/* ==========================================================================
 *  screens.js —— 标题画面 / 历史战役线 / 战前简报 / 战后史实
 *
 *  只碰 DOM，不碰仿真。所有“进入战斗”的动作都通过回调交回 main.js。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U;

  var Screens = {
    game: null,
    el: {},

    init: function (game) {
      this.game = game;
      var $ = function (id) { return document.getElementById(id); };
      this.el = {
        title: $('titleScreen'),
        campaignBtn: $('tsCampaign'),
        campaignSub: $('tsCampaignSub'),
        freeBtn: $('tsFree'),
        tutorialBtn: $('tsTutorial'),
        helpBtn: $('tsHelp'),
        progress: $('tsProgress')
      };

      var self = this;
      if (this.el.campaignBtn) {
        this.el.campaignBtn.addEventListener('click', function () { self.openCampaign(); });
      }
      if (this.el.freeBtn) {
        this.el.freeBtn.addEventListener('click', function () {
          self.hideTitle();
          if (self.onFree) self.onFree();
        });
      }
      if (this.el.tutorialBtn) {
        this.el.tutorialBtn.addEventListener('click', function () {
          self.hideTitle();
          if (self.onTutorial) self.onTutorial();
        });
      }
      if (this.el.helpBtn) {
        this.el.helpBtn.addEventListener('click', function () {
          game.hud.showHelp(function () { self.showTitle(); });
        });
      }
      this.refreshProgress();
    },

    /* ------------------------------------------------------------ 标题画面 */
    showTitle: function () {
      if (this.el.title) this.el.title.classList.remove('hidden');
      this.refreshProgress();
    },

    hideTitle: function () {
      if (this.el.title) this.el.title.classList.add('hidden');
    },

    isTitleVisible: function () {
      return !!this.el.title && !this.el.title.classList.contains('hidden');
    },

    refreshProgress: function () {
      if (!N.Campaign) return;
      var total = N.Campaign.chapters().length;
      var done = N.Campaign.clearedCount();
      if (this.el.progress) {
        this.el.progress.textContent = done
          ? '已通关 ' + done + ' / ' + total + ' 场'
          : '尚未通关任何战役 · 从第一章开始';
      }
      if (this.el.campaignSub) {
        var next = N.Campaign.nextPlayable();
        if (done >= total) {
          this.el.campaignSub.textContent = '全部 ' + total + ' 场已通关 · 可以重打任意一场';
        } else if (done) {
          this.el.campaignSub.textContent = '下一场：' + next.name;
        } else {
          this.el.campaignSub.textContent = total + ' 场真实海战 · 按时间推进';
        }
      }
    },

    /* ------------------------------------------------------------ 战役线 */
    openCampaign: function () {
      var self = this;
      var hud = this.game.hud;
      var chapters = N.Campaign.chapters();
      var body = '<div class="sc-intro">按真实时间排列的 ' + N.Campaign.chapters().length + ' 场所罗门群岛海战。' +
        '通关一章解锁下一章；每一章都有战前背景与战后史实。</div>';

      body += '<div class="cp-list">';
      for (var i = 0; i < chapters.length; i++) {
        var c = chapters[i];
        var done = N.Campaign.isCleared(c.id);
        var open = N.Campaign.isUnlocked(i);
        var cls = done ? 'done' : (open ? 'open' : 'locked');
        body += '<div class="cp-row ' + cls + '" data-i="' + i + '">' +
          '<div class="cp-rail"><div class="cp-n">' + (i + 1) + '</div><div class="cp-line"></div></div>' +
          '<div class="cp-main">' +
          '<div class="cp-top">' +
          '<span class="cp-date">' + c.date + '</span>' +
          '<span class="cp-name">' + c.name + '</span>' +
          '<span class="cp-res ' + c.resultKind + '">' + c.result + '</span>' +
          '</div>' +
          '<div class="cp-place">' + c.place + '</div>' +
          '<div class="cp-state">' + (done ? '✓ 已通关' : (open ? '可挑战' : '未解锁 · 先打完上一场')) + '</div>' +
          '</div></div>';
      }
      body += '</div>';

      hud.el.modalTag.textContent = '历史战役';
      hud.el.modalTitle.textContent = '所罗门群岛 1942 — 1943';
      hud.el.modalSub.textContent = '已通关 ' + N.Campaign.clearedCount() + ' / ' + chapters.length + ' 场';
      hud.el.modalBody.innerHTML = body;
      hud.el.modalFoot.innerHTML = '';

      var back = document.createElement('button');
      back.className = 'btn-ghost';
      back.textContent = '返回标题';
      back.addEventListener('click', function () { hud.hideOverlay(); self.showTitle(); });
      hud.el.modalFoot.appendChild(back);

      hud.el.overlay.classList.remove('hidden');
      hud.el.modal.scrollTop = 0;

      var rows = hud.el.modalBody.querySelectorAll('.cp-row');
      for (var k = 0; k < rows.length; k++) {
        rows[k].addEventListener('click', function () {
          var idx = parseInt(this.dataset.i, 10);
          if (!N.Campaign.isUnlocked(idx)) {
            hud.toast('先打完上一场', 'warn');
            return;
          }
          hud.hideOverlay();
          self.openChapter(N.Campaign.chapters()[idx]);
        });
      }
    },

    /* ------------------------------------------------------------ 战前简报 */
    openChapter: function (chapter) {
      var self = this;
      var hud = this.game.hud;
      var sc = N.Scenarios.get(chapter.scenario);
      if (!sc) { hud.toast('这一章的场景不存在', 'bad'); return; }

      var body = '<div class="cp-banner">' +
        '<div class="cb-k">战前背景 · ' + chapter.date + '</div>' +
        '<div class="cb-v">' + chapter.name + ' · ' + chapter.place + '</div>' +
        '</div>';
      for (var i = 0; i < chapter.pre.length; i++) {
        body += '<p class="cp-para">' + chapter.pre[i] + '</p>';
      }

      body += '<div class="intel-box"><div class="ib-label">这一仗你要做什么</div>' +
        sc.title + '<br>' + (sc.brief && sc.brief.length ? sc.brief[sc.brief.length - 1] : '') +
        '</div>';

      if (N.Weather && sc.env) {
        body += '<div class="wx-forecast"><span class="wf-k">天气预报</span>' +
          '<span class="wf-v">' + N.Weather.forecast(sc.env) + '</span>' +
          '<span class="wf-note">实际会变 —— 风浪雨一直在动，雷达和瞭望都跟着变</span></div>';
      }

      if (sc.objectives && sc.objectives.length) {
        body += '<div class="obj-list">';
        sc.objectives.forEach(function (o) {
          body += '<div class="obj-item' + (o.kind === 'secondary' ? ' secondary' : '') + '">' +
            '<span class="ob-mark">' + (o.kind === 'secondary' ? '◇' : '◆') + '</span>' +
            '<span>' + o.text + '</span></div>';
        });
        body += '</div>';
      }

      hud.el.modalTag.textContent = '第 ' + (N.Campaign.chapters().indexOf(chapter) + 1) + ' 章 · 战前';
      hud.el.modalTitle.textContent = sc.title;
      hud.el.modalSub.textContent = sc.date + ' · ' + sc.location;
      hud.el.modalBody.innerHTML = body;
      hud.el.modalFoot.innerHTML = '';

      var go = document.createElement('button');
      go.className = 'btn-primary';
      go.textContent = '进入战位';
      go.addEventListener('click', function () {
        hud.hideOverlay();
        if (self.onStartScenario) self.onStartScenario(sc, chapter);
      });

      var back = document.createElement('button');
      back.className = 'btn-ghost';
      back.textContent = '返回战役线';
      back.addEventListener('click', function () { hud.hideOverlay(); self.openCampaign(); });

      hud.el.modalFoot.appendChild(back);

      // 打过的章节可以单独回看战后史实
      if (N.Campaign.isCleared(chapter.id)) {
        var post = document.createElement('button');
        post.className = 'btn-ghost';
        post.textContent = '战后史实';
        post.addEventListener('click', function () { self.showPostOnly(chapter); });
        hud.el.modalFoot.appendChild(post);
      }

      hud.el.modalFoot.appendChild(go);
      hud.el.overlay.classList.remove('hidden');
      hud.el.modal.scrollTop = 0;
    },

    /** 单独看一章的战后史实（不带战果对照） */
    showPostOnly: function (chapter) {
      var self = this;
      var hud = this.game.hud;
      var body = '<div class="cp-after">' +
        '<div class="cp-res-big ' + chapter.resultKind + '">史实：' + chapter.result + '</div>';
      for (var i = 0; i < chapter.post.length; i++) {
        body += '<p class="cp-para">' + chapter.post[i] + '</p>';
      }
      body += '</div>';

      hud.el.modalTag.textContent = '战后史实';
      hud.el.modalTitle.textContent = chapter.name;
      hud.el.modalSub.textContent = chapter.dateText + ' · ' + chapter.place;
      hud.el.modalBody.innerHTML = body;
      hud.el.modalFoot.innerHTML = '';

      var back = document.createElement('button');
      back.className = 'btn-ghost';
      back.textContent = '返回';
      back.addEventListener('click', function () { self.openChapter(chapter); });
      hud.el.modalFoot.appendChild(back);
      hud.el.overlay.classList.remove('hidden');
      hud.el.modal.scrollTop = 0;
    },

    /* ------------------------------------------------------------ 战后史实 */
    /** 结算页里追加的「史实」区块 */
    aftermathHtml: function (chapter, world) {
      if (!chapter) return '';
      var sum = world.summary();
      var r = (sum.result && sum.result.result) || 'draw';
      var mine = { win: '任务达成', loss: '任务失败', draw: '脱离接触' }[r] || '结束';

      var html = '<div class="cp-after" style="margin-top:26px;padding-top:18px;border-top:1px solid var(--line)">' +
        '<div class="cp-banner"><div class="cb-k">战后史实 · ' + chapter.dateText + '</div>' +
        '<div class="cb-v">' + chapter.name + '</div></div>' +
        '<div class="cp-res-big ' + chapter.resultKind + '">史实：' + chapter.result + '</div>';

      for (var i = 0; i < chapter.post.length; i++) {
        html += '<p class="cp-para">' + chapter.post[i] + '</p>';
      }

      html += '<div class="cp-vs">' +
        '<div class="cp-vs-cell hist"><div class="vc-k">历史上发生了什么</div>' +
        '<div class="vc-v">' + chapter.result + '</div></div>' +
        '<div class="cp-vs-cell"><div class="vc-k">你这一仗</div>' +
        '<div class="vc-v">' + mine + ' · 我方战力 ' + Math.round(sum.own.power * 100) + '%' +
        ' · 损失 ' + sum.own.sunk + ' 艘</div></div>' +
        '</div></div>';
      return html;
    },

    /** 结算页里追加的按钮：下一场 */
    aftermathButtons: function (chapter, onNext) {
      var next = N.Campaign.nextOf(chapter.id);
      var btn = document.createElement('button');
      if (!next) {
        btn.className = 'btn-ghost';
        btn.textContent = '战役线已通关';
        btn.disabled = true;
        return btn;
      }
      btn.className = 'btn-primary';
      btn.textContent = '下一场：' + next.name;
      btn.addEventListener('click', function () {
        this.game.hud.hideOverlay();
        onNext && onNext(next);
      }.bind(this));
      return btn;
    }
  };

  N.Screens = Screens;
})(globalThis.Naval = globalThis.Naval || {});
