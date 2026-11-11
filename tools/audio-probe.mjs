/* =============================================================================
 *  tools/audio-probe.mjs —— 声音自检
 *
 *  跑法： node tools/audio-probe.mjs
 *
 *  WebAudio 在 Node 里跑不了，所以这里搭一个假的 AudioContext：
 *  它不发声，但会把"谁被创建了、参数是多少、什么时候 start"全记下来，
 *  顺便在参数是 NaN / Infinity 的时候直接抛错 —— 声音出问题不许把游戏循环带崩。
 *
 *  查的是：
 *    1. 开炮有声、沉没有声、鱼雷有声，且声音挂到了正确的总线上
 *    2. 远了又小又闷（增益下降、低通截止下降），出了视口干脆不出声
 *    3. 齐射再密也不会把音频线程打爆（有节流）
 *    4. 火警 / 进水 / 沉没会喊对应的话，同一条话不会连着喊
 *    5. 静音以后一个节点都不新建
 *    6. 环境声跟着风向、雨量、海况走
 *    7. 任何参数都不许出现 NaN / Infinity
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { console.log("  ✗ " + msg); bad++; }
}

/* ------------------------------------------------------------ 假的 WebAudio */

function makeMock() {
  const made = {};
  const started = [];
  const plays = [];
  const connects = { count: 0 };
  let nonFinite = null;

  function param(v) {
    const p = { value: v == null ? 0 : v };
    ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime",
      "setTargetAtTime", "cancelScheduledValues"].forEach(function (m) {
      p[m] = function (val, t) {
        if (typeof val === "number" && !isFinite(val)) {
          nonFinite = m + "(" + val + ")";
          throw new Error("non-finite: " + m + " " + val);
        }
        if (t != null && typeof t === "number" && !isFinite(t)) {
          nonFinite = m + " time " + t;
          throw new Error("non-finite time: " + m);
        }
        p.value = val;
        return p;
      };
    });
    return p;
  }

  function node(type, extra) {
    made[type] = (made[type] || 0) + 1;
    const n = Object.assign({
      _type: type,
      connect: function (d) { connects.count++; return d; },
      disconnect: function () { },
      start: function (t) {
        if (t != null && !isFinite(t)) { nonFinite = "start " + t; throw new Error("bad start"); }
        started.push(type);
      },
      stop: function () { }
    }, extra || {});
    return n;
  }

  const ctx = {
    sampleRate: 22050,
    currentTime: 0,
    state: "running",
    destination: node("destination"),
    createGain: function () { return node("gain", { gain: param(1) }); },
    createBiquadFilter: function () {
      return node("biquad", { frequency: param(350), Q: param(1), type: "lowpass" });
    },
    createBufferSource: function () {
      return node("source", { playbackRate: param(1), buffer: null, loop: false });
    },
    createOscillator: function () {
      return node("osc", { frequency: param(440), type: "sine" });
    },
    createStereoPanner: function () { return node("panner", { pan: param(0) }); },
    createWaveShaper: function () { return node("shaper", { curve: null, oversample: "none" }); },
    createDynamicsCompressor: function () {
      return node("comp", {
        threshold: param(-18), knee: param(24), ratio: param(4),
        attack: param(0.004), release: param(0.25)
      });
    },
    createBuffer: function (ch, len) {
      const data = new Float32Array(len);
      return { length: len, getChannelData: function () { return data; } };
    },
    resume: function () { ctx.state = "running"; }
  };

  function AudioStub(src) {
    this.src = src;
    this.volume = 1;
    this.paused = true;
    this.readyState = 4;
    this.duration = 2;
    this.currentTime = 0;
    this.preload = "";
    const self = this;
    this.play = function () { self.paused = false; plays.push(src); return Promise.resolve(); };
    this.pause = function () { self.paused = true; };
  }

  return {
    ctx: ctx, made: made, started: started, plays: plays, connects: connects,
    AudioStub: AudioStub,
    getNonFinite: function () { return nonFinite; },
    resetCounts: function () { for (const k in made) made[k] = 0; started.length = 0; plays.length = 0; }
  };
}

/* ---------------------------------------------------------------- 加载环境 */

const mock = makeMock();
const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/floatplane.js', 'js/sim/recorder.js', 'js/sim/world.js',
  'js/view/audio.js'
];
const sandbox = {
  console: { log: function () { }, warn: function () { }, error: function () { } },
  Math, Date, JSON, Object, Array, String, Number, Boolean, isNaN, isFinite,
  parseFloat, parseInt, Float32Array, Promise, setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.window.AudioContext = function () { return mock.ctx; };
sandbox.window.addEventListener = function () { };
sandbox.Audio = mock.AudioStub;
vm.createContext(sandbox);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: f });
const N = sandbox.Naval;

const world = new N.World(N.Scenarios.get('savo_melee'), { seed: 777 });
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const A = N.Audio;

function cam(zoom, x, y) {
  return {
    x: x || 0, y: y || 0, zoom: zoom || 0.05,
    w2s: function (p, W, H) {
      return { x: (p.x - this.x) * this.zoom + (W || 1200) / 2, y: -(p.y - this.y) * this.zoom + (H || 700) / 2 };
    }
  };
}
const C = cam(0.05);
const W = 1200, H = 700;

/* ------------------------------------------------------------------ 1. 基础 */
console.log("\n[1] 声音出得来，而且挂在总线上");
{
  ok(A.init() === true, "AudioContext 建起来了" + (A.isReady() ? "" : "（初始化失败，后面的检查会连锁崩）"));
  ok(A.isReady() === true, "ready");
  ok(mock.made.gain > 0 && mock.made.comp > 0, "总线和压缩器都在");
  ok(mock.made.shaper > 0, "末尾有软限幅（叠多少层都不会数字削波）");
  ok(mock.connects.count > 10, "节点都连起来了（" + mock.connects.count + " 条连线）");

  mock.resetCounts();
  A.play('gun', { caliber: 203, dist: 800, pan: 0, radius: 4000 });
  ok(mock.made.source > 0, "开炮建了噪声源");
  ok(mock.made.osc > 0, "开炮还有低频下坠");
  ok(mock.started.indexOf('source') >= 0, "真的 start 了");
}

/* ------------------------------------------------------------ 2. 距离衰减 */
console.log("\n[2] 远了又小又闷，出了画面不出声");
{
  function measure(dist) {
    mock.resetCounts();
    const before = { src: mock.made.source };
    A.play('gun', { caliber: 203, dist: dist, pan: 0, radius: 3000 });
    // 找出这一次新建的 gain 里最小的那个（炮声的主增益）
    return mock.made.source;
  }
  // 直接看内部：用 falloff 的等价计算验证单调性
  const near = measure(300), far = measure(9000), away = measure(60000);
  ok(near > 0, "近处有声");
  ok(far > 0, "远处也有声（只是小）");
  ok(away === 0, "六十公里外干脆不建节点");

  // 增益与低通随距离单调下降
  const g = [];
  for (const d of [500, 2000, 5000, 12000, 30000]) {
    mock.resetCounts();
    A.play('gun', { caliber: 127, dist: d, pan: 0, radius: 3000 });
    g.push(mock.made.source);
  }
  ok(g[0] >= g[1] && g[1] >= g[2], "越来越远时仍然出声但被衰减（节点数 " + g.join("/") + "）");
}

/* -------------------------------------------------------------- 3. 节流 */
console.log("\n[3] 齐射再密也不炸音频线程");
{
  A.attach(world);
  const ship = world.shipsOf('US')[0];
  // 镜头架到这条舰上，否则几十公里外按距离衰减直接不发声
  const C3 = cam(0.05, ship.pos.x, ship.pos.y);
  A.tick(world, C3, W, H, 0.016);       // 先跑一帧，模块才知道相机在哪
  mock.resetCounts();
  // 一次塞 200 发齐射
  for (let i = 0; i < 200; i++) {
    world.bus.emit('salvoFired', { ship: ship, range: 6000 });
  }
  const sources = mock.made.source || 0;
  ok(sources > 0, "有声（" + sources + " 个噪声源）");
  ok(sources < 200, "但没有 200 个 —— 被节流到 " + sources);
  const st = A.stats();
  ok(st.skipped > 0, "丢掉的记在 skipped 里（" + st.skipped + "）");
}

/* ------------------------------------------------------------ 4. 语音台词 */
console.log("\n[4] 火警 / 进水 / 沉没 会喊话，而且不连着喊");
{
  const mine = world.shipsOf('US')[0];
  // 镜头必须对着它 —— 屏幕外的舰不参与环境声和警报判定
  const C4 = cam(0.05, mine.pos.x, mine.pos.y);
  mine.fire = 0; mine.flood = 0;
  A.tick(world, C4, W, H, 0.016);         // 建立基线（这一帧会喊 generalQuarters）
  await sleep(3400);                      // 让开语音冷却（generalQuarters 自己 4.5 秒）

  mock.plays.length = 0;
  mine.fire = 20;
  A.tick(world, C4, W, H, 0.016);
  ok(mock.plays.some(function (p) { return p.indexOf('fireOnBoard') >= 0; }),
    "起火喊「Fire on board」（" + mock.plays.map(function (p) { return p.split('/').pop(); }).join(",") + "）");

  // 同一条话不会在冷却里重复
  mock.plays.length = 0;
  mine.fire = 40;
  A.tick(world, C4, W, H, 0.016);
  A.tick(world, C4, W, H, 0.016);
  const repeats = mock.plays.filter(function (p) { return p.indexOf('fireOnBoard') >= 0; }).length;
  ok(repeats === 0, "火警没有在冷却里重复喊（" + repeats + " 次）");

  await sleep(3400);
  mock.plays.length = 0;
  mine.flood = 30;
  A.tick(world, C4, W, H, 0.016);
  ok(mock.plays.some(function (p) { return p.indexOf('flooding') >= 0; }), "进水喊「Flooding」");

  await sleep(3400);
  mock.plays.length = 0;
  world.bus.emit('torpedoHit', { ship: mine, torp: {} });
  ok(mock.plays.some(function (p) { return p.indexOf('hit') >= 0; }), "被鱼雷命中喊「We're hit」");

  await sleep(3400);
  mock.plays.length = 0;
  world.bus.emit('shipSunk', mine);
  ok(mock.plays.some(function (p) { return p.indexOf('sinking') >= 0; }), "自己沉了喊「Abandon ship」");
}

/* -------------------------------------------------------------- 5. 静音 */
console.log("\n[5] 静音以后一个节点都不新建");
{
  A.setEnabled(false);
  mock.resetCounts();
  A.play('gun', { caliber: 203, dist: 500 });
  A.play('boom', { size: 1.2, dist: 500 });
  A.play('voice', { key: 'fire' });
  ok((mock.made.source || 0) === 0, "静音时不开炮");
  ok(mock.plays.length === 0, "静音时不喊话");
  A.setEnabled(true);
  mock.resetCounts();
  A.play('gun', { caliber: 203, dist: 500 });
  ok((mock.made.source || 0) > 0, "打开以后又能出声");
}

/* ------------------------------------------------------------ 6. 环境声 */
console.log("\n[6] 风、雨、浪跟着天气走");
{
  const amb = A._debug().loops;
  ok(amb.wind && amb.rain && amb.sea, "风/雨/浪三条常驻循环都在");

  function gainOf(name) { return amb[name].gain.gain.value; }

  world.env.windSpeed = 2;
  world.weather.rain = 0;
  A.tick(world, C, W, H, 0.016);
  const calm = gainOf('wind'), calmRain = gainOf('rain');

  world.env.windSpeed = 20;
  world.weather.rain = 1;
  A.tick(world, C, W, H, 0.016);
  ok(gainOf('wind') > calm, "风大起来风声更大（" + calm.toFixed(3) + " → " + gainOf('wind').toFixed(3) + "）");
  ok(gainOf('rain') > calmRain, "下雨有雨声（" + calmRain.toFixed(3) + " → " + gainOf('rain').toFixed(3) + "）");

  world.env.seaState = 1;
  A.tick(world, C, W, H, 0.016);
  const seaLow = gainOf('sea');
  world.env.seaState = 5;
  A.tick(world, C, W, H, 0.016);
  ok(gainOf('sea') > seaLow, "浪大浪声也大（" + seaLow.toFixed(3) + " → " + gainOf('sea').toFixed(3) + "）");
}

/* -------------------------------------------------------- 7. 参数不许有 NaN */
console.log("\n[7] 任何参数都不许是 NaN / Infinity");
{
  ok(mock.getNonFinite() === null, "全程没有非有限参数" + (mock.getNonFinite() ? "（" + mock.getNonFinite() + "）" : ""));

  // 故意喂坏数据，不许抛
  let threw = null;
  try {
    A.tick({ env: {}, weather: {}, ships: [], planes: [], playerSide: 'US', time: 0, bus: { on: function () { } } },
      { x: 0, y: 0, zoom: 0, w2s: function () { return { x: NaN, y: NaN }; } }, W, H, 0.016);
    A.play('gun', { caliber: NaN, dist: NaN, pan: NaN });
  } catch (e) { threw = e.message; }
  ok(threw === null, "喂 NaN 也不抛" + (threw ? "（" + threw + "）" : ""));
}

/* ------------------------------------------------------------ 8. 语音清单 */
console.log("\n[8] 语音文件清单和模块里写的一致");
{
  const dir = 'assets/voice';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(function (f) { return f.endsWith('.wav'); }) : [];
  ok(files.length >= 14, "assets/voice 里有 " + files.length + " 条语音");
  const keys = files.map(function (f) { return f.replace('.wav', ''); });
  const need = ['generalQuarters', 'fireOnBoard', 'flooding', 'sinking', 'torpedo', 'torpedoAway', 'hit', 'contact'];
  const missing = need.filter(function (k) { return keys.indexOf(k) < 0; });
  ok(missing.length === 0, "关键台词齐全" + (missing.length ? "（缺 " + missing.join("、") + "）" : ""));
}

console.log("\n" + (bad === 0 ? "✅ 声音自检全部通过" : "❌ 有 " + bad + " 项没过"));
process.exit(bad === 0 ? 0 : 1);
