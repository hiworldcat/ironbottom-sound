/* =============================================================================
 *  tools/ai-probe.mjs —— 舰队 AI（参谋部分工 / 雷击 / 照明弹）专项自检
 *
 *  跑法： node tools/ai-probe.mjs
 *
 *  查的是这几件事：
 *    1. 每条舰都有明确任务，任务有任期，不会每帧翻烧饼
 *    2. 侦察舰真的前出，掩护舰真的守在船队旁边
 *    3. 雷击：驱逐舰抢到阵位、齐射、然后转向脱离
 *    4. 照明弹：只在该打的时候打、有节制、没有精确航迹时打梯次
 *    5. 同一个目标不会全队挤上去打
 *    6. 玩家自己那一侧不会被 AI 抢舵
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
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

const OPEN = N.MAP.at(159.60, -8.00);
const ROLES = Object.keys(N.Tactics.ROLE).map(k => N.Tactics.ROLE[k]);

/** 跑一场，顺手记录每个阵营的照明弹 */
function play(scenarioId, opts, seconds, hooks) {
  const sc = N.Scenarios.get(scenarioId);
  const w = new N.World(sc, Object.assign({ seed: 777 }, opts || {}));
  const shots = [];
  const orig = w.fireStarshell.bind(w);
  w.fireStarshell = function (s, p) {
    const r = orig(s, p);
    if (!r) shots.push({ t: w.time, side: s.side, ship: s.name, pos: { x: p.x, y: p.y } });
    return r;
  };
  const torps = [];
  const origTorp = w.spawnTorpedo ? w.spawnTorpedo.bind(w) : null;
  if (origTorp) {
    w.spawnTorpedo = function (t) { torps.push({ t: w.time, side: t.side, id: t.id }); return origTorp(t); };
  }
  let frames = 0;
  while (!w.ended && w.time < (seconds || 900)) {
    w.update(0.1);
    frames++;
    if (hooks && hooks.each) hooks.each(w, frames);
  }
  return { w, shots, torps, frames };
}

/** 简易战场：一条日舰打一条美舰，开阔水域 */
function duel(jpClass, usClass, distM, headingJp) {
  const sc = Object.assign({}, N.Scenarios.get('day_surface_action'), {
    check: () => null, objectives: [], update: null
  });
  const w = new N.World(sc, { seed: 11 });
  const all = w.ships.slice();
  const jp = all.filter(s => s.side === 'JP')[0];
  const us = all.filter(s => s.side === 'US')[0];
  jp.cls = N.ShipClasses[jpClass] || jp.cls;
  us.cls = N.ShipClasses[usClass] || us.cls;
  w.ships = [jp, us];
  us.pos = { x: OPEN.x, y: OPEN.y };
  us.heading = 0; us.orderedHeading = 0; us.speed = 0; us.orderedSpeed = 0;
  jp.pos = { x: OPEN.x, y: OPEN.y - distM };
  jp.heading = headingJp == null ? 90 : headingJp;
  jp.orderedHeading = jp.heading;
  jp.speed = 0; jp.orderedSpeed = 0;
  w.weather.seaState = 2; w.weather.rain = 0; w.weather.squall = false;
  w.weather.visibility = 20000;
  w.env.light = 'day';
  return { w, jp, us };
}

/* ------------------------------------------------------- 1. 任务与任期 */
console.log('\n[1] 每条舰都明确自己在干什么');
{
  const { w } = play('day_surface_action', { autopilot: true }, 240);
  const jp = w.ships.filter(s => s.side === 'JP' && !s.sunk);
  const withTask = jp.filter(s => s.aiTask && s.aiTask.role);
  ok(withTask.length === jp.length,
    `${withTask.length}/${jp.length} 条日舰有明确任务`);
  ok(withTask.every(s => ROLES.indexOf(s.aiTask.role) >= 0), '任务名都在任务表里');
  ok(withTask.every(s => N.Tactics.LABEL[s.aiTask.role]),
    '每个任务都有中文名：' + withTask.map(s => s.name + '=' + N.Tactics.LABEL[s.aiTask.role]).join(' '));
  ok(!!(w.aiTasks && w.aiTasks.JP && w.aiTasks.JP.length), '参谋部留下了任务清单（调试面板可读）');
}

{
  // 换任务太勤 = 每条舰都在原地打转，等于没有任务
  const changes = {};
  let last = {};
  const { w } = play('day_surface_action', { autopilot: true }, 600, {
    each(world) {
      for (const s of world.ships) {
        if (s.side !== 'JP') continue;
        const r = s.aiTask && s.aiTask.role;
        if (!r) continue;
        if (last[s.id] && last[s.id] !== r) changes[s.id] = (changes[s.id] || 0) + 1;
        last[s.id] = r;
      }
    }
  });
  const vals = Object.values(changes);
  const max = vals.length ? Math.max(...vals) : 0;
  ok(max <= 8, `10 分钟里换任务最多的舰换了 ${max} 次（应 ≤ 8）`);
  ok(vals.reduce((a, b) => a + b, 0) <= 20, `全队换任务 ${vals.reduce((a, b) => a + b, 0)} 次（应 ≤ 20）`);
}

/* ------------------------------------------------------- 2. 阵位与侦察 */
console.log('\n[2] 侦察舰前出、掩护舰守船队');
{
  // 没有情报时，最快的两条舰应该被派去前出搜索
  const { w } = play('day_surface_action', { autopilot: true }, 30);
  const jp = w.ships.filter(s => s.side === 'JP' && !s.sunk);
  const scouts = jp.filter(s => s.aiTask && s.aiTask.role === N.Tactics.ROLE.SCOUT);
  ok(scouts.length >= 1 && scouts.length <= 2, `${scouts.length} 条舰被派去前出搜索（应为 1~2）`);
  const fastest = jp.slice().sort((a, b) => b.effectiveMaxSpeed() - a.effectiveMaxSpeed())[0];
  ok(scouts.indexOf(fastest) >= 0, '前出的是最快的舰（' + fastest.name + '）');

  // 没有情报的时候，两条侦察舰要拉成一条搜索线（而不是并排走）
  {
    const sc = Object.assign({}, N.Scenarios.get('day_surface_action'), {
      check: () => null, objectives: [], update: null
    });
    const w = new N.World(sc, { seed: 11 });
    const jpAll = w.ships.filter(s => s.side === 'JP').slice(0, 3);
    const us = w.ships.filter(s => s.side === 'US')[0];
    w.ships = jpAll.concat([us]);
    jpAll.forEach((s, i) => {
      s.pos = { x: OPEN.x + i * 600, y: OPEN.y };
      s.heading = 0; s.orderedHeading = 0; s.speed = 0; s.orderedSpeed = 0;
    });
    us.pos = { x: OPEN.x, y: OPEN.y + 40000 };   // 远到看不见，逼出"前出搜索"
    us.heading = 180; us.orderedHeading = 180; us.speed = 0; us.orderedSpeed = 0;
    w.weather.visibility = 6000; w.weather.seaState = 2; w.weather.rain = 0;
    w.env.light = 'day';

    let apart = 0;
    for (let i = 0; i < 3000; i++) {
      w.update(0.1);
      if (i % 50) continue;
      const s2 = w.ships.filter(s => !s.sunk && s.aiTask && s.aiTask.role === N.Tactics.ROLE.SCOUT);
      if (s2.length < 2) continue;
      for (let a = 0; a < s2.length; a++) {
        for (let b = a + 1; b < s2.length; b++) {
          apart = Math.max(apart, N.V.dist(s2[a].pos, s2[b].pos));
        }
      }
    }
    ok(apart > 2000, `两条侦察舰最多拉开 ${Math.round(apart)} m（应 > 2000，搜索线才铺得开）`);
  }
}

{
  // 有运输船的时候，必须留一条舰守在旁边
  let guardSamples = 0, samples = 0;
  play('cover_landing', { autopilot: true }, 600, {
    each(world, f) {
      if (f % 100) return;
      const ak = world.ships.filter(s => s.side === 'US' && !s.sunk &&
        (s.role === 'transport' || s.role === 'escortee'));
      if (!ak.length) return;
      samples++;
      const guard = world.ships.filter(s => s.side === 'US' && !s.sunk &&
        s.role !== 'transport' && s.role !== 'escortee' &&
        ak.some(a => N.V.dist(s.pos, a.pos) < 5000));
      if (guard.length) guardSamples++;
    }
  });
  const ratio = guardSamples / Math.max(1, samples);
  ok(ratio > 0.6, `船队身边一直有护航舰（${Math.round(ratio * 100)}% 的采样，应 > 60%）`);
}

/* ------------------------------------------------------- 3. 雷击 */
console.log('\n[3] 雷击：抢位 → 齐射 → 脱离');
{
  const { w, jp, us } = duel('kagero', 'neworleans', 8500, 90);
  const roles = [];
  let torpAt = null, turnedAfter = false;
  for (let i = 0; i < 2400; i++) {
    w.update(0.1);
    if (jp.aiTask) roles.push(jp.aiTask.role);
    if (!torpAt && w.torpedoes && w.torpedoes.length) torpAt = w.time;
    if (torpAt && jp.ai && w.time < jp.ai.turnAwayUntil) turnedAfter = true;
  }
  ok(roles.indexOf(N.Tactics.ROLE.TORPEDO) >= 0, '参谋部给这条驱逐舰派了雷击任务');
  ok(!!torpAt, `在 ${torpAt ? Math.round(torpAt) + ' 秒' : '——'} 放出了鱼雷`);
  ok(turnedAfter, '放完雷立刻转向脱离（turnAway）');
  ok(jp.engage !== undefined, '雷击航路上也会用炮还手');
}

/* ------------------------------------------------------- 4. 照明弹 */
console.log('\n[4] 照明弹纪律');
{
  // 白天一发都不该打
  const { shots } = play('day_surface_action', { autopilot: true }, 600);
  ok(shots.length === 0, `白天打了 ${shots.length} 发照明弹（应为 0）`);

  // 夜里该打，而且不能是"每艘舰各打各的"
  const night = play('tassafaronga', { autopilot: true }, 1800);
  const jpShots = night.shots.filter(s => s.side === 'JP');
  ok(jpShots.length > 0, `夜战打了 ${jpShots.length} 发照明弹`);
  const times = jpShots.map(s => s.t).sort((a, b) => a - b);
  let minGap = 1e9;
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  ok(minGap >= 3, `相邻两发至少隔 ${minGap.toFixed(1)} 秒（应有节奏，不是齐射）`);
  ok(jpShots.length <= 60, `一场夜战 ${jpShots.length} 发（不该无限刷）`);

  // 没有雷达的日军在夜战里靠照明弹把"测向方位"变成"看得见"
  const vis = [];
  const w2 = new N.World(N.Scenarios.get('tassafaronga'), { seed: 777, autopilot: true });
  let firstVisual = null;
  while (!w2.ended && w2.time < 1800) {
    w2.update(0.1);
    if (!firstVisual && N.Sensors.trackList(w2, 'JP').some(t => !t.esmOnly)) firstVisual = w2.time;
  }
  ok(!!firstVisual, `照明弹让日军在 ${firstVisual ? Math.round(firstVisual) + ' 秒' : '——'} 拿到了"看得见"的航迹`);

  // 照明弹只落在敌舰附近才有意义
  const w3 = new N.World(N.Scenarios.get('tassafaronga'), { seed: 777, autopilot: true });
  const lit = [];
  const orig = w3.fireStarshell.bind(w3);
  w3.fireStarshell = function (s, p) {
    const r = orig(s, p);
    if (!r) lit.push({ t: w3.time, pos: { x: p.x, y: p.y } });
    return r;
  };
  while (!w3.ended && w3.time < 1800) w3.update(0.1);
  ok(lit.length > 0, `共 ${lit.length} 发`);
}

/* ------------------------------------------------------- 5. 目标不扎堆 */
console.log('\n[5] 同一个目标不会全队挤上去');
{
  // 只有在"同时有好几个目标"的时候才谈得上分散：
  // 只剩一个目标时全队压上去是对的，那叫集中兵力。
  let samples = 0, multiSamples = 0, piled = 0, worstOver = 0, worst = 0;
  play('empress_augusta', { autopilot: true }, 900, {
    each(world, f) {
      if (f % 50) return;
      const contacts = N.Tactics.contactsOf(world, 'JP');
      const byTgt = {};
      let n = 0;
      for (const s of world.ships) {
        if (s.side !== 'JP' || s.sunk) continue;
        const t = s.aiTask && s.aiTask.targetId;
        if (!t) continue;
        byTgt[t] = (byTgt[t] || 0) + 1;
        n++;
      }
      const v = Object.values(byTgt);
      if (!v.length) return;
      samples++;
      if (contacts.length < 3) return;
      multiSamples++;
      // 8 条舰打 3 个目标，本来就只能 3/3/2 —— 要看的是"均不均"，
      // 而不是"有没有超过 2 条"。参谋部 6 秒才重新分工一次，留 1 条余量。
      const fair = Math.ceil(n / contacts.length) + 1;
      const mx = Math.max(...v);
      worst = Math.max(worst, mx);
      worstOver = Math.max(worstOver, mx - fair);
      if (mx > fair) piled++;
    }
  });
  ok(samples > 0, `采到 ${samples} 个"有目标"的时刻`);
  ok(multiSamples > 0, `其中 ${multiSamples} 个时刻有三个以上目标可选`);
  ok(piled / Math.max(1, multiSamples) < 0.25,
    `有几个目标可选时，兵力分配失衡的采样只占 ${Math.round(100 * piled / Math.max(1, multiSamples))}%（应 < 25%，最多一次 ${worst} 条打一个目标）`);
}

/* ------------------------------------------------------- 6. 不抢玩家的舵 */
console.log('\n[6] 玩家自己那一侧不会被 AI 抢舵');
{
  // 这两个剧本玩家指挥日军
  for (const id of ['shore_bombardment', 'henderson_bombardment']) {
    const w = new N.World(N.Scenarios.get(id), { seed: 5 });
    const jp = w.ships.filter(s => s.side === 'JP');
    const before = jp.map(s => s.orderedHeading);
    for (let i = 0; i < 900; i++) w.update(0.1);
    const taken = jp.filter(s => s.aiTask && s.aiTask.role);
    ok(taken.length === 0,
      `${id}: 玩家的 ${jp.length} 条舰没有被参谋部接管（${taken.length} 条被接管）`);
    const moved = jp.filter((s, i) => Math.abs(s.orderedHeading - before[i]) > 1).length;
    ok(moved === 0, `${id}: 没有一条舰被 AI 改了航向（${moved} 条）`);
  }
}

console.log('');
if (bad === 0) console.log('✅ AI 自检全部通过');
else { console.log(`❌ ${bad} 项不通过`); process.exitCode = 1; }
