/**
 * 场景清单检查 —— 加新场景时先跑这个。
 *
 *   node tools/scenario-check.mjs
 *
 * 按任务类型分组列出全部场景，并检查：
 *   · 每艘舰的出生点是否落在陆地上（会被 World 自动挪到最近水面）
 *   · AI 的 searchPos 锚点是否落在陆地上
 * 修正数不为 0 就说明 js/data/scenarios.js 里的坐标写错了。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const files = [
  'js/core.js', 'js/data/ships.js', 'js/data/scenarios.js',
  'js/sim/sensors.js', 'js/sim/ship.js', 'js/sim/combat.js',
  'js/sim/ai.js', 'js/sim/squad.js', 'js/sim/command.js', 'js/sim/recorder.js', 'js/sim/world.js'
];
globalThis.Naval = {};
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const N = globalThis.Naval;

let bad = 0;
for (const g of N.Scenarios.grouped()) {
  console.log(`\n[${g.name}] ${g.desc || ''}  (${g.list.length})`);
  for (const sc of g.list) {
    const w = new N.World(sc, { seed: 1 });
    const us = w.ships.filter(s => s.side === 'US').length;
    const jp = w.ships.filter(s => s.side === 'JP').length;
    const n = w.spawnFixups.length + w.posFixups.length;
    if (n) bad++;
    console.log(
      `   ${sc.id.padEnd(22)} ${sc.title.padEnd(24)} 美${us}/日${jp}  ` +
      `出生修正 ${w.spawnFixups.length} 锚点修正 ${w.posFixups.length}`
    );
    for (const f of w.spawnFixups) {
      console.log(`       ! 出生点 ${f.side} ${f.name} (${f.from.x},${f.from.y}) → (${f.to.x},${f.to.y}) 偏移 ${f.d}m`);
    }
    for (const f of w.posFixups) {
      console.log(`       ! 锚点 ${f.kind}.${f.side} (${f.from.x},${f.from.y}) → (${f.to.x},${f.to.y}) 偏移 ${f.d}m`);
    }
    // 岸上目标反过来：必须钉在陆地上，不能掉进海里
    for (const t of (sc.shoreTargets || [])) {
      if (!N.MAP.isLandAt(t.x, t.y)) {
        console.log(`       ! 岸上目标 ${t.name} (${t.x},${t.y}) 掉进海里了`);
        bad++;
      }
    }
    // 区域与目的地必须在水上 —— 放在陆地上就永远不会触发
    for (const z of (sc.zones || [])) {
      if (N.MAP.isLandAt(z.x, z.y)) {
        console.log(`       ! 区域 ${z.name} (${z.x},${z.y}) 落在陆地上，永远不会触发`);
        bad++;
      }
    }
    for (const f of (sc.forces || [])) {
      if (f.destination && N.MAP.isLandAt(f.destination.x, f.destination.y)) {
        console.log(`       ! 目的地 ${f.name} 在陆地上，这条船永远到不了`);
        bad++;
      }
    }
  }
}

const total = N.Scenarios.available().length;
console.log(`\n共 ${total} 个可作战场景，${N.Scenarios.types().length} 种任务类型。`);
if (bad) {
  console.error(`❌ ${bad} 个场景的坐标落在陆地上，请修正 js/data/scenarios.js`);
  process.exit(1);
}
console.log('✅ 所有场景的出生点、锚点、区域与目的地都在水面上');
