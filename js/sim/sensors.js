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

      var radarOk = false, visualOk = false;
      var radarObs = null, visualObs = null;

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
          radarObs = {
            posErr: Math.max(120, range * (r.rangeErr / 10000) + range * Math.tan(r.bearingErr * U.DEG)),
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
          posErr: Math.max(90, range * rangeFrac * 0.75 + range * Math.tan(0.8 * U.DEG)),
          brgErr: 0.8,
          rangeErr: range * rangeFrac
        };
      }

      if (!radarOk && !visualOk) return null;

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
      if (radarOk && idLevel < ID.SURFACE) idLevel = ID.SURFACE;

      // 优先使用更精确的定位源
      var best = (visualObs && radarObs)
        ? (visualObs.posErr <= radarObs.posErr ? visualObs : radarObs)
        : (visualObs || radarObs);

      return {
        range: range,
        bearing: bearing,
        idLevel: idLevel,
        source: (visualOk && radarOk) ? 'both' : (visualOk ? 'visual' : 'radar'),
        posErr: best.posErr,
        brgErr: best.brgErr,
        rangeErr: best.rangeErr,
        visual: visualOk,
        radar: radarOk
      };
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
        for (var i = 0; i < targets.length; i++) {
          var obs = Sensors.observe(observer, targets[i], world);
          Sensors.fuse(world, observer.ownTracks, targets[i], obs, dt, side, observer);
        }
      }

      if (N.Command) N.Command.report(world, side, observers);
      if (N.Command) N.Command.extrapolatePicture(world, side, dt);
    },

    /**
     * 把一次观测并进一张航迹表。
     * @param {Object} map    航迹表（本舰 ownTracks，或指挥舰的态势图）
     * @param {string} owner  这张表属于哪一方
     */
    fuse: function (world, map, tgt, obs, dt, owner, observer) {
      var rng = world.rng;
      var tr = map[tgt.id];
      if (!tr) {
        if (!obs) return null;
        tr = map[tgt.id] = {
          id: tgt.id,
          side: owner,
          pos: { x: 0, y: 0 },
          course: 0,
          speed: 0,
          uncertainty: 0,
          idLevel: 0,
          typeGuess: null,
          classGuess: null,
          nameGuess: null,
          misId: false,
          lastSeen: world.time,
          firstSeen: world.time,
          seenBy: observer ? observer.id : null,
          fixes: [],
          seenThisTick: true,
          source: 'visual'
        };
      }

      if (obs) {
        // ---- 有观测：更新位置（带误差） ----
        var errPos = Geo.dest(tgt.pos, obs.bearing + rng.dev(obs.brgErr), rng.dev(obs.posErr));
        tr.pos = errPos;
        tr.uncertainty = Math.max(120, obs.posErr * 1.1);
        tr.lastSeen = world.time;
        tr.observedAt = world.time;
        tr.seenBy = observer ? observer.id : tr.seenBy;
        tr.seenThisTick = true;
        tr.source = obs.source;

        // ---- 识别 ----
        if (obs.idLevel > tr.idLevel) {
          tr.idLevel = obs.idLevel;
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

        // ---- 由连续定位推算航向航速（带噪声） ----
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
      } else {
        // ---- 无观测：按估算航向外推 ----
        tr.seenThisTick = false;
        var gap = world.time - tr.lastSeen;
        if (gap > 900) { delete map[tgt.id]; return null; }
        var v = Geo.headingVec(tr.course);
        var step = tr.speed * U.KNOT_MS * dt;
        tr.pos = { x: tr.pos.x + v.x * step, y: tr.pos.y + v.y * step };
        tr.uncertainty = Math.min(9000, tr.uncertainty + 55 * dt);
      }
      return tr;
    },

    /**
     * 某艘舰对某个目标该用哪张航迹：
     * 自己看得见就用本舰的（即时），否则用指挥舰发下来的态势（可能已经旧了）。
     */
    trackFor: function (world, ship, targetId) {
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

  N.Sensors = Sensors;
})(globalThis.Naval = globalThis.Naval || {});
