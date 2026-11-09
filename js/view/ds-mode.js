/* =====================================================================
 *  双 AI 对战 —— 两边各接一个 DeepSeek，各看各的态势图
 *  ---------------------------------------------------------------------
 *  这一层只管三件事：什么时候问、把回话交给 N.Agent 落地、把两边参谋部
 *  写的东西画在屏幕上。规则和校验都在 js/sim/agent.js，那一层不碰 DOM。
 *
 *  节奏：不暂停。战场一直在走，命令什么时候回来什么时候生效 —— 延迟是
 *  真实的，所以默认锁 1 倍速（5 倍速下一轮问答就过去 25 秒战局了）。
 *
 *  需要本地中转（tools/ds-bridge.mjs）提供 /api/ds，密钥不进网页。
 * ===================================================================== */
(function (N) {
  var Ds = {};

  var SIDES = ['US', 'JP'];
  var NAME = { US: '美军', JP: '日军' };

  var st = {
    on: false,
    game: null,
    interval: 6,          // 每 6 秒战场时间问一轮
    endpoint: '/api/ds',
    model: null,
    bridge: null,         // { ok, hasKey, model } / { ok:false, error }
    panel: null,
    rows: {},
    lastPaint: 0,
    visible: true
  };

  var agents = {};

  function newAgent(side) {
    return {
      side: side,
      busy: false,
      round: 0,
      think: '',
      orders: '',
      latency: 0,
      tokens: 0,
      error: null,
      warn: null,
      lastAt: -1e9,
      totalMs: 0
    };
  }

  /* ------------------------------------------------------------------ 面板 */

  function css() {
    if (document.getElementById('ds-style')) return;
    var s = document.createElement('style');
    s.id = 'ds-style';
    s.textContent = [
      '.ds-panel{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:60;',
      ' width:min(760px,92vw);background:rgba(8,14,20,.88);border:1px solid rgba(120,180,200,.28);',
      ' border-radius:8px;font:12px/1.5 "Segoe UI",system-ui,sans-serif;color:#cfe3ea;',
      ' box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(3px);}',
      '.ds-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(120,180,200,.18);',
      ' font-size:12px;letter-spacing:.04em;color:#8fb6c4;}',
      '.ds-head b{color:#e8f4f8;font-weight:600;}',
      '.ds-dot{width:7px;height:7px;border-radius:50%;background:#4a5a62;display:inline-block;}',
      '.ds-dot.ok{background:#49d18a;box-shadow:0 0 6px #49d18a;}',
      '.ds-dot.bad{background:#e0604a;box-shadow:0 0 6px #e0604a;}',
      '.ds-cols{display:grid;grid-template-columns:1fr 1fr;}',
      '.ds-col{padding:7px 10px;min-height:74px;}',
      '.ds-col+.ds-col{border-left:1px solid rgba(120,180,200,.18);}',
      '.ds-col h4{margin:0 0 3px;font-size:11px;font-weight:600;letter-spacing:.08em;color:#7fa6b4;}',
      '.ds-col h4 .us{color:#6fb2e8}.ds-col h4 .jp{color:#e8a06f}',
      '.ds-col .think{color:#e8f4f8;min-height:2.6em;}',
      '.ds-col .meta{margin-top:3px;color:#6d8b96;font-size:11px;}',
      '.ds-col .err{color:#e88a72;}',
      '.ds-col .ord{color:#9fc7d6;}',
      '.ds-tag{display:inline-block;margin-right:6px;padding:0 5px;border-radius:3px;',
      ' background:rgba(120,180,200,.12);color:#8fb6c4;font-size:10px;}'
    ].join('');
    document.head.appendChild(s);
  }

  function buildPanel() {
    css();
    var el = document.createElement('div');
    el.className = 'ds-panel';
    el.id = 'ds-panel';
    var head = document.createElement('div');
    head.className = 'ds-head';
    head.innerHTML = '<span class="ds-dot" id="ds-dot"></span><b>双 AI 对战</b>' +
      '<span id="ds-status">连接中…</span>';
    el.appendChild(head);

    var cols = document.createElement('div');
    cols.className = 'ds-cols';
    SIDES.forEach(function (side) {
      var c = document.createElement('div');
      c.className = 'ds-col';
      var tag = side === 'US' ? 'us' : 'jp';
      c.innerHTML = '<h4><span class="' + tag + '">' + NAME[side] + '</span> 参谋部' +
        ' <span class="ds-tag" data-r="round">第 0 轮</span>' +
        '<span class="ds-tag" data-r="lat">—</span></h4>' +
        '<div class="think" data-r="think">等待第一次判断…</div>' +
        '<div class="meta" data-r="meta"></div>';
      cols.appendChild(c);
      st.rows[side] = {
        round: c.querySelector('[data-r=round]'),
        lat: c.querySelector('[data-r=lat]'),
        think: c.querySelector('[data-r=think]'),
        meta: c.querySelector('[data-r=meta]')
      };
    });
    el.appendChild(cols);
    document.body.appendChild(el);
    st.panel = el;
  }

  function paint() {
    if (!st.panel) return;
    var dot = document.getElementById('ds-dot');
    var status = document.getElementById('ds-status');
    if (st.bridge && st.bridge.ok) {
      dot.className = 'ds-dot ok';
      status.textContent = (st.bridge.model || st.model || '') + ' · 每 ' + st.interval + ' 秒一轮 · 1 倍速';
    } else if (st.bridge) {
      dot.className = 'ds-dot bad';
      status.textContent = st.bridge.error + '（现在由内置 AI 在打）';
    }

    SIDES.forEach(function (side) {
      var a = agents[side], r = st.rows[side];
      if (!a || !r) return;
      r.round.textContent = '第 ' + a.round + ' 轮';
      r.lat.textContent = a.busy ? '思考中…' : (a.latency ? a.latency + ' ms' : '—');
      r.think.textContent = a.think || '…';
      var bits = [];
      if (a.orders) bits.push('<span class="ord">' + esc(a.orders) + '</span>');
      if (a.tokens) bits.push(a.tokens + ' tokens');
      if (a.warn) bits.push('<span class="err">' + esc(a.warn) + '</span>');
      if (a.error) bits.push('<span class="err">' + esc(a.error) + '</span>');
      r.meta.innerHTML = bits.join(' · ');
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* ------------------------------------------------------------------ 一问 */

  function ask(side) {
    var a = agents[side];
    var game = st.game;
    var world = game && game.world;
    if (!a || !world || a.busy) return;

    a.busy = true;
    var brief = N.Agent.brief(world, side);
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    fetch(st.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: st.model || undefined,
        messages: [
          { role: 'system', content: N.Agent.systemPrompt() },
          { role: 'user', content: N.Agent.userPrompt(brief) }
        ],
        temperature: 0.5,
        max_tokens: 700,
        json: true
      })
    }).then(function (r) {
      return r.json();
    }).then(function (d) {
      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      a.latency = Math.round(now - t0);
      a.totalMs += a.latency;
      if (!d || !d.ok) throw new Error((d && d.error) || '中转返回了错误');
      if (st.game.world !== world) return;    // 已经换了一局，这份回话作废

      var act = N.Agent.parse(d.text);
      var res;
      if (act) {
        res = N.Agent.apply(world, side, act);
        a.warn = null;
      } else {
        // 模型没按格式回 —— 用保守策略顶一轮，别让整条战线站着不动
        res = N.Agent.apply(world, side, N.Agent.fallback(world, side));
        a.warn = '回话不是 JSON，已用兜底策略';
      }
      a.round++;
      a.think = (act && act.think) || res.think || '（没有说明）';
      a.orders = res.applied.length ? res.applied.slice(0, 2).join(' / ') : '（没下令）';
      if (res.ignored.length) a.warn = res.ignored.slice(0, 2).join('；');
      if (d.usage && d.usage.total_tokens) a.tokens += d.usage.total_tokens;
      a.error = null;
    }).catch(function (e) {
      a.error = String((e && e.message) || e);
    }).then(function () {
      a.busy = false;
    });
  }

  /* ---------------------------------------------------------------- 中转 */

  /**
   * 问一下本地中转在不在。连上了才把两边交给代理 ——
   * 连不上就让内置 AI 继续打（画面还是动的），面板上挂个红点说明原因。
   */
  function checkBridge() {
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && d.hasKey) {
        st.bridge = d;
        if (d.model) st.model = st.model || d.model;
        if (st.game && st.game.world) st.game.world.dsControl = { US: true, JP: true };
      } else if (d && d.ok) {
        st.bridge = { ok: false, error: '中转起来了，但没设 DEEPSEEK_API_KEY' };
      } else {
        st.bridge = { ok: false, error: '中转没有响应' };
      }
      st.lastCheck = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      paint();
    }).catch(function () {
      st.bridge = { ok: false, error: '没连上本地中转 —— 先跑 node tools/ds-bridge.mjs' };
      st.lastCheck = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      paint();
    });
  }

  /* ------------------------------------------------------------------ 主循环 */

  Ds.update = function (dtReal) {
    if (!st.on || !st.game) return;
    var world = st.game.world;
    if (!world) return;

    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (!st.bridge || !st.bridge.ok) {
      // 中转还没连上：每 10 秒重试一次，连上之前由内置 AI 顶着
      if (!st.lastCheck || now - st.lastCheck > 10000) { st.lastCheck = now; checkBridge(); }
    } else if (!world.ended && !st.game.paused) {
      // 换了一局（重开场景）之后接管会掉，补回来
      if (!world.dsControl) world.dsControl = { US: true, JP: true };
      for (var i = 0; i < SIDES.length; i++) {
        var side = SIDES[i], a = agents[side];
        if (a.busy) continue;
        if (world.time - a.lastAt < st.interval) continue;
        a.lastAt = world.time;
        ask(side);
      }
    }

    if (now - st.lastPaint > 200) {
      st.lastPaint = now;
      paint();
    }
  };

  Ds.toggle = function () {
    if (!st.panel) return;
    st.visible = !st.visible;
    st.panel.style.display = st.visible ? '' : 'none';
  };

  Ds.isOn = function () { return st.on; };

  Ds.start = function (game, opts) {
    opts = opts || {};
    st.game = game;
    st.on = true;
    st.interval = opts.interval || 6;
    st.model = opts.model || null;
    if (opts.endpoint) st.endpoint = opts.endpoint;
    agents = { US: newAgent('US'), JP: newAgent('JP') };

    game.world.autopilot = true;      // 观战模式：玩家那一侧也不等人
    game.timeScale = 1;               // 1 倍速：一轮问答 2~4 秒，正好是"参谋部想一下"

    buildPanel();
    paint();
    checkBridge();

    return st;
  };

  Ds.stop = function () {
    st.on = false;
    if (st.panel && st.panel.parentNode) st.panel.parentNode.removeChild(st.panel);
    st.panel = null;
    st.rows = {};
  };

  /** 给测试/调试看的一份快照 */
  Ds.stats = function () {
    var out = {};
    SIDES.forEach(function (side) {
      var a = agents[side];
      out[side] = a ? {
        round: a.round, busy: a.busy, latency: a.latency, tokens: a.tokens,
        think: a.think, orders: a.orders, error: a.error, warn: a.warn
      } : null;
    });
    return out;
  };

  N.DsMode = Ds;
})(globalThis.Naval = globalThis.Naval || {});
