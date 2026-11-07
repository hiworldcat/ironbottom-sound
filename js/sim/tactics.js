/* =============================================================================
 *  sim/tactics.js —— 舰队参谋部：分工、目标、照明弹
 *
 *  以前每艘舰各打各的：谁看上哪个目标就打哪个，驱逐舰和重巡用同一套战法，
 *  照明弹谁想打就打（而且经常照空）。这个模块把「整支舰队」当成一个单位来
 *  做三件事：
 *
 *    1. 分工（plan）：给每条舰派一个任务 —— 掩护船队 / 前出搜索 / 雷击 /
 *       炮战 / 脱离。任务有任期（至少干 18 秒），不会每帧改主意。
 *    2. 分目标：同一个目标最多两条舰打，避免全队追一艘而放过另一艘。
 *    3. 照明（illuminate）：全队共用一套照明弹纪律 —— 只在"看不清但打得着"
 *       的时候照、同一时刻只有一艘舰在打、照的是敌人的前置点。
 *
 *  参谋部同样只读 world.tracks，不读敌舰真实坐标。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var ROLE = {
    MOVE: 'MOVE',         // 运输船：开往登陆点
    SCREEN: 'SCREEN',     // 掩护船队
    SCOUT: 'SCOUT',       // 前出搜索
    ADVANCE: 'ADVANCE',   // 向敌接近
    GUN: 'GUN',           // 炮战
    TORPEDO: 'TORPEDO',   // 雷击
    WITHDRAW: 'WITHDRAW', // 脱离
    RAID: 'RAID',         // 突入（剧本指定）
    BOMBARD: 'BOMBARD'    // 岸轰（剧本指定）
  };

  var LABEL = {
    MOVE: '开往登陆点', SCREEN: '掩护船队', SCOUT: '前出搜索',
    ADVANCE: '向敌接近', GUN: '炮战', TORPEDO: '雷击',
    WITHDRAW: '脱离战斗', RAID: '突入泊地', BOMBARD: '炮击岸上'
  };

  /* 两国的战法不一样：
     日军更爱放鱼雷、更爱在夜里打照明弹（他们没有雷达，照明是唯一的"眼睛"）；
     美军有雷达，照明弹用得省，倾向于用炮火解决问题。 */
  var STAFF = {
    US: {
      planEvery: 7,
      minDwell: 22,
      screens: 1,          // 派几条舰专门掩护船队
      scouts: 1,           // 没有情报时派几条舰前出
      torpAttackers: 1,    // 同时几条舰执行雷击
      torpMinRange: 16000, // 目标进入这个距离才派雷击
      illumGap: 75,        // 两次照明之间至少隔多久
      illumMax: 10000,     // 超过这个距离照了也白照（弹只飞 6.5 km）
      illumVisCap: 9000,   // 自己已经能看这么远就不打了
      illumMin: 3200,      // 这么近就不用照了
      salvoDelay: 5        // 雷击组从下令到齐射隔多久
    },
    JP: {
      planEvery: 6,
      minDwell: 18,
      screens: 1,
      scouts: 2,
      torpAttackers: 3,
      torpMinRange: 18000,
      illumGap: 42,
      illumMax: 11000,
      illumVisCap: 11000,
      illumMin: 3000,
      salvoDelay: 16
    }
  };

  /* 梯次照明的三级距离（米）。照明弹射程 6.5 km、照亮半径 4.2 km，
     所以这三发叠起来能覆盖 0~10.6 km 的一条光带。 */
  var LADDER = [4200, 5300, 6400];

  function staffOf(side) { return STAFF[side] || STAFF.US; }

  function memoOf(world, side) {
    if (!world._staff) world._staff = {};
    var m = world._staff[side];
    if (!m) {
      m = world._staff[side] = { next: 0, illumNext: 0, shells: 0, lastRole: {} };
    }
    return m;
  }

  /* ---------------------------------------------------------------- 工具 */

  function aliveOf(world, side) {
    var out = [];
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (s.side !== side || s.sunk || !s.alive) continue;
      out.push(s);
    }
    return out;
  }

  /** 这条舰归 AI 指挥吗（玩家手操的舰不归参谋部管） */
  function aiControlled(world, ship) {
    if (!ship.isPlayerControlled) return true;
    return !!world.autopilot;
  }

  /**
   * 还活着的敌情（只用航迹）。
   * @param {boolean} includeEsm 是否把"只有无线电测向、没有位置精度"的航迹也算进来。
   *        照明弹要用它 —— 夜里没有雷达的舰队只有测向方位，正是靠打照明弹
   *        把"那个方向有东西"变成"看清是什么"。
   */
  function contactsOf(world, side, maxAge, includeEsm) {
    var list = N.Sensors.trackList(world, side), out = [];
    var age = maxAge || 300;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.pos) continue;
      if (t.phantom) continue;
      if (t.esmOnly && !includeEsm) continue;
      if (world.time - t.lastSeen > age) continue;
      out.push(t);
    }
    return out;
  }

  function hurt(ship) {
    return (ship.flood > 55) || (ship.hull < ship.hullMax * 0.30);
  }

  function hasTorpedoes(ship) {
    if (!ship.torps || !ship.torps.length) return false;
    for (var i = 0; i < ship.torps.length; i++) {
      var m = ship.torps[i];
      if (m.disabled || m.destroyed || m.fault) continue;
      if (m.loaded > 0) return true;
    }
    return false;
  }

  function nearestWard(world, ship) {
    var best = null, bd = 1e9;
    for (var i = 0; i < world.ships.length; i++) {
      var o = world.ships[i];
      if (o === ship || o.side !== ship.side || o.sunk) continue;
      if (o.role !== 'transport' && o.role !== 'escortee') continue;
      var d = V.dist(ship.pos, o.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best ? { ship: best, d: bd } : null;
  }

  /* ---------------------------------------------------------------- 分工 */

  /**
   * 换任务。
   *
   * 任务本身有最短任期（十几秒），免得每条舰每秒都在改主意；
   * 但"打谁"是随时可以改的 —— 目标分配本来就要跟着态势走。
   */
  function assign(world, ship, role, targetId, note) {
    var t = ship.aiTask;
    if (!t) t = ship.aiTask = { role: null, targetId: null, since: -999, note: '' };
    var tid = targetId === undefined ? t.targetId : targetId;

    if (t.role === role) {
      t.targetId = tid;
      if (note) t.note = note;
      return false;
    }

    // 任期未满：任务先不改，但目标照改
    var urgent = (role === ROLE.WITHDRAW) || (role === ROLE.TORPEDO && !t.role);
    if (!urgent && t.role && world.time - t.since < staffOf(ship.side).minDwell) {
      t.targetId = tid;
      return false;
    }
    if (t.role !== role && ship.side === world.playerSide) {
      // 玩家看得见自己的舰换任务（运输船/撤退舰这类不可指挥的舰）
      var txt = LABEL[role] || role;
      if (ship.role === 'transport' || ship.role === 'escortee') {
        world.log(ship.side, ship.name + ' 的任务：' + txt, 'info');
      }
    }
    t.role = role;
    t.targetId = tid;
    t.since = world.time;
    t.note = note || '';
    if (role !== ROLE.SCREEN) t.wardId = null;
    return true;
  }

  /** 给一条舰挑目标：算分 + 避免全队挤在同一个目标上 */
  function bestContact(world, ship, contacts, ships) {
    var best = null, bestScore = -1;
    for (var i = 0; i < contacts.length; i++) {
      var tr = contacts[i];
      var d = V.dist(ship.pos, tr.pos);
      var sc = 12000 / (d + 3000);

      // 一坨回波里可能好几条船：优先打大坨，但别追一个两公里的圈
      if (tr.count > 1) sc *= 1 + 0.25 * Math.min(tr.count - 1, 3);
      if (tr.uncertainty > 2200) sc *= 0.55;
      else if (tr.uncertainty > 1400) sc *= 0.8;

      // 舰种偏好：驱逐舰先打大的（鱼雷值钱），巡洋舰先打同级
      var g = (tr.idLevel >= 2 && tr.typeGuess) ? tr.typeGuess : null;
      if (g) {
        if (ship.cls.type === 'DD') {
          sc *= (g === 'CA' ? 1.5 : g === 'CL' ? 1.25 : g === 'DD' ? 0.85 : 1);
        } else {
          sc *= (g === 'CA' ? 1.5 : g === 'CL' ? 1.3 : g === 'DD' ? 0.9 : 1);
        }
      }

      // 跑到 10 节以下的船：多半是刚挨了鱼雷或者机舱被打穿了。
      // 补刀比另开一个战场划算 —— 它已经打不动，但还占着敌人的一条舰。
      if (tr.typeGuess !== 'AK' && tr.speed != null && tr.speed < 10) sc *= 1.3;

      // 已经有人打了：第一条不扣分，第二条开始让位。
      // 这里直接数"现在谁在打它"，比记账可靠 —— 换任务被任期挡住时也不会算错。
      var n = 0;
      for (var q = 0; q < ships.length; q++) {
        var o = ships[q];
        if (o === ship || o.sunk || !o.aiTask) continue;
        if (o.aiTask.targetId === tr.id) n++;
      }
      if (n >= 2) sc *= 0.12;
      else if (n === 1) sc *= 0.55;

      if (sc > bestScore) { bestScore = sc; best = tr; }
    }
    return best;
  }

  /**
   * 重新分工。每 side 每 planEvery 秒算一次。
   */
  function plan(world, side) {
    var m = memoOf(world, side);
    if (world.time < m.next) return null;
    m.next = world.time + staffOf(side).planEvery;

    var st = staffOf(side);
    var ships = aliveOf(world, side);
    var pending = [];
    var tasks = [];

    /* ---- 1. 剧本指定的任务、运输船、重伤舰先定下来 ---- */
    for (var i = 0; i < ships.length; i++) {
      var s = ships[i];
      // 玩家手操的舰不归参谋部管
      if (!aiControlled(world, s)) continue;

      if (s.cls.type === 'AK' || s.role === 'transport' || s.role === 'escortee') {
        assign(world, s, ROLE.MOVE);
      } else if (s.aiRole === 'raid') {
        assign(world, s, ROLE.RAID);
      } else if (s.aiRole === 'bombard' && world.shoreTargets.length) {
        assign(world, s, ROLE.BOMBARD);
      } else if (hurt(s)) {
        assign(world, s, ROLE.WITHDRAW);
      } else {
        pending.push(s);
      }
    }

    /* ---- 2. 留一条舰看住船队 ---- */
    var wards = [];
    for (var w = 0; w < ships.length; w++) {
      var ws = ships[w];
      if (ws.role === 'transport' || ws.role === 'escortee') wards.push(ws);
    }
    if (wards.length && pending.length > st.screens) {
      // 挑离船队最近、而且本来就不该去雷击的（驱逐舰优先）
      var sorted = pending.slice().sort(function (a, b) {
        var da = nearestWard(world, a), db = nearestWard(world, b);
        return (da ? da.d : 1e9) - (db ? db.d : 1e9);
      });
      var nScreen = Math.min(st.screens, sorted.length - 1);
      for (var k = 0; k < nScreen; k++) {
        assign(world, sorted[k], ROLE.SCREEN);
        pending.splice(pending.indexOf(sorted[k]), 1);
      }
    }

    /* ---- 2b. 有人被打残了：派一条舰陪它回去 ----
       单独一条伤舰往回开，最容易在半路上被落单的驱逐舰补掉。 */
    var wounded = [];
    for (var wi = 0; wi < ships.length; wi++) {
      var ws2 = ships[wi];
      if (ws2.aiTask && ws2.aiTask.role === ROLE.WITHDRAW) wounded.push(ws2);
    }
    if (wounded.length && pending.length > 1) {
      var w0 = wounded[0], escort = null, ed = 1e9;
      for (var ei = 0; ei < pending.length; ei++) {
        var dd = V.dist(pending[ei].pos, w0.pos);
        if (dd < ed) { ed = dd; escort = pending[ei]; }
      }
      if (escort && ed < 12000) {
        assign(world, escort, ROLE.SCREEN);
        escort.aiTask.wardId = w0.id;
        pending.splice(pending.indexOf(escort), 1);
      }
    }

    /* ---- 3. 有敌情：分目标、派雷击 ---- */
    var contacts = contactsOf(world, side);
    if (contacts.length) {
      /* 3a. 雷击组：几条舰打同一个目标簇，横着铺开，差不多同时放雷。
         不要各挑各的目标 —— 鱼雷的杀伤在于"一次来十几条，往哪躲都有一条"。 */
      var torpCapable = [];
      for (var t = 0; t < pending.length; t++) {
        var ts = pending[t];
        if (ts.torpRangeMax > 0 && hasTorpedoes(ts)) torpCapable.push(ts);
      }
      torpCapable.sort(function (a, b) {
        return distToContacts(a, contacts) - distToContacts(b, contacts);
      });
      var group = salvoTarget(world, side, contacts);
      var nTorp = Math.min(st.torpAttackers, torpCapable.length);
      if (group && nTorp > 0) {
        var lanes = [];
        for (var lq = 0; lq < nTorp; lq++) {
          lanes.push(nTorp === 1 ? 0 : (lq / (nTorp - 1)) * 2 - 1);
        }
        /* 齐射时刻只在"换目标"时重设。否则每 6 秒重算一次，
           readyAt 永远比现在晚十几秒 —— 鱼雷一发也放不出去。 */
        var prev = m.salvo;
        m.salvo = {
          targetId: group.id, n: nTorp, lanes: lanes,
          readyAt: (prev && prev.targetId === group.id)
            ? prev.readyAt
            : world.time + (st.salvoDelay || 0)
        };
        for (var q = 0; q < nTorp; q++) {
          var ship = torpCapable[q];
          if (V.dist(ship.pos, group.pos) > st.torpMinRange) continue;
          assign(world, ship, ROLE.TORPEDO, group.id, '雷击 ' + group.id);
          ship.aiTask.lane = lanes[q];
          pending.splice(pending.indexOf(ship), 1);
        }
      } else {
        m.salvo = null;
      }

      // 3b. 其余炮战
      for (var g = 0; g < pending.length; g++) {
        var gs = pending[g];
        var gt = bestContact(world, gs, contacts, ships);
        if (!gt) { assign(world, gs, ROLE.ADVANCE); continue; }
        assign(world, gs, ROLE.GUN, gt.id, '打 ' + gt.id);
      }
    } else {
      /* ---- 4. 没有情报：派人前出，其余压上去 ---- */
      var scouts = pending.slice().sort(function (a, b) {
        return b.effectiveMaxSpeed() - a.effectiveMaxSpeed();
      });
      var nScout = Math.min(st.scouts, Math.max(0, scouts.length - 1));
      for (var c = 0; c < nScout; c++) {
        // 左右各一条，拉成搜索线
        scouts[c]._scoutSide = (c % 2 === 0) ? 1 : -1;
        assign(world, scouts[c], ROLE.SCOUT);
        pending.splice(pending.indexOf(scouts[c]), 1);
      }
      for (var p = 0; p < pending.length; p++) {
        assign(world, pending[p], ROLE.ADVANCE);
      }
    }

    /* ---- 4b. 记下目标最后出现的位置：丢了接触以后好往那儿追 ---- */
    for (var lp = 0; lp < ships.length; lp++) {
      var lps = ships[lp];
      if (!lps.aiTask || !lps.aiTask.targetId) continue;
      var lt = N.Sensors.trackFor(world, lps, lps.aiTask.targetId);
      if (lt && lt.pos) lps.aiTask.lastPos = { x: lt.pos.x, y: lt.pos.y, t: world.time };
    }

    /* ---- 5. 汇总一份给调试/HUD 看 ---- */
    for (var z = 0; z < ships.length; z++) {
      var zs = ships[z];
      if (!zs.aiTask || !zs.aiTask.role) continue;
      tasks.push({
        side: side, ship: zs.name, id: zs.id,
        role: zs.aiTask.role, label: LABEL[zs.aiTask.role] || zs.aiTask.role,
        target: zs.aiTask.targetId, note: zs.aiTask.note,
        since: Math.round(zs.aiTask.since)
      });
    }
    world.aiTasks = (world.aiTasks || {});
    world.aiTasks[side] = tasks;
    return tasks;
  }

  /** 舰队中心，用来判断"哪一坨敌人离我们最近" */
  function fleetCentre(world, side) {
    var x = 0, y = 0, n = 0;
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      if (sh.side !== side || sh.sunk || !sh.alive) continue;
      x += sh.pos.x; y += sh.pos.y; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  /**
   * 这一轮雷击打哪一坨：优先船多的（一雷多收），其次离舰队近的。
   * 打的是"一坨"而不是"一条"—— 鱼雷本来就不是精确武器。
   */
  function salvoTarget(world, side, contacts) {
    var cen = fleetCentre(world, side);
    var best = null, bs = -1;
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var n = Math.max(1, c.count || 1);
      var d = cen ? V.dist(cen, c.pos) : 0;
      var sc = n * 2.2 + (1 - Math.min(d, 24000) / 24000);
      if (c.uncertainty > 2500) sc *= 0.6;
      if (sc > bs) { bs = sc; best = c; }
    }
    return best;
  }

  function distToContacts(ship, contacts) {
    var best = 1e9;
    for (var i = 0; i < contacts.length; i++) {
      var d = V.dist(ship.pos, contacts[i].pos);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * 顺着无线电测向方位压上去的"接近点"。
   *
   * 关键：方位是准的，距离是瞎猜的（误差 45%）。所以不要朝那个估计位置开
   * —— 那会开到一个根本不存在的点上。要朝"距估计位置还有 standoff 的
   * 那个点"开，让舰队横着扫过这条方位线，自然就会撞上真正的敌人。
   */
  function approachPoint(world, side, fromPos, standoff) {
    var t = hint(world, side);
    if (!t) return null;
    var brg = Geo.bearing(t.pos, fromPos);
    return Geo.dest(t.pos, brg, standoff || 5500);
  }

  /** 最新的"只有方位"的敌情：侦察舰顺着它去找 */
  function hint(world, side) {
    var list = N.Sensors.trackList(world, side), best = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.pos || !t.esmOnly) continue;
      if (world.time - t.lastSeen > 100) continue;
      if (!best || t.lastSeen > best.lastSeen) best = t;
    }
    return best;
  }

  /* ---------------------------------------------------------------- 照明弹 */

  /**
   * 照明弹纪律。
   *
   * 一条照明弹的射程只有 6.5 km、照亮半径 4.2 km、烧 50 秒、每舰装填 25 秒、
   * 带的数量有限 —— 所以它是一次"战术决定"，不是随手一打：
   *
   *   · 白天不打；自己已经看得够远不打；敌人就在眼前不打
   *   · 只在"看得见轮廓但打不准"的那一段打（大约 4~10 km）
   *   · 全队同一时刻只有一艘舰在打，间隔按国家定（日军 42 秒，美军 75 秒）
   *   · 照的是**敌人的前置点**，不是他现在的位置 —— 弹飞 3.5 秒才亮
   *   · 已经亮着的地方不重复打
   */
  function illuminate(world, side) {
    var m = memoOf(world, side);
    var st = staffOf(side);
    if (!world.env || world.env.light === 'day') return null;
    if (world.time < m.illumNext) return null;

    var vis = (world.weather && world.weather.visibility) ||
      (world.env.visibility != null ? world.env.visibility : 12000);
    if (vis >= st.illumVisCap) return null;

    /* 注意：这里把"只有测向方位的航迹"也算进来。
       没有雷达的舰队在夜里只剩无线电测向，照明弹是唯一能把
       "那个方向有东西"变成"看清是什么"的手段 —— 这是日军夜战的核心。 */
    var contacts = contactsOf(world, side, 120, true);
    if (!contacts.length) return null;

    var ships = aliveOf(world, side);

    /* ---- 挑一个"值得照亮"的目标 ---- */
    var bestTr = null, bestScore = 0, bestFrom = null, bestD = 0;
    for (var i = 0; i < contacts.length; i++) {
      var tr = contacts[i];
      if (world.illuminationAt(tr.pos) > 0) continue;   // 已经亮着

      // 从哪条舰看过去最近
      var near = null, nd = 1e9;
      for (var j = 0; j < ships.length; j++) {
        var s = ships[j];
        if (!aiControlled(world, s)) continue;
        if (!s.starshells || s.starshellCd > 0) continue;
        if (s.aiTask && (s.aiTask.role === ROLE.WITHDRAW || s.aiTask.role === ROLE.MOVE)) continue;
        var d = V.dist(s.pos, tr.pos);
        if (d < nd) { nd = d; near = s; }
      }
      if (!near) continue;

      // 太近：不照也看得见
      if (nd < st.illumMin) continue;
      // 已经能看清：不浪费
      if (nd < vis * 0.85) continue;

      if (tr.esmOnly) {
        // 测向方位：方位准（1.3°），距离全是猜的（误差 45%）。
        // 照明弹只飞 6.5 km、照亮半径 4.2 km，所以最远那级也就能罩到 10.6 km ——
        // 舰队还在十几公里外就先别打，那是往空海面上扔弹。
        if (nd > 12000) continue;
      } else {
        // 有精确航迹：弹落在 6.5 km 处，靠 4.2 km 照亮半径罩住目标
        if (nd > st.illumMax) continue;
      }

      // 越近、越多条船，越值得照
      var score = (tr.count || 1) * 1000 / (nd + 1500);
      if (tr.id === (near.aiTask && near.aiTask.targetId)) score *= 1.35;
      if (score > bestScore) {
        bestScore = score; bestTr = tr; bestFrom = near; bestD = nd;
      }
    }
    if (!bestTr) return null;

    /* ---- 算照亮点 ---- */
    var lead, bracket = false;
    if (bestTr.esmOnly) {
      /* 梯次照明：沿着测向方位，把照明弹按 4.2 / 5.3 / 6.4 km 三级打出去。
         每一发照亮半径 4.2 km，三级叠起来就是一条 10 km 长的"光带"，
         正好把"方位对、距离不知道"这个不确定性夹在中间。
         这是日军夜战的经典做法，也是没有雷达的舰队唯一的侦察手段。 */
      bracket = true;
      var brg0 = Geo.bearing(bestFrom.pos, bestTr.pos);
      var rung = m.ladder || 0;
      lead = Geo.dest(bestFrom.pos, brg0, LADDER[rung]);
      m.ladder = (rung + 1) % LADDER.length;
    } else {
      m.ladder = 0;
      lead = Geo.lead(bestTr.pos, bestTr.course || 0, bestTr.speed || 0, 3.5);
    }

    var shooter = null, sd = 1e9;
    for (var k = 0; k < ships.length; k++) {
      var sh = ships[k];
      if (!aiControlled(world, sh)) continue;
      if (!sh.starshells || sh.starshellCd > 0) continue;
      if (sh.aiTask && (sh.aiTask.role === ROLE.WITHDRAW || sh.aiTask.role === ROLE.MOVE)) continue;
      var dd = V.dist(sh.pos, lead);
      if (dd > 6400) continue;          // 打不到
      if (dd < sd) { sd = dd; shooter = sh; }
    }
    if (!shooter) return null;

    // 已经有一发在飞向同一片海面了，别重复（梯次弹除外：它就是要铺开）
    if (!bracket) {
      for (var a = 0; a < world.starshells.length; a++) {
        var fly = world.starshells[a];
        if (fly.side !== side) continue;
        if (world.time > fly.burstT) continue;
        if (V.dist(fly.pos, lead) < 2200) return null;
      }
    }

    var res = world.fireStarshell(shooter, lead);
    if (res) { m.illumNext = world.time + 6; return null; }   // 装填中，过会儿再看

    // 梯次弹：一发接一发地把三级光带铺开；铺完一轮就按常规间隔等一等，
    // 看看照亮的地方到底有没有东西，而不是对着空海面一直打。
    var more = bracket && (m.ladder !== 0);
    m.illumNext = world.time + (more ? 4 : st.illumGap);
    m.shells = (m.shells || 0) + 1;
    return { ship: shooter.name, target: bestTr.id, range: Math.round(bestD), bracket: bracket };
  }

  /* ---------------------------------------------------------------- 对外 */

  /**
   * 这条舰这一轮参加的齐射（没参加就返回 null）。
   * 只有"打的是同一个目标簇"才算同一次齐射。
   */
  function salvoFor(world, ship) {
    var m = memoOf(world, ship.side);
    if (!m.salvo) return null;
    if (!ship.aiTask || ship.aiTask.targetId !== m.salvo.targetId) return null;
    return m.salvo;
  }

  N.Tactics = {
    ROLE: ROLE,
    LABEL: LABEL,
    STAFF: STAFF,
    salvoFor: salvoFor,
    salvoTarget: salvoTarget,
    plan: plan,
    illuminate: illuminate,
    label: function (ship) {
      if (!ship || !ship.aiTask || !ship.aiTask.role) return null;
      return LABEL[ship.aiTask.role] || ship.aiTask.role;
    },
    staffOf: staffOf,
    contactsOf: contactsOf,
    hint: hint,
    approachPoint: approachPoint,
    hurt: hurt
  };
})(globalThis.Naval = globalThis.Naval || {});
