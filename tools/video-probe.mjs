/* =============================================================================
 *  tools/video-probe.mjs —— 录视频这一层的自检
 *
 *  跑法： node tools/video-probe.mjs
 *
 *  Node 里没有画布也没有 MediaRecorder，所以这里搭三个假货：
 *    · 一个记下所有 fillRect 的假 2D 上下文（查黑边画在哪）
 *    · 一个能 captureStream 的假 canvas
 *    · 一个会按 2 秒切片吐数据的假 MediaRecorder
 *
 *  查的是：
 *    1. U 键隐藏界面之后，海图铺满整块画布（面板不再占地方）
 *    2. 2.35:1 信箱边框算得对、画得对、图例和刻度尺会避开它
 *    3. 窗口尺寸变了，黑边跟着重算
 *    4. 录制出来的流同时有视频轨和音频轨
 *    5. 停止后真的产出一个 blob 并以 .webm 下载
 *    6. 没有 MediaRecorder 的浏览器给提示，不抛异常
 *    7. ?hud=0 / ?letterbox= / ?rec=1 三个参数
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { console.log("  ✗ " + msg); bad++; }
}

/* ------------------------------------------------------------ 假 DOM */
const bodyCls = new Set();
const downloaded = [];

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.id = "";
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._cls = new Set();
    this._html = "";
    this._text = "";
    this.parentNode = null;
    this.clientWidth = 1600;
    this.clientHeight = 900;
    this.width = 1600;
    this.height = 900;
  }
  get classList() {
    const s = this;
    return {
      add: (...c) => c.forEach(x => s._cls.add(x)),
      remove: (...c) => c.forEach(x => s._cls.delete(x)),
      contains: (c) => s._cls.has(c),
      toggle: (c, f) => { if (f === undefined) { s._cls.has(c) ? s._cls.delete(c) : s._cls.add(c); } else if (f) s._cls.add(c); else s._cls.delete(c); }
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(" "); }
  set innerHTML(v) {
    this._html = String(v);
    this.children.length = 0;
    // 只要 <b> 就够了（徽标里的计时）
    const m = /<b>([^<]*)<\/b>/.exec(this._html);
    if (m) { const b = new El("b"); b.textContent = m[1]; b.parentNode = this; this.children.push(b); }
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  querySelector(sel) {
    const tag = String(sel).replace(/^[.#]/, "").toUpperCase();
    for (const c of this.children) if (c.tagName === tag) return c;
    return null;
  }
  addEventListener() { }
  removeEventListener() { }
  click() {
    if (this.tagName === "A") downloaded.push({ name: this.download, href: this.href });
  }
}

const doc = {
  body: new El("body"),
  createElement: (t) => new El(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() { },
  documentElement: new El("html")
};
// body.classList 要能记到 bodyCls 里
Object.defineProperty(doc.body, "classList", {
  get() {
    return {
      add: (...c) => c.forEach(x => bodyCls.add(x)),
      remove: (...c) => c.forEach(x => bodyCls.delete(x)),
      contains: (c) => bodyCls.has(c),
      toggle: (c, f) => { if (f === undefined) { bodyCls.has(c) ? bodyCls.delete(c) : bodyCls.add(c); } else if (f) bodyCls.add(c); else bodyCls.delete(c); }
    };
  }
});

/* ------------------------------------------------------------ 假画布 / 上下文 */
const fills = [];
function makeCtx() {
  const state = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, globalAlpha: 1, font: "", textAlign: "", textBaseline: "" };
  const noop = () => { };
  const ctx = {
    canvas: null,
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, clip: noop, stroke: noop, fill: noop, fillText: noop, strokeText: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, setLineDash: noop,
    drawImage: noop, putImageData: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}),
    clearRect: noop,
    fillRect: function (x, y, w, h) { fills.push({ x: x, y: y, w: w, h: h, style: state.fillStyle }); },
    strokeRect: noop
  };
  for (const k in state) {
    Object.defineProperty(ctx, k, {
      get() { return state[k]; },
      set(v) { state[k] = v; }
    });
  }
  return ctx;
}

const canvas = new El("canvas");
canvas.captureStream = function (fps) {
  canvas._fps = fps;
  return new MediaStream([new MediaStreamTrack("video")]);
};
canvas.getContext = () => makeCtx();

/* ------------------------------------------------------------ 假 Web 平台 */
let recInstances = [];

class MediaStreamTrack {
  constructor(kind) { this.kind = kind; }
}
class MediaStream {
  constructor(tracks) { this._t = (tracks || []).slice(); }
  getVideoTracks() { return this._t.filter(t => t.kind === "video"); }
  getAudioTracks() { return this._t.filter(t => t.kind === "audio"); }
  getTracks() { return this._t.slice(); }
}
class Blob {
  constructor(parts, opts) {
    this.parts = parts || [];
    this.size = this.parts.reduce((a, p) => a + (p.size || 0), 0);
    this.type = (opts && opts.type) || "";
  }
}
class MediaRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts || {};
    this.state = "inactive";
    this.mimeType = opts && opts.mimeType || "";
    recInstances.push(this);
  }
  start(timeslice) { this.state = "recording"; this.timeslice = timeslice; }
  stop() {
    this.state = "inactive";
    if (this._onStop) this._onStop();
  }
  static isTypeSupported(t) { return /webm/.test(t); }
}

let blobUrlSeq = 0;
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, isNaN, isFinite,
  parseFloat, parseInt, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => { },
  Blob, MediaRecorder, MediaStream, MediaStreamTrack,
  URL: { createObjectURL: () => "blob:fake/" + (++blobUrlSeq), revokeObjectURL: () => { } },
  document: doc,
  navigator: { userAgent: "probe" },
  devicePixelRatio: 1
};
sandbox.window = sandbox;
sandbox.window.innerWidth = 1600;
sandbox.window.innerHeight = 900;
sandbox.window.devicePixelRatio = 1;
sandbox.window.addEventListener = function () { };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ["js/core.js", "js/view/renderer.js", "js/view/video.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
}
const N = sandbox.Naval;

/* ------------------------------------------------------------ 组装一个 game */
const renderer = new N.Renderer(canvas);
const toasts = [];
const game = {
  renderer: renderer,
  world: { scenario: { id: "savo_melee" } },
  hud: { toast: (t) => toasts.push(t) }
};
N.Audio = {
  init() { }, resume() { },
  captureStream() { return new MediaStream([new MediaStreamTrack("audio")]); }
};
N.Video.init(game);

/* ------------------------------------------------------------ 1. 隐藏界面 */
console.log("\n[1] U 隐藏界面之后，海图铺满整块画布");
{
  const before = renderer.usable();
  ok(before.x > 0 && before.w < renderer.W, "有界面时海图要让开面板（x=" + before.x + " w=" + before.w + "）");

  N.Video.setHud(false);
  ok(renderer.hudHidden === true, "renderer 知道界面藏了");
  ok(bodyCls.has("hud-off"), "body 上挂了 hud-off（CSS 靠它隐藏面板）");
  ok(N.Video.hudOn() === false, "hudOn() 返回 false");

  const after = renderer.usable();
  ok(after.x === 0 && after.y === 0, "海图从左上角开始");
  ok(after.w === renderer.W && after.h === renderer.H, "铺满整块画布（" + after.w + "×" + after.h + "）");

  N.Video.setHud(true);
  ok(renderer.hudHidden === false && !bodyCls.has("hud-off"), "U 再按一次恢复");
  const back = renderer.usable();
  ok(back.x === before.x && back.w === before.w, "恢复之后海图重新让开面板");
}

/* ------------------------------------------------------------ 2. 信箱边框 */
console.log("\n[2] 2.35:1 信箱边框：算得对、画得对、图例避开");
{
  renderer.W = 1600; renderer.H = 900;
  const bars = renderer.setLetterbox(2.35);
  const want = Math.round((900 - 1600 / 2.35) / 2);
  ok(bars === want, "黑边高度 " + bars + " px（应为 " + want + "）");
  ok(renderer.bars === want, "renderer.bars 同步了");

  const u = renderer.usable();
  ok(u.y === 56 + want, "可用区顶边让开黑边（y=" + u.y + "）");
  ok(u.y + u.h === 900 - 152 - want, "可用区底边也让开（底=" + (u.y + u.h) + "）");

  fills.length = 0;
  const ctx = renderer.ctx;
  renderer.drawLetterbox(ctx, 1600, 900);
  ok(fills.length === 2, "画了两条黑边（" + fills.length + "）");
  ok(fills[0].y === 0 && fills[0].h === want, "上边贴顶、高度对");
  ok(fills[1].y === 900 - want && fills[1].h === want, "下边贴底、高度对");
  ok(fills[0].style === "#000", "是黑的");

  renderer.setLetterbox(0);
  ok(renderer.bars === 0, "关掉之后没有黑边");
  fills.length = 0;
  renderer.drawLetterbox(renderer.ctx, 1600, 900);
  ok(fills.length === 0, "关掉之后不画");
}

/* ------------------------------------------------------------ 3. 窗口变化 */
console.log("\n[3] 窗口尺寸变了，黑边跟着重算");
{
  renderer.setLetterbox(2.35);
  const h1 = renderer.bars;
  // 换成 16:9 更矮的窗口
  canvas.clientWidth = 1600; canvas.clientHeight = 700;
  renderer.resize();
  const h2 = renderer.bars;
  ok(h2 !== h1, "窗口变矮之后黑边重算了（" + h1 + " → " + h2 + "）");
  ok(h2 === Math.round((700 - 1600 / 2.35) / 2), "算出来的高度对");
  renderer.setLetterbox(0);
  canvas.clientWidth = 1600; canvas.clientHeight = 900;
  renderer.resize();
}

/* ------------------------------------------------------------ 4. 录制 */
console.log("\n[4] 录制：视频轨 + 音频轨，停止后落盘");
{
  recInstances = [];
  const started = N.Video.start();
  ok(started === true, "开始录制");
  ok(recInstances.length === 1, "起了一个 MediaRecorder");

  const r = recInstances[0];
  ok(r.state === "recording", "在录");
  const vt = r.stream.getVideoTracks(), at = r.stream.getAudioTracks();
  ok(vt.length === 1, "流里有 1 条视频轨");
  ok(at.length === 1, "流里有 1 条音频轨（画面和声音一起录）");
  ok(canvas._fps === 30, "画布按 30 帧取流");
  ok(r.opts.videoBitsPerSecond >= 6e6, "码率给足了（" + Math.round(r.opts.videoBitsPerSecond / 1e6) + " Mbps）");
  ok(/webm/.test(r.opts.mimeType), "容器是 webm（" + r.opts.mimeType + "）");
  ok(r.timeslice === 2000, "每 2 秒切一段，崩了也不全丢");

  ok(N.Video.isRecording() === true, "isRecording() 为真");

  // 喂两段数据再停
  r.ondataavailable({ data: { size: 5000 } });
  r.ondataavailable({ data: { size: 7000 } });
  downloaded.length = 0;
  N.Video.stop();
  ok(r.state === "inactive", "停止后状态对");

  // onstop 是异步挂上去的，手动触发
  r.onstop();
  ok(downloaded.length === 1, "触发了一次下载");
  ok(/^ironbottom-savo_melee-\d{8}-\d{6}\.webm$/.test(downloaded[0].name),
    "文件名带场景和日期（" + downloaded[0].name + "）");
  ok(N.Video.lastFile().size === 12000, "blob 大小是两段之和（" + N.Video.lastFile().size + "）");
  ok(N.Video.isRecording() === false, "停完 isRecording() 为假");
  ok(toasts.some(t => /已保存/.test(t)), "给了保存提示");
}

/* ------------------------------------------------------------ 5. 降级 */
console.log("\n[5] 不支持录制的浏览器给提示，不抛异常");
{
  const saved = sandbox.MediaRecorder;
  sandbox.MediaRecorder = undefined;
  let threw = null, ret;
  try { ret = N.Video.start(); } catch (e) { threw = e.message; }
  ok(threw === null, "没有 MediaRecorder 也不抛");
  ok(ret === false, "返回 false");
  ok(toasts.some(t => /MediaRecorder|不支持/.test(t)), "提示了原因");
  sandbox.MediaRecorder = saved;

  // 画布不支持 captureStream
  const savedCap = canvas.captureStream;
  canvas.captureStream = undefined;
  toasts.length = 0;
  let threw2 = null;
  try { N.Video.start(); } catch (e) { threw2 = e.message; }
  ok(threw2 === null && toasts.some(t => /不支持/.test(t)), "画布不支持也给提示");
  canvas.captureStream = savedCap;
}

/* ------------------------------------------------------------ 6. URL 参数 */
console.log("\n[6] ?hud=0 / ?letterbox= / ?rec=1");
{
  N.Video.setHud(true);
  renderer.setLetterbox(0);
  N.Video.applyParams("?autostart=1&hud=0");
  ok(renderer.hudHidden === true, "hud=0 隐藏界面");

  N.Video.setHud(true);
  N.Video.applyParams("?letterbox=2.35");
  ok(renderer.bars > 0, "letterbox=2.35 有黑边（" + renderer.bars + " px）");

  N.Video.applyParams("?letterbox=1");
  ok(renderer.bars > 0, "letterbox=1 也当 2.35 处理");

  N.Video.applyParams("?rec=1");
  ok(N.Video._autoRec === true, "rec=1 记下了，开战后自动开录");

  renderer.setLetterbox(0);
}

console.log("\n" + (bad === 0 ? "✅ 录视频自检全部通过" : "❌ 有 " + bad + " 项没过"));
process.exit(bad === 0 ? 0 : 1);
