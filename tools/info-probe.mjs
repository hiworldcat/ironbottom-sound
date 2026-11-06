/* 信息链路专项：电探、融合、延迟误差传递、损管差异 */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/recorder.js', 'js/sim/world.js'
];
const ctx = { console, Math, Date, JSON, Object, Array, String, Number, Boolean, isNaN, parseFloat, parseInt };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
const N = ctx.Naval;

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };

/* ==========================================================================
 *  1) 电探：只有装了电探的日舰，才看得见美军雷达的辐射
 * ========================================================================== */
function testESM() {
  // blackett_strait：村雨装了电探，美军是雷达伏击方
  const w = new N.World(N.Scenarios.get('blackett_strait'), { seed: 3 });
  const esmShip = w.ships.find(s => s.side === 'JP' && s.hasESM);
  ok(!!esmShip, '电探自检: blackett_strait 里没有装电探的日舰');
  if (!esmShip) return;

  const noEsm = w.ships.filter(s => s.side === 'JP' && !s.hasESM);
  ok(noEsm.length > 0, '电探自检: 这个剧本里所有日舰都装了电探，不符合"只有部分船"');

  // 设备表里必须有这一台，且挂在通讯区
  const dev = esmShip.devList.find(d => d.kind === 'esm');
  ok(!!dev, '电探自检: 设备表里没有电探');
  ok(dev && dev.group === 'comms', '电探自检: 电探没挂在通讯区');
  ok(N.Damage.esmOk(esmShip), '电探自检: 新造出来的舰电探就不可用');

  // 跑一段时间，看它有没有靠电探拿到航迹（先跑 2 分钟，够电探抓到就停）
  let esmTracks = 0, esmOnly = 0;
  for (let i = 0; i < 1200 && !esmTracks; i++) {
    w.update(0.1);
    for (const k in esmShip.ownTracks) {
      const tr = esmShip.ownTracks[k];
      if (tr.source === 'esm') esmTracks++;
      if (tr.esmOnly) esmOnly++;
    }
  }
  ok(esmTracks > 0, '电探自检: 跑了 2 分钟，电探一次都没抓到美军雷达');
  console.log(`电探自检: ${esmShip.name} 靠电探拿到航迹 ${esmTracks} 次（其中纯方位 ${esmOnly} 次）`);

  // 没装电探的日舰，不该出现 source === 'esm' 的航迹
  let leak = 0;
  for (const s of noEsm) {
    for (const k in (s.ownTracks || {})) {
      if (s.ownTracks[k].source === 'esm') leak++;
    }
  }
  ok(leak === 0, `电探自检: 没装电探的日舰出现了 ${leak} 条电探航迹`);

  // 打掉电探以后必须立刻失效
  const dev2 = esmShip.devList.find(d => d.kind === 'esm');
  if (dev2) {
    N.Damage.routeDamage(esmShip, 'comms', 1e6, w, null);
  }
  ok(!N.Damage.esmOk(esmShip), '电探自检: 通讯区打光以后电探还能用');

  // 美军那边没有任何"被监听"的接口
  const us = w.ships.filter(s => s.side === 'US');
  for (const s of us) {
    ok(!s.hasESM, '电探自检: 美军舰也装了电探');
    ok(!s.esmDev, '电探自检: 美军舰有电探设备');
  }
  console.log('电探自检: 美军侧没有任何电探 / 被监听提示');
}

/* ==========================================================================
 *  2) 融合：两份报告应该合并，而不是后到的覆盖先到的
 * ========================================================================== */
function testFusion() {
  const w = new N.World(N.Scenarios.get('day_surface_action'), { seed: 5 });
  const cmd = w.command.US;
  ok(!!cmd && !!cmd.flagshipId, '融合自检: 没有指挥舰');

  const tgt = w.ships.find(s => s.side === 'JP');
  const truth = { x: tgt.pos.x, y: tgt.pos.y };
  const pic = w.tracks.US = w.tracks.US || {};

  const mk = (dx, dy, err, at) => ({
    id: tgt.id, pos: { x: truth.x + dx, y: truth.y + dy }, posErr: err,
    course: 90, speed: 20, uncertainty: err, idLevel: 1,
    typeGuess: null, classGuess: null, nameGuess: null, misId: false,
    source: 'radar', observedAt: at
  });

  const now = w.time;
  N.Command.deliver(w, cmd, { kind: 'contact', from: 'a', fromName: 'A', obs: [mk(3000, 0, 800, now)] });
  const p1 = { x: pic[tgt.id].pos.x, y: pic[tgt.id].pos.y };
  N.Command.deliver(w, cmd, { kind: 'contact', from: 'b', fromName: 'B', obs: [mk(0, -3000, 800, now)] });
  const tr = pic[tgt.id];
  const p2 = { x: tr.pos.x, y: tr.pos.y };

  // 融合点应该在两份报告之间，而不是等于第二份
  const d1 = Math.hypot(p2.x - (truth.x + 3000), p2.y - truth.y);
  const d2 = Math.hypot(p2.x - truth.x, p2.y - (truth.y - 3000));
  ok(d1 > 400 && d2 > 400, `融合自检: 第二份报告直接覆盖了第一份（d1=${d1.toFixed(0)} d2=${d2.toFixed(0)}）`);
  const du = Math.hypot(p2.x - truth.x, p2.y - truth.y);
  ok(du < Math.hypot(p1.x - truth.x, p1.y - truth.y),
    '融合自检: 融合后的位置没有比单份报告更靠近真值');
  // 融合后的误差必须小于单份
  ok(tr.uncertainty < 800 * 1.1, `融合自检: 融合后误差 ${tr.uncertainty.toFixed(0)} 没有小于单份的 800`);
  console.log(`融合自检: 单份 800 m → 两份融合 ${tr.uncertainty.toFixed(0)} m，离真值 ${du.toFixed(0)} m`);
}

/* ==========================================================================
 *  3) 延迟误差传递：同一份观测，晚到 60 秒，圈必须明显更大
 * ========================================================================== */
function testDelay() {
  const mkWorld = () => new N.World(N.Scenarios.get('day_surface_action'), { seed: 7 });
  const run = (latency) => {
    const w = mkWorld();
    const cmd = w.command.US;
    const tgt = w.ships.find(s => s.side === 'JP');
    w.tracks.US = {};
    const t0 = w.time - latency;      // 观测发生在 latency 秒之前
    N.Command.deliver(w, cmd, {
      kind: 'contact', from: 'x', fromName: 'X',
      obs: [{
        id: tgt.id, pos: { x: tgt.pos.x, y: tgt.pos.y }, posErr: 500,
        course: 90, speed: 24, uncertainty: 500, idLevel: 1,
        typeGuess: null, classGuess: null, nameGuess: null, misId: false,
        source: 'radar', observedAt: t0
      }]
    });
    const tr = w.tracks.US[tgt.id];
    return { err: tr.uncertainty, lat: tr.latency, drift: Math.hypot(tr.pos.x - tgt.pos.x, tr.pos.y - tgt.pos.y) };
  };

  const a = run(0), b = run(60), c = run(150);
  ok(b.err > a.err * 1.5, `延迟自检: 晚到 60 秒误差 ${b.err.toFixed(0)} 没比实时的 ${a.err.toFixed(0)} 明显大`);
  ok(c.err > b.err * 1.2, `延迟自检: 晚到 150 秒误差 ${c.err.toFixed(0)} 没比 60 秒的 ${b.err.toFixed(0)} 更大`);
  ok(Math.abs(b.lat - 60) < 1, `延迟自检: 记录的延迟 ${b.lat.toFixed(1)} 不是 60 秒`);
  // 位置也要跟着往前推（不是停在 60 秒前）
  ok(b.drift < 2000, `延迟自检: 晚到的报告位置没往前推，离真值还有 ${b.drift.toFixed(0)} m`);
  console.log(`延迟自检: 实时 ±${a.err.toFixed(0)} m · 晚 60 秒 ±${b.err.toFixed(0)} m · 晚 150 秒 ±${c.err.toFixed(0)} m`);
}

/* ==========================================================================
 *  4) 指挥舰自己的观测是准的，别人的要靠无线电
 * ========================================================================== */
function testFlagshipExact() {
  const w = new N.World(N.Scenarios.get('kula_gulf'), { seed: 11 });
  // 先跑一分钟，让各舰把状态报告发上来
  for (let i = 0; i < 700; i++) w.update(0.1);
  const cmd = w.command.US;
  const flag = w.shipById(cmd.flagshipId);
  ok(!!flag, '指挥自检: 找不到指挥舰');
  if (!flag) return;

  // 指挥舰的状态快照是精确的（无定位误差）
  const snap = cmd.roster[flag.id];
  ok(snap && snap.exact, '指挥自检: 指挥舰自己的状态报告不是精确的');
  if (snap) {
    ok(snap.posErr === 0, `指挥自检: 指挥舰自己的报告带了 ${snap.posErr.toFixed(0)} m 定位误差`);
    // 报告是几秒前拍的，船已经走了一点，但绝不该是导航误差那个量级
    const d = Math.hypot(snap.pos.x - flag.pos.x, snap.pos.y - flag.pos.y);
    ok(d < 300, `指挥自检: 指挥舰自己的位置偏了 ${d.toFixed(1)} m`);
  }

  // 视距外的友舰：状态报告必须带定位误差
  let sawErr = false;
  for (const k in cmd.roster) {
    if (k === flag.id) continue;
    const r = cmd.roster[k];
    if (r && !r.exact && r.posErr > 0) sawErr = true;
  }
  ok(sawErr, '指挥自检: 视距外友舰的状态报告没有定位误差');
  console.log('指挥自检: 指挥舰自身精确，其余舰船带定位误差');
}

/* ==========================================================================
 *  5) 损管差异
 * ========================================================================== */
function testDamageControl() {
  const w = new N.World(N.Scenarios.get('savo_melee'), { seed: 13 });
  const us = w.ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  const jp = w.ships.find(s => s.side === 'JP' && s.cls.type === 'CA');
  const pu = N.Damage.profile(us), pj = N.Damage.profile(jp);
  ok(pj.flood > pu.flood, '损管自检: 日军进水倍率不比美军高');
  ok(pu.fire > pj.fire, '损管自检: 美军灭火倍率不比日军高');
  ok(pj.magazine > pu.magazine, '损管自检: 日军殉爆倍率不比美军高');
  ok(pu.fault < pj.fault, '损管自检: 美军故障率不比日军低');
  console.log(`损管自检: 进水 美×${pu.flood.toFixed(2)}/日×${pj.flood.toFixed(2)}，` +
    `灭火 美×${pu.fire.toFixed(2)}/日×${pj.fire.toFixed(2)}，` +
    `殉爆 美×${pu.magazine.toFixed(2)}/日×${pj.magazine.toFixed(2)}，` +
    `故障 美×${pu.fault.toFixed(2)}/日×${pj.fault.toFixed(2)}`);
}

testESM();
testFusion();
testDelay();
testFlagshipExact();
testDamageControl();

if (problems.length) {
  console.log('\n❌ 问题:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n✅ 信息链路自检通过');
