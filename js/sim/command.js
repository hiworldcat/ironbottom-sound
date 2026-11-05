/**
 *  sim/command.js —— 指挥舰与无线电
 *
 *  真实海战里没有"上帝视角的战场态势图"。全舰队的雷达、瞭望、测距仪各自
 *  看到的碎片，要靠无线电报到指挥舰上，指挥舰再把命令发回去。无线电就有：
 *
 *    · 延迟 —— 你看到的态势是几十秒到两分钟之前的；距离越远越慢。
 *    · 丢包 —— 有些消息发出去了但没收到，你根本不知道有这回事。
 *
 *  这套东西对美日双方完全一样：双方各有一艘指挥舰，各自的态势图都是用
 *  报告拼出来的，AI 用的也是这张图，不是真坐标。
 *
 *  几条分界线：
 *
 *    视距内（<= env.visibility，最多 15 km）
 *        灯光 / 旗语：几秒内到达，不丢包。指挥舰能直接看见的舰，状态也是即时的。
 *    视距外
 *        无线电：延迟 25~80 秒，丢包率见 lossChance()。
 *
 *    本舰火控
 *        每艘舰自己看到什么就能打什么（ship.ownTracks，即时、无延迟）。
 *        指挥舰的态势图只决定"上面让你去哪、打谁"。
 *
 *  硬件：
 *    ship.radioDestroyed  收发机被打掉 —— 视距外的报告和命令全部中断
 *    ship.iffDestroyed    敌我识别器被打掉 —— 接触只能靠目视判别
 */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var DEFAULTS = {
    /* 无线电 */
    radioDelay: 24,          // 基础延迟（秒）
    radioDelayPerKm: 1.8,    // 每公里再加多少秒
    radioJitter: 6,          // 抖动上限
    lossBase: 0.10,          // 基础丢包
    lossNight: 0.10,         // 夜间
    lossWeather: 0.14,       // 恶劣天气
    lossRain: 0.20,          // 满雨量时的附加
    lossSea: 0.05,           // 海况 >= 4 的附加

    /* 本舰状态报告 */
    statusInterval: 11,      // 平均多久报一次
    statusJitter: 5,

    /* 导航定位 */
    navError: 70,            // 常规定位误差（米）
    navBlunder: 0.06,        // 粗大误差概率
    blunderMin: 500,
    blunderMax: 2400,

    /* 敌我识别 */
    iffError: 0.01,

    /* 指挥交接 */
    handover: 35,            // 旗舰失联后多久由下一艘接替

    /* 视距 */
    visualCap: 15000
  };

  /* ==========================================================================
   *  链路
   * ========================================================================== */

  function cmdOf(world, side) {
    if (!world.command) world.command = { US: null, JP: null };
    if (!world.command[side]) {
      world.command[side] = {
        side: side,
        flagshipId: null,
        packets: [],
        roster: {},
        downUntil: 0,
        sent: 0,
        lost: 0,
        lastDelay: 0,
        lastReason: null
      };
    }
    return world.command[side];
  }

  function flagshipOf(world, side) {
    var cmd = cmdOf(world, side);
    if (!cmd.flagshipId) return null;
    var s = world.shipById(cmd.flagshipId);
    if (!s || s.sunk || !s.alive) return null;
    return s;
  }

  /** 视距：指挥舰肉眼能不能直接看见这艘舰 */
  function inVisual(world, a, b) {
    if (!a || !b) return false;
    var vis = (world.weather && world.weather.visibility) ||
      (world.env && world.env.visibility) || 12000;
    return V.dist(a.pos, b.pos) <= Math.min(vis, DEFAULTS.visualCap);
  }

  /** 无线电丢包率：夜间 / 天气 / 雨 / 海况 / 干扰，全部累加 */
  function lossChance(world, side) {
    var env = world.env || {};
    var wx = world.weather;
    var p = DEFAULTS.lossBase;

    if (env.light === 'night') p += DEFAULTS.lossNight;
    else if (env.light === 'dusk') p += DEFAULTS.lossNight * 0.5;

    var w = String(env.weather || '');
    if (/雾|雨|暴|雪|阴|飑/.test(w)) p += DEFAULTS.lossWeather;

    // 天气用**当前**的，不是剧本开局的
    var rain = wx ? wx.rain : ((env.rain || 0) / 10);
    var sea = wx ? wx.seaState : (env.seaState || 0);
    p += U.clamp01(rain) * DEFAULTS.lossRain;
    if (sea >= 4) p += DEFAULTS.lossSea;
    // 雨飑：电离层噪声 + 天线在风里摇，链路最容易断的时候
    if (wx && wx.squall) p += 0.10;

    // 电子干扰（预留接口，目前场景里都是 0）
    if (world.jamming && world.jamming[side]) p += world.jamming[side];

    return U.clamp(p, 0, 0.8);
  }

  /** 无线电延迟（秒），只跟距离有关 */
  function radioDelay(world, a, b) {
    var d = a && b ? V.dist(a.pos, b.pos) : 8000;
    return DEFAULTS.radioDelay + d / 1000 * DEFAULTS.radioDelayPerKm +
      world.rng.range(0, DEFAULTS.radioJitter);
  }

  /**
   * 从 a 发一条消息给 b，能不能发出去、要多久、会不会丢。
   * @return {ok, delay, lost, visual, reason}
   */
  function link(world, from, to) {
    var cmd = cmdOf(world, from.side);

    if (!to) return { ok: false, reason: 'no-flagship' };
    if (world.time < cmd.downUntil) return { ok: false, reason: 'command-down' };

    // 视距内：灯光 / 旗语，几秒就到，不会丢
    if (inVisual(world, from, to)) {
      return { ok: true, delay: 1.2 + world.rng.range(0, 2.4), lost: false, visual: true };
    }

    if (from.radioDestroyed) return { ok: false, reason: 'from-radio' };
    if (to.radioDestroyed) return { ok: false, reason: 'to-radio' };

    var p = lossChance(world, from.side);
    // 通信结构受损 → 发射机功率不足、天线被打歪，丢包率显著上升
    var cf = from.commsFactor ? from.commsFactor() : 1;
    if (cf < 1) p = U.clamp01(p + (1 - cf) * 0.55);
    return {
      ok: true,
      delay: radioDelay(world, from, to) * (1 + (1 - cf) * 0.6),
      lost: world.rng.chance(p),
      visual: false,
      loss: p
    };
  }

  function note(world, cmd, l) {
    cmd.sent++;
    if (l.lost) cmd.lost++;
    cmd.lastDelay = l.delay || 0;
    cmd.lastReason = l.reason || null;
  }

  /* ==========================================================================
   *  指挥舰
   * ========================================================================== */

  /** 指挥价值：吨位大的当旗舰，场景里点名 role='flagship' 的优先 */
  function commandValue(s) {
    var v = (s.cls.displacement || 2000) / 1000;
    if (s.role === 'flagship') v += 40;
    if (s.role === 'escortee') v -= 20;
    if (s.cls.type === 'AK') v -= 15;
    return v;
  }

  function pickFlagship(world, side) {
    var best = null, bestV = -1e9;
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (s.side !== side || s.sunk || !s.alive) continue;
      var v = commandValue(s);
      if (v > bestV) { bestV = v; best = s; }
    }
    return best;
  }

  function setFlagship(world, cmd, ship, why) {
    cmd.flagshipId = ship ? ship.id : null;
    if (!ship) return;
    cmd.roster[ship.id] = snapshot(world, ship, true);
    world.log(cmd.side, '◆ ' + ship.name + ' 担任指挥舰' + (why ? '（' + why + '）' : ''), 'info');
  }

  /** 本舰状态快照（带定位误差） */
  function snapshot(world, ship, exact) {
    var err = { x: 0, y: 0 }, posErr = 0;
    if (!exact) {
      posErr = DEFAULTS.navError * world.rng.range(0.4, 1.6);
      if (world.rng.chance(DEFAULTS.navBlunder)) {
        // 定位粗差：一段时间内整张图上这艘舰都是偏的
        posErr = world.rng.range(DEFAULTS.blunderMin, DEFAULTS.blunderMax);
      }
      var brg = world.rng.range(0, 360);
      err = Geo.dest({ x: 0, y: 0 }, brg, posErr);
    }
    return {
      id: ship.id,
      name: ship.name,
      cls: ship.cls,
      hull: ship.hull,
      hullMax: ship.hullMax,
      flood: ship.flood,
      fire: ship.fire,
      speed: ship.speed,
      heading: ship.heading,
      pos: exact ? { x: ship.pos.x, y: ship.pos.y } : { x: ship.pos.x + err.x, y: ship.pos.y + err.y },
      posErr: posErr,
      engage: !!ship.engage,
      targetTrackId: ship.targetTrackId || null,
      torps: ship.torps ? ship.torps.reduce(function (a, t) { return a + (t.loaded || 0); }, 0) : 0,
      radio: !ship.radioDestroyed,
      iff: !ship.iffDestroyed,
      zones: ship.zoneFrac ? {
        power: ship.zoneFrac('power'),
        weapons: ship.zoneFrac('weapons'),
        superstructure: ship.zoneFrac('superstructure'),
        comms: ship.zoneFrac('comms')
      } : null,
      sunk: !!ship.sunk,
      sinking: !!ship.sinking,
      reportedAt: world.time,
      exact: !!exact
    };
  }

  /* ==========================================================================
   *  报告
   * ========================================================================== */

  /** 每艘舰把自己的观测报给指挥舰（sensors.js 每帧调用） */
  function report(world, side, observers) {
    var cmd = cmdOf(world, side);
    var flag = flagshipOf(world, side);
    if (!flag) return;

    for (var j = 0; j < observers.length; j++) {
      var ship = observers[j];

      // 指挥舰自己的雷达/瞭望是实时的：直接进态势图，不用发报
      var isFlag = (ship === flag);
      if (!isFlag && world.time < (ship._nextContactReport || 0)) continue;
      if (!isFlag) ship._nextContactReport = world.time + 9 + world.rng.range(0, 8);

      // 本舰这一轮看到的（含刚丢掉的旧目标，让对方知道"最后一次看到在哪"）
      var obs = [];
      var own = ship.ownTracks || {};
      for (var k in own) {
        var tr = own[k];
        if (world.time - tr.lastSeen > 20) continue;
        obs.push({
          id: tr.id,
          pos: { x: tr.pos.x, y: tr.pos.y },
          course: tr.course,
          speed: tr.speed,
          uncertainty: tr.uncertainty,
          idLevel: tr.idLevel,
          typeGuess: tr.typeGuess,
          classGuess: tr.classGuess,
          nameGuess: tr.nameGuess,
          misId: tr.misId,
          source: tr.source,
          observedAt: tr.lastSeen
        });
      }
      if (!obs.length) continue;

      if (isFlag) {
        deliver(world, cmd, { kind: 'contact', from: ship.id, fromName: ship.name, obs: obs });
        continue;
      }

      var l = link(world, ship, flag);
      note(world, cmd, l);
      if (!l.ok) continue;
      cmd.packets.push({
        at: world.time + l.delay,
        kind: 'contact',
        from: ship.id,
        fromName: ship.name,
        lost: l.lost,
        obs: obs
      });
    }
  }

  /** 本舰状态报告：视距内即时刷新，视距外走无线电 */
  function reportStatus(world, side) {
    var cmd = cmdOf(world, side);
    var flag = flagshipOf(world, side);
    if (!flag) return;

    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (s.side !== side || !s.alive) continue;

      // 沉没：发最后一次报（"我完了"），之后就不再报
      if (s.sunk) {
        if (s._sunkReported) continue;
        s._sunkReported = true;
        var ls = link(world, s, flag);
        note(world, cmd, ls);
        if (ls.ok && !ls.lost) {
          cmd.packets.push({
            at: world.time + ls.delay,
            kind: 'status',
            from: s.id,
            lost: false,
            status: snapshot(world, s, true)
          });
        }
        continue;
      }

      if (s === flag) { cmd.roster[s.id] = snapshot(world, s, true); continue; }

      if (world.time < (s._nextStatus || 0)) continue;
      s._nextStatus = world.time + DEFAULTS.statusInterval + world.rng.range(0, DEFAULTS.statusJitter);

      // 视距内直接看得到，不用报
      if (inVisual(world, s, flag)) { cmd.roster[s.id] = snapshot(world, s, true); continue; }

      var l = link(world, s, flag);
      note(world, cmd, l);
      if (!l.ok) continue;
      cmd.packets.push({
        at: world.time + l.delay,
        kind: 'status',
        from: s.id,
        lost: l.lost,
        status: snapshot(world, s, false)
      });
    }
  }

  /* ==========================================================================
   *  送达
   * ========================================================================== */

  function deliver(world, cmd, p) {
    if (p.kind === 'contact') {
      var pic = world.tracks[cmd.side] || (world.tracks[cmd.side] = {});
      for (var i = 0; i < p.obs.length; i++) {
        var o = p.obs[i];
        var tr = pic[o.id];
        if (!tr) {
          tr = pic[o.id] = {
            id: o.id, side: cmd.side,
            pos: { x: o.pos.x, y: o.pos.y },
            course: o.course, speed: o.speed,
            uncertainty: o.uncertainty, idLevel: 0,
            typeGuess: null, classGuess: null, nameGuess: null,
            misId: false, lastSeen: o.observedAt, firstSeen: world.time,
            seenBy: p.from, fixes: [], seenThisTick: false,
            source: o.source, observedAt: o.observedAt, reportedAt: world.time,
            via: p.fromName, iff: 'unknown'
          };
        }
        // 更旧的消息不能覆盖更新的
        if ((tr.observedAt || 0) > o.observedAt) continue;

        tr.pos = { x: o.pos.x, y: o.pos.y };
        tr.course = o.course;
        tr.speed = o.speed;
        tr.uncertainty = Math.max(tr.uncertainty || 0, o.uncertainty);
        tr.lastSeen = o.observedAt;
        tr.observedAt = o.observedAt;
        tr.reportedAt = world.time;
        tr.seenBy = p.from;
        tr.via = p.fromName;
        tr.source = o.source;
        if (o.idLevel > tr.idLevel) {
          tr.idLevel = o.idLevel;
          tr.typeGuess = o.typeGuess;
          tr.classGuess = o.classGuess;
          tr.nameGuess = o.nameGuess;
          tr.misId = o.misId;
          tr.iff = classify(world, cmd, o);
        }
      }
    } else if (p.kind === 'status') {
      cmd.roster[p.from] = p.status;
    }
  }

  /**
   * 敌我识别：识别器正常工作时有 1% 的概率答错。
   * 答错的后果是双向的 —— 敌人被当成友军（不会出现在目标列表里），
   * 友军被当成敌人（图上多出一个假目标）。
   */
  function classify(world, cmd, o) {
    var flag = flagshipOf(world, cmd.side);
    if (!flag || flag.iffDestroyed) return 'unknown';
    if (world.rng.chance(DEFAULTS.iffError)) {
      return world.rng.chance(0.5) ? 'friendly' : 'unknown';
    }
    return 'hostile';
  }

  /* ==========================================================================
   *  态势外推
   * ========================================================================== */

  function extrapolatePicture(world, side, dt) {
    var pic = world.tracks[side];
    if (!pic) return;
    var cmd = cmdOf(world, side);

    for (var k in pic) {
      var tr = pic[k];
      var gap = world.time - (tr.observedAt || tr.lastSeen);
      if (gap > 900) { delete pic[k]; continue; }
      if (gap < 1) continue;

      // 报告之间的空档：按估算航向外推，误差随时间涨
      var v = Geo.headingVec(tr.course || 0);
      var step = (tr.speed || 0) * U.KNOT_MS * dt;
      tr.pos = { x: tr.pos.x + v.x * step, y: tr.pos.y + v.y * step };
      tr.uncertainty = Math.min(9000, (tr.uncertainty || 300) + 40 * dt);
      tr.age = gap;
      tr.stale = gap > 45;
    }

    // 丢了很久的目标从图上撤掉
    if (world.time - (cmd.lastPrune || 0) > 5) {
      cmd.lastPrune = world.time;
      for (var k2 in pic) {
        if (world.time - (pic[k2].observedAt || 0) > 300) delete pic[k2];
      }
    }
  }

  /* ==========================================================================
   *  命令
   * ========================================================================== */

  /**
   * 从指挥舰给某艘舰下命令。返回 {ok, delay, lost, reason}。
   * 丢包时命令根本不会生效，调用方应当告诉玩家"未确认"。
   */
  function sendOrder(world, ship, heading, speed) {
    if (!ship || ship.sunk || ship.sinking) return { ok: false, reason: 'sunk' };
    var flag = flagshipOf(world, ship.side);
    if (!flag) return { ok: false, reason: 'no-flagship' };

    var l = link(world, flag, ship);
    var cmd = cmdOf(world, ship.side);
    note(world, cmd, l);

    if (!l.ok) {
      cmd.lastReason = l.reason;
      return { ok: false, reason: l.reason };
    }
    if (l.lost) {
      // 命令丢了，但发令的人过一会儿才会意识到没有回执
      cmd.packets.push({ at: world.time + l.delay, kind: 'noack', from: ship.id, lost: true });
      return { ok: false, lost: true, delay: l.delay };
    }

    ship.pendingOrder = {
      heading: heading === undefined ? ship.orderedHeading : U.norm360(heading),
      speed: speed === undefined ? ship.orderedSpeed : speed,
      at: world.time + l.delay
    };
    return { ok: true, delay: l.delay, visual: l.visual };
  }

  /* ==========================================================================
   *  每帧
   * ========================================================================== */

  function update(world, dt) {
    var sides = ['US', 'JP'];
    for (var si = 0; si < sides.length; si++) {
      var side = sides[si];
      var cmd = cmdOf(world, side);

      // 旗舰没了 → 指挥中断 → 交接
      var flag = flagshipOf(world, side);
      if (!flag) {
        if (cmd.flagshipId) {
          var dead = world.shipById(cmd.flagshipId);
          cmd.flagshipId = null;
          cmd.downUntil = world.time + DEFAULTS.handover;
          cmd.roster = {};
          world.log(side, '⚠ 指挥舰' + (dead ? ' ' + dead.name : '') + ' 失去联络，指挥中断', 'bad');
        }
        if (world.time >= cmd.downUntil) {
          var next = pickFlagship(world, side);
          if (next) setFlagship(world, cmd, next, '接替指挥');
        }
        continue;
      }

      // 送达
      var pk = cmd.packets;
      for (var i = pk.length - 1; i >= 0; i--) {
        var p = pk[i];
        if (world.time < p.at) continue;
        pk.splice(i, 1);
        if (p.kind === 'noack') continue;
        if (p.lost) { cmd.lost++; continue; }
        deliver(world, cmd, p);
      }

      reportStatus(world, side);
    }
  }

  function init(world) {
    world.command = { US: null, JP: null };
    var sides = ['US', 'JP'];
    for (var i = 0; i < sides.length; i++) {
      var side = sides[i];
      var cmd = cmdOf(world, side);
      var flag = pickFlagship(world, side);
      if (flag) setFlagship(world, cmd, flag);
      // 开局全队是收拢的，指挥舰知道每艘舰在哪、什么状态
      for (var j = 0; j < world.ships.length; j++) {
        var s2 = world.ships[j];
        if (s2.side === side && !s2.sunk) cmd.roster[s2.id] = snapshot(world, s2, true);
      }
    }
  }

  /* ==========================================================================
   *  查询（给 HUD / 渲染 / AI 用）
   * ========================================================================== */

  /** 玩家看到的某艘己方舰的状态：视距内是真值，视距外是最后一次报告 */
  function ownView(world, ship) {
    var cmd = cmdOf(world, ship.side);
    var r = cmd.roster[ship.id];
    var flag = flagshipOf(world, ship.side);
    if (ship === flag) return snapshot(world, ship, true);
    if (!r) {
      // 从来没收到过报告：图上只能画个"上次知道的大概位置"
      var st = cmd.roster[ship.id];
      if (!st) return null;
      return st;
    }
    return r;
  }

  /** 链路状态（给 HUD） */
  function statusOf(world, side) {
    var cmd = cmdOf(world, side);
    var flag = flagshipOf(world, side);
    var down = Math.max(0, (cmd.downUntil || 0) - world.time);
    var loss = lossChance(world, side);
    var total = cmd.sent || 0;
    return {
      side: side,
      flagship: flag,
      flagshipName: flag ? flag.name : null,
      online: !!flag && down <= 0,
      down: down,
      loss: loss,
      lossPct: Math.round(loss * 100),
      delay: Math.round(flag ? DEFAULTS.radioDelay + 10 * DEFAULTS.radioDelayPerKm : 0),
      sent: total,
      lost: cmd.lost,
      lostPct: total ? Math.round(cmd.lost / total * 100) : 0,
      radioOk: !!flag && !flag.radioDestroyed,
      iffOk: !!flag && !flag.iffDestroyed
    };
  }

  /** 图上该把某艘己方舰画在哪儿 */
  function plotPos(world, ship) {
    var v = ownView(world, ship);
    return v && v.pos ? v.pos : ship.pos;
  }

  /** 图上这张接触的"最后报告于多少秒前" */
  function ageOf(world, tr) {
    if (!tr) return 0;
    return Math.max(0, world.time - (tr.observedAt || tr.lastSeen || world.time));
  }

  N.Command = {
    DEFAULTS: DEFAULTS,
    init: init,
    update: update,
    report: report,
    extrapolatePicture: extrapolatePicture,
    sendOrder: sendOrder,
    ownView: ownView,
    plotPos: plotPos,
    statusOf: statusOf,
    ageOf: ageOf,
    inVisual: inVisual,
    lossChance: lossChance,
    flagshipOf: flagshipOf,
    cmdOf: cmdOf,
    link: link,
    classify: classify
  };
})(globalThis.Naval = globalThis.Naval || {});
