/* =============================================================================
 *  main.js —— 启动、场景选择、输入、游戏循环、回放
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  /* ---------------------------------------------------------------- 游戏状态 */
  var game = {
    world: null,
    scenario: null,
    camera: null,
    renderer: null,
    hud: null,
    selected: new Set(),
    selectedTrackId: null,
    timeScale: 1,
    paused: true,
    showResultDone: false,
    mouseWorld: { x: 0, y: 0 },
    mouseScreen: { x: 0, y: 0 },
    bearingFrom: null,
    hoverShipId: null,

    /* 回放 */
    mode: 'live',          // 'live' | 'replay'
    replay: null,
    replayT: 0,
    replayPlaying: true,
    replaySpeed: 2,
    replayAuto: true,
    overlayBack: null,
    debug: false
  };
  N.game = game;

  /* ---------------------------------------------------------------- 初始化 */
  function init() {
    window.addEventListener('error', function (e) {
      try {
        document.body.setAttribute('data-js-error',
          (e.message || 'error') + ' @' + (e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
      } catch (err) { /* ignore */ }
    });

    game.camera = new N.Camera();
    game.renderer = new N.Renderer(document.getElementById('sea'));
    game.hud = new N.HUD(game);
    if (game.hud.bindSquadControls) game.hud.bindSquadControls(game);
    if (game.hud.bindSplitter) game.hud.bindSplitter(game);

    // 标题画面 / 历史战役线 / 新手引导
    game.chapter = null;
    if (N.Screens) {
      N.Screens.init(game);
      N.Screens.onFree = function () { openScenarioSelect(function () { N.Screens.showTitle(); }); };
      N.Screens.onTutorial = function () { startTutorial(); };
      N.Screens.onStartScenario = function (sc, chapter) { startScenario(sc, chapter); };
    }
    if (N.Tutorial) N.Tutorial.init(game);

    var list = N.Scenarios.available();
    if (!list.length) {
      document.body.innerHTML = '<p style="padding:40px;color:#fff">没有可玩场景</p>';
      return;
    }
    game.scenario = list[0];

    var q = '';
    try { q = (window.location && window.location.search) || ''; } catch (e) { q = ''; }
    var auto = /[?&]autostart=1/.test(q);
    game.debug = /[?&]debug=1/.test(q);
    var m = /[?&]speed=(\d+(?:\.\d+)?)/.exec(q);
    var sid = /[?&]scenario=([\w_]+)/.exec(q);
    if (sid) {
      var picked = N.Scenarios.get(sid[1]);
      if (picked && picked.available) game.scenario = picked;
    }

    if (auto) {
      if (N.Screens) N.Screens.hideTitle();
      startScenario(game.scenario);
      if (m) setTimeScale(parseFloat(m[1]));
      if (/[?&]menu=1/.test(q)) {
        var adv = /[?&]advance=(\d+)/.exec(q);
        if (adv) {
          for (var ai2 = 0; ai2 < parseInt(adv[1], 10); ai2++) game.world.update(0.1);
        }
        openPauseMenu();
        if (/[?&]help=1/.test(q)) game.hud.showHelp(function () { openPauseMenu(); });
        if (/[?&]select=1/.test(q)) openScenarioSelect(function () { openPauseMenu(); });
      }
    } else if (/[?&]campaign=1/.test(q)) {
      // 调试：直接开战役线
      N.Screens.openCampaign();
    } else if (/[?&]tutorial=1/.test(q)) {
      // 调试：直接进新手引导
      N.Screens.hideTitle();
      startTutorial();
    } else {
      // 先给标题画面 —— 玩家选了才进游戏
      if (N.Screens) N.Screens.showTitle();
    }

    bindInput();
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- 开局 */
  function startScenario(scenario, chapter) {
    game.chapter = chapter || null;
    game.scenario = scenario;
    game.world = new N.World(scenario, { seed: (Date.now() & 0x7fffffff) });
    game.selected.clear();
    game.selectedTrackId = null;
    game.showResultDone = false;
    game.torpAttempts = 0;
    game.overlayBack = null;
    game.hud.hideOverlay();
    if (N.Screens) N.Screens.hideTitle();
    game.timeScale = 1;
    game.paused = false;
    game.mode = 'live';
    game.replay = null;
    document.body.classList.remove('replay-mode');
    game.hud.hideReplayBar();
    game.hud.resetLog();
    updateTimeButtons();

    // 镜头对准我方编队，并把近处的任务区域纳入画面
    var ships = game.world.shipsOf(game.world.playerSide).filter(function (s) { return !s.sunk; });
    var cx = 0, cy = 0;
    ships.forEach(function (s) { cx += s.pos.x; cy += s.pos.y; });
    if (ships.length) { cx /= ships.length; cy /= ships.length; }

    var pts = ships.map(function (s) { return s.pos; });
    (game.world.shoreTargets || []).forEach(function (t) {
      if (V.dist(t.pos, { x: cx, y: cy }) < 16000) pts.push(t.pos);
    });
    (game.world.zones || []).forEach(function (z) {
      if (V.dist(z.pos, { x: cx, y: cy }) < 16000) pts.push(z.pos);
    });
    frameArea(pts, 1.4, 6000, 0.14);

    var flag = ships.filter(function (s) { return s.role === 'flagship'; })[0] || ships[0];
    if (flag) game.selected.add(flag.id);

    // 调试：?advance=600 直接推进仿真
    var q2 = '';
    try { q2 = (window.location && window.location.search) || ''; } catch (e) { q2 = ''; }

    // 调试：?squad=4 把前 4 艘可指挥舰编成小队，可选 &sqcourse=90&sqline=1
    var sqm = /[?&]squad=(\d+)/.exec(q2);
    if (sqm && N.Squad) {
      var want = Math.max(2, Math.min(6, parseInt(sqm[1], 10)));
      var pool = game.world.shipsOf(game.world.playerSide).filter(function (s) {
        return !s.sunk && s.isPlayerControlled !== false && s.cls.type !== 'AK';
      }).slice(0, want);
      if (pool.length >= 2) {
        var lq = /[?&]sqline=(\d)/.exec(q2);
        var tq = /[?&]sqturn=(\w+)/.exec(q2);
        var sq = N.Squad.create(game.world, pool.map(function (s) { return s.id; }), {
          lines: lq ? parseInt(lq[1], 10) : 1,
          turnMode: tq && tq[1] === 'together' ? 'together' : 'line'
        });
        // ?sqlanes=4,2 直接把各线摆成指定长度（截图 / 验证不等长队形）
        var lnq = /[?&]sqlanes=([\d,]+)/.exec(q2);
        if (sq && lnq && N.Squad.setLanes) {
          var want2 = lnq[1].split(',').map(function (x) { return parseInt(x, 10); })
            .filter(function (x) { return x > 0; });
          if (want2.length && want2.reduce(function (a, b) { return a + b; }, 0) === sq.shipIds.length) {
            var flat = sq.shipIds.slice(), lanes2 = [], p2 = 0;
            for (var w2 = 0; w2 < want2.length; w2++) {
              lanes2.push(flat.slice(p2, p2 + want2[w2]));
              p2 += want2[w2];
            }
            N.Squad.setLanes(game.world, sq, lanes2);
          }
        }
        var cq = /[?&]sqcourse=(\d+)/.exec(q2);
        if (sq && cq) N.Squad.issueCourse(game.world, sq, parseInt(cq[1], 10), sq.turnMode, true);
        // ?sqroute=x1,y1;x2,y2 直接给一条航线（截图 / 验证用）
        var rq = /[?&]sqroute=([-\d.,;]+)/.exec(q2);
        if (sq && rq) {
          var pts = rq[1].split(';').map(function (seg) {
            var ab = seg.split(',');
            return { x: parseFloat(ab[0]), y: parseFloat(ab[1]) };
          }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
          if (pts.length) N.Squad.issueRoute(game.world, sq, pts, true);
        }
      }
    }

    var adv = /[?&]advance=(\d+)/.exec(q2);
    if (adv) {
      var secs = parseInt(adv[1], 10);
      var n = Math.min(30000, Math.round(secs / SIM_DT));
      for (var i2 = 0; i2 < n; i2++) {
        game.world.update(SIM_DT);
        if (game.world.ended) break;
      }
      fitView(game.world, 1.6);
    }

    // 调试：?pick=1 选中己方第 1 艘舰（截图 / 验证右侧详情面板用）
    var pkq = /[?&]pick=(\d+)/.exec(q2);
    if (pkq) {
      var pkPool = game.world.shipsOf(game.world.playerSide).filter(function (s) {
        return !s.sunk && s.isPlayerControlled !== false;
      });
      var pk = pkPool[Math.max(0, Math.min(pkPool.length - 1, parseInt(pkq[1], 10) - 1))];
      if (pk) { game.selected.clear(); game.selected.add(pk.id); }
    }

    // 调试：?replay=1 直接进入回放
    if (/[?&]replay=1/.test(q2)) {
      game.enterReplay();
      var rt = /[?&]rt=(\d+)/.exec(q2);
      if (rt) game.replaySeek(parseInt(rt[1], 10));
    }

    // 调试：?cam=x,y 直接把镜头放到指定海区（配合 ?zoom= 截图用）
    // 必须放在 ?replay=1 之后：进回放时的自动跟随会把镜头和缩放都改掉
    var cm = /[?&]cam=(-?\d+),(-?\d+)/.exec(q2);
    if (cm) {
      game.camera.x = parseInt(cm[1], 10);
      game.camera.y = parseInt(cm[2], 10);
      game.replayAuto = false;
    }

    // 调试：?zoom=0.12 直接设定缩放
    var zm = /[?&]zoom=([\d.]+)/.exec(q2);
    if (zm) {
      game.camera.zoom = U.clamp(parseFloat(zm[1]), game.camera.minZoom, game.camera.maxZoom);
      game.replayAuto = false;          // 指定了缩放就别让自动跟随覆盖掉
    }

    // 调试：?ss=1 立刻打一发照明弹并推进到爆燃（截图 / 验证用）
    if (/[?&]ss=1/.test(q2)) {
      var sss = game.world.shipsOf(game.world.playerSide).filter(function (s) { return s.starshells > 0; })[0];
      if (sss) {
        game.world.fireStarshell(sss, Geo.dest(sss.pos, sss.heading + 30, 6000));
        for (var k2 = 0; k2 < 45; k2++) game.world.update(SIM_DT);
      }
    }

    game.hud.toast('战斗开始 · 右键海图下达航向命令');
  }

  /* ---------------------------------------------------------------- 视野 */
  /** 画布上没有被 HUD 面板遮挡的区域 */
  function usableView() {
    var W = game.renderer.W, H = game.renderer.H;
    var iw = (typeof window !== 'undefined' && window.innerWidth) || 1600;
    var left = 234, right = 308, top = 56, bottom = 152;
    if (iw <= 900) { left = 0; right = 240; bottom = 0; }
    else if (iw <= 1180) { left = 190; right = 268; }
    if (W < left + right + 320) { left = Math.min(left, Math.round(W * 0.18)); right = Math.min(right, Math.round(W * 0.22)); }
    if (H < top + bottom + 260) bottom = Math.min(bottom, Math.round(H * 0.16));
    return { x: left, y: top, w: Math.max(240, W - left - right), h: Math.max(180, H - top - bottom) };
  }

  /** 把一组世界坐标点框进可用区域 */
  function frameArea(pts, pad, minSpan, maxZoom) {
    if (!pts || pts.length === 0) return;
    pad = pad || 1.45;
    minSpan = minSpan || 5000;
    var minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x;
      if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y;
      if (p.y > maxy) maxy = p.y;
    });
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    var spanW = Math.max(minSpan, maxx - minx) * pad;
    var spanH = Math.max(minSpan, maxy - miny) * pad;
    var u = usableView();
    var z = Math.min(u.w / spanW, u.h / spanH);
    game.camera.zoom = U.clamp(z, game.camera.minZoom, maxZoom || 0.2);

    var W = game.renderer.W, H = game.renderer.H;
    var ucx = u.x + u.w / 2, ucy = u.y + u.h / 2;
    game.camera.x = cx - (ucx - W / 2) / game.camera.zoom;
    game.camera.y = cy + (ucy - H / 2) / game.camera.zoom;
    game.camera.clampTo(N.MAP.bounds);
  }

  function fitView(world, pad) {
    var pts = [];
    world.shipsOf(world.playerSide).forEach(function (s) { if (!s.sunk) pts.push(s.pos); });
    if (world.zones) world.zones.forEach(function (z) { pts.push(z.pos); });
    if (world.shoreTargets) world.shoreTargets.forEach(function (t) { if (!t.destroyed) pts.push(t.pos); });
    N.Sensors.trackList(world, world.playerSide).forEach(function (t) { pts.push(t.pos); });
    if (pts.length < 2) return;
    frameArea(pts, pad || 1.5, 6000, 0.25);
  }
  N.fitView = fitView;

  /* ---------------------------------------------------------------- 选择 */
  game.selectedShips = function () {
    if (!game.world) return [];
    var out = [];
    game.selected.forEach(function (id) {
      var s = game.world.shipById(id);
      if (s && !s.sunk) out.push(s);
    });
    return out;
  };

  game.selectShip = function (id, additive) {
    if (!game.world) return;
    var s = game.world.shipById(id);
    if (!s || s.sunk) return;
    if (!additive) game.selected.clear();
    if (game.selected.has(id)) game.selected.delete(id);
    else game.selected.add(id);
    if (game.selected.size === 0) game.selected.add(id);
    game.selectedTrackId = null;
  };

  game.clearSelection = function () {
    game.selected.clear();
    game.selectedTrackId = null;
  };

  game.selectTrack = function (trackId) {
    game.selectedTrackId = trackId;
    var ships = game.selectedShips();
    if (ships.length && trackId) {
      ships.forEach(function (s) {
        s.targetTrackId = trackId;
        s.bombardTargetId = null;
        s.autoTarget = false;
        var tr = N.Sensors.track(game.world, game.world.playerSide, trackId);
        if (tr && V.dist(s.pos, tr.pos) < s.gunRangeMax) {
          s.engage = true;
          s.playerFireOrder = true;
        }
      });
      var tr = N.Sensors.track(game.world, game.world.playerSide, trackId);
      if (tr) game.hud.toast('目标指定：' + N.Sensors.idText(tr));
    }
  };

  /** 指定岸上目标（点击岸上目标） */
  game.selectShoreTarget = function (targetId) {
    var ships = commandable();
    if (!ships.length) return;
    var t = game.world.shoreTargetById(targetId);
    if (!t) return;
    if (t.destroyed) { game.hud.toast('该目标已被摧毁', 'warn'); return; }
    ships.forEach(function (s) {
      s.bombardTargetId = targetId;
      s.targetTrackId = null;
      s.engage = false;
    });
    game.hud.toast('炮击目标：' + t.name);
  };

  /* ---------------------------------------------------------------- 指令 */
  /** 只保留玩家能指挥的舰艇（运输船 / 受创撤退舰由 AI 驾驶） */
  function commandable() {
    var all = game.selectedShips();
    var ok = all.filter(function (s) { return s.isPlayerControlled !== false; });
    if (all.length && ok.length === 0) {
      game.hud.toast('该舰由舰长自行驾驶，无法直接指挥', 'warn');
    } else if (ok.length < all.length) {
      game.hud.toast('已忽略 ' + (all.length - ok.length) + ' 艘不受指挥的舰艇', 'warn');
    }
    return ok;
  }

  /**
   * 把一次命令的下发结果说人话。
   * 视距内是旗语灯光，几秒就到；视距外走无线电，几十秒，还可能丢。
   */
  function orderFeedback(world, results) {
    var sent = 0, lost = 0, vis = 0, maxD = 0, why = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i] || {};
      if (r.ok) { sent++; if (r.visual) vis++; maxD = Math.max(maxD, r.delay || 0); }
      else if (r.lost) lost++;
      else why = r.reason;
    }
    if (!sent && !lost) {
      if (why === 'to-radio') return { text: '命令发不出去：对方电台已被摧毁', kind: 'warn' };
      if (why === 'from-radio') return { text: '命令发不出去：旗舰电台已被摧毁', kind: 'warn' };
      if (why === 'command-down') return { text: '指挥中断，命令无人接收', kind: 'warn' };
      return { text: '命令无法下达', kind: 'warn' };
    }
    if (lost && !sent) return { text: '无线电里全丢了，没有一艘舰收到', kind: 'warn' };
    var t = vis === sent
      ? '旗语已传递（约 ' + Math.round(maxD) + ' 秒）'
      : '无线电已发出（约 ' + Math.round(maxD) + ' 秒，' + Math.round(100 - sent / results.length * 100) + '% 可能收不到）';
    if (lost) t += ' · ' + lost + ' 艘命令丢失';
    return { text: t, kind: lost ? 'warn' : undefined };
  }

  game.orderSpeed = function (frac) {
    // 选中了小队：改的是整条战列线的航速
    var sq = game.primarySquad();
    if (sq && N.Squad) {
      var base = 99;
      sq.shipIds.forEach(function (id) {
        var s = game.world.shipById(id);
        if (s && !s.sunk) base = Math.min(base, s.effectiveMaxSpeed());
      });
      if (base > 90) return;
      var spd = Math.round(base * frac);
      N.Squad.setFormation(game.world, sq, { speed: spd });
      game.hud.toast(sq.name + ' 航速 ' + spd + ' 节（全队）');
      return;
    }

    var ships = commandable();
    if (!ships.length) return;
    var res = ships.map(function (s) {
      var spd = s.cls.maxSpeed * frac;
      return game.world.issueOrder(s, undefined, spd);
    });
    var fb = orderFeedback(game.world, res);
    game.hud.toast('航速 ' + Math.round(frac * 100) + '% · ' + fb.text, fb.kind);
  };

  game.orderMove = function (worldPos, append) {
    var ships = commandable();
    if (!ships.length) return;

    // 点到岛上就取最近的水面，别让舰队一头撞进陆地
    var goal = worldPos, corrected = false;
    if (game.world.isLand(worldPos.x, worldPos.y)) {
      var wet = game.world.nearestWater(worldPos.x, worldPos.y, 12000);
      if (wet) {
        goal = { x: wet.x, y: wet.y };
        corrected = true;
      }
    }

    /* 选中了小队：命令下给战列线，而不是一艘一艘下 */
    var sq = game.primarySquad();
    if (sq && N.Squad) {
      if (game.squadOrderMode === 'course') {
        var h = Geo.bearing(sq.anchor, goal);
        N.Squad.issueCourse(game.world, sq, h, sq.turnMode, true);
        game.hud.toast('战列线方向 ' + Math.round(h) + '°（' +
          (sq.turnMode === 'line' ? '依次转向' : '同转') + '）· 传递约 2-3 秒');
      } else {
        N.Squad.issueMove(game.world, sq, goal, !!append, true);
        var n = (sq.route || []).length;
        game.hud.toast((append ? '航路点 ' + n + ' 已追加 ' : '战列线移动至 ') +
          Math.round(goal.x) + ', ' + Math.round(goal.y) +
          (corrected ? '（已修正到海面）' : '') +
          (n > 1 ? ' · 共 ' + n + ' 个航路点，沿航线开进' : ' · 沿移动线开进'));
      }
      return;
    }

    var cx = 0, cy = 0;
    ships.forEach(function (s) { cx += s.pos.x; cy += s.pos.y; });
    cx /= ships.length; cy /= ships.length;

    var res = ships.map(function (s) {
      var tx = goal.x + (s.pos.x - cx);
      var ty = goal.y + (s.pos.y - cy);
      var hdg = Geo.bearing(s.pos, { x: tx, y: ty });
      var spd = s.orderedSpeed > 1 ? s.orderedSpeed : s.cls.cruiseSpeed;
      s.moveTarget = { x: tx, y: ty };
      return game.world.issueOrder(s, hdg, spd);
    });
    var fb = orderFeedback(game.world, res);
    game.hud.toast((corrected ? '该处是陆地，已修正到最近海面 · ' : '') +
      '航向 ' + Math.round(Geo.bearing(ships[0].pos, goal)) + '° · ' + fb.text,
      corrected ? 'warn' : fb.kind);
  };

  /* ------------------------------------------------------------ 小队/战列线 */

  /** 当前选中舰艇涉及的小队（去重） */
  game.selectedSquads = function () {
    var out = [], seen = {};
    game.selectedShips().forEach(function (s) {
      var sq = game.world ? game.world.squadOf(s) : null;
      if (sq && !seen[sq.id]) { seen[sq.id] = 1; out.push(sq); }
    });
    return out;
  };

  /** 下达编队命令时优先作用于哪支小队 */
  game.primarySquad = function () {
    var list = game.selectedSquads();
    return list.length ? list[0] : null;
  };

  game.squadOrderMode = 'move';     // 'move' 战列线移动 / 'course' 战列线方向

  game.setSquadOrderMode = function (mode) {
    game.squadOrderMode = mode === 'course' ? 'course' : 'move';
    if (game.hud.syncSquadControls) game.hud.syncSquadControls(game);
    game.hud.toast(mode === 'course'
      ? '右键＝战列线方向（只改航向，不设终点）'
      : '右键＝战列线移动（给航路点；Shift+右键追加航路点）');
  };

  /** 编队 / 解散（对选中舰艇） */
  game.formSquad = function () {
    if (!game.world || !N.Squad) return;
    var ships = game.selectedShips().filter(function (s) {
      return s.isPlayerControlled !== false;
    });
    if (!ships.length) { game.hud.toast('先选中几艘舰', 'warn'); return; }
    if (ships.length < 2) { game.hud.toast('至少选中 2 艘舰才能编队（Shift+点击加选）', 'warn'); return; }

    var sq0 = game.world.squadOf(ships[0]);
    var allSame = sq0 && ships.every(function (s) { return s.squadId === sq0.id; });

    // 已经全在同一小队里：再按一次就是解散 / 移出
    if (allSame) {
      if (ships.length === sq0.shipIds.length) {
        N.Squad.remove(game.world, sq0);
        game.hud.toast('小队已解散');
      } else {
        ships.forEach(function (s) { N.Squad.detach(game.world, sq0, s.id); });
        game.hud.toast(ships.length + ' 艘舰已移出小队');
      }
      return;
    }

    // 先脱离原来的小队，避免一艘舰挂在两个队里
    ships.forEach(function (s) {
      var old = game.world.squadOf(s);
      if (old) N.Squad.detach(game.world, old, s.id);
    });

    var sq = N.Squad.create(game.world, ships.map(function (s) { return s.id; }), {
      lines: game.squadLines || 1,
      turnMode: game.squadTurnMode || 'line'
    });
    if (sq) {
      game.hud.toast('已编成 ' + sq.name + '：' + ships.length + ' 艘 · ' +
        N.Squad.lineCountOf(sq) + ' 条战列线');
    }
  };

  game.squadLines = 1;
  game.setSquadLines = function (n) {
    game.squadLines = U.clamp(Math.round(n), 1, 3);
    if (game.hud.syncSquadControls) game.hud.syncSquadControls(game);
    var sq = game.primarySquad();
    if (sq) {
      N.Squad.setFormation(game.world, sq, { lines: game.squadLines });
      game.hud.toast(sq.name + '：' + N.Squad.lineCountOf(sq) + ' 条战列线');
    } else {
      game.hud.toast('新建小队时排 ' + game.squadLines + ' 条战列线');
    }
  };

  game.squadTurnMode = 'line';
  game.setSquadTurnMode = function (mode) {
    game.squadTurnMode = mode === 'together' ? 'together' : 'line';
    if (game.hud.syncSquadControls) game.hud.syncSquadControls(game);
    var sq = game.primarySquad();
    if (sq) {
      N.Squad.setFormation(game.world, sq, { turnMode: game.squadTurnMode });
      game.hud.toast(game.squadTurnMode === 'line'
        ? '依次转向：后舰沿前舰的航迹跟转，转弯半径一样（仍是纵队）'
        : '同转：所有舰同时转向，纵队会拉开成横队');
    } else {
      game.hud.toast(game.squadTurnMode === 'line' ? '默认依次转向' : '默认同转');
    }
  };

  game.toggleSquadTurnMode = function () {
    game.setSquadTurnMode(game.squadTurnMode === 'line' ? 'together' : 'line');
  };

  /** 清空航路：停船原地待命 */
  game.clearSquadRoute = function () {
    var sq = game.primarySquad();
    if (!sq) { game.hud.toast('先选中一支小队', 'warn'); return; }
    sq.route = [];
    sq.goal = null;
    sq.order = null;
    sq.speed = 0;
    game.hud.toast(sq.name + '：航路已清空，原地待命');
  };

  game.setSquadSpacing = function (kind) {
    var sq = game.primarySquad();
    if (!sq) { game.hud.toast('先选中一支小队', 'warn'); return; }
    var v = kind === 'wide' ? { spacing: 1400, lineGap: 2200 }
      : kind === 'tight' ? { spacing: 600, lineGap: 900 }
        : { spacing: 900, lineGap: 1500 };
    N.Squad.setFormation(game.world, sq, v);
    game.hud.toast('间距 ' + v.spacing + ' m / 线距 ' + v.lineGap + ' m');
  };

  game.toggleEngage = function () {
    var ships = commandable();
    if (!ships.length) return;
    var any = ships.some(function (s) { return !s.engage; });
    ships.forEach(function (s) {
      s.autoTarget = false;
      s.bombardTargetId = null;
      if (!s.targetTrackId) {
        var tr = N.AI.pickTarget(game.world, s);
        if (tr) s.targetTrackId = tr.id;
      }
      s.engage = any && !!s.targetTrackId;
      s.playerFireOrder = s.engage;
    });
    game.hud.toast(any ? '开火' : '停火');
  };

  game.launchTorpedoes = function () {
    var ships = commandable();
    if (!ships.length) return;
    // 选中的舰里有没有鱼雷发射管（美军重巡/轻巡没有，只有驱逐舰有）
    var hasTubes = false;
    ships.forEach(function (s) { if (s.torps && s.torps.length) hasTubes = true; });
    if (hasTubes) game.torpAttempts = (game.torpAttempts || 0) + 1;
    var anyFired = false, blocked = false;
    ships.forEach(function (s) {
      var tr = s.targetTrackId ? N.Sensors.track(game.world, game.world.playerSide, s.targetTrackId) : null;
      if (!tr) { blocked = true; return; }
      for (var i = 0; i < s.torps.length; i++) {
        var m = s.torps[i];
        if (m.disabled || m.loaded <= 0) continue;
        var n = Math.min(m.loaded, 4);
        var fired = N.Combat.launchTorpedoes(game.world, s, m, tr.pos, tr.course, tr.speed, n, 1.8);
        if (fired > 0) {
          anyFired = true;
          game.hud.toast(s.name + ' 发射 ' + fired + ' 条鱼雷');
        } else if (fired === -1) blocked = true;
      }
    });
    if (!anyFired && blocked) game.hud.toast('无法发射：舷侧未对准或发射管装填中', 'warn');
  };

  game.toggleSmoke = function () {
    var ships = commandable();
    if (!ships.length) return;
    var on = ships.some(function (s) { return !s.smokeScreen; });
    ships.forEach(function (s) { s.smokeScreen = on; s.smokeTimer = 0; });
    game.hud.toast(on ? '施放烟幕' : '停止施放烟幕');
  };

  game.fireStarshell = function () {
    var ships = commandable();
    if (!ships.length) return;
    var light = game.world.env.light;
    if (light === 'day') {
      game.hud.toast('白昼能见度良好，不需要照明弹', 'warn');
      return;
    }
    var n = 0, why = null;
    ships.forEach(function (s) {
      var r = game.world.fireStarshell(s, game.mouseWorld);
      if (r === null) n++;
      else if (why === null) why = r;
    });
    if (n) {
      game.hud.toast('照明弹已发射 · 3.5 秒后爆燃，照亮半径 4.2 km');
    } else if (why === 'empty') {
      game.hud.toast('照明弹已用尽', 'warn');
    } else if (why === 'cooldown') {
      game.hud.toast('照明弹装填中（25 秒）', 'warn');
    }
  };

  /* ---------------------------------------------------------------- 时间 */
  function setTimeScale(v) {
    game.timeScale = v;
    game.paused = (v === 0);
    updateTimeButtons();
  }
  N.setTimeScale = setTimeScale;

  function updateTimeButtons() {
    var btns = document.querySelectorAll('.tbtn[data-scale]');
    for (var i = 0; i < btns.length; i++) {
      var v = parseFloat(btns[i].dataset.scale);
      var on = game.paused ? v === 0 : Math.abs(v - game.timeScale) < 0.01;
      btns[i].classList.toggle('active', on);
    }
    var pb = document.getElementById('btnPause');
    if (pb) pb.textContent = game.paused ? '▶ 继续' : '❚❚ 暂停';
  }

  /* ---------------------------------------------------------------- 菜单 */
  /** 打开任务选择；onBack 存在时给一个“返回”出口 */
  function openScenarioSelect(onBack) {
    game.overlayBack = onBack || null;
    game.hud.showScenarioSelect(N.Scenarios.available(), game.scenario.id, function (sc) {
      game.scenario = sc;
      game.overlayBack = onBack || null;
      game.hud.showBriefing(sc, function () { startScenario(sc); }, '进入战位', onBack);
    }, onBack);
  }

  /** 暂停菜单：战斗中的万能出口（继续 / 重开 / 换任务 / 回放 / 帮助） */
  function openPauseMenu() {
    if (!game.world || game.mode === 'replay') return;
    if (game.hud.isOverlayOpen()) return;
    game.paused = true;
    updateTimeButtons();

    function resume() {
      if (game.world && !game.world.ended) {
        game.paused = false;
        updateTimeButtons();
      }
    }
    game.overlayBack = resume;

    game.hud.showPauseMenu(game.world, {
      onResume: resume,
      onRestart: function () { startScenario(game.scenario); },
      onSelect: function () {
        openScenarioSelect(function () { openPauseMenu(); });
      },
      onReplay: function () { game.enterReplay(); },
      onHome: function () {
        game.hud.hideOverlay();
        game.paused = true;
        updateTimeButtons();
        if (N.Screens) N.Screens.showTitle();
      },
      onHelp: function () {
        game.overlayBack = function () { openPauseMenu(); };
        game.hud.showHelp(function () { openPauseMenu(); });
      }
    });
  }

  /* ---------------------------------------------------------------- 新手引导 */
  /** 用一个比较平静的场景练手；先把战斗推进到双方刚接触，否则雷达上什么都没有 */
  function startTutorial() {
    var sc = N.Scenarios.get('day_surface_action');
    if (!sc) {
      var all = N.Scenarios.available();
      sc = all[0];
    }
    if (!sc) return;
    startScenario(sc, null);

    // 白昼水面炮战开局双方相距约 15 km，按 1× 要 5 分钟才互相发现。
    // 引导不能让人干等，所以直接把仿真推到刚接触的那一刻（接触时间由探测距离决定，是确定的）。
    if (game.world && !game.world.ended) {
      for (var i = 0; i < 3060 && !game.world.ended; i++) game.world.update(0.1);
    }

    if (N.Tutorial) {
      N.Tutorial.start();
      game.hud.toast('训练开始 · 侦察已经发现敌方编队', 'info');
    }
  }

  /* ---------------------------------------------------------------- 回放 */
  /** 结算界面：胜利/失败 + 目标达成 + 战报 + 三个出口 */
  function showResultPanel(world) {
    game.paused = true;
    updateTimeButtons();
    game.overlayBack = null;

    // 战役线：记通关 + 结算页追加战后史实 + 「下一场」
    var extra = {
      home: function () {
        game.paused = true;
        updateTimeButtons();
        if (N.Screens) N.Screens.showTitle();
      }
    };
    var chapter = game.chapter;
    if (chapter && N.Campaign) {
      var rr = (world.summary().result || {}).result;
      N.Campaign.markCleared(chapter.id, rr);
      if (N.Screens) {
        N.Screens.refreshProgress();
        extra.html = N.Screens.aftermathHtml(chapter, world);
        extra.buttons = [N.Screens.aftermathButtons(chapter, function (next) {
          N.Screens.openChapter(next);
        })];
      }
    }

    game.hud.showResult(world, function () {
      startScenario(game.scenario, chapter);
    }, function () {
      openScenarioSelect(function () { showResultPanel(world); });
    }, function () {
      game.enterReplay();
    }, extra);
  }

  game.enterReplay = function () {
    var w = game.world;
    if (!w || !w.recorder || w.recorder.frames.length < 2) {
      game.hud.toast('录像太短，无法回放', 'warn');
      return;
    }
    game.mode = 'replay';
    game.replay = new N.Replay(w.recorder, game.scenario);
    game.replayT = 0;
    game.replayPlaying = true;
    game.replaySpeed = 2;
    game.replayAuto = true;
    game.paused = true;
    game.selected.clear();
    game.selectedTrackId = null;
    game.bearingFrom = null;
    document.body.classList.add('replay-mode');
    game.hud.showReplayBar(game.replay, !!(w.ended));
    game.hud.hideOverlay();
    game.overlayBack = null;
    game.hud.toast('回放：双方真实舰位 · 空格播放/暂停');

    // 镜头跟住开场时的双方编队
    var pw0 = game.replay.sampleAt(0);
    if (pw0) followReplay(pw0, true);
  };

  game.exitReplay = function () {
    game.mode = 'live';
    game.replay = null;
    document.body.classList.remove('replay-mode');
    game.hud.hideReplayBar();

    var ended = !!(game.world && game.world.ended);
    game.paused = ended;
    updateTimeButtons();

    if (ended) {
      // 战斗已经结束：退出回放必须回到结算界面，否则玩家会卡在最后一帧无路可走
      showResultPanel(game.world);
      game.hud.toast('已退出回放 · 可以再来一局或换个任务');
    } else {
      game.hud.toast('已退出回放');
    }
  };

  game.replaySeek = function (t) {
    if (!game.replay) return;
    game.replayT = U.clamp(t, 0, game.replay.duration);
  };

  game.replayToggle = function () {
    if (!game.replay) return;
    if (game.replayT >= game.replay.duration - 0.05) game.replayT = 0;
    game.replayPlaying = !game.replayPlaying;
    game.hud.updateReplayBar(game.replay, game.replayT, game.replayPlaying, game.replayAuto);
  };

  game.replaySetSpeed = function (v) {
    game.replaySpeed = v;
    game.hud.updateReplayBar(game.replay, game.replayT, game.replayPlaying, game.replayAuto);
  };

  /* ---------------------------------------------------------------- 输入 */
  function bindInput() {
    var canvas = document.getElementById('sea');
    var drag = null;

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    canvas.addEventListener('mousedown', function (e) {
      if (game.mode === 'replay') {
        drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: game.camera.x, cy: game.camera.y, moved: false };
        return;
      }
      if (e.button === 2) {
        var p = game.camera.s2w({ x: e.clientX, y: e.clientY }, game.renderer.W, game.renderer.H);
        game.orderMove(p, e.shiftKey);
        return;
      }
      if (e.button === 1) {
        drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: game.camera.x, cy: game.camera.y, moved: false };
        e.preventDefault();
        return;
      }
      drag = {
        mode: 'select', sx: e.clientX, sy: e.clientY,
        cx: game.camera.x, cy: game.camera.y, moved: false
      };
    });

    canvas.addEventListener('mousemove', function (e) {
      var W = game.renderer.W, H = game.renderer.H;
      game.mouseScreen.x = e.clientX;
      game.mouseScreen.y = e.clientY;
      game.mouseWorld = game.camera.s2w({ x: e.clientX, y: e.clientY }, W, H);

      if (drag) {
        var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          game.camera.x = drag.cx - dx / game.camera.zoom;
          game.camera.y = drag.cy + dy / game.camera.zoom;
          if (game.world) game.camera.clampTo(game.world.bounds);
          if (game.mode === 'replay') game.replayAuto = false;
        }
      }
    });

    window.addEventListener('mouseup', function (e) {
      if (!drag) return;
      var wasClick = !drag.moved && drag.mode === 'select';
      drag = null;
      if (!wasClick || e.button !== 0) return;
      if (game.mode === 'replay') return;
      handleClick(e.clientX, e.clientY, e.shiftKey);
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
      game.camera.zoomAt({ x: e.clientX, y: e.clientY }, factor, game.renderer.W, game.renderer.H);
      if (game.world) game.camera.clampTo(game.world.bounds);
      if (game.mode === 'replay') game.replayAuto = false;
    }, { passive: false });

    canvas.addEventListener('dblclick', function (e) {
      if (game.mode === 'replay') return;
      var s = pickShipAt(e.clientX, e.clientY);
      if (s) { game.camera.x = s.pos.x; game.camera.y = s.pos.y; }
    });

    window.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      var k = e.key.toLowerCase();

      // 标题画面上不响应游戏内按键
      if (N.Screens && N.Screens.isTitleVisible()) return;

      // 弹窗挡住游戏时，只允许 Esc 关闭当前弹窗
      if (game.hud.isOverlayOpen()) {
        if (k === 'escape' && game.overlayBack) {
          e.preventDefault();
          var back = game.overlayBack;
          game.overlayBack = null;
          game.hud.hideOverlay();
          back();
        }
        return;
      }

      if (game.mode === 'replay') {
        if (k === ' ') { e.preventDefault(); game.replayToggle(); return; }
        if (k === 'escape') { game.exitReplay(); return; }
        if (k === 'arrowleft' || k === 'a') { game.replaySeek(game.replayT - 10); return; }
        if (k === 'arrowright' || k === 'd') { game.replaySeek(game.replayT + 10); return; }
      }

      if (k === ' ') { e.preventDefault(); setTimeScale(game.paused ? (game.timeScale || 1) : 0); return; }
      if (k === '1') { setTimeScale(1); return; }
      if (k === '2') { setTimeScale(2); return; }
      if (k === '3') { setTimeScale(5); return; }
      if (k === '4') { setTimeScale(10); return; }
      if (k === 'f') { game.toggleEngage(); return; }
      if (k === 't') { game.launchTorpedoes(); return; }
      if (k === 's') { game.toggleSmoke(); return; }
      if (k === 'l') { game.fireStarshell(); return; }
      if (k === 'g') { game.formSquad(); return; }
      if (k === 'h') { game.toggleSquadTurnMode(); return; }
    if (k === 'k') { game.clearSquadRoute(); return; }
      if (k === 'j') {
        game.setSquadOrderMode(game.squadOrderMode === 'move' ? 'course' : 'move');
        return;
      }
      if (k === 'r') { game.enterReplay(); return; }
      if (k === 'escape') { e.preventDefault(); openPauseMenu(); return; }
      if (k === 'q' || k === 'home') {
        if (game.world) { fitView(game.world, 1.6); game.hud.toast('视野已全览'); }
        return;
      }
      if (k === 'tab') {
        e.preventDefault();
        cycleSelection(e.shiftKey ? -1 : 1);
        return;
      }
      if (k === 'arrowleft' || k === 'a') { game.camera.x -= 300 / game.camera.zoom * 0.35; return; }
      if (k === 'arrowright' || k === 'd') { game.camera.x += 300 / game.camera.zoom * 0.35; return; }
      if (k === 'arrowup' || k === 'w') { game.camera.y += 300 / game.camera.zoom * 0.35; return; }
      if (k === 'arrowdown') { game.camera.y -= 300 / game.camera.zoom * 0.35; return; }
    });

    document.querySelectorAll('.tbtn[data-scale]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseFloat(b.dataset.scale);
        if (v === 0) { setTimeScale(game.paused ? (game.timeScale || 1) : 0); return; }
        setTimeScale(v);
      });
    });

    document.getElementById('btnBrief').addEventListener('click', function () {
      if (!game.world || game.mode === 'replay') return;
      if (game.hud.isOverlayOpen()) return;
      game.paused = true;
      updateTimeButtons();
      function back() {
        if (game.world && !game.world.ended) {
          game.paused = false;
          updateTimeButtons();
        }
      }
      game.overlayBack = back;
      game.hud.showBriefing(game.scenario, function () {
        game.paused = false;
        updateTimeButtons();
      }, '进入战位', back);
    });

    document.getElementById('btnHelp').addEventListener('click', function () {
      if (game.mode === 'replay' || !game.world) {
        game.hud.showHelp();
        return;
      }
      if (game.hud.isOverlayOpen()) return;
      game.paused = true;
      updateTimeButtons();
      function back() {
        if (game.world && !game.world.ended) {
          game.paused = false;
          updateTimeButtons();
        }
      }
      game.overlayBack = back;
      game.hud.showHelp(back);
    });

    var btnMenu = document.getElementById('btnMenu');
    if (btnMenu) {
      btnMenu.addEventListener('click', function () {
        if (game.mode === 'replay') { game.exitReplay(); return; }
        openPauseMenu();
      });
    }

    var btnFit = document.getElementById('btnFit');
    if (btnFit) {
      btnFit.addEventListener('click', function () {
        if (!game.world) return;
        if (game.mode === 'replay') {
          game.camera.zoom = 0.03;
          return;
        }
        fitView(game.world, 1.6);
        game.hud.toast('视野已全览');
      });
    }

    var btnReplay = document.getElementById('btnReplay');
    if (btnReplay) {
      btnReplay.addEventListener('click', function () {
        if (game.mode === 'replay') game.exitReplay();
        else game.enterReplay();
      });
    }
  }

  function cycleSelection(dir) {
    if (!game.world) return;
    var ships = game.world.shipsOf(game.world.playerSide).filter(function (s) { return !s.sunk; });
    if (!ships.length) return;
    var cur = null;
    game.selected.forEach(function (id) { if (cur === null) cur = id; });
    var idx = -1;
    for (var i = 0; i < ships.length; i++) if (ships[i].id === cur) idx = i;
    idx = (idx + dir + ships.length) % ships.length;
    game.selected.clear();
    game.selected.add(ships[idx].id);
    game.camera.x = ships[idx].pos.x;
    game.camera.y = ships[idx].pos.y;
  }

  /* ------------------------------------------------------------ 点选判定 */
  function pickShipAt(sx, sy) {
    if (!game.world) return null;
    var W = game.renderer.W, H = game.renderer.H;
    var best = null, bestD = 1e9;
    var ships = game.world.shipsOf(game.world.playerSide);
    for (var i = 0; i < ships.length; i++) {
      var s = ships[i];
      if (s.sunk) continue;
      var pp = (N.Command && !game.world.replay) ? N.Command.plotPos(game.world, s) : s.pos;
      var p = game.camera.w2s(pp, W, H);
      var d = Math.sqrt((p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy));
      var r = Math.max(16, s.cls.length * game.camera.zoom * 0.6 + 6);
      if (d < r && d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  function pickTrackAt(sx, sy) {
    if (!game.world) return null;
    var W = game.renderer.W, H = game.renderer.H;
    var list = N.Sensors.trackList(game.world, game.world.playerSide);
    var best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      var p = game.camera.w2s(tr.pos, W, H);
      var d = Math.sqrt((p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy));
      var r = Math.max(18, tr.uncertainty * game.camera.zoom + 8);
      if (d < r && d < bestD) { best = tr; bestD = d; }
    }
    return best;
  }

  function pickShoreTargetAt(sx, sy) {
    if (!game.world || !game.world.shoreTargets.length) return null;
    var W = game.renderer.W, H = game.renderer.H;
    for (var i = 0; i < game.world.shoreTargets.length; i++) {
      var t = game.world.shoreTargets[i];
      var p = game.camera.w2s(t.pos, W, H);
      if (Math.abs(p.x - sx) < 16 && Math.abs(p.y - sy) < 16) return t;
    }
    return null;
  }

  function handleClick(sx, sy, shift) {
    // 岸上目标优先（用于下达炮击命令）
    var st = pickShoreTargetAt(sx, sy);
    if (st && game.selected.size) {
      game.selectShoreTarget(st.id);
      return;
    }

    var ship = pickShipAt(sx, sy);
    if (ship) {
      game.selectShip(ship.id, shift);
      return;
    }
    var tr = pickTrackAt(sx, sy);
    if (tr) {
      game.selectTrack(tr.id);
      return;
    }
    if (!st && !shift) game.clearSelection();
  }

  /* ---------------------------------------------------------------- 主循环 */
  var lastTime = 0;
  var SIM_DT = 0.1;
  var simAcc = 0;

  function frame(now) {
    if (!lastTime) lastTime = now;
    var dtReal = Math.min(0.12, (now - lastTime) / 1000);
    lastTime = now;

    if (game.mode === 'replay') {
      frameReplay(dtReal);
      requestAnimationFrame(frame);
      return;
    }

    var world = game.world;
    if (world && !game.paused && !world.ended) {
      simAcc = Math.min(simAcc + dtReal * game.timeScale, 6);
      var steps = Math.min(600, Math.floor(simAcc / SIM_DT));
      if (steps > 0) {
        simAcc -= steps * SIM_DT;
        for (var i = 0; i < steps; i++) {
          world.update(SIM_DT);
          if (world.ended) break;
        }
      }
    } else {
      simAcc = 0;
    }

    if (world) {
      // 新手引导：看世界状态判断这一步做到没有
      if (N.Tutorial && N.Tutorial.isActive()) N.Tutorial.update(dtReal);

      // 到达移动目标点后停车
      for (var k = 0; k < world.ships.length; k++) {
        var s = world.ships[k];
        if (s.moveTarget && V.dist(s.pos, s.moveTarget) < 700) {
          s.orderedSpeed = 0;
          s.moveTarget = null;
        }
      }

      updateBearingFrom(world);
      game.renderer.draw(world, {
        camera: game.camera,
        selected: game.selected,
        selectedTrackId: game.selectedTrackId,
        worldTime: world.time,
        mouseWorld: game.mouseWorld,
        bearingFrom: game.bearingFrom
      });
      game.hud.update(world, dtReal);

      if (game.debug) dumpDebug(world);

      if (world.ended && !game.showResultDone) {
        game.showResultDone = true;
        game.paused = true;
        updateTimeButtons();
        setTimeout(function () { showResultPanel(world); }, 900);
      }
    } else {
      var dummy = dummyWorld();
      game.renderer.draw(dummy, {
        camera: game.camera,
        selected: game.selected,
        selectedTrackId: null,
        worldTime: 0,
        mouseWorld: null,
        bearingFrom: null
      });
    }

    requestAnimationFrame(frame);
  }

  function frameReplay(dtReal) {
    var rp = game.replay;
    if (!rp) { game.exitReplay(); return; }

    if (game.replayPlaying) {
      game.replayT += dtReal * game.replaySpeed;
      if (game.replayT >= rp.duration) {
        game.replayT = rp.duration;
        game.replayPlaying = false;
      }
    }

    var pw = rp.sampleAt(game.replayT);
    if (pw) {
      if (game.replayAuto) followReplay(pw);
      game.hud.setReplaySides(pw.ships, pw.playerSide);
      game.renderer.draw(pw, {
        camera: game.camera,
        selected: game.selected,
        selectedTrackId: null,
        worldTime: game.replayT,
        mouseWorld: game.mouseWorld,
        bearingFrom: null
      });
    }
    game.hud.updateReplayBar(rp, game.replayT, game.replayPlaying, game.replayAuto);
    if (game.debug && pw) dumpDebug(pw);
  }

  /**
   * 回放镜头：跟随当前仍在海面上的舰艇，保持一个能看清舰体的缩放。
   * 玩家一旦自己拖动 / 缩放，就停止跟随（replayAuto = false）。
   */
  function followReplay(pw, snap) {
    var pts = [];
    var minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12;
    for (var i = 0; i < pw.ships.length; i++) {
      var s = pw.ships[i];
      if (s.sunk) continue;
      pts.push(s.pos);
      if (s.pos.x < minx) minx = s.pos.x;
      if (s.pos.x > maxx) maxx = s.pos.x;
      if (s.pos.y < miny) miny = s.pos.y;
      if (s.pos.y > maxy) maxy = s.pos.y;
    }
    if (!pts.length) return;

    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    var u = usableView();
    var spanW = Math.max(9000, maxx - minx) * 1.5;
    var spanH = Math.max(7000, maxy - miny) * 1.5;
    var z = U.clamp(Math.min(u.w / spanW, u.h / spanH), 0.035, 0.22);

    var W = game.renderer.W, H = game.renderer.H;
    var ucx = u.x + u.w / 2, ucy = u.y + u.h / 2;
    var tx = cx - (ucx - W / 2) / z;
    var ty = cy + (ucy - H / 2) / z;

    // 平滑跟随，避免镜头跳动
    var k = snap ? 1 : 0.10;
    game.camera.x += (tx - game.camera.x) * k;
    game.camera.y += (ty - game.camera.y) * k;
    game.camera.zoom += (z - game.camera.zoom) * k;
    game.camera.clampTo(N.MAP.bounds);
  }

  /* ------------------------------------------------------- 调试信息（?debug=1） */
  function dumpDebug(world) {
    try {
      var W = game.renderer.W, H = game.renderer.H;
      var proj = function (p) {
        var s = game.camera.w2s(p, W, H);
        return { x: Math.round(s.x), y: Math.round(s.y) };
      };
      var d = {
        mode: game.mode,
        zoom: +game.camera.zoom.toFixed(4),
        cam: [Math.round(game.camera.x), Math.round(game.camera.y)],
        canvas: [W, H],
        t: Math.round(world.time),
        ships: (typeof world.shipsOf === 'function'
          ? world.shipsOf(world.playerSide)
          : world.ships.filter(function (s) { return s.side === world.playerSide; })
        ).map(function (s) {
          return { n: s.name, s: proj(s.pos), h: Math.round(s.heading) };
        }),
        tracks: N.Sensors.trackList(world, world.playerSide).map(function (t) {
          return { n: N.Sensors.idText(t), s: proj(t.pos) };
        }),
        zones: (world.zones || []).map(function (z) {
          return { n: z.name, s: proj(z.pos), r: Math.round(z.r * game.camera.zoom) };
        }),
        shore: (world.shoreTargets || []).map(function (t) {
          return { n: t.name, s: proj(t.pos), hp: Math.round(t.hp) };
        }),
        illum: (world.illum || []).map(function (i) { return proj(i.pos); }),
        squads: (world.squads || []).map(function (sq) {
          return {
            n: sq.name, s: proj(sq.anchor),
            ax: Math.round(sq.axis), co: Math.round(sq.course),
            li: N.Squad ? N.Squad.lineCountOf(sq) : sq.lines,
            k: sq.shipIds.length,
            ai: sq.aiTakeover ? 1 : 0,
            why: sq.aiWhy || null,
            err: sq.shipIds.map(function (id, i) {
              var sh = world.shipById(id);
              if (!sh || !N.Squad) return -1;
              return Math.round(V.dist(sh.pos, N.Squad.stationOf(sq, i).pos));
            })
          };
        }),
        cmd: (N.Command ? (function () {
          var st = N.Command.statusOf(world, world.playerSide);
          return {
            flag: st.flagshipName, on: st.online ? 1 : 0, down: Math.round(st.down),
            loss: st.lossPct, radio: st.radioOk ? 1 : 0, iff: st.iffOk ? 1 : 0,
            age: (typeof world.shipsOf === 'function' ? world.shipsOf(world.playerSide) : [])
              .map(function (sh) {
                var v = N.Command.ownView(world, sh);
                return v ? Math.round(world.time - (v.reportedAt || 0)) : -1;
              })
          };
        })() : null)
      };

      // 顶栏排版自检：按钮挤爆或换行都会在这里暴露
      try {
        var tb = document.getElementById('topbar');
        if (tb) {
          var right = tb.querySelector('.tb-right');
          d.topbar = {
            w: tb.clientWidth,
            scrollW: tb.scrollWidth,
            overflow: tb.scrollWidth > tb.clientWidth + 1,
            rightW: right ? right.getBoundingClientRect().width : 0,
            h: tb.clientHeight
          };
        }
        d.pauseLabel = (document.getElementById('btnPause') || {}).textContent || '';
        d.hasMenuBtn = !!document.getElementById('btnMenu');
        d.posRead = (document.getElementById('posRead') || {}).textContent || '';
        d.area = N.MAP.describe ? N.MAP.describe(game.camera.x, game.camera.y) : null;
      } catch (e2) { /* ignore */ }

      document.body.setAttribute('data-debug', JSON.stringify(d));
    } catch (e) { /* ignore */ }
  }

  /** 方位读数的参考点：所选舰艇的中心 */
  function updateBearingFrom(world) {
    var ships = game.selectedShips();
    if (!ships.length) { game.bearingFrom = null; return; }
    var x = 0, y = 0;
    ships.forEach(function (s) { x += s.pos.x; y += s.pos.y; });
    game.bearingFrom = { x: x / ships.length, y: y / ships.length };
  }

  /* 单机模式下的空世界 */
  var _dummy = null;
  function dummyWorld() {
    if (!_dummy) {
      _dummy = {
        env: game.scenario.env,
        ships: [], smokes: [], splashes: [], torpedoes: [], tracks: { US: {}, JP: {} },
        zones: [], shoreTargets: [], illum: [],
        playerSide: game.scenario.playerSide,
        time: 0,
        playerReference: function () { return { x: 0, y: 0 }; }
      };
    }
    return _dummy;
  }

  /* ---------------------------------------------------------------- 启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(globalThis.Naval = globalThis.Naval || {});
