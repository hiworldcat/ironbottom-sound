import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = process.cwd();
const files = ["js/core.js","js/data/ships.js","js/data/scenarios.js","js/sim/sensors.js","js/sim/ship.js",
  "js/sim/combat.js","js/sim/tactics.js", "js/sim/ai.js","js/sim/squad.js","js/sim/command.js","js/sim/recorder.js","js/sim/world.js"];
globalThis.Naval = {};
for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
const N = globalThis.Naval;

function makeWorld(id, seed) {
  const sc = Object.assign({}, N.Scenarios.get(id), { check: () => null, objectives: [], update: null });
  return new N.World(sc, { seed: seed || 1 });
}

// ---------- 1. 指挥舰 ----------
const w = makeWorld("day_surface_action");
const us = N.Command.statusOf(w, "US");
const jp = N.Command.statusOf(w, "JP");
console.log("US 旗舰:", us.flagshipName, "| JP 旗舰:", jp.flagshipName);
console.log("白昼链路: 丢包", us.lossPct + "%", "延迟", us.delay + "s", "电台", us.radioOk, "IFF", us.iffOk);

// ---------- 2. 态势延迟 ----------
for (let i = 0; i < 600; i++) w.update(0.1);   // 60 s
const pic = N.Sensors.trackList(w, "US");
console.log("60s 后 US 态势图接触数:", pic.length,
  pic.map(t => `${t.id}:${Math.round(N.Command.ageOf(w, t))}s前`).join(" "));

// ---------- 3. 命令延迟/丢包 ----------
const ship = w.shipsOf("US").find(s => s !== N.Command.flagshipOf(w, "US"));
let ok = 0, lost = 0, delays = [];
for (let i = 0; i < 200; i++) {
  const r = w.issueOrder(ship, (i * 7) % 360, 20);
  if (r.ok) { ok++; delays.push(r.delay); } else if (r.lost) lost++;
}
delays.sort((a, b) => a - b);
console.log(`命令 200 次: 送达 ${ok}, 丢 ${lost} (${Math.round(lost / 200 * 100)}%), ` +
  `延迟中位 ${Math.round(delays[delays.length >> 1] || 0)}s 最大 ${Math.round(delays[delays.length - 1] || 0)}s`);

// ---------- 4. 夜间 / 恶劣天气 ----------
function lossAt(id, tweak) {
  const ww = makeWorld(id);
  if (tweak) tweak(ww);
  return Math.round(N.Command.lossChance(ww, "US") * 100);
}
const dayId = "day_surface_action", nightId = "night_escort";
console.log("丢包率对比: 白昼", lossAt(dayId) + "%",
  "| 夜间", lossAt(nightId) + "%",
  "| 夜间+干扰20%", lossAt(nightId, w => { w.jamming = { US: 0.2, JP: 0 }; }) + "%",
  "| 白昼+暴雨", lossAt(dayId, w => { w.env.weather = "暴雨"; w.env.rain = 10; }) + "%");

// ---------- 5. 视距 ----------
const w3 = makeWorld(dayId);
const f3 = N.Command.flagshipOf(w3, "US");
const near = w3.shipsOf("US").find(s => s !== f3);
near.pos = { x: f3.pos.x + 2000, y: f3.pos.y };
const far = w3.shipsOf("US").find(s => s !== f3 && s !== near);
far.pos = { x: f3.pos.x + 25000, y: f3.pos.y };
console.log("视距内(2km):", N.Command.inVisual(w3, near, f3),
  "| 视距外(25km):", N.Command.inVisual(w3, far, f3));

// ---------- 6. 电台被打掉 ----------
far.radioDestroyed = true;
const r6 = w3.issueOrder(far, 0, 20);
console.log("电台被打掉后下令:", r6.ok ? "成功" : "失败(" + r6.reason + ")");

// ---------- 7. IFF ----------
const w4 = makeWorld(dayId);
const cmd = N.Command.cmdOf(w4, "US");
let bad = 0;
for (let i = 0; i < 20000; i++) {
  const c = N.Command.classify(w4, cmd, {});
  if (c !== "hostile") bad++;
}
console.log("IFF 20000 次识别，异常结果", bad, "≈", (bad / 200).toFixed(1) + "%");
N.Command.flagshipOf(w4, "US").iffDestroyed = true;
console.log("IFF 被打掉后识别结果:", N.Command.classify(w4, cmd, {}));

// ---------- 8. 本舰状态：视距外是旧的 ----------
const w5 = makeWorld(dayId);
const f5 = N.Command.flagshipOf(w5, "US");
const rem = w5.shipsOf("US").find(s => s !== f5);
rem.pos = { x: f5.pos.x + 24000, y: f5.pos.y };
for (let i = 0; i < 400; i++) w5.update(0.1);
const v = N.Command.ownView(w5, rem);
console.log("25km 外的己方舰: 图上位置误差", Math.round(N.V.dist(v.pos, rem.pos)),
  "m, 报告于", Math.round(w5.time - v.reportedAt), "s 前, 真航速", rem.speed.toFixed(1),
  "图上", v.speed === null ? "未知" : v.speed.toFixed(1));

// ---------- 8b. 报告到了之后误差有多大 ----------
for (let i = 0; i < 2400; i++) w5.update(0.1);
const v2 = N.Command.ownView(w5, rem);
console.log("再等 240s: 图上位置误差", Math.round(N.V.dist(v2.pos, rem.pos)),
  "m, 报告于", Math.round(w5.time - v2.reportedAt), "s 前, 图上航速", v2.speed.toFixed(1));

// ---------- 8c. 远距离下令：延迟 + 丢包 ----------
const w7 = makeWorld(dayId);
const f7 = N.Command.flagshipOf(w7, "US");
const far7 = w7.shipsOf("US").find(s => s !== f7);
far7.pos = { x: f7.pos.x + 26000, y: f7.pos.y };
let ok7 = 0, lost7 = 0, d7 = [];
for (let i = 0; i < 400; i++) {
  const r = w7.issueOrder(far7, (i * 11) % 360, 20);
  if (r.ok) { ok7++; d7.push(r.delay); } else if (r.lost) lost7++;
}
d7.sort((a, b) => a - b);
console.log(`26km 外下令 400 次: 送达 ${ok7}, 丢 ${lost7} (${Math.round(lost7 / 4)}%), ` +
  `延迟中位 ${Math.round(d7[d7.length >> 1] || 0)}s`);

// ---------- 9. 指挥交接 ----------
const w6 = makeWorld(dayId);
const f6 = N.Command.flagshipOf(w6, "US");
console.log("交接前旗舰:", f6.name);
f6.sunk = true; f6.alive = false;
w6.update(0.1);
console.log("旗舰沉没后:", N.Command.statusOf(w6, "US").online ? "在线" : "指挥中断",
  "| 中断剩余", Math.round(N.Command.statusOf(w6, "US").down) + "s");
for (let i = 0; i < 400; i++) w6.update(0.1);
console.log("40s 后旗舰:", N.Command.statusOf(w6, "US").flagshipName);
