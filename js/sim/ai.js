/* =============================================================================
 *  sim/ai.js —— 战术 AI
 *
 *  重要：AI 同样只能使用 world.tracks[side] 里的航迹，不读取敌舰真实坐标，
 *        因此它也会打偏、也会误判，和玩家处在同一信息水平上。
 *
 *  日方战术条令（简化）：
 *    · 争取进入 10~14 km 的炮战距离
 *    · 一旦进入鱼雷射界就齐射九三式，然后转向脱离、重新装填
 *    · 重创后向西北撤退
 *  美方（自动部分）：优先用雷达获取的航迹选择目标，保持 12~17 km 炮战距离
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  /**
   * 两国海军打的不是同一场仗，所以战法也不该一样。
   *
   * 美军有雷达火控（Mk 3/Mk 4 + SG），十几公里上就能解算射击诸元；
   * 日军靠九四式光学方位盘，指挥仪本身很好，但**看不见就打不了**。
   * 所以：
   *   · 美军白天压到 7~16 km 对轰（8 英寸炮在这个距离上能打穿日舰舷侧），
   *     夜里靠雷达拉到 11.5~16.5 km —— 这个距离上日军既看不见也打不着，
   *     而美军能打。
   *   · 日军必须**压进去**：5~11 km，光学指挥仪在这个距离上不吃亏，
   *     而且进了九三式鱼雷的扇面。
   *   · 美军不让日军进到 9.5 km 以内 —— 那是鱼雷射程。
   *     （被照明弹照到就没这个便宜了：日军看得见，距离就得让出来。）
   */
  var DOCTRINE = {
    US: {
      engageMin: 7000,     // 白天两边都看得见，该压上去打穿甲弹
      engageMax: 16000,
      nightMin: 11500,     // 有雷达优势时（夜里、对方看不见）拉得更开
      nightMax: 16500,
      torpFrac: 0.72,
      torpSpread: 2.0,
      aggression: 0.9
    },
    JP: {
      engageMin: 5200,
      engageMax: 11500,
      nightMin: 5200,
      nightMax: 11500,
      torpFrac: 0.42,
      torpSpread: 2.6,
      aggression: 1.2
    }
  };

  function ensureAI(ship, world) {
    if (ship.ai) return ship.ai;
    ship.ai = {
      next: 0,
      targetId: null,
      state: 'PATROL',
      torpCooldown: 0,
      turnAwayUntil: 0,
      evadeUntil: 0,
      evadeHeading: 0,
      lastRange: 0,
      nextManeuver: 0,
      lastState: 'PATROL',
      home: world.homePos[ship.side] || { x: 0, y: 0 }
    };
    // 每艘舰有各自的偏好，避免全队死盯同一个目标
    ship._targetBias = 0.75 + world.rng.next() * 0.6;
    return ship.ai;
  }

  function targetScore(world, ship, tr) {
    var d = V.dist(ship.pos, tr.pos);
    var threat = 1.0;
    var guess = (tr.idLevel >= 2 && tr.typeGuess) ? tr.typeGuess : null;
    if (guess) {
      // 不同舰种有各自的优先目标：驱逐舰优先打对方驱逐舰，巡洋舰优先打对方巡洋舰
      var pref = ship.cls.type === 'DD'
        ? { DD: 1.9, CL: 1.3, CA: 0.7 }
        : { DD: 0.9, CL: 1.35, CA: 1.9 };
      threat = pref[guess] || 1.0;
    }
    var age = world.time - tr.lastSeen;
    var freshness = age < 30 ? 1.0 : (age < 120 ? 0.7 : 0.4);
    var bias = ship._targetBias || 1;
    return threat * freshness * bias * 10000 / (d + 4000);
  }

  function pickTarget(world, ship) {
    /* 识别器认错了：这条船正把一条友舰当成敌舰，别的目标都得靠边站。
       它会一直打到识别纠正为止 —— 这就是误伤。 */
    if (ship.ffTrack && world.time < (ship.ffUntil || 0)) return ship.ffTrack;

    /* 参谋部已经给这条舰分了目标：就按它打，别自己另挑一个 */
    if (ship.aiTask && ship.aiTask.targetId) {
      var t0 = N.Sensors.trackFor(world, ship, ship.aiTask.targetId);
      if (t0 && t0.pos && !t0.phantom && !t0.esmOnly &&
        world.time - t0.lastSeen < 300) return t0;
    }

    var tracks = N.Sensors.trackList(world, ship.side);
    var best = null, bestScore = -1;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (!tr.pos) continue;
      if (world.time - tr.lastSeen > 300) continue;
      /* 电探给的只是方位，测不出距离 —— 打不了。AI 也不会拿它当目标，
         但可以照它那个方向开过去（那一段在 steer 里读航迹，不走这里）。 */
      if (tr.esmOnly) continue;
      /* 假回波：海杂波和二次回波也会在屏幕上留一个亮点。舰上的人不会
         拿一个没有航向、忽大忽小的点当目标，AI 也不该去追。 */
      if (tr.phantom) continue;
      /* 炮口闪光：知道"那边有人在开炮"，但那是一个事件，不是一个能瞄准的目标。
         拿它当目标只会把炮弹打进空海面 —— AI 不干这种亏本买卖。 */
      if (tr.fromFlash) continue;
      var sc = targetScore(world, ship, tr);
      if (sc > bestScore) { bestScore = sc; best = tr; }
    }
    return best;
  }

  /** 找最近的被护航对象（运输船 / 撤退舰） */
  function wardOf(world, ship) {
    // 参谋部点名要护送的那条舰（撤退中的伤舰）优先
    if (ship.aiTask && ship.aiTask.wardId) {
      var w0 = world.shipById(ship.aiTask.wardId);
      if (w0 && !w0.sunk && w0.alive) return w0;
    }
    var best = null, bd = 1e9;
    for (var i = 0; i < world.ships.length; i++) {
      var o = world.ships[i];
      if (o === ship || o.side !== ship.side || o.sunk) continue;
      if (o.role !== 'transport' && o.role !== 'escortee') continue;
      var d = V.dist(ship.pos, o.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** 护航阵位：在被护航舰周围按舰名散开，避免挤成一团 */
  function escortStation(ship, ward) {
    var h = 0;
    for (var i = 0; i < ship.name.length; i++) h = (h * 31 + ship.name.charCodeAt(i)) & 0xffff;
    return Geo.dest(ward.pos, ward.heading + 20 + (h % 6) * 55, 2400);
  }

  /** 陆地规避：如果前方航路上有陆地，返回修正后的航向。
   *  goal 可选：用来在左右两个绕行方向之间做选择（朝目标那一侧绕）。 */
  function avoidLand(world, ship, heading, goal) {
    var probes = [700, 1500, 2400, 3600];

    // 返回“通到第几档”：4 = 3.6 km 内全程无陆地，0 = 700 m 内就有陆地
    function clearOf(h) {
      for (var k = 0; k < probes.length; k++) {
        var p = Geo.dest(ship.pos, h, probes[k]);
        if (world.isLand(p.x, p.y)) return k;
      }
      return probes.length;
    }

    // 刚选过的绕行方向先保持一会儿，避免每帧左右摇摆
    if (ship._avoidH != null && world.time < ship._avoidUntil) {
      if (clearOf(ship._avoidH) === probes.length) return ship._avoidH;
    }

    var base = clearOf(heading);
    if (base === probes.length) { ship._avoidH = null; return heading; }

    var opts = [20, -20, 35, -35, 50, -50, 70, -70, 90, -90, 115, -115, 140, -140, 165, -165];
    var bestH = heading, bestScore = -1;
    for (var i = 0; i < opts.length; i++) {
      var h = U.norm360(heading + opts[i]);
      var s = clearOf(h);
      if (s === 0) continue;                       // 这个方向立刻撞，直接排除
      // 能通得更远最重要；同样远时，选走 2.4 km 后更靠近目标的那一侧
      var score = s * 1e6;
      if (goal) score -= V.dist(Geo.dest(ship.pos, h, 2400), goal);
      else score -= Math.abs(opts[i]) * 50;
      if (score > bestScore) { bestScore = score; bestH = h; }
    }

    if (bestScore < 0) {
      // 四面八方都堵死（贴岸）：朝离水面最远的方向硬挤出去
      var fd = -1;
      for (var j = 0; j < opts.length; j++) {
        var hh = U.norm360(heading + opts[j]);
        var q = Geo.dest(ship.pos, hh, 900);
        var w = world.nearestWater ? world.nearestWater(q.x, q.y, 9000) : null;
        if (w && w.d > fd) { fd = w.d; bestH = hh; }
      }
    }

    ship._avoidH = bestH;
    ship._avoidUntil = world.time + 12;
    return bestH;
  }

  /** 与友舰保持距离，避免碰撞 */
  function avoidShips(world, ship, heading) {
    for (var i = 0; i < world.ships.length; i++) {
      var o = world.ships[i];
      if (o === ship || o.side !== ship.side || o.sunk || !o.alive) continue;
      var d = V.dist(ship.pos, o.pos);
      if (d > 900) continue;
      var brgToOther = Geo.bearing(ship.pos, o.pos);
      var rel = Math.abs(U.angDiff(brgToOther, heading));
      if (rel < 45) {
        var away = U.norm360(brgToOther + 180);
        heading = U.approachAngle(heading, away, 8);
      }
    }
    return heading;
  }

  /** 规避已发现的来袭鱼雷 */
  function evadeTorpedoes(world, ship, ai) {
    if (world.time < ai.evadeUntil) return true;
    for (var i = 0; i < world.torpedoes.length; i++) {
      var t = world.torpedoes[i];
      if (t.side === ship.side) continue;
      // 只有被瞭望哨发现的鱼雷航迹才可能规避
      if (!t.spotted) continue;
      var d = V.dist(ship.pos, t.pos);
      if (d > 1400) continue;
      var brgToShip = Geo.bearing(t.pos, ship.pos);
      if (Math.abs(U.angDiff(brgToShip, t.heading)) > 25) continue;
      ai.evadeUntil = world.time + 40;
      ai.evadeHeading = U.norm360(ship.heading + (world.rng.chance(0.5) ? 80 : -80));
      world.log(ship.side, '⚠ ' + ship.name + ' 发现鱼雷航迹，紧急转向！', 'warn');
      return true;
    }
    return false;
  }

  /** 最近的敌方航迹（限定距离内） */
  function nearestEnemyTrack(world, ship, maxDist) {
    var list = N.Sensors.trackList(world, ship.side);
    var best = null, bestD = maxDist;
    for (var i = 0; i < list.length; i++) {
      if (list[i].phantom) continue;
  if (list[i].fromFlash) continue;   // 闪光不是船，不能当射击目标
      var d = V.dist(ship.pos, list[i].pos);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  /** 最近的未摧毁岸上目标 */
  function nearestShoreTarget(world, ship) {
    var best = null, bestD = 1e12;
    for (var i = 0; i < world.shoreTargets.length; i++) {
      var t = world.shoreTargets[i];
      if (t.destroyed) continue;
      var d = V.dist(ship.pos, t.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * 夜间照明：交给舰队参谋部统一管（`N.Tactics.illuminate`）。
   * 这里只留一个兜底：万一 tactics.js 没加载，就还按老规矩打。
   */
  function considerStarshell(world, ship) {
    if (N.Tactics) return;
    if (!ship.starshells || ship.starshellCd > 0) return;
    if (!world.env || world.env.light === 'day') return;
    var vis = (world.weather && world.weather.visibility) ||
      (world.env.visibility != null ? world.env.visibility : 12000);
    if (vis >= 9000) return;
    var tr = nearestEnemyTrack(world, ship, 11500);
    if (!tr) return;
    var d = V.dist(ship.pos, tr.pos);
    if (d < 4500) return;
    if (world.illuminationAt(tr.pos) > 0) return;
    var lead = Geo.lead(tr.pos, tr.course, tr.speed, 3.5);
    world.fireStarshell(ship, lead);
  }

  /* ==========================================================================
   *  任务执行：掩护 / 雷击 / 前出搜索
   *  参谋部（tactics.js）只负责"派活"，具体怎么开船还是在这里。
   * ========================================================================== */

  /** 掩护船队：守在被护航舰周围，敌人逼近船队才迎上去 */
  function doScreen(world, ship, ai, track, doc) {
    var ward = wardOf(world, ship);
    if (!ward) return false;

    var wardThreat = track ? V.dist(ward.pos, track.pos) : 1e9;

    /* 敌人已经摸到船队跟前：拦在它和船队之间，这时候不守阵位了 */
    if (track && wardThreat < 13000) {
      var myRange = V.dist(ship.pos, track.pos);
      ship.engage = myRange < ship.gunRangeMax * 0.98;
      // 拦在敌人和船队连线上、靠敌人那一侧
      var between = Geo.dest(ward.pos, Geo.bearing(ward.pos, track.pos), 3000);
      var want = Geo.bearing(ship.pos, between);
      ship.orderedHeading = avoidLand(world, ship, avoidShips(world, ship, want), track.pos);
      ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.92;
      return true;
    }

    ship.engage = !!track && V.dist(ship.pos, track.pos) < ship.gunRangeMax * 0.95;
    var station = escortStation(ship, ward);
    if (V.dist(ship.pos, station) > 900) {
      ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, station), station);
      ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.8;
    } else {
      ship.orderedHeading = avoidLand(world, ship, ward.heading, ward.pos);
      ship.orderedSpeed = Math.min(ship.effectiveMaxSpeed() * 0.7, ward.speed + 5);
    }
    return true;
  }

  /** 同一支舰队不要对着同一条船反复放雷 */
  function torpedoWindowOpen(world, ship, track) {
    if (!world._torpClaims) world._torpClaims = {};
    var k = ship.side + ':' + track.id;
    return world.time >= (world._torpClaims[k] || 0);
  }

  function claimTorpedoWindow(world, ship, track) {
    if (!world._torpClaims) world._torpClaims = {};
    world._torpClaims[ship.side + ':' + track.id] = world.time + 45;
  }

  /** 雷击：高速抢占发射阵位 → 齐射 → 转向脱离 */
  function doTorpedo(world, ship, ai, track, doc, rng) {
    var range = V.dist(ship.pos, track.pos);
    var brg = Geo.bearing(ship.pos, track.pos);
    ai.lastRange = range;

    // 雷击航路上顺手也开炮
    ship.engage = range < ship.gunRangeMax * 0.98;

    /* 协同齐射：参谋部给这一轮雷击舰排了"分道"和"齐射时刻"。
       目标位置本身有误差，几条舰横着铺开、差不多同时放雷，
       目标往哪边躲都会撞上一条。 */
    var salvo = (N.Tactics && N.Tactics.salvoFor) ? N.Tactics.salvoFor(world, ship) : null;
    var lane = (ship.aiTask && ship.aiTask.lane) || 0;
    var holding = !!(salvo && world.time < salvo.readyAt);

    if (!holding && ai.torpCooldown <= world.time && !ship.ffTrack &&
      torpedoWindowOpen(world, ship, track)) {
      var trng = ship.torpRangeMax * doc.torpFrac;
      /* 鱼雷是有限的：阳炎级一共 16 条，四条一次就只能放四轮。
         只剩最后几条的时候不再远距离撒 —— 近了再打，一条当一条用。 */
      if (ship.torpedoesLeft && ship.torpedoesLeft() <= 4) trng *= 0.7;
      var rel = Math.abs(U.angDiff(brg, ship.heading));
      if (range < trng && rel > 40 && rel < 140) {
        // 距离越远，扇面越宽 —— 远了目标跑得出散布
        var spread = U.clamp(1.3 + range / 5200, 1.3, 4.4);
        // 分道：横着偏开几百米，几条舰的雷不叠在一个点上
        var aim = lane
          ? Geo.dest(track.pos, U.norm360(brg + 90), lane * 480)
          : track.pos;
        for (var ti = 0; ti < ship.torps.length; ti++) {
          var mount = ship.torps[ti];
          if (mount.disabled || mount.destroyed || mount.fault || mount.loaded <= 0) continue;
          var n = Math.min(mount.loaded, 4);
          var fired = N.Combat.launchTorpedoes(world, ship, mount, aim,
            track.course, track.speed, n, spread);
          if (fired > 0) {
            ai.torpCooldown = world.time + rng.range(150, 220);
            ai.turnAwayUntil = world.time + 70;
            claimTorpedoWindow(world, ship, track);
            if (ship.aiTask) ship.aiTask.note = '雷击 ' + track.id + ' · 已齐射';
            world.log(ship.side, ship.name + ' 发射鱼雷！', 'info');
            break;
          }
        }
      }
    }

    if (world.time < ai.turnAwayUntil) {
      // 放完雷立刻把舰尾转过去，别让敌人拿舷侧打你
      ship.orderedHeading = avoidLand(world, ship, U.norm360(brg + 115), track.pos);
      ship.orderedSpeed = ship.effectiveMaxSpeed();
      return;
    }

    var fireR = ship.torpRangeMax * doc.torpFrac;
    if (holding && range > fireR * 0.75) {
      // 还没到齐射时刻，而且还有余量：先占位（略偏一点，别一直正对着）
      var hb = Geo.bearing(ship.pos, track.pos);
      var wantH = U.norm360(hb + (lane >= 0 ? 55 : -55));
      ship.orderedHeading = avoidLand(world, ship, avoidShips(world, ship, wantH), track.pos);
      ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.85;
      return;
    }
    if (range > fireR * 1.05) {
      // 还没到射程：全速拦截
      var want = Geo.interceptBearing(ship.pos, track.pos, track.course,
        track.speed * U.KNOT_MS, ship.effectiveMaxSpeed() * U.KNOT_MS);
      ship.orderedHeading = avoidLand(world, ship, avoidShips(world, ship, want), track.pos);
      ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.98;
    } else {
      // 进入射程：把舷侧摆过去，等管里装满
      var rel2 = U.angDiff(brg, ship.heading);
      var want2 = U.norm360(brg + (rel2 >= 0 ? 80 : -80));
      ship.orderedHeading = avoidLand(world, ship, avoidShips(world, ship, want2), track.pos);
      ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.78;
    }
  }

  /** 前出搜索：全速奔可疑海域，到了以后扇形扫 */
  function doScout(world, ship, ai, doc) {
    ship.engage = false;
    var toward = (world.searchPos && world.searchPos[ship.side === 'US' ? 'JP' : 'US'])
      || world.homePos[ship.side === 'US' ? 'JP' : 'US'];
    // 有无线电测向方位就顺着它找 —— 比闷头开往搜索海域聪明。
    // 侦察舰比主力压得更近（2400 m），这样才真的"前出"而不是跟着队伍走。
    var app = N.Tactics && N.Tactics.approachPoint
      ? N.Tactics.approachPoint(world, ship.side, ship.pos, 2400) : null;
    if (app) toward = app;
    // 两条侦察舰左右分开，拉成一条搜索线 —— 一起走等于只有一双眼睛。
    // 偏的是"航向"而不是"目标点"：目标点常在几十公里外，横向挪几公里
    // 只差两度，等于没挪。
    if (ai.scoutSide === undefined) ai.scoutSide = ship._scoutSide || (rng0(world) ? 1 : -1);
    var d = V.dist(ship.pos, toward);
    if (d > 6500) {
      var want = U.norm360(Geo.bearing(ship.pos, toward) + 26 * ai.scoutSide);
      ship.orderedHeading = avoidLand(world, ship, want, toward);
      ship.orderedSpeed = ship.effectiveMaxSpeed();
      return;
    }
    // 到位了：左右摆着扫，雷达和瞭望一起用
    if (!ai.scoutTurn || world.time > ai.scoutTurn) {
      ai.scoutTurn = world.time + 120;
      ai.scoutHdg = U.norm360((ai.scoutHdg || ship.heading) + (rng0(world) ? 70 : -70));
    }
    ship.orderedHeading = avoidLand(world, ship, ai.scoutHdg || ship.heading, toward);
    ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.6;
  }

  function rng0(world) { return world.rng.chance(0.5); }

  function updateShip(world, ship) {
    var ai = ensureAI(ship, world);
    var doc = DOCTRINE[ship.side] || DOCTRINE.US;
    var rng = world.rng;
    var T = (N.Tactics && N.Tactics.ROLE) || {};
    var role = (ship.aiTask && ship.aiTask.role) || null;

    /* ---------- 消焰发射药 ----------
       夜里有就用：这个距离上对方本来就看不见你，唯一会暴露位置的是
       炮口那团火球。代价是射程打九二折、散布略大，所以只在天黑时开。
       备用弹有限（约占主炮弹药的三分之一），打光了自动回到普通弹。 */
    if (ship.flashlessLeft) {
      ship.flashlessOn = ship.flashlessLeft() > 0 && world.isDark &&
        world.isDark() && (world.weather.visibility || 12000) < 11000;
    }

    /* ---------- 运输船：只负责开到目的地 ---------- */
    if (ship.cls.type === 'AK' || ship.role === 'transport') {
      var dest = ship.destination;
      ship.engage = false;
      if (dest) {
        var dd = V.dist(ship.pos, dest);
        if (dd < 900) {
          ship.orderedSpeed = 0;
        } else {
          ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, dest), dest);
          ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.95;
        }
      } else {
        ship.orderedSpeed = ship.cls.cruiseSpeed;
      }
      return;
    }

    /* ---------- 撤退舰：全速驶向撤离区，不交战 ---------- */
    if (ship.role === 'escortee') {
      var ez = world.zoneById(ship.aiExitZone || 'exit');
      ship.engage = false;
      if (ez) {
        if (V.dist(ship.pos, ez.pos) > ez.r * 0.6) {
          ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, ez.pos), ez.pos);
          ship.orderedSpeed = ship.effectiveMaxSpeed();
        } else {
          ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.8;
        }
      }
      return;
    }

    /* ---------- 规避 ---------- */
    if (evadeTorpedoes(world, ship, ai)) {
      ship.orderedHeading = avoidLand(world, ship, ai.evadeHeading);
      ship.orderedSpeed = ship.effectiveMaxSpeed();
      return;
    }

    /* ---------- 夜间照明 ---------- */
    considerStarshell(world, ship);

    /* ---------- 突入任务：不管交战结果，先冲进目标区 ---------- */
    if (ship.aiRole === 'raid') {
      var rz = world.zoneById(ship.raidZone || 'landing');
      var nearE = nearestEnemyTrack(world, ship, 11000);
      if (nearE) {
        ship.targetTrackId = nearE.id;
        ship.engage = true;
      } else {
        ship.engage = false;
      }
      if (rz && !world.inZone(ship.pos, rz)) {
        ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, rz.pos), rz.pos);
        ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.88;
      } else if (rz) {
        // 已经冲进去了：低速在区内游走，边打边炸
        ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.25;
        if (!ai.raidTurn || world.time > ai.raidTurn) {
          ai.raidTurn = world.time + 90;
          ai.raidHdg = U.norm360(ship.heading + (world.rng.chance(0.5) ? 60 : -60));
        }
        ship.orderedHeading = avoidLand(world, ship, ai.raidHdg || ship.heading);
      }
      return;
    }

    /* ---------- 岸轰任务 ---------- */
    if (ship.aiRole === 'bombard' && world.shoreTargets.length) {
      var threat = nearestEnemyTrack(world, ship, 13000);
      if (!threat) {
        var st = nearestShoreTarget(world, ship);
        if (st) {
          ship.bombardTargetId = st.id;
          ship.engage = false;
          var sd = V.dist(ship.pos, st.pos);
          var sbrg = Geo.bearing(ship.pos, st.pos);
          if (sd > ship.gunRangeMax * 0.80) {
            ship.orderedHeading = avoidLand(world, ship, sbrg, st.pos);
            ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.9;
          } else {
            // 已进入射程：保持舷侧对岸，低速机动
            var sgn = (U.angDiff(sbrg, ship.heading) >= 0) ? 1 : -1;
            ship.orderedHeading = avoidLand(world, ship, U.norm360(sbrg + 72 * sgn), st.pos);
            ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.35;
          }
          return;
        }
      } else {
        ship.bombardTargetId = null;
      }
    }

    /* ---------- 撤退判定 ---------- */
    var badlyHurt = (ship.flood > 55) || (ship.hull < ship.hullMax * 0.30);
    if (role === T.WITHDRAW) badlyHurt = true;
    if (badlyHurt && ai.state !== 'RETREAT') {
      ai.state = 'RETREAT';
      world.log(ship.side, ship.name + ' 失去战斗力，正在脱离', ship.side === world.playerSide ? 'warn' : 'good');
    }
    if (ai.state === 'RETREAT') {
      if (ship.hull > ship.hullMax * 0.45 && ship.flood < 40) ai.state = 'ENGAGE';
      else {
        var hb = Geo.bearing(ship.pos, ai.home);
        ship.orderedHeading = avoidLand(world, ship, hb, ai.home);
        ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.95;
        ship.engage = false;
        return;
      }
    }

    /* ---------- 目标选择 ---------- */
    if (world.time > ai.next) {
      ai.next = world.time + rng.range(3, 7);
      var tr = pickTarget(world, ship);
      if (tr) {
        ai.targetId = tr.id;
        if (ship.autoTarget !== false) {
          ship.targetTrackId = tr.id;
          ship.autoTarget = true;
        }
      } else {
        ai.targetId = null;
        if (ship.autoTarget !== false) ship.targetTrackId = null;
      }
    }

    var track = ship.targetTrackId ? N.Sensors.trackFor(world, ship, ship.targetTrackId) : null;

    /* ---------- 任务：掩护船队 ----------
       掩护舰不追敌人：守在船队旁边，敌人摸到 13 km 以内才迎上去。 */
    if (role === T.SCREEN && doScreen(world, ship, ai, track, doc)) return;

    if (!track || world.time - track.lastSeen > 300) {
      // 无目标：前往敌可能出现的海域搜索
      ship.engage = false;
      if (ai.state !== 'PATROL') { ai.state = 'PATROL'; }

      /* ---------- 任务：前出搜索 ----------
         参谋部派的侦察舰直奔可疑海域，不和船队挤在一起。 */
      if (role === T.SCOUT) { doScout(world, ship, ai, doc); return; }

      /* 刚才还在打它，一转眼丢了：往它最后出现的位置追，
         而不是掉头回预设海域 —— 它多半只是躲进了雨飑或者夜暗里。 */
      var lastP = ship.aiTask && ship.aiTask.lastPos;
      if (lastP && (role === T.GUN || role === T.TORPEDO) &&
        world.time - lastP.t < 240 && V.dist(ship.pos, lastP) > 3500) {
        ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, lastP), lastP);
        ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.9;
        return;
      }

      var toward = (world.searchPos && world.searchPos[ship.side === 'US' ? 'JP' : 'US'])
        || world.homePos[ship.side === 'US' ? 'JP' : 'US'];
      // 只有无线电测向方位时：整队顺着那个方位压上去，
      // 接近到能打照明弹、能看见的距离，而不是闷头开往预设海域
      var bapp = N.Tactics && N.Tactics.approachPoint
        ? N.Tactics.approachPoint(world, ship.side, ship.pos, 5200) : null;
      if (bapp) toward = bapp;

      // 护航舰不要丢下被护航对象跑去搜索海域——跟着船队走
      var ward = (ship.role === 'transport' || ship.role === 'escortee') ? null : wardOf(world, ship);
      if (ward && V.dist(ship.pos, ward.pos) < 14000) {
        var station = escortStation(ship, ward);
        if (V.dist(ship.pos, station) > 900) {
          ship.orderedHeading = avoidLand(world, ship, Geo.bearing(ship.pos, station), station);
          ship.orderedSpeed = ship.effectiveMaxSpeed() * 0.8;
        } else {
          // 已在阵位：跟着船队同向同速
          ship.orderedHeading = avoidLand(world, ship, ward.heading, ward.pos);
          ship.orderedSpeed = Math.min(ship.effectiveMaxSpeed() * 0.7, ward.speed + 5);
        }
        return;
      }

      var dSearch = V.dist(ship.pos, toward);
      if (dSearch < 4500) {
        // 已经在搜索海域附近：原地巡逻，等待目标出现
        if (!ai.patrolTurn || world.time > ai.patrolTurn) {
          ai.patrolTurn = world.time + 150;
          ai.patrolHdg = U.norm360(ship.heading + (world.rng.chance(0.5) ? 100 : -100));
        }
        ship.orderedHeading = avoidLand(world, ship, ai.patrolHdg || ship.heading);
        ship.orderedSpeed = ship.pursue ? ship.effectiveMaxSpeed() * 0.55 : ship.cls.cruiseSpeed;
        return;
      }
      var h = Geo.bearing(ship.pos, toward);
      ship.orderedHeading = avoidLand(world, ship, h, toward);
      // 追击任务用高航速，普通巡逻用巡航速度
      ship.orderedSpeed = ship.pursue
        ? ship.effectiveMaxSpeed() * 0.92
        : ship.cls.cruiseSpeed * 1.4;
      return;
    }

    var range = V.dist(ship.pos, track.pos);
    var brg = Geo.bearing(ship.pos, track.pos);
    ai.lastRange = range;

    /* ---------- 任务：雷击 ----------
       参谋部点名的雷击舰走一条专门的航路：先高速抢位，再摆舷侧齐射，
       放完立刻转向脱离 —— 而不是像炮战舰那样横着慢慢磨。 */
    if (role === T.TORPEDO && ship.torpRangeMax > 0 && !ship.ffTrack) {
      doTorpedo(world, ship, ai, track, doc, rng);
      return;
    }

    /* ---------- 交战 ---------- */
    var gunRange = ship.gunRangeMax;
    var inRange = range < gunRange * 0.98;
    ship.engage = inRange;

    /* ---------- 鱼雷 ---------- */
    /* 鱼雷不放：发射前要"确认目标"，这是各国海军的硬规定，也是本作里
       识别器认错时唯一的刹车 —— 炮可能误击，鱼雷不会。 */
    if (ai.torpCooldown <= world.time && ship.torpRangeMax > 0 && !ship.ffTrack &&
      torpedoWindowOpen(world, ship, track)) {
      var trng = ship.torpRangeMax * doc.torpFrac;
      var rel = Math.abs(U.angDiff(brg, ship.heading));
      if (range < trng && rel > 35 && rel < 145) {
        var spread = U.clamp(1.3 + range / 5200, 1.3, 4.4);
        for (var ti = 0; ti < ship.torps.length; ti++) {
          var mount = ship.torps[ti];
          if (mount.disabled || mount.destroyed || mount.fault || mount.loaded <= 0) continue;
          var n = Math.min(mount.loaded, 4);
          var fired = N.Combat.launchTorpedoes(world, ship, mount, track.pos, track.course, track.speed, n, spread);
          if (fired > 0) {
            ai.torpCooldown = world.time + rng.range(180, 260);
            ai.turnAwayUntil = world.time + 75;
            claimTorpedoWindow(world, ship, track);
            world.log(ship.side === world.playerSide ? 'US' : 'JP',
              ship.name + ' 发射鱼雷！', 'info');
            break;
          }
        }
      }
    }

    /* ---------- 机动 ---------- */
    /* 舰艇在炮战中并不会持续蛇行：航向每隔十几秒才修正一次，
       这也让鱼雷的提前量解算变得有意义。 */
    /* 雷达优势：夜里能看见对方、对方看不见自己。
       这种时候不抢近战，拉开距离慢慢打 —— 对方连你在哪都不知道。
       一旦自己被照明弹照亮，这个便宜就没了，距离要让出来。 */
    var visNow = (world.weather && world.weather.visibility) || 12000;
    var radarEdge = !!ship.cls.radar && visNow < 9000 &&
      world.illuminationAt(ship.pos) <= 0;
    /* 只有大舰才"拉开打"：驱逐舰的 5 英寸炮在 11 km 上打不准，
       而且它们的鱼雷射程只有 6 km —— 躲远了等于什么也做不了。 */
    var canStandOff = radarEdge && ship.cls.type !== 'DD';
    var eMin = canStandOff ? (doc.nightMin || doc.engageMin) : doc.engageMin;
    var eMax = canStandOff ? (doc.nightMax || doc.engageMax) : doc.engageMax;

    var stateChanged = (ai.lastState !== ai.state);
    ai.lastState = ai.state;
    var force = stateChanged || world.time < ai.turnAwayUntil;
    if (force || world.time > (ai.nextManeuver || 0)) {
      ai.nextManeuver = world.time + rng.range(12, 22);
      var wantHeading;
      if (world.time < ai.turnAwayUntil) {
        // 发射后脱离：把舷侧/舰尾转向敌方
        wantHeading = U.norm360(brg + 115);
      } else if (range > eMax) {
        // 接近：取拦截航向
        wantHeading = Geo.interceptBearing(ship.pos, track.pos, track.course, track.speed * U.KNOT_MS,
          ship.effectiveMaxSpeed() * U.KNOT_MS);
      } else if (range < eMin) {
        // 太近：先摆到 100° 边打边把距离拉开（炮还能响）；
        // 被逼到很近才真的掉头走 —— 掉头就意味着把炮都背过去。
        wantHeading = U.norm360(brg + (range < eMin * 0.7 ? 145 : 100));
      } else {
        // 保持舷侧对敌，便于全炮门和鱼雷发射
        var side = (U.angDiff(brg, ship.heading) >= 0) ? 1 : -1;
        wantHeading = U.norm360(brg + 68 * side);
      }

      wantHeading = avoidLand(world, ship, wantHeading, track.pos);
      wantHeading = avoidShips(world, ship, wantHeading);
      ai.desiredHeading = wantHeading;

      var speedFrac = range > eMax ? 0.95 : (range < eMin ? 0.98 : 0.72);
      if (world.time < ai.turnAwayUntil) speedFrac = 1.0;
      ai.desiredSpeed = ship.effectiveMaxSpeed() * speedFrac;
    }

    if (ai.desiredHeading === undefined) ai.desiredHeading = ship.heading;
    ship.orderedHeading = ai.desiredHeading;
    ship.orderedSpeed = ai.desiredSpeed !== undefined ? ai.desiredSpeed : ship.cls.cruiseSpeed;
  }

  /* ==========================================================================
   *  对外接口
   * ========================================================================== */
  var AI = {
    doctrine: DOCTRINE,

    /**
     * @param {Object} world
     * @param {number} dt
     * @param {string} side 要驱动的阵营
     * @param {boolean} controlMovement 是否接管运动（敌方=true，友方=false 时只做目标分配）
     */
    update: function (world, dt, side, controlMovement) {
      /* 这一方交给了外部代理（DeepSeek）就不要再让内置参谋部抢舵 ——
         参谋部每 6~7 秒重排一次，会把代理下的令全部覆盖掉。 */
      var external = !!(world.dsControl && world.dsControl[side]);

      /* 先让参谋部分工、安排照明弹（它自己会按间隔限流） */
      if (N.Tactics && !external) {
        N.Tactics.plan(world, side);
        N.Tactics.illuminate(world, side);
      }

      /* 玩家自己那一侧：除非开了自动指挥，否则不许 AI 抢舵 */
      var playerSide = (side === world.playerSide) && !world.autopilot;
      var ships = world.ships;
      for (var i = 0; i < ships.length; i++) {
        var s = ships[i];
        if (s.side !== side || s.sunk || !s.alive) continue;

        /* 外部代理控制的舰：航向航速由代理给，舰长只保留两个本能 ——
           绕开陆地、躲鱼雷。别的什么都不做。 */
        if (external) {
          var extAI = ensureAI(s, world);
          if (evadeTorpedoes(world, s, extAI)) {
            s.orderedHeading = avoidLand(world, s, extAI.evadeHeading);
            s.orderedSpeed = s.effectiveMaxSpeed();
          } else {
            s.orderedHeading = avoidLand(world, s, s.orderedHeading);
          }
          continue;
        }

        if (s.isPlayerControlled && (!controlMovement || playerSide)) {
          // 玩家控制的舰只：只自动分配目标，不动航向
          var ai = ensureAI(s, world);
          if (world.time > ai.next) {
            ai.next = world.time + 4;
            if (s.autoTarget !== false) {
              var tr = pickTarget(world, s);
              if (tr) s.targetTrackId = tr.id;
            }
            var t2 = s.targetTrackId ? N.Sensors.trackFor(world, s, s.targetTrackId) : null;
            var nowEngage = !!t2 && V.dist(s.pos, t2.pos) < s.gunRangeMax * 0.98;
            // 玩家明确下过开火/停火令时，自动逻辑只负责“是否在射程内”
            if (s.playerFireOrder === undefined) s.engage = nowEngage;
            else s.engage = s.playerFireOrder && nowEngage;
            if (s.engage && !s._wasEngaging) {
              world.log(s.side, s.name + ' 进入射程，开始射击', 'info');
            }
            s._wasEngaging = s.engage;
          }
          // 编在小队里的舰：航向航速交给战列线保持，但鱼雷来了照样要躲
          if (s.squadId && world.squadById(s.squadId)) {
            if (evadeTorpedoes(world, s, ai)) {
              s.orderedHeading = avoidLand(world, s, ai.evadeHeading);
              s.orderedSpeed = s.effectiveMaxSpeed();
            } else {
              N.Squad.stationKeep(world, s);
            }
          }
          continue;
        }
        updateShip(world, s);
      }
    },

    pickTarget: pickTarget,
    ensureAI: ensureAI,
    avoidLand: avoidLand,
    evadeTorpedoes: evadeTorpedoes
  };

  N.AI = AI;
})(globalThis.Naval = globalThis.Naval || {});
