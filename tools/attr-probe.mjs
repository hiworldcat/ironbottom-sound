import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root=process.cwd();
const files=["js/core.js","js/data/ships.js","js/data/scenarios.js","js/sim/sensors.js","js/sim/ship.js","js/sim/combat.js","js/sim/tactics.js", "js/sim/ai.js","js/sim/recorder.js","js/sim/world.js"];
globalThis.Naval={}; for(const f of files) vm.runInThisContext(fs.readFileSync(path.join(root,f),"utf8"),{filename:f});
const N=globalThis.Naval;
for (const sc of N.Scenarios.available()) {
  const w = new N.World(sc, {seed:777});
  let maxLive = 0, steps = 0;
  while (!w.ended && steps < 24000) { w.update(0.1); steps++; maxLive = Math.max(maxLive, w.torpedoes.length); }
  const rp = new N.Replay(w.recorder, sc);
  let sp=0, spn=0, tp=0, tpn=0, tpu=0;
  for (const f of rp.frames) {
    for (const s of f.splashes) { sp++; if (s.o) spn++; }
    for (const t of f.torps) { tp++; if (t.o) tpn++; if (!t.sp) tpu++; }
  }
  // 找一帧有鱼雷的
  let sampleT = null;
  for (const f of rp.frames) if (f.torps.length) { sampleT = f.t; break; }
  console.log(`${sc.id.padEnd(20)} ${(w.time/60).toFixed(0)}分 水柱 ${sp}/有名${spn} | 鱼雷帧 ${tp} 有名 ${tpn} 未发现 ${tpu} | 同时最多 ${maxLive} 条 | 首条鱼雷 t=${sampleT===null?"-":sampleT.toFixed(0)+"s"}`);
}
