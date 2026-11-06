/* =============================================================================
 *  tools/fire-probe.mjs —— 射界遮挡 / 误伤 专项自检
 *
 *  跑法： node tools/fire-probe.mjs
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/recorder.js', 'js/sim/world.js'
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

/* ---------------------------------------------------------------- 1. 岛屿遮挡 */
console.log('\n[1] 岛屿遮挡射界');
{
  const sc = N.Scenarios.get('kolombangara');
  const w = new N.World(sc, { seed: 7 });
  const isl = N.ISLANDS.find(i => (i.name || '').indexOf('科隆班加拉') >= 0);
  ok(!!isl, '找到科隆班加拉岛多边形');
  // 多边形重心（一定在岛里面）
  let cx = 0, cy = 0;
  for (const p of isl.poly) { cx += p.x; cy += p.y; }
  cx /= isl.poly.length; cy /= isl.poly.length;
  const a = { x: cx - 26000, y: cy };
  const b = { x: cx + 26000, y: cy };
  const hit = w.landBetween(a.x, a.y, b.x, b.y, true);
  ok(!!hit && (hit.name || '').indexOf('科隆班加拉') >= 0,
    '横穿科隆班加拉：' + (hit ? hit.name : '没挡住'));

  // 同一片水域，绕开岛的短线不该被挡
  const a2 = { x: cx - 30000, y: cy };
  const b2 = { x: cx - 22000, y: cy };
  ok(!w.landBetween(a2.x, a2.y, b2.x, b2.y, true), '岛外 8 km 的短线：不挡');

  // lineOfFire 走一遍真舰
  const ship = w.ships.find(s => s.side === 'US' && s.alive);
  ship.pos = { x: cx - 24000, y: cy };
  const los = w.lineOfFire(ship, { x: cx + 24000, y: cy }, 8);
  ok(!los.ok && los.kind === 'land', 'lineOfFire：隔着岛打不过去（' + los.name + '）');
  ship.pos = { x: cx - 30000, y: cy };
  const los2 = w.lineOfFire(ship, { x: cx - 22000, y: cy }, 8);
  ok(los2.ok, 'lineOfFire：开阔水域打得过去');
}

/* ---------------------------------------------------------------- 2. 友舰遮挡 */
console.log('\n[2] 友舰遮挡炮口');
{
  const sc = N.Scenarios.get('day_surface_action');
  const w = new N.World(sc, { seed: 11 });
  const us = w.ships.filter(s => s.side === 'US');
  const big = us.find(s => s.cls.displacement >= 8000);
  ok(!!big, '有一条大舰可以当"挡路的友舰"');
  if (big) {
    // 把另一条友舰放到正前方 400 m
    const blocker = us.find(s => s !== big && s.cls.displacement >= 8000) || us.find(s => s !== big);
    const bearing = 90; // 正东
    big.pos = { x: 0, y: 0 };
    blocker.pos = N.Geo.dest(big.pos, bearing, 400);
    blocker.side = big.side;
    blocker.sunk = false;
    const near = N.Geo.dest(big.pos, bearing, 2500);
    const far = N.Geo.dest(big.pos, bearing, 12000);
    const l1 = w.lineOfFire(big, near, 6);      // 2.5 km 平射
    const l2 = w.lineOfFire(big, far, 20);      // 12 km 高抛
    ok(!l1.ok && l1.kind === 'friendly', '2.5 km 平射：被友舰「' + l1.name + '」挡住');
    ok(l2.ok, '12 km 高抛：炮弹从友舰头顶过去，不挡');
  }
}

/* ---------------------------------------------------------------- 3. 误伤 */
console.log('\n[3] 炮弹能打到自己人');
{
  const sc = N.Scenarios.get('tassafaronga');
  const w = new N.World(sc, { seed: 3 });
  const us = w.ships.filter(s => s.side === 'US');
  const a = us[0], b = us[1];
  // 把 b 摆在 a 正东 5 km，然后让 a 朝 b 的位置打一发
  a.pos = { x: 0, y: 0 }; a.heading = 90;
  b.pos = { x: 5000, y: 0 }; b.heading = 90;
  const before = b.hull;
  const gun = a.mounts[0].gun;
  // 直接推一发炮弹落在 b 的舰体上
  w.shells.push({
    id: 'X1', side: a.side, ownerId: a.id, gun: gun, targetId: b.id,
    salvoId: 'SX', salvoSize: 1,
    aim: { x: 5000, y: 0 }, to: { x: 5000, y: 0 }, t: 0, tf: 0.01, range: 5000
  });
  w.update(0.1);
  w.update(0.1);
  ok(b.hull < before, '友舰被自家炮弹打中：船体 ' + before.toFixed(1) + ' → ' + b.hull.toFixed(1));
  ok(w.friendlyFire && w.friendlyFire[a.side] > 0, '误伤计数 = ' + (w.friendlyFire ? w.friendlyFire[a.side] : 0));
}

/* ---------------------------------------------------------------- 4. 识别失灵 */
console.log('\n[4] 识别器失灵 → 打自己人');
{
  const sc = N.Scenarios.get('tassafaronga');
  const w = new N.World(sc, { seed: 5 });
  const us = w.ships.filter(s => s.side === 'US');
  const shooter = us.find(s => s.cls.type === 'DD' && s.role !== 'flagship') || us[0];
  const victim = us.find(s => s !== shooter && s.role !== 'flagship') || us.find(s => s !== shooter);
  // 让射手处于交战状态，把识别器打掉，并强制触发一次误判
  shooter.engage = true;
  shooter.iffDestroyed = true;
  shooter.pos = { x: 0, y: 0 };
  victim.pos = { x: 4000, y: 0 };
  // 其它友舰挪到 22 km 以外，让候选只有 victim 一艘 —— 误判对象就唯一确定了
  us.forEach((s, i) => { if (s !== shooter && s !== victim) s.pos = { x: 60000 + i * 3000, y: 60000 }; });
  let got = null;
  for (let i = 0; i < 4000 && !got; i++) {
    N.Command.checkMisId(w, shooter.side);
    if (shooter.ffTrack) got = shooter.ffTrack;
    w.time += 0.5;
  }
  ok(!!got, '识别器失灵后出现误判' + (got ? '：把「' + victim.name + '」当成敌舰' : ''));
  if (got) {
    ok(got.friendlyId === victim.id, '误判对象就是那条友舰');
    const tr = N.Sensors.trackFor(w, shooter, got.id);
    ok(tr === got, '射手的火控拿到的就是这个"敌舰"航迹');
    const picked = N.AI && N.AI.pickTarget ? N.AI.pickTarget(w, shooter) : null;
    ok(!picked || picked.id === got.id, 'AI 目标选择被这条误判钉住');

    // 真的开火：跑一段时间，看有没有朝友舰打出去的炮弹、有没有打中
    const beforeFF = (w.friendlyFire && w.friendlyFire[shooter.side]) || 0;
    let firedAtFriend = 0;
    for (let i = 0; i < 600; i++) {
      w.update(0.1);
      for (const sh of w.shells) if (sh.ownerId === shooter.id) firedAtFriend++;
    }
    const afterFF = (w.friendlyFire && w.friendlyFire[shooter.side]) || 0;
    ok(shooter.salvosFired > 0 || firedAtFriend > 0, '误判期间射手真的开了炮');
    console.log('    朝友舰方向发射的炮弹样本 ' + firedAtFriend +
      ' · 误伤命中 ' + (afterFF - beforeFF) + ' 次');

    // 过一阵子会自己纠正
    if (shooter.ffTrack) {
      w.time = (shooter.ffUntil || 0) + 1;
      N.Command.checkMisId(w, shooter.side);
    }
    ok(!shooter.ffTrack, '时间到，识别纠正');
  }
}

/* ---------------------------------------------------------------- 5. 整场跑 */
console.log('\n[5] 整场仿真：误伤与遮挡都会真的发生');
{
  let blockedRuns = 0, ffRuns = 0, misRuns = 0;
  const ids = ['day_surface_action', 'savo_melee', 'tassafaronga', 'kolombangara',
    'blackett_strait', 'shore_bombardment', 'munda', 'new_georgia_landing',
    'empress_augusta', 'vella_gulf'];
  for (const id of ids) {
    const sc = N.Scenarios.get(id);
    if (!sc) continue;
    const w = new N.World(sc, { seed: 42 });
    let sawBlock = false, sawMis = false, blockName = '';
    for (let i = 0; i < 9000; i++) {
      w.update(0.1);
      if (!sawBlock) {
        const b = w.ships.find(s => s.losBlocked);
        if (b) { sawBlock = true; blockName = b.losBlocked.name; }
      }
      if (!sawMis && w.ships.some(s => s.ffTrack)) sawMis = true;
    }
    if (sawBlock) blockedRuns++;
    if (sawMis) misRuns++;
    if (w.friendlyFire && ((w.friendlyFire.US || 0) + (w.friendlyFire.JP || 0)) > 0) ffRuns++;
    console.log('    ' + id.padEnd(20) + ' 遮挡 ' + (sawBlock ? '有(' + blockName + ')' : '无') +
      ' · 误判 ' + (sawMis ? '有' : '无') +
      ' · 误伤 ' + JSON.stringify(w.friendlyFire || {}));
  }
  ok(blockedRuns >= 2, blockedRuns + '/' + ids.length + ' 场出现射界遮挡');
  ok(misRuns + ffRuns >= 1, '至少一场出现识别失灵或误伤');
}

console.log(bad === 0 ? '\n✅ 射界与误伤自检通过' : '\n❌ 有 ' + bad + ' 项没过');
process.exit(bad === 0 ? 0 : 1);
