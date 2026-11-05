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

  var DOCTRINE = {
    US: {
      engageMin: 9000,
      engageMax: 17500,
      torpFrac: 0.70,
      torpSpread: 2.2,
      aggression: 0.9
    },
    JP: {
      engageMin: 8000,
      engageMax: 14500,
      torpFrac: 0.45,
      torpSpread: 2.8,
      aggression: 1.15
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
    var tracks = N.Sensors.trackList(world, ship.side);
    var best = null, bestScore = -1;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (!tr.pos) continue;
      if (world.time - tr.lastSeen > 300) continue;
      var sc = targetScore(world, ship, tr);
      if (sc > bestScore) { bestScore = sc; best = tr; }
    }
    return best;
  }

  /** 找最近的被护航对象（运输船 / 撤退舰） */
  function wardOf(world, ship) {
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
   * 夜间照明：有目标航迹但看不清时打照明弹。
   * 只在低光环境、目标距离 4.5~11 km 时使用，避免浪费。
   */
  function considerStarshell(world, ship) {
    if (!ship.starshells || ship.starshellCd > 0) return;
    if (!world.env || world.env.light === 'day') return;
    // 能见度已经够好，照明弹没有意义
    if (world.env.visibility >= 9000) return;
    var tr = nearestEnemyTrack(world, ship, 11500);
    if (!tr) return;
    var d = V.dist(ship.pos, tr.pos);
    if (d < 4500) return;                       // 太近，直接打就行
    // 已经被照亮了就不重复打
    if (world.illuminationAt(tr.pos) > 0) return;
    var lead = Geo.lead(tr.pos, tr.course, tr.speed, 3.5);
    world.fireStarshell(ship, lead);
  }

  function updateShip(world, ship) {
    var ai = ensureAI(ship, world);
    var doc = DOCTRINE[ship.side] || DOCTRINE.US;
    var rng = world.rng;

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

    var track = ship.targetTrackId ? N.Sensors.track(world, ship.side, ship.targetTrackId) : null;
    if (!track || world.time - track.lastSeen > 240) {
      // 无目标：前往敌可能出现的海域搜索
      ship.engage = false;
      if (ai.state !== 'PATROL') { ai.state = 'PATROL'; }
      var toward = (world.searchPos && world.searchPos[ship.side === 'US' ? 'JP' : 'US'])
        || world.homePos[ship.side === 'US' ? 'JP' : 'US'];

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

    /* ---------- 交战 ---------- */
    var gunRange = ship.gunRangeMax;
    var inRange = range < gunRange * 0.98;
    ship.engage = inRange;

    /* ---------- 鱼雷 ---------- */
    if (ai.torpCooldown <= world.time && ship.torpRangeMax > 0) {
      var trng = ship.torpRangeMax * doc.torpFrac;
      var rel = Math.abs(U.angDiff(brg, ship.heading));
      if (range < trng && rel > 35 && rel < 145) {
        for (var ti = 0; ti < ship.torps.length; ti++) {
          var mount = ship.torps[ti];
          if (mount.disabled || mount.destroyed || mount.fault || mount.loaded <= 0) continue;
          var n = Math.min(mount.loaded, 4);
          var fired = N.Combat.launchTorpedoes(world, ship, mount, track.pos, track.course, track.speed, n, doc.torpSpread);
          if (fired > 0) {
            ai.torpCooldown = world.time + rng.range(180, 260);
            ai.turnAwayUntil = world.time + 75;
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
    var stateChanged = (ai.lastState !== ai.state);
    ai.lastState = ai.state;
    var force = stateChanged || world.time < ai.turnAwayUntil;
    if (force || world.time > (ai.nextManeuver || 0)) {
      ai.nextManeuver = world.time + rng.range(12, 22);
      var wantHeading;
      if (world.time < ai.turnAwayUntil) {
        // 发射后脱离：把舷侧/舰尾转向敌方
        wantHeading = U.norm360(brg + 115);
      } else if (range > doc.engageMax) {
        // 接近：取拦截航向
        wantHeading = Geo.interceptBearing(ship.pos, track.pos, track.course, track.speed * U.KNOT_MS,
          ship.effectiveMaxSpeed() * U.KNOT_MS);
      } else if (range < doc.engageMin) {
        // 太近：拉开距离
        wantHeading = U.norm360(brg + 150);
      } else {
        // 保持舷侧对敌，便于全炮门和鱼雷发射
        var side = (U.angDiff(brg, ship.heading) >= 0) ? 1 : -1;
        wantHeading = U.norm360(brg + 68 * side);
      }

      wantHeading = avoidLand(world, ship, wantHeading, track.pos);
      wantHeading = avoidShips(world, ship, wantHeading);
      ai.desiredHeading = wantHeading;

      var speedFrac = range > doc.engageMax ? 0.95 : (range < doc.engageMin ? 0.85 : 0.72);
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
      var ships = world.ships;
      for (var i = 0; i < ships.length; i++) {
        var s = ships[i];
        if (s.side !== side || s.sunk || !s.alive) continue;
        if (s.isPlayerControlled && !controlMovement) {
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
