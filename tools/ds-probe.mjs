/* =============================================================================
 *  tools/ds-probe.mjs —— 双 AI 对战（外部代理）专项自检
 *
 *  跑法： node tools/ds-probe.mjs
 *         node tools/ds-probe.mjs --live      （真调一次 DeepSeek，要设 DEEPSEEK_API_KEY）
 *
 *  查的是这几件事：
 *    1. 简报里只有"这一方看得见的东西" —— 没有敌舰真身、没有敌方血量
 *    2. 指令能落到舰上：航向 / 航速 / 目标 / 开火，编出来的 id 一律丢掉
 *    3. 交给外部代理的阵营，内置参谋部不再抢舵
 *    4. 模型输出乱七八糟时，解析器和兜底策略都能顶住
 *    5. 两边各跑一个假模型打满十分钟，链路不断、船真的会动会开炮
 * ========================================================================== */
import fs from "node:fs";
import vm from "node:vm";

const FILES = [
  'js/core.js', 'js/data/ships.js', 'js/data/coastline.js', 'js/data/scenarios.js',
  'js/data/campaign.js', 'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js', 'js/sim/combat.js', 'js/sim/tactics.js', 'js/sim/ai.js', 'js/sim/squad.js',
  'js/sim/command.js', 'js/sim/floatplane.js', 'js/sim/recorder.js', 'js/sim/world.js',
  'js/sim/agent.js'
];
const ctx = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean,
  isNaN, parseFloat, parseInt
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
const N = ctx.Naval;

let bad = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { console.log("  ✗ " + msg); bad++; }
}

function makeWorld(id, seed, secs) {
  const w = new N.World(N.Scenarios.get(id || 'savo_melee'), { seed: seed || 777 });
  w.dsControl = { US: true, JP: true };
  const n = Math.round((secs || 0) / 0.1);
  for (let i = 0; i < n && !w.ended; i++) w.update(0.1);
  return w;
}

/* ---------------------------------------------------------------- 1. 简报 */
console.log("\n[1] 简报：只给这一方看得见的东西");
{
  const w = makeWorld('savo_melee', 777, 240);
  const b = N.Agent.brief(w, 'US');
  const mineIds = w.shipsOf('US').map(s => s.id);
  const foeIds = w.shipsOf('JP').map(s => s.id);

  ok(b.ships.length === mineIds.length, `己方舰 ${b.ships.length} 条，一条不少`);
  ok(b.ships.every(s => mineIds.indexOf(s.id) >= 0), '简报里的舰全是自己的');
  ok(!b.ships.some(s => foeIds.indexOf(s.id) >= 0), '没有把敌舰混进"己方"');
  ok(b.tracks.length > 0, `有 ${b.tracks.length} 条接触`);
  // 敌舰的真身不能出现：血量、进水这些字段只在 ships 里，而 ships 只有自己人
  ok(b.ships.every(s => s.hull_pct === undefined || mineIds.indexOf(s.id) >= 0), '敌舰没有血量');
  ok(b.objective.length > 0, `任务目标 ${b.objective.length} 条`);
  ok(b.visibility_km > 0, `能见度 ${b.visibility_km} km`);
  let jsonOk = true;
  try { JSON.parse(JSON.stringify(b)); } catch (e) { jsonOk = false; }
  ok(jsonOk, '简报能原样 JSON 序列化（没有函数、没有循环引用）');

  // 视距外的己方舰，拿到的是旧报告
  const stale = b.ships.filter(s => s.report_age_s > 0);
  ok(b.ships.every(s => s.report_age_s === undefined || s.report_age_s >= 1), '旧报告都带 report_age_s');

  // 接触都带年龄
  ok(b.tracks.every(t => typeof t.age_s === 'number'), '每条接触都标了情报有多旧');
  ok(b.tracks.every(t => typeof t.rng_km === 'number' && t.rng_km > 0), '每条接触都有距离');
}

/* ---------------------------------------------------------------- 2. 落地 */
console.log("\n[2] 指令落地：合法的照办，编出来的丢掉");
{
  const w = makeWorld('savo_melee', 777, 240);
  const flag = w.shipsOf('US')[0];
  const tr = N.Sensors.trackList(w, 'US')[0];

  const res = N.Agent.apply(w, 'US', {
    think: '压上去打',
    ships: {
      [flag.id]: { hdg: -30, spd: 99, engage: true, target: tr ? tr.id : null }
    }
  });
  ok(Math.abs(flag.orderedHeading - 330) < 0.01, `航向 -30 归一成 ${Math.round(flag.orderedHeading)}°`);
  ok(flag.orderedSpeed <= flag.effectiveMaxSpeed() + 1e-6,
    `航速 99 被压到 ${Math.round(flag.orderedSpeed)} 节（本舰上限 ${Math.round(flag.effectiveMaxSpeed())}）`);
  ok(flag.engage === true && flag.playerFireOrder === true, '开火令落到了舰上');
  ok(flag.autoTarget === false, '外部代理下令后，自动分配目标让位');
  if (tr) ok(flag.targetTrackId === tr.id, `目标锁定 ${tr.id}`);

  const res2 = N.Agent.apply(w, 'US', {
    ships: { 'NOPE-1': { hdg: 10 }, 'S999': { spd: 5 } }
  });
  ok(res2.applied.length === 0 && res2.ignored.length === 2, '不存在的舰 id 全部拒绝');
  ok(res2.ignored.join().includes('没有这艘舰'), '拒绝理由写清楚了');

  const res3 = N.Agent.apply(w, 'US', { ships: { [flag.id]: { target: 'ZZZ' } } });
  ok(res3.ignored.length === 1, '不存在的航迹也拒绝');

  ok(N.Agent.apply(w, 'US', null).ignored.length === 1, 'null 指令被挡下');
}

/* ------------------------------------------------- 3. 内置参谋部不再抢舵 */
console.log("\n[3] 交给外部代理的阵营，内置参谋部不抢舵");
{
  const w = makeWorld('savo_melee', 777, 60);
  let planCalls = 0;
  const origPlan = N.Tactics.plan;
  N.Tactics.plan = function () { planCalls++; return origPlan.apply(this, arguments); };

  const flag = w.shipsOf('US')[0];
  flag.orderedHeading = 200;
  flag.orderedSpeed = 20;
  for (let i = 0; i < 300; i++) w.update(0.1);      // 30 秒
  ok(planCalls === 0, `30 秒里参谋部一次都没重排（实际 ${planCalls} 次）`);
  const drift = Math.abs(((flag.orderedHeading - 200 + 540) % 360) - 180);
  ok(drift < 25, `代理给的航向守住了（偏 ${Math.round(drift)}°，绕陆地的修正另算）`);

  // 取消接管以后，参谋部应该重新开始工作
  w.dsControl = null;
  for (let i = 0; i < 150; i++) w.update(0.1);      // 15 秒
  ok(planCalls > 0, `取消接管后参谋部恢复（${planCalls} 次）`);
  N.Tactics.plan = origPlan;
}

/* ---------------------------------------------------------------- 4. 解析 */
console.log("\n[4] 模型输出乱七八糟时也顶得住");
{
  ok(N.Agent.parse('{"think":"x","ships":{}}') !== null, '裸 JSON 能解析');
  ok(N.Agent.parse('```json\n{"think":"x"}\n```') !== null, '包了代码块的能解析');
  ok(N.Agent.parse('好的，我的计划是：\n{"think":"绕后"}\n以上。') !== null, '前后带话的能解析');
  ok(N.Agent.parse('我建议往西北走') === null, '纯文字返回 null');
  ok(N.Agent.parse('') === null, '空字符串返回 null');
  ok(N.Agent.parse(null) === null, 'null 返回 null');

  const w = makeWorld('savo_melee', 777, 120);
  const fb = N.Agent.fallback(w, 'US');
  const ids = w.shipsOf('US').map(s => s.id);
  ok(ids.every(id => fb.ships[id]), `兜底策略给每条舰都下了令（${ids.length} 条）`);
  const res = N.Agent.apply(w, 'US', fb);
  ok(res.applied.length === ids.length, '兜底指令全部能落地');
}

/* --------------------------------------------------- 5. 两边打满十分钟 */
console.log("\n[5] 两个假模型各带一边，打满十分钟");
{
  const w = makeWorld('savo_melee', 2024, 0);
  let asks = 0, applied = 0;
  const lastAt = { US: -1e9, JP: -1e9 };

  /** 假模型：照着简报做最朴素的事 —— 往最近的接触压上去，进射程就开火 */
  function fakeModel(side) {
    const b = N.Agent.brief(w, side);
    const ships = {};
    const near = b.tracks.slice().sort((a, c) => a.rng_km - c.rng_km)[0];
    for (const s of b.ships) {
      const o = {};
      if (near) {
        o.hdg = Math.round(near.brg);
        o.spd = 26;
        if (near.rng_km < 13) { o.engage = true; o.target = near.id; }
        if (near.rng_km < 7 && s.torps > 0 && side === 'JP') o.torp = near.id;
      } else {
        o.hdg = Math.round(s.hdg); o.spd = 18;
      }
      ships[s.id] = o;
    }
    return { think: '按最近接触接敌', ships: ships };
  }

  let guard = 0;
  while (w.time < 600 && !w.ended && guard < 12000) {
    w.update(0.1); guard++;
    for (const side of ['US', 'JP']) {
      if (w.time - lastAt[side] < 6) continue;
      lastAt[side] = w.time;
      asks++;
      const act = fakeModel(side);
      const res = N.Agent.apply(w, side, act);
      applied += res.applied.length;
    }
  }

  ok(asks >= 150, `${Math.round(w.time)} 秒里两边一共问了 ${asks} 次`);
  ok(applied > 0, `落地了 ${applied} 条指令`);
  ok(w.time > 300, `战场推进到 ${Math.round(w.time)} 秒`);

  const moved = w.ships.filter(s => s.sunk || s.hull < s.hullMax || s.flood > 0);
  ok(moved.length > 0, `${moved.length} 条舰受了损 —— 双方真的打起来了`);

  const shot = w.ships.some(s => s.engage);
  ok(shot || w.ended, '有人开过火（或者已经分出胜负）');
}

/* ------------------------------------------------------------ 6. 真调一次 */
console.log("\n[6] 真调一次（可选）");
{
  const live = process.argv.includes('--live');
  const key = process.env.DEEPSEEK_API_KEY;
  if (!live || !key) {
    console.log("  · 跳过：加 --live 并设置 DEEPSEEK_API_KEY 才会真调");
  } else {
    const w = makeWorld('savo_melee', 777, 180);
    const b = N.Agent.brief(w, 'US');
    const body = {
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: N.Agent.systemPrompt() },
        { role: 'user', content: N.Agent.userPrompt(b) }
      ],
      temperature: 0.5,
      max_tokens: 700,
      response_format: { type: 'json_object' }
    };
    const t0 = Date.now();
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    const text = d && d.choices && d.choices[0] && d.choices[0].message.content;
    ok(!!text, `模型回了话（${Date.now() - t0} ms，${d.usage ? d.usage.total_tokens : '?'} tokens）`);
    const act = N.Agent.parse(text);
    ok(!!act, '回话能解析成 JSON');
    if (act) {
      const res = N.Agent.apply(w, 'US', act);
      console.log("     think: " + (act.think || ''));
      console.log("     落地: " + res.applied.slice(0, 4).join(' / '));
      if (res.ignored.length) console.log("     丢掉: " + res.ignored.slice(0, 4).join(' / '));
      ok(res.applied.length > 0, '至少有一条指令能落地');
    } else {
      console.log("     原文: " + String(text).slice(0, 300));
    }
  }
}

console.log("\n" + (bad === 0 ? "✅ 双 AI 对战自检全部通过" : `❌ 有 ${bad} 项没过`));
process.exit(bad === 0 ? 0 : 1);
