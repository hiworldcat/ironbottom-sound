/* =============================================================================
 *  tools/status-probe.mjs —— 海图舰况速览（血条 + 故障标签）专项自检
 *
 *  跑法： node tools/status-probe.mjs
 *
 *  查的是这几件事：
 *    1. 失效位掩码：雷达 / 电台 / 识别器 / 火控 / 舵机 / 动力 / 火炮 / 鱼雷
 *       各自能单独亮起来，正常舰一个位都不亮
 *    2. 血条：五个一级分区各算各的，掉哪块只有哪一段短
 *    3. 标签：进水、火灾、各种故障都能挂上去；好船一个标签都没有
 *    4. 录像：每帧存了分区比例和失效位，回放壳舰能一模一样地还原
 *    5. 真打一场：后半段的回放里确实有船挂着标签、血条也确实短了
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/floatplane.js', 'js/sim/recorder.js', 'js/sim/world.js',
  'js/view/renderer.js'
];
const ctx = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean,
  isNaN, parseFloat, parseInt
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
const N = ctx.Naval;

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { console.log("  ✗ " + msg); bad++; }
}

/* 渲染器只需要这两个方法就能算出血条和标签，不必真开一块画布 */
const R = N.Renderer.prototype;
const view = { shipHealth: R.shipHealth, shipTags: R.shipTags, drawShipStatus: R.drawShipStatus };

/** 假的 2D 上下文：只记 fillText，够验标签了 */
function mockCtx() {
  const texts = [];
  const c = {
    texts,
    save() { }, restore() { }, beginPath() { }, moveTo() { }, lineTo() { },
    closePath() { }, fill() { }, stroke() { }, arc() { }, ellipse() { },
    translate() { }, rotate() { }, setLineDash() { }, clip() { },
    fillRect() { }, strokeRect() { }, clearRect() { },
    fillText(t) { texts.push(String(t)); }, strokeText() { },
    measureText(t) { return { width: String(t).length * 9 }; },
    createLinearGradient() { return { addColorStop() { } }; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left",
    textBaseline: "top", globalAlpha: 1
  };
  return c;
}

const OPEN = N.MAP.at(159.60, -8.00);

function duel(usClass, jpClass, distM) {
  const sc = {
    id: 'probe_status', type: 'surface', title: 'probe', subtitle: '',
    date: '1943 年 8 月 6 日 23:30', startTime: 23 * 3600, timeOfDay: 'night',
    location: '', available: true, tags: [], floatplane: false,
    env: {
      visibility: 14000, windDir: 120, windSpeed: 8, seaState: 2, weather: '晴',
      light: 'night', sunAzimuth: 0, rain: 0
    },
    playerSide: 'US', brief: [], intel: '',
    objectives: [], zones: [], shoreTargets: [], forces: [],
    victory: { timeLimit: 0 }
  };
  sc.forces.push({
    side: 'US', group: 'TF', class: usClass, name: '檀香山', hull: '',
    x: Math.round(OPEN.x), y: Math.round(OPEN.y), heading: 90, speed: 0, role: 'flagship'
  });
  sc.forces.push({
    side: 'JP', group: 'IJN', class: jpClass, name: '夕立', hull: '',
    x: Math.round(OPEN.x + distM), y: Math.round(OPEN.y), heading: 270, speed: 0, role: 'flagship'
  });
  return new N.World(sc, { seed: 4242 });
}

/* ------------------------------------------------------------------ */
console.log('[1] 失效位：坏一个亮一个');
{
  const w = duel('neworleans', 'kagero', 9000);
  const s = w.shipsOf('US')[0];
  const F = N.Damage.FAIL;
  ok(N.Damage.failMask(s) === 0, '新舰的失效位是 0');

  s.radarDestroyed = true;
  ok((N.Damage.failMask(s) & F.RADAR) !== 0, '打掉雷达 → 雷达位亮');
  s.radarDestroyed = false;
  ok((N.Damage.failMask(s) & F.RADAR) === 0, '雷达修好（重置）→ 位熄灭');

  s.radioDestroyed = true;
  ok((N.Damage.failMask(s) & F.RADIO) !== 0, '打掉电台 → 电台位亮');
  s.radioDestroyed = false;

  s.iffDestroyed = true;
  ok((N.Damage.failMask(s) & F.IFF) !== 0, '打掉识别器 → 识别器位亮');
  s.iffDestroyed = false;

  s.fcDestroyed = true;
  ok((N.Damage.failMask(s) & F.FC) !== 0, '打掉火控指挥仪 → 火控位亮');
  s.fcDestroyed = false;

  s.rudder.destroyed = true;
  ok((N.Damage.failMask(s) & F.RUDDER) !== 0, '舵机被打烂 → 舵机位亮');
  s.rudder.destroyed = false;

  s.electrical.destroyed = true;
  ok((N.Damage.failMask(s) & F.ELEC) !== 0, '电力系统报废 → 电力位亮');
  const elecTags = view.shipTags.call(view, s).map((x) => x.t);
  ok(elecTags.indexOf('电力') >= 0, '电力坏 → 挂「电力」');
  ok(elecTags.indexOf('雷达') < 0 && elecTags.indexOf('电台') < 0 && elecTags.indexOf('识别器') < 0,
    '没电时雷达/电台/识别器不再各自挂标签（只写根因，' + elecTags.join('/') + '）');
  s.electrical.destroyed = false;
  ok(view.shipTags.call(view, s).length === 0, '电恢复 → 标签全消');

  // 五座炮塔里毁三座 → 火炮位
  let killed = 0;
  for (const m of s.mounts) { if (killed < 3) { m.disabled = true; m.destroyed = true; killed++; } }
  ok((N.Damage.failMask(s) & F.GUNS) !== 0, '一半以上的炮塔报废 → 火炮位亮');
  for (const m of s.mounts) { m.disabled = false; m.destroyed = false; }
  ok((N.Damage.failMask(s) & F.GUNS) === 0, '炮塔恢复 → 火炮位熄灭');

  const t = s.torps[0];
  t.disabled = true; t.destroyed = true;
  ok(s.torps.length > 1 && (N.Damage.failMask(s) & F.TORPS) !== 0,
    '一半以上的鱼雷管报废 → 鱼雷位亮');
  t.disabled = false; t.destroyed = false;
  ok(N.Damage.failMask(s) === 0, '全部复原 → 失效位回到 0');
}

/* ------------------------------------------------------------------ */
console.log("\n[2] 血条：五个一级分区各算各的");
{
  const w = duel('neworleans', 'kagero', 9000);
  const s = w.shipsOf('US')[0];
  const h0 = view.shipHealth.call(view, s);
  ok(h0.length === 5, '血条是五段');
  ok(h0.every((v) => v > 0.999), '新舰五段都是满的');

  // 只打上层建筑
  s.zone.superstructure = s.zoneMax.superstructure * 0.4;
  const h1 = view.shipHealth.call(view, s);
  ok(h1[1] < 0.45, '上层建筑掉到四成 → 第二段跟着掉');
  ok(h1[0] > 0.999, '船体没挨打 → 第一段还是满的');
  ok(h1[2] > 0.999, '武器没挨打 → 第三段还是满的');

  // 只打船体
  s.zone.superstructure = s.zoneMax.superstructure;
  s.hull = s.hullMax * 0.25;
  const h2 = view.shipHealth.call(view, s);
  ok(h2[0] < 0.3, '船体剩两成半 → 第一段短到底');
  ok(h2[1] > 0.999 && h2[2] > 0.999, '其它段不受影响');

  // 动力分区
  s.hull = s.hullMax;
  s.zone.power = s.zoneMax.power * 0.1;
  const h3 = view.shipHealth.call(view, s);
  ok(h3[4] < 0.15, '动力分区剩一成 → 第五段几乎空');
}

/* ------------------------------------------------------------------ */
console.log("\n[3] 标签：只在真出问题的时候挂");
{
  const w = duel('neworleans', 'kagero', 9000);
  const s = w.shipsOf('US')[0];
  ok(view.shipTags.call(view, s).length === 0, '完好的舰一个标签都不挂');

  s.flood = 12;
  let tags = view.shipTags.call(view, s).map((x) => x.t);
  ok(tags.indexOf('进水') >= 0, '进水 → 挂「进水」');
  s.flood = 0;

  s.fire = 9;
  tags = view.shipTags.call(view, s).map((x) => x.t);
  ok(tags.indexOf('火灾') >= 0, '起火 → 挂「火灾」');
  s.fire = 0;

  s.rudder.destroyed = true;
  s.fcDestroyed = true;
  tags = view.shipTags.call(view, s).map((x) => x.t);
  ok(tags.indexOf('舵机') >= 0 && tags.indexOf('火控') >= 0, '舵机 + 火控 → 两个标签都在');
  ok(tags.length === 2, '没有多余标签');
  s.rudder.destroyed = false; s.fcDestroyed = false;

  // 画出来看看
  s.flood = 20; s.fire = 15; s.radarDestroyed = true;
  const c = mockCtx();
  view.drawShipStatus.call(view, c, s, 400, 300, 40, 8, {});
  const drawn = c.texts.join(' ');
  ok(c.texts.indexOf('进水') >= 0 && c.texts.indexOf('火灾') >= 0 && c.texts.indexOf('雷达') >= 0,
    '画到画布上：「进水」「火灾」「雷达」都在（' + drawn + '）');
  ok(c.texts.filter((t) => t === '+' || /^\+\d/.test(t)).length === 0,
    '三个标签正好放得下，不用写 +N');
  s.flood = 0; s.fire = 0; s.radarDestroyed = false;

  // 超过三个要有 +N
  s.flood = 20; s.fire = 15; s.radarDestroyed = true; s.fcDestroyed = true;
  const c2 = mockCtx();
  view.drawShipStatus.call(view, c2, s, 400, 300, 40, 8, {});
  ok(c2.texts.some((t) => /^\+\d+$/.test(t)), '超过三个 → 显示 +N（' + c2.texts.join(' ') + '）');
}

/* ------------------------------------------------------------------ */
console.log("\n[4] 录像：分区比例和失效位都存下来了，回放能还原");
{
  const w = duel('neworleans', 'kagero', 7000);
  const s = w.shipsOf('US')[0];
  for (let i = 0; i < 900; i++) w.update(0.1);
  s.zone.weapons = s.zoneMax.weapons * 0.3;
  s.radarDestroyed = true;
  for (let i = 0; i < 30; i++) w.update(0.1);

  const rec = w.recorder;
  ok(!!rec && rec.frames.length > 0, '有录像（' + (rec ? rec.frames.length : 0) + ' 帧）');
  const fr = rec.frames[rec.frames.length - 1];
  const row = fr.ships.find((x) => x.id === s.id);
  ok(!!row, '最后一帧里有这条舰');
  ok(Array.isArray(row.z) && row.z.length === 5, '每帧存了五个分区比例');
  ok(row.z[2] < 45, '武器分区的比例录对了（' + row.z[2] + '%）');
  ok((row.df & N.Damage.FAIL.RADAR) !== 0, '失效位也录进去了（雷达）');

  const rp = new N.Replay(rec, w.scenario);
  const pw = rp.sampleAt(rp.frames[rp.frames.length - 1].t);
  const shell = pw && pw.ships.find((x) => x.id === s.id);
  ok(!!shell, '回放里找得到这条舰');
  if (shell) {
    ok(Array.isArray(shell.zfrac) && shell.zfrac.length === 5, '壳舰带上了分区比例');
    ok(shell.zfrac[2] < 0.45, '回放里武器段也是短的（' + Math.round(shell.zfrac[2] * 100) + '%）');
    ok((shell.failMask & N.Damage.FAIL.RADAR) !== 0, '回放里雷达标签还在');
    const tags = view.shipTags.call(view, shell).map((x) => x.t);
    ok(tags.indexOf('雷达') >= 0, '回放壳舰能直接算出「雷达」标签');
    const hb = view.shipHealth.call(view, shell);
    ok(hb[2] < 0.45, '回放壳舰的血条第三段也是短的');
  }
}

/* ------------------------------------------------------------------ */
console.log("\n[5] 真打一场：回放到后半段，图上确实有船挂着标签");
{
  const w = new N.World(N.Scenarios.get('empress_augusta'), { seed: 777, autopilot: true });
  for (let f = 0; f < 12000 && !w.ended; f++) w.update(0.1);

  const rec = w.recorder;
  const rp = new N.Replay(rec, w.scenario);
  const tMid = rec.frames[Math.floor(rec.frames.length * 0.6)].t;
  const pw = rp.sampleAt(tMid);
  let tagged = 0, shortBar = 0, total = 0, sample = '';
  for (const sh of pw.ships) {
    if (sh.sunk) continue;
    total++;
    const tags = view.shipTags.call(view, sh);
    if (tags.length) {
      tagged++;
      if (!sample) sample = sh.name + '：' + tags.map((x) => x.t).join('/');
    }
    const hb = view.shipHealth.call(view, sh);
    if (hb.some((v) => v < 0.9)) shortBar++;
  }
  ok(total > 0, '回放里有 ' + total + ' 条活着的舰');
  ok(tagged > 0, '其中 ' + tagged + ' 条挂着故障标签（例：' + sample + '）');
  ok(shortBar > 0, '其中 ' + shortBar + ' 条血条已经短了');

  // 回放里两边都要画（复盘看真相）
  ok(pw.ships.some((s) => s.side === 'US') && pw.ships.some((s) => s.side === 'JP'),
    '回放里美日双方的舰都在（两边都显示血条）');
}

console.log("");
if (bad === 0) console.log("✅ 舰况速览（血条 + 标签）自检全部通过");
else { console.log("❌ " + bad + " 项失败"); process.exitCode = 1; }
