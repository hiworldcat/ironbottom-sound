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

  /** 无线电延迟（秒），只跟距离有关；电力失灵时再加一分钟 */
  function radioDelay(world, a, b) {
    var d = a && b ? V.dist(a.pos, b.pos) : 8000;
    var bonus = 0;
    if (a && N.Damage) bonus = N.Damage.radioDelayBonus(a);
    if (b && N.Damage) bonus = Math.max(bonus, N.Damage.radioDelayBonus(b));
    return DEFAULTS.radioDelay + d / 1000 * DEFAULTS.radioDelayPerKm +
      world.rng.range(0, DEFAULTS.radioJitter) + bonus;
  }

  /** 这台舰的电台现在还能不能用（被打掉 / 故障 / 电力失灵都不行） */
  function radioOk(ship) {
    if (!ship) return false;
    if (N.Damage) return N.Damage.radioOk(ship);
    return !ship.radioDestroyed;
  }

  /** 识别器还能不能用 */
  function iffOk(ship) {
    if (!ship) return false;
    if (N.Damage) return N.Damage.iffOk(ship);
    return !ship.iffDestroyed;
  }

  /* ==========================================================================
   *  敌我识别失灵：把自己的船当成敌舰
   *
   *  识别器是装在船上的东西，所以这件事也按**舰**算，不按舰队算：
   *  某条船的识别器坏了（或者干脆没装），它在夜里的回波里分不清敌我，
   *  就会对着自己人开火。旗舰的识别器好，不代表别的船不会认错。
   *
   *  触发条件：
   *    · 这条船正在交战（engage）—— 不打仗的时候没人去认目标；
   *    · 附近有友舰（22 km 内，旗舰不算 —— 谁都知道旗舰在哪）；
   *    · 识别器正常时每次判定 1%，识别器失灵时 10%。
   *
   *  认错以后这条船会把友舰当成目标，炮弹落在真船上 —— 是真的会沉。
   *  45 秒左右识别纠正，或者友舰打信号弹/闪灯，就停了。
   *
   *  注意：舰上的字段叫 ffTrack（friendly-fire），和航迹上原有的 misId
   *  （认错舰种）是两回事，别混。
   * ========================================================================== */
  var MISID = { life: 30, every: 90, err: 25 };

  /** 这条船此刻正在把自己的哪条友舰当成敌人 */
  function misIdOf(ship) {
    return (ship && ship.ffTrack) ? ship.ffTrack : null;
  }

  function clearMisId(world, ship) {
    if (!ship || !ship.ffTrack) return;
    var victim = world.shipById(ship.ffTrack.friendlyId);
    ship.ffTrack = null;
    ship.ffUntil = 0;
    if (victim && ship.targetTrackId === victim.id) ship.targetTrackId = null;
    if (victim && !victim.sunk && ship.side === world.playerSide) {
      world.log(ship.side, '✓ ' + ship.name + ' 认出「' + victim.name + '」是自己人', 'info');
    }
  }

  function checkMisId(world, side) {
    for (var i = 0; i < world.ships.length; i++) {
      var ship = world.ships[i];
      if (ship.side !== side || !ship.alive || ship.sunk) continue;

      /* ---- 已经在认错：跟着真船更新"敌舰"的位置 ---- */
      if (ship.ffTrack) {
        var v = world.shipById(ship.ffTrack.friendlyId);
        if (!v || v.sunk || world.time >= (ship.ffUntil || 0)) { clearMisId(world, ship); continue; }
        ship.ffTrack.pos = { x: v.pos.x + ship.ffTrack._dx, y: v.pos.y + ship.ffTrack._dy };
        ship.ffTrack.course = v.heading;
        ship.ffTrack.speed = v.speed;
        ship.ffTrack.lastSeen = world.time;
        continue;
      }

      if (world.time < (ship._nextMisCheck || 0)) continue;
      var down = !iffOk(ship);
      ship._nextMisCheck = world.time + MISID.every * world.rng.range(0.7, 1.4);
      if (!ship.engage) continue;

      var p = down ? 0.10 : (N.Damage ? N.Damage.iffError(ship) : DEFAULTS.iffError);
      if (!world.rng.chance(p)) continue;

      // 挑一艘附近的友舰
      var cand = [];
      for (var j = 0; j < world.ships.length; j++) {
        var s = world.ships[j];
        if (s === ship || s.side !== side || !s.alive || s.sunk) continue;
        if (s.role === 'flagship') continue;
        if (V.dist(s.pos, ship.pos) > 22000) continue;
        cand.push(s);
      }
      if (!cand.length) continue;
      var victim = world.rng.pick(cand);
      forceMisId(world, ship, victim, down);
    }
  }

  /** 强制制造一次误判（checkMisId 用它，调试和截图也用它） */
  function forceMisId(world, ship, victim, down) {
    var dx = world.rng.dev(MISID.err), dy = world.rng.dev(MISID.err);
    ship.ffTrack = {
      id: victim.id, friendlyId: victim.id, ffTarget: true,
      pos: { x: victim.pos.x + dx, y: victim.pos.y + dy },
      course: victim.heading, speed: victim.speed,
      uncertainty: MISID.err, idLevel: 2,
      typeGuess: victim.cls.type, classGuess: victim.cls.typeName,
      source: 'visual', iff: 'hostile',
      firstSeen: world.time, lastSeen: world.time, _dx: dx, _dy: dy
    };
    ship.ffUntil = world.time + MISID.life * world.rng.range(0.8, 1.3);
    ship.targetTrackId = victim.id;
    if (ship.side === world.playerSide) {
      world.log(ship.side, '⚠ ' + ship.name + ' 的识别器' + (down ? '失灵' : '出错') +
        '：把「' + victim.name + '」当成了敌舰，正在开火！', 'bad');
    }
    world.bus.emit('misId', { side: ship.side, shooter: ship, victim: victim });
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

    if (!radioOk(from)) return { ok: false, reason: 'from-radio' };
    if (!radioOk(to)) return { ok: false, reason: 'to-radio' };

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
  /** 设备状态快照：跟着无线电一起走，视距外看到的就是旧数据 */
  function devSnapshot(ship) {
    if (!ship.devList || !ship.engines) return null;
    var alive = 0, engFault = 0, i;
    for (i = 0; i < ship.engines.length; i++) {
      if (!ship.engines[i].destroyed) alive++;
      if (ship.engines[i].faulted && !ship.engines[i].destroyed) engFault++;
    }
    var D = N.Damage;
    return {
      engines: ship.engines.length,
      alive: alive,
      engFault: engFault,
      prop: D ? D.propulsion(ship) : 1,
      turn: D ? D.turnFactor(ship) : 1,
      engFrac: D ? D.engineFrac(ship) : 1,
      rudderFrac: ship.rudder && ship.rudder.hpMax > 0
        ? Math.max(0, ship.rudder.hp) / ship.rudder.hpMax : 1,
      elecFrac: ship.electrical && ship.electrical.hpMax > 0
        ? Math.max(0, ship.electrical.hp) / ship.electrical.hpMax : 1,
      elec: D ? D.elecFailed(ship) : false,
      radar: D ? D.radarOk(ship) : !ship.radarDestroyed,
      radio: D ? D.radioOk(ship) : !ship.radioDestroyed,
      iff: D ? D.iffOk(ship) : !ship.iffDestroyed,
      // 电探只有装了的那几条船才有这一栏
      hasESM: !!ship.hasESM,
      esm: D ? D.esmOk(ship) : false,
      esmDestroyed: !!ship.esmDestroyed,
      fc: !ship.fcDestroyed,
      faults: D ? D.faults(ship).map(function (f) { return f.short; }) : [],
      dead: D ? D.destroyedList(ship).map(function (d) { return d.short; }) : []
    };
  }

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
      // true = 指挥舰自己直接看到的（精确）；false = 靠无线电报来的（有定位误差 + 延迟）
      exact: !!exact,
      reportedAt: world.time,
      engage: !!ship.engage,
      targetTrackId: ship.targetTrackId || null,
      torps: ship.torps ? ship.torps.reduce(function (a, t) { return a + (t.loaded || 0); }, 0) : 0,
      radio: radioOk(ship),
      iff: iffOk(ship),
      zones: ship.zoneFrac ? {
        power: ship.zoneFrac('power'),
        weapons: ship.zoneFrac('weapons'),
        superstructure: ship.zoneFrac('superstructure'),
        comms: ship.zoneFrac('comms')
      } : null,
      // 设备状态也要走报告 —— 视距外的舰，你看到的设备情况同样是旧的
      dev: devSnapshot(ship),
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
        /* 发出去的是"定解点"而不是当前外推点：
           定解点 = 最后一次真正看见它时算出来的位置（tr.fix），
           收报方自己按航向航速往前推。这样延迟多久，误差就涨多少。 */
        var fx = tr.fix || { x: tr.pos.x, y: tr.pos.y, t: tr.lastSeen, err: tr.uncertainty };
        obs.push({
          id: tr.id,
          pos: { x: fx.x, y: fx.y },
          posErr: fx.err,
          course: tr.course,
          speed: tr.speed,
          uncertainty: tr.uncertainty,
          idLevel: tr.idLevel,
          typeGuess: tr.typeGuess,
          classGuess: tr.classGuess,
          nameGuess: tr.nameGuess,
          misId: tr.misId,
          source: tr.source,
          esmOnly: !!tr.esmOnly,
          observedAt: fx.t
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

  /* ==========================================================================
   *  送达与融合
   *
   *  以前是"后到的报告直接覆盖前面的"。真实情况不是这样：指挥舰的态势图
   *  上同一个目标可能同时有雷达的、瞭望的、隔壁舰报来的好几份位置，参谋
   *  要做的是把它们**融合**成一个点，而不是谁后到听谁的。
   *
   *  融合规则（按逆方差加权）：
   *
   *    1. 先把图上现有的定解点，用估算航向航速外推到"这次观测发生的时刻"。
   *       注意是观测时刻，不是现在 —— 新旧两个位置必须对齐到同一时刻才能比。
   *    2. 两个位置按 1/误差² 加权平均：误差小的那份说了算。
   *    3. 融合后的误差 = 1/√(1/e旧² + 1/e新²)，一定小于两者中任何一个。
   *    4. 但这份报告在路上走了 age 秒，这 age 秒里目标又走了，
   *       所以从定解点外推到"现在"时，误差要按漂移率累加 —— 这就是延迟的误差传递。
   *
   *  延迟越久 → 外推越远 → 误差越大 → 图上那个圈越大 → 越打不准。
   *  这条链路以前是断的：报告晚到 60 秒，图上的点还停在 60 秒前，圈也不变。
   * ========================================================================== */

  /** 外推漂移率（米/秒）：航向估不准 + 航速估不准 + 对方随时可能转向 */
  function driftRate(tr) {
    var spd = (tr.speed || 0) * U.KNOT_MS;
    return 6 + spd * 0.35;
  }

  /** 把一条航迹的定解点外推到 t 时刻 */
  function predictAt(tr, t) {
    var fx = tr.fix;
    if (!fx) return { x: tr.pos.x, y: tr.pos.y, err: tr.uncertainty || 400 };
    var gap = t - fx.t;
    var v = Geo.headingVec(tr.course || 0);
    var step = (tr.speed || 0) * U.KNOT_MS * gap;
    var drift = driftRate(tr) * Math.abs(gap);
    return {
      x: fx.x + v.x * step,
      y: fx.y + v.y * step,
      err: Math.sqrt(fx.err * fx.err + drift * drift)
    };
  }

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
            uncertainty: o.posErr || o.uncertainty || 400,
            idLevel: 0,
            typeGuess: null, classGuess: null, nameGuess: null,
            misId: false, lastSeen: o.observedAt, firstSeen: world.time,
            seenBy: p.from, fixes: [], seenThisTick: false,
            source: o.source, observedAt: o.observedAt, reportedAt: world.time,
            via: p.fromName, iff: 'unknown',
            contributors: {}, latency: 0, esmOnly: !!o.esmOnly, bestErr: 1e9
          };
        }

        /* ---- 这份报告在路上走了多久 ---- */
        var age = Math.max(0, world.time - o.observedAt);
        var newErr = Math.max(120, o.posErr || o.uncertainty || 400);

        /* ---- 融合：新位置 vs 旧航迹外推到同一时刻 ---- */
        var fused;
        if (!tr.fix) {
          fused = { x: o.pos.x, y: o.pos.y, err: newErr };
        } else {
          var pred = predictAt(tr, o.observedAt);
          var wNew = 1 / (newErr * newErr);
          // 旧航迹的权重随时间打折：放了两分钟的东西，不该和新报告平起平坐
          // （如果这份报告比图上已有的还旧，旧定解点按满权算，自然把它压下去）
          var oldAge = o.observedAt - tr.fix.t;
          var decay = oldAge > 0 ? Math.exp(-oldAge / 90) : 1;
          var wOld = decay / (pred.err * pred.err);
          var w = wOld + wNew;
          fused = {
            x: (pred.x * wOld + o.pos.x * wNew) / w,
            y: (pred.y * wOld + o.pos.y * wNew) / w,
            err: Math.sqrt(1 / w)
          };
        }

        // 定解点落在"这次观测的时刻"，之后由外推负责往前推
        /* 融合的下限：同一批传感器反复报，误差里有一大块是**共模**的
           （本舰自己的位置误差、雷达标定、测距仪基线），这部分再怎么平均
           也消不掉。所以融合后的圈不许小于最好那份的 65%。 */
        var best = Math.min(tr.bestErr || 1e9, newErr);
        tr.bestErr = best;
        fused.err = Math.max(fused.err, best * 0.65);

        /* 电探只有方位：反复融合能把方位越校越准，但**永远测不出距离**。
           所以误差不许被融合压到测距误差的一半以下，否则会凭空造出一个
           能开炮的解 —— 那是作弊。 */
        if (o.esmOnly) fused.err = Math.max(fused.err, newErr * 0.55);
        tr.fix = { x: fused.x, y: fused.y, t: o.observedAt, err: fused.err };
        tr.course = o.course;
        tr.speed = o.speed;
        tr.lastSeen = o.observedAt;
        tr.observedAt = o.observedAt;
        tr.reportedAt = world.time;
        tr.latency = age;
        tr.seenBy = p.from;
        tr.via = p.fromName;
        tr.source = o.source;
        tr.esmOnly = !!o.esmOnly;
        tr.contributors[p.from] = (tr.contributors[p.from] || 0) + 1;

        // 外推到当前时刻（融合点 → 现在）
        var nowP = predictAt(tr, world.time);
        tr.pos = { x: nowP.x, y: nowP.y };
        tr.uncertainty = Math.min(9000, nowP.err);
        tr.age = world.time - o.observedAt;

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
    if (!iffOk(flag)) return 'unknown';
    var err = N.Damage ? N.Damage.iffError(flag) : DEFAULTS.iffError;
    if (world.rng.chance(err)) {
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
      if (!tr.fix) continue;
      var gap = world.time - tr.fix.t;
      if (gap > 900) { delete pic[k]; continue; }

      /* 从定解点重算，不是每帧累加 —— 这样误差只跟"定解点到现在多久"有关，
         不会因为掉帧或者速度变化而累积成假的漂移。 */
      var p = predictAt(tr, world.time);
      tr.pos = { x: p.x, y: p.y };
      tr.uncertainty = Math.min(9000, p.err);
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
      checkMisId(world, side);
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
      iffOk: iffOk(flag)
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
    deliver: deliver,
    predictAt: predictAt,
    driftRate: driftRate,
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
    classify: classify,
    checkMisId: checkMisId,
    forceMisId: forceMisId,
    misIdOf: misIdOf,
    clearMisId: clearMisId,
    MISID: MISID
  };
})(globalThis.Naval = globalThis.Naval || {});
