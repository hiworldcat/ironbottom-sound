import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root=process.cwd();
const files=["js/core.js","js/data/ships.js","js/data/scenarios.js","js/sim/sensors.js","js/sim/ship.js","js/sim/combat.js","js/sim/ai.js","js/sim/recorder.js","js/sim/world.js"];
globalThis.Naval={}; for(const f of files) vm.runInThisContext(fs.readFileSync(path.join(root,f),"utf8"),{filename:f});
const N=globalThis.Naval;
const sc = N.Scenarios.get("day_surface_action");
const w = new N.World(sc, {seed:20241115});
for (const s of w.ships) {
  const t = s.torps.map(m => `${m.torp.name||m.torp.id} loaded=${m.loaded} range=${m.torp.range} arc=${m.arc||"-"} disabled=${!!m.disabled}`);
  console.log(`${s.side} ${s.name.padEnd(5,"　")} torpRangeMax=${s.torpRangeMax} mounts=${s.torps.length} ${t.join(" | ")}`);
}
console.log("arcOk(90deg)=", w.ships[0].torpedoArcOk(90), " arcOk(60)=", w.ships[0].torpedoArcOk(60));
// 统计交战距离与舷角
let minR = 1e9, minRel = 999, framesInTorpRange = 0, arcOkFrames = 0;
const origLaunch = N.Combat.launchTorpedoes;
let calls = 0, okCalls = 0;
N.Combat.launchTorpedoes = function(...a){ calls++; const r = origLaunch.apply(this,a); if (r>0) okCalls++; return r; };
for (let i=0;i<18000;i++) {
  w.update(0.1);
  for (const s of w.ships) {
    if (s.sunk || !s.torps.length) continue;
    const tr = s.targetTrackId ? N.Sensors.track(w, s.side, s.targetTrackId) : null;
    if (!tr) continue;
    const r = N.V.dist(s.pos, tr.pos);
    const rel = Math.abs(N.U.angDiff(N.Geo.bearing(s.pos, tr.pos), s.heading));
    if (r < minR) minR = r;
    if (r < s.torpRangeMax*0.45) { framesInTorpRange++; if (rel>35&&rel<145) { arcOkFrames++; if (rel<minRel) minRel=rel; } }
  }
  if (w.ended) break;
}
console.log(`最近交战距离 ${Math.round(minR)}m  鱼雷射程内帧 ${framesInTorpRange}  其中舷角合适 ${arcOkFrames}  最小舷角 ${minRel.toFixed(0)}`);
console.log(`launchTorpedoes 调用 ${calls} 次，成功 ${okCalls} 次；世界鱼雷数 ${w.torpedoes.length}`);
