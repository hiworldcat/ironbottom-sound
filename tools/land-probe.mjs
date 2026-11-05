/* 陆地碰撞诊断：检查每个剧本的出生点与整场航行中是否有舰艇压在陆地上。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  'js/core.js', 'js/data/ships.js', 'js/data/scenarios.js',
  'js/sim/sensors.js', 'js/sim/ship.js', 'js/sim/combat.js',
  'js/sim/ai.js', 'js/sim/recorder.js', 'js/sim/world.js'
];
globalThis.Naval = {};
for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const N = globalThis.Naval;

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : null;
const SEED = parseInt(process.argv[3] || '20241115', 10);
const AUTO = process.argv.includes('--autopilot');

/* 岛屿名称（用于报告） */
function islandAt(x, y) {
  const b = N.WORLD_BOUNDS;
  for (const isl of N.ISLANDS) {
    if (N.Geo.pointInPolygon({ x, y }, isl.poly)) return isl.name || '?';
  }
  return null;
}

for (const sc of N.Scenarios.available()) {
  if (only && sc.id !== only) continue;
  const world = new N.World(sc, { seed: SEED, autopilot: AUTO });

  console.log('\n===== ' + sc.id + ' (' + sc.title + ') =====');

  /* 1. 出生点 */
  for (const s of world.ships) {
    const nm = islandAt(s.pos.x, s.pos.y);
    if (nm) {
      console.log(`  ❌ 出生在陆地: ${s.side} ${s.name} (${Math.round(s.pos.x)},${Math.round(s.pos.y)}) 在 ${nm}`);
    } else {
      /* 最近的陆地距离 */
      let best = 1e9;
      for (let a = 0; a < 360; a += 10) {
        for (const r of [300, 600, 900, 1200, 1800]) {
          const p = N.Geo.dest(s.pos, a, r);
          if (world.isLand(p.x, p.y)) { best = Math.min(best, r); break; }
        }
      }
      if (best < 900) console.log(`  ⚠ 出生离岸太近: ${s.side} ${s.name} 约 ${best}m`);
    }
  }

  /* 2. 整场航行 */
  const onLand = {};
  const maxDepth = {};
  let steps = 0;
  const dt = 0.1;
  if (world.spawnFixups.length) {
    for (const fx of world.spawnFixups) {
      console.log(`  ❌ 出生在陆地: ${fx.side} ${fx.name} (${fx.from.x},${fx.from.y}) → 被挪到 (${fx.to.x},${fx.to.y})，偏移 ${fx.d}m`);
    }
  }
  while (!world.ended && steps < 36000) {
    world.update(dt);
    steps++;
    for (const s of world.ships) {
      if (s.sunk) continue;
      if (world.isLand(s.pos.x, s.pos.y)) {
        const k = s.side + ' ' + s.name;
        onLand[k] = (onLand[k] || 0) + 1;
        /* 深入程度：向外找最近的水面 */
        let d = 0;
        for (let r = 50; r <= 4000; r += 50) {
          let wet = false;
          for (let a = 0; a < 360; a += 15) {
            const p = N.Geo.dest(s.pos, a, r);
            if (!world.isLand(p.x, p.y)) { wet = true; break; }
          }
          if (wet) { d = r; break; }
        }
        maxDepth[k] = Math.max(maxDepth[k] || 0, d);
      }
    }
  }

  const keys = Object.keys(onLand);
  if (!keys.length) {
    console.log('  ✅ 全场无舰艇压陆地');
  } else {
    for (const k of keys) {
      console.log(`  ❌ ${k}: 压陆地 ${(onLand[k] * 1).toFixed(0)} 个采样点(×1s)，最深处离水面 ${maxDepth[k]}m`);
    }
  }
  console.log(`  （模拟 ${(world.time / 60).toFixed(1)} 分钟，结果 ${world.result ? world.result.result : '未结束'}）`);
}
