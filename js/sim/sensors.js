/* =============================================================================
 *  sim/sensors.js —— 探测与航迹
 *
 *  这是“信息不透明”的核心：
 *    玩家 / AI 都拿不到敌舰的真实坐标、航向、航速和损伤，
 *    只能拿到一份带误差的“航迹（track）”。
 *
 *  误差来源（尽量贴近史实）：
 *    · 雷达：测距准（~1%）、测向差（2~3°），无法识别舰种
 *    · 光学：测向准（~0.5~1.5°）、测距差（3~8%），可识别舰种/舰级
 *    · 目标开火闪光、起火、浓烟会显著增加被发现距离
 *    · 烟幕会遮蔽目视观测（但不影响雷达）
 *    · 失去接触后航迹按最后测得的航向航速外推，误差随时间增大
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var _flashSeq = 0;   // 闪光航迹的编号（不暴露对方是哪条船）

  var ID = {
    NONE: 0,        // 无接触
    SURFACE: 1,     // 水面目标（有东西，不知是什么）
    TYPE: 2,        // 可判舰种（驱逐舰 / 巡洋舰）
    CLASS: 3,       // 可判舰级
    CONFIRMED: 4    // 可确认舰名
  };

  var Sensors = {
    ID: ID,

    /** 舰艇的“可见性尺寸因子”：越大越容易被发现 */
    sizeFactor: function (ship) {
      return U.clamp(0.55 + 0.45 * Math.sqrt(ship.cls.displacement / 12000), 0.55, 1.45);
    },

    /** 该舰是否处于烟幕中（起火的烟不算遮蔽，那只是它自己冒烟） */
    inSmoke: function (world, pos) {
      for (var i = 0; i < world.smokes.length; i++) {
        var s = world.smokes[i];
        if (s.kind === 'fire') continue;
        if (V.dist(pos, s.pos) < s.radius) return true;
      }
      return false;
    },

    /** 点到线段的距离 */
    segDist: function (ax, ay, bx, by, px, py) {
      var dx = bx - ax, dy = by - ay;
      var l2 = dx * dx + dy * dy;
      if (l2 < 1) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
      var t = U.clamp01(((px - ax) * dx + (py - ay) * dy) / l2);
      return Math.sqrt((px - (ax + t * dx)) * (px - (ax + t * dx)) +
        (py - (ay + t * dy)) * (py - (ay + t * dy)));
    },

    /**
     * 起火冒的烟挡在观察者和目标之间 → 光学观测打折。
     * 注意这和「烟幕」不一样：烟幕是目标自己躲进去，火烟是挡住别人的视线。
     */
    fireSmokeBlocks: function (world, from, to) {
      var puffs = 0;
      for (var i = 0; i < world.smokes.length; i++) {
        var s = world.smokes[i];
        if (s.kind !== 'fire') continue;
        // 只算夹在两者之间的那一段
        var mid = { x: (from.x + to.x) * 0.5, y: (from.y + to.y) * 0.5 };
        if (V.dist(mid, s.pos) > s.radius + V.dist(from, to) * 0.5 + 800) continue;
        if (Sensors.segDist(from.x, from.y, to.x, to.y, s.pos.x, s.pos.y) < s.radius * 0.85) {
          puffs++;
          if (puffs >= 2) break;
        }
      }
      if (!puffs) return 1;
      return puffs >= 2 ? 0.32 : 0.58;
    },

    /* 眼高 / 桅顶高度（米）。巡洋舰的雷达天线和瞭望台都在 25~30 米 */
    EYE_H: 28,
    TGT_H: 22,

    /**
     * 这条视线是不是被地形挡住了。结果按（观察者, 目标）缓存 6 秒 ——
     * 船在这个时间尺度上最多走六十米，地形轮廓根本不会变。
     */
    losBlocked: function (world, observer, target, range) {
      // 注意别和 combat.js 里炮口视线的 ship._los 撞名字，那个是另一个缓存
      var c = observer._sight || (observer._sight = {});
      var e = c[target.id];
      var now = world.time;
      if (e && now - e.t < 6 &&
        Math.abs(e.ax - observer.pos.x) < 350 && Math.abs(e.ay - observer.pos.y) < 350 &&
        Math.abs(e.bx - target.pos.x) < 350 && Math.abs(e.by - target.pos.y) < 350) {
        return e.isl;
      }
      var isl = world.sightBlocked(observer.pos.x, observer.pos.y, Sensors.EYE_H,
        target.pos.x, target.pos.y, Sensors.TGT_H);
      c[target.id] = {
        t: now, ax: observer.pos.x, ay: observer.pos.y,
        bx: target.pos.x, by: target.pos.y, isl: isl
      };
      return isl;
    },

    /**
     * 单个观察者对一个目标的观测。
     * 返回 null 或 { range, bearing, idLevel, source, posErr, brgErr, pos }
     */
    observe: function (observer, target, world) {
      if (target.sunk || !target.alive) return null;
      var env = world.env;
      var wx = world.weather;
      var range = V.dist(observer.pos, target.pos);
      var bearing = Geo.bearing(observer.pos, target.pos);

      var radarOk = false, visualOk = false, esmOk = false;
      var radarObs = null, visualObs = null, esmObs = null;

      /* ---------------- 雷达 ---------------- */
      var r = observer.cls.radar;
      // 雷达被打坏、故障、或者电力失灵，都用不了
      if (N.Damage && !N.Damage.radarOk(observer)) r = null;
      if (r && !observer.radarDestroyed) {
        // 上层建筑受损 → 天线基座、波导管跟着遭殃，雷达作用距离成比例缩水
        var rRange = r.range * (0.62 + 0.38 * Math.sqrt(target.cls.displacement / 12000)) *
          (observer.sensorFactor ? observer.sensorFactor() : 1);
        if (world.env.radarJammed) rRange *= 0.5;
        // 天气：雨幕衰减 + 高海况海杂波（小船先被淹没）
        if (N.Weather) rRange *= N.Weather.radarFactor(world) * N.Weather.seaClutter(world, target);
        if (range < rRange) {
          radarOk = true;
          // 雷达的两个方向差得很远：测距准（1%），测向糊（2~4°）。
          // 分开存，画出来才是一条细长的椭圆，而不是一个圆。
          var rErr = Math.max(60, range * (r.rangeErr / 10000));
          var rCross = Math.max(60, range * Math.tan(r.bearingErr * U.DEG));
          radarObs = {
            errR: rErr,
            errC: rCross,
            posErr: Math.max(120, Math.max(rErr, rCross)),
            brgErr: r.bearingErr,
            rangeErr: r.rangeErr
          };
        }
      }

      /* ---------------- 光学（瞭望哨） ---------------- */
      // 能见度是活的：雨、雨飑、月光、云量、浪沫都在改它（weather.js）
      var vis = wx ? wx.visibility : env.visibility;
      var rain = wx ? wx.rain : (env.rain || 0);
      var base = vis * Sensors.sizeFactor(target);
      // 照明弹：被照亮的圈内，能见距离提升到 11 km（双方一视同仁）
      var lit = false;
      if (env.light !== 'day' && typeof world.illuminationAt === 'function') {
        var il = world.illuminationAt(target.pos);
        // 只有照明真的比环境更亮时才算数（拂晓 12 km 能见度下打照明弹没有意义）
        if (il > 0) { lit = il > base; base = Math.max(base, il); }
      }
      // 识别用基准：照明弹会显著改善识别，起火/炮口闪光则不算（那是“看见”，不是“认清”）
      var idBase = base;
      // 目标特征增强
      if (target.fire > 3) base *= 1.20;                       // 起火
      if (N.Weather && target.fire > 3) base *= N.Weather.fireBeacon(world);  // 夜里的火光最扎眼
      if (target.smokeScreen) base *= 1.12;                    // 自身施放烟幕（浓烟）
      if (world.time - target.lastFireTime < 25) base *= 1.35; // 炮口闪光
      if (rain > 0.3) base *= 0.75;
      // 烟幕遮蔽
      if (Sensors.inSmoke(world, target.pos)) base *= 0.30;
      // 观察者自身在烟幕里
      if (Sensors.inSmoke(world, observer.pos)) base *= 0.55;
      // 别人烧起来的烟挡在你和目标之间
      base *= Sensors.fireSmokeBlocks(world, observer.pos, target.pos);

      if (range < base) {
        visualOk = true;
        // 光学测距误差随距离平方增长；测向误差很小
        var rangeFrac = 0.02 + 0.06 * U.clamp01(range / Math.max(6000, vis));
        if (lit) rangeFrac *= 0.6;   // 被照明弹照亮时测距明显更准
        visualObs = {
          errR: Math.max(90, range * rangeFrac),
          errC: Math.max(60, range * Math.tan(0.8 * U.DEG)),
          posErr: Math.max(90, range * rangeFrac * 0.75 + range * Math.tan(0.8 * U.DEG)),
          brgErr: 0.8,
          rangeErr: range * rangeFrac
        };
      }

      /* ---------------- 电探（被动雷达告警） ----------------
       *  只听不发：对方雷达一开机，受信机就能测到它的方位。
       *  关键在于 —— 测向准，测距基本靠信号强度估，误差极大。
       *  所以它不会给你一个能开炮的解，只告诉你"那个方向有雷达"。
       *  美军不知道自己的雷达被听了。 */
      if (N.Damage && N.Damage.esmOk(observer) && observer.side !== target.side) {
        // 对方雷达得真的在辐射（被打坏、故障、断电就不辐射了）
        var tRadarOn = target.cls.radar && (N.Damage ? N.Damage.radarOk(target) : !target.radarDestroyed);
        if (tRadarOn) {
          var esmCfg = (N.ESM && N.ESM.config) || { range: 26000, bearingErr: 1.3, rangeFrac: 0.45 };
          var esmRange = esmCfg.range * (observer.sensorFactor ? observer.sensorFactor() : 1);
          // 雨幕对雷达波也有衰减，但远小于对光学的影响
          if (N.Weather) esmRange *= 0.82 + 0.18 * N.Weather.radarFactor(world);
          if (range < esmRange) {
            esmOk = true;
            esmObs = {
              // 方位很准，距离只能估到 ±45%，两者合成一个很大的圆
              errR: Math.max(1800, range * esmCfg.rangeFrac),
              errC: Math.max(200, range * Math.tan(esmCfg.bearingErr * U.DEG)),
              posErr: Math.max(1800, range * esmCfg.rangeFrac),
              brgErr: esmCfg.bearingErr,
              rangeErr: range * esmCfg.rangeFrac
            };
          }
        }
      }

      if (!radarOk && !visualOk && !esmOk) return null;

      /* ---------------- 地形遮挡 ----------------
       *  岛不是一堵墙：只有地面高过视线的那一段才挡得住。
       *  萨沃（485 米）能把 20 公里外的舰队整个藏起来，图拉吉（100 米）不行。
       *  雷达同理 —— 电磁波不会拐过山脊。 */
      if (Sensors.losBlocked(world, observer, target, range)) {
        return null;
      }

      /* ---------------- 识别等级 ---------------- */
      var idLevel = ID.NONE;
      if (visualOk) {
        var visRatio = range / Math.max(1500, idBase);
        if (visRatio < 0.16) idLevel = ID.CONFIRMED;
        else if (visRatio < 0.38) idLevel = ID.CLASS;
        else if (visRatio < 0.72) idLevel = ID.TYPE;
        else idLevel = ID.SURFACE;
        // 拂晓/黄昏/雨雾会降低识别能力
        if (env.light === 'dawn' || env.light === 'dusk') idLevel = Math.max(ID.SURFACE, idLevel - 1);
        // 雨幕里连舰型都分不清
        if (rain > 0.45) idLevel = Math.max(ID.SURFACE, idLevel - 1);
      }
      if ((radarOk || esmOk) && idLevel < ID.SURFACE) idLevel = ID.SURFACE;

      // 优先使用更精确的定位源
      var best = (visualObs && radarObs)
        ? (visualObs.posErr <= radarObs.posErr ? visualObs : radarObs)
        : (visualObs || radarObs || esmObs);

      return {
        range: range,
        bearing: bearing,
        idLevel: idLevel,
        source: (visualOk && radarOk) ? 'both'
          : (visualOk ? 'visual'
            : (radarOk ? 'radar' : 'esm')),
        posErr: best.posErr,
        errR: best.errR || best.posErr,
        errC: best.errC || best.posErr,
        // 椭圆的长轴是"测距方向"，也就是从观察者到目标的方位
        axis: bearing,
        brgErr: best.brgErr,
        rangeErr: best.rangeErr,
        visual: visualOk,
        radar: radarOk,
        esm: esmOk,
        // 只有电探看到：方位很准，距离基本靠猜
        esmOnly: esmOk && !radarOk && !visualOk
      };
    },

    /* ======================================================================
     *  雷达的"一坨"
     *
     *  雷达不是照相机。它给的是「某个方位上、某个距离上有一个回波」。
     *  两条舰挨得比天线波束还近的时候，屏幕上只有一个亮点 —— 操作手
     *  根本不知道那是几条船。只有瞭望哨数得清。
     *
     *  所以"只有雷达"的接触必须先**聚类**：落在同一个分辨率单元里的几条船
     *  合成一条「雷达接触」，位置取回波的重心，圈要能把整个单元包住。
     *  这条接触从此没有"艘数"这个概念（countKnown = false）。
     *
     *  不同舰的雷达也不一样：天线大的测向准，小艇上的测向糊；运输舰装的是
     *  对空警戒的 SC，海面上一塌糊涂。这些都写在 ships.js 的 radar 里。
     * ====================================================================== */

    /** 两个方位之间的夹角（度，0~180） */
    angDiff: function (a, b) {
      var d = ((a - b) % 360 + 540) % 360 - 180;
      return d < 0 ? -d : d;
    },

    /** 这条船的雷达分辨率单元（米 / 度） */
    radarCell: function (ship) {
      var r = ship && ship.cls ? ship.cls.radar : null;
      if (!r) return null;
      return {
        rangeRes: r.rangeRes || 400,
        bearingRes: r.bearingRes || 4.0
      };
    },

    /**
     * 一次"扫描"：把这艘舰这一瞬间看到的全部目标，整理成**回波**。
     * 目视/电探的接触一条一个（看得见就能数）；
     * 只有雷达的，按分辨率单元聚成一坨。
     */
    scan: function (world, observer, targets) {
      var rng = world.rng;
      var list = [], i, o;
      for (i = 0; i < targets.length; i++) {
        o = Sensors.observe(observer, targets[i], world);
        if (o) { o.tgt = targets[i]; list.push(o); }
      }

      // 被海杂波糊住 / 操作手跟丢了一阵：这几秒雷达上什么都没有
      var blind = world.time < (observer._blindUntil || 0);

      var echoes = [], radarOnly = [];
      for (i = 0; i < list.length; i++) {
        o = list[i];
        if (blind && o.source === 'radar') continue;
        if (o.visual || o.esm) echoes.push(Sensors.singleEcho(world, o));
        else radarOnly.push(o);
      }

      // ---- 聚类 ----
      var cell = Sensors.radarCell(observer);
      if (cell && radarOnly.length) {
        var used = [];
        for (i = 0; i < radarOnly.length; i++) {
          if (used[i]) continue;
          var group = [radarOnly[i]];
          used[i] = 1;
          for (var j = i + 1; j < radarOnly.length; j++) {
            if (used[j]) continue;
            var a = radarOnly[i], b = radarOnly[j];
            if (Math.abs(a.range - b.range) < cell.rangeRes &&
              Sensors.angDiff(a.bearing, b.bearing) < cell.bearingRes) {
              group.push(b);
              used[j] = 1;
            }
          }
          echoes.push(Sensors.clusterEcho(world, group));
        }
      } else {
        for (i = 0; i < radarOnly.length; i++) echoes.push(Sensors.singleEcho(world, radarOnly[i]));
      }

      // ---- 假回波 ----
      Sensors.stepClutter(world, observer);
      var ph = observer._phantoms || [];
      for (i = 0; i < ph.length; i++) {
        if (world.time <= ph[i].until) echoes.push(ph[i]);
      }
      return echoes;
    },

    /** 一条独立的接触（看得见，或者只是单条船的回波） */
    singleEcho: function (world, o) {
      var rng = world.rng;
      return {
        key: o.tgt.id,
        members: [o.tgt.id],
        count: 1, countKnown: true,
        pos: Geo.dest(o.tgt.pos, o.bearing + rng.dev(o.brgErr), rng.dev(o.posErr)),
        posErr: o.posErr, errR: o.errR, errC: o.errC, axis: o.bearing,
        range: o.range, bearing: o.bearing,
        idLevel: o.idLevel, source: o.source,
        esmOnly: !!o.esmOnly, visual: o.visual, radar: o.radar, esm: o.esm,
        tgt: o.tgt
      };
    },

    /** 几条船挤在一个分辨率单元里：雷达上只有一个亮点 */
    clusterEcho: function (world, group) {
      var rng = world.rng;
      var reps = [], sx = 0, sy = 0, i, o, rep;
      for (i = 0; i < group.length; i++) {
        o = group[i];
        rep = Geo.dest(o.tgt.pos, o.bearing + rng.dev(o.brgErr), rng.dev(o.posErr));
        reps.push(rep);
        sx += rep.x; sy += rep.y;
      }
      var c = { x: sx / group.length, y: sy / group.length };
      var spread = 0, maxErr = 0;
      for (i = 0; i < group.length; i++) {
        spread = Math.max(spread, V.dist(c, reps[i]));
        maxErr = Math.max(maxErr, group[i].posErr);
      }
      var members = [];
      for (i = 0; i < group.length; i++) members.push(group[i].tgt.id);
      var g0 = group[0];
      return {
        key: members[0],
        members: members,
        count: members.length,
        countKnown: members.length === 1,
        pos: c,
        posErr: maxErr + spread,
        errR: g0.errR + spread, errC: g0.errC + spread, axis: g0.bearing,
        range: g0.range, bearing: g0.bearing,
        // 一坨回波既分不出舰种，也数不清几条
        idLevel: ID.SURFACE,
        source: 'radar',
        esmOnly: false, visual: false, radar: true, esm: false,
        tgt: members.length === 1 ? g0.tgt : null
      };
    },

    /**
     * 随机干扰：海杂波、二次回波、异常传播，以及"跟丢了一阵"。
     * 海况越差、雨越大，假回波越多，也越容易暂时看不见。
     */
    stepClutter: function (world, observer) {
      // 干扰用自己的一条随机流：它每十几秒就摇一次色子，混进战斗随机流里
      // 会把设备故障、AI 抖动这些判定的序列整体推偏，整场结果就跑飞了。
      if (!world.clutterRng) {
        world.clutterRng = new N.RNG(((world.seedValue || 12345) ^ 0xC1A77E) >>> 0);
      }
      var rng = world.clutterRng;
      if (!observer._phantoms) observer._phantoms = [];
      var keep = [];
      for (var i = 0; i < observer._phantoms.length; i++) {
        if (world.time <= observer._phantoms[i].until) keep.push(observer._phantoms[i]);
      }
      observer._phantoms = keep;

      var r = observer.cls.radar;
      if (!r || (N.Damage && !N.Damage.radarOk(observer))) return;

      if (world.time < (observer._nextClutter || 0)) return;
      // 定时器用固定的错峰，不摇色子 —— 每帧都消耗随机数会把整场的随机流推偏，
      // 后面所有靠随机数做的判定（设备故障、AI 抖动）都会跟着漂。
      observer._nextClutter = world.time + 14 + ((observer._clutterPhase || 0) % 22);
      observer._clutterPhase = (observer._clutterPhase || 0) + 7;

      var wx = world.weather || {};
      var sea = wx.seaState || 2, rain = wx.rain || 0;
      var p = 0.10 + 0.05 * Math.max(0, sea - 2) + 0.12 * rain;
      if (!rng.chance(p)) return;

      if (rng.chance(0.45)) {
        // 跟丢：这几秒屏幕上干干净净，接触只能靠外推
        observer._blindUntil = world.time + 3 + rng.range(0, 6);
        return;
      }
      // 假回波：一个漂在海上的亮点，过十几秒自己消失
      var brg = rng.range(0, 360);
      var dist = rng.range(4000, Math.min(r.range, 26000) * 0.85);
      observer._phantomSeq = (observer._phantomSeq || 0) + 1;
      observer._phantoms.push({
        key: 'P' + observer._phantomSeq,
        members: [], count: 0, countKnown: false,
        pos: Geo.dest(observer.pos, brg, dist),
        posErr: 900 + dist * 0.04,
        errR: 400, errC: dist * 0.05, axis: brg,
        range: dist, bearing: brg,
        idLevel: ID.SURFACE, source: 'radar',
        esmOnly: false, visual: false, radar: true, esm: false,
        phantom: true, tgt: null,
        until: world.time + 12 + rng.range(0, 14)
      });
    },

    /**
     * 每艘舰维护一份**自己的**观测表（即时、无延迟）—— 这是本舰火控能用的东西。
     * 指挥舰的全场态势由 N.Command 用无线电报告拼出来，见 command.js。
     */
    updateTracks: function (world, side, dt) {
      var observers = world.ships.filter(function (s) {
        return s.side === side && s.alive && !s.sunk;
      });
      var targets = world.ships.filter(function (s) {
        return s.side !== side && s.alive && !s.sunk;
      });

      for (var j = 0; j < observers.length; j++) {
        var observer = observers[j];
        if (!observer.ownTracks) observer.ownTracks = {};
        var echoes = Sensors.scan(world, observer, targets);
        var seen = {};
        for (var i = 0; i < echoes.length; i++) {
          seen[echoes[i].key] = 1;
          Sensors.fuse(world, observer.ownTracks, echoes[i], dt, side, observer);
        }
        // 这一轮没看到的，按最后定解点外推
        for (var k in observer.ownTracks) {
          if (seen[k]) continue;
          Sensors.decay(world, observer.ownTracks, k, dt);
        }
      }

      if (N.Command) N.Command.report(world, side, observers);
      if (N.Command) N.Command.extrapolatePicture(world, side, dt);
    },

    /**
     * 把一条回波并进一张航迹表。
     * @param {Object} map    航迹表（本舰 ownTracks，或指挥舰的态势图）
     * @param {string} owner  这张表属于哪一方
     */
    fuse: function (world, map, echo, dt, owner, observer) {
      var rng = world.rng;
      if (!echo) return null;
      var key = echo.key;
      var tr = map[key];
      if (!tr) {
        tr = map[key] = {
          id: key,
          side: owner,
          pos: { x: echo.pos.x, y: echo.pos.y },
          course: 0,
          speed: 0,
          uncertainty: echo.posErr,
          errR: echo.errR, errC: echo.errC, axis: echo.axis,
          idLevel: echo.idLevel,
          typeGuess: null,
          classGuess: null,
          nameGuess: null,
          misId: false,
          members: echo.members.slice(),
          count: echo.count,
          countKnown: echo.countKnown,
          phantom: !!echo.phantom,
          fromPlane: echo.fromPlane || null,
          fromFlash: !!echo.fromFlash,
          lastSeen: world.time,
          firstSeen: world.time,
          seenBy: observer ? observer.id : null,
          fixes: [],
          seenThisTick: true,
          source: echo.source
        };
      }

      // 这一坨里换人了：旧的定解点没用了，重新开始
      if (echo.members.length !== tr.members.length ||
        echo.members.some(function (m) { return tr.members.indexOf(m) < 0; })) {
        tr.fixes.length = 0;
      }
      tr.members = echo.members.slice();
      tr.count = echo.count;
      tr.countKnown = echo.countKnown;
      tr.phantom = !!echo.phantom;
      if (echo.fromPlane) tr.fromPlane = echo.fromPlane;
      else if (!tr.fromPlane) tr.fromPlane = null;
      if (echo.fromFlash) tr.fromFlash = true;

      /* ---- 电探只是方位：已经有更好的定位时，别让它把位置拽偏 ----
       * 电探的"位置"是沿方位线猜出来的，误差几公里。如果本舰已经有
       * 望远镜或雷达的实定位，正确的做法是拿这条方位线去校核，而不是覆盖。 */
      if (echo.esmOnly && tr.fix && tr.source !== 'esm' && tr.uncertainty < echo.posErr) {
        tr.esmFix = (tr.esmFix || 0) + 1;
        tr.uncertainty = Math.max(120, tr.uncertainty * 0.88);
        tr.esmAt = world.time;
        return tr;
      }

      // ---- 有观测：更新位置（带误差） ----
      tr.pos = { x: echo.pos.x, y: echo.pos.y };
      tr.uncertainty = Math.max(120, echo.posErr * 1.1);
      tr.errR = echo.errR; tr.errC = echo.errC; tr.axis = echo.axis;
      tr.lastSeen = world.time;
      tr.observedAt = world.time;
      tr.seenBy = observer ? observer.id : tr.seenBy;
      tr.seenThisTick = true;
      tr.source = echo.source;
      tr.esmOnly = !!echo.esmOnly;
      tr.fix = { x: tr.pos.x, y: tr.pos.y, t: world.time, err: Math.max(120, echo.posErr) };

      // ---- 识别：只有"看得见的那一条船"才谈得上识别 ----
      if (echo.tgt && echo.idLevel > tr.idLevel) {
        var tgt = echo.tgt;
        tr.idLevel = echo.idLevel;
        if (tr.idLevel >= ID.TYPE && !tr.typeGuess) {
          tr.typeGuess = tgt.cls.type;
          // 一定概率误判舰种（史实中并不少见）
          if (tr.idLevel < ID.CONFIRMED && rng.chance(0.12)) {
            tr.misId = true;
            tr.typeGuess = (tgt.cls.type === 'DD') ? 'CL' : (tgt.cls.type === 'CA' ? 'CL' : 'DD');
          }
        }
        if (tr.idLevel >= ID.CLASS) {
          tr.classGuess = tgt.cls.name;
          if (tr.idLevel >= ID.CONFIRMED) { tr.nameGuess = tgt.name; tr.misId = false; }
        }
      }

      /* ---- 火光：只有瞭望哨看得见，雷达对一团火完全无感 ----
         烧起来的船是夜里最好认的目标，这条信息不该被藏起来；
         但它是"看见的"，所以只能由目视观测刷新，而且会随着看不见而变旧。 */
      if (echo.visual && echo.tgt) {
        tr.fireSeen = echo.tgt.fire || 0;
        tr.floodSeen = echo.tgt.flood || 0;
        tr.seenFireAt = world.time;
      }

      // ---- 由连续定位推算航向航速（带噪声） ----
      // 闪光航迹没有航向：那是"有人在那边开炮"，不是一条正在走的船
      if (tr.fromFlash) return tr;
      tr.fixes.push({ t: world.time, x: tr.pos.x, y: tr.pos.y });
      if (tr.fixes.length > 6) tr.fixes.shift();
      if (tr.fixes.length >= 2) {
        var f0 = tr.fixes[0], f1 = tr.fixes[tr.fixes.length - 1];
        var dtf = f1.t - f0.t;
        if (dtf > 6) {
          var d = V.dist(f0, f1);
          var noiseF = U.clamp(tr.uncertainty / 800, 0.5, 3);
          tr.course = U.norm360(Geo.bearing(f0, f1) + rng.dev(1.6 * noiseF));
          tr.speed = U.clamp(d / dtf / U.KNOT_MS + rng.dev(0.8 * noiseF), 0, 40);
        }
      }
      return tr;
    },

    /** 这一轮没有观测：从定解点按估算航向外推 */
    decay: function (world, map, key, dt) {
      var tr = map[key];
      if (!tr) return null;
      tr.seenThisTick = false;
      var gap = world.time - tr.lastSeen;
      // 闪光是一次一闪的事件：停火一分钟，这条接触就该从图上消失
      if (tr.fromFlash && gap > 60) { delete map[key]; return null; }
      if (gap > 900 || (tr.phantom && gap > 26)) { delete map[key]; return null; }
      if (tr.fix) {
        var v = Geo.headingVec(tr.course);
        var step = tr.speed * U.KNOT_MS * (world.time - tr.fix.t);
        tr.pos = { x: tr.fix.x + v.x * step, y: tr.fix.y + v.y * step };
        var drift = (6 + tr.speed * U.KNOT_MS * 0.35) * (world.time - tr.fix.t);
        tr.uncertainty = Math.min(9000, Math.sqrt(tr.fix.err * tr.fix.err + drift * drift));
        tr.errR = tr.uncertainty;
        tr.errC = tr.uncertainty;
      } else {
        var v2 = Geo.headingVec(tr.course);
        var step2 = tr.speed * U.KNOT_MS * dt;
        tr.pos = { x: tr.pos.x + v2.x * step2, y: tr.pos.y + v2.y * step2 };
        tr.uncertainty = Math.min(9000, tr.uncertainty + 55 * dt);
        tr.errR = tr.uncertainty;
        tr.errC = tr.uncertainty;
      }
      return tr;
    },

    /**
     * 炮口闪光报告：只有瞭望哨能看见，测向还行、测距很糟。
     *
     * 它不是"看见了一条船"，而是"那个方向有人在开炮"。所以：
     *   · 识别等级只到「水面目标」，数不清几条、也分不出舰种；
     *   · 距离靠闪光—炮声时差估（声速 340 m/s），误差三成；
     *   · 航向航速一概没有 —— 图上就是一个大圈。
     */
    flashReport: function (world, observer, target, dist) {
      var rng = world.rng;
      var brg = Geo.bearing(observer.pos, target.pos);
      var brgErr = 1.6;                                   // 度：点光源，方位看得还算准
      var rEst = Math.max(900, dist * (1 + rng.dev(0.30)));
      var pos = Geo.dest(observer.pos, U.norm360(brg + rng.dev(brgErr)), rEst);
      var errR = Math.max(700, rEst * 0.30);              // 沿视线：时差估距，三成
      var errC = Math.max(300, rEst * Math.tan(brgErr * U.DEG));
      if (!observer.ownTracks) observer.ownTracks = {};

      /* 同一片海域里还在闪的，归到同一条航迹上：
         瞭望哨会说"还是那家伙在打"，而不是每打一发就多出一个目标。
         归并门限要跟着距离走 —— 10 km 外估出来的位置本身就有三公里误差，
         拿一个固定的小半径去比，同一条舰每一轮齐射都会变成一个新目标。 */
      var gate = Math.max(2600, rEst * 0.45);
      var key = null, oldest = null, oldestT = 1e9;
      for (var k in observer.ownTracks) {
        var t0 = observer.ownTracks[k];
        if (!t0.fromFlash) continue;
        var age0 = world.time - t0.lastSeen;
        if (age0 > 50) continue;
        if (V.dist(t0.pos, pos) < gate) { key = k; break; }
        if (age0 < oldestT) { oldestT = age0; oldest = k; }
      }
      /* 同时在闪的目标太多，图就没法看了。超过 14 条就把最旧的顶掉。 */
      if (!key) {
        var nFlash = 0;
        for (var k2 in observer.ownTracks) {
          if (observer.ownTracks[k2].fromFlash) nFlash++;
        }
        if (nFlash >= 14 && oldest) key = oldest;
      }
      if (!key) key = 'F' + (++_flashSeq);

      return Sensors.fuse(world, observer.ownTracks, {
        key: key,
        pos: pos, posErr: Math.max(errR, errC),
        errR: errR, errC: errC, axis: brg,
        idLevel: ID.SURFACE,
        members: [key], count: 1, countKnown: false,
        phantom: false, source: 'flash', esmOnly: false, fromFlash: true,
        tgt: null
      }, 0, observer.side, observer);
    },

    /**
     * 某艘舰对某个目标该用哪张航迹：
     * 自己看得见就用本舰的（即时），否则用指挥舰发下来的态势（可能已经旧了）。
     */
    trackFor: function (world, ship, targetId) {
      // 识别器认错了：这条船眼里的"敌舰"其实是自己的友舰
      if (ship && ship.ffTrack && ship.ffTrack.id === targetId) return ship.ffTrack;
      var own = ship.ownTracks ? ship.ownTracks[targetId] : null;
      var pic = Sensors.track(world, ship.side, targetId);
      if (!own) return pic;
      if (!pic) return own;
      var a = world.time - (own.lastSeen || 0);
      var b = world.time - (pic.observedAt || pic.lastSeen || 0);
      return a <= b ? own : pic;
    },

    /** 某方对某目标是否有有效航迹 */
    track: function (world, side, targetId) {
      return world.tracks[side] ? world.tracks[side][targetId] : null;
    },

    /** 航迹列表（按发现顺序） */
    trackList: function (world, side) {
      var t = world.tracks[side] || {};
      return Object.keys(t).map(function (k) { return t[k]; });
    },

    /** 识别等级文字 */
    idText: function (tr) {
      if (!tr) return '无接触';
      // 雷达上的一坨：不知道几条船，也分不出舰种
      if (tr.phantom) return '雷达接触 · 疑似假回波';
      if (tr.fromFlash) return '炮口闪光 · 仅方位';
      if (tr.source === 'floatplane') {
        return '水侦情报 · ' + (tr.count || 1) + ' 艘（坐标不准）';
      }
      if (tr.countKnown === false) return '雷达接触 · 数量不明';
      switch (tr.idLevel) {
        case ID.SURFACE: return '水面目标';
        case ID.TYPE: return tr.misId ? ('疑似' + typeName(tr.typeGuess)) : typeName(tr.typeGuess);
        case ID.CLASS: return '疑似' + (tr.classGuess || '巡洋舰');
        case ID.CONFIRMED: return tr.nameGuess || tr.classGuess || '已识别';
        default: return '未知';
      }
    }
  };

  function typeName(t) {
    if (t === 'DD') return '驱逐舰';
    if (t === 'CL') return '轻巡洋舰';
    if (t === 'CA') return '重巡洋舰';
    return '舰艇';
  }
  Sensors.typeName = typeName;

  /* ==========================================================================
   *  电探（被动雷达告警）
   *
   *  日军把"电波探知機"装在少数旗舰和巡洋舰上，用来听美军雷达的辐射。
   *  它只听不发 —— 美军那边没有任何提示，雷达照开，直到炮弹落下来。
   *
   *  这也意味着：它测得到方位，测不到距离。给了日舰"那个方向有美国人"，
   *  但给不了射击诸元。真正值钱的是夜战里提前几十秒知道对面来了。
   * ========================================================================== */
  N.ESM = {
    config: {
      range: 26000,        // 被动接收距离（米），比美军雷达自己的作用距离还远一点
      bearingErr: 1.3,     // 测向误差（度）
      rangeFrac: 0.45      // 测距误差：信号强度估距，只能到这个量级
    },
    /** 这条舰装没装电探 */
    fitted: function (ship) {
      return !!(ship && ship.hasESM && N.Damage && N.Damage.esmOk(ship));
    }
  };

  N.Sensors = Sensors;
})(globalThis.Naval = globalThis.Naval || {});
