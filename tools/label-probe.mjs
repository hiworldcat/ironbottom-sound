/* =============================================================================
 *  tools/label-probe.mjs —— 海图标签分级 / 避让 / 图例 专项自检
 *
 *  跑法： node tools/label-probe.mjs
 *
 *  查的是这几件事：
 *    1. 舰名分三档：拉远只剩前两个字，再远不画；中等只有舰名；近处才带航速
 *    2. 避让：同一块地方只让一个标签落脚，挤不下就退成一行，再挤不下就跳过
 *    3. 血条：远景里满血的舰不占地方，太远了整条都不画
 *    4. 图例：十一种故障标签、四种接触符号、五段血条说明一个都不能少
 *    5. 可用区域：图例和刻度尺要落在面板没盖住的那块里
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

/** 假的 2D 上下文：记下所有画过的文字和矩形 */
function mockCtx() {
  const texts = [], rects = [];
  return {
    texts, rects,
    save() { }, restore() { }, beginPath() { }, moveTo() { }, lineTo() { },
    closePath() { }, fill() { }, stroke() { }, arc() { }, ellipse() { },
    translate() { }, rotate() { }, setLineDash() { }, clip() { }, scale() { },
    quadraticCurveTo() { }, rect() { },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: true }); },
    strokeRect() { },
    clearRect() { },
    fillText(t, x, y) { texts.push({ t: String(t), x, y }); },
    strokeText() { },
    measureText(t) { return { width: String(t).length * 9 }; },
    createLinearGradient() { return { addColorStop() { } }; },
    createRadialGradient() { return { addColorStop() { } }; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left",
    textBaseline: "top", globalAlpha: 1
  };
}

/* 不需要构造函数：这些方法只用到 this.W / this.H / this._labels */
function bareRenderer(W, H) {
  const r = Object.create(N.Renderer.prototype);
  r.W = W || 1600;
  r.H = H || 900;
  r._labels = [];
  return r;
}

const world = new N.World(N.Scenarios.get('savo_melee'), { seed: 777 });
const ship = world.shipsOf('US')[0];

/* ------------------------------------------------------------ 1. 档位 */
console.log("\n[1] 舰名分档：拉远了只剩两个字，再远不画");
{
  const cases = [
    [0.20, 3, '近处'],
    [0.080, 3, '中近'],
    [0.060, 3, '中等'],
    [0.040, 2, '偏中'],
    [0.020, 1, '远景'],
    [0.012, 1, '很远'],
    [0.006, 0, '极远']
  ];
  for (const [zoom, tier, name] of cases) {
    const r = bareRenderer();
    const c = mockCtx();
    r.drawShipName(c, ship, 400, 300, 20, zoom, {});
    const t = c.texts.length ? c.texts[0].t : null;
    if (tier === 0) {
      ok(t === null, `${name} zoom=${zoom}：不画（实际 ${t === null ? '没画' : JSON.stringify(t)}）`);
    } else if (tier === 1) {
      ok(t !== null && t.length <= 2 && !t.includes('kn'),
        `${name} zoom=${zoom}：只留两个字「${t}」`);
    } else if (tier === 2) {
      ok(t === ship.name, `${name} zoom=${zoom}：只有舰名「${t}」`);
    } else {
      ok(t !== null && t.startsWith(ship.name) && t.includes('kn'),
        `${name} zoom=${zoom}：舰名 + 航速「${t}」`);
    }
  }
}

/* ------------------------------------------------------------ 2. 避让 */
console.log("\n[2] 避让：一块地方只让一个标签落脚");
{
  const r = bareRenderer();
  const c = mockCtx();
  const first = r.drawShipName(c, ship, 400, 300, 20, 0.2, {});
  const second = r.drawShipName(c, ship, 400, 300, 20, 0.2, {});
  ok(first === true, '第一次画得下');
  ok(second === false, '同一位置第二次被挡掉');
  ok(c.texts.length === 1, `只画了一次（实际 ${c.texts.length} 次）`);

  // 挪开一点就够了
  const third = r.drawShipName(c, ship, 400, 340, 20, 0.2, {});
  ok(third === true, '往下挪 40 像素就能画');
  ok(c.texts.length === 2, '两行字，不叠');

  // 相邻但不重叠的矩形要放行
  r._labels = [];
  r.reserveLabel(0, 0, 50, 14);
  ok(r.labelFits(60, 0, 50, 14) === true, '隔开 10 像素算空');
  ok(r.labelFits(40, 0, 50, 14) === false, '压到边缘算占');
  ok(r.labelFits(0, 30, 50, 14) === true, '上下错开算空');
}

/* ------------------------------------------------------------ 3. 血条 */
console.log("\n[3] 血条：远景里满血的舰不占地方");
{
  const healthy = world.shipsOf('US').filter(s => !s.sunk && s.hull >= s.hullMax)[0] || ship;
  const r = bareRenderer();

  let c = mockCtx();
  r.drawShipStatus(c, healthy, 300, 300, 20, 6, { zoom: 0.2 });
  const nearBars = c.rects.length;
  ok(nearBars > 0, `近处满血舰也画血条（${nearBars} 个矩形）`);

  c = mockCtx();
  r.drawShipStatus(c, healthy, 300, 300, 20, 6, { zoom: 0.02, hurtOnly: true });
  ok(c.rects.length === 0, '远景里满血舰不画血条');

  const hurt = world.shipsOf('US').filter(s => !s.sunk && s.hull < s.hullMax)[0];
  if (hurt) {
    c = mockCtx();
    r.drawShipStatus(c, hurt, 300, 300, 20, 6, { zoom: 0.02, hurtOnly: true });
    ok(c.rects.length > 0, '远景里挨了打的舰照样画');
  } else {
    console.log("  · 这一局没有受伤的舰，跳过");
  }

  c = mockCtx();
  r.drawShipStatus(c, hurt || ship, 300, 300, 20, 6, { zoom: 0.004 });
  ok(c.rects.length === 0 && c.texts.length === 0, '缩放 0.004 时整条都不画');
}

/* ------------------------------------------------------------ 4. 图例 */
console.log("\n[4] 图例：该有的字一个都不能少");
{
  const r = bareRenderer(1600, 900);
  const c = mockCtx();
  r.drawLegend(c, world, 1600, 900);
  const all = c.texts.map(t => t.t).join('|');

  ok(all.includes('图例'), '有标题');
  ok(all.includes('舰体') && all.includes('上层') && all.includes('武器') &&
     all.includes('通讯') && all.includes('动力'), '五段血条的名字都在');

  const tags = ['进水', '火灾', '火炮', '鱼雷', '舵机', '动力', '电力', '火控', '雷达', '电台', '识别器'];
  const missing = tags.filter(t => !all.includes(t));
  ok(missing.length === 0, `十一种故障标签全在${missing.length ? '（缺 ' + missing.join('、') + '）' : ''}`);

  ok(all.includes('未识别接触') && all.includes('已识别') &&
     all.includes('电探辐射源') && all.includes('炮口闪光'), '四种接触符号都在');
  ok(all.includes('>66%') && all.includes('<33%'), '血条颜色档位写清楚了');
  ok(all.includes('按 ? 收起'), '写明了怎么收起');

  // 图例必须落在可用区域里，不能跑到面板底下
  const u = r.usable();
  ok(c.rects.length > 0, '图例画了底框');
  const box = c.rects[0];
  ok(box.x >= u.x && box.y >= u.y &&
     box.x + box.w <= u.x + u.w && box.y + box.h <= u.y + u.h,
    `底框 (${Math.round(box.x)},${Math.round(box.y)} ${box.w}×${box.h}) 在可用区域 (${u.x},${u.y} ${u.w}×${u.h}) 里`);

  // 收起来以后一个像素都不许画
  r.showLegend = false;
  const c2 = mockCtx();
  r.drawLegend(c2, world, 1600, 900);
  ok(c2.texts.length === 0 && c2.rects.length === 0, 'showLegend=false 时什么都不画');
}

/* ------------------------------------------------------ 5. 可用区域 */
console.log("\n[5] 可用区域：面板让开以后剩下的那块");
{
  const r = bareRenderer(1600, 900);
  const u = r.usable();
  ok(u.x === 234 && u.y === 56, `左边让出 234、上边让出 56（实际 ${u.x} / ${u.y}）`);
  ok(u.w === 1600 - 234 - 308, `宽度扣掉右栏（${u.w}）`);
  ok(u.h === 900 - 56 - 152, `高度扣掉战报（${u.h}）`);

  const small = bareRenderer(1000, 700).usable();
  ok(small.w >= 240 && small.h >= 180, `小窗口也不塌（${small.w}×${small.h}）`);

  // 图例在小窗口里干脆不画，别糊住半个屏幕
  const r2 = bareRenderer(760, 420);
  const c = mockCtx();
  r2.drawLegend(c, world, 760, 420);
  ok(c.texts.length === 0, '窗口太小时图例自动不画');
}

console.log("\n" + (bad === 0 ? "✅ 标签分级 / 避让 / 图例自检全部通过" : `❌ 有 ${bad} 项没过`));
process.exit(bad === 0 ? 0 : 1);
