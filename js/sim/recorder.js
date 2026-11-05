/* =============================================================================
 *  sim/recorder.js —— 战斗录像：录制关键帧，并在回放时重建“世界快照”
 *
 *  设计要点
 *  ---------------------------------------------------------------------------
 *  · 每 interval 秒（默认 1 秒）记录一帧：舰位/航向/航速/损伤、玩家侧航迹、
 *    鱼雷、水柱、烟幕。数据量很小（一场 45 分钟的战斗约 2~3 MB 对象）。
 *  · 回放是“上帝视角”：双方真实舰位都会绘制，用来复盘自己当时到底在打什么。
 *  · 帧之间做线性插值，回放看起来是连续的。
 *  · 同时记录战报事件，用于时间轴上的标记。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  /* ==========================================================================
   *  录制
   * ========================================================================== */
  function Recorder(world, opts) {
    opts = opts || {};
    this.world = world;
    this.interval = opts.interval || 1.0;
    this.maxFrames = opts.maxFrames || 7200;
    this.frames = [];
    this.events = [];
    this.lastT = -1e9;
    this.roster = {};

    // 舰艇名册（回放时用来还原舰名与舰级，避免每帧重复存字符串）
    for (var i = 0; i < world.ships.length; i++) {
      var s = world.ships[i];
      this.roster[s.id] = { name: s.name, clsId: s.clsId, side: s.side, group: s.group };
    }

    var self = this;
    world.bus.on('message', function (m) {
      if (!m) return;
      self.events.push({ t: m.t, text: m.text, kind: m.kind });
      if (self.events.length > 500) self.events.shift();
    });
    world.bus.on('shipSunk', function (s) {
      self.events.push({ t: world.time, text: s.name + ' 沉没', kind: 'sink', mark: true });
    });

    this.capture(true);
  }

  Recorder.prototype.capture = function (force) {
    var w = this.world;
    if (!force && w.time - this.lastT < this.interval - 1e-6) return;
    this.lastT = w.time;

    var f = {
      t: w.time,
      ships: [],
      tracks: [],
      torps: [],
      splashes: [],
      smokes: [],
      illum: [],
      air: [],
      shore: [],
      squads: []
    };

    var i, s;
    for (i = 0; i < w.ships.length; i++) {
      s = w.ships[i];
      f.ships.push({
        id: s.id,
        side: s.side,
        x: Math.round(s.pos.x),
        y: Math.round(s.pos.y),
        h: Math.round(s.heading),
        v: Math.round(s.speed * 10) / 10,
        hp: Math.round(U.clamp01(s.hull / s.hullMax) * 100),
        fl: Math.round(s.flood),
        fi: Math.round(s.fire),
        st: s.sunk ? 2 : (s.sinking ? 1 : 0),
        // 当时的“操作”：指令航向/航速、是否交战、打谁
        oh: Math.round(s.orderedHeading),
        ov: Math.round(s.orderedSpeed * 10) / 10,
        en: s.engage ? 1 : 0,
        bt: s.bombardTargetId || null,
        tg: s.targetTrackId || null,
        mt: s.moveTarget ? [Math.round(s.moveTarget.x), Math.round(s.moveTarget.y)] : null
      });
    }

    var tl = N.Sensors.trackList(w, w.playerSide);
    for (i = 0; i < tl.length; i++) {
      var tr = tl[i];
      f.tracks.push({
        id: tr.id,
        x: Math.round(tr.pos.x),
        y: Math.round(tr.pos.y),
        u: Math.round(tr.uncertainty),
        l: tr.idLevel,
        c: Math.round(tr.course),
        v: Math.round(tr.speed * 10) / 10,
        tg: tr.typeGuess,
        cg: tr.classGuess,
        ng: tr.nameGuess,
        mi: tr.misId ? 1 : 0,
        a: Math.round(w.time - tr.lastSeen)
      });
    }

    for (i = 0; i < w.torpedoes.length; i++) {
      var t = w.torpedoes[i];
      f.torps.push({
        x: Math.round(t.pos.x), y: Math.round(t.pos.y),
        sx: Math.round(t.start.x), sy: Math.round(t.start.y),
        h: Math.round(t.heading), side: t.side, sp: t.spotted ? 1 : 0,
        o: t.ownerId || null,          // 谁发射的（回放里要标出来）
        v: Math.round(t.speed * 10) / 10,
        d: Math.round(t.traveled || 0)
      });
    }

    for (i = 0; i < w.splashes.length; i++) {
      var sp = w.splashes[i];
      f.splashes.push({
        x: Math.round(sp.pos.x), y: Math.round(sp.pos.y),
        r: Math.round(sp.r), side: sp.side, k: sp.kind,
        o: sp.ownerId || null,         // 这一发是谁打的
        c: sp.cal || 0
      });
    }

    for (i = 0; i < w.smokes.length; i++) {
      var sm = w.smokes[i];
      f.smokes.push({ x: Math.round(sm.pos.x), y: Math.round(sm.pos.y), r: Math.round(sm.radius) });
    }

    if (w.illum) {
      for (i = 0; i < w.illum.length; i++) {
        var il = w.illum[i];
        f.illum.push({
          x: Math.round(il.pos.x), y: Math.round(il.pos.y), r: Math.round(il.r),
          b: Math.round(il.born || 0), u: Math.round(il.until || 0), s: il.side || null
        });
      }
    }
    if (w.starshells) {
      for (i = 0; i < w.starshells.length; i++) {
        var st = w.starshells[i];
        f.air.push({
          x: Math.round(st.pos.x), y: Math.round(st.pos.y),
          fx: Math.round(st.from.x), fy: Math.round(st.from.y),
          b: Math.round(st.burstT), u: Math.round(st.until), s: st.side
        });
      }
    }
    if (w.shoreTargets) {
      for (i = 0; i < w.shoreTargets.length; i++) {
        var sh0 = w.shoreTargets[i];
        f.shore.push({ id: sh0.id, hp: Math.round(sh0.hp), d: sh0.destroyed ? 1 : 0 });
      }
    }

    // 战列线：队形几何 + 领舰航迹（后舰的站位就在航迹上）
    if (w.squads) {
      for (i = 0; i < w.squads.length; i++) {
        var sq0 = w.squads[i];
        var li = Math.max(1, Math.min(Math.round(sq0.lines), sq0.shipIds.length));
        var per = Math.max(1, Math.ceil(sq0.shipIds.length / li));
        var tl = sq0.trackLen || 0;
        var need = (per - 1) * sq0.spacing + 700;

        // 航迹只存站位用得到的那一段，并按 45 m 抽稀；回放里不需要毫米级精度
        var tk = null;
        if (sq0.track && sq0.track.length > 1) {
          tk = [];
          var prevS = null;
          for (var t = sq0.track.length - 1; t >= 0; t--) {
            var tp = sq0.track[t];
            if (tl - tp.s > need) break;
            if (prevS !== null && prevS - tp.s < 45) continue;
            tk.push([Math.round(tp.x), Math.round(tp.y), Math.round(tp.s)]);
            prevS = tp.s;
          }
          tk.reverse();
          if (tk.length < 2) tk = null;
        }

        f.squads.push({
          id: sq0.id,
          n: sq0.name,
          s: sq0.side,
          a: [Math.round(sq0.anchor.x), Math.round(sq0.anchor.y)],
          ax: Math.round(sq0.axis),
          co: Math.round(sq0.course),
          li: li,
          sp: sq0.spacing,
          lg: sq0.lineGap,
          tm: sq0.turnMode,
          tk: tk,
          tl: Math.round(tl),
          rt: (sq0.route || []).map(function (p) { return [Math.round(p.x), Math.round(p.y)]; }),
          sh: sq0.shipIds.slice()
        });
      }
    }

    this.frames.push(f);
    if (this.frames.length > this.maxFrames) this.frames.shift();
  };

  /* ==========================================================================
   *  回放
   * ========================================================================== */
  function Replay(recorder, scenario) {
    this.frames = recorder.frames;
    this.events = recorder.events;
    this.roster = recorder.roster;
    this.scenario = scenario;
    this.interval = recorder.interval;
    this.duration = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    this._idx = 0;

    // 预先建好舰艇外壳，回放时只更新坐标
    this._shells = {};
    for (var id in this.roster) {
      var r = this.roster[id];
      var cls = N.ShipClasses[r.clsId] || N.ShipClasses.fletcher;
      this._shells[id] = {
        id: id,
        side: r.side,
        name: r.name,
        cls: cls,
        clsId: r.clsId,
        group: r.group,
        pos: { x: 0, y: 0 },
        heading: 0,
        speed: 0,
        hull: 100, hullMax: 100,
        flood: 0, fire: 0,
        sinking: false, sunk: false, sinkTimer: 1,
        mounts: [],
        wake: [],
        trail: [],
        _replay: true,
        smokeScreen: false,
        engage: false,
        targetTrackId: null,
        _flash: -999
      };
    }
  }

  /** 找到 t 所在的帧区间 */
  Replay.prototype._find = function (t) {
    var f = this.frames;
    if (!f.length) return -1;
    if (f.length === 1) return 0;
    var i = this._idx;
    if (i > f.length - 1) i = f.length - 1;
    if (i < 0) i = 0;
    while (i > 0 && f[i].t > t) i--;
    // 用 <= ：时间正好落在某帧上时取那一帧，取到最后一帧也不越界
    while (i < f.length - 1 && f[i + 1].t <= t) i++;
    this._idx = i;
    return i;
  };

  Replay.prototype.frameAt = function (t) {
    var i = this._find(t);
    if (i < 0) return null;
    return this.frames[Math.min(i, this.frames.length - 1)];
  };

  /**
   * 生成 t 时刻的“世界快照”，结构与 World 兼容，可直接交给 Renderer 绘制。
   */
  Replay.prototype.sampleAt = function (t) {
    var f = this.frames;
    if (!f.length) return null;
    if (t < f[0].t) t = f[0].t;
    if (t > this.duration) t = this.duration;

    var i = this._find(t);
    var a = f[i];
    var b = f[Math.min(i + 1, f.length - 1)];
    var span = b.t - a.t;
    var k = span > 1e-6 ? U.clamp01((t - a.t) / span) : 0;

    var sc = this.scenario;
    var world = {
      time: t,
      env: sc.env,
      playerSide: sc.playerSide,
      bounds: N.MAP.bounds,
      showAllSides: true,
      replay: true,
      zones: (sc.zones || []).map(function (z) {
        return {
          id: z.id, name: z.name, kind: z.kind || 'objective',
          pos: { x: z.x, y: z.y }, r: z.r || 3000, side: z.side || null
        };
      }),
      shoreTargets: [],
      shore: [],
      illum: [],
      starshells: [],
      ships: [],
      torpedoes: [],
      splashes: [],
      smokes: [],
      tracks: { US: {}, JP: {} },
      playerReference: function () {
        for (var q = 0; q < world.ships.length; q++) {
          if (world.ships[q].side === world.playerSide && !world.ships[q].sunk) return world.ships[q].pos;
        }
        return { x: 0, y: 0 };
      }
    };

    /* ---- 舰艇（插值） ---- */
    var mapA = {}, mapB = {};
    var q;
    for (q = 0; q < a.ships.length; q++) mapA[a.ships[q].id] = a.ships[q];
    for (q = 0; q < b.ships.length; q++) mapB[b.ships[q].id] = b.ships[q];

    for (var id in this._shells) {
      var sa = mapA[id], sb = mapB[id] || sa;
      if (!sa) continue;
      var sh = this._shells[id];
      sh.pos.x = U.lerp(sa.x, sb.x, k);
      sh.pos.y = U.lerp(sa.y, sb.y, k);
      sh.heading = U.norm360(sa.h + U.angDiff(sb.h, sa.h) * k);
      sh.speed = U.lerp(sa.v, sb.v, k);
      sh.hull = sa.hp; sh.hullMax = 100;
      sh.flood = sa.fl;
      sh.fire = sa.fi;
      sh.sunk = sa.st === 2;
      sh.sinking = sa.st === 1;
      sh.sinkTimer = sh.sinking ? 1 : 1;
      // 回放里也要能看到“当时在下什么命令”
      sh.orderedHeading = sa.oh != null ? sa.oh : sh.heading;
      sh.orderedSpeed = sa.ov != null ? sa.ov : sh.speed;
      sh.engage = !!sa.en;
      sh.bombardTargetId = sa.bt || null;
      sh.targetTrackId = sa.tg || null;
      sh.moveTarget = sa.mt ? { x: sa.mt[0], y: sa.mt[1] } : null;
      world.ships.push(sh);
    }

    /* ---- 运动轨迹：最近 90 秒的航迹线 ---- */
    var trails = {};
    var span = 90;
    for (q = i; q >= 0; q--) {
      var fr = f[q];
      if (fr.t < t - span) break;
      for (var qq = 0; qq < fr.ships.length; qq++) {
        var sf = fr.ships[qq];
        if (!trails[sf.id]) trails[sf.id] = [];
        trails[sf.id].push({ x: sf.x, y: sf.y });
      }
    }
    for (q = 0; q < world.ships.length; q++) {
      var tsh = world.ships[q];
      var tl = trails[tsh.id];
      if (tl) { tl.reverse(); tl.push({ x: tsh.pos.x, y: tsh.pos.y }); }
      tsh.trail = tl || [];
    }

    /* ---- 玩家侧航迹 ---- */
    for (q = 0; q < a.tracks.length; q++) {
      var tr = a.tracks[q];
      var tt = b.tracks.filter(function (x) { return x.id === tr.id; })[0] || tr;
      world.tracks[sc.playerSide][tr.id] = {
        id: tr.id,
        side: sc.playerSide,
        pos: { x: U.lerp(tr.x, tt.x, k), y: U.lerp(tr.y, tt.y, k) },
        uncertainty: tr.u,
        idLevel: tr.l,
        course: tr.c,
        speed: tr.v,
        typeGuess: tr.tg,
        classGuess: tr.cg,
        nameGuess: tr.ng,
        misId: !!tr.mi,
        lastSeen: t - tr.a,
        firstSeen: 0,
        seenBy: null,
        fixes: [],
        source: 'visual'
      };
    }

    /* ---- 战列线：几何按帧插值，回放里照样能画出当时的队形 ---- */
    world.squads = [];
    var sqa = a.squads || [];
    var sqb = b.squads || {};
    var sqbMap = {};
    for (q = 0; q < sqb.length; q++) sqbMap[sqb[q].id] = sqb[q];
    for (q = 0; q < sqa.length; q++) {
      var sa = sqa[q];
      var sb = sqbMap[sa.id] || sa;
      world.squads.push({
        id: sa.id,
        name: sa.n,
        side: sa.s,
        anchor: {
          x: U.lerp(sa.a[0], sb.a[0], k),
          y: U.lerp(sa.a[1], sb.a[1], k)
        },
        axis: sa.ax,
        course: sa.co,
        lines: sa.li,
        spacing: sa.sp,
        lineGap: sa.lg,
        shipIds: sa.sh.slice(),
        turnMode: sa.tm || 'line',
        // 航迹只用来还原站位几何，直接取当帧的值，不做插值
        track: sa.tk ? sa.tk.map(function (p) { return { x: p[0], y: p[1], s: p[2] }; }) : [],
        trackLen: sa.tl || 0,
        route: (sa.rt || []).map(function (p) { return { x: p[0], y: p[1] }; }),
        offsets: null,
        order: null,
        goal: null,
        effSpeed: 0
      });
    }
    world.squadById = function (id) {
      for (var z = 0; z < world.squads.length; z++) {
        if (world.squads[z].id === id) return world.squads[z];
      }
      return null;
    };

    /* ---- 岸上目标（血量随时间变化） ---- */
    var defs = sc.shoreTargets || [];
    var prev = a.shore || [];
    var prevMap = {};
    for (q = 0; q < prev.length; q++) prevMap[prev[q].id] = prev[q];
    var curMap = {};
    var cur = b.shore || [];
    for (q = 0; q < cur.length; q++) curMap[cur[q].id] = cur[q];
    for (q = 0; q < defs.length; q++) {
      var d0 = defs[q];
      var pa = prevMap[d0.id] || { hp: d0.hp, d: 0 };
      var pb = curMap[d0.id] || pa;
      world.shoreTargets.push({
        id: d0.id, name: d0.name, kind: d0.kind || 'position',
        pos: { x: d0.x, y: d0.y },
        hp: Math.round(U.lerp(pa.hp, pb.hp, k)),
        maxHp: d0.hp,
        fire: 0,
        destroyed: !!pa.d
      });
    }

    /* ---- 鱼雷 / 水柱 / 烟幕 / 照明 ---- */
    var self2 = this;
    function ownerName(id) {
      var r = self2.roster[id];
      return r ? r.name : null;
    }
    for (q = 0; q < a.torps.length; q++) {
      var tp = a.torps[q];
      world.torpedoes.push({
        pos: { x: tp.x, y: tp.y },
        start: { x: tp.sx, y: tp.sy },
        heading: tp.h, side: tp.side, spotted: !!tp.sp, wake: 0.5,
        ownerId: tp.o || null,
        ownerName: ownerName(tp.o),
        speed: tp.v || 0,
        traveled: tp.d || 0
      });
    }
    for (q = 0; q < a.splashes.length; q++) {
      var sp = a.splashes[q];
      world.splashes.push({
        pos: { x: sp.x, y: sp.y }, r: sp.r, maxR: sp.r,
        side: sp.side, kind: sp.k, t: 0, life: 3,
        ownerId: sp.o || null,
        ownerName: ownerName(sp.o),
        cal: sp.c || 0
      });
    }
    for (q = 0; q < a.smokes.length; q++) {
      var sm = a.smokes[q];
      world.smokes.push({
        pos: { x: sm.x, y: sm.y }, radius: sm.r,
        born: t - 60, life: 210
      });
    }
    if (a.illum) {
      for (q = 0; q < a.illum.length; q++) {
        var il = a.illum[q];
        world.illum.push({
          pos: { x: il.x, y: il.y }, r: il.r,
          born: il.b || t, until: il.u || (t + 30), side: il.s || null
        });
      }
    }
    if (a.air) {
      for (q = 0; q < a.air.length; q++) {
        var ar = a.air[q];
        world.starshells.push({
          pos: { x: ar.x, y: ar.y },
          from: { x: ar.fx, y: ar.fy },
          burstT: ar.b, until: ar.u, side: ar.s,
          fireT: ar.b - 3.5
        });
      }
    }

    return world;
  };

  /** 时间轴上的重要事件 */
  Replay.prototype.marks = function () {
    var out = [];
    for (var i = 0; i < this.events.length; i++) {
      var e = this.events[i];
      if (e.mark || e.kind === 'critical' || e.kind === 'good') {
        out.push({ t: e.t, text: e.text, kind: e.kind });
      }
    }
    return out;
  };

  N.Recorder = Recorder;
  N.Replay = Replay;
})(globalThis.Naval = globalThis.Naval || {});
