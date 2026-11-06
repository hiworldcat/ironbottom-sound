/* DOM 冒烟测试：用最小 DOM 桩加载全部脚本（含渲染/HUD/输入），
 * 驱动若干帧并模拟操作，用来抓运行期错误（拼写、空引用、缺失元素等）。
 * 用法: node tools/dom-smoke-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------ 极简 DOM 桩 */
const errors = [];
function logErr(e) { errors.push(e && e.stack ? e.stack : String(e)); }

class El {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.style = {};
    this.dataset = {};
    this._cls = new Set();
    this._listeners = {};
    this._text = '';
    this._html = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientWidth = 1280;
    this.clientHeight = 800;
    this.width = 1280;
    this.height = 800;
    this.parentNode = null;
  }
  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach(x => self._cls.add(x)),
      remove: (...c) => c.forEach(x => self._cls.delete(x)),
      toggle: (c, f) => { if (f === undefined) { self._cls.has(c) ? self._cls.delete(c) : self._cls.add(c); } else if (f) self._cls.add(c); else self._cls.delete(c); },
      contains: (c) => self._cls.has(c)
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  get textContent() { return this._text; }
  set innerHTML(v) {
    this._html = String(v);
    this.children.length = 0;
    // 极简解析：把带 data-xxx 的元素做成子节点，便于 querySelectorAll 命中
    const re = /<div class="([^"]*)" data-(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(this._html))) {
      const e = new El('', 'div');
      e.className = m[1];
      e.dataset[m[2]] = m[3];
      e.parentNode = this;
      this.children.push(e);
    }
  }
  get innerHTML() { return this._html; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() { }
  dispatch(t, ev = {}) {
    const evt = Object.assign({
      target: this, currentTarget: this, preventDefault() { }, stopPropagation() { }
    }, ev);
    (this._listeners[t] || []).forEach(fn => fn.call(this, evt));
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  insertBefore(c) { return this.appendChild(c); }
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, '').split(/[\s>]/)[0];
    return this.children.filter(c => c._cls.has(cls));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setAttribute() { }
  getAttribute() { return null; }
  focus() { }
}

const textDrawn = [];
function makeCtx() {
  const grad = { addColorStop() { } };
  const ctx = {
    canvas: null,
    save() { }, restore() { }, clearRect() { }, fillRect() { }, strokeRect() { },
    beginPath() { }, moveTo() { }, lineTo() { }, closePath() { }, fill() { }, stroke() { },
    arc() { }, ellipse() { }, rect() { }, translate() { }, rotate() { }, scale() { },
    setTransform() { }, setLineDash() { }, clip() { }, quadraticCurveTo() { },
    bezierCurveTo() { }, arcTo() { }, createImageData() { return null; },
    getImageData() { return { data: [] }; }, putImageData() { },
    fillText(t) { textDrawn.push(String(t)); }, strokeText() { },
    measureText(t) { return { width: 20 }; },
    createLinearGradient() { return grad; },
    createRadialGradient() { return grad; },
    createPattern() { return null; },
    drawImage() { },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
    textBaseline: 'top', globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0
  };
  return ctx;
}

const ids = [
  'clock', 'missionTitle', 'missionSub', 'envVis', 'envWind', 'rosterList', 'rosterCount',
  'forcePower', 'forcePowerBar', 'detailEmpty', 'detailBody', 'dName', 'dClass',
  'barHull', 'txtHull', 'barFlood', 'txtFlood', 'barFire', 'txtFire', 'dStatus',
  'dSpeed', 'dHeading', 'dOrder', 'dTarget', 'dRange', 'dFire', 'dSpot',
  'dRelBrg', 'dTargetBrg', 'dBombard', 'hdgDial', 'objectiveList', 'btnStarshell',
  'mountList', 'torpList', 'torpSection', 'torpNote', 'btnEngage', 'btnTorp', 'btnSmoke',
  'speedBtns', 'log', 'logCount', 'contacts', 'contactCount', 'toast', 'overlay', 'modal',
  'modalTag', 'modalTitle', 'modalSub', 'modalBody', 'modalFoot', 'btnHelp', 'btnBrief',
  'btnFit', 'btnReplay', 'btnMenu', 'btnPause',
  'squadList', 'squadCount', 'btnSquad',
  'replayBar', 'rbPlay', 'rbSeek', 'rbClock', 'rbMarks', 'rbExit', 'rbFollow', 'rbSides',
  'dClose', 'sea',
  // 标题画面 / 战役线
  'titleScreen', 'tsCampaign', 'tsCampaignSub', 'tsFree', 'tsTutorial', 'tsHelp', 'tsProgress',
  // 新手引导
  'tutCard', 'tutStep', 'tutTitle', 'tutBody', 'tutWait', 'tutDots', 'tutNext', 'tutSkip'
];

const registry = new Map();
for (const id of ids) registry.set(id, new El(id));

const sea = registry.get('sea');
sea.getContext = () => { const c = makeCtx(); c.canvas = sea; return c; };
sea.clientWidth = 1280;
sea.clientHeight = 800;

const dial = registry.get('hdgDial');
dial.getContext = () => { const c = makeCtx(); c.canvas = dial; return c; };

// 时间倍率按钮
const timeBtns = [0, 1, 2, 5, 10].map(v => { const b = new El('', 'button'); b.dataset.scale = String(v); return b; });

const body = new El('', 'body');

// 小队面板上的分段按钮：按 data-<attr>="<val>" 惰性创建，点一次就记住状态
const SQUAD_ATTRS = {
  lines: ['1', '2', '3'],
  turn: ['line', 'together'],
  sp: ['tight', 'normal', 'wide'],
  mode: ['move', 'course']
};
const sqBtnMap = new Map();
function sqBtn(attr, val) {
  const k = attr + '=' + val;
  if (!sqBtnMap.has(k)) {
    const b = new El('', 'button');
    b.className = 'sq-b';
    b.dataset[attr] = val;
    sqBtnMap.set(k, b);
  }
  return sqBtnMap.get(k);
}

const document = {
  readyState: 'complete',
  body,
  getElementById: (id) => registry.get(id) || null,
  createElement: (tag) => new El('', tag),
  createTextNode: (t) => { const e = new El('', '#text'); e.textContent = t; return e; },
  querySelectorAll: (sel) => {
    if (sel.indexOf('tbtn') >= 0) return timeBtns;
    const m = /data-(\w+)\]/.exec(sel);
    if (m && sel.indexOf('sq-b') >= 0) return (SQUAD_ATTRS[m[1]] || []).map(v => sqBtn(m[1], v));
    return [];
  },
  querySelector: (sel) => {
    const m = /\.sq-b\[data-(\w+)="([^"]+)"\]/.exec(sel);
    if (m) return sqBtn(m[1], m[2]);
    return null;
  },
  addEventListener() { },
  removeEventListener() { }
};

let rafCb = null;
const pending = [];
const keyHandlers = [];
const window = {
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type, fn) { if (type === 'keydown') keyHandlers.push(fn); },
  removeEventListener() { },
  requestAnimationFrame(fn) { rafCb = fn; return 1; },
  cancelAnimationFrame() { },
  setTimeout(fn) { pending.push(fn); return pending.length; },
  clearTimeout() { }
};

/** 模拟一次按键 */
function keydown(key) {
  for (const fn of keyHandlers) fn({ key, preventDefault() { }, target: null });
}

const sandbox = {
  document, window, console,
  requestAnimationFrame: window.requestAnimationFrame,
  setTimeout: window.setTimeout,
  clearTimeout: () => { },
  performance: { now: () => Date.now() },
  Math, Date, JSON, Object, Array, String, Number, Boolean, Set, Map, isFinite, isNaN, parseInt, parseFloat
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctxObj = vm.createContext(sandbox);

/* ------------------------------------------------------------ 加载脚本 */
const files = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js', 'js/data/campaign.js',
  'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js', 'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/ai.js', 'js/sim/squad.js', 'js/sim/command.js',
  'js/sim/recorder.js', 'js/sim/world.js',
  'js/view/renderer.js', 'js/view/hud.js', 'js/view/screens.js', 'js/view/tutorial.js', 'js/main.js'
];

process.on('uncaughtException', logErr);

for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    vm.runInContext(code, ctxObj, { filename: f });
  } catch (e) {
    logErr(new Error('加载 ' + f + ' 失败: ' + e.message));
  }
}

const N = sandbox.Naval;
if (!N) { console.error('❌ Naval 未定义'); process.exit(1); }
if (!N.game) { console.error('❌ game 未初始化'); process.exit(1); }

/* ------------------------------------------------------------ 标题画面 */
const titleEl = registry.get('titleScreen');
if (titleEl._cls.has('hidden')) logErr(new Error('启动时标题画面应该是可见的'));
else console.log('启动 → 标题画面可见 ✓');

/* ------------------------------------------------------------ 历史战役线 */
registry.get('tsCampaign').dispatch('click');
const cpRows = registry.get('modalBody').querySelectorAll('.cp-row');
console.log('战役章节数:', cpRows.length);
if (cpRows.length !== 21) logErr(new Error('战役线章节数不对: ' + cpRows.length));
if (cpRows.length) {
  // 第一章的日期 / 名称 / 史实结果都在
  const first = cpRows[0];
  if (!first.dataset.i) logErr(new Error('章节行缺少 data-i'));
  // 点开第一章 → 战前简报
  first.dispatch('click');
  const foot = registry.get('modalFoot');
  console.log('战前简报按钮:', foot.children.length);
  if (foot.children.length < 2) logErr(new Error('战前简报按钮不足'));
  const bodyEl = registry.get('modalBody');
  if (!/cp-para/.test(bodyEl.innerHTML)) logErr(new Error('战前背景没有渲染'));
  // 返回战役线
  foot.children[0].dispatch('click');
  // 返回标题
  registry.get('modalFoot').children[0].dispatch('click');
  if (registry.get('titleScreen')._cls.has('hidden')) logErr(new Error('返回标题失败'));
  console.log('战役线 → 战前简报 → 返回标题 ✓');
}

/* ------------------------------------------------------------ 自由选择 */
registry.get('tsFree').dispatch('click');
if (!registry.get('titleScreen')._cls.has('hidden')) logErr(new Error('进自由选择后标题画面应该隐藏'));

/* ------------------------------------------------------------ 场景选择 */
const modalBody = registry.get('modalBody');
const modalFoot = registry.get('modalFoot');

const cards = modalBody.querySelectorAll('.sc-card');
console.log('场景卡片数量:', cards.length);
if (cards.length < 5) {
  console.error('❌ 场景选择列表不完整');
  process.exit(1);
}
const playable = cards.filter(c => !c._cls.has('locked'));
console.log('可玩场景:', playable.map(c => c.dataset.id).join(','));
if (playable.length < 5) {
  console.error('❌ 可玩场景数量不足');
  process.exit(1);
}
playable[0].dispatch('click');

/* ------------------------------------------------------------ 开始战斗 */
console.log('简报按钮数量:', modalFoot.children.length);
if (modalFoot.children.length === 0) {
  console.error('❌ 简报没有生成按钮');
  process.exit(1);
}
modalFoot.children[0].dispatch('click');

if (!N.game.world) { console.error('❌ 战斗没有开始'); process.exit(1); }
console.log('参战舰艇:', N.game.world.ships.length);

/* ------------------------------------------------------------ 驱动帧 */
const game = N.game;
let t = 0;
function step(ms = 16.7) {
  t += ms;
  if (rafCb) { const fn = rafCb; rafCb = null; try { fn(t); } catch (e) { logErr(e); } }
}

// 正常推进若干帧
for (let i = 0; i < 60; i++) step();
console.log('60 帧后模拟时间:', N.game.world.time.toFixed(1), 's');

/* ------------------------------------------------------------ 暂停菜单 */
try {
  const overlayEl = registry.get('overlay');
  const footEl = registry.get('modalFoot');
  const tBefore = N.game.world.time;

  registry.get('btnMenu').dispatch('click');
  if (!overlayEl._cls.has('hidden')) {
    console.log('菜单按钮 → 暂停菜单，按钮:', footEl.children.length);
    if (!N.game.paused) logErr(new Error('打开菜单后没有暂停'));
    if (footEl.children.length < 5) logErr(new Error('暂停菜单出口不足: ' + footEl.children.length));
    // 菜单打开时仿真不能继续推进
    for (let i = 0; i < 10; i++) step(50);
    if (N.game.world.time > tBefore + 0.01) logErr(new Error('菜单打开时仿真仍在推进'));

    // 继续战斗
    footEl.children[0].dispatch('click');
    if (N.game.paused) logErr(new Error('点击继续后仍然是暂停'));
    if (!overlayEl._cls.has('hidden')) logErr(new Error('点击继续后弹窗没有关闭'));

    // 再打开 → 选择任务 → 返回
    registry.get('btnMenu').dispatch('click');
    footEl.children[2].dispatch('click');       // 选择任务
    const backBtn = footEl.children[footEl.children.length - 1];
    console.log('任务选择弹窗按钮:', footEl.children.length, '最后一个:', backBtn.textContent);
    if (backBtn.textContent !== '返回') logErr(new Error('任务选择缺少返回按钮'));
    backBtn.dispatch('click');
    console.log('返回后是否回到暂停菜单:', footEl.children.length >= 5);
    if (footEl.children.length < 5) logErr(new Error('从任务选择返回后没有回到暂停菜单'));

    // Esc 关闭暂停菜单
    keydown('Escape');
    if (!overlayEl._cls.has('hidden')) logErr(new Error('Esc 没有关闭暂停菜单'));
    if (N.game.paused) logErr(new Error('Esc 关闭菜单后仍然是暂停'));

    // 顶栏暂停按钮必须能来回切换
    timeBtns[0].dispatch('click');
    if (!N.game.paused) logErr(new Error('点击暂停按钮没有暂停'));
    if (registry.get('btnPause').textContent.indexOf('继续') < 0) {
      logErr(new Error('暂停后按钮文字没有变成“继续”: ' + registry.get('btnPause').textContent));
    }
    timeBtns[0].dispatch('click');
    if (N.game.paused) logErr(new Error('再点暂停按钮没有恢复'));
    if (registry.get('btnPause').textContent.indexOf('暂停') < 0) {
      logErr(new Error('恢复后按钮文字没有变回“暂停”: ' + registry.get('btnPause').textContent));
    }
  } else {
    logErr(new Error('点击菜单按钮没有弹出暂停菜单'));
  }
} catch (e) {
  logErr(e);
}

// 模拟玩家操作
try {
  game.timeScale = 10;
  const ships = game.selectedShips();
  console.log('默认选中:', ships.map(s => s.name).join(','));
  game.orderMove({ x: 12000, y: -6000 });
  game.orderSpeed(1);
  game.toggleEngage();
  game.toggleSmoke();
  game.launchTorpedoes();
  const tracks = N.Sensors.trackList(game.world, game.world.playerSide);
  if (tracks.length) game.selectTrack(tracks[0].id);
  game.selectShip(game.world.shipsOf('US')[1].id, true);
  for (let i = 0; i < 400; i++) step(50);
  console.log('400 帧后模拟时间:', N.game.world.time.toFixed(1), 's',
    ' 接触数:', N.Sensors.trackList(game.world, game.world.playerSide).length);
} catch (e) {
  logErr(e);
}

// 小队 / 战列线
try {
  const w = N.game.world;
  const us = w.shipsOf('US').filter(s => s.cls.type !== 'AK').slice(0, 4);
  N.game.selected.clear();
  us.forEach(s => N.game.selected.add(s.id));
  N.game.formSquad();
  const sq = w.squads[0];
  if (!sq) throw new Error('编队没有生成小队');
  if (sq.shipIds.length !== 4) throw new Error('小队舰数不对: ' + sq.shipIds.length);
  for (let i = 0; i < 20; i++) step(50);          // 让 HUD 刷新一次

  const items = registry.get('squadList').querySelectorAll('.sq-item');
  console.log('小队面板条目:', items.length, '名称:', sq.name,
    '战列线:', N.Squad.lineCountOf(sq), '航向:', Math.round(sq.course));
  if (items.length !== 1) throw new Error('小队面板没有渲染出条目: ' + items.length);

  // 面板按钮：战列线 2 条 / 同转 / 右键＝方向
  const btnLines = document.querySelector('.sq-b[data-lines="2"]');
  const btnTurn = document.querySelector('.sq-b[data-turn="together"]');
  const btnMode = document.querySelector('.sq-b[data-mode="course"]');
  btnLines.dispatch('click');
  btnTurn.dispatch('click');
  btnMode.dispatch('click');
  if (N.Squad.lineCountOf(sq) !== 2) throw new Error('战列线数量没跟着按钮变');
  if (sq.turnMode !== 'together') throw new Error('转向方式没跟着按钮变');
  if (N.game.squadOrderMode !== 'course') throw new Error('右键模式没切换');
  if (!btnLines.classList.contains('on')) throw new Error('按钮没有高亮');

  // 右键＝方向：航向应当被改掉
  const before = sq.course;
  N.game.orderMove({ x: sq.anchor.x, y: sq.anchor.y + 8000 });
  if (!sq.order) throw new Error('方向命令没有下达');
  for (let i = 0; i < 60; i++) step(50);          // 6 秒，够指令延迟
  if (Math.abs(sq.course - before) < 5) throw new Error('方向命令没有生效');

  // 右键＝移动：先排进指令队列，延迟到了才有目标点
  document.querySelector('.sq-b[data-mode="move"]').dispatch('click');
  N.game.orderMove({ x: sq.anchor.x + 6000, y: sq.anchor.y });
  if (!sq.order) throw new Error('移动命令没有排进队列');
  for (let i = 0; i < 60; i++) step(50);          // 6 秒，够指令延迟
  if (!sq.goal) throw new Error('移动命令延迟后没有设目标点');
  if (!sq.route.length) throw new Error('移动命令没有生成航线');

  // Shift+右键 = 追加航路点
  N.game.orderMove({ x: sq.anchor.x + 6000, y: sq.anchor.y + 4000 }, true);
  for (let i = 0; i < 60; i++) step(50);
  if (sq.route.length !== 2) throw new Error('追加航路点后航线点数不对: ' + sq.route.length);
  console.log('小队命令: 方向→', Math.round(sq.course), '° 航路点:',
    sq.route.map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(' → '));

  // 解散
  N.game.formSquad();
  if (w.squads.length !== 0) throw new Error('再按一次 G 没有解散');
  console.log('小队解散: 剩余', w.squads.length);
} catch (e) {
  logErr(e);
}

// 继续跑到结束
try {
  let guard = 0;
  while (!N.game.world.ended && guard < 6000) { step(50); guard++; }
  console.log('结束:', N.game.world.ended, N.game.world.result && N.game.world.result.result);
  for (let i = 0; i < 30; i++) step(50);
} catch (e) {
  logErr(e);
}

// 执行挂起的 setTimeout（结算弹窗）
try {
  while (pending.length) { const fn = pending.shift(); fn(); }
  console.log('结算弹窗按钮:', modalFoot.children.length);
  if (modalFoot.children.length !== 4) logErr(new Error('结算弹窗按钮数量异常: ' + modalFoot.children.length));
} catch (e) {
  logErr(e);
}

/* ------------------------------------------------------------ 回放 */
try {
  const before = N.game.world.recorder.frames.length;
  N.game.enterReplay();
  console.log('回放模式:', N.game.mode, ' 录像帧:', before,
    ' 时长:', N.game.replay ? N.game.replay.duration.toFixed(0) + 's' : '-');
  if (N.game.mode !== 'replay') logErr(new Error('未进入回放模式'));
  for (let i = 0; i < 40; i++) step(50);
  N.game.replaySeek(N.game.replay.duration * 0.5);
  step(50);
  const pw = N.game.replay.sampleAt(N.game.replayT);
  if (!pw) logErr(new Error('回放采样返回空'));

  /* 回放溯源：放大后必须标出“这一发是谁打的 / 这条鱼雷是谁放的” */
  try {
    const rp = N.game.replay;
    // 找一段有鱼雷的录像
    let tTorp = null;
    for (const f of rp.frames) { if (f.torps && f.torps.length) { tTorp = f.t; break; } }
    N.game.replayAuto = false;                // 关掉自动跟随，否则缩放会被覆盖
    N.game.camera.zoom = 0.2;                 // 放大到能看到文字
    textDrawn.length = 0;
    if (tTorp != null) {
      N.game.replaySeek(tTorp);
      // 把镜头挪到鱼雷附近，否则标注会因为“不在画面里”而不画
      const fT = rp.frameAt(tTorp);
      const t0 = fT.torps[0];
      N.game.camera.x = t0.sx; N.game.camera.y = t0.sy;
      step(50);
      const tags = textDrawn.filter(t => t.indexOf('鱼雷') >= 0);
      console.log('回放鱼雷标注:', tags.slice(0, 3).join(' / ') || '(无)');
      if (!tags.length) logErr(new Error('放大回放后没有标注鱼雷发射舰'));
      if (!tags.some(t => t.indexOf('未发现') >= 0 || t.length > 2)) {
        logErr(new Error('鱼雷标注内容异常: ' + tags[0]));
      }
    } else {
      console.log('回放鱼雷标注: 本局没有鱼雷');
    }

    // 水柱标注
    let tSplash = null;
    for (const f of rp.frames) { if (f.splashes && f.splashes.length) { tSplash = f.t; break; } }
    textDrawn.length = 0;
    if (tSplash != null) {
      N.game.replaySeek(tSplash);
      const fS = rp.frameAt(tSplash);
      N.game.camera.x = fS.splashes[0].x; N.game.camera.y = fS.splashes[0].y;
      step(50);
      const tags = textDrawn.filter(t => /″/.test(t));
      console.log('回放水柱标注:', tags.slice(0, 3).join(' / ') || '(无)');
      if (!tags.length) logErr(new Error('放大回放后没有标注水柱发射舰'));
    }

    // 缩小时不标注，避免糊成一片
    N.game.camera.zoom = 0.01;
    textDrawn.length = 0;
    step(50);
    if (textDrawn.some(t => /″/.test(t) || t.indexOf('鱼雷') >= 0)) {
      logErr(new Error('缩小回放时仍在绘制溯源标注（会糊成一片）'));
    }
    console.log('缩小后不再标注: true');
  } catch (e) {
    logErr(e);
  }

  N.game.replayToggle();
  N.game.replaySetSpeed(4);
  step(50);
  N.game.exitReplay();
  console.log('退出回放后模式:', N.game.mode);
  if (N.game.mode !== 'live') logErr(new Error('退出回放后没有回到 live'));

  // 关键：战斗已结束，退出回放必须能回到结算界面，否则玩家卡死
  const overlay = registry.get('overlay');
  const foot = registry.get('modalFoot');
  console.log('退出回放后结算界面:', !overlay._cls.has('hidden'), ' 按钮:', foot.children.length);
  if (overlay._cls.has('hidden')) logErr(new Error('退出回放后结算界面没有重新出现（玩家会卡在最后一帧）'));
  if (foot.children.length !== 4) logErr(new Error('退出回放后结算按钮数量异常: ' + foot.children.length));

  // 再从结算界面进一次回放，确认可以反复进出
  foot.children[2].dispatch('click');
  if (N.game.mode !== 'replay') logErr(new Error('结算界面无法再次进入回放'));
  step(50);
  N.game.exitReplay();
  console.log('二次进出回放:', N.game.mode, ' 结算界面:', !overlay._cls.has('hidden'));
  if (N.game.mode !== 'live' || overlay._cls.has('hidden')) logErr(new Error('二次进出回放异常'));

  // 结算 → 选择任务 → 返回：必须回到结算，不能卡在任务列表
  foot.children[1].dispatch('click');
  const backToResult = foot.children[foot.children.length - 1];
  console.log('结算→任务选择，按钮:', foot.children.length, ' 末位:', backToResult.textContent);
  if (backToResult.textContent !== '返回') logErr(new Error('结算进入的任务选择缺少返回按钮'));
  backToResult.dispatch('click');
  console.log('返回后结算按钮:', foot.children.length, ' 可见:', !overlay._cls.has('hidden'));
  if (overlay._cls.has('hidden') || foot.children.length !== 4) {
    logErr(new Error('从任务选择返回后没有回到结算界面'));
  }
} catch (e) {
  logErr(e);
}

/* ------------------------------------------------------------ 结果 */
console.log('');
console.log('战报条数:', N.game.world.messages.length);
console.log('结算弹窗子元素:', registry.get('modalFoot').children.length);
if (errors.length) {
  console.error('\n❌ 捕获到 ' + errors.length + ' 个错误:');
  errors.slice(0, 12).forEach(e => console.error('---\n' + e));
  process.exit(1);
}
console.log('\n✅ DOM 冒烟测试通过');
