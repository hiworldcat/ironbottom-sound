/* =============================================================================
 *  view/hud.js —— DOM 界面：编队列表、舰艇详情、战报、接触列表、简报/结算
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  function $(id) { return document.getElementById(id); }

  /** 舷角文字：右 045° / 左 030° / 正前 / 正后 */
  function relText(rel) {
    var a = Math.round(Math.abs(rel));
    if (a < 2) return '正前';
    if (a > 178) return '正后';
    return (rel > 0 ? '右 ' : '左 ') + (a < 10 ? '00' + a : (a < 100 ? '0' + a : a)) + '°';
  }

  function HUD(game) {
    this.game = game;
    this.el = {
      clock: $('clock'),
      missionTitle: $('missionTitle'),
      missionSub: $('missionSub'),
      envVis: $('envVis'),
      envWind: $('envWind'),
      envMoon: $('envMoon'),
      posRead: $('posRead'),
      rosterList: $('rosterList'),
      rosterCount: $('rosterCount'),
      squadList: $('squadList'),
      squadCount: $('squadCount'),
      btnSquad: $('btnSquad'),
      forcePower: $('forcePower'),
      forcePowerBar: $('forcePowerBar'),
    cmdFlag: $('cmdFlag'), cmdLink: $('cmdLink'), cmdRadio: $('cmdRadio'),
    cmdIff: $('cmdIff'), cmdLossBar: $('cmdLossBar'),
      detailEmpty: $('detailEmpty'),
      detailBody: $('detailBody'),
      dName: $('dName'),
      dClass: $('dClass'),
      barHull: $('barHull'), txtHull: $('txtHull'),
      barFlood: $('barFlood'), txtFlood: $('txtFlood'),
      barFire: $('barFire'), txtFire: $('txtFire'),
      barZonePower: $('barZonePower'), txtZonePower: $('txtZonePower'),
      barZoneWeapons: $('barZoneWeapons'), txtZoneWeapons: $('txtZoneWeapons'),
      barZoneSuper: $('barZoneSuper'), txtZoneSuper: $('txtZoneSuper'),
      barZoneComms: $('barZoneComms'), txtZoneComms: $('txtZoneComms'),
      dStatus: $('dStatus'),
      dSpeed: $('dSpeed'), dHeading: $('dHeading'), dOrder: $('dOrder'),
      dRelBrg: $('dRelBrg'), dTargetBrg: $('dTargetBrg'), dBombard: $('dBombard'),
      dStarshell: $('dStarshell'),
      hdgDial: $('hdgDial'),
      objectiveList: $('objectiveList'),
      btnStarshell: $('btnStarshell'),
      dTarget: $('dTarget'), dRange: $('dRange'), dFire: $('dFire'), dSpot: $('dSpot'),
      mountList: $('mountList'), torpList: $('torpList'), torpSection: $('torpSection'),
      torpNote: $('torpNote'),
      btnEngage: $('btnEngage'), btnTorp: $('btnTorp'), btnSmoke: $('btnSmoke'),
      speedBtns: $('speedBtns'),
      log: $('log'), logCount: $('logCount'),
      contacts: $('contacts'), contactCount: $('contactCount'),
      toast: $('toast'),
      replayBar: $('replayBar'), rbPlay: $('rbPlay'), rbSeek: $('rbSeek'),
      rbClock: $('rbClock'), rbMarks: $('rbMarks'), rbExit: $('rbExit'),
      rbFollow: $('rbFollow'), rbSides: $('rbSides'),
      overlay: $('overlay'), modal: $('modal'), modalTag: $('modalTag'),
      modalTitle: $('modalTitle'), modalSub: $('modalSub'),
      modalBody: $('modalBody'), modalFoot: $('modalFoot')
    };
    this._acc = 999;   // 首帧立即渲染一次
    this._lastMsgId = 0;
    this._toastTimer = null;
    this._rosterKey = '';
    this.bind();
  }

  /* ------------------------------------------------------------------ 绑定 */
  HUD.prototype.bind = function () {
    var self = this;
    var g = this.game;

    // 速度按钮
    this.el.speedBtns.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var frac = parseFloat(b.dataset.spd);
      g.orderSpeed(frac);
    });

    // 详情面板按钮
    this.el.btnEngage.addEventListener('click', function () { g.toggleEngage(); });
    this.el.btnTorp.addEventListener('click', function () { g.launchTorpedoes(); });
    this.el.btnSmoke.addEventListener('click', function () { g.toggleSmoke(); });
    if (this.el.btnStarshell) {
      this.el.btnStarshell.addEventListener('click', function () { g.fireStarshell(); });
    }
    $('dClose').addEventListener('click', function () { g.clearSelection(); });

    /* 回放控制条 */
    this.el.rbPlay.addEventListener('click', function () { g.replayToggle(); });
    this.el.rbSeek.addEventListener('input', function () {
      g.replaySeek(parseFloat(self.el.rbSeek.value));
    });
    this.el.rbExit.addEventListener('click', function () { g.exitReplay(); });
    if (this.el.rbFollow) {
      this.el.rbFollow.addEventListener('click', function () {
        g.replayAuto = !g.replayAuto;
        this.classList.toggle('active', g.replayAuto);
        if (g.replayAuto) g.hud.toast('镜头跟随已开启');
      });
    }
    document.querySelectorAll('.rb-speed button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.rb-speed button').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        g.replaySetSpeed(parseFloat(b.dataset.rspd));
      });
    });

    // 编队列表
    this.el.rosterList.addEventListener('click', function (e) {
      var card = e.target.closest('.ship-card');
      if (!card || card.dataset.sunk === '1') return;
      g.selectShip(card.dataset.id, e.shiftKey);
    });

    // 接触列表
    this.el.contacts.addEventListener('click', function (e) {
      var item = e.target.closest('.contact-item');
      if (!item) return;
      g.selectTrack(item.dataset.id);
    });
  };

  /* ------------------------------------------------------------------ 更新 */
  HUD.prototype.update = function (world, dt) {
    if (!world) return;
    var sc = world.scenario;
    this.el.clock.textContent = N.U.formatClock(sc.startTime + world.time);
    this.el.missionTitle.textContent = sc.title;
    var chap = this.game && this.game.chapter;
    if (chap && N.Campaign) {
      var ci = N.Campaign.chapters().indexOf(chap);
      this.el.missionSub.textContent = '第 ' + (ci + 1) + ' 章 · ' + chap.name + ' · ' + sc.date;
    } else {
      this.el.missionSub.textContent = sc.subtitle + ' · ' + sc.date;
    }

    /* ---- 气象条：能见度 / 风 / 海况 / 月光，全是活的 ---- */
    var wx = world.weather;
    if (wx && N.Weather) {
      var arrow = wx.trend > 0 ? ' ↑' : (wx.trend < 0 ? ' ↓' : '');
      this.el.envVis.textContent = '能见度 ' + (wx.visibility / 1000).toFixed(1) + ' km' + arrow;
      this.el.envVis.className = 'env-chip' + (wx.visibility < 6000 ? ' bad' : (wx.visibility < 10000 ? ' warn' : ''));
      this.el.envWind.textContent = N.Weather.windName(wx.windDir) + ' ' +
        Math.round(wx.windSpeed) + ' kn · ' + N.Weather.seaName(wx.seaState);
      this.el.envWind.className = 'env-chip' + (wx.seaState >= 5 ? ' warn' : '');
      if (this.el.envMoon) {
        var showMoon = wx.light !== 'day';
        this.el.envMoon.style.display = showMoon ? '' : 'none';
        if (showMoon) {
          this.el.envMoon.textContent = N.Weather.moonName(wx.moon) + ' ' +
            Math.round(N.Weather.moonEff(wx) * 100) + '%';
          this.el.envMoon.className = 'env-chip' + (N.Weather.moonEff(wx) < 0.15 ? ' warn' : '');
        }
      }
      var tip = N.Weather.brief(world) +
        '\n雷达作用距离 ×' + N.Weather.radarFactor(world).toFixed(2) +
        '，无线电丢包 +' + Math.round(N.Weather.radioExtra(world) * 100) + '%';
      if (this.el.envVis.title !== tip) {
        this.el.envVis.title = tip;
        this.el.envWind.title = tip;
        if (this.el.envMoon) this.el.envMoon.title = tip;
      }
    } else {
      this.el.envVis.textContent = '能见度 ' + (world.env.visibility / 1000).toFixed(1) + ' km';
      this.el.envWind.textContent = '风 ' + Math.round(world.env.windDir) + '° / ' + world.env.windSpeed + ' kn';
    }

    // 视野中心在哪片海：拖图的时候一直跟着变
    if (this.el.posRead && N.MAP.describe) {
      var cam = this.game && this.game.camera;
      if (cam) {
        var here = N.MAP.describe(cam.x, cam.y);
        if (here.text !== this._posText) {
          this._posText = here.text;
          this.el.posRead.textContent = here.text;
        }
      }
    }

    this.el.logCount.textContent = '共 ' + world.messages.length + ' 条';

    this.appendLog(world);

    this._acc += dt;
    if (this._acc >= 0.18) {
      this._acc = 0;
      this.renderRoster(world);
      this.renderObjectives(world);
      this.renderDetail(world);
      this.renderContacts(world);
      this.renderSquads(world);
      this.renderCommand(world);
    }
  };

  /* ---------------------------------------------------------- 小队/战列线 */
  /**
   * 队形缩略图：每一列是一条战列线，列内从上到下是前到后。
   * 橙色那颗是领舰（队形基准）。玩家改「线数 / 间距」时这张图会立刻变。
   */
  HUD.prototype.formationHtml = function (d) {
    var lines = Math.max(1, d.lines);
    var counts = d.lineCounts || [];
    var cols = '';
    for (var l = 0; l < lines; l++) {
      var n = counts[l] || 0;
      var dots = '';
      for (var s2 = 0; s2 < n; s2++) {
        var lead = (l === 0 && s2 === 0);
        dots += '<i class="sq-dot' + (lead ? ' lead' : '') + '"></i>';
      }
      cols += '<span class="sq-col">' + dots + '</span>';
    }
    var names = d.lineShips || [];
    var tip = lines + ' 条战列线（' + counts.join('+') + ' 艘）';
    for (var l2 = 0; l2 < names.length; l2++) {
      tip += '\n第 ' + l2 + ' 线：' + names[l2].join('、');
    }
    tip += '\n间距 ' + Math.round(d.spacing) + ' m · 线距 ' + Math.round(d.lineGap) + ' m';
    tip += '\n橙色是领舰（第 0 线队首），队形以它为基准';
    return '<span class="sq-form" title="' + tip + '">' + cols + '</span>';
  };

  /**
   * 可编辑的队形盘：每个格子里写舰名，点两艘舰交换站位。
   * 网格按「行 = 线上第几个、列 = 第几线」排，所以格子顺序就是站位顺序。
   */
  /**
   * 可编辑的队形盘：网格的**列 = 战列线，行 = 线上第几个**，每格写舰名。
   * 各列长度可以不等（4+2、5+2+2 都行）—— 这才叫自由编队。
   * 点两艘舰 = 交换站位；点一艘舰再点上方线号 = 把它挪到那条线的末尾。
   */
  HUD.prototype.formationEditor = function (d) {
    var lanes = d.lanes || [];
    var L = Math.max(1, lanes.length);
    var rows = 1, i;
    for (i = 0; i < lanes.length; i++) rows = Math.max(rows, lanes[i].length);
    var pick = (this._pick && this._pick.sqId === d.id) ? this._pick : null;

    // 线号表头：选中一艘舰以后可以点这里，把它挪到那条线
    var head = '<div class="sq-fe-head" style="grid-template-columns:repeat(' + L + ',1fr)">';
    for (i = 0; i < L; i++) {
      var cnt = lanes[i] ? lanes[i].length : 0;
      head += '<button type="button" class="sq-fe-lane' + (pick ? ' can' : '') +
        '" data-lane="' + i + '" title="把选中的舰挪到第 ' + i + ' 线末尾（现在 ' +
        cnt + ' 艘）">' + (i === 0 ? '基准' : '第 ' + i + ' 线') +
        '<i>' + cnt + '</i></button>';
    }
    head += '</div>';

    // 格子按行优先铺，空位留占位符保持对齐
    var cells = '';
    for (var r = 0; r < rows; r++) {
      for (var l = 0; l < L; l++) {
        var sl = lanes[l] && lanes[l][r];
        if (!sl) { cells += '<span class="sq-cell empty"></span>'; continue; }
        var on = pick && pick.index === sl.index;
        cells += '<button type="button" class="sq-cell' + (sl.lead ? ' lead' : '') +
          (on ? ' picked' : '') + '" data-i="' + sl.index + '"' +
          ' title="' + sl.name + ' · ' + sl.type + ' · 第 ' + l + ' 线第 ' + (r + 1) + ' 位">' +
          (sl.lead ? '★' : '') + sl.name + '</button>';
      }
    }

    var hint;
    if (pick) {
      var pn = null;
      for (i = 0; i < d.slots.length; i++) {
        if (d.slots[i].index === pick.index) pn = d.slots[i].name;
      }
      hint = '已选「' + (pn || '?') + '」：再点一艘交换，或点上方线号挪过去';
    } else {
      hint = '点两艘舰交换站位；点一艘再点线号，把它挪到那条线';
    }

    return '<div class="sq-fe">' + head +
      '<div class="sq-fe-grid" style="grid-template-columns:repeat(' + L + ',1fr)">' +
      cells + '</div>' +
      '<div class="sq-fe-hint">' + hint + '</div>' +
      '</div>';
  };

  HUD.prototype.renderSquads = function (world) {
    var box = this.el.squadList;
    if (!box) return;
    var list = (world.squads || []).filter(function (sq) {
      return sq.side === world.playerSide;
    });

    this.el.squadCount.textContent = list.length ? list.length + ' 支' : '0';

    if (!list.length) {
      if (this._sqKey !== 'empty') {
        this._sqKey = 'empty';
        box.innerHTML = '<div class="sq-empty">Shift+点击选中多艘舰，按 <kbd>G</kbd> 编成小队</div>';
      }
      return;
    }

    var self = this;
    var active = this.game.primarySquad ? this.game.primarySquad() : null;
    var key = list.map(function (sq) {
      var d = N.Squad.describe(sq, world);
      return d.id + ':' + d.count + ':' + d.lines + ':' + (d.lineCounts || []).join('+') +
        ':' + (d.slots || []).map(function (x) { return x.id; }).join(',') +
        ':' + Math.round(d.spacing) + ':' + d.course + ':' + d.axis +
        ':' + d.speed + ':' + d.turnMode + ':' + d.waypoints + ':' +
        ':' + (d.pending ? 1 : 0) + ':' + (active && active.id === sq.id ? 1 : 0);
    }).join('|');
    if (key === this._sqKey) return;
    this._sqKey = key;

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var sq = list[i];
      var d = N.Squad.describe(sq, world);
      var mode = d.turnMode === 'line' ? '依次' : '同转';
      var flag = d.pending ? '·传递中'
        : d.waypoints ? '·航路 ' + d.waypoints
          : (Math.abs(d.axis - d.course) > 4 ? '·轴 ' + d.axis + '°' : '');
      html += '<div class="sq-item' + (active && active.id === sq.id ? ' active' : '') +
        '" data-id="' + sq.id + '">' +
        '<div class="sq-top">' +
        this.formationHtml(d) +
        '<span class="sq-name">' + d.name + '</span>' +
        '<span class="sq-mode">' + mode + flag + '</span>' +
        '</div>' +
        '<div class="sq-bot">' +
        '<span class="sq-meta">' + d.count + '艘 · ' +
        (d.turnMode === 'line'
          ? (d.lines + '线' + (d.lines > 1 ? '(' + (d.lineCounts || []).join('+') + ')' : ''))
          : '同转·不保持队形') +
        ' · ' + d.course + '° ' + d.speed + 'kn</span>' +
        '<span class="sq-gap">间' + Math.round(d.spacing) + '</span>' +
        '</div>' +
        this.formationEditor(d) +
        '</div>';
    }
    box.innerHTML = html;

    var items = box.querySelectorAll('.sq-item');
    for (var k = 0; k < items.length; k++) {
      items[k].addEventListener('click', function () {
        var sq = world.squadById(this.dataset.id);
        if (!sq) return;
        self.game.selected.clear();
        sq.shipIds.forEach(function (id) { self.game.selected.add(id); });
        self.game.selectedTrackId = null;
      });
    }

    // 站位格子：点第一艘选中，点第二艘交换
    var cells = box.querySelectorAll('.sq-cell[data-i]');
    for (var c = 0; c < cells.length; c++) {
      cells[c].addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var sq = self._squadOfCell(this, world);
        if (!sq) return;
        // 点哪支小队就选中哪支，面板上的「线数 / 间距」跟着切过去
        self.game.selected.clear();
        sq.shipIds.forEach(function (id) { self.game.selected.add(id); });
        self.game.selectedTrackId = null;
        var idx = parseInt(this.dataset.i, 10);

        if (!self._pick || self._pick.sqId !== sq.id) {
          self._pick = { sqId: sq.id, index: idx };
        } else if (self._pick.index === idx) {
          self._pick = null;                       // 再点一次取消
        } else {
          var a = self._pick.index, b = idx;
          var na = sq.shipIds[a], nb = sq.shipIds[b];
          self._pick = null;
          if (N.Squad.swapStations(world, sq, a, b)) {
            var sa = world.shipById(na), sb2 = world.shipById(nb);
            self.toast('已交换站位：' + (sa ? sa.name : '?') + ' ↔ ' + (sb2 ? sb2.name : '?'));
          }
        }
        self._sqKey = '';                          // 强制重画
        self.renderSquads(world);
      });
    }

    // 线号表头：把选中的舰挪到这条线的末尾（这就是 4+2 怎么来的）
    var heads = box.querySelectorAll('.sq-fe-lane');
    for (var h = 0; h < heads.length; h++) {
      heads[h].addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var sq = self._squadOfCell(this, world);
        if (!sq) return;
        var lane = parseInt(this.dataset.lane, 10);
        if (!self._pick || self._pick.sqId !== sq.id) {
          self.toast('先点一艘舰，再点线号把它挪过去');
          return;
        }
        var idx = self._pick.index;
        var ship = null;
        for (var q = 0; q < sq.shipIds.length; q++) {
          if (sq.assign[q] && q === idx) ship = world.shipById(sq.shipIds[q]);
        }
        self._pick = null;
        if (N.Squad.moveToLane(world, sq, idx, lane)) {
          self.toast('已把 ' + (ship ? ship.name : '该舰') + ' 挪到第 ' + lane + ' 线末尾');
        } else {
          self.toast('挪不了：每条线至少要留一艘（想减线请用「线数」）', 'warn');
        }
        self._sqKey = '';
        self.renderSquads(world);
      });
    }
  };

  /** 从任意一个格子/表头往上找它属于哪支小队 */
  HUD.prototype._squadOfCell = function (el, world) {
    var node = el;
    while (node && !(node.dataset && node.dataset.id)) node = node.parentNode;
    if (!node || !node.dataset) return null;
    return world.squadById(node.dataset.id);
  };

  /** 把小队面板上的按钮接到 game 上 */
  HUD.prototype.bindSquadControls = function (game) {
    var self = this;
    function group(attr, fn) {
      var btns = document.querySelectorAll('.sq-b[data-' + attr + ']');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var btns2 = document.querySelectorAll('.sq-b[data-' + attr + ']');
          for (var j = 0; j < btns2.length; j++) btns2[j].classList.remove('on');
          this.classList.add('on');
          fn(this.dataset[attr]);
        });
      }
    }
    group('lines', function (v) { game.setSquadLines(parseInt(v, 10)); });
    group('turn', function (v) { game.setSquadTurnMode(v); });
    group('sp', function (v) { game.setSquadSpacing(v); });
    group('mode', function (v) { game.setSquadOrderMode(v); });

    if (this.el.btnSquad) {
      this.el.btnSquad.addEventListener('click', function () { game.formSquad(); });
    }
  };

  /**
   * 左栏「舰艇列表 / 小队面板」之间的分隔条。
   *
   *  两块都是**可伸缩**的：它们用 `flex: <grow> 1 0` 分掉左栏剩下的高度，
   *  分隔条只改 grow 的比例 —— 所以拖动是真正在改「展示区域」的大小，
   *  不是把某一块的像素高度写死。窗口变大变小，两边还是按同一个比例分。
   *  双击分隔条恢复默认（小队面板 38%）。
   */
  HUD.prototype.bindSplitter = function (game) {
    var bar = document.getElementById('splitter');
    var roster = document.getElementById('roster');
    var fleet = document.getElementById('rosterList');
    var squad = document.getElementById('squadBox');
    if (!bar || !roster || !fleet || !squad) return;

    var DEFAULT_FRAC = 0.34;   // 小队面板分到的比例（默认把更多高度留给舰艇列表）
    var MIN_FRAC = 0.07;
    var MAX_FRAC = 0.93;
    var frac = DEFAULT_FRAC;

    try {
      var saved = window.localStorage && window.localStorage.getItem('naval.squadBoxFrac');
      var v = parseFloat(saved);
      if (isFinite(v) && v > MIN_FRAC - 0.01 && v < MAX_FRAC + 0.01) frac = v;
    } catch (e) { /* file:// 下可能没有 localStorage */ }

    function remember() {
      try {
        if (window.localStorage) window.localStorage.setItem('naval.squadBoxFrac', String(frac));
      } catch (e) { /* ignore */ }
    }

    function setFrac(f) {
      frac = U.clamp(f, MIN_FRAC, MAX_FRAC);
      fleet.style.flexGrow = String((1 - frac).toFixed(4));
      squad.style.flexGrow = String(frac.toFixed(4));
    }

    var dragging = false;
    bar.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      bar.classList.add('dragging');
      if (bar.setPointerCapture) { try { bar.setPointerCapture(e.pointerId); } catch (err) { } }
      if (e.preventDefault) e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var top = fleet.getBoundingClientRect().top;
      var bottom = squad.getBoundingClientRect().bottom;
      var region = bottom - top;
      if (region < 80) return;
      // 分隔条跟着鼠标走：小队面板的上沿就在指针下方半个分隔条处
      var squadH = bottom - e.clientY - (bar.offsetHeight || 9) / 2;
      setFrac(squadH / region);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      remember();
    }
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    if (bar.addEventListener) bar.addEventListener('lostpointercapture', endDrag);
    bar.addEventListener('dblclick', function () {
      setFrac(DEFAULT_FRAC);
      remember();
    });

    setFrac(frac);
  };

  /** 面板高亮跟 game 的当前状态同步（键盘改了模式时也要跟上） */
  HUD.prototype.syncSquadControls = function (game) {
    function mark(attr, val) {
      var btns = document.querySelectorAll('.sq-b[data-' + attr + ']');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].dataset[attr] === String(val));
      }
    }
    mark('lines', game.squadLines);
    mark('turn', game.squadTurnMode);
    mark('mode', game.squadOrderMode);
    var sq = game.primarySquad ? game.primarySquad() : null;
    if (sq) mark('lines', N.Squad.lineCountOf(sq) === 0 ? 1 : sq.lines);
  };

  /* ---------------------------------------------------------------- 目标 */
  HUD.prototype.renderObjectives = function (world) {
    var box = this.el.objectiveList;
    if (!box) return;
    var list = world.evaluateObjectives();
    if (!list.length) {
      box.innerHTML = '<div class="obj-none">自由交战</div>';
      return;
    }
    var key = list.map(function (o) {
      return o.id + ':' + (o.done ? 1 : 0) + ':' + Math.round(o.progress * 20) + ':' + (o.note || '');
    }).join('|');
    if (key === this._objKey) return;
    this._objKey = key;

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      html += '<div class="obj-item' + (o.done ? ' done' : '') +
        (o.kind === 'secondary' ? ' secondary' : '') + '">' +
        '<div class="oi-top"><span class="oi-mark">' + (o.done ? '✓' : (o.kind === 'secondary' ? '◇' : '◆')) + '</span>' +
        '<span class="oi-text">' + o.text + '</span></div>' +
        '<div class="oi-bar"><i style="width:' + Math.round(U.clamp01(o.progress) * 100) + '%"></i></div>' +
        (o.note ? '<div class="oi-note">' + o.note + '</div>' : '') +
        '</div>';
    }
    box.innerHTML = html;
  };

  /* ---------------------------------------------------------------- 战报 */
  HUD.prototype.appendLog = function (world) {
    var box = this.el.log;
    var msgs = world.messages;
    var added = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.id <= this._lastMsgId) continue;
      this._lastMsgId = m.id;
      var d = document.createElement('div');
      d.className = m.kind || 'info';
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = N.U.formatClock(world.scenario.startTime + m.t);
      d.appendChild(t);
      d.appendChild(document.createTextNode(m.text));
      box.appendChild(d);
      added = true;
    }
    if (added) {
      // 控制节点数量
      while (box.childNodes.length > 120) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
  };

  /* ---------------------------------------------------------------- 编队 */
  /**
   * 我方编队列表。
   * 视距内的舰是实时的；视距外的舰显示的是最后一次无线电报告，
   * 会标出"报告多少秒前"，掉得太久的整条卡片变暗。
   */
  HUD.prototype.renderRoster = function (world) {
    var all = world.ships.filter(function (s) { return s.side === world.playerSide; });
    var sel = this.game.selected;
    var cmdOn = !!N.Command;

    var views = all.map(function (s) {
      var v = cmdOn ? N.Command.ownView(world, s) : null;
      return { s: s, v: v || s, age: v ? world.time - (v.reportedAt || 0) : 0 };
    });

    // 结构签名，只有变化时才重建 DOM
    var key = views.map(function (o) {
      var v = o.v;
      return o.s.id + ':' + (sel.has(o.s.id) ? 1 : 0) + ':' + Math.round(v.hull || 0) + ':' +
        Math.round(v.flood || 0) + ':' + Math.round(v.fire || 0) + ':' +
        Math.round((v.speed || 0) * 2) + ':' + (v.sunk ? 1 : 0) + ':' +
        (v.sinking ? 1 : 0) + ':' + (v.engage ? 1 : 0) + ':' + (o.age > 18 ? 1 : 0) + ':' +
        (o.s.speed > 1.5 ? 1 : 0);
    }).join('|');

    var alive = views.filter(function (o) { return !o.v.sunk; });
    this.el.rosterCount.textContent = alive.length + ' 艘';

    // 战力也按图上的报告算，不是按真实血量
    var cur = 0, max = 0;
    views.forEach(function (o) {
      max += o.v.hullMax || 1;
      if (!o.v.sunk) cur += (o.v.hull || 0);
    });
    var p = max > 0 ? U.clamp01(cur / max) : 0;
    this.el.forcePower.textContent = Math.round(p * 100) + '%';
    this.el.forcePowerBar.style.width = (p * 100) + '%';

    if (key === this._rosterKey) return;
    this._rosterKey = key;

    var html = '';
    for (var i = 0; i < views.length; i++) {
      var o = views[i], s2 = o.s, v = o.v;
      var hp = v.hullMax ? U.clamp01((v.hull || 0) / v.hullMax) : 0;
      var stale = o.age > 18 && !v.sunk;
      var cls = 'ship-card';
      if (sel.has(s2.id)) cls += ' selected';
      if (v.sunk) cls += ' sunk';
      else if (hp < 0.35 || (v.flood || 0) > 60) cls += ' critical';
      else if (hp < 0.75 || (v.fire || 0) > 25) cls += ' damaged';
      if (stale) cls += ' stale';

      var barCls = hp < 0.35 ? 'crit' : (hp < 0.7 ? 'low' : '');
      var isFlag = cmdOn && N.Command.flagshipOf(world, world.playerSide) === s2;
      // 运输船开进锚地就停船卸货 —— 别让它看起来像是卡住了
      var anchored = s2.role === 'transport' && s2.destination &&
        V.dist(s2.pos, s2.destination) < 900 && (s2.speed || 0) < 1.5 && !v.sunk;

      html += '<div class="' + cls + '" data-id="' + s2.id + '" data-sunk="' + (v.sunk ? 1 : 0) + '">' +
        '<div class="sc-top"><span class="sc-name">' +
        (isFlag ? '★ ' : '') + s2.name + '</span>' +
        '<span class="sc-type">' + s2.cls.type + '</span></div>' +
        '<div class="sc-bars">' +
        '<div class="sc-line"><div class="bar"><i class="' + barCls + '" style="width:' + (hp * 100) + '%"></i></div></div>' +
        '</div>' +
        '<div class="sc-spd">' + s2.cls.typeName + ' · ' +
        (v.speed == null ? '—' : v.speed.toFixed(1) + ' kn') +
        ((v.flood || 0) > 5 ? ' · 进水' + Math.round(v.flood) + '%' : '') +
        ((v.fire || 0) > 5 ? ' · 火' + Math.round(v.fire) + '%' : '') + '</div>' +
        (v.sunk ? '<div class="sc-tag">已沉没</div>' :
          (v.sinking ? '<div class="sc-tag">正在沉没</div>' :
            (stale ? '<div class="sc-tag warn">报告 ' + Math.round(o.age) + 's 前</div>' :
              (s2.isPlayerControlled === false ? '<div class="sc-tag ai">AI 驾驶</div>' :
                (v.engage ? '<div class="sc-tag">交战中</div>' : ''))))) +
        (anchored ? '<div class="sc-tag">锚泊卸货</div>' : '') +
        '</div>';
    }
    this.el.rosterList.innerHTML = html;

    // 选中的舰自动滚进可见范围（列表被拖小的时候尤其重要）。
    // 只在“选择变了”的时候做，免得跟用户自己的滚动打架。
    var selKey = Array.from(sel).join(',');
    if (selKey !== this._selScrollKey) {
      this._selScrollKey = selKey;
      var box = this.el.rosterList;
      var pick = null;
      for (var ci = 0; ci < box.children.length; ci++) {
        var ch = box.children[ci];
        if (ch.classList && ch.classList.contains('selected')) { pick = ch; break; }
      }
      if (pick && box.getBoundingClientRect && pick.getBoundingClientRect) {
        var cr = box.getBoundingClientRect();
        var br = pick.getBoundingClientRect();
        if (br.top < cr.top) box.scrollTop -= (cr.top - br.top) + 4;
        else if (br.bottom > cr.bottom) box.scrollTop += (br.bottom - cr.bottom) + 4;
      }
    }
  };

  /* ------------------------------------------------------------ 指挥舰状态 */
  HUD.prototype.renderCommand = function (world) {
    if (!N.Command || !this.el.cmdFlag) return;
    var st = N.Command.statusOf(world, world.playerSide);

    this.el.cmdFlag.textContent = st.flagshipName || '无';

    if (!st.online) {
      this.el.cmdLink.textContent = '指挥中断 · ' + Math.ceil(st.down) + 's';
      this.el.cmdLink.className = 'bad';
    } else {
      this.el.cmdLink.textContent = '丢包 ' + st.lossPct + '% · 延迟 ~' + st.delay + 's';
      this.el.cmdLink.className = st.lossPct >= 40 ? 'bad' : (st.lossPct >= 22 ? 'warn' : '');
    }

    this.el.cmdRadio.textContent = st.radioOk ? '正常' : '已损毁';
    this.el.cmdRadio.className = st.radioOk ? '' : 'bad';
    this.el.cmdIff.textContent = st.iffOk ? '正常' : '已损毁';
    this.el.cmdIff.className = st.iffOk ? '' : 'bad';
    this.el.cmdLossBar.style.width = Math.min(100, st.lossPct) + '%';
  };

  /* ---------------------------------------------------------------- 详情 */
  HUD.prototype.renderDetail = function (world) {
    var g = this.game;
    var sel = g.selected;
    if (!sel || sel.size === 0) {
      this.el.detailEmpty.classList.remove('hidden');
      this.el.detailBody.classList.add('hidden');
      return;
    }
    // 多选时显示第一艘
    var id = null;
    sel.forEach(function (x) { if (id === null) id = x; });
    var ship = world.shipById(id);
    if (!ship) {
      this.el.detailEmpty.classList.remove('hidden');
      this.el.detailBody.classList.add('hidden');
      return;
    }

    this.el.detailEmpty.classList.add('hidden');
    this.el.detailBody.classList.remove('hidden');

    // 视距外：这一屏显示的也是最后一次报告，不是实时状态
    var vw = (N.Command && !world.replay) ? N.Command.ownView(world, ship) : null;
    var age = vw ? world.time - (vw.reportedAt || 0) : 0;
    var stale = !!vw && age > 18 && !vw.sunk;

    this.el.dName.textContent = ship.name + (ship.hullNumber ? '  ' + ship.hullNumber : '');
    this.el.dClass.textContent = ship.cls.name + ' · ' + ship.cls.typeName +
      ' · ' + ship.cls.displacement.toLocaleString() + ' t' +
      (sel.size > 1 ? '  （已选 ' + sel.size + ' 艘）' : '') +
      (stale ? '  · 报告 ' + Math.round(age) + 's 前' : '');

    var hullNow = vw && vw.hull != null ? vw.hull : ship.hull;
    var floodNow = vw && vw.flood != null ? vw.flood : ship.flood;
    var fireNow = vw && vw.fire != null ? vw.fire : ship.fire;
    var spdNow = vw && vw.speed != null ? vw.speed : ship.speed;
    var hdgNow = vw && vw.heading != null ? vw.heading : ship.heading;

    var hp = U.clamp01(hullNow / ship.hullMax);
    this.el.barHull.style.width = (hp * 100) + '%';
    this.el.barHull.style.background = hp < 0.35 ? 'var(--red)' : (hp < 0.7 ? 'var(--amber)' : 'var(--cyan)');
    this.el.txtHull.textContent = Math.round(hullNow);
    this.el.barFlood.style.width = U.clamp01(floodNow / 100) * 100 + '%';
    this.el.txtFlood.textContent = Math.round(floodNow);
    this.el.barFire.style.width = U.clamp01(fireNow / 100) * 100 + '%';
    this.el.txtFire.textContent = Math.round(fireNow);
    this.el.dStatus.textContent = stale ? '数据已过期（无线电报告）' : ship.statusText();

    /* 结构分区：动力/武器/上层/通信 各自的剩余比例 */
    var zf = vw && vw.zones ? vw.zones : null;
    var zoneRow = function (bar, txt, k) {
      var f = zf && zf[k] != null ? zf[k] : (ship.zoneFrac ? ship.zoneFrac(k) : 1);
      if (!bar || !txt) return;
      bar.style.width = (U.clamp01(f) * 100) + '%';
      bar.className = f <= 0 ? 'dead' : (f < 0.5 ? 'warn' : '');
      txt.textContent = f <= 0 ? '毁' : Math.round(f * 100);
    };
    zoneRow(this.el.barZonePower, this.el.txtZonePower, 'power');
    zoneRow(this.el.barZoneWeapons, this.el.txtZoneWeapons, 'weapons');
    zoneRow(this.el.barZoneSuper, this.el.txtZoneSuper, 'superstructure');
    zoneRow(this.el.barZoneComms, this.el.txtZoneComms, 'comms');

    this.el.dSpeed.textContent = spdNow.toFixed(1) + ' / ' + ship.effectiveMaxSpeed().toFixed(1) + ' kn';
    this.el.dHeading.textContent = Math.round(U.norm360(hdgNow)) + '° (' + U.bearingName(hdgNow) + ')';
    if (ship.pendingOrder) {
      this.el.dOrder.textContent = '命令传递中…';
      this.el.dOrder.style.color = 'var(--amber)';
    } else {
      this.el.dOrder.textContent = Math.round(ship.orderedHeading) + '° / ' +
        (ship.orderedSpeed).toFixed(0) + ' kn';
      this.el.dOrder.style.color = '';
    }

    // 舷角（相对舰首）
    var aimForRel = null;
    if (ship.bombardTargetId) {
      var stt = world.shoreTargetById(ship.bombardTargetId);
      if (stt && !stt.destroyed) aimForRel = stt.pos;
    }
    if (!aimForRel && ship.targetTrackId) {
      var trr = N.Sensors.track(world, world.playerSide, ship.targetTrackId);
      if (trr) aimForRel = trr.pos;
    }
    if (this.el.dRelBrg) {
      this.el.dRelBrg.textContent = aimForRel
        ? relText(ship.relativeBearing(aimForRel))
        : '—';
    }

    this.drawHeadingDial(ship, hdgNow);

    // 速度按钮高亮
    var locked = ship.isPlayerControlled === false;
    var frac = ship.cls.maxSpeed > 0 ? ship.orderedSpeed / ship.cls.maxSpeed : 0;
    var btns = this.el.speedBtns.querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) {
      var f = parseFloat(btns[b].dataset.spd);
      var on = Math.abs(f - frac) < 0.13;
      btns[b].classList.toggle('active', on);
      btns[b].disabled = locked;
    }

    // 火控
    var tr = ship.targetTrackId ? N.Sensors.track(world, world.playerSide, ship.targetTrackId) : null;
    if (tr) {
      var dist = V.dist(ship.pos, tr.pos);
      this.el.dTarget.textContent = N.Sensors.idText(tr);
      this.el.dRange.textContent = U.fmtRange(dist) +
        (dist > ship.gunRangeMax ? ' （超出射程）' : '');
      if (this.el.dTargetBrg) {
        this.el.dTargetBrg.textContent = relText(ship.relativeBearing(tr.pos)) +
          ' · ' + Math.round(Geo.bearing(ship.pos, tr.pos)) + '°';
      }
    } else {
      this.el.dTarget.textContent = '未指定';
      this.el.dRange.textContent = '—';
      if (this.el.dTargetBrg) this.el.dTargetBrg.textContent = '—';
    }

    // 岸轰目标
    if (this.el.dBombard) {
      if (ship.bombardTargetId) {
        var bt = world.shoreTargetById(ship.bombardTargetId);
        if (bt) {
          this.el.dBombard.textContent = bt.name +
            (bt.destroyed ? '（已摧毁）' : ' · ' + U.fmtRange(V.dist(ship.pos, bt.pos)));
          this.el.dBombard.style.color = bt.destroyed ? 'var(--dim)' : 'var(--amber)';
        } else {
          this.el.dBombard.textContent = '—';
          this.el.dBombard.style.color = '';
        }
      } else {
        this.el.dBombard.textContent = '—';
        this.el.dBombard.style.color = '';
      }
    }

    // 照明弹
    if (this.el.dStarshell) {
      var total = ship.starshells || 0;
      var cd = ship.starshellCd || 0;
      if (!total && cd <= 0) {
        this.el.dStarshell.textContent = '已用尽';
        this.el.dStarshell.style.color = 'var(--dim)';
      } else if (cd > 0) {
        this.el.dStarshell.textContent = '装填 ' + Math.ceil(cd) + 's · 余 ' + total + ' 发';
        this.el.dStarshell.style.color = 'var(--dim2)';
      } else {
        this.el.dStarshell.textContent = '余 ' + total + ' 发';
        this.el.dStarshell.style.color = 'var(--amber)';
      }
    }

    this.el.dFire.textContent = ship.engage ? '开火中' : (ship.bombardTargetId ? '对岸射击' : '停火');
    this.el.dFire.style.color = (ship.engage || ship.bombardTargetId) ? 'var(--red)' : '';
    this.el.btnEngage.classList.toggle('active', !!ship.engage);
    this.el.btnEngage.disabled = locked || (!tr && !ship.bombardTargetId);

    var spot = ship.spotting;
    if (spot && world.time - spot.t < 90) {
      var txt = spot.kind === 'hit' ? '命中' : (spot.kind === 'straddle' ? '跨射' : '未跨射');
      var acc = Math.round((1 - ship.errorScale) * 100);
      this.el.dSpot.textContent = txt + ' · 火控收敛 ' + acc + '%';
      this.el.dSpot.style.color = spot.kind === 'miss' ? 'var(--dim)' : 'var(--green)';
    } else {
      this.el.dSpot.textContent = '未校射 · 火控收敛 ' + Math.round((1 - ship.errorScale) * 100) + '%';
      this.el.dSpot.style.color = '';
    }

    // 主炮
    var mh = '';
    for (var i = 0; i < ship.mounts.length; i++) {
      var m = ship.mounts[i];
      var st = m.disabled ? '损毁' : (m.ready ? '待发' : '装填 ' + Math.ceil(m.reload) + 's');
      var cls = m.disabled ? 'disabled' : (m.ready ? 'ready' : 'reloading');
      mh += '<div class="mount-row ' + cls + '">' +
        '<span class="m-id">' + m.label + '</span>' +
        '<span class="m-state">' + (m.count > 1 ? m.count + '×' : '') + m.gun.caliber + 'mm ' + st + '</span>' +
        '<span class="m-ammo">' + m.ammo + '</span></div>';
    }
    this.el.mountList.innerHTML = mh;

    // 鱼雷
    if (ship.torps.length === 0) {
      this.el.torpSection.classList.add('hidden');
    } else {
      this.el.torpSection.classList.remove('hidden');
      var th = '';
      for (var j = 0; j < ship.torps.length; j++) {
        var t = ship.torps[j];
        var st2 = t.disabled ? '损毁' : (t.loaded > 0 ? t.loaded + '/' + t.tubes + ' 待发' :
          '装填 ' + Math.ceil(t.reload / 60) + '分');
        th += '<div class="mount-row ' + (t.disabled ? 'disabled' : (t.loaded > 0 ? 'ready' : 'reloading')) + '">' +
          '<span class="m-id">' + t.label + '</span>' +
          '<span class="m-state">' + t.torp.name + ' ' + st2 + '</span></div>';
      }
      this.el.torpList.innerHTML = th;

      var rel = tr ? Math.abs(ship.relativeBearing(tr.pos)) : 0;
      var arcOk = tr && ship.torpedoArcOk(ship.relativeBearing(tr.pos));
      var anyLoaded = ship.torps.some(function (t) { return t.loaded > 0 && !t.disabled; });
      this.el.btnTorp.disabled = locked || !tr || !anyLoaded || !arcOk;
      this.el.torpNote.textContent = !tr ? '未指定目标' :
        (!anyLoaded ? '发射管装填中' :
          (!arcOk ? '舷侧未对准目标（需将舷侧转向目标）' :
            '射程 ' + U.fmtRange(ship.torpRangeMax) + ' · 航速 ' + ship.torpSpeed + ' kn' +
            (ship.torps[0].torp.wake < 0.2 ? ' · 几乎无航迹' : ' · 航迹明显')));
    }

    this.el.btnSmoke.classList.toggle('active', !!ship.smokeScreen);
    this.el.btnSmoke.disabled = locked;
    if (this.el.btnStarshell) {
      var scd = ship.starshellCd || 0;
      var sleft = ship.starshells || 0;
      this.el.btnStarshell.disabled = locked || sleft <= 0 || scd > 0;
      this.el.btnStarshell.innerHTML = scd > 0
        ? ('照明弹 ' + Math.ceil(scd) + 's')
        : ('照明弹 <kbd>L</kbd>');
    }
  };

  /* ---------------------------------------------------------------- 接触 */
  HUD.prototype.renderContacts = function (world) {
    var list = N.Sensors.trackList(world, world.playerSide);
    var ref = world.playerReference();
    list.sort(function (a, b) { return V.dist(ref, a.pos) - V.dist(ref, b.pos); });

    this.el.contactCount.textContent = list.length + ' 个';

    if (list.length === 0) {
      this.el.contacts.innerHTML = '<div class="contact-empty">暂无接触</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      var dist = V.dist(ref, tr.pos);
      var brg = Geo.bearing(ref, tr.pos);
      var cls = 'contact-item';
      if (tr.idLevel >= N.Sensors.ID.TYPE) cls += ' identified';
      if (this.game.selectedTrackId === tr.id) cls += ' selected';
      var stale = world.time - tr.lastSeen > 45;
      html += '<div class="' + cls + '" data-id="' + tr.id + '">' +
        '<span class="ci-name">' + N.Sensors.idText(tr) + '</span>' +
        '<span class="ci-meta">' + Math.round(brg) + '° ' + U.fmtRange(dist) +
        (stale ? ' · 陈旧' : '') + '</span></div>';
    }
    this.el.contacts.innerHTML = html;
  };

  /* ---------------------------------------------------------------- 提示 */
  HUD.prototype.toast = function (text, kind) {
    var el = this.el.toast;
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(this._toastTimer);
    var self = this;
    this._toastTimer = setTimeout(function () {
      el.className = 'toast hidden';
    }, 2200);
  };

  /* ---------------------------------------------------------------- 简报 */
  HUD.prototype.showBriefing = function (scenario, onStart, label, onBack) {
    var self = this;
    this.el.clock.textContent = N.U.formatClock(scenario.startTime);
    var body = '';
    (scenario.brief || []).forEach(function (line) {
      if (line === '') body += '<div class="brief-blank"></div>';
      else body += '<p class="brief-line">' + line + '</p>';
    });

    if (scenario.intel) {
      body += '<div class="intel-box"><div class="ib-label">情报（可能已过时）</div>' +
        scenario.intel + '</div>';
    }

    if (scenario.objectives && scenario.objectives.length) {
      body += '<div class="obj-list">';
      scenario.objectives.forEach(function (o) {
        body += '<div class="obj-item' + (o.kind === 'secondary' ? ' secondary' : '') + '">' +
          '<span class="ob-mark">' + (o.kind === 'secondary' ? '◇' : '◆') + '</span>' +
          '<span>' + o.text + '</span></div>';
      });
      body += '</div>';
    }

    // 环境提示：低光条件下照明弹是关键手段
    var light = (scenario.env && scenario.env.light) || 'day';
    if (light !== 'day') {
      body += '<div class="intel-box"><div class="ib-label">夜战提示 · 照明弹</div>' +
        '按 <b>L</b> 朝鼠标所指海域发射照明弹：<b>3.5 秒</b>后爆燃，燃烧 <b>50 秒</b>，' +
        '照亮半径 <b>4.2 km</b>。圈内<b>任何舰艇</b>（敌我皆然）的可见距离提升到 11 km，' +
        '光学测距误差降低 40%。<br>' +
        '弹药有限（重巡 10 / 轻巡 8 / 驱逐舰 5），发射后 25 秒装填。' +
        '<b>照亮敌人的同时也会照亮自己。</b></div>';
    }

    // 双方编成
    var mine = (scenario.forces || []).filter(function (f) { return f.side === scenario.playerSide; });
    var foeSide = scenario.playerSide === 'US' ? 'JP' : 'US';
    var foe = (scenario.forces || []).filter(function (f) { return f.side === foeSide; });
    if (mine.length || foe.length) {
      var foeName = foeSide === 'US' ? '美军' : '日军';
      body += '<div class="force-grid">';
      body += '<div class="force-col us"><h4>我方编成 · ' + (mine[0] ? mine[0].group : '') + '</h4><ul>';
      mine.forEach(function (f) {
        var c = N.ShipClasses[f.class];
        body += '<li>' + f.name + ' <span>' + (c ? c.typeName : '?') + '</span></li>';
      });
      body += '</ul></div>';
      body += '<div class="force-col jp"><h4>情报中的' + foeName + '编成</h4><ul>';
      foe.forEach(function (f) {
        var c = N.ShipClasses[f.class];
        var guess = !c ? '不明' : (c.type === 'CA' ? '重巡洋舰？' : (c.type === 'CL' ? '轻巡洋舰？' : (c.type === 'AK' ? '运输船？' : '驱逐舰？')));
        body += '<li>不明 <span>' + guess + '</span></li>';
      });
      body += '</ul></div></div>';
    }

    // 其他场景
    var others = N.Scenarios.all().filter(function (s) { return s.id !== scenario.id; });
    if (others.length) {
      body += '<div class="scenario-more"><div class="sm-title">其他场景</div>';
      others.forEach(function (s) {
        body += '<div class="sm-item' + (s.available ? '' : ' locked') + '">' +
          '<span class="sm-name">' + s.title + '</span>' +
          '<span class="sm-tags">' + (s.tags || []).join(' / ') + '</span>' +
          '<span class="sm-state">' + (s.available ? '可选' : '未实现') + '</span></div>';
      });
      body += '</div>';
    }

    this.el.modalTag.textContent = '任务简报';
    this.el.modalTitle.textContent = scenario.title;
    this.el.modalSub.textContent = scenario.date + ' · ' + scenario.location;
    this.el.modalBody.innerHTML = body;
    this.el.modalFoot.innerHTML = '';
    var btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = label || '进入战位';
    btn.addEventListener('click', function () {
      self.hideOverlay();
      if (onStart) onStart();
    });
    this.el.modalFoot.appendChild(btn);

    if (onBack) {
      var back = document.createElement('button');
      back.className = 'btn-ghost';
      back.textContent = '返回';
      back.addEventListener('click', function () {
        self.hideOverlay();
        onBack();
      });
      this.el.modalFoot.appendChild(back);
    }
    this._ensureExit();
    this.el.overlay.classList.remove('hidden');
    this.el.modal.scrollTop = 0;
  };

  /* ---------------------------------------------------------------- 暂停菜单 */
  /** 暂停菜单：战斗中的万能出口。任何状态都能从这里回到游戏/重开/换任务 */
  HUD.prototype.showPauseMenu = function (world, o) {
    var self = this;
    o = o || {};
    var sum = world && world.summary ? world.summary() : null;

    var body = '<p class="pause-hint">战斗已暂停。选择下一步：</p>';
    if (sum) {
      body += '<div class="result-grid">' +
        '<div class="result-cell"><div class="rc-label">已交战</div><div class="rc-value">' +
        Math.round(sum.time / 60) + ' 分</div></div>' +
        '<div class="result-cell"><div class="rc-label">我方战力</div><div class="rc-value">' +
        Math.round(sum.own.power * 100) + '%</div></div>' +
        '<div class="result-cell"><div class="rc-label">敌方战力</div><div class="rc-value">' +
        Math.round(sum.enemy.power * 100) + '%</div></div>' +
        '<div class="result-cell"><div class="rc-label">我方损失</div><div class="rc-value">' +
        sum.own.sunk + ' 沉</div></div>' +
        '</div>';
    }

    this.el.modalTag.textContent = '菜单';
    this.el.modalTitle.textContent = '战斗暂停';
    this.el.modalSub.textContent = world ? (world.scenario.title || '') : '';
    this.el.modalBody.innerHTML = body;
    this.el.modalFoot.innerHTML = '';

    function addBtn(text, cls, fn) {
      var b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      b.addEventListener('click', fn);
      self.el.modalFoot.appendChild(b);
      return b;
    }

    addBtn('继续战斗', 'btn-primary', function () {
      self.hideOverlay();
      if (o.onResume) o.onResume();
    });
    addBtn('重新开始', 'btn-ghost', function () {
      self.hideOverlay();
      if (o.onRestart) o.onRestart();
    });
    addBtn('选择任务', 'btn-ghost', function () {
      if (o.onSelect) o.onSelect();
    });
    if (o.onReplay) {
      addBtn('观看回放', 'btn-ghost', function () {
        self.hideOverlay();
        if (o.onReplay) o.onReplay();
      });
    }
    if (o.onHelp) {
      addBtn('操作说明', 'btn-ghost', function () {
        if (o.onHelp) o.onHelp();
      });
    }
    if (o.onHome) {
      addBtn('回主菜单', 'btn-ghost', function () {
        if (o.onHome) o.onHome();
      });
    }

    this._ensureExit();
    this.el.overlay.classList.remove('hidden');
    this.el.modal.scrollTop = 0;
  };

  /* ---------------------------------------------------------------- 结算 */
  HUD.prototype.showResult = function (world, onRestart, onSelect, onReplay, extra) {
    var self = this;
    var sum = world.summary();
    var r = sum.result || { result: 'draw', reason: '' };
    var label = { win: '任务达成', loss: '任务失败', draw: '脱离接触' }[r.result] || '结束';
    var cls = { win: 'result-win', loss: 'result-loss', draw: 'result-draw' }[r.result] || '';

    var body = '<div class="result-big ' + cls + '">' + label + '</div>' +
      '<div class="modal-sub">' + r.reason + '</div>';

    body += '<div class="result-grid">' +
      '<div class="result-cell"><div class="rc-label">交战时长</div><div class="rc-value">' +
      Math.round(sum.time / 60) + ' 分</div></div>' +
      '<div class="result-cell"><div class="rc-label">我方战力</div><div class="rc-value">' +
      Math.round(sum.own.power * 100) + '%</div></div>' +
      '<div class="result-cell"><div class="rc-label">敌方战力</div><div class="rc-value">' +
      Math.round(sum.enemy.power * 100) + '%</div></div>' +
      '<div class="result-cell"><div class="rc-label">我方损失</div><div class="rc-value">' +
      sum.own.sunk + ' 沉</div></div>' +
      '</div>';

    // 任务目标达成情况
    var objs = world.evaluateObjectives();
    if (objs.length) {
      body += '<div class="obj-result">';
      objs.forEach(function (o) {
        body += '<div class="or-item' + (o.done ? ' done' : '') + '">' +
          '<span class="or-mark">' + (o.done ? '✓' : '·') + '</span>' +
          '<span class="or-text">' + o.text + '</span>' +
          '<span class="or-pct">' + Math.round(U.clamp01(o.progress) * 100) + '%</span></div>';
      });
      body += '</div>';
    }

    body += '<div class="ship-report"><table><thead><tr>' +
      '<th>舰艇</th><th>状态</th><th>命中</th><th>被弹</th><th>雷击</th></tr></thead><tbody>';
    var all = world.shipsOf(world.playerSide).concat(world.shipsOf(world.playerSide === 'US' ? 'JP' : 'US'));
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      var st = s.sunk ? '沉没' : (s.sinking ? '沉没中' : Math.round(s.hull) + '/' + s.hullMax);
      body += '<tr class="' + (s.sunk ? 'dead' : '') + '">' +
        '<td class="name">' + (s.side === world.playerSide ? '［我］' : '［敌］') + s.name + '</td>' +
        '<td>' + st + '</td><td>' + s.hitsDealt + '</td><td>' + s.hitsTaken + '</td>' +
        '<td>' + s.torpsHitTaken + '</td></tr>';
    }
    body += '</tbody></table></div>';

    // 战役线：追加战后史实
    if (extra && extra.html) body += extra.html;

    this.el.modalTag.textContent = '战斗结算';
    this.el.modalTitle.textContent = world.scenario.title;
    this.el.modalSub.textContent = N.U.formatClock(world.scenario.startTime + world.time) +
      ' · 历时 ' + U.formatDuration(world.time);
    this.el.modalBody.innerHTML = body;
    this.el.modalFoot.innerHTML = '';

    var b1 = document.createElement('button');
    b1.className = 'btn-ghost';
    b1.textContent = '重打本关';
    b1.addEventListener('click', function () { self.hideOverlay(); onRestart && onRestart(); });

    var b2 = document.createElement('button');
    b2.className = 'btn-ghost';
    b2.textContent = '选择任务';
    b2.addEventListener('click', function () { self.hideOverlay(); onSelect && onSelect(); });

    var b3 = document.createElement('button');
    b3.className = 'btn-ghost';
    b3.textContent = '观看回放';
    b3.addEventListener('click', function () { self.hideOverlay(); onReplay && onReplay(); });

    this.el.modalFoot.appendChild(b1);
    this.el.modalFoot.appendChild(b2);
    this.el.modalFoot.appendChild(b3);
    if (extra && extra.home) {
      var bh = document.createElement('button');
      bh.className = 'btn-ghost';
      bh.textContent = '回主菜单';
      bh.addEventListener('click', function () { self.hideOverlay(); extra.home(); });
      this.el.modalFoot.appendChild(bh);
    }
    // 「下一场」放在最后、最显眼的位置
    if (extra && extra.buttons) {
      for (var bi = 0; bi < extra.buttons.length; bi++) {
        this.el.modalFoot.appendChild(extra.buttons[bi]);
      }
    }
    this._ensureExit();
    this.el.overlay.classList.remove('hidden');
    this.el.modal.scrollTop = 0;
  };

  /* ------------------------------------------------------------ 航向仪表 */
  HUD.prototype.drawHeadingDial = function (ship, headingOverride) {
    var cv = this.el.hdgDial;
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;

    var CSS = 132;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (cv.width !== Math.round(CSS * dpr)) {
      cv.width = Math.round(CSS * dpr);
      cv.height = Math.round(CSS * dpr);
    }
    var w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(w / CSS, h / CSS);

    var cx = CSS / 2, cy = CSS / 2, r = CSS / 2 - 11;
    var hdg = U.norm360(headingOverride != null ? headingOverride : ship.heading);
    var ord = U.norm360(ship.pendingOrder ? ship.pendingOrder.heading : ship.orderedHeading);
    var turn = U.angDiff(ord, hdg);
    var TAU = Math.PI * 2;
    var d, a, major, inner;

    /* 底盘 */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = 'rgba(10,26,38,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,180,215,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 刻度 */
    for (d = 0; d < 360; d += 15) {
      major = (d % 45 === 0);
      a = (d - 90) * U.DEG;
      inner = r - (major ? 7 : 3.5);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.strokeStyle = major ? 'rgba(140,220,245,0.55)' : 'rgba(140,220,245,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* 方位字 */
    ctx.font = '9px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var names = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']];
    for (var n = 0; n < names.length; n++) {
      var an = (names[n][0] - 90) * U.DEG;
      ctx.fillStyle = names[n][0] === 0 ? 'rgba(255,140,120,0.95)' : 'rgba(175,220,240,0.7)';
      ctx.fillText(names[n][1], cx + Math.cos(an) * (r + 7), cy + Math.sin(an) * (r + 7));
    }

    /* 转向弧 */
    if (Math.abs(turn) > 2) {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 6, (hdg - 90) * U.DEG, (ord - 90) * U.DEG, turn < 0);
      ctx.strokeStyle = 'rgba(255,193,92,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();

      var mid = (hdg + turn / 2 - 90) * U.DEG;
      ctx.font = 'bold 9px "Consolas", monospace';
      ctx.fillStyle = 'rgba(255,208,125,0.95)';
      ctx.fillText((turn > 0 ? '右' : '左') + Math.abs(Math.round(turn)) + '°',
        cx + Math.cos(mid) * (r - 20), cy + Math.sin(mid) * (r - 20));
    }

    /* 指令航向（虚线） */
    drawDialNeedle(ctx, cx, cy, ord, r - 3, 'rgba(255,193,92,0.85)', 1.2, true, [3, 3]);
    /* 当前航向 */
    drawDialNeedle(ctx, cx, cy, hdg, r - 3, 'rgba(150,238,255,0.98)', 1.9, true, null);

    /* 中心 */
    ctx.beginPath();
    ctx.arc(cx, cy, 2.4, 0, TAU);
    ctx.fillStyle = 'rgba(200,245,255,0.9)';
    ctx.fill();

    /* 底部数字 */
    ctx.font = 'bold 10px "Consolas", monospace';
    ctx.fillStyle = 'rgba(190,240,255,0.9)';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(Math.round(hdg)).padStart(3, '0') + '°', cx, CSS - 1);
  };

  function drawDialNeedle(ctx, cx, cy, hdg, r, color, w, arrow, dash) {
    var a = (hdg - 90) * U.DEG;
    var ex = cx + Math.cos(a) * r, ey = cy + Math.sin(a) * r;
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.restore();
    if (arrow) {
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-5, -3);
      ctx.lineTo(-5, 3);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------ 场景选择 */
  HUD.prototype.showScenarioSelect = function (list, currentId, onPick, onBack) {
    var self = this;
    var groups = N.Scenarios.grouped();
    var total = N.Scenarios.available().length;
    var body = '<p class="sc-intro">按任务类型分组，共 ' + total +
      ' 个可作战场景。每个场景有不同的兵力、时间、能见度与胜负条件。</p>' +
      '<div class="sc-groups">';

    groups.forEach(function (g) {
      body += '<div class="sc-group">' +
        '<div class="sc-group-head"><span class="sc-group-name">' + g.name + '</span>' +
        '<span class="sc-group-desc">' + (g.desc || '') + '</span></div>' +
        '<div class="sc-group-body">';
      g.list.forEach(function (s) {
        var locked = !s.available;
        var cls = 'sc-card' + (locked ? ' locked' : '') + (s.id === currentId ? ' current' : '');
        body += '<div class="' + cls + '" data-id="' + s.id + '">' +
          '<div class="sc-card-top"><span class="sc-title">' + s.title + '</span>' +
          '<span class="sc-badge">' + (locked ? '未实现' : '可作战') + '</span></div>' +
          '<div class="sc-sub">' + s.subtitle + '</div>' +
          '<div class="sc-meta">' + s.date + ' · ' + s.location + '</div>' +
          '<div class="sc-tags">' +
          (s.tags || []).map(function (t) { return '<span>' + t + '</span>'; }).join('') +
          '</div></div>';
      });
      body += '</div></div>';
    });
    body += '</div>';

    this.el.modalTag.textContent = '任务选择';
    this.el.modalTitle.textContent = '铁底湾 1942';
    this.el.modalSub.textContent = '所罗门群岛 · 水面舰艇战术';
    this.el.modalBody.innerHTML = body;
    this.el.modalFoot.innerHTML = '';

    var btns = this.el.modalBody.querySelectorAll('.sc-card');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var id = this.dataset.id;
        var sc = N.Scenarios.get(id);
        if (!sc || !sc.available) {
          self.toast('该场景尚未实现', 'warn');
          return;
        }
        self.hideOverlay();
        if (onPick) onPick(sc);
      });
    }

    if (onBack) {
      var back = document.createElement('button');
      back.className = 'btn-ghost';
      back.textContent = '返回';
      back.addEventListener('click', function () {
        self.hideOverlay();
        onBack();
      });
      this.el.modalFoot.appendChild(back);
    }

    this._ensureExit();
    this.el.overlay.classList.remove('hidden');
    this.el.modal.scrollTop = 0;
  };

  /* ------------------------------------------------------------ 回放控制 */  HUD.prototype.showReplayBar = function (replay, ended) {
    if (!replay) return;
    this.el.replayBar.classList.remove('hidden');
    if (this.el.rbExit) this.el.rbExit.textContent = ended ? '返回结算' : '退出回放';
    this.el.rbSeek.min = 0;
    this.el.rbSeek.max = replay.duration.toFixed(1);
    this.el.rbSeek.step = 0.1;
    this.el.rbSeek.value = 0;

    var dur = replay.duration || 1;
    var marks = '';
    var list = replay.marks ? replay.marks() : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var pct = U.clamp01(m.t / dur) * 100;
      marks += '<i class="' + (m.kind || 'info') + '" style="left:' + pct.toFixed(2) + '%"></i>';
    }
    this.el.rbMarks.innerHTML = marks;

    document.querySelectorAll('.rb-speed button').forEach(function (b) {
      b.classList.toggle('active', parseFloat(b.dataset.rspd) === 2);
    });

    this.updateReplayBar(replay, 0, true, true);
  };

  HUD.prototype.hideReplayBar = function () {
    this.el.replayBar.classList.add('hidden');
  };

  /** 回放：双方当前还在海面上的舰艇数（让玩家确认两边都在画面里） */
  HUD.prototype.setReplaySides = function (ships, playerSide) {
    if (!this.el.rbSides) return;
    var us = 0, jp = 0;
    for (var i = 0; i < ships.length; i++) {
      if (ships[i].sunk) continue;
      if (ships[i].side === 'US') us++; else jp++;
    }
    var key = us + '/' + jp;
    if (this._sidesKey === key) return;
    this._sidesKey = key;
    this.el.rbSides.innerHTML =
      '<span class="us"><i></i>美军 ' + us + '</span>' +
      '<span class="jp"><i></i>日军 ' + jp + '</span>';
  };

  HUD.prototype.updateReplayBar = function (replay, t, playing, auto) {
    if (!replay) return;
    if (this.el.replayBar.classList.contains('hidden')) return;
    if (document.activeElement !== this.el.rbSeek) this.el.rbSeek.value = t;
    this.el.rbClock.textContent = N.U.formatDuration(t) + ' / ' + N.U.formatDuration(replay.duration);
    this.el.rbPlay.textContent = playing ? '❚❚' : '▶';
    if (this.el.rbFollow) this.el.rbFollow.classList.toggle('active', auto !== false);
  };

  /* ---------------------------------------------------------------- 帮助 */
  HUD.prototype.showHelp = function (onClose) {
    var self = this;
    var body =
      '<p><b style="color:var(--accent)">你看到的不是战场，是报告。</b></p>' +
      '<p>本作刻意还原二战水面舰艇的“信息不透明”：</p>' +
      '<div class="obj-list">' +
      '<div class="obj-item"><span class="ob-mark">◆</span><span>敌舰只以<b>航迹</b>形式出现，带测距/测向误差圈，看不到它的真实位置、血量与损伤。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">◆</span><span>识别分四级：水面目标 → 舰种 → 舰级 → 舰名。远距离只能判断“有东西”，且可能误判。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">◆</span><span>炮弹要飞十几秒，你只能看到落水水柱。首发必然偏，靠<b>跨射</b>校射逐步收敛。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">◆</span><span>日方九三式氧气鱼雷射程 20 km 且几乎无航迹；只有瞭望哨偶尔发现，才会触发规避。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">◆</span><span>你的命令有 2~4 秒的传递延迟（信号旗/传声管）。</span></div>' +
      '</div>' +
      '<p style="margin-top:18px"><b style="color:var(--accent)">照明弹规则</b></p>' +
      '<div class="obj-list">' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span>按 <b>L</b>（或点详情面板「照明弹」）朝<b>鼠标所指海域</b>发射，最远 6.5 km。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span><b>3.5 秒</b>后到达并爆燃，燃烧 <b>50 秒</b>，照亮半径 <b>4.2 km</b> 的圆（海图上是虚线圆，标注剩余时间）。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span>照亮期间，<b>圈内任何舰艇</b>（不分敌我）的可见距离都提升到 <b>11 km</b>，且光学测距误差降低 40%。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span>所以照明弹是<b>双刃剑</b>：照亮敌人也照亮自己。夜战里谁先开照明弹，往往意味着谁先准备开炮。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span>每艘舰携带有限（重巡 10 / 轻巡 8 / 驱逐舰 5），发射后需 <b>25 秒</b>装填；运输船没有。</span></div>' +
      '<div class="obj-item"><span class="ob-mark">☀</span><span>被照亮的敌舰会更容易被识别（舰种→舰级→舰名），也更容易被跨射校射。</span></div>' +
      '</div>' +
      '<p style="margin-top:18px"><b style="color:var(--accent)">操作</b></p>' +
      '<div class="obj-list">' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>左键点选己方舰艇（Shift 多选），右键海图下达航向</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>G</b> 把选中舰艇编成小队：右键改成给整条线下命令（不是给单艘舰）</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>「线数」是把小队拆成几条<b>并排的纵队</b>，不是舰艇编号。1 线＝单纵队，2 线＝两条并排，3 线同理</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>舰是按“谁在前、谁在左”自动分到各线的：线号 = 顺序 % 线数，同一线上前后排开</span></div>' +
      '<pre class="help-form">' +
      '1 线（单纵队）      2 线（双纵队）        3 线（三纵队）\n' +
      '\n' +
      '  ①                  ①      ②            ①      ②      ③\n' +
      '  ③                  ③      ④            ④      ⑤      ⑥\n' +
      '  ⑤                  ⑤                    ⑦      ⑧      ⑨\n' +
      '\n' +
      '① = 领舰（队形基准，橙色）\n' +
      '上下间隔 = 「间距」：紧 600 / 中 900 / 宽 1400 m\n' +
      '左右间隔 = 「线距」：紧 900 / 中 1500 / 宽 2200 m\n' +
      '第 0 线压在领舰航迹上，其余各线向右舷依次排开' +
      '</pre>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>左栏每支小队都摊开一张<b>队形盘</b>：一列是一条线，一格里写着一艘舰的名字，从上到下是前到后，<b>★</b> 是领舰</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>点两艘舰＝交换站位</b>。领舰也能换（换完航迹会从新领舰重铺）</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>点一艘舰，再点上方「基准 / 第 N 线」，就把它挪到那条线的末尾</b> —— 4+2、5+2+2 这种不等长队形就是这么排的</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>各条线<b>不必一样长</b>。每条线至少留一艘；想真正减少线数请用「线数」按钮</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>改完不用重新编队，舰会自己开到新站位去；「线数 / 间距」按钮只作用于<b>当前选中</b>的小队</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>小队面板里「右键」切换 <b>战列线移动</b>（给航路点，沿航线开过去）／<b>战列线方向</b>（只改航向）</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>Shift+右键</b> 追加航路点：可以一次给一整条折线航线，到最后一个点自动停车</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>H</b> 切换转向：<b>依次</b>＝后舰沿前舰压出来的航迹跟转，走同一个弯，仍是纵队</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>　　　　　<b>同转</b>＝全队同时转同一个角度：不追航迹、也不保持战列线，各舰只按新航向开（纵队会摊成横队）</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>小队 30 秒没有新指令，由队首那艘舰的舰长接管指挥（面板上会写“指挥长”）</span></div>' +
      '<div class="obj-head" style="margin-top:12px"><span>指挥舰与无线电</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>每方有一艘<b>指挥舰</b>（左栏「指挥舰」）。全舰队的雷达、瞭望要先报到它那里，你再从它那里看图</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>视距内</b>（能见度以内）＝旗语灯光：几秒到，不丢；指挥舰看得见的舰，状态也是实时的</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>视距外</b>＝无线电：延迟几十秒到两分钟，还可能丢包。你看到的接触是旧的，己方舰也是</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>夜间、雾雨、海况差都会<b>提高丢包率</b>（延迟不变），干扰可叠加；左栏「链路」写着当前丢包率</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>敌我识别器有 <b>1%</b> 概率认错；<b>电台</b>或<b>识别器</b>被炮弹打掉就彻底不能用了</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>指挥舰被打沉会<b>指挥中断</b>几十秒，然后由下一艘大舰接替</span></div>' +
      '<div class="obj-head" style="margin-top:12px"><span>气象</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>风、浪、雨、云、月光<b>每场都不一样，而且一直在变</b>（顶栏三条：能见度 / 风与海况 / 月光）</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>瞭望哨</b>：雨和雾压能见度，夜里月光越暗看得越近，阴天会把月光遮掉；满月夜能比新月夜多看四成</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>雷达</b>：雨幕衰减作用距离，<b>海况 5 以上</b>的海杂波会把驱逐舰这种小目标先埋掉，大舰不受影响</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>无线电</b>：雨静电和海况让丢包率上升，<b>雨飑</b>过境时最糟 —— 这时候你既看不见，也问不到</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>会突然来<b>阵雨</b>和<b>雨飑</b>，能见度可能几分钟内掉一半再恢复；战报里会写</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>起火</b>的舰自己就是一根烟囱：烟顺风飘，挡在观察者和目标之间时瞭望会打折；不过夜里火光也最好认</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>鼠标停在顶栏气象条上，能看到当前雷达和无线电被削了多少</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>左键点击敌方接触＝指定为目标；再按 F 开火</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>T 鱼雷齐射（需舷侧对准目标）· S 烟幕 · L 照明弹 · Tab 切换舰艇</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>R 观看回放（双方真实舰位与机动）· 空格暂停 · 1/2/3/4 时间倍率</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span><b>Esc</b> 暂停菜单：继续 / 重新开始 / 选择任务 / 观看回放 / 操作说明</span></div>' +
      '<div class="obj-item"><span class="ob-mark">·</span><span>滚轮缩放 · 拖拽平移 · Q 视野全览</span></div>' +
      '</div>';

    this.el.modalTag.textContent = '操作与规则';
    this.el.modalTitle.textContent = '如何在信息不足时作战';
    this.el.modalSub.textContent = 'Naval Action · Solomon Islands 1942';
    this.el.modalBody.innerHTML = body;
    this.el.modalFoot.innerHTML = '';
    var btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = '知道了';
    btn.addEventListener('click', function () {
      self.hideOverlay();
      if (onClose) onClose();
    });
    this.el.modalFoot.appendChild(btn);
    this._ensureExit();
    this.el.overlay.classList.remove('hidden');
    this.el.modal.scrollTop = 0;
  };

  /** 兜底：任何弹窗都必须至少有一个出口按钮，绝不出现“进得去出不来” */
  HUD.prototype._ensureExit = function () {
    if (this.el.modalFoot.children.length === 0) {
      var self = this;
      var b = document.createElement('button');
      b.className = 'btn-primary';
      b.textContent = '关闭';
      b.addEventListener('click', function () { self.hideOverlay(); });
      this.el.modalFoot.appendChild(b);
    }
  };

  HUD.prototype.hideOverlay = function () {
    this.el.overlay.classList.add('hidden');
  };

  /** 当前是否有弹窗挡住游戏（用于屏蔽游戏内按键） */
  HUD.prototype.isOverlayOpen = function () {
    return !this.el.overlay.classList.contains('hidden');
  };

  HUD.prototype.resetLog = function () {
    this.el.log.innerHTML = '';
    this._lastMsgId = 0;
    this._rosterKey = '';
    this._objKey = '';
  };

  N.HUD = HUD;
})(globalThis.Naval = globalThis.Naval || {});
