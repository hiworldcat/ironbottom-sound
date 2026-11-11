/* =============================================================================
 *  view/audio.js —— 声音
 *
 *  两种来源：
 *    · 音效：全部用 WebAudio 现场合成（噪声 + 滤波 + 包络），一个素材文件都不要
 *    · 语音：tools/gen-voice.py 用 SAPI 烤好的电台英语，走 <audio> 播放
 *
 *  为什么语音要烤成文件而不是用 speechSynthesis：
 *    每台机器装的声音不一样，而且合成语音进不了效果链、加不上电台味。
 *    烤成 wav 之后任何浏览器听到的都是同一句。
 *
 *  距离感：按"视口半径"归一化。拉近看细节时远处的炮声又闷又小，
 *  拉远看全局时整片海都在响 —— 这和肉眼看到的一致。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V;
  var A = {};

  var ctx = null, master = null, comp = null, limiter = null;
  var busSfx = null, busAmb = null, busVoice = null;
  var white = null, pink = null;

  var enabled = true;
  var volume = 0.85;
  var ready = false;
  var failed = false;

  var loops = {};                 // 常驻循环：风、雨、浪、火、进水、飞机
  var voiceEls = {};              // key -> [Audio, Audio]
  var voiceIdx = {};
  var voiceReady = false;

  var stats = { sfx: 0, voice: 0, skipped: 0, events: 0 };
  var lastVoiceAt = -99;
  var voiceKeyAt = {};
  var salvoBudget = 0, lastSalvoTick = 0;

  var hookedWorld = null;
  var seen = { tracks: 0, started: false };
  var shipState = {};             // id -> {fire, flood, sinking}

  /* ------------------------------------------------------------------ 基础 */

  function now() { return ctx ? ctx.currentTime : 0; }

  function makeNoise(seconds, pinkish) {
    var n = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.random() * 2 - 1;
      if (pinkish) {
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      } else {
        d[i] = w;
      }
    }
    return buf;
  }

  function panner(pan) {
    if (!ctx.createStereoPanner) return null;
    var p = ctx.createStereoPanner();
    p.pan.value = U.clamp(pan || 0, -1, 1);
    return p;
  }

  /** 把一个节点接到总线上（可选声像） */
  function out(node, bus, pan) {
    var p = pan == null ? null : panner(pan);
    if (p) { node.connect(p); p.connect(bus); } else { node.connect(bus); }
    return node;
  }

  /** 距离 → 增益和低通截止：远了又小又闷 */
  function falloff(dist, radius) {
    var ref = Math.max(1200, radius * 0.55);
    var g = 1 / (1 + Math.pow(dist / ref, 1.6));
    var cut = 2600 * Math.exp(-dist / Math.max(3000, radius * 2.2)) + 260;
    return { gain: g, cut: cut };
  }

  function viewRadius(cam, W, H) {
    return Math.min(W, H) * 0.5 / Math.max(0.001, cam.zoom || 0.05);
  }

  /* ------------------------------------------------------------------ 音效 */

  /** 一次爆炸/炮响：噪声爆 + 低频下坠 */
  function boom(o) {
    if (!ctx || !enabled) return;
    var t0 = now() + (o.delay || 0);
    var dur = o.dur || 0.5;
    var gain = o.gain;

    var src = ctx.createBufferSource();
    src.buffer = o.pink ? pink : white;
    src.loop = true;
    src.playbackRate.value = 1;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = o.q == null ? 0.9 : o.q;
    lp.frequency.setValueAtTime(Math.max(120, o.cut), t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, o.cut * 0.28), t0 + dur);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(lp); lp.connect(g);
    out(g, busSfx, o.pan);
    src.start(t0);
    src.stop(t0 + dur + 0.05);

    if (o.thump) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(o.thump, t0);
      osc.frequency.exponentialRampToValueAtTime(o.thump * 0.42, t0 + dur * 0.75);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.linearRampToValueAtTime(gain * 0.85, t0 + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.9);
      osc.connect(og);
      out(og, busSfx, o.pan);
      osc.start(t0);
      osc.stop(t0 + dur);
    }
    stats.sfx++;
  }

  function gunSalvo(caliber, dist, pan, radius) {
    var f = falloff(dist, radius);
    if (f.gain < 0.02) { stats.skipped++; return; }
    var big = U.clamp((caliber - 76) / 130, 0, 1);          // 127mm→0.4, 203mm→1
    boom({
      cut: f.cut * (1.5 + big * 0.7),
      dur: 0.34 + big * 0.55,
      gain: f.gain * (0.22 + big * 0.20),
      thump: 95 - big * 30,
      pan: pan,
      q: 0.8
    });
  }

  function explosion(size, dist, pan, radius) {
    var f = falloff(dist, radius);
    if (f.gain < 0.02) { stats.skipped++; return; }
    boom({
      cut: f.cut * 1.1, dur: 0.9 + size * 1.5, gain: f.gain * (0.24 + size * 0.20),
      thump: 70 - size * 18, pan: pan, pink: true, attack: 0.004, q: 1.2
    });
  }

  function splash(dist, pan, radius) {
    var f = falloff(dist, radius);
    if (f.gain < 0.02) return;
    var t0 = now(), dur = 0.42;
    var src = ctx.createBufferSource(); src.buffer = white; src.loop = true;
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, t0);
    lp.frequency.exponentialRampToValueAtTime(900, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(f.gain * 0.13, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(hp); hp.connect(lp); lp.connect(g);
    out(g, busSfx, pan);
    src.start(t0); src.stop(t0 + dur + 0.03);
    stats.sfx++;
  }

  /** 金属被撕开：带通噪声 + 快速下滑的共振 */
  function metal(dist, pan, radius) {
    var f = falloff(dist, radius);
    if (f.gain < 0.03) return;
    var t0 = now(), dur = 1.1;
    var src = ctx.createBufferSource(); src.buffer = white; src.loop = true;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
    bp.frequency.setValueAtTime(1500, t0);
    bp.frequency.exponentialRampToValueAtTime(220, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(f.gain * 0.22, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g);
    out(g, busSfx, pan);
    src.start(t0); src.stop(t0 + dur + 0.05);
    stats.sfx++;
  }

  /** 警报：电机带动的蜂鸣器，锯齿波 + 快速颤音 */
  function klaxon(times) {
    if (!ctx || !enabled) return;
    times = times || 2;
    var t0 = now();
    for (var i = 0; i < times; i++) {
      var st = t0 + i * 0.42;
      var osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(168, st);
      osc.frequency.linearRampToValueAtTime(196, st + 0.34);
      var trem = ctx.createOscillator(); trem.type = 'sine'; trem.frequency.value = 9;
      var tg = ctx.createGain(); tg.gain.value = 0.5;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(0.09, st + 0.02);
      g.gain.setValueAtTime(0.09, st + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.4);
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
      trem.connect(tg); tg.connect(g.gain);
      osc.connect(lp); lp.connect(g);
      g.connect(busSfx);
      osc.start(st); osc.stop(st + 0.42);
      trem.start(st); trem.stop(st + 0.42);
    }
    stats.sfx++;
  }

  /** 水兵哨：高频、带颤、先上后下 */
  function whistle() {
    if (!ctx || !enabled) return;
    var t0 = now();
    var osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(1850, t0);
    osc.frequency.linearRampToValueAtTime(2500, t0 + 0.09);
    osc.frequency.linearRampToValueAtTime(1700, t0 + 0.42);
    var vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 22;
    var vg = ctx.createGain(); vg.gain.value = 40;
    vib.connect(vg); vg.connect(osc.frequency);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.055, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    osc.connect(g); g.connect(busSfx);
    osc.start(t0); osc.stop(t0 + 0.5);
    vib.start(t0); vib.stop(t0 + 0.5);
    stats.sfx++;
  }

  function torpedoRun(dist, pan, radius) {
    var f = falloff(dist, radius);
    if (f.gain < 0.02) return;
    var t0 = now(), dur = 1.4;
    var src = ctx.createBufferSource(); src.buffer = white; src.loop = true;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(900, t0);
    bp.frequency.linearRampToValueAtTime(2600, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(f.gain * 0.10, t0 + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g);
    out(g, busSfx, pan);
    src.start(t0); src.stop(t0 + dur + 0.05);
    stats.sfx++;
  }

  /* -------------------------------------------------------------- 常驻循环 */

  function makeLoop(name, opts) {
    var src = ctx.createBufferSource();
    src.buffer = opts.buffer;
    src.loop = true;
    var node = src;
    if (opts.filter) {
      var f = ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.value = opts.freq || 800;
      if (opts.q != null) f.Q.value = opts.q;
      node.connect(f);
      node = f;
    }
    var g = ctx.createGain();
    g.gain.value = 0.0001;
    node.connect(g);
    var pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pn) { g.connect(pn); pn.connect(busAmb); } else { g.connect(busAmb); }
    src.start(0);
    loops[name] = { src: src, filter: node === src ? null : node, gain: g, pan: pn, opts: opts };
    return loops[name];
  }

  function setLoop(name, target, tc) {
    var l = loops[name];
    if (!l) return;
    if (!isFinite(target)) target = 0;
    try { l.gain.gain.setTargetAtTime(Math.max(0.0001, target), now(), tc || 0.25); } catch (e) { }
  }

  function setLoopPan(name, pan) {
    var l = loops[name];
    if (!l || !l.pan) return;
    if (!isFinite(pan)) pan = 0;
    try { l.pan.pan.setTargetAtTime(U.clamp(pan, -1, 1), now(), 0.2); } catch (e) { }
  }

  function buildAmbience() {
    makeLoop('wind', { buffer: pink, filter: 'bandpass', freq: 520, q: 0.6 });
    makeLoop('rain', { buffer: white, filter: 'highpass', freq: 2200 });
    makeLoop('sea', { buffer: pink, filter: 'lowpass', freq: 420, q: 0.7 });
    makeLoop('fire', { buffer: white, filter: 'bandpass', freq: 1400, q: 0.9 });
    makeLoop('flood', { buffer: pink, filter: 'lowpass', freq: 700, q: 0.8 });
    makeLoop('plane', { buffer: pink, filter: 'bandpass', freq: 300, q: 1.2 });
  }

  /* ------------------------------------------------------------------ 语音 */

  var VOICE_KEYS = ['generalQuarters', 'radarContact', 'allGuns', 'fire', 'torpedo',
    'hit', 'fireOnBoard', 'flooding', 'sinking', 'targetSunk', 'ceaseFire',
    'plane', 'dcReport', 'warning', 'torpedoAway', 'contact'];

  function preloadVoice() {
    if (voiceReady || typeof Audio === 'undefined') return;
    voiceReady = true;
    for (var i = 0; i < VOICE_KEYS.length; i++) {
      var k = VOICE_KEYS[i];
      voiceEls[k] = [];
      voiceIdx[k] = 0;
      for (var j = 0; j < 2; j++) {
        var el = new Audio('assets/voice/' + k + '.wav');
        el.preload = 'auto';
        el.volume = 1;
        voiceEls[k].push(el);
      }
    }
  }

  function say(key, opts) {
    if (!enabled || A.volume <= 0.01) return false;
    if (!voiceEls[key]) return false;
    opts = opts || {};
    var t = Date.now() / 1000;
    var gap = opts.gap == null ? 1.1 : opts.gap;
    if (t - lastVoiceAt < gap) { stats.skipped++; return false; }
    var own = opts.keyGap == null ? 7 : opts.keyGap;
    if (voiceKeyAt[key] && t - voiceKeyAt[key] < own) { stats.skipped++; return false; }
    lastVoiceAt = t;
    voiceKeyAt[key] = t;

    var pool = voiceEls[key];
    var i = voiceIdx[key] % pool.length;
    voiceIdx[key] = i + 1;
    var el = pool[i];
    try {
      el.pause();
      el.currentTime = 0;
      el.volume = U.clamp(volume * (opts.gain || 1), 0, 1);
      var p = el.play();
      if (p && p.catch) p.catch(function () { });
      stats.voice++;
      duck();
    } catch (e) { }
    return true;
  }

  var duckUntil = 0;
  function duck() {
    if (!ctx || !busAmb) return;
    var t = now();
    duckUntil = t + 2.6;
    busAmb.gain.cancelScheduledValues(t);
    busAmb.gain.setTargetAtTime(0.45, t, 0.08);
  }

  /* ------------------------------------------------------------------ 挂载 */

  function attach(world) {
    if (!world || world._audioHooked) return;
    world._audioHooked = true;
    hookedWorld = world;
    seen.tracks = 0;
    seen.started = false;
    seen.contacted = false;
    seen.firstSalvo = false;
    shipState = {};

    var bus = world.bus;
    if (!bus) return;

    bus.on('salvoFired', function (e) {
      if (!enabled || !ready) return;
      var t = Date.now() / 1000;
      if (t - lastSalvoTick > 0.5) { lastSalvoTick = t; salvoBudget = 10; }
      if (salvoBudget <= 0) { stats.skipped++; return; }
      salvoBudget--;
      stats.events++;
      var sh = e.ship;
      if (!sh) return;
      if (!seen.firstSalvo && sh.side === world.playerSide) {
        seen.firstSalvo = true;
        whistle();
        say('allGuns', { gap: 0.6, keyGap: 999 });
      }
      var cam = A._cam, W = A._W, H = A._H;
      if (!cam) return;
      var p = cam.w2s(sh.pos, W, H);
      var pan = U.clamp((p.x / Math.max(1, W)) * 2 - 1, -1, 1);
      var d = V.dist(sh.pos, { x: cam.x, y: cam.y });
      var cal = 127;
      try { cal = sh.cls.guns[0].caliber; } catch (err) { }
      gunSalvo(cal, d, pan, viewRadius(cam, W, H));
    });

    bus.on('torpedoLaunch', function (e) {
      if (!ready) return;
      if (e.ship && e.ship.side === world.playerSide && e.count > 0) {
        say('torpedoAway', { gap: 2, keyGap: 9 });
      }
      var cam = A._cam; if (!cam || !e.ship) return;
      var p = cam.w2s(e.ship.pos, A._W, A._H);
      torpedoRun(V.dist(e.ship.pos, { x: cam.x, y: cam.y }),
        U.clamp((p.x / A._W) * 2 - 1, -1, 1), viewRadius(cam, A._W, A._H));
    });

    bus.on('torpedoHit', function (e) {
      if (!ready || !e.ship) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(e.ship.pos, A._W, A._H);
      var d = V.dist(e.ship.pos, { x: cam.x, y: cam.y });
      var r = viewRadius(cam, A._W, A._H);
      var pan = U.clamp((p.x / A._W) * 2 - 1, -1, 1);
      explosion(1.0, d, pan, r);
      metal(d, pan, r);
      if (e.ship.side === (hookedWorld && hookedWorld.playerSide)) {
        say('hit', { gap: 1.5 });
      }
    });

    bus.on('shipSunk', function (sh) {
      if (!ready || !sh) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(sh.pos, A._W, A._H);
      var d = V.dist(sh.pos, { x: cam.x, y: cam.y });
      var r = viewRadius(cam, A._W, A._H);
      var pan = U.clamp((p.x / A._W) * 2 - 1, -1, 1);
      explosion(1.3, d, pan, r);
      metal(d, pan, r);
      if (sh.side === world.playerSide) {
        klaxon(2);
        say('sinking', { gap: 3 });
      } else if (sh.side !== world.playerSide) {
        say('targetSunk', { gap: 4, keyGap: 10 });
      }
    });

    bus.on('shipSinking', function (sh) {
      if (!ready || !sh) return;
      var cam = A._cam; if (!cam) return;
      var d = V.dist(sh.pos, { x: cam.x, y: cam.y });
      var r = viewRadius(cam, A._W, A._H);
      if (d > r * 2) return;
      metal(d, 0, r);
    });

    bus.on('friendlyFire', function () {
      if (!ready) return;
      klaxon(1);
      say('warning', { gap: 4, keyGap: 14 });
    });

    bus.on('misId', function () {
      if (!ready) return;
      say('warning', { gap: 5, keyGap: 18 });
    });

    bus.on('grounding', function (e) {
      if (!ready || !e.ship) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(e.ship.pos, A._W, A._H);
      metal(V.dist(e.ship.pos, { x: cam.x, y: cam.y }),
        U.clamp((p.x / A._W) * 2 - 1, -1, 1), viewRadius(cam, A._W, A._H));
    });

    bus.on('collision', function (e) {
      if (!ready || !e.ship) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(e.ship.pos, A._W, A._H);
      metal(V.dist(e.ship.pos, { x: cam.x, y: cam.y }),
        U.clamp((p.x / A._W) * 2 - 1, -1, 1), viewRadius(cam, A._W, A._H));
    });

    bus.on('shipCollision', function (e) {
      if (!ready || !e.a) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(e.a.pos, A._W, A._H);
      metal(V.dist(e.a.pos, { x: cam.x, y: cam.y }),
        U.clamp((p.x / A._W) * 2 - 1, -1, 1), viewRadius(cam, A._W, A._H));
    });

    bus.on('shoreTargetDestroyed', function (t) {
      if (!ready || !t) return;
      var cam = A._cam; if (!cam) return;
      var p = cam.w2s(t.pos, A._W, A._H);
      var d = V.dist(t.pos, { x: cam.x, y: cam.y });
      explosion(1.5, d, U.clamp((p.x / A._W) * 2 - 1, -1, 1), viewRadius(cam, A._W, A._H));
    });

    bus.on('plane', function (e) {
      if (!ready) return;
      if (e.kind === 'launch') { whistle(); say('plane', { gap: 2, keyGap: 20 }); }
    });

    bus.on('battleEnd', function (r) {
      if (!ready) return;
      if (r && r.result === 'win') say('ceaseFire', { gap: 0.5, keyGap: 30 });
      else klaxon(2);
    });
  }

  /* ------------------------------------------------------------------ 每帧 */

  function tick(world, cam, W, H, dtReal) {
    if (!enabled || !ready || !world) return;
    A._cam = cam; A._W = W; A._H = H;

    /* 开场：全员就战斗岗位 */
    if (!seen.started) {
      seen.started = true;
      whistle();
      say('generalQuarters', { gap: 0, keyGap: 999 });
    }

    var env = world.env || {};
    var wx = world.weather || {};
    var radius = viewRadius(cam, W, H);

    /* --- 环境声 --- */
    var windK = U.clamp((env.windSpeed || 0) / 22, 0, 1);
    var rainK = U.clamp((wx.rain || env.rain || 0), 0, 1);
    var seaK = U.clamp((env.seaState || 0) / 5, 0, 1);
    setLoop('wind', 0.05 + windK * 0.16, 0.4);
    setLoop('rain', rainK * 0.20, 0.5);
    setLoop('sea', 0.03 + seaK * 0.09, 0.6);
    if (loops.wind && loops.wind.filter) {
      loops.wind.filter.frequency.setTargetAtTime(420 + windK * 900, now(), 0.5);
    }
    if (loops.rain && loops.rain.filter) {
      loops.rain.filter.frequency.setTargetAtTime(1500 + rainK * 1800, now(), 0.5);
    }

    /* --- 己方舰的火与进水 --- */
    var mySide = world.playerSide;
    var bestFire = 0, bestFlood = 0, firePan = 0, floodPan = 0;
    var ships = world.ships || [];
    for (var i = 0; i < ships.length; i++) {
      var s = ships[i];
      if (s.side !== mySide || s.sunk) continue;
      var p = cam.w2s(s.pos, W, H);
      if (p.x < -80 || p.x > W + 80 || p.y < -80 || p.y > H + 80) continue;
      var d = V.dist(s.pos, { x: cam.x, y: cam.y });
      var near = 1 / (1 + d / Math.max(2000, radius));
      var pan = U.clamp((p.x / W) * 2 - 1, -1, 1);
      var fk = (s.fire || 0) / 100 * near;
      var wk = (s.flood || 0) / 100 * near;
      if (fk > bestFire) { bestFire = fk; firePan = pan; }
      if (wk > bestFlood) { bestFlood = wk; floodPan = pan; }

      /* 状态跳变 → 警报 */
      var st = shipState[s.id] || (shipState[s.id] = { fire: s.fire || 0, flood: s.flood || 0, sunk: false });
      if ((s.fire || 0) >= 5 && st.fire < 5) {
        klaxon(2);
        say('fireOnBoard', { gap: 2.5, keyGap: 10 });
      }
      if ((s.flood || 0) >= 6 && st.flood < 6) {
        say('flooding', { gap: 2.5, keyGap: 12 });
      }
      st.fire = s.fire || 0;
      st.flood = s.flood || 0;
    }
    setLoop('fire', bestFire * 0.22, 0.3);
    setLoop('flood', bestFlood * 0.16, 0.4);
    setLoopPan('fire', firePan);
    setLoopPan('flood', floodPan);

    /* --- 水侦 --- */
    var planes = world.planes || [];
    var planeGain = 0, planePan = 0;
    for (var k = 0; k < planes.length; k++) {
      var pl = planes[k];
      if (!pl || pl.down) continue;
      var pp = cam.w2s(pl.pos, W, H);
      var pd = V.dist(pl.pos, { x: cam.x, y: cam.y });
      var g2 = 1 / (1 + pd / Math.max(2500, radius));
      if (g2 > planeGain) {
        planeGain = g2;
        planePan = U.clamp((pp.x / W) * 2 - 1, -1, 1);
      }
    }
    setLoop('plane', planeGain * 0.10, 0.5);
    setLoopPan('plane', planePan);
    if (loops.plane && loops.plane.filter) {
      loops.plane.filter.frequency.setTargetAtTime(240 + planeGain * 320, now(), 0.4);
    }

    /* --- 第一次拿到接触：雷达接触 --- */
    var n = 0;
    try {
      var list = N.Sensors.trackList(world, mySide);
      n = list ? list.length : 0;
    } catch (e) { n = 0; }
    if (!seen.contacted && n > 0 && world.time > 2) {
      seen.contacted = true;
      say('contact', { gap: 1.2, keyGap: 999 });
    }
    seen.tracks = n;

    /* --- 语音压低环境声，到时间恢复 --- */
    if (duckUntil && now() > duckUntil) {
      duckUntil = 0;
      busAmb.gain.setTargetAtTime(1, now(), 0.4);
    }
  }

  /* ------------------------------------------------------------------ 接口 */

  A.init = function () {
    if (ctx || failed) return ready;
    var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { failed = true; enabled = false; return false; }
    try {
      ctx = new AC();
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;

      /* 软限幅：再叠也不会数字削波。tanh 在 0.7 以下几乎是直的 */
      limiter = ctx.createWaveShaper();
      var curve = new Float32Array(1024);
      for (var i = 0; i < curve.length; i++) {
        var x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.15) / Math.tanh(1.15);
      }
      limiter.curve = curve;
      limiter.oversample = '2x';

      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(comp);
      comp.connect(limiter);
      limiter.connect(ctx.destination);

      busSfx = ctx.createGain(); busSfx.gain.value = 1; busSfx.connect(master);
      busAmb = ctx.createGain(); busAmb.gain.value = 1; busAmb.connect(master);
      busVoice = ctx.createGain(); busVoice.gain.value = 1; busVoice.connect(master);

      white = makeNoise(2, false);
      pink = makeNoise(2, true);
      buildAmbience();
      preloadVoice();
      ready = true;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    } catch (e) {
      failed = true;
      enabled = false;
      ready = false;
    }
    return ready;
  };

  A.attach = attach;
  A.tick = tick;

  A.setEnabled = function (b) {
    enabled = !!b;
    if (!enabled) {
      if (master) master.gain.setTargetAtTime(0.0001, now(), 0.05);
      for (var k in voiceEls) {
        for (var i = 0; i < voiceEls[k].length; i++) { try { voiceEls[k][i].pause(); } catch (e) { } }
      }
    } else {
      A.init();
      if (master) master.gain.setTargetAtTime(volume, now(), 0.08);
    }
  };

  A.isEnabled = function () { return enabled; };
  A.isReady = function () { return ready; };

  /** 浏览器的自动播放策略：没有用户手势，AudioContext 会一直挂着 suspended */
  A.resume = function () {
    if (ctx && ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) { }
    }
  };

  A.setVolume = function (v) {
    volume = U.clamp(v, 0, 1);
    if (master) master.gain.setTargetAtTime(volume, now(), 0.05);
  };

  A.context = function () { return ctx; };
  A._debug = function () { return { loops: loops, voices: voiceEls, busAmb: busAmb, master: master, comp: comp, busSfx: busSfx }; };
  A.volume = function () { return volume; };
  A.stats = function () { return stats; };

  /** 调试/自检用：直接触发一个声音 */
  A.play = function (name, opts) {
    if (!A.init()) return false;
    opts = opts || {};
    switch (name) {
      case 'gun': gunSalvo(opts.caliber || 127, opts.dist || 0, opts.pan || 0, opts.radius || 4000); return true;
      case 'boom': explosion(opts.size || 1, opts.dist || 0, opts.pan || 0, opts.radius || 4000); return true;
      case 'splash': splash(opts.dist || 0, opts.pan || 0, opts.radius || 4000); return true;
      case 'metal': metal(opts.dist || 0, opts.pan || 0, opts.radius || 4000); return true;
      case 'klaxon': klaxon(opts.times || 2); return true;
      case 'whistle': whistle(); return true;
      case 'torpedo': torpedoRun(opts.dist || 0, opts.pan || 0, opts.radius || 4000); return true;
      case 'voice': return say(opts.key || 'fire', { gap: 0, keyGap: 0 });
      default: return false;
    }
  };

  N.Audio = A;
})(globalThis.Naval = globalThis.Naval || {});
