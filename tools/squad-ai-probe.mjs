import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = process.cwd();
const files = ["js/core.js","js/data/ships.js","js/data/scenarios.js","js/sim/sensors.js","js/sim/ship.js",
  "js/sim/combat.js","js/sim/ai.js","js/sim/squad.js","js/sim/command.js","js/sim/recorder.js","js/sim/world.js"];
globalThis.Naval = {};
for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
const N = globalThis.Naval;

const sc = Object.assign({}, N.Scenarios.get("day_surface_action"),
  { check: () => null, objectives: [], update: null });
const w = new N.World(sc, { seed: 3 });

const pool = w.shipsOf("US").filter(s => s.cls.type !== "AK").slice(0, 4);
const sq = N.Squad.create(w, pool.map(s => s.id), { lines: 1 });
console.log("小队:", sq.name, "指挥长:", N.Squad.commanderOf(w, sq).name,
  "| 自动接管:", sq.aiControl);

const step = (n) => { for (let i = 0; i < n; i++) w.update(0.1); };

step(400);   // 40s：还在等待玩家
console.log("40s: 接管 =", sq.aiTakeover, "| 航向", Math.round(sq.course));

step(300);   // 累计 70s
const c1 = Math.round(sq.course);
console.log("70s: 接管 =", sq.aiTakeover, "| 理由 =", sq.aiWhy, "| 航向", c1);
const logs = w.messages.filter(m => /接管指挥|恢复人工/.test(m.text));
console.log("日志:", logs.map(m => m.text).join(" / ") || "（无）");

// 玩家下个命令 → 应该交还控制
N.Squad.issueCourse(w, sq, 200, sq.turnMode, true);
step(80);
console.log("玩家下令后: 接管 =", sq.aiTakeover, "| 航向", Math.round(sq.course));

// 再放 80s 不管 → 又被接管
step(900);
console.log("再放 90s: 接管 =", sq.aiTakeover, "| 理由 =", sq.aiWhy);

// 指挥舰被击沉 → 指挥中断 → 交接
const flag = N.Command.flagshipOf(w, "US");
console.log("旗舰:", flag.name);
flag.sunk = true; flag.alive = false;
step(1);
console.log("旗舰没了: 在线 =", N.Command.statusOf(w, "US").online,
  "| 中断", Math.round(N.Command.statusOf(w, "US").down), "s");
step(400);
console.log("交接后旗舰:", N.Command.statusOf(w, "US").flagshipName);
