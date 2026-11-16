/* =============================================================================
 *  view/video.js —— 录视频用的一层
 *
 *  三件事，都是为「把这局录下来发出去」服务的：
 *
 *    1. 隐藏界面（U）—— 面板全是 DOM，盖在画布上；藏掉之后只剩海图
 *    2. 信箱边框（B）—— 2.35:1 的黑边，画在画布上（不是 DOM 盖层），
 *       所以导出的视频和眼睛看到的一模一样
 *    3. 录制（V）—— canvas.captureStream + MediaRecorder，
 *       音频从 AudioContext 的 MediaStreamDestination 接过来，一起混进 webm
 *
 *  为什么要自己做录制而不是让人去开 OBS：
 *    canvas 是 1:1 渲染的，导出的是画布原始分辨率（HiDPI 屏上是 2 倍），
 *    没有浏览器边框、没有通知弹窗、帧率稳定。代价是——面板是 DOM，
 *    不进画布，所以导出的是「纯海图」；要带面板的画面得用 OBS 录窗口。
 * ========================================================================== */
(function (N) {
  'use strict';

  var Vd = {};

  var game = null;
  var rec = null;
  var chunks = [];
  var startedAt = 0;
  var badge = null;
  var timer = null;
  var lastUrl = null;
  var lastSize = 0;

  /* ------------------------------------------------------------ 界面开关 */

  Vd.setHud = function (on) {
    var r = game && game.renderer;
    if (r) r.hudHidden = !on;
    try {
      if (on) document.body.classList.remove('hud-off');
      else document.body.classList.add('hud-off');
    } catch (e) { }
  };

  Vd.hudOn = function () {
    var r = game && game.renderer;
    return r ? !r.hudHidden : true;
  };

  /** 2.35:1 信箱边框。ratio 传 0 / null 就是关掉 */
  Vd.setLetterbox = function (ratio) {
    var r = game && game.renderer;
    if (!r) return 0;
    return r.setLetterbox(ratio || 0);
  };

  Vd.toggleLetterbox = function () {
    Vd._ratio = Vd._ratio ? 0 : 2.35;
    Vd.setLetterbox(Vd._ratio);
    return Vd._ratio;
  };

  /* ------------------------------------------------------------ 录制徽标 */

  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'recBadge';
    badge.innerHTML = '<i></i><span>REC</span><b>0:00</b>';
    document.body.appendChild(badge);
    return badge;
  }

  function showBadge(on) {
    var b = ensureBadge();
    b.classList[on ? 'add' : 'remove']('on');
  }

  function tickBadge() {
    if (!badge) return;
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var mm = Math.floor(s / 60), ss = s % 60;
    var t = badge.querySelector('b');
    if (t) t.textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* -------------------------------------------------------------- 录制 */

  function pickMime() {
    var list = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm'
    ];
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < list.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(list[i])) return list[i];
      } catch (e) { }
    }
    return '';
  }

  Vd.isRecording = function () { return !!rec; };

  Vd.start = function () {
    if (rec) return true;
    var canvas = game && game.renderer && game.renderer.canvas;
    if (!canvas || !canvas.captureStream) {
      game.hud.toast('这个浏览器不支持画布录制');
      return false;
    }
    if (typeof MediaRecorder === 'undefined') {
      game.hud.toast('这个浏览器没有 MediaRecorder，用 OBS 录吧');
      return false;
    }
    var mime = pickMime();
    if (mime === null) {
      game.hud.toast('这个浏览器不支持 webm 录制');
      return false;
    }

    var stream;
    try {
      stream = canvas.captureStream(30);
      if (N.Audio) {
        N.Audio.init();
        N.Audio.resume();
        var as = N.Audio.captureStream();
        if (as && as.getAudioTracks().length) {
          var tracks = stream.getVideoTracks().slice();
          tracks = tracks.concat(as.getAudioTracks());
          stream = new MediaStream(tracks);
        }
      }
    } catch (e) {
      game.hud.toast('建流失败：' + e.message);
      return false;
    }

    var bps = Math.min(24e6, Math.max(6e6, canvas.width * canvas.height * 30 * 0.15));
    var opts = { videoBitsPerSecond: Math.round(bps) };
    if (mime) opts.mimeType = mime;
    try {
      rec = new MediaRecorder(stream, opts);
    } catch (e) {
      game.hud.toast('录制器起不来：' + e.message);
      rec = null;
      return false;
    }

    chunks = [];
    startedAt = Date.now();
    rec.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = function () {
      var blob = new Blob(chunks, { type: mime || 'video/webm' });
      chunks = [];
      lastSize = blob.size;
      if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) { } }
      lastUrl = URL.createObjectURL(blob);
      var name = 'ironbottom-' + ((game.world && game.world.scenario && game.world.scenario.id) || 'battle') +
        '-' + stamp() + '.webm';
      var a = document.createElement('a');
      a.href = lastUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (game && game.hud) {
        game.hud.toast('已保存 ' + name + '（' + (blob.size / 1048576).toFixed(1) + ' MB）');
      }
      rec = null;
      showBadge(false);
      if (timer) { clearInterval(timer); timer = null; }
    };
    rec.onerror = function (ev) {
      if (game && game.hud) game.hud.toast('录制出错：' + (ev.error && ev.error.message || '未知'));
    };

    // 每 2 秒切一段，浏览器崩了也不至于全丢
    rec.start(2000);
    showBadge(true);
    tickBadge();
    if (timer) clearInterval(timer);
    timer = setInterval(tickBadge, 500);
    if (game && game.hud) game.hud.toast('开始录制（V 停止）');
    return true;
  };

  Vd.stop = function () {
    if (!rec) return false;
    try { rec.stop(); } catch (e) { }
    return true;
  };

  Vd.toggle = function () {
    if (rec) { Vd.stop(); return false; }
    return Vd.start();
  };

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* -------------------------------------------------------------- 启动 */

  Vd.init = function (g) {
    game = g;
    Vd._ratio = 0;
  };

  Vd.applyParams = function (q) {
    var m;
    if (/[?&]hud=0/.test(q)) Vd.setHud(false);
    m = /[?&]letterbox=([\d.]+)/.exec(q);
    if (m) {
      var r = parseFloat(m[1]);
      Vd._ratio = (r > 1 && r < 4) ? r : 2.35;
      Vd.setLetterbox(Vd._ratio);
    } else if (/[?&]letterbox=1\b/.test(q)) {
      Vd._ratio = 2.35;
      Vd.setLetterbox(2.35);
    }
    if (/[?&]rec=1/.test(q)) Vd._autoRec = true;
  };

  /** 开战之后调用一次；?rec=1 时自动开始录 */
  Vd.afterStart = function () {
    if (!Vd._autoRec) return;
    Vd._autoRec = false;
    setTimeout(function () { Vd.start(); }, 900);
  };

  Vd.lastFile = function () {
    return { url: lastUrl, size: lastSize };
  };

  N.Video = Vd;
})(globalThis.Naval = globalThis.Naval || {});
