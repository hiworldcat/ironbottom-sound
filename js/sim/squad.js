/**
 *  sim/squad.js —— 小队与战列线（沿航迹的依次转向）
 *
 *  核心思想：**战列线不是一块刚体，而是一列沿同一条航迹行进的船。**
 *
 *  领舰按命令（航向 / 航路点）自己开，它走过的每一个点都记进一条航迹折线；
 *  后面的舰不是去"某个几何站位"，而是去**领舰航迹上往回退 N 个间距**的那个点。
 *  于是领舰怎么转，后面的舰就怎么转，只是晚一点、走同一个弯 —— 这就是
 *  "依次转向"（turn in succession），转弯半径、甩尾、超调都是自然发生的，
 *  没有任何"整条线一起平移"的假动作。
 *
 *  两种转向：
 *
 *    · 依次转向 line      领舰转向 → 航迹拐弯 → 后舰沿同一条弯走。队形保持纵队。
 *    · 同转     together  **全队同时转同一个角度**：每条舰直接按新航向开，
 *                         不追航迹、也不保持战列线站位。各舰转弯半径相同，
 *                         所以队形在世界上大致原样平移，只是航向一起变了
 *                         （纵队会变成相对新航向的横队，这是同转的固有结果）。
 *
 *  两种移动：
 *
 *    · 战列线移动  给一个（或多个）航路点，整条线沿着这条路线开过去。
 *    · 战列线方向  只改航向，不设终点；航迹照样记录，后舰照样依次跟转。
 *
 *  航迹是按弧长参数化的：`sq.track = [{x, y, s}, ...]`，`s` 从 0 单调增。
 *  第 j 个站位就取 `s = trackLen - j * spacing` 处的点，切向就是该处的航向。
 *  **只有依次转向才用得到航迹**；同转时站位就是各舰自己的位置。
 */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var DEFAULTS = {
    lines: 1,          // 战列线数量
    spacing: 900,      // 同一条线上相邻两舰的间距（米）
    lineGap: 1500,     // 两条战列线之间的距离（米）
    speed: 18,         // 全队航速（节）
    turnMode: 'line',
    idleCommand: 30,        // 这么久没有新指令，就由指挥长接管   // 'line' 依次转向 / 'together' 同转
  };

  var TRACK_STEP = 12;      // 航迹采样间隔（米）
  /**
   * 小队编号：从 1 开始取**当前世界里最小的空号**。
   * 解散一支就回收它的号；换一局世界是新的，自然又从 1 开始。
   */
  function nextNumber(world) {
    var used = {};
    var list = (world && world.squads) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].num) used[list[i].num] = true;
    }
    var n = 1;
    while (used[n]) n++;
    return n;
  }

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }

  /* ==========================================================================
   *  队形参数
   * ========================================================================== */

  /**
   * 队形的唯一真相是 `sq.lanes`：`lanes[线号][线上第几个] = 舰 id`。
   * 各条线的长度**可以不等**（4+2、5+3+2 都行），玩家自己摆。
   * `shipIds` 是它的按线拼接（供遍历），`assign[i]` 是第 i 艘舰的 (线, 排)。
   */

  /** 实际生效的战列线数量（船少的时候线会少） */
  function lineCountOf(sq) {
    if (sq.lanes && sq.lanes.length) return Math.max(1, Math.min(3, sq.lanes.length));
    var want = U.clamp(Math.round(sq.lines), 1, 3);
    return Math.max(1, Math.min(want, Math.max(1, sq.shipIds.length)));
  }

  /** 最长的那条线上排了几艘 */
  function perLineOf(sq) {
    if (sq.lanes && sq.lanes.length) {
      var m = 1;
      for (var i = 0; i < sq.lanes.length; i++) m = Math.max(m, sq.lanes[i].length);
      return m;
    }
    return Math.max(1, Math.ceil(sq.shipIds.length / lineCountOf(sq)));
  }

  /** 第 i 艘舰在队形里的 (线号, 线上第几个) */
  function slotOf(sq, index) {
    var lines = lineCountOf(sq);
    var a = sq.assign && sq.assign[index];
    if (a) return { line: a.line, slot: a.row, lines: lines };
    return { line: index % lines, slot: Math.floor(index / lines), lines: lines };
  }

  /**
   * 由 lanes 重建 shipIds / assign。
   * 扁平顺序是**行优先**（一横排从左到右，再下一排），
   * 所以「第 1 艘」永远紧挨着领舰，不随哪条线长哪条线短而变。
   */
  function rebuild(sq) {
    var ids = [], asg = [];
    var L = sq.lanes.length, maxR = 0, l, r;
    for (l = 0; l < L; l++) maxR = Math.max(maxR, sq.lanes[l].length);
    for (r = 0; r < maxR; r++) {
      for (l = 0; l < L; l++) {
        if (r < sq.lanes[l].length) {
          ids.push(sq.lanes[l][r]);
          asg.push({ line: l, row: r });
        }
      }
    }
    sq.shipIds = ids;
    sq.assign = asg;
    return ids;
  }

  /** 把按行优先排好的舰拆成 lanes[线号][第几个] */
  function buildLanes(ids, lines) {
    var lanes = [];
    for (var l = 0; l < lines; l++) lanes.push([]);
    for (var i = 0; i < ids.length; i++) lanes[i % lines].push(ids[i]);
    return lanes;
  }

  /** 按「行优先」重新分线（线号 = i % 线数），换线数时用 */
  function distribute(world, sq, lines) {
    var n = sq.shipIds.length;
    if (!n) return;
    var L = Math.max(1, Math.min(3, Math.round(lines), n));
    sq.lanes = buildLanes(sq.shipIds.slice(), L);
    sq.lines = L;
    rebuild(sq);
    for (var j = 0; j < sq.shipIds.length; j++) {
      var s = world.shipById(sq.shipIds[j]);
      if (s) s.squadSlot = j;
    }
  }

  /**
   * 某条战列线相对基准航迹的横向偏移。
   * 基准航迹就是领舰压出来的，所以 0 号线正好压在航迹上，其余各线依次向右舷排开。
   */
  function lateralOf(sq, line, lines) {
    return line * sq.lineGap;
  }

  /* ==========================================================================
   *  航迹：记录与采样
   * ========================================================================== */

  function dirOf(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var l = Math.sqrt(dx * dx + dy * dy);
    if (l < 1e-6) return { x: 0, y: 1 };
    return { x: dx / l, y: dy / l };
  }

  /**
   * 在航迹上按弧长采样，同时给出该处的切向（也就是船在该点应有的航向）。
   * 弧长超出航迹两端时就取端点，不会跳。
   */
  function sampleTrack(sq, s) {
    var t = sq.track, n = t ? t.length : 0;
    if (!n) return { x: sq.anchor.x, y: sq.anchor.y, tx: 0, ty: 1, s: 0 };

    if (s <= t[0].s) {
      var d0 = n > 1 ? dirOf(t[0], t[1]) : { x: 0, y: 1 };
      return { x: t[0].x, y: t[0].y, tx: d0.x, ty: d0.y, s: t[0].s };
    }
    var last = t[n - 1];
    if (s >= last.s) {
      var dl = n > 1 ? dirOf(t[n - 2], last) : { x: 0, y: 1 };
      return { x: last.x, y: last.y, tx: dl.x, ty: dl.y, s: last.s };
    }

    var lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (t[mid].s <= s) lo = mid; else hi = mid;
    }
    var a = t[lo], b = t[hi];
    var span = b.s - a.s;
    var k = span > 1e-6 ? (s - a.s) / span : 0;
    var d = dirOf(a, b);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, tx: d.x, ty: d.y, s: s };
  }

  /** 把领舰当前位置压进航迹 */
  function recordTrack(world, sq) {
    var guide = world.shipById(sq.shipIds[0]);
    if (!guide) return;
    sq.anchor.x = guide.pos.x;
    sq.anchor.y = guide.pos.y;

    var t = sq.track;
    var last = t[t.length - 1];
    var d = V.dist(guide.pos, last);
    if (d >= TRACK_STEP) {
      t.push({ x: guide.pos.x, y: guide.pos.y, s: last.s + d });
      sq.trackLen = last.s + d;
    }

    // 只保留站位用得着的长度，别无限长
    var need = (perLineOf(sq) - 1) * sq.spacing + 900;
    while (t.length > 2 && sq.trackLen - t[0].s > need + 2000) t.shift();
  }

  /** 重置航迹：从领舰位置沿 axis 向后铺一条直线 */
  function resetTrack(world, sq) {
    var guide = world.shipById(sq.shipIds[0]);
    if (!guide) return;
    var back = (perLineOf(sq) - 1) * sq.spacing + 800;
    var axis = U.norm360(sq.axis != null ? sq.axis : guide.heading);
    var t = [];
    for (var d = back; d > 0; d -= TRACK_STEP) {
      var p = Geo.dest(guide.pos, axis + 180, d);
      t.push({ x: p.x, y: p.y, s: -d });
    }
    // 末端必须正好落在领舰身上、s 正好是 0，否则第 0 个站位会差一小截
    t.push({ x: guide.pos.x, y: guide.pos.y, s: 0 });
    sq.track = t;
    sq.trackLen = 0;
    sq.anchor = { x: guide.pos.x, y: guide.pos.y };
  }

  /* ==========================================================================
   *  站位
   * ========================================================================== */

  /**
   * 第 index 艘舰的站位。
   *
   *  依次转向：航迹上往回退 slot*spacing 的那个点，再横向偏移到它那条线上；
   *  同转：    没有"站位"这回事 —— 返回这艘舰自己的位置，见 keepTogether()。
   */
  function stationOf(sq, index) {
    var sp = slotOf(sq, index);
    var lat = lateralOf(sq, sp.line, sp.lines);

    if (sq.turnMode === 'together' && sq.offsets) {
      var off = sq.offsets[index] || { dx: 0, dy: 0 };
      return {
        pos: { x: sq.anchor.x + off.dx, y: sq.anchor.y + off.dy },
        heading: sq.course
      };
    }

    var s = (sq.trackLen || 0) - sp.slot * sq.spacing;
    var smp = sampleTrack(sq, s);
    var p = { x: smp.x, y: smp.y };
    if (lat) p = Geo.dest(p, U.norm360(Geo.bearing({ x: 0, y: 0 }, { x: smp.tx, y: smp.ty }) + 90), lat);
    return { pos: p, heading: U.norm360(Geo.bearing({ x: 0, y: 0 }, { x: smp.tx, y: smp.ty })) };
  }

  /** 整条战列线的两个端点（画图用） */
  function lineSpan(sq) {
    var n = sq.shipIds.length;
    if (!n) return null;
    return { a: stationOf(sq, 0).pos, b: stationOf(sq, n - 1).pos };
  }

  /* ==========================================================================
   *  创建 / 解散
   * ========================================================================== */

  function create(world, shipIds, opts) {
    opts = opts || {};
    var ships = [], i;
    for (i = 0; i < shipIds.length; i++) {
      var s = world.shipById(shipIds[i]);
      if (s && !s.sunk) ships.push(s);
    }
    if (!ships.length) return null;
    var side = ships[0].side;
    ships = ships.filter(function (s) { return s.side === side; });
    if (!ships.length) return null;

    var lead = ships[0];
    var axis0 = U.norm360(lead.heading);
    var fwd = Geo.headingVec(axis0);
    var stbd = Geo.headingVec(U.norm360(axis0 + 90));
    function projF(s) { return V.dot(V.sub(s.pos, lead.pos), fwd); }
    function projS(s) { return V.dot(V.sub(s.pos, lead.pos), stbd); }

    var linesWanted = U.clamp(Math.round(num(opts.lines, DEFAULTS.lines)), 1, 3);
    var nLines = Math.max(1, Math.min(linesWanted, ships.length));

    // 纵向前后分档、档内左右排序：站位最接近现有队形，编队时不会互相穿过去
    var byFwd = ships.slice().sort(function (a, b) { return projF(b) - projF(a); });
    var rows = Math.ceil(byFwd.length / nLines);
    var ordered = [];
    for (var r = 0; r < rows; r++) {
      var row = byFwd.slice(r * nLines, r * nLines + nLines);
      row.sort(function (a, b) { return projS(a) - projS(b); });
      for (var c = 0; c < row.length; c++) ordered.push(row[c]);
    }

    var sqNum = opts.num || nextNumber(world);
    var sq = {
      num: sqNum,
      id: 'SQ' + sqNum,
      name: opts.name || ('第 ' + sqNum + ' 小队'),
      side: side,
      shipIds: ordered.map(function (s) { return s.id; }),
      lanes: buildLanes(ordered.map(function (s) { return s.id; }), nLines),
      assign: null,
      lines: nLines,
      spacing: num(opts.spacing, DEFAULTS.spacing),
      lineGap: num(opts.lineGap, DEFAULTS.lineGap),
      speed: num(opts.speed, Math.round(lead.orderedSpeed || DEFAULTS.speed)),
      turnMode: opts.turnMode === 'together' ? 'together' : 'line',
      aiControl: opts.aiControl !== false,   // 没指令时由指挥长接管
      lastPlayerOrderAt: 0,
      aiTakeover: false,
      aiWhy: null,

      axis: axis0,
      course: axis0,
      anchor: { x: ordered[0].pos.x, y: ordered[0].pos.y },
      track: [],
      trackLen: 0,
      route: [],
      goal: null,
      order: null,
      offsets: null,
      effSpeed: 0,
      blocked: false,
      guideId: ordered[0].id,
      createdAt: world.time
    };

    rebuild(sq);
    for (i = 0; i < ordered.length; i++) {
      ordered[i].squadId = sq.id;
      ordered[i].squadSlot = i;
      ordered[i].moveTarget = null;
    }

    resetTrack(world, sq);
    if (sq.turnMode === 'together') snapshotOffsets(world, sq);

    world.squads.push(sq);
    world.log(side, '◆ ' + sq.name + ' 编成完毕（' + ordered.length + ' 艘，' +
      lineCountOf(sq) + ' 条战列线）', 'good');
    return sq;
  }

  function remove(world, sq) {
    if (!sq) return;
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      if (s.squadId === sq.id) { s.squadId = null; s.squadSlot = -1; }
    }
    var idx = world.squads.indexOf(sq);
    if (idx >= 0) world.squads.splice(idx, 1);
    world.log(sq.side, '◇ ' + sq.name + ' 解散', 'info');
  }

  function detach(world, sq, shipId) {
    var idx = sq.shipIds.indexOf(shipId);
    if (idx < 0) return;
    dropAt(sq, idx);
    var s = world.shipById(shipId);
    if (s) { s.squadId = null; s.squadSlot = -1; }
    rebuild(sq);
    for (var i = 0; i < sq.shipIds.length; i++) {
      var o = world.shipById(sq.shipIds[i]);
      if (o) o.squadSlot = i;
    }
    if (!sq.shipIds.length) remove(world, sq);
  }

  /** 从 lanes 里挖掉第 index 个站位（空掉的线整列删除） */
  function dropAt(sq, index) {
    var a = sq.assign && sq.assign[index];
    if (a && sq.lanes[a.line]) {
      sq.lanes[a.line].splice(a.row, 1);
      for (var l = sq.lanes.length - 1; l >= 0; l--) {
        if (!sq.lanes[l].length && sq.lanes.length > 1) sq.lanes.splice(l, 1);
      }
      sq.lines = Math.max(1, sq.lanes.length);
    } else {
      sq.shipIds.splice(index, 1);
    }
  }

  /* ==========================================================================
   *  命令
   * ========================================================================== */

  function delay(world) {
    return 1.4 + world.rng.range(0, 1.8);
  }

  function wake(sq) {
    if (sq.speed < 1) sq.speed = DEFAULTS.speed;
  }

  /**
   * 同转：全队同时转同一个角度。
   *
   *  这里**不追航迹、也不保持战列线**。每条舰只是把航向摆到队航向，
   *  各舰转弯半径一样，于是整队像刚体一样平移着转过去 —— 纵队在新航向上
   *  自然变成横队。谁掉队了不会去补位，这是同转与依次转向的根本区别。
   *
   *  `sq.offsets` 只用来给界面画"各舰现在在哪"，每帧跟着实际位置刷新。
   */
  function keepTogether(world, ship, sq, idx) {
    var base = (sq.effSpeed != null ? sq.effSpeed : sq.speed);
    var maxSpd = ship.effectiveMaxSpeed();
    var wantH = U.norm360(sq.course);
    ship.orderedHeading = N.AI.avoidLand(world, ship, wantH, Geo.dest(ship.pos, wantH, 3000));
    // 掉队太多的（被打坏、被挤开）允许追一下，但不改变横向位置
    if (idx > 0) {
      var lead = world.shipById(sq.shipIds[0]);
      if (lead && V.dist(ship.pos, lead.pos) > sq.spacing * (idx + 1.5)) {
        base = Math.max(base, Math.min(maxSpd, base * 1.15));
      }
    }
    ship.orderedSpeed = U.clamp(base, 0, maxSpd);
    return true;
  }

  /** 同转：把各舰相对领舰的世界偏移刷新成当前实际位置 */
  function snapshotOffsets(world, sq) {
    var guide = world.shipById(sq.shipIds[0]);
    if (!guide) return;
    var out = [];
    for (var i = 0; i < sq.shipIds.length; i++) {
      var s = world.shipById(sq.shipIds[i]);
      out.push(s ? { dx: s.pos.x - guide.pos.x, dy: s.pos.y - guide.pos.y } : { dx: 0, dy: 0 });
    }
    sq.offsets = out;
    if (!sq.anchor) sq.anchor = { x: guide.pos.x, y: guide.pos.y };
    else { sq.anchor.x = guide.pos.x; sq.anchor.y = guide.pos.y; }
  }

  /**
   * 方向命令：改全队航向。
   * @param {string} mode 'line' 依次转向 / 'together' 同转
   */
  function issueCourse(world, sq, heading, mode, byPlayer) {
    if (!sq || !sq.shipIds.length) return null;
    if (mode) sq.turnMode = (mode === 'together' ? 'together' : 'line');
    if (byPlayer) sq.lastPlayerOrderAt = world.time;
    wake(sq);
    sq.order = {
      kind: 'course',
      heading: U.norm360(heading),
      mode: sq.turnMode,
      at: world.time + delay(world)
    };
    return sq.order;
  }

  /**
   * 移动命令：整条战列线沿航路点开过去。
   * @param {boolean} append true = 追加航路点（Shift+右键），false = 替换整条航线
   */
  function issueMove(world, sq, point, append, byPlayer) {
    if (!sq || !sq.shipIds.length || !point) return null;
    var route = append ? (sq.route || []).slice() : [];
    route.push({ x: point.x, y: point.y });
    if (byPlayer) sq.lastPlayerOrderAt = world.time;
    wake(sq);
    sq.order = {
      kind: 'route',
      route: route,
      append: !!append,
      mode: 'line',          // 走航线必然是依次转向
      at: world.time + delay(world)
    };
    return sq.order;
  }

  /** 一次给一整条航线 */
  function issueRoute(world, sq, points, byPlayer) {
    if (!sq || !sq.shipIds.length || !points || !points.length) return null;
    if (byPlayer) sq.lastPlayerOrderAt = world.time;
    wake(sq);
    sq.order = {
      kind: 'route',
      route: points.map(function (p) { return { x: p.x, y: p.y }; }),
      append: false,
      mode: 'line',
      at: world.time + delay(world)
    };
    return sq.order;
  }

  /** 重新写一遍每艘舰的站位序号 */
  function reindex(world, sq) {
    for (var i = 0; i < sq.shipIds.length; i++) {
      var s = world.shipById(sq.shipIds[i]);
      if (s) s.squadSlot = i;
    }
  }

  /** 领舰换人以后航迹要重铺，否则队形会倒跳 */
  function afterMove(world, sq, oldGuide) {
    if (!sq.shipIds.length) return;
    if (oldGuide === sq.shipIds[0]) return;
    sq.guideId = sq.shipIds[0];
    resetTrack(world, sq);
    if (sq.turnMode === 'together') snapshotOffsets(world, sq);
  }

  /**
   * 交换两个站位（站位按扁平序号，0 号是领舰）。
   * 舰不会瞬移 —— 它们只是换了目标站位，各自开过去。
   */
  function swapStations(world, sq, i, j) {
    if (!sq) return false;
    var n = sq.shipIds.length;
    if (i < 0 || j < 0 || i >= n || j >= n || i === j) return false;

    var oldGuide = sq.shipIds[0];
    var a = sq.assign[i], b = sq.assign[j];
    if (!a || !b) return false;
    var t = sq.lanes[a.line][a.row];
    sq.lanes[a.line][a.row] = sq.lanes[b.line][b.row];
    sq.lanes[b.line][b.row] = t;
    rebuild(sq);
    for (var k = 0; k < sq.shipIds.length; k++) {
      var sk = world.shipById(sq.shipIds[k]);
      if (sk) sk.squadSlot = k;
    }
    afterMove(world, sq, oldGuide);
    return true;
  }

  /**
   * 把某一艘舰挪到另一条线的末尾 —— 这是排出 4+2、5+2 这种不等长队形的方式。
   * 不允许把一条线搬空（想减少线数请用「线数」按钮）。
   */
  function moveToLane(world, sq, index, lane) {
    if (!sq) return false;
    var n = sq.shipIds.length;
    if (index < 0 || index >= n) return false;
    var L = lineCountOf(sq);
    if (lane < 0 || lane >= L) return false;
    var a = sq.assign[index];
    if (!a || a.line === lane) return false;
    if (sq.lanes[a.line].length <= 1) return false;   // 不能把一条线搬空

    var oldGuide = sq.shipIds[0];
    var id = sq.lanes[a.line].splice(a.row, 1)[0];
    sq.lanes[lane].push(id);
    rebuild(sq);
    for (var k = 0; k < sq.shipIds.length; k++) {
      var sk = world.shipById(sq.shipIds[k]);
      if (sk) sk.squadSlot = k;
    }
    afterMove(world, sq, oldGuide);
    return true;
  }

  /**
   * 直接指定每条线上有哪几艘：`lanes = [[id, id, id, id], [id, id]]`。
   * 最自由的接口 —— 界面上的「交换站位 / 挪到某条线」最终都落到这里。
   * 各线长度可以不等，但每条线至少要有一艘。
   */
  function setLanes(world, sq, lanes) {
    if (!sq || !lanes || !lanes.length || lanes.length > 3) return false;
    var all = [];
    for (var l = 0; l < lanes.length; l++) {
      if (!lanes[l] || !lanes[l].length) return false;
      for (var r = 0; r < lanes[l].length; r++) {
        var id = lanes[l][r];
        if (sq.shipIds.indexOf(id) < 0 || all.indexOf(id) >= 0) return false;
        all.push(id);
      }
    }
    if (all.length !== sq.shipIds.length) return false;

    var oldGuide = sq.shipIds[0];
    sq.lanes = lanes.map(function (x) { return x.slice(); });
    sq.lines = sq.lanes.length;
    rebuild(sq);
    for (var k = 0; k < sq.shipIds.length; k++) {
      var sk = world.shipById(sq.shipIds[k]);
      if (sk) sk.squadSlot = k;
    }
    afterMove(world, sq, oldGuide);
    return true;
  }

  /** 直接指定整个站位顺序（必须是现有成员的排列），按行优先重新分线 */
  function setOrder(world, sq, ids) {
    if (!sq || !ids || ids.length !== sq.shipIds.length) return false;
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      if (sq.shipIds.indexOf(ids[i]) < 0 || seen[ids[i]]) return false;
      seen[ids[i]] = true;
    }
    var oldGuide = sq.shipIds[0];
    sq.shipIds = ids.slice();
    distribute(world, sq, lineCountOf(sq));
    afterMove(world, sq, oldGuide);
    return true;
  }

  /** 改队形 */
  function setFormation(world, sq, opts) {
    if (!sq) return;
    var oldLines = lineCountOf(sq);
    var wantLines = opts.lines != null ? U.clamp(Math.round(opts.lines), 1, 3) : oldLines;
    if (wantLines !== oldLines) {
      // 换线数：按行优先重新分，各线长度自动拉平
      distribute(world, sq, wantLines);
      if (sq.turnMode === 'together') snapshotOffsets(world, sq);
    } else if (opts.lines != null) {
      sq.lines = wantLines;
    }
    if (opts.spacing != null) sq.spacing = U.clamp(opts.spacing, 400, 3000);
    if (opts.lineGap != null) sq.lineGap = U.clamp(opts.lineGap, 600, 4000);
    if (opts.speed != null) sq.speed = U.clamp(opts.speed, 0, 34);
    if (opts.turnMode) {
      var m = opts.turnMode === 'together' ? 'together' : 'line';
      if (m !== sq.turnMode) {
        sq.turnMode = m;
        // 同转 → 依次转向：从领舰当前位置重新铺一条航迹，大家重新排成纵队
        if (m === 'line') { sq.offsets = null; resetTrack(world, sq); }
        else snapshotOffsets(world, sq);
      }
    }
  }

  /* ==========================================================================
   *  指挥长（小队自己的 AI）
   * ========================================================================== */

  /** 小队指挥长：队首那艘舰的舰长（沉了就顺延） */
  function commanderOf(world, sq) {
    for (var i = 0; i < sq.shipIds.length; i++) {
      var s = world.shipById(sq.shipIds[i]);
      if (s && !s.sunk && s.alive) return s;
    }
    return null;
  }

  /**
   * 指挥长替玩家做决定。
   * 用的是**指挥舰的态势图**（几十秒前的），不是真坐标 —— 跟玩家看到的一样旧。
   */
  function decide(world, sq) {
    var cmdr = commanderOf(world, sq);
    if (!cmdr) return null;

    var pic = (N.Sensors && N.Sensors.trackList) ? N.Sensors.trackList(world, sq.side) : [];
    var near = null, nd = 1e9;
    for (var i = 0; i < pic.length; i++) {
      var t = pic[i];
      // 假回波不是目标：指挥长不会带着整条战列线去追一团海杂波
      if (t.phantom) continue;
      if (world.time - (t.observedAt || t.lastSeen || 0) > 240) continue;
      var d = V.dist(sq.anchor || cmdr.pos, t.pos);
      if (d < nd) { nd = d; near = t; }
    }

    // 队伍状态
    var hullFrac = 0, n = 0;
    for (var j = 0; j < sq.shipIds.length; j++) {
      var sh = world.shipById(sq.shipIds[j]);
      if (!sh || sh.sunk) continue;
      hullFrac += sh.hull / sh.hullMax; n++;
    }
    hullFrac = n ? hullFrac / n : 0;

    var base = sq.anchor || cmdr.pos;

    if (!near) {
      // 图上没有目标：保持航向巡航
      return { kind: 'course', heading: sq.course, why: '图上没有接触，保持航向' };
    }

    var brg = Geo.bearing(base, near.pos);

    if (hullFrac < 0.45) {
      // 打残了：脱离接触
      return { kind: 'course', heading: U.norm360(brg + 180), why: '本队受损严重，脱离接触' };
    }

    // 炮战理想距离：太远就压上去，太近就拉开，差不多了就侧身保持
    var ideal = 11000;
    if (nd > ideal * 1.3) return { kind: 'course', heading: brg, why: '接近目标' };
    if (nd < ideal * 0.65) return { kind: 'course', heading: U.norm360(brg + 180), why: '距离过近，拉开' };
    return { kind: 'course', heading: U.norm360(brg + 50), why: '保持炮战距离，侧身周旋' };
  }

  /** 玩家多久没管，就由指挥长接管 */
  function maybeTakeOver(world, sq) {
    if (!sq.aiControl) return;
    if (sq.order) return;                                  // 还有指令在路上
    // 玩家给的航线还没走完，那就是在执行计划，别插嘴
    if (sq.route && sq.route.length) {
      if (sq.aiTakeover) {
        sq.aiTakeover = false;
        world.log(sq.side, sq.name + ' 恢复人工指挥', 'info');
      }
      return;
    }
    var idle = world.time - (sq.lastPlayerOrderAt || 0);
    if (idle < (DEFAULTS.idleCommand || 30)) {
      if (sq.aiTakeover) {
        sq.aiTakeover = false;
        world.log(sq.side, sq.name + ' 恢复人工指挥', 'info');
      }
      return;
    }
    if (world.time < (sq.nextAIDecision || 0)) return;
    sq.nextAIDecision = world.time + 18;

    var d = decide(world, sq);
    if (!d) return;

    if (!sq.aiTakeover) {
      sq.aiTakeover = true;
      var c = commanderOf(world, sq);
      world.log(sq.side, '◆ ' + sq.name + ' 无新指令，由 ' + (c ? c.name : '指挥长') +
        ' 舰长接管指挥', 'info');
    }
    issueCourse(world, sq, d.heading, sq.turnMode, false);
    sq.aiWhy = d.why;
  }

  /* ==========================================================================
   *  每帧推进
   * ========================================================================== */

  function update(world, dt) {
    var list = world.squads;
    if (!list || !list.length) return;

    for (var i = list.length - 1; i >= 0; i--) {
      var sq = list[i];

      // 清理沉没的舰
      var lost = false;
      for (var k = sq.shipIds.length - 1; k >= 0; k--) {
        var s = world.shipById(sq.shipIds[k]);
        if (!s || s.sunk || !s.alive) {
          if (s) { s.squadId = null; s.squadSlot = -1; }
          dropAt(sq, k);
          lost = true;
        }
      }
      if (lost) rebuild(sq);
      if (!sq.shipIds.length) { remove(world, sq); continue; }
      for (var j = 0; j < sq.shipIds.length; j++) {
        var o = world.shipById(sq.shipIds[j]);
        if (o) o.squadSlot = j;
      }

      // 领舰换人（被打沉 / 移出）：航迹从新领舰的位置重铺，别让航迹倒跳
      var guide = world.shipById(sq.shipIds[0]);
      if (!guide) continue;
      if (sq.guideId !== guide.id) {
        sq.guideId = guide.id;
        resetTrack(world, sq);
        if (sq.turnMode === 'together') snapshotOffsets(world, sq);
      }

      // 指令延迟
      if (sq.order && world.time >= sq.order.at) {
        var od = sq.order;
        sq.order = null;
        if (od.mode && od.mode !== sq.turnMode) {
          sq.turnMode = od.mode;
          if (od.mode === 'line') { sq.offsets = null; resetTrack(world, sq); }
        }
        if (od.kind === 'course') {
          sq.course = od.heading;
          sq.route = [];
          sq.goal = null;
          if (sq.turnMode === 'together') snapshotOffsets(world, sq);
        } else if (od.kind === 'route') {
          sq.route = od.route;
          sq.goal = od.route.length ? od.route[od.route.length - 1] : null;
          if (sq.turnMode === 'together') {
            sq.turnMode = 'line';
            sq.offsets = null;
            resetTrack(world, sq);
          }
        }
      }

      // 没有及时指令 → 指挥长接手
      maybeTakeOver(world, sq);

      // 记录领舰航迹 + 同步锚点
      recordTrack(world, sq);

      // 同转：站位就是各舰自己的位置，每帧刷新，界面画出来才不会撒谎
      if (sq.turnMode === 'together') snapshotOffsets(world, sq);

      // 队形轴向 = 航迹末端的切向（依次转向时）；同转时没有队形轴向。
      // 注意 sq.course 是"下令的航向"，不能被领舰实际航向覆盖，否则领舰永远不转。
      if (sq.turnMode === 'line') {
        var smp = sampleTrack(sq, sq.trackLen);
        sq.axis = U.norm360(Geo.bearing({ x: 0, y: 0 }, { x: smp.tx, y: smp.ty }));
      } else {
        sq.axis = U.norm360(sq.course);
      }

      // 队速取领舰实际航速，后面的舰跟着它走
      sq.effSpeed = guide ? guide.speed : 0;
    }
  }

  /* ==========================================================================
   *  领舰：按航路点开
   * ========================================================================== */

  /** 领舰的航路跟随。返回 true 表示已接管航向航速。 */
  function guideSteer(world, ship, sq) {
    var arrive = Math.max(350, sq.spacing * 0.55);

    // 到点就换下一个航路点
    while (sq.route && sq.route.length && V.dist(ship.pos, sq.route[0]) < arrive) {
      sq.route.shift();
      if (!sq.route.length) {
        sq.goal = null;
        sq.speed = 0;
        sq.route = [];
      }
    }

    var target = (sq.route && sq.route.length) ? sq.route[0] : null;
    if (target) sq.course = U.norm360(Geo.bearing(ship.pos, target));
    var wantH = target ? sq.course : sq.course;
    ship.orderedHeading = N.AI.avoidLand(world, ship, wantH, target || Geo.dest(ship.pos, sq.course, 3000));

    // 队形没跟上的时候领舰慢一点，别把尾巴甩掉
    var worst = 0;
    for (var i = 1; i < sq.shipIds.length; i++) {
      var s = world.shipById(sq.shipIds[i]);
      if (!s || s.sunk) continue;
      var d = V.dist(s.pos, stationOf(sq, i).pos);
      if (d > 6000) continue;
      if (d > worst) worst = d;
    }
    var spd = sq.speed;
    if (worst > 900) spd *= U.clamp(1 - (worst - 900) / 3000, 0.4, 1);

    ship.orderedSpeed = U.clamp(spd, 0, ship.effectiveMaxSpeed());
    sq.blocked = false;
    return true;
  }

  /* ==========================================================================
   *  单舰保持阵位
   * ========================================================================== */

  function stationKeep(world, ship) {
    var sq = world.squadById ? world.squadById(ship.squadId) : null;
    if (!sq) return false;
    var idx = sq.shipIds.indexOf(ship.id);
    if (idx < 0) return false;

    if (idx === 0) return guideSteer(world, ship, sq);

    // 同转：全队同时转同一个角度，不追航迹、也不保持战列线
    if (sq.turnMode === 'together') return keepTogether(world, ship, sq, idx);

    var st = stationOf(sq, idx);
    var stPos = st.pos;
    if (world.isLand(stPos.x, stPos.y)) {
      var wet = world.nearestWater(stPos.x, stPos.y, 4000);
      if (wet) stPos = wet;
    }

    var maxSpd = ship.effectiveMaxSpeed();
    var base = (sq.effSpeed != null ? sq.effSpeed : sq.speed);

    // 参考航向：依次转向时用站位处的航迹切向（也就是"前舰在那个点走的航向"），
    // 同转时用队航向。两者用同一套跟随律。
    var ref = (sq.turnMode === 'line') ? st.heading : sq.course;

    // 把站位误差拆成"沿航向"和"横向"两个分量
    var fv = Geo.headingVec(ref);
    var ex = stPos.x - ship.pos.x, ey = stPos.y - ship.pos.y;
    var along = ex * fv.x + ey * fv.y;          // 正 = 站位在前方
    var across = ex * fv.y - ey * fv.x;         // 正 = 站位在右舷（右舷 = 前向顺时针 90°）

    // 纯追踪：横向误差除以一个固定的前视距离换算成航向修正。
    // 前视距离不能用"纵向误差"（转弯时它会趋零，修正角会飙到 90°，
    // 结果就是后舰直接切内角、脱离航迹）。
    var look = Math.max(420, Math.abs(along));
    var corr = Math.atan2(across, look) * 180 / Math.PI;
    var wantH = U.norm360(ref + U.clamp(corr, -75, 75));

    // 航速：纵向误差决定快慢，单调——落后就加速，超前就减速，齐了回队速
    var spd = base + U.clamp(along / 40, -base * 0.5, 14);
    spd = Math.max(spd, Math.min(base, 6));      // 舵效保底
    if (along > 700) spd = maxSpd;               // 掉队太多，全速追

    ship.orderedHeading = N.AI.avoidLand(world, ship, wantH, stPos);
    ship.orderedSpeed = U.clamp(spd, 0, maxSpd);
    return true;
  }

  /* ==========================================================================
   *  查询
   * ========================================================================== */

  function describe(sq, world) {
    var lines = lineCountOf(sq);
    var alive = 0;
    for (var i = 0; i < sq.shipIds.length; i++) {
      var s = world.shipById(sq.shipIds[i]);
      if (s && !s.sunk) alive++;
    }
    var worst = 0;
    for (i = 0; i < sq.shipIds.length; i++) {
      var sh = world.shipById(sq.shipIds[i]);
      if (!sh || sh.sunk) continue;
      worst = Math.max(worst, V.dist(sh.pos, stationOf(sq, i).pos));
    }
    // 每条线上各有几艘、分别是哪几艘 —— 以 lanes 为准（各线可以不等长）
    var counts = [], names = [];
    for (i = 0; i < lines; i++) {
      var lane = (sq.lanes && sq.lanes[i]) || [];
      counts.push(lane.length);
      var rowNames = [];
      for (var q = 0; q < lane.length; q++) {
        var sn = world.shipById(lane[q]);
        rowNames.push(sn ? sn.name : '—');
      }
      names.push(rowNames);
    }

    // 每个站位是谁：index = row * 线数 + 线号
    var slots = [];
    for (i = 0; i < sq.shipIds.length; i++) {
      var sp = slotOf(sq, i);
      var s3 = world.shipById(sq.shipIds[i]);
      slots.push({
        index: i,
        id: sq.shipIds[i],
        name: s3 ? s3.name : '—',
        type: s3 ? s3.cls.type : '',
        line: sp.line,
        row: sp.slot,
        lead: i === 0
      });
    }

    // 按线分组，供界面直接画
    var lanes = [];
    for (i = 0; i < lineCountOf(sq); i++) lanes.push([]);
    for (i = 0; i < slots.length; i++) {
      if (lanes[slots[i].line]) lanes[slots[i].line].push(slots[i]);
    }

    return {
      id: sq.id,
      num: sq.num,
      name: sq.name,
      side: sq.side,
      count: alive,
      lines: lines,
      perLine: perLineOf(sq),
      lineCounts: counts,
      lineShips: names,
      slots: slots,
      lanes: lanes,
      spacing: sq.spacing,
      lineGap: sq.lineGap,
      course: Math.round(sq.course),
      axis: Math.round(sq.axis),
      speed: Math.round(sq.speed),
      turnMode: sq.turnMode,
      waypoints: (sq.route || []).length,
      trackLen: Math.round(sq.trackLen || 0),
      worstError: Math.round(worst),
      pending: !!sq.order,
      goal: sq.goal
    };
  }

  N.Squad = {
    DEFAULTS: DEFAULTS,
    create: create,
    remove: remove,
    detach: detach,
    issueCourse: issueCourse,
    issueMove: issueMove,
    issueRoute: issueRoute,
    setFormation: setFormation,
    swapStations: swapStations,
    moveToLane: moveToLane,
    setLanes: setLanes,
    setOrder: setOrder,
    lineCountOf: lineCountOf,
    update: update,
    nextNumber: nextNumber,
    commanderOf: commanderOf,
    decide: decide,
    stationKeep: stationKeep,
    stationOf: stationOf,
    lineSpan: lineSpan,
    sampleTrack: sampleTrack,
    perLineOf: perLineOf,
    describe: describe
  };
})(globalThis.Naval = globalThis.Naval || {});
