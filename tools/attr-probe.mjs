/* =============================================================================
 *  tools/attr-probe.mjs —— 回放溯源自检
 *
 *  跑法： node tools/attr-probe.mjs
 *
 *  查的是：回放里的每一朵水柱、每一条鱼雷，是否都带着"是谁打的"。
 *  这一条断了，回放里就会出现没有主的炮弹，或者"未发现"的鱼雷数失真。
 *
 *  注意必须开 autopilot：不开的话玩家侧不会动，场上根本没有交火，
 *  测出来的全是 0，等于什么也没测。
 * ========================================================================== */
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = process.cwd();
const files = [
  "js/core.js", "js/data/ships.js", "js/data/coastline.js", "js/data/scenarios.js",
  "js/data/campaign.js", "js/sim/weather.js", "js/sim/damage.js", "js/sim/sensors.js",
  "js/sim/ship.js", "js/sim/combat.js", "js/sim/tactics.js", "js/sim/ai.js",
  "js/sim/squad.js", "js/sim/command.js", "js/sim/floatplane.js",
  "js/sim/recorder.js", "js/sim/world.js"
];
globalThis.Naval = {};
for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
const N = globalThis.Naval;

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); bad++; }
}

let SP = 0, SPN = 0, TP = 0, TPN = 0, TPU = 0, liveMax = 0;

for (const sc of N.Scenarios.available()) {
  const w = new N.World(sc, { seed: 777, autopilot: true });
  let maxLive = 0, steps = 0;
  while (!w.ended && steps < 24000) {
    w.update(0.1); steps++;
    maxLive = Math.max(maxLive, w.torpedoes.length);
  }
  const rp = new N.Replay(w.recorder, sc);
  let sp = 0, spn = 0, tp = 0, tpn = 0, tpu = 0;
  for (const f of rp.frames) {
    for (const s of f.splashes) { sp++; if (s.o) spn++; }
    for (const t of f.torps) { tp++; if (t.o) tpn++; if (!t.sp) tpu++; }
  }
  SP += sp; SPN += spn; TP += tp; TPN += tpn; TPU += tpu;
  liveMax = Math.max(liveMax, maxLive);
  console.log(`${sc.id.padEnd(20)} ${(w.time / 60).toFixed(0)}分` +
    ` 水柱 ${sp}/有名${spn}` +
    ` | 鱼雷帧 ${tp} 有名 ${tpn} 未发现 ${tpu}` +
    ` | 同时最多 ${maxLive} 条`);
}

console.log('');
ok(SP > 0, `回放里一共 ${SP} 朵水柱`);
ok(SP === SPN, `每一朵水柱都带着"谁打的"（${SPN}/${SP}）`);
ok(TP > 0, `回放里一共 ${TP} 帧带鱼雷`);
ok(TP === TPN, `每一条鱼雷都带着"谁放的"（${TPN}/${TP}）`);
ok(TPU > 0, `确实有鱼雷一直没被玩家发现（${TPU} 帧，九三式就是这样）`);
ok(liveMax <= 60, `同时在水的鱼雷最多 ${liveMax} 条（不该无限堆积）`);

console.log('');
if (bad === 0) console.log('✅ 回放溯源自检通过');
else { console.log(`❌ ${bad} 项不通过`); process.exitCode = 1; }
