/* ==========================================================================
 *  tutorial.js —— 新手引导
 *
 *  分步骤的卡片，每一关给一句话说明 + 一个“要你做的动作”。
 *  动作类步骤自己看世界状态判断有没有做到（选中 / 下令 / 编队 / 转向 / 开火 / 鱼雷），
 *  做到就自动进下一步；纯讲解的步骤点「下一步」。
 *  15 秒还没做到就把「跳过这步」放出来，不至于卡死。
 * ========================================================================== */
(function (N) {
  'use strict';

  var STEPS = [
    {
      title: '先看清你手里有什么',
      body: '左边是<b>我方编队</b>，每一行是一艘舰：舰名、舰级、结构值、航速。<br>' +
        '注意 —— 这里显示的是<b>指挥舰收到的报告</b>，不是舰艇此刻的真实状态。' +
        '报告可能是几十秒前的。',
      todo: '点击左侧任意一艘舰（或直接点海图上的舰）',
      enter: function (game) { game.selected.clear(); },
      check: function (game) { return game.selected.size > 0; }
    },
    {
      title: '用右键给航向',
      body: '在<b>海图上右键</b>，舰艇就会转向那个点。<br>' +
        '琥珀色虚线是<b>指令航向</b>，白色实线是它<b>当前</b>的航向 —— 大舰转向很慢，' +
        '一条重巡从 20 节满舵转 90° 要一两分钟。',
      todo: '在海图上右键，给选中的舰下一个航向',
      enter: function (game) { this._snap = snapshotOrders(game); },
      check: function (game) {
        // 进来时一艘都没选中？那就等玩家选了再拍快照
        if (!this._snap || !Object.keys(this._snap).length) {
          this._snap = snapshotOrders(game);
          return false;
        }
        return ordersChanged(game, this._snap);
      }
    },
    {
      title: '把几艘舰编成小队',
      body: '按住 <kbd>Shift</kbd> 点击，可以多选。<br>' +
        '选中两艘以上后按 <kbd>G</kbd>，它们就编成一个小队，会自动排成一条<b>战列线</b>：' +
        '后舰跟着前舰的航迹走，保持固定间距。',
      todo: 'Shift+点击选中 2 艘以上，然后按 G',
      check: function (game) {
        return game.world && game.world.squads && game.world.squads.length > 0;
      }
    },
    {
      title: '两种转向：依次 / 同转',
      body: '按 <kbd>H</kbd> 切换。<br>' +
        '<b>依次</b>：后舰沿前舰的航迹跟转，整条线走同一个弯，队形不变。<br>' +
        '<b>同转</b>：全队同时转同一个角度，队形会从纵队拉成横队 —— 用来快速转向接敌。',
      todo: '按 H 把小队切成「同转」',
      check: function (game) {
        var sq = game.world && game.world.squads;
        if (!sq) return false;
        for (var i = 0; i < sq.length; i++) if (sq[i].turnMode === 'together') return true;
        return false;
      }
    },
    {
      title: '指定目标，然后开火',
      body: '你<b>看不到敌舰本体</b>，只能看到雷达和瞭望哨报上来的<b>接触</b>（右下的列表，' +
        '海图上的橙色标记）。接触有误差，而且会滞后。<br>' +
        '点一个接触指定为目标，再按 <kbd>F</kbd> 开火。火控会按接触的<b>估计</b>位置解算 —— ' +
        '如果估计错了，炮弹就落在空处。',
      todo: '点右下「接触目标」里的一个目标，然后按 F 开火',
      check: function (game) {
        var list = game.world ? game.world.shipsOf(game.world.playerSide) : [];
        for (var i = 0; i < list.length; i++) if (list[i].engage) return true;
        return false;
      }
    },
    {
      title: '鱼雷：先换一艘驱逐舰',
      body: '鱼雷只有装了发射管的舰才有 —— 驱逐舰<b>都有</b>，重巡一艘都没有，轻巡看舰级。<br>' +
        '选中一艘弗莱彻级（左栏里标着「驱逐舰」的那几艘），然后按 <kbd>T</kbd> 齐射。<br>' +
        '鱼雷只能从<b>舷侧</b>打出去，船头对着目标时打不出来（相对方位要 32°~148°）；' +
        '打不出来就先转个向，让舷侧对着目标。<br>' +
        '日军的九三式氧气鱼雷射程远、航迹几乎看不见；美军的 Mk 15 射程短、航迹明显，早期引信还不可靠。',
      todo: '选中一艘驱逐舰，按 T 发射鱼雷（打不出来就先转向让舷侧对准目标）',
      check: function (game) {
        if (game.world && game.world.torpedoes && game.world.torpedoes.length > 0) return true;
        // 有鱼雷管、也确实按了 T，只是舷侧没对准 —— 也算学会了
        return (game.torpAttempts || 0) > 0;
      }
    },
    {
      title: '最后：你永远在猜',
      body: '这一局里你看到的所有敌方信息 —— 位置、航向、舰种、还剩多少血 —— ' +
        '都是<b>估计</b>。屏幕上没有一处显示敌舰的真实状态，这是故意的。<br><br>' +
        '左侧的<b>指挥舰</b>面板告诉你信息是怎么来的：视距外走无线电，有延迟、会丢包，' +
        '夜间丢得更多。旗舰被打掉，指挥会中断再交接。<br><br>' +
        '按 <kbd>?</kbd> 随时看完整操作说明。祝你打得好。',
      todo: '',
      auto: true
    }
  ];

  function snapshotOrders(game) {
    var out = {};
    game.selected.forEach(function (id) {
      var s = game.world && game.world.shipById ? game.world.shipById(id) : null;
      if (!s) return;
      out[id] = (s.orderedHeading || 0) + ':' + ((s.waypoints && s.waypoints.length) || 0);
    });
    return out;
  }

  function ordersChanged(game, snap) {
    if (!snap) return false;
    for (var id in snap) {
      if (!snap.hasOwnProperty(id)) continue;
      var s = game.world && game.world.shipById ? game.world.shipById(id) : null;
      if (!s) continue;
      var now = (s.orderedHeading || 0) + ':' + ((s.waypoints && s.waypoints.length) || 0);
      if (now !== snap[id]) return true;
    }
    return false;
  }

  var Tutorial = {
    active: false,
    step: 0,
    game: null,
    _waitT: 0,
    _advT: 0,
    _snap: null,
    el: {},

    init: function (game) {
      this.game = game;
      var $ = function (id) { return document.getElementById(id); };
      this.el = {
        card: $('tutCard'),
        step: $('tutStep'),
        title: $('tutTitle'),
        body: $('tutBody'),
        wait: $('tutWait'),
        dots: $('tutDots'),
        next: $('tutNext'),
        skip: $('tutSkip')
      };
      var self = this;
      if (this.el.skip) {
        this.el.skip.addEventListener('click', function () { self.stop(true); });
      }
      if (this.el.next) {
        this.el.next.addEventListener('click', function () { self.advance(); });
      }
    },

    start: function () {
      if (!this.el.card) return;
      this.active = true;
      this.step = 0;
      this._advT = 0;
      if (this.el.card) this.el.card.classList.remove('hidden');
      this.enterStep();
    },

    stop: function (byUser) {
      this.active = false;
      if (this.el.card) this.el.card.classList.add('hidden');
      if (byUser && this.game && this.game.hud) {
        this.game.hud.toast('引导已退出 · 按 ? 看操作说明', 'info');
      }
    },

    isActive: function () { return this.active; },

    enterStep: function () {
      var st = STEPS[this.step];
      if (!st) { this.finish(); return; }
      this._waitT = 0;
      this._advT = 0;
      this._snap = null;
      this._done = false;
      if (st.enter) st.enter.call(this, this.game);

      if (this.el.step) this.el.step.textContent = (this.step + 1) + ' / ' + STEPS.length;
      if (this.el.title) this.el.title.textContent = st.title;
      if (this.el.body) this.el.body.innerHTML = st.body;
      if (this.el.wait) {
        this.el.wait.className = 'tut-wait';
        this.el.wait.textContent = st.auto ? '' : '待完成：' + st.todo;
      }
      if (this.el.next) {
        this.el.next.textContent = st.auto ? '下一步' : '跳过这步';
        this.el.next.classList.toggle('hidden', !st.auto);
      }
      this.renderDots();
    },

    renderDots: function () {
      if (!this.el.dots) return;
      var html = '';
      for (var i = 0; i < STEPS.length; i++) {
        html += '<i class="' + (i === this.step ? 'on' : (i < this.step ? 'past' : '')) + '"></i>';
      }
      this.el.dots.innerHTML = html;
    },

    advance: function () {
      if (!this.active) return;
      this.step++;
      if (this.step >= STEPS.length) { this.finish(); return; }
      this.enterStep();
    },

    finish: function () {
      this.active = false;
      if (this.el.card) this.el.card.classList.add('hidden');
      if (this.game && this.game.hud) {
        this.game.hud.toast('引导结束 · 剩下的交给你的判断', 'info');
      }
    },

    update: function (dt) {
      if (!this.active) return;
      var st = STEPS[this.step];
      if (!st || st.auto) return;

      if (this._done) {
        this._advT += dt;
        if (this._advT > 0.9) this.advance();
        return;
      }

      this._waitT += dt;
      var ok = false;
      try { ok = !!st.check.call(this, this.game); } catch (e) { ok = false; }

      if (ok) {
        this._done = true;
        this._advT = 0;
        if (this.el.wait) {
          this.el.wait.className = 'tut-wait ok';
          this.el.wait.textContent = '✓ 完成';
        }
        return;
      }

      // 15 秒还没做到，把「跳过这步」放出来，别把人卡死
      if (this._waitT > 15 && this.el.next) {
        this.el.next.textContent = '跳过这步';
        this.el.next.classList.remove('hidden');
      }
    },

    steps: function () { return STEPS; }
  };

  N.Tutorial = Tutorial;
})(globalThis.Naval = globalThis.Naval || {});
