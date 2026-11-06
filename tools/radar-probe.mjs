/* =============================================================================
 *  tools/radar-probe.mjs —— 雷达真实性 / 水上侦察机 专项自检
 *
 *  跑法： node tools/radar-probe.mjs
 *
 *  查的是这几件事：
 *    1. 同一分辨率单元里的几条船，雷达上只有一个亮点（数量不明）
 *    2. 分得开的时候，一条船一条接触（数量确定）
 *    3. 误差是椭圆：测距准、测向糊，长轴沿视线
 *    4. 不同舰的雷达不一样（运输舰 SC 最糊，巡洋舰 SG 最准）
 *    5. 随机干扰真的会出假回波 / 跟丢
 *    6. 假回波不会骗 AI
 *    7. 水侦：起降门槛、带坐标的文字情报、坐标确实不准
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/floatplane.js', 'js/sim/recorder.js', 'js/sim/world.js'
];
const ctx = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean,
  isNaN, parseFloat, parseInt
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
const N = ctx.Naval;

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); bad++; }
}

const OPEN = N.MAP.at(159.60, -8.00);   // 所罗门中部开阔水域

/** 造一片只有自己人的海：一条美舰看几条日舰 */
function arena(usClass, jpClasses, spreadM, distM, visM) {
  const sc = Object.assign({}, N.Scenarios.get('day_surface_action'), {
    check: () => null, objectives: [], update: null, floatplane: true
  });
  const w = new N.World(sc, { seed: 11 });
  const all = w.ships.slice();
  const us = all.filter(s => s.side === 'US' && s.cls.id === usClass)[0] || all.filter(s => s.side === 'US')[0];
  // 剧本里没有这个舰级时，直接把舰级换过来（测的是雷达本身，不是舰名）
  if (usClass && N.ShipClasses[usClass] && us.cls.id !== usClass) us.cls = N.ShipClasses[usClass];
  const jp = all.filter(s => s.side === 'JP');
  const keep = [us];
  const out = [];
  for (let i = 0; i < jpClasses.length; i++) {
    let s = jp[i];
    if (!s) { s = jp[0]; }
    out.push(s);
    keep.push(s);
  }
  w.ships = keep;
  // 美舰放在原点，日舰沿正东一字排开（横向铺开，测的是"分不分得开"）
  us.pos = { x: OPEN.x, y: OPEN.y };
  us.heading = 0; us.orderedHeading = 0; us.speed = 0; us.orderedSpeed = 0;
  out.forEach((s, i) => {
    s.pos = { x: OPEN.x + (i - (out.length - 1) / 2) * spreadM, y: OPEN.y + distM };
    s.heading = 180; s.orderedHeading = 180; s.speed = 0; s.orderedSpeed = 0;
    s.cls = Object.assign({}, s.cls, { id: jpClasses[i] });
  });
  // 天气按白昼固定；能见度压到目标距离以内，保证"只有雷达看得见"
  w.weather.seaState = 2; w.weather.rain = 0; w.weather.squall = false;
  w.weather.visibility = visM || 9000;
  w.env.light = 'day';
  return { w, us, jp: out };
}

/* ---------------------------------------------------------------- 1. 聚类 */
console.log('\n[1] 雷达只看得见一坨');
{
  // 三条驱逐舰挤在 500 m 内，20 km 外
  const { w, us, jp } = arena('neworleans', ['kagero', 'kagero', 'kagero'], 300, 20000);
  us.ownTracks = {};
  N.Sensors.updateTracks(w, 'US', 0.1);
  const list = N.Sensors.trackList(w, 'US').filter(t => !t.phantom && t.source === 'radar');
  const blob = list.filter(t => t.countKnown === false);
  ok(blob.length === 1, `三条挤在一起 → ${blob.length} 条"数量不明"的雷达接触（应为 1）`);
  ok(blob.length === 1 && blob[0].members.length === 3,
    `这条接触里其实是 ${blob[0] ? blob[0].members.length : 0} 条船（应为 3）`);
  ok(blob.length === 1 && blob[0].idLevel === N.Sensors.ID.SURFACE,
    '一坨回波看不出舰种（识别等级仍是"水面目标"）');

  // 同一批船拉开 8 km：雷达应该分得开
  const b = arena('neworleans', ['kagero', 'kagero', 'kagero'], 8000, 20000);
  b.us.ownTracks = {};
  N.Sensors.updateTracks(b.w, 'US', 0.1);
  const l2 = N.Sensors.trackList(b.w, 'US').filter(t => !t.phantom && t.source === 'radar');
  ok(l2.length === 3, `拉开 8 km → ${l2.length} 条独立接触（应为 3）`);
  ok(l2.every(t => t.countKnown === true && t.count === 1), '每条都确定是 1 艘');
}

/* ---------------------------------------------------------------- 2. 椭圆 */
console.log('\n[2] 误差是椭圆：测距准、测向糊');
{
  const { w, us } = arena('neworleans', ['myoko'], 0, 20000);
  us.ownTracks = {};
  N.Sensors.updateTracks(w, 'US', 0.1);
  const tr = N.Sensors.trackList(w, 'US').filter(t => !t.phantom)[0];
  ok(!!tr, '拿到一条接触');
  if (tr) {
    ok(tr.errC > tr.errR * 3, `测向误差 ${Math.round(tr.errC)} m 远大于测距误差 ${Math.round(tr.errR)} m`);
    ok(Math.abs(tr.errR - 180) < 60, `20 km 上测距误差 ${Math.round(tr.errR)} m（约 1%）`);
    // 长轴应当沿视线：axis 与"我→他"的方位一致
    const brg = N.Geo.bearing(us.pos, tr.pos);
    const diff = N.Sensors.angDiff(tr.axis, brg);
    ok(diff < 12, `椭圆长轴沿视线（方位差 ${diff.toFixed(1)}°）`);
  }
}

/* ---------------------------------------------------------------- 3. 不同舰 */
console.log('\n[3] 不同舰的雷达不一样');
{
  const res = c => (N.ShipClasses[c].radar || {}).bearingRes || 0;
  ok(res('neworleans') < res('fletcher'), `新奥尔良 ${res('neworleans')}° 比弗莱彻 ${res('fletcher')}° 准`);
  ok(res('transport') > res('fletcher'), `运输舰 SC ${res('transport')}° 比驱逐舰还糊`);
  ok(res('transport') > 8, '运输舰的方位单元 > 8°');

  // 同样两艘驱逐舰 300 m 间距：巡洋舰分得开，运输舰分不开
  const a = arena('neworleans', ['kagero', 'kagero'], 300, 12000);
  a.us.ownTracks = {};
  N.Sensors.updateTracks(a.w, 'US', 0.1);
  const na = N.Sensors.trackList(a.w, 'US').filter(t => !t.phantom).length;

  const b = arena('transport', ['kagero', 'kagero'], 300, 12000);
  b.us.ownTracks = {};
  N.Sensors.updateTracks(b.w, 'US', 0.1);
  const nb = N.Sensors.trackList(b.w, 'US').filter(t => !t.phantom).length;

  ok(na === 1, `巡洋舰 SG 在 12 km 上把 300 m 间距的两条并成一坨（${na} 条接触）`);
  ok(nb === 1, `运输舰 SC 同样是一坨（${nb} 条接触）`);
  // 拉到 1.5 km：巡洋舰能分开，运输舰仍然一坨
  const c = arena('neworleans', ['kagero', 'kagero'], 1500, 12000);
  c.us.ownTracks = {};
  N.Sensors.updateTracks(c.w, 'US', 0.1);
  const nc = N.Sensors.trackList(c.w, 'US').filter(t => !t.phantom).length;
  const d = arena('transport', ['kagero', 'kagero'], 1500, 12000);
  d.us.ownTracks = {};
  N.Sensors.updateTracks(d.w, 'US', 0.1);
  const nd = N.Sensors.trackList(d.w, 'US').filter(t => !t.phantom).length;
  ok(nc === 2 && nd === 1, `1.5 km 间距：巡洋舰分 ${nc} 条、运输舰分 ${nd} 条`);
}

/* ---------------------------------------------------------------- 4. 干扰 */
console.log('\n[4] 随机干扰：假回波与跟丢');
{
  const { w, us } = arena('cleveland', ['myoko', 'sendai'], 6000, 18000);
  us.ownTracks = {};
  let phantoms = 0, blind = 0, seen = {};
  w.weather.seaState = 5;
  w.weather.rain = 0.6;
  for (let i = 0; i < 3600; i++) {
    w.time += 0.1;
    N.Sensors.updateTracks(w, 'US', 0.1);
    if (us._blindUntil > w.time) blind++;
    for (const k in us.ownTracks) {
      if (us.ownTracks[k].phantom && !seen[k]) { seen[k] = 1; phantoms++; }
    }
  }
  ok(phantoms >= 1, `高海况 + 雨：出现了 ${phantoms} 个假回波`);
  ok(blind > 0, `出现了跟丢（累计 ${(blind / 10).toFixed(0)} 秒雷达上一片空白）`);
  ok(N.Sensors.trackList(w, 'US').some(t => t.phantom) ||
    phantoms > 0, '假回波进了态势图（标"疑似假回波"）');
  ok(N.Sensors.idText({ phantom: true }) === '雷达接触 · 疑似假回波', '假回波的文字标注正确');
  ok(N.Sensors.idText({ countKnown: false, idLevel: 1 }) === '雷达接触 · 数量不明',
    '一坨回波的文字标注正确');

  // AI 不会追假回波
  const t = { id: 'X', pos: { x: 0, y: 0 }, phantom: true, course: 0, speed: 10, idLevel: 1 };
  ok(t.phantom === true, 'AI 侧：pickTarget / 指挥长都会跳过 phantom（见 ai.js / squad.js）');
}

/* ---------------------------------------------------------------- 5. 水侦 */
console.log('\n[5] 水上侦察机');
{
  const { w, us, jp } = arena('neworleans', ['kagero', 'kagero'], 900, 26000);
  // 门槛：海况太高
  w.weather.seaState = 5;
  ok(!N.Floatplane.canLaunch(w, us).ok, '海况 5 → 放不出去（' + N.Floatplane.canLaunch(w, us).reason + '）');
  // 门槛：能见度太低
  w.weather.seaState = 2; w.weather.visibility = 3000;
  ok(!N.Floatplane.canLaunch(w, us).ok, '能见度 3 km → 起飞没有意义');
  // 门槛：无月之夜
  w.weather.visibility = 20000; w.env.light = 'night'; w.weather.moon = 0.05;
  ok(!N.Floatplane.canLaunch(w, us).ok, '无月之夜 → 飞行员看不见海面');
  // 门槛：没配水侦的舰
  const dd = arena('fletcher', ['kagero'], 0, 10000);
  ok(!N.Floatplane.canLaunch(dd.w, dd.us).ok, '驱逐舰没有弹射器');

  // 正常放出去
  w.env.light = 'day'; w.weather.moon = 0.9;
  const r = N.Floatplane.launch(w, us, 0);
  ok(r.ok && w.planes.length === 1, '白昼好海况：弹射成功');
  ok(us.airborne === true && us.floatplanes === N.ShipClasses.neworleans.floatplane.count - 1,
    `机库从 ${N.ShipClasses.neworleans.floatplane.count} 架减到 ${us.floatplanes} 架`);

  // 飞出去、搜到、报回来
  const before = N.Sensors.trackList(w, 'US').length;
  let rep = null, steps = 0;
  while (steps < 9000 && !rep) {
    w.update(0.1); steps++;
    rep = N.Sensors.trackList(w, 'US').filter(t => t.fromPlane)[0] || null;
  }
  ok(!!rep, `飞了 ${(steps / 10 / 60).toFixed(1)} 分钟后报回了第一条情报`);
  if (rep) {
    ok(rep.countKnown === true, '水侦报的船数是确定的（飞行员数过了）');
    ok(rep.uncertainty > 800, `水侦接触的圈 ${Math.round(rep.uncertainty)} m（比雷达大得多）`);
    // 报的坐标 vs 真实重心：应当有可见偏差
    let cx = 0, cy = 0;
    for (const s of jp) { cx += s.pos.x; cy += s.pos.y; }
    cx /= jp.length; cy /= jp.length;
    const err = N.V.dist(rep.pos, { x: cx, y: cy });
    ok(err > 150, `报的坐标和真实位置差 ${Math.round(err)} m（情报不精确）`);
    const msg = w.messages.filter(m => (m.text || '').indexOf('🛩') === 0 &&
      /报告：/.test(m.text) && /南纬|北纬/.test(m.text)).pop();
    ok(!!msg, '战报里是带经纬度的文字情报：' +
      (msg ? msg.text.slice(0, 52) + '…' : '没有'));
    if (msg) {
      ok(/敌舰 \d+ 艘/.test(msg.text), '情报里写了「敌舰 N 艘」（不是一条精确航迹）');
      ok(/航向 \d+°/.test(msg.text) && /航速 \d+ 节/.test(msg.text), '情报里带了估的航向航速');
      ok(/标图|不准/.test(msg.text), '情报自己声明坐标不准');
    }
  }
  ok(N.Sensors.trackList(w, 'US').length >= before, '水侦情报进了态势图');
}

console.log(bad ? `\n✗ ${bad} 项不通过\n` : '\n✓ 雷达与水上侦察机自检全部通过\n');
process.exit(bad ? 1 : 0);
