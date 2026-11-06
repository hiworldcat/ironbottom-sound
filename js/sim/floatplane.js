/* =============================================================================
 *  sim/floatplane.js —— 水上侦察机
 *
 *  巡洋舰上带着弹射器和几架水上侦察机（美军 OS2U 翠鸟 / SOC 海鸥，
 *  日军零式水侦）。它是 1942 年夜里少数能"看到更远"的东西之一 ——
 *  但代价很大：
 *
 *    · **放不出去的时候很多**。海况超过 3 就收放不了（浪打进弹射器），
 *      能见度低于 5 km 起飞没有意义，无月之夜飞行员看不见海面。
 *    · **它看到的东西要写成字报回来**。飞行员在图上点一个位置、数一下
 *      几条船、估一个航向航速，然后由报务员发成电文。这三样都不准：
 *      坐标误差一两公里，船数可能多报或少报一条，航向航速是估的。
 *    · **报回来的是文字，不是一条精确航迹**。所以水侦的接触圈很大，
 *      只能用来"往那个方向去堵"，不能用来开炮。
 *
 *  这一套是刻意做得比雷达差：雷达至少测距准，水侦连距离都是飞行员
 *  目测的。它的价值在于**超出雷达作用距离**的那一段。
 * ============================================================================= */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var CFG = {
    speed: 70,           // m/s ≈ 136 kn（巡航）
    outbound: 30000,     // 出航多远开始搜索
    searchLeg: 165,      // 每段搜索航程的时间（秒）
    searchLegs: 3,       // 搜索几段（来回扫）
    endurance: 1500,     // 留空时间（秒）—— 现实三四小时，这里压到 25 分钟
    sightBase: 24000,    // 天气好时的发现距离
    sightMin: 6000,
    reportGap: 75,       // 两次报告的最小间隔（发太密战报会刷屏）
    maxSea: 3,           // 海况超过这个数就收放不了
    minVis: 5000,
    recoverRadius: 1800,
    countErr: 0.22,      // 数错船数的概率
    autoDelay: 95        // 开战多久以后自动弹射
  };

  /* ---------------------------------------------------------------- 工具 */

  /** 飞行员能看多远 */
  function sightRange(world) {
    var w = world.weather || {};
    var vis = w.visibility || 12000;
    var r = U.clamp(vis * 1.7, CFG.sightMin, CFG.sightBase);
    if (w.rain > 0.4) r *= 0.62;
    if (w.squall) r *= 0.7;
    return r;
  }

  /** 南纬 8.30° 东经 157.05° */
  function fmtLatLon(ll) {
    var ns = ll.lat >= 0 ? '北纬' : '南纬';
    var ew = ll.lon >= 0 ? '东经' : '西经';
    return ns + Math.abs(ll.lat).toFixed(2) + '° ' + ew + Math.abs(ll.lon).toFixed(2) + '°';
  }

  /* ---------------------------------------------------------------- 收放 */

  /** 这艘舰现在能不能弹射水侦 */
  function canLaunch(world, ship) {
    var fp = ship && ship.cls ? ship.cls.floatplane : null;
    if (!fp) return { ok: false, reason: '本舰没有水上侦察机' };
    if (!world.scenario || world.scenario.floatplane !== true) {
      return { ok: false, reason: '本次任务没有配水侦' };
    }
    if (!ship.alive || ship.sunk || ship.sinking) return { ok: false, reason: '本舰已失去起降能力' };
    if (ship.airborne) return { ok: false, reason: '已有一架在空中' };
    var left = (ship.floatplanes == null) ? fp.count : ship.floatplanes;
    if (left <= 0) return { ok: false, reason: '水侦已全部损失' };

    var w = world.weather || {};
    if ((w.seaState || 0) > CFG.maxSea) {
      return { ok: false, reason: '海况 ' + w.seaState + '，弹射器放不出去' };
    }
    var vis = w.visibility || 12000;
    if (vis < CFG.minVis) return { ok: false, reason: '能见度太低，起飞没有意义' };

    var light = world.env ? world.env.light : 'day';
    if (light === 'night') {
      var moon = (N.Weather && N.Weather.moonEff) ? N.Weather.moonEff(w) : 0.5;
      if (moon < 0.30) return { ok: false, reason: '无月之夜，飞行员看不见海面' };
    }
    if (ship.speed > 28) return { ok: false, reason: '航速太快，弹射器用不了' };
    return { ok: true };
  }

  /** 弹射一架，沿 bearing 方向出航 */
  function launch(world, ship, bearing) {
    var chk = canLaunch(world, ship);
    if (!chk.ok) return chk;
    var fp = ship.cls.floatplane;
    if (ship.floatplanes == null) ship.floatplanes = fp.count;
    ship.floatplanes--;
    ship.airborne = true;

    world._planeSeq = (world._planeSeq || 0) + 1;
    var p = {
      id: 'P' + world._planeSeq,
      side: ship.side,
      ownerId: ship.id,
      ownerName: ship.name,
      name: fp.name,
      pos: Geo.dest(ship.pos, bearing, 700),
      heading: bearing,
      speed: CFG.speed,
      state: 'out',
      legT: 0, legs: 0,
      fuel: CFG.endurance,
      reports: 0,
      lastReport: -999,
      trail: [],
      done: false
    };
    if (!world.planes) world.planes = [];
    world.planes.push(p);

    world.log(ship.side, '🛩 ' + ship.name + ' 弹射了一架' + fp.name +
      '，搜索方位 ' + Math.round(bearing) + '°', 'info');
    world.bus.emit('plane', { kind: 'launch', plane: p });
    return { ok: true, plane: p };
  }

  function recover(world, p, owner) {
    p.done = true;
    owner.airborne = false;
    owner.floatplanes = (owner.floatplanes || 0) + 1;
    world.log(p.side, '🛩 ' + p.name + ' 降落回收，' + owner.name + ' 的机库又满了一格', 'info');
    world.bus.emit('plane', { kind: 'recover', plane: p });
  }

  function lose(world, p, why) {
    p.done = true;
    var owner = world.shipById(p.ownerId);
    if (owner) owner.airborne = false;
    world.log(p.side, '🛩 ' + p.name + ' 损失：' + why, 'bad');
    world.bus.emit('plane', { kind: 'lost', plane: p });
  }

  /* ---------------------------------------------------------------- 报告 */

  /**
   * 发一份文字情报。
   *
   * 报的是**飞行员在图上标出来的位置**，不是真实坐标：
   *   · 标图误差随距离涨（飞得越远，回算越糊）；
   *   · 船数可能多报/少报一条（远处几条船挤在一起，飞行员也数不清）；
   *   · 航向航速是估的。
   */
  function report(world, p, enemies) {
    // 水侦的目测误差也用自己的一条随机流，别搅乱战斗随机序列
    if (!world.planeRng) {
      world.planeRng = new N.RNG(((world.seedValue || 12345) ^ 0xF10A7) >>> 0);
    }
    var rng = world.planeRng;
    var cx = 0, cy = 0, i;
    for (i = 0; i < enemies.length; i++) { cx += enemies[i].pos.x; cy += enemies[i].pos.y; }
    cx /= enemies.length;
    cy /= enemies.length;

    var trueDist = V.dist(p.pos, { x: cx, y: cy });
    var err = 700 + trueDist * 0.06 + rng.range(0, 900);
    var rep = Geo.dest({ x: cx, y: cy }, rng.range(0, 360), Math.abs(rng.dev(err)));

    var n = enemies.length;
    if (rng.chance(CFG.countErr)) n = Math.max(1, n + (rng.chance(0.5) ? 1 : -1));

    // 航向航速取离飞机最近的那条（飞行员总是先看清最近的那艘）
    var near = enemies[0], bd = 1e9;
    for (i = 0; i < enemies.length; i++) {
      var d = V.dist(p.pos, enemies[i].pos);
      if (d < bd) { bd = d; near = enemies[i]; }
    }
    var course = U.norm360(near.heading + rng.dev(9));
    var speed = U.clamp(near.speed + rng.dev(1.6), 0, 40);

    var ll = N.Geo.xyToLonLat(rep.x, rep.y, N.MAP.refLon, N.MAP.refLat);
    world.log(p.side, '🛩 ' + p.name + '报告：' + fmtLatLon(ll) +
      ' 附近发现敌舰 ' + n + ' 艘，航向 ' + Math.round(course) + '°，航速 ' +
      Math.round(speed) + ' 节（飞行员标图，坐标不准）', 'contact');

    // 塞进指挥舰的观测表 —— 之后它会像别的接触一样融合、转发、外推
    var flag = N.Command && N.Command.flagshipOf ? N.Command.flagshipOf(world, p.side) : null;
    var map = flag ? (flag.ownTracks || (flag.ownTracks = {}))
      : (world.tracks[p.side] || (world.tracks[p.side] = {}));

    // 几架飞机报的是不是同一支舰队？离得近（6 km 以内）就并成同一条接触，
    // 让两份独立标图互相校准；离得远就各算一条。
    var fpKey = null;
    for (var mk in map) {
      var t2 = map[mk];
      if (!t2 || !t2.fromPlane) continue;
      if (V.dist(t2.pos, rep) < 6000) { fpKey = mk; break; }
    }
    if (!fpKey) {
      world._fpKeySeq = (world._fpKeySeq || 0) + 1;
      fpKey = 'FP' + world._fpKeySeq;
    }

    var echo = {
      key: fpKey,
      members: [], count: n, countKnown: true,
      pos: rep,
      posErr: err, errR: err, errC: err, axis: 0,
      range: 0, bearing: 0,
      idLevel: N.Sensors.ID.SURFACE,
      source: 'floatplane',
      esmOnly: false, visual: true, radar: false, esm: false,
      tgt: null
    };
    var tr = N.Sensors.fuse(world, map, echo, 0.1, p.side, flag);
    if (tr) {
      tr.course = course;
      tr.speed = speed;
      tr.count = n;
      tr.countKnown = true;
      tr.fromPlane = p.id;
    }
    world.bus.emit('plane', { kind: 'report', plane: p, track: tr });
  }

  /** 这一轮有没有看到敌人 */
  function tryReport(world, p) {
    if (world.time - p.lastReport < CFG.reportGap) return;
    var sight = sightRange(world);
    var enemies = [];
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (s.side === p.side || !s.alive || s.sunk) continue;
      if (V.dist(p.pos, s.pos) < sight) enemies.push(s);
    }
    if (!enemies.length) return;
    p.lastReport = world.time;
    p.reports++;
    report(world, p, enemies);
  }

  /* ---------------------------------------------------------------- 每帧 */

  function stepPlane(world, p, dt) {
    var owner = world.shipById(p.ownerId);
    p.fuel -= dt;
    if (p.fuel <= 0) { lose(world, p, '燃油耗尽，迫降在海面'); return; }
    p.legT += dt;

    if (p.state === 'out') {
      // 飞够距离、或者已经飞了很久（母舰在动），开始搜索
      if (V.dist(p.pos, owner ? owner.pos : p.pos) >= CFG.outbound || p.legT > 900) {
        p.state = 'search';
        p.legT = 0;
      }
    } else if (p.state === 'search') {
      if (p.legT > CFG.searchLeg) {
        p.legT = 0;
        p.legs++;
        p.heading = U.norm360(p.heading + ((p.legs % 2) ? 68 : -68));
        if (p.legs >= CFG.searchLegs * 2) p.state = 'back';
      }
    } else if (p.state === 'back') {
      if (!owner || owner.sunk || !owner.alive) { lose(world, p, '母舰沉没，无处降落'); return; }
      p.heading = Geo.bearing(p.pos, owner.pos);
      if (V.dist(p.pos, owner.pos) < CFG.recoverRadius) { recover(world, p, owner); return; }
    }

    var v = Geo.headingVec(p.heading);
    p.pos = { x: p.pos.x + v.x * p.speed * dt, y: p.pos.y + v.y * p.speed * dt };
    p.trail.push({ x: p.pos.x, y: p.pos.y });
    if (p.trail.length > 140) p.trail.shift();

    tryReport(world, p);
  }

  /** 到点了自己弹一架（不管玩家点不点，仗打起来了总会放） */
  function autoLaunch(world, ship) {
    var fp = ship.cls ? ship.cls.floatplane : null;
    if (!fp || ship.airborne) return;
    if (world.time < (ship._nextLaunch || 0)) return;
    ship._nextLaunch = world.time + 45;
    var chk = canLaunch(world, ship);
    if (!chk.ok) return;
    // 有目标就朝目标方向放，没有就朝本舰航向放
    var brg = ship.heading;
    var tr = ship.targetTrackId ? N.Sensors.trackFor(world, ship, ship.targetTrackId) : null;
    if (tr && tr.pos) brg = Geo.bearing(ship.pos, tr.pos);
    launch(world, ship, brg);
  }

  function init(world) {
    world.planes = [];
    world._planeSeq = 0;
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      var fp = s.cls ? s.cls.floatplane : null;
      if (!fp) continue;
      s.floatplanes = fp.count;
      s.airborne = false;
      // 这里不摇色子：初始化阶段消耗随机数会把整场的随机流整体推偏
      s._nextLaunch = CFG.autoDelay + (i * 13) % 40;
    }
  }

  function update(world, dt) {
    if (!world.planes) world.planes = [];

    // 自动弹射（只有剧本里点名配了水侦的任务才放）
    if (world.scenario && world.scenario.floatplane === true) {
      for (var i = 0; i < world.ships.length; i++) {
        var s = world.ships[i];
        if (!s.alive || s.sunk) continue;
        autoLaunch(world, s);
      }
    }

    for (var j = world.planes.length - 1; j >= 0; j--) {
      var p = world.planes[j];
      stepPlane(world, p, dt);
      if (p.done) world.planes.splice(j, 1);
    }
  }

  N.Floatplane = {
    CFG: CFG,
    init: init,
    update: update,
    launch: launch,
    canLaunch: canLaunch,
    sightRange: sightRange,
    fmtLatLon: fmtLatLon,
    report: report
  };
})(globalThis.Naval = globalThis.Naval || {});
