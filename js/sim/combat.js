/* =============================================================================
 *  sim/combat.js —— 炮战解算、弹道、命中判定、鱼雷
 *
 *  真实感要点：
 *    · 炮弹有飞行时间（10~30 秒），你只能看到落水水柱，看不到弹道
 *    · 首发通常打偏，靠“跨射”校射逐步收敛（errorScale）
 *    · 命中位置（舷侧/甲板/炮塔/水线）由落角与概率决定
 *    · 穿深不足则跳弹，只造成轻微结构损伤
 *    · 鱼雷按预设提前量直线航行，九三式几乎无航迹
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var _shellId = 0;
  var _torpId = 0;
  var _salvoId = 0;
  var _splashId = 0;

  /* ==========================================================================
   *  火控解算
   * ========================================================================== */
  function computeSolution(world, ship, track) {
    if (!track) return null;
    var gun = ship.mounts.length ? ship.mounts[0].gun : null;
    if (!gun) return null;

    var range = V.dist(ship.pos, track.pos);
    if (range > gun.maxRange * 1.05) return null;

    // 平均飞行速度约为初速的 0.72（含空气阻力）
    var avgV = gun.mv * 0.72;
    var tFlight = range / avgV;
    var aim = track.pos;
    for (var it = 0; it < 3; it++) {
      aim = Geo.lead(track.pos, track.course, track.speed * U.KNOT_MS, tFlight);
      range = V.dist(ship.pos, aim);
      tFlight = range / avgV;
    }

    return {
      aim: aim,
      range: range,
      tFlight: tFlight,
      bearing: Geo.bearing(ship.pos, aim),
      valid: true
    };
  }

  /** 单发炮弹的落点散布（米） */
  function dispersionSigma(world, ship, track, gun, range) {
    var q = ship.fcDestroyed ? 0.35 : (ship.cls.fc.quality || 0.7);
    // 上层建筑被打塌 → 指挥仪、测距仪、雷达天线一起完蛋，火控质量跟着掉
    if (ship.sensorFactor) q *= ship.sensorFactor();
    // 基础散布：距离越远越大，火控越好越小
    var base = range * (0.0042 + 0.0075 * (1 - q));
    var scale = ship.errorScale;
    // 航迹陈旧 / 不确定会显著放大误差
    var stale = U.clamp((world.time - track.lastSeen) / 45, 0, 4);
    var unc = Math.min(track.uncertainty, 1200) * 0.10 * (1 + stale * 0.8);
    return Math.max(25, base * scale + unc);
  }

  /* ==========================================================================
   *  开火
   * ========================================================================== */
  function tryFire(world, ship, dt) {
    if (ship.sunk || ship.sinking || !ship.engage) return;
    if (!ship.targetTrackId) return;
    // 火控用本舰自己看得见的那份（即时）；指挥舰发下来的态势可能已经旧了
    var track = N.Sensors.trackFor(world, ship, ship.targetTrackId);
    if (!track) return;

    var sol = computeSolution(world, ship, track);
    ship.solution = sol;
    if (!sol) return;

    var rel = ship.relativeBearing(track.pos);
    var rng = world.rng;
    var firedAny = false;

    for (var i = 0; i < ship.mounts.length; i++) {
      var m = ship.mounts[i];
      if (m.disabled || !m.ready) continue;
      if (m.ammo < m.count) continue;
      if (sol.range > m.gun.maxRange) continue;
      if (!ship.mountArcOk(m, rel)) continue;

      // 炮塔尚未转到位
      var want = (m.arc === 'aft') ? U.angDiff(rel, 180) + 180 : U.angDiff(rel, 0);
      if (Math.abs(U.angDiff(m.train, want)) > 6) continue;

      var sigma = dispersionSigma(world, ship, track, m.gun, sol.range);
      var salvoId = 'V' + (++_salvoId);

      for (var g = 0; g < m.count; g++) {
        // 椭圆散布：沿射向的误差远大于横向
        var dr = rng.dev(sigma * 1.55);          // 距离向
        var dc = rng.dev(sigma * 0.55);          // 横向
        var brg = sol.bearing;
        var perp = brg + 90;
        var p = Geo.dest(sol.aim, brg, dr);
        p = Geo.dest(p, perp, dc);

        world.shells.push({
          id: 'H' + (++_shellId),
          side: ship.side,
          ownerId: ship.id,
          gun: m.gun,
          targetId: ship.targetTrackId,
          salvoId: salvoId,
          salvoSize: m.count,
          aim: sol.aim,
          to: p,
          t: 0,
          tf: sol.tFlight * rng.range(0.97, 1.03),
          range: sol.range
        });
      }

      m.ammo -= m.count;
      m.ready = false;
      m.reload = (60 / m.gun.rof) * rng.range(0.92, 1.35);
      m.shotsFired += m.count;
      firedAny = true;

      if (!world.salvoes[salvoId]) {
        world.salvoes[salvoId] = {
          shipId: ship.id, side: ship.side, targetId: ship.targetTrackId,
          size: m.count, landed: 0, short: 0, long: 0, hits: 0,
          ship: ship, targetTrack: track
        };
      }
    }

    if (firedAny) {
      ship.salvosFired++;
      ship.lastFireTime = world.time;
      world.bus.emit('salvoFired', { ship: ship, range: sol.range });
    }
  }

  /* ==========================================================================
   *  岸轰
   * ========================================================================== */
  /** 对岸上目标实施压制射击（没有跨射校射，命中率较低，但目标不会还击） */
  function tryBombard(world, ship, dt) {
    if (ship.sunk || ship.sinking) return;
    var tgt = world.shoreTargetById(ship.bombardTargetId);
    if (!tgt || tgt.destroyed) {
      // 目标已被摧毁：自动改派下一个
      if (ship.autoBombard && world.nearestShoreTarget) {
        var next = world.nearestShoreTarget(ship.pos, true);
        ship.bombardTargetId = next ? next.id : null;
        if (next) {
          world.log(ship.side, ship.name + ' 转移火力：' + next.name, 'info');
          tgt = next;
        } else {
          return;
        }
      } else {
        ship.bombardTargetId = null;
        return;
      }
    }

    var rng = world.rng;
    var rel = ship.relativeBearing(tgt.pos);
    var dist = V.dist(ship.pos, tgt.pos);
    var brg = Geo.bearing(ship.pos, tgt.pos);
    var firedAny = false;

    for (var i = 0; i < ship.mounts.length; i++) {
      var m = ship.mounts[i];
      if (m.disabled || !m.ready) continue;
      if (m.ammo < m.count) continue;
      if (dist > m.gun.maxRange) continue;
      if (!ship.mountArcOk(m, rel)) continue;

      var want = (m.arc === 'aft') ? U.angDiff(rel, 180) + 180 : U.angDiff(rel, 0);
      if (Math.abs(U.angDiff(m.train, want)) > 6) continue;

      var sigma = Math.max(60, dist * 0.016 * ship.errorScale);
      var salvoId = 'B' + (++_salvoId);

      for (var g = 0; g < m.count; g++) {
        var dr = rng.dev(sigma * 1.4);
        var dc = rng.dev(sigma * 0.9);
        var p = Geo.dest(tgt.pos, brg, dr);
        p = Geo.dest(p, brg + 90, dc);
        world.shells.push({
          id: 'H' + (++_shellId),
          side: ship.side,
          ownerId: ship.id,
          gun: m.gun,
          shoreTargetId: tgt.id,
          salvoId: salvoId,
          aim: tgt.pos,
          to: p,
          t: 0,
          tf: (dist / (m.gun.mv * 0.72)) * rng.range(0.97, 1.03),
          range: dist
        });
      }

      m.ammo -= m.count;
      m.ready = false;
      m.reload = (60 / m.gun.rof) * 1.8 * rng.range(0.92, 1.35);
      m.shotsFired += m.count;
      firedAny = true;
    }

    if (firedAny) {
      ship.salvosFired++;
      ship.lastFireTime = world.time;
      world.bus.emit('salvoFired', { ship: ship, range: dist });
    }
  }

  /* ==========================================================================
   *  炮弹飞行与落弹
   * ========================================================================== */
  function updateShells(world, dt) {
    var shells = world.shells;
    for (var i = shells.length - 1; i >= 0; i--) {
      var s = shells[i];
      s.t += dt;
      if (s.t >= s.tf) {
        impact(world, s);
        shells.splice(i, 1);
      }
    }
  }

  function impact(world, shell) {
    var rng = world.rng;
    var hitShip = null;

    /* ---- 岸轰炮弹 ---- */
    if (shell.shoreTargetId) {
      var st = world.shoreTargetById(shell.shoreTargetId);
      if (st && !st.destroyed && V.dist(shell.to, st.pos) < 190) {
        world.damageShoreTarget(st, 1.2 + shell.gun.shellWeight * 0.012, world);
      } else {
        world.addSplash(shell.to, shell.side, 'shell', shell.ownerId, shell.gun.caliber);
      }
      return;
    }

    // 落点附近有没有敌舰
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      if (sh.side === shell.side || sh.sunk || !sh.alive) continue;
      if (Geo.inShipRect(shell.to, sh.pos, sh.heading, sh.cls.length, sh.cls.beam, 6)) {
        hitShip = sh;
        break;
      }
    }

    var salvo = world.salvoes[shell.salvoId];

    if (hitShip) {
      resolveHit(world, hitShip, shell);
      if (salvo) salvo.hits++;
    } else {
      // 水柱
      world.addSplash(shell.to, shell.side, 'shell', shell.ownerId, shell.gun.caliber);
      if (salvo) {
        var tr = salvo.targetTrack;
        if (tr) {
          // 以“落点到本舰的距离”与“目标到本舰的距离”比较，判断近失/远失
          var dImpact = V.dist(salvo.ship.pos, shell.to);
          var dTarget = V.dist(salvo.ship.pos, tr.pos);
          if (dImpact < dTarget) salvo.short++; else salvo.long++;
        }
      }
    }

    if (salvo) {
      salvo.landed++;
      if (salvo.landed >= salvo.size) evaluateSalvo(world, salvo, shell.salvoId);
    }
  }

  /** 校射：命中或跨射后收敛误差 */
  function evaluateSalvo(world, salvo, salvoId) {
    var ship = salvo.ship;
    delete world.salvoes[salvoId];
    if (!ship || ship.sunk) return;

    var straddle = salvo.hits > 0 || (salvo.short > 0 && salvo.long > 0);
    var canLog = (world.time - (ship._lastSpotLog || -999)) > 22;
    if (salvo.hits > 0) {
      ship.errorScale = Math.max(0.28, ship.errorScale * 0.62);
      ship.spotting = { kind: 'hit', t: world.time };
      if (canLog && ship.side === world.playerSide) {
        ship._lastSpotLog = world.time;
        world.log(ship.side, '观测到命中：' + ship.name + ' 的齐射打中目标', 'good');
      }
    } else if (straddle) {
      ship.errorScale = Math.max(0.30, ship.errorScale * 0.78);
      ship.spotting = { kind: 'straddle', t: world.time };
      if (canLog && ship.side === world.playerSide) {
        ship._lastSpotLog = world.time;
        world.log(ship.side, '跨射！' + ship.name + ' 已对目标夹叉，火控修正中', 'good');
      }
    } else {
      ship.errorScale = Math.max(0.30, ship.errorScale * 0.93);
      ship.spotting = { kind: 'miss', t: world.time };
    }
  }

  /* ==========================================================================
   *  命中与损伤
   * ========================================================================== */
  var LOC_WEIGHTS = {
    CA: [['turret', 0.12], ['belt', 0.34], ['deck', 0.17], ['machinery', 0.12],
      ['waterline', 0.12], ['ctic', 0.05], ['super', 0.08]],
    CL: [['turret', 0.14], ['belt', 0.29], ['deck', 0.19], ['machinery', 0.14],
      ['waterline', 0.12], ['ctic', 0.04], ['super', 0.08]],
    DD: [['turret', 0.10], ['belt', 0.26], ['deck', 0.13], ['machinery', 0.24],
      ['waterline', 0.15], ['ctic', 0.02], ['super', 0.10]]
  };

  function pickLocation(rng, ship, descentDeg) {
    // 大落角更容易命中水平装甲
    if (descentDeg > 22 && rng.chance(0.62)) return 'deck';
    var w = LOC_WEIGHTS[ship.cls.type] || LOC_WEIGHTS.DD;
    var r = rng.next(), acc = 0;
    for (var i = 0; i < w.length; i++) {
      acc += w[i][1];
      if (r <= acc) return w[i][0];
    }
    return 'belt';
  }

  function armorFor(ship, loc) {
    var a = ship.cls.armor;
    switch (loc) {
      case 'belt': return a.belt;
      case 'waterline': return a.belt;
      case 'deck': return a.deck;
      case 'turret': return a.turret;
      case 'machinery': return a.belt * 0.65;
      case 'ctic': return a.ctic;
      default: return 4;
    }
  }

  function resolveHit(world, ship, shell) {
    var rng = world.rng;
    var gun = shell.gun;
    var descent = gun.maxDescent * Math.pow(U.clamp01(shell.range / gun.maxRange), 1.5);
    var loc = pickLocation(rng, ship, descent);

    var pen = (loc === 'deck') ? U.table(gun.deckPen, shell.range) : U.table(gun.pen, shell.range);
    pen *= rng.range(0.92, 1.08);

    var armor = armorFor(ship, loc);
    var ratio = armor > 0 ? pen / armor : 3;

    var result;
    if (ratio >= 1.05) result = 'pen';
    else if (ratio >= 0.82) result = 'partial';
    else result = 'noPen';

    // 基础伤害
    var base = 6 * Math.pow(gun.shellWeight / 25, 0.55);
    if (result === 'partial') base *= 0.55;
    else if (result === 'noPen') base *= 0.10;

    var dmg = { hull: 0, flood: 0, floodRate: 0, fire: 0, power: 0, steering: 0 };
    var struct = {};          // 命中部位对应的结构分区损伤（单位同 hull）
    var disabledMount = null;

    switch (loc) {
      case 'belt':
        dmg.hull = base * 0.95;
        dmg.floodRate = base * 0.0016;
        dmg.fire = base * 0.25;
        break;
      case 'waterline':
        dmg.hull = base * 0.80;
        dmg.flood = base * 0.35;
        dmg.floodRate = base * 0.0045;
        struct.power = base * 0.25;
        break;
      case 'deck':
        dmg.hull = base * 0.65;
        dmg.fire = base * 0.45;
        struct.superstructure = base * 0.55;
        struct.weapons = base * 0.20;
        dmg.floodRate = base * 0.0012;
        break;
      case 'machinery':
        dmg.hull = base * 0.55;
        struct.power = base * 1.15;
        dmg.floodRate = base * 0.0020;
        break;
      case 'turret':
        dmg.hull = base * 0.18;
        dmg.fire = base * 0.6;
        struct.weapons = base * 0.95;
        dmg.mountHit = pickMount(rng, ship);
        break;
      case 'ctic':
        dmg.hull = base * 0.45;
        dmg.steering = base * 0.8;
        dmg.fire = base * 0.3;
        struct.comms = base * 0.85;
        struct.superstructure = base * 0.55;
        if (rng.chance(0.35)) dmg.fc = true;
        if (rng.chance(0.30)) dmg.radio = true;
        if (rng.chance(0.18)) dmg.iff = true;
        break;
      default: // superstructure
        dmg.hull = base * 0.30;
        dmg.fire = base * 0.5;
        struct.superstructure = base * 1.05;
        struct.comms = base * 0.22;
        if (rng.chance(0.12)) dmg.radar = true;
        if (rng.chance(0.10)) dmg.radio = true;
        if (rng.chance(0.05)) dmg.iff = true;
        break;
    }

    if (result === 'noPen' && loc === 'turret') dmg.mountHit = undefined;

    ship.applyDamage({
      hull: dmg.hull,
      flood: dmg.flood,
      floodRate: dmg.floodRate,
      fire: dmg.fire,
      steering: dmg.steering,
      struct: struct,
      mountHit: dmg.mountHit,
      radar: dmg.radar,
      fc: dmg.fc,
      radio: dmg.radio,
      iff: dmg.iff
    }, world);

    var shooter = world.shipById(shell.ownerId);
    if (shooter) shooter.hitsDealt++;

    // 记录战果，用于简报
    if (!ship.damageLog) ship.damageLog = [];
    ship.damageLog.push({ t: world.time, loc: loc, result: result, from: shell.ownerId });

    if (ship.side === world.playerSide) {
      var txt = {
        pen: '穿透',
        partial: '部分穿透',
        noPen: '未击穿'
      }[result];
      var locName = {
        belt: '舷侧', waterline: '水线', deck: '甲板', machinery: '机舱',
        turret: '炮塔', ctic: '舰桥', super: '上层建筑'
      }[loc];
      world.log(ship.side, '⚠ ' + ship.name + ' 被命中：' + locName + '（' + txt + '）', 'warn');
    }
  }

  function pickMount(rng, ship) {
    var avail = [];
    for (var i = 0; i < ship.mounts.length; i++) if (!ship.mounts[i].disabled) avail.push(i);
    if (!avail.length) return undefined;
    return rng.pick(avail);
  }

  /* ==========================================================================
   *  鱼雷
   * ========================================================================== */
  /**
   * 发射鱼雷齐射。
   * @param {Ship} ship
   * @param {Object} mount 鱼雷发射管
   * @param {Object} aimPos 目标估计位置
   * @param {Object} aimVel {course, speed} 目标估计运动
   */
  function launchTorpedoes(world, ship, mount, aimPos, aimCourse, aimSpeedKn, count, spreadDeg) {
    if (ship.sunk || ship.sinking || mount.disabled) return 0;
    if (mount.loaded <= 0) return 0;
    var torp = mount.torp;
    var n = Math.min(count || mount.loaded, mount.loaded);
    var rng = world.rng;

    // 提前量
    var dist = V.dist(ship.pos, aimPos);
    var runTime = dist / (torp.speed * U.KNOT_MS);
    var lead = Geo.lead(aimPos, aimCourse, aimSpeedKn * U.KNOT_MS, runTime);
    // 鱼雷解算误差：距离越远越不准
    var leadErr = 0.35 + 0.9 * U.clamp01(dist / 12000);
    var baseBrg = U.norm360(Geo.bearing(ship.pos, lead) + rng.dev(leadErr));

    // 发射管必须大致指向目标
    var rel = ship.relativeBearing(lead);
    if (!ship.torpedoArcOk(rel)) return -1;   // 舷侧未对准

    var spread = spreadDeg || 1.6;
    var fired = 0;
    for (var i = 0; i < n; i++) {
      var off = (i - (n - 1) / 2) * spread + rng.dev(0.35);
      var brg = U.norm360(baseBrg + off);
      var launchPos = Geo.dest(ship.pos, ship.heading, -ship.cls.length * 0.15);
      world.torpedoes.push({
        id: 'T' + (++_torpId),
        side: ship.side,
        ownerId: ship.id,
        start: { x: launchPos.x, y: launchPos.y },
        pos: launchPos,
        heading: brg,
        speed: torp.speed,
        range: torp.range,
        traveled: 0,
        torp: torp,
        wake: torp.wake,
        spotted: false,
        spottedTime: 0,
        alive: true,
        age: 0
      });
      fired++;
    }
    mount.loaded -= fired;
    mount.salvoesFired++;
    ship.torpsFired += fired;
    if (mount.loaded <= 0) { mount.reload = mount.reloadTime; mount.loaded = 0; }
    else mount.reload = mount.reloadTime;

    world.bus.emit('torpedoLaunch', { ship: ship, count: fired });
    return fired;
  }

  function updateTorpedoes(world, dt) {
    var list = world.torpedoes;
    for (var i = list.length - 1; i >= 0; i--) {
      var t = list[i];
      t.age += dt;
      var step = t.speed * U.KNOT_MS * dt;
      t.traveled += step;
      var v = Geo.headingVec(t.heading);
      t.pos.x += v.x * step;
      t.pos.y += v.y * step;

      if (t.traveled > t.range) { list.splice(i, 1); continue; }
      if (world.isLand(t.pos.x, t.pos.y)) { list.splice(i, 1); continue; }

      // 命中判定
      var hit = null;
      for (var j = 0; j < world.ships.length; j++) {
        var sh = world.ships[j];
        if (sh.side === t.side || sh.sunk || !sh.alive || sh.id === t.ownerId) continue;
        if (Geo.inShipRect(t.pos, sh.pos, sh.heading, sh.cls.length, sh.cls.beam, t.torp.hitRadius)) {
          hit = sh; break;
        }
      }
      if (hit) {
        resolveTorpedoHit(world, hit, t);
        list.splice(i, 1);
      }
    }
  }

  /**
   * 鱼雷引信触发概率 —— 船越大越容易触发。
   *
   *  几何上大船本来就更好打（舰体矩形更大），但真正决定"炸不炸"的是引信：
   *  驱逐舰干舷低、吃水浅，鱼雷常常从龙骨底下穿过去；重巡干舷高、吃水深、
   *  舰体长，磁性/触发引信几乎必然动作。这里给的就是这个"触发"概率。
   *
   *  1500 t → 0.55   2500 t(驱逐) → 0.64   10000 t(轻巡) → 0.89   13000 t(重巡) → 0.93
   */
  function torpTriggerChance(ship) {
    var d = ship.cls.displacement || 2000;
    var k = U.clamp01(Math.log(d / 1500) / Math.log(14000 / 1500));
    return 0.55 + 0.40 * k;
  }

  function resolveTorpedoHit(world, ship, torp) {
    var rng = world.rng;
    if (!rng.chance(torp.torp.reliability)) {
      // 哑弹
      world.addSplash(torp.pos, torp.side, 'dud', torp.ownerId, 610);
      if (torp.side === world.playerSide) {
        world.log(torp.side, '✖ 鱼雷命中' + ship.name + '但未爆炸（哑弹）', 'warn');
      }
      return 'dud';
    }

    // 引信没触发：从船底穿过或擦着舷侧过去了，没有爆炸
    if (!rng.chance(torpTriggerChance(ship))) return 'passed';

    var w = torp.torp.warhead;
    ship.applyDamage({
      hull: w * 0.115,
      flood: w * 0.135,
      floodRate: w * 0.0013,
      fire: w * 0.06,
      struct: {
        power: w * 0.030,
        superstructure: w * 0.012,
        weapons: w * 0.008,
        comms: w * 0.004
      },
      steering: w * 0.02
    }, world);

    ship.torpsHitTaken++;
    world.addSplash(torp.pos, torp.side, 'torpedo', torp.ownerId, 610);
    world.bus.emit('torpedoHit', { ship: ship, torp: torp });

    if (ship.side === world.playerSide) {
      world.log(ship.side, '💥 ' + ship.name + ' 被鱼雷命中！舰体剧烈震动', 'critical');
    } else {
      world.log(world.playerSide, '观测到敌方舰艇发生剧烈爆炸', 'good');
    }
    return 'hit';
  }

  /* ==========================================================================
   *  主更新
   * ========================================================================== */
  function update(world, dt) {
    var i;
    for (i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (!s.alive || s.sunk || s.sinking) continue;
      if (s.bombardTargetId) tryBombard(world, s, dt);
      else tryFire(world, s, dt);
    }
    updateShells(world, dt);
    updateTorpedoes(world, dt);
  }

  N.Combat = {
    update: update,
    computeSolution: computeSolution,
    dispersionSigma: dispersionSigma,
    launchTorpedoes: launchTorpedoes,
    torpTriggerChance: torpTriggerChance,
    resolveHit: resolveHit,
    resolveTorpedoHit: resolveTorpedoHit
  };
})(globalThis.Naval = globalThis.Naval || {});
