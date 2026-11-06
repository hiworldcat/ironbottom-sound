/* 无头测试：在 Node 中加载仿真层，跑完整场战斗，检查逻辑与数值。
 * 用法: node tools/headless-test.mjs [scenarioId]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  'js/core.js',
  'js/data/ships.js',
  'js/data/coastline.js',
  'js/data/scenarios.js',
  'js/sim/weather.js', 'js/sim/damage.js', 'js/sim/sensors.js',
  'js/sim/ship.js',
  'js/sim/combat.js',
  'js/sim/ai.js',
  'js/sim/squad.js', 'js/sim/command.js',
  'js/sim/recorder.js',
  'js/sim/world.js'
];

globalThis.Naval = {};
for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  vm.runInThisContext(code, { filename: f });
}

const N = globalThis.Naval;
const problems = [];
const only = process.argv[2];

function run(scenarioId, label, opts) {
  const scenario = N.Scenarios.get(scenarioId);
  if (!scenario) throw new Error('场景未注册: ' + scenarioId);
  const world = new N.World(scenario, opts);
  const dt = 0.1;
  const maxT = ((scenario.victory && scenario.victory.timeLimit) || 2700) + 200;
  let steps = 0;
  const t0 = Date.now();

  // 出生点不能压在岛上（World 会自动挪开，但那是兜底，剧本本身应当是对的）
  if (world.spawnFixups && world.spawnFixups.length) {
    for (const fx of world.spawnFixups) {
      problems.push(`${scenarioId}/${label}: ${fx.side} ${fx.name} 出生在陆地 (${fx.from.x},${fx.from.y})，偏移 ${fx.d}m`);
    }
  }
  // 集结 / 搜索海域也不能在岛上
  if (world.posFixups && world.posFixups.length) {
    for (const fx of world.posFixups) {
      problems.push(`${scenarioId}/${label}: ${fx.kind}.${fx.side} 在陆地 (${fx.from.x},${fx.from.y})，偏移 ${fx.d}m`);
    }
  }

  // 整场航行不能压陆地。战斗损伤之后被浪推上礁盘是正常的，
  // 只有"陷在岸上出不来"（连续超过 90 秒）才算导航出问题。
  const aground = {};
  const runLen = {};
  const STUCK = 180;              // 采样每 0.5 秒一次 → 180 次 = 90 秒
  while (!world.ended && world.time < maxT) {
    world.update(dt);
    steps++;
    if (steps % 5 === 0) {
      for (const s of world.ships) {
        // 已经在沉没的舰不算：沉船漂到哪片礁盘上不叫"航行压陆地"
        if (s.sunk || s.sinking) continue;
        const k = s.side + ' ' + s.name;
        if (world.isLand(s.pos.x, s.pos.y)) {
          runLen[k] = (runLen[k] || 0) + 1;
          if (runLen[k] > (aground[k] || 0)) aground[k] = runLen[k];
        } else {
          runLen[k] = 0;
        }
      }
    }
    if (steps > 400000) break;
  }
  for (const k of Object.keys(aground)) {
    if (aground[k] < STUCK) continue;
    problems.push(`${scenarioId}/${label}: ${k} 陷在陆地上 ${(aground[k] * 0.5).toFixed(0)} 秒出不来`);
  }
  const elapsed = Date.now() - t0;

  console.log(`\n========== ${scenario.title} · ${label} ==========`);
  console.log('模拟时长:', (world.time / 60).toFixed(1), '分钟   ',
    '结果:', world.result ? world.result.result : '未结束', '-', world.result ? world.result.reason : '');
  console.log('性能:', elapsed, 'ms =>', (world.time / (elapsed / 1000)).toFixed(0), 'x 实时');

  for (const side of ['US', 'JP']) {
    console.log(`--- ${side} ---`);
    for (const s of world.shipsOf(side)) {
      console.log(
        `  ${s.name.padEnd(5, '　')} ${s.cls.typeName.padEnd(4, '　')}  ` +
        `hull ${s.hull.toFixed(0).padStart(3)}/${s.hullMax}  ` +
        `flood ${s.flood.toFixed(0).padStart(3)}  fire ${s.fire.toFixed(0).padStart(3)}  ` +
        `spd ${s.speed.toFixed(1).padStart(4)}/${s.effectiveMaxSpeed().toFixed(1).padStart(4)}  ` +
        `命中 ${String(s.hitsDealt).padStart(3)}  被弹 ${String(s.hitsTaken).padStart(3)}  雷击 ${s.torpsHitTaken}  ` +
        `${s.sunk ? '【沉没】' : (s.sinking ? '【沉没中】' : '')}`
      );
    }
    console.log(`  战力剩余: ${(world.powerRatio(side) * 100).toFixed(0)}%`);
  }

  const objectives = world.evaluateObjectives();
  if (objectives.length) {
    console.log('--- 任务目标 ---');
    for (const o of objectives) {
      console.log(`  [${o.done ? '✓' : ' '}] ${o.text}  ${(o.progress * 100).toFixed(0)}% ${o.note || ''}`);
    }
  }

  if (world.shoreTargets.length) {
    console.log('--- 岸上目标 ---');
    for (const t of world.shoreTargets) {
      console.log(`  ${t.name}  ${t.hp.toFixed(0)}/${t.maxHp} ${t.destroyed ? '【已摧毁】' : ''}`);
    }
  }

  // 断言
  if (world.ships.some(s => !isFinite(s.pos.x) || !isFinite(s.pos.y))) problems.push(label + ': NaN 坐标');
  if (!world.result) problems.push(label + ': 战斗未结束');
  if (world.messages.length === 0) problems.push(label + ': 没有战报');
  if (!world.ships.some(s => Math.abs(s.pos.x) > 2000 || Math.abs(s.pos.y) > 2000)) problems.push(label + ': 舰艇没有移动');
  if (world.recorder && world.recorder.frames.length < 10) problems.push(label + ': 录像帧数过少');
  if (world.ships.some(s => world.isLand(s.pos.x, s.pos.y) && !s.sunk && s.speed > 1)) {
    problems.push(label + ': 有舰艇卡在陆地上');
  }

  const totalHits = world.ships.reduce((a, s) => a + s.hitsDealt, 0);
  return { world, totalHits };
}

/* ---------- 照明弹规则自检 ---------- */
function testStarshell() {
  const sc = N.Scenarios.get('night_escort');
  const world = new N.World(sc, { seed: 424242 });
  const ship = world.shipsOf(world.playerSide).find(s => s.starshells > 0);
  if (!ship) { problems.push('夜间场景里没有携带照明弹的舰艇'); return; }

  const before = ship.starshells;
  const aim = { x: ship.pos.x + 5000, y: ship.pos.y };
  const err = world.fireStarshell(ship, aim);
  if (err !== null) problems.push('照明弹发射失败: ' + err);
  if (ship.starshells !== before - 1) problems.push('照明弹数量没有减少');
  if (ship.starshellCd <= 0) problems.push('照明弹没有进入装填');
  if (world.fireStarshell(ship, aim) !== 'cooldown') problems.push('装填期间仍可发射');
  if (world.illum.length !== 0) problems.push('照明弹未飞抵就产生了照明区');

  for (let i = 0; i < 40; i++) world.update(0.1);   // 4 秒
  if (world.illum.length < 1) { problems.push('照明弹没有按时爆燃'); return; }
  const shell = world.starshells.find(s => s.pos === world.illum[0].pos) || world.starshells[0];
  const il = world.illum[0];
  if (world.illuminationAt(il.pos) !== 11000) problems.push('照明区内的可见距离不是 11000');
  const outside = { x: il.pos.x + il.r + 500, y: il.pos.y };
  if (world.illuminationAt(outside) !== 0) problems.push('照明区外也被照亮了');

  for (let i = 0; i < 520; i++) world.update(0.1);   // 再 52 秒
  if (world.starshells.indexOf(shell) >= 0) problems.push('照明弹超时没有清理');
  if (world.illum.some(x => x.pos === shell.pos)) problems.push('照明弹超时仍在照明');
  console.log('照明弹自检: 发射→3.5s 爆燃→50s 熄灭，半径 ' +
    (il.r / 1000).toFixed(1) + ' km，可见距离 11 km，装填/数量限制正常');
}
testStarshell();

/* ---------- 回放快照结构自检（渲染层直接消费这些字段） ---------- */
function testReplayShape() {
  let torpTotal = 0, torpNamedTotal = 0, splashTotal = 0;
  for (const sc of N.Scenarios.available()) {
    const world = new N.World(sc, { seed: 31337 });
    for (let i = 0; i < 5000; i++) world.update(0.1);   // 500 秒：足够打到炮战
    const rp = new N.Replay(world.recorder, sc);
    const pw = rp.sampleAt(rp.duration * 0.5);
    if (!pw) { problems.push(sc.id + ': 回放采样为空'); continue; }

    if (!pw.ships.length) problems.push(sc.id + ': 回放没有舰艇');
    for (const z of pw.zones) {
      if (!z.pos || !isFinite(z.pos.x)) problems.push(sc.id + ': 回放区域缺少坐标');
    }
    for (const sh of pw.shoreTargets) {
      if (!sh.pos || !isFinite(sh.pos.x)) problems.push(sc.id + ': 回放岸上目标缺少坐标');
    }
    if (!Array.isArray(pw.starshells)) problems.push(sc.id + ': 回放缺少 starshells');
    if (!Array.isArray(pw.illum)) problems.push(sc.id + ': 回放缺少 illum');
    for (const s of pw.ships) {
      if (!s.pos || !isFinite(s.pos.x) || !isFinite(s.pos.y)) problems.push(sc.id + ': 回放舰位异常');
      if (!Array.isArray(s.trail)) problems.push(sc.id + ': 回放缺少运动轨迹');
      if (s.orderedHeading == null) problems.push(sc.id + ': 回放缺少指令航向');
      if (s.cls == null) problems.push(sc.id + ': 回放缺少舰级');
    }
    // 双方都要有舰艇（回放是上帝视角）
    const sides = new Set(pw.ships.map(s => s.side));
    if (sides.size < 2) problems.push(sc.id + ': 回放只还原了一方');

    // 回放必须能溯源：每发水柱、每条鱼雷都要带发射舰
    let splashSeen = 0, splashNamed = 0, torpSeen = 0, torpNamed = 0;
    for (const t of pw.torpedoes) {
      torpSeen++;
      if (t.ownerName) torpNamed++;
      if (!t.start || !isFinite(t.start.x)) problems.push(sc.id + ': 回放鱼雷缺少发射点');
    }
    for (const sp of pw.splashes) {
      splashSeen++;
      if (sp.ownerName) splashNamed++;
    }
    // 采样点可能正好没有落水柱/鱼雷，扫一遍整段录像再判定
    if (splashSeen === 0) {
      for (let t = 0; t <= rp.duration; t += Math.max(1, rp.duration / 40)) {
        const f = rp.frameAt(t);
        if (f && f.splashes && f.splashes.length) {
          for (const sp of f.splashes) { splashSeen++; if (sp.o) splashNamed++; }
          if (splashSeen) break;
        }
      }
    }
    if (splashSeen > 0 && splashNamed === 0) {
      problems.push(sc.id + ': 回放水柱没有记录发射舰（无法溯源）');
    }
    if (torpSeen > 0 && torpNamed === 0) {
      problems.push(sc.id + ': 回放鱼雷没有记录发射舰（无法溯源）');
    }
    torpTotal += torpSeen;
    torpNamedTotal += torpNamed;
    splashTotal += splashSeen;
  }
  console.log('回放快照自检: 区域 / 岸上目标 / 双方舰艇 / 轨迹 / 指令航向齐全');
  console.log(`回放溯源自检: 水柱 ${splashTotal} 条、鱼雷 ${torpTotal} 条，带发射舰名称 ${torpNamedTotal} 条`);
  if (splashTotal === 0) problems.push('回放自检: 整段录像里一条水柱都没有');
}

/** 鱼雷溯源：直接打一条，确认录像里带发射舰 */
function testTorpedoAttribution() {
  const sc = N.Scenarios.get('day_surface_action');
  const world = new N.World(sc, { seed: 1 });
  for (let i = 0; i < 20; i++) world.update(0.1);   // 让时间轴离开 0
  const jp = world.shipsOf('JP').filter(s => s.torps.length && s.torps[0].loaded > 0)[0];
  const us = world.shipsOf('US')[0];
  if (!jp) { problems.push('鱼雷自检: 找不到带鱼雷的日舰'); return; }

  // 摆正舷角，确保发射管对准目标
  let fired = 0;
  for (let h = 0; h < 360 && fired <= 0; h += 10) {
    jp.heading = h;
    fired = N.Combat.launchTorpedoes(world, jp, jp.torps[0],
      us.pos, 0, 18, 2, 2);
  }
  if (fired <= 0) { problems.push('鱼雷自检: 一条都打不出去'); return; }

  world.recorder.capture(true);
  const rp = new N.Replay(world.recorder, sc);
  const pw = rp.sampleAt(world.time);
  const torps = pw.torpedoes || [];
  if (!torps.length) { problems.push('鱼雷自检: 回放里没有鱼雷'); return; }
  for (const t of torps) {
    if (!t.ownerName) problems.push('鱼雷自检: 回放鱼雷没有发射舰名称');
    if (t.ownerName !== jp.name) problems.push(`鱼雷自检: 发射舰错成 ${t.ownerName}（应为 ${jp.name}）`);
    if (!t.start || !isFinite(t.start.x)) problems.push('鱼雷自检: 缺少发射点');
  }
  // 未发现的敌方鱼雷也必须画出来（回放是上帝视角）
  const hidden = torps.filter(t => t.side !== pw.playerSide && !t.spotted).length;
  console.log(`鱼雷溯源自检: ${torps.length} 条，发射舰 ${torps[0].ownerName}，其中未被发现 ${hidden} 条仍会显示`);
}
/* ---------- 小队 / 战列线自检 ---------- */
function squadWorld(count) {
  // 复制一份场景定义再改：直接改会污染全局场景表，后面的战斗就永远打不完
  const sc = Object.assign({}, N.Scenarios.get('day_surface_action'), {
    check: () => null, objectives: [], update: null
  });
  const world = new N.World(sc, { seed: 1 });
  const ships = world.shipsOf('US').filter(s => s.cls.type !== 'AK').slice(0, count);
  // 找一片开阔水域做试验场：所罗门中部 159.6°E / 8.0°S，四周 40 km 内没有陆地
  const base = N.MAP.at(159.60, -8.00);
  ships.forEach((s, i) => {
    s.pos.x = base.x + (i % 2) * 1500;
    s.pos.y = base.y + Math.floor(i / 2) * 1500;
    s.heading = 90; s.orderedHeading = 90;
    s.speed = 16; s.orderedSpeed = 16;
  });
  world.ships = ships;
  return { world, ships };
}

function maxErr(sq, world) {
  let m = 0;
  sq.shipIds.forEach((id, i) => {
    const s = world.shipById(id);
    m = Math.max(m, N.V.dist(s.pos, N.Squad.stationOf(sq, i).pos));
  });
  return m;
}

function step(world, seconds) {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) world.update(0.1);
}

/** 点到航迹折线的最短距离：用来验证后舰是不是真的走在领舰压出来的航迹上 */
function distToTrack(sq, p) {
  const t = sq.track;
  if (!t || t.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1], b = t[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let k = L > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    k = Math.max(0, Math.min(1, k));
    const q = { x: a.x + dx * k, y: a.y + dy * k };
    best = Math.min(best, N.V.dist(p, q));
  }
  return best;
}

function testSquad() {
  /* --- 编队几何 --- */
  {
    const { world, ships } = squadWorld(4);
    const sq = N.Squad.create(world, ships.map(s => s.id), {
      lines: 2, spacing: 800, lineGap: 1200, speed: 16, turnMode: 'line'
    });
    if (!sq) { problems.push('编队自检: 建不出小队'); return; }
    if (sq.shipIds.length !== 4) problems.push('编队自检: 小队舰数不对');
    if (N.Squad.lineCountOf(sq) !== 2) problems.push('编队自检: 战列线数不对');
    if (N.Squad.perLineOf(sq) !== 2) problems.push('编队自检: 每线舰数不对');

    const a = N.Squad.stationOf(sq, 0).pos, b = N.Squad.stationOf(sq, 1).pos;
    const c = N.Squad.stationOf(sq, 2).pos;
    if (Math.abs(N.V.dist(a, b) - 1200) > 1) problems.push('编队自检: 线间距不是 1200');
    if (Math.abs(N.V.dist(a, c) - 800) > 1) problems.push('编队自检: 同线间距不是 800');

    step(world, 420);
    const e = maxErr(sq, world);
    if (e > 250) problems.push(`编队自检: 收拢后最大站位误差 ${Math.round(e)} m（应 < 250）`);
    console.log(`编队自检: 4 舰 / 2 条战列线，7 分钟收拢后最大误差 ${Math.round(e)} m`);
  }

  /* --- 依次转向：后舰必须走在领舰压出来的航迹上 --- */
  {
    const { world, ships } = squadWorld(4);
    const sq = N.Squad.create(world, ships.map(s => s.id), {
      lines: 1, spacing: 900, speed: 16, turnMode: 'line'
    });
    step(world, 420);                       // 先排成纵队

    // 记下转向前的队形，确认后面确实转过
    const before = sq.course;
    N.Squad.issueCourse(world, sq, 200, 'line');
    step(world, 900);                       // 转 15 分钟，足够转完并重新稳定

    // 每艘舰是不是都压在领舰航迹上
    let worstOff = 0;
    sq.shipIds.forEach((id, i) => {
      const s = world.shipById(id);
      worstOff = Math.max(worstOff, distToTrack(sq, s.pos));
    });
    if (worstOff > 120) {
      problems.push(`依次转向自检: 有舰偏离领舰航迹 ${Math.round(worstOff)} m（应 < 120）`);
    }

    // 航向转到位了
    const hd = sq.shipIds.map(id => world.shipById(id).heading);
    const hdOff = Math.max(...hd.map(h => Math.abs(N.U.angDiff(h, 200))));
    if (hdOff > 20) problems.push(`依次转向自检: 有舰没转到新航向（偏 ${Math.round(hdOff)}°）`);
    if (Math.abs(N.U.angDiff(sq.axis, 200)) > 3) problems.push('依次转向自检: 轴线没跟上航迹切向');

    // 队形还是纵队：相邻两舰的间距应当接近设定值
    const gaps = [];
    for (let i = 1; i < sq.shipIds.length; i++) {
      gaps.push(N.V.dist(world.shipById(sq.shipIds[i - 1]).pos,
                         world.shipById(sq.shipIds[i]).pos));
    }
    const badGap = Math.max(...gaps.map(g => Math.abs(g - 900)));
    if (badGap > 350) problems.push(`依次转向自检: 纵队间距散了（偏差 ${Math.round(badGap)} m）`);
    if (before === 200) problems.push('依次转向自检: 测试本身没转');
    console.log(`依次转向自检: 110° 转向后 4 舰全部压在领舰航迹上（最大偏离 ` +
      `${Math.round(worstOff)} m），间距 ${gaps.map(g => Math.round(g)).join('/')} m`);
  }

  /* --- 依次转向 vs 同转：转向过程中各舰航向必须不同 / 基本相同 --- */
  {
    function midTurnHeadings(mode) {
      const { world, ships } = squadWorld(4);
      const sq = N.Squad.create(world, ships.map(s => s.id), {
        lines: 1, spacing: 900, speed: 16, turnMode: mode
      });
      step(world, 420);
      N.Squad.issueCourse(world, sq, 270, mode);
      step(world, 150);                      // 转了一半的时候取样
      return {
        hd: sq.shipIds.map(id => world.shipById(id).heading),
        spread: (() => {
          const h = sq.shipIds.map(id => world.shipById(id).heading);
          const ref = h[0];
          return Math.max(...h.map(x => Math.abs(N.U.angDiff(x, ref))));
        })()
      };
    }

    const line = midTurnHeadings('line');
    const tog = midTurnHeadings('together');
    if (line.spread < 12) {
      problems.push(`转向对比: 依次转向时各舰航向几乎一样（${Math.round(line.spread)}°），` +
        '说明不是沿航迹跟转');
    }
    // 同转时队形要从纵队摊成横队，摊的过程里各舰会有几十度的差异，
    // 但绝不该像依次转向那样差出一整个转弯角
    if (tog.spread > 40) {
      problems.push(`转向对比: 同转时各舰航向差 ${Math.round(tog.spread)}°，应当基本一致`);
    }
    if (line.spread < tog.spread + 30) {
      problems.push(`转向对比: 依次转向(${Math.round(line.spread)}°) 与同转(${Math.round(tog.spread)}°) ` +
        '差得不够开');
    }
    console.log(`转向对比: 转了一半时 依次转向 各舰航向相差 ${Math.round(line.spread)}°，` +
      `同转 相差 ${Math.round(tog.spread)}°`);
  }

  /* --- 沿指定航线行进 --- */
  {
    const { world, ships } = squadWorld(4);
    const sq = N.Squad.create(world, ships.map(s => s.id), {
      lines: 2, spacing: 800, lineGap: 1200, speed: 18
    });
    step(world, 300);
    const a0 = { x: sq.anchor.x, y: sq.anchor.y };

    // 三个航路点，走一个 U 形：先北、再东、再南
    const wp = [
      { x: a0.x, y: a0.y + 3000 },
      { x: a0.x + 4000, y: a0.y + 3000 },
      { x: a0.x + 4000, y: a0.y - 3000 }
    ];
    N.Squad.issueRoute(world, sq, wp);
    if (!sq.order) problems.push('航线自检: 航线命令没排上');

    // 走的过程中航迹必须是一段一段拐的，不是一条直线
    let turned = 0, lastH = sq.course;
    for (let i = 0; i < 15000; i++) {
      world.update(0.1);
      turned += Math.abs(N.U.angDiff(sq.course, lastH));
      lastH = sq.course;
    }
    if (turned < 90) problems.push(`航线自检: 领舰总共只转了 ${Math.round(turned)}°，航线没走成`);
    if (sq.route.length) problems.push(`航线自检: 航路点还剩 ${sq.route.length} 个没走完`);

    // 到最后一个航路点附近
    const dEnd = N.V.dist(sq.anchor, wp[wp.length - 1]);
    if (dEnd > 2500) problems.push(`航线自检: 终点还差 ${Math.round(dEnd)} m`);

    // 到点后让队形重新收拢，再看后舰是不是还在航迹上。
    // 注意 1 号线本来就横着偏开一个线距，所以比的是"离航迹的距离"与"该线应有的横向偏移"之差。
    step(world, 300);
    const lines = N.Squad.lineCountOf(sq);
    let worst = 0;
    sq.shipIds.forEach((id, i) => {
      const lat = (i % lines) * sq.lineGap;
      worst = Math.max(worst, Math.abs(distToTrack(sq, world.shipById(id).pos) - lat));
    });
    if (worst > 200) problems.push(`航线自检: 有舰没跟着航线走（偏离 ${Math.round(worst)} m）`);

    console.log(`航线自检: U 形航线（3 个航路点）走完，领舰累计转向 ${Math.round(turned)}°，` +
      `终点残余 ${Math.round(dEnd)} m，后舰偏离航迹 ${Math.round(worst)} m`);
  }

  /* --- 同转：全队同时转同一个角度，不追航迹、不保持战列线 --- */
  {
    const { world, ships } = squadWorld(4);
    // 先按依次转向排成纵队，再改成同转 —— 这才是玩家会遇到的顺序
    const sq = N.Squad.create(world, ships.map(s => s.id), {
      lines: 1, spacing: 900, speed: 16, turnMode: 'line'
    });
    step(world, 420);
    const gap0 = N.V.dist(world.shipById(sq.shipIds[0]).pos,
      world.shipById(sq.shipIds[3]).pos);
    if (gap0 < 2400) problems.push(`同转自检: 转向之前没排成纵队（首尾 ${Math.round(gap0)} m）`);
    N.Squad.issueCourse(world, sq, 200, 'together');
    step(world, 240);
    const hd = sq.shipIds.map(id => world.shipById(id).heading);
    const off = Math.max(...hd.map(h => Math.abs(N.U.angDiff(h, 200))));
    if (off > 25) problems.push(`同转自检: 有舰没转到位（最大偏差 ${Math.round(off)}°）`);
    // 横队：相邻舰的横向距离远大于纵向
    const p0 = world.shipById(sq.shipIds[0]).pos;
    const p3 = world.shipById(sq.shipIds[3]).pos;
    const bearing = N.Geo.bearing(p0, p3);
    const abeam = Math.abs(N.U.angDiff(bearing, 200 + 90));
    if (abeam > 40) problems.push(`同转自检: 转向后不是横队（相邻舰方位差 ${Math.round(abeam)}°）`);
    // 不保持战列线：队形整体平移过去，首尾间距不变，也没有被拉去补位
    const gap1 = N.V.dist(p0, p3);
    if (Math.abs(gap1 - gap0) > 200) {
      problems.push(`同转自检: 队形被强行重排了（首尾间距 ${Math.round(gap0)} → ${Math.round(gap1)} m）`);
    }
    const stErr = Math.max(...sq.shipIds.map((id, i) =>
      N.V.dist(world.shipById(id).pos, N.Squad.stationOf(sq, i).pos)));
    if (stErr > 1) problems.push(`同转自检: 同转时不该有强制站位（误差 ${Math.round(stErr)} m）`);
    console.log(`同转自检: 纵队 4 舰航向最大偏差 ${Math.round(off)}°，队形整体平移成横队` +
      `（首尾间距 ${Math.round(gap0)} → ${Math.round(gap1)} m），无强制站位`);
  }

  /* --- 掉队与减员 --- */
  {
    const { world, ships } = squadWorld(4);
    const sq = N.Squad.create(world, ships.map(s => s.id), { lines: 2, spacing: 800 });
    const victim = world.shipById(sq.shipIds[1]);
    victim.sunk = true; victim.alive = false;
    world.update(0.1);
    if (sq.shipIds.includes(victim.id)) problems.push('减员自检: 沉没的舰没被移出小队');
    if (sq.shipIds.length !== 3) problems.push('减员自检: 小队舰数没有更新');
    sq.shipIds.forEach((id, i) => {
      if (world.shipById(id).squadSlot !== i) problems.push('减员自检: 站位编号没有重排');
    });

    N.Squad.remove(world, sq);
    if (world.squads.length !== 0) problems.push('减员自检: 解散后小队还在');
    if (world.ships.some(s => s.squadId)) problems.push('减员自检: 解散后舰还挂着 squadId');
    console.log('减员自检: 沉舰自动移出、站位重排、解散清理干净');
  }

  /* --- 录像：战列线几何能进回放 --- */
  {
    const { world, ships } = squadWorld(4);
    const sq = N.Squad.create(world, ships.map(s => s.id), { lines: 2, spacing: 800 });
    step(world, 60);
    world.recorder.capture(true);
    const rp = new N.Replay(world.recorder, world.scenario);
    const pw = rp.sampleAt(world.time);
    if (!pw.squads || !pw.squads.length) {
      problems.push('回放自检: 回放里没有战列线');
    } else {
      const r = pw.squads[0];
      if (r.shipIds.length !== 4) problems.push('回放自检: 战列线舰数不对');
      if (!isFinite(r.anchor.x) || !isFinite(r.axis)) problems.push('回放自检: 战列线几何是 NaN');
      if (!r.track || r.track.length < 2) problems.push('回放自检: 回放里没有航迹');
      // 回放里的站位必须还能算出来，而且不是全挤在锚点上
      const s0 = N.Squad.stationOf(r, 0).pos, s3 = N.Squad.stationOf(r, 3).pos;
      if (N.V.dist(s0, s3) < 300) problems.push('回放自检: 回放里站位挤成一团');
      if (typeof pw.squadById !== 'function' || !pw.squadById(r.id)) {
        problems.push('回放自检: 回放世界缺少 squadById');
      }
    }
    console.log('回放自检: 战列线几何 + 航迹随帧记录，回放世界可查');
  }
}
/* ==========================================================================
 *  指挥舰 / 无线电
 * ========================================================================== */
function cmdWorld(id, seed) {
  const sc = Object.assign({}, N.Scenarios.get(id), { check: () => null, objectives: [], update: null });
  return new N.World(sc, { seed: seed || 5 });
}

function testCommand() {
  // --- 旗舰 ---
  const w = cmdWorld('day_surface_action');
  const st = N.Command.statusOf(w, 'US');
  const jp = N.Command.statusOf(w, 'JP');
  if (!st.flagshipName) problems.push('指挥自检: 美方没有选出指挥舰');
  if (!jp.flagshipName) problems.push('指挥自检: 日方没有选出指挥舰');
  if (!st.radioOk || !st.iffOk) problems.push('指挥自检: 开局电台/识别器就坏了');

  // --- 视距内是即时、不丢包 ---
  const flag = N.Command.flagshipOf(w, 'US');
  const mate = w.shipsOf('US').find(s => s !== flag);
  mate.pos = { x: flag.pos.x + 1500, y: flag.pos.y };
  if (!N.Command.inVisual(w, mate, flag)) problems.push('指挥自检: 1.5 km 不算视距内');
  let visOk = 0, visDelay = 0;
  for (let i = 0; i < 50; i++) {
    const r = w.issueOrder(mate, (i * 13) % 360, 18);
    if (r.ok && r.visual) { visOk++; visDelay = Math.max(visDelay, r.delay); }
  }
  if (visOk !== 50) problems.push('指挥自检: 视距内命令竟然丢了');
  if (visDelay > 5) problems.push(`指挥自检: 视距内命令延迟 ${visDelay.toFixed(1)}s 太长`);

  // --- 视距外：延迟 + 丢包 ---
  const w2 = cmdWorld('day_surface_action');
  const f2 = N.Command.flagshipOf(w2, 'US');
  const far = w2.shipsOf('US').find(s => s !== f2);
  far.pos = { x: f2.pos.x + 26000, y: f2.pos.y };
  if (N.Command.inVisual(w2, far, f2)) problems.push('指挥自检: 26 km 被算成视距内');
  let ok = 0, lost = 0, ds = [];
  for (let i = 0; i < 600; i++) {
    const r = w2.issueOrder(far, (i * 7) % 360, 20);
    if (r.ok) { ok++; ds.push(r.delay); } else if (r.lost) lost++;
  }
  ds.sort((a, b) => a - b);
  const med = ds[ds.length >> 1] || 0;
  if (med < 50) problems.push(`指挥自检: 26 km 命令延迟中位数只有 ${Math.round(med)}s，太短`);
  const lossPct = lost / 600;
  if (lossPct < 0.03 || lossPct > 0.3) problems.push(`指挥自检: 白昼丢包率 ${(lossPct * 100).toFixed(0)}% 不合理`);

  // --- 夜间/恶劣天气丢包率上升，延迟不变 ---
  const dayLoss = N.Command.lossChance(cmdWorld('day_surface_action'), 'US');
  const nightLoss = N.Command.lossChance(cmdWorld('night_escort'), 'US');
  if (!(nightLoss > dayLoss)) problems.push('指挥自检: 夜间丢包率没有比白昼高');
  const w3 = cmdWorld('day_surface_action');
  const jam = N.Command.lossChance(Object.assign(w3, { jamming: { US: 0.2, JP: 0 } }), 'US');
  if (!(jam > dayLoss)) problems.push('指挥自检: 干扰没有叠加到丢包率上');
  const w4 = cmdWorld('day_surface_action');
  w4.env.weather = '暴雨'; w4.env.rain = 10;
  if (!(N.Command.lossChance(w4, 'US') > dayLoss)) problems.push('指挥自检: 暴雨没有提高丢包率');

  // --- 电台 / 识别器被打掉 ---
  const w5 = cmdWorld('day_surface_action');
  const f5 = N.Command.flagshipOf(w5, 'US');
  const r5 = w5.shipsOf('US').find(s => s !== f5);
  r5.pos = { x: f5.pos.x + 26000, y: f5.pos.y };
  r5.radioDestroyed = true;
  const rr = w5.issueOrder(r5, 0, 20);
  if (rr.ok) problems.push('指挥自检: 电台被打掉还能下令');
  const cmd5 = N.Command.cmdOf(w5, 'US');
  if (N.Command.classify(w5, cmd5, {}) !== 'hostile') problems.push('指挥自检: IFF 正常时没判成敌舰');
  f5.iffDestroyed = true;
  if (N.Command.classify(w5, cmd5, {}) !== 'unknown') problems.push('指挥自检: IFF 被打掉还能识别');

  // --- IFF 误判率 ---
  const w6 = cmdWorld('day_surface_action');
  const cmd6 = N.Command.cmdOf(w6, 'US');
  let wrong = 0;
  for (let i = 0; i < 40000; i++) if (N.Command.classify(w6, cmd6, {}) !== 'hostile') wrong++;
  const iffPct = wrong / 40000;
  if (iffPct < 0.005 || iffPct > 0.02) problems.push(`指挥自检: IFF 误判率 ${(iffPct * 100).toFixed(2)}%，不是 1%`);

  // --- 远处的己方舰，图上状态是旧的 ---
  const w7 = cmdWorld('night_escort', 9);
  const f7 = N.Command.flagshipOf(w7, 'US');
  const rem7 = w7.shipsOf('US').find(s => s !== f7);
  rem7.pos = { x: f7.pos.x + 25000, y: f7.pos.y };
  for (let i = 0; i < 900; i++) w7.update(0.1);
  const v7 = N.Command.ownView(w7, rem7);
  const age7 = w7.time - (v7.reportedAt || 0);
  if (age7 < 20) problems.push(`指挥自检: 25 km 外的己方舰报告只有 ${Math.round(age7)}s 旧，太新`);
  if (v7.exact) problems.push('指挥自检: 视距外的己方舰被当成实时状态');

  // --- 旗舰自己的雷达是实时的（这不算作弊，它就在指挥舰上） ---
  const liveAge = Math.min(...N.Sensors.trackList(w7, 'US').map(t => N.Command.ageOf(w7, t)));
  if (N.Sensors.trackList(w7, 'US').length && liveAge > 20) {
    problems.push(`指挥自检: 旗舰自己的雷达数据也延迟了 ${Math.round(liveAge)}s`);
  }

  // --- 指挥交接 ---
  const w8 = cmdWorld('day_surface_action');
  const f8 = N.Command.flagshipOf(w8, 'US');
  const name8 = f8.name;
  f8.sunk = true; f8.alive = false;
  w8.update(0.1);
  if (N.Command.statusOf(w8, 'US').online) problems.push('指挥自检: 旗舰沉了还没中断指挥');
  for (let i = 0; i < 500; i++) w8.update(0.1);
  const st8 = N.Command.statusOf(w8, 'US');
  if (!st8.online) problems.push('指挥自检: 旗舰沉了以后没有交接');
  if (st8.flagshipName === name8) problems.push('指挥自检: 交接给了同一艘船');

  console.log(`指挥自检: 视距内 50 次命令 ${visDelay.toFixed(1)}s 内送达且不丢；` +
    `26 km 外延迟中位 ${Math.round(med)}s、丢包 ${(lossPct * 100).toFixed(0)}%；` +
    `夜间丢包 ${Math.round(nightLoss * 100)}% > 白昼 ${Math.round(dayLoss * 100)}%；` +
    `IFF 误判 ${(iffPct * 100).toFixed(2)}%`);
  console.log(`指挥自检: 旗舰 ${name8} → ${st8.flagshipName}（中断 ${Math.round(N.Command.DEFAULTS.handover)}s）`);
}

/* ==========================================================================
 *  小队指挥长
 * ========================================================================== */
function testSquadCommander() {
  const sc = Object.assign({}, N.Scenarios.get('day_surface_action'),
    { check: () => null, objectives: [], update: null });
  const w = new N.World(sc, { seed: 11 });
  const pool = w.shipsOf('US').filter(s => s.cls.type !== 'AK').slice(0, 4);
  const sq = N.Squad.create(w, pool.map(s => s.id), { lines: 1 });
  const cmdr = N.Squad.commanderOf(w, sq);
  if (!cmdr) { problems.push('指挥长自检: 找不到指挥长'); return; }

  const step = n => { for (let i = 0; i < n; i++) w.update(0.1); };

  // 玩家刚下过命令：不该接管
  N.Squad.issueCourse(w, sq, 90, sq.turnMode, true);
  step(50);
  if (sq.aiTakeover) problems.push('指挥长自检: 刚下完命令就被 AI 接管');

  // 放着不管：应该接管
  step(400);
  if (!sq.aiTakeover) problems.push('指挥长自检: 无指令 45s 后 AI 没有接管');
  const took = w.messages.some(m => /接管指挥/.test(m.text));
  if (!took) problems.push('指挥长自检: 接管没有战报');
  const why = sq.aiWhy;

  // 玩家再下命令：应该交还
  N.Squad.issueCourse(w, sq, 200, sq.turnMode, true);
  step(80);
  if (sq.aiTakeover) problems.push('指挥长自检: 玩家下令后 AI 没有交还指挥');
  if (Math.abs(N.U.angDiff(sq.course, 200)) > 5) problems.push('指挥长自检: 玩家命令没生效');

  // 关掉自动接管就不该再接管
  sq.aiControl = false;
  step(900);
  if (sq.aiTakeover) problems.push('指挥长自检: 关掉自动接管后 AI 仍在指挥');

  console.log(`指挥长自检: ${sq.name} 指挥长 ${cmdr.name}，45s 无指令接管（${why}），` +
    `玩家下令即交还，关掉开关后不再插手`);
}

/* ==========================================================================
 *  小队编号
 * ========================================================================== */
function testSquadNumbering() {
  const mk = (seed) => {
    const sc = Object.assign({}, N.Scenarios.get('day_surface_action'),
      { check: () => null, objectives: [], update: null });
    return new N.World(sc, { seed });
  };
  const make = (w, n) => {
    const pool = w.shipsOf('US').filter(s => !s.sunk && !s.squadId).slice(0, n);
    return N.Squad.create(w, pool.map(s => s.id), { lines: 1 });
  };

  const w = mk(21);
  const a = make(w, 2);
  const b = make(w, 2);
  if (a.name !== '第 1 小队') problems.push(`小队编号: 第一支叫“${a.name}”，不是第 1 小队`);
  if (b.name !== '第 2 小队') problems.push(`小队编号: 第二支叫“${b.name}”，不是第 2 小队`);
  if (a.id !== 'SQ1' || b.id !== 'SQ2') problems.push('小队编号: id 不是 SQ1/SQ2');

  // 解散第 1 支，下一支应该补回 1 号
  N.Squad.remove(w, a);
  const c = make(w, 2);
  if (c.name !== '第 1 小队') problems.push(`小队编号: 解散 1 号后新建的是“${c.name}”，应该补回第 1 小队`);
  if (c.id === b.id) problems.push('小队编号: 新建小队的 id 和现有小队撞了');

  // 1、2 都在的时候，第三支应该是 3
  const d = make(w, 2);
  if (d.name !== '第 3 小队') problems.push(`小队编号: 1、2 都在时新建的是“${d.name}”，应该是第 3 小队`);

  // 换一局：世界是新的，编号从头开始
  const w2 = mk(22);
  const e = make(w2, 2);
  if (e.name !== '第 1 小队') problems.push(`小队编号: 新一局第一支叫“${e.name}”，应该重新从第 1 小队开始`);
  const f = make(w2, 2);
  if (f.name !== '第 2 小队') problems.push(`小队编号: 新一局第二支叫“${f.name}”`);

  console.log(`小队编号自检: 1→2，解散 1 号后补回 1 号，1、2 都在时新建为 3 号；` +
    `换局后重新从 1 号开始（${e.name} / ${f.name}）`);
}

/* ==========================================================================
 *  队形分配（线数 → 每条线几艘）
 * ========================================================================== */
function testFormationShape() {
  const mk = () => {
    const sc = Object.assign({}, N.Scenarios.get('day_surface_action'),
      { check: () => null, objectives: [], update: null });
    return new N.World(sc, { seed: 31 });
  };
  const shape = (n, lines) => {
    const w = mk();
    const pool = w.shipsOf('US').filter(s => !s.sunk).slice(0, n);
    const sq = N.Squad.create(w, pool.map(s => s.id), { lines });
    const d = N.Squad.describe(sq, w);
    return { lines: d.lines, counts: d.lineCounts, count: d.count };
  };

  const cases = [
    [6, 1, 1, [6]],
    [6, 2, 2, [3, 3]],
    [6, 3, 3, [2, 2, 2]],
    [5, 2, 2, [3, 2]],
    [5, 3, 3, [2, 2, 1]],
    [4, 3, 3, [2, 1, 1]],
    [2, 3, 2, [1, 1]]      // 舰不够 3 条线，线数被压到 2
  ];
  for (const [n, want, wantLines, wantCounts] of cases) {
    const got = shape(n, want);
    if (got.count !== n) problems.push(`队形自检: ${n} 艘只编进 ${got.count} 艘`);
    if (got.lines !== wantLines) {
      problems.push(`队形自检: ${n} 艘要 ${want} 线，实际 ${got.lines} 线`);
    }
    if (got.counts.join('+') !== wantCounts.join('+')) {
      problems.push(`队形自检: ${n} 艘 ${want} 线应分成 ${wantCounts.join('+')}，` +
        `实际 ${got.counts.join('+')}`);
    }
    if (got.counts.reduce((a, b) => a + b, 0) !== n) {
      problems.push(`队形自检: ${n} 艘 ${want} 线，各线人数加起来不是 ${n}`);
    }
  }

  console.log('队形自检: 6 艘 1/2/3 线 = 6 / 3+3 / 2+2+2；5 艘 2 线 = 3+2，' +
    '5 艘 3 线 = 2+2+1；舰数不够时线数自动压缩');
}

/* ==========================================================================
 *  站位编辑：交换 / 挪线（4+2）
 * ========================================================================== */
function testFormationEdit() {
  const mk = () => {
    const sc = Object.assign({}, N.Scenarios.get('day_surface_action'),
      { check: () => null, objectives: [], update: null });
    return new N.World(sc, { seed: 41 });
  };
  const w = mk();
  const pool = w.shipsOf('US').slice(0, 6);
  const sq = N.Squad.create(w, pool.map(s => s.id), { lines: 2, spacing: 900, lineGap: 1500 });
  const counts = () => N.Squad.describe(sq, w).lineCounts;

  if (counts().join('+') !== '3+3') problems.push(`站位编辑: 初始应为 3+3，实际 ${counts().join('+')}`);

  // 把第 1 线上的第一艘挪到第 0 线末尾 → 4+2
  let idx = sq.assign.findIndex(a => a.line === 1);
  if (idx < 0) problems.push('站位编辑: 找不到第 1 线上的舰');
  const movedId = sq.shipIds[idx];
  if (!N.Squad.moveToLane(w, sq, idx, 0)) problems.push('站位编辑: moveToLane 返回 false');
  if (counts().join('+') !== '4+2') {
    problems.push(`站位编辑: 挪线后应为 4+2，实际 ${counts().join('+')}`);
  }

  // 挪过去的那艘应该在 0 线的最后一排
  const d = N.Squad.describe(sq, w);
  const slot = d.slots.find(x => x.id === movedId);
  if (!slot || slot.line !== 0 || slot.row !== 3) {
    problems.push(`站位编辑: 挪过去的舰站位是 ${slot ? slot.line + '/' + slot.row : '缺失'}，应为 0/3`);
  }

  // 横向间隔还是 lineGap：0 线第 1 排 vs 1 线第 1 排
  const a = N.Squad.stationOf(sq, d.slots.findIndex(x => x.line === 0 && x.row === 0));
  const b = N.Squad.stationOf(sq, d.slots.findIndex(x => x.line === 1 && x.row === 0));
  const lat = Math.abs(N.V.dist(a.pos, b.pos));
  if (Math.abs(lat - 1500) > 5) problems.push(`站位编辑: 线间距 ${Math.round(lat)}，应为 1500`);

  // 交换两艘舰：领舰换人，航迹重铺
  const oldGuide = sq.shipIds[0];
  const other = sq.shipIds[2];
  if (!N.Squad.swapStations(w, sq, 0, 2)) problems.push('站位编辑: swapStations 返回 false');
  if (sq.shipIds[0] !== other) problems.push('站位编辑: 交换后 0 号位不是原来 2 号位的舰');
  if (sq.shipIds[2] !== oldGuide) problems.push('站位编辑: 交换后 2 号位不是原领舰');
  if (sq.guideId !== other) problems.push('站位编辑: 换领舰后 guideId 没跟着换');

  // 不能把一条线搬空
  const onlyIdx = sq.assign.findIndex((x, i) => x.line === 1 &&
    sq.lanes[1].length === 1);
  if (onlyIdx >= 0 && N.Squad.moveToLane(w, sq, onlyIdx, 0)) {
    problems.push('站位编辑: 允许把一条线搬空');
  }

  // 各条线长度不等时，站位几何仍然自洽（4+2 跑一段不打架）
  const sq2 = N.Squad.create(w, w.shipsOf('US').slice(6, 12).map(s => s.id),
    { lines: 2, spacing: 900, lineGap: 1500 });
  if (sq2) {
    const j = sq2.assign.findIndex(x => x.line === 1);
    if (j >= 0) N.Squad.moveToLane(w, sq2, j, 0);
    for (let t = 0; t < 900; t++) w.update(0.1);
    const dd = N.Squad.describe(sq2, w);
    if (dd.worst > 260) {
      problems.push(`站位编辑: 4+2 队形收拢后最大偏差 ${Math.round(dd.worst)} m`);
    }
  }

  console.log('站位编辑自检: 3+3 → 挪一艘 → 4+2（0 线第 4 排）；线间距仍是 1500 m；' +
    '交换站位会换领舰并重铺航迹；不允许把一条线搬空');
}

/* ==========================================================================
 *  结构分区 / 鱼雷引信 / 搁浅 / 撞船
 * ========================================================================== */
function zoneWorld() {
  const sc = Object.assign({}, N.Scenarios.get('day_surface_action'), {
    check: () => null, objectives: [], update: null
  });
  const world = new N.World(sc, { seed: 11 });
  const base = N.MAP.at(159.60, -8.00);
  world.ships.forEach((s, i) => {
    s.pos.x = base.x + (i % 3) * 4000;
    s.pos.y = base.y + Math.floor(i / 3) * 4000;
    s.heading = 90; s.orderedHeading = 90; s.speed = 12; s.orderedSpeed = 12;
  });
  return world;
}

function testZones() {
  const w = zoneWorld();
  const ca = w.ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  const dd = w.ships.find(s => s.side === 'US' && s.cls.type === 'DD');
  if (!ca || !dd) { problems.push('结构自检: 找不到测试用的巡洋舰/驱逐舰'); return; }

  // 各区血条按结构比例分配
  const zf = N.zonesFor(ca.cls);
  const wantW = ca.hullMax * zf.weapons / zf.hull;
  if (Math.abs(ca.zoneMax.weapons - wantW) > 0.01) {
    problems.push(`结构自检: 武器区满值 ${ca.zoneMax.weapons.toFixed(1)}，应为 ${wantW.toFixed(1)}`);
  }

  // 武器结构打光 → 所有炮塔与鱼雷管失效
  ca.hitZone('weapons', ca.zoneMax.weapons + 1, w);
  if (ca.mounts.some(m => !m.disabled)) problems.push('结构自检: 武器区全毁后还有炮塔能用');
  if (ca.torps.some(t => !t.disabled)) problems.push('结构自检: 武器区全毁后鱼雷管还能用');
  if (ca.weaponFactor() > 0.31) problems.push('结构自检: 武器区全毁后射速系数没降下来');

  // 通信结构打光 → 无线电中断
  const b = zoneWorld().ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  b.hitZone('comms', b.zoneMax.comms + 1, w);
  if (!b.radioDestroyed) problems.push('结构自检: 通信区全毁后无线电还在');
  if (b.commsFactor() > 0.26) problems.push('结构自检: 通信区全毁后通信系数没降下来');

  // 上层建筑打光 → 雷达 + 火控一起报废
  const c = zoneWorld().ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  c.hitZone('superstructure', c.zoneMax.superstructure + 1, w);
  if (!c.radarDestroyed || !c.fcDestroyed) problems.push('结构自检: 上层建筑全毁后雷达/火控还在');

  // 动力结构打光 → 动不了
  const d = zoneWorld().ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  d.hitZone('power', d.zoneMax.power + 1, w);
  if (d.power > 0.01) problems.push(`结构自检: 动力区全毁后 power 还有 ${d.power.toFixed(0)}%`);
  if (d.effectiveMaxSpeed() > 0.5) problems.push('结构自检: 动力区全毁后还能开');

  // 只打掉一部分 → 能力成比例下降，不是非黑即白
  const e = zoneWorld().ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  e.hitZone('weapons', e.zoneMax.weapons * 0.5, w);
  const wf = e.weaponFactor();
  if (!(wf > 0.55 && wf < 0.75)) problems.push(`结构自检: 武器区剩五成时射速系数 ${wf.toFixed(2)} 不合理`);
  if (e.mounts.every(m => m.disabled)) problems.push('结构自检: 武器区只损一半就把炮全打没了');

  console.log(`结构自检: 武器区 ${ca.zoneMax.weapons.toFixed(0)} 点打光即全炮哑火；` +
    `通信/上层/动力各自对应无线电、雷达火控、航速，且只损一半时能力成比例下降`);
}

function testTorpedoTrigger() {
  const w = zoneWorld();
  const ca = w.ships.find(s => s.side === 'US' && s.cls.type === 'CA');
  const dd = w.ships.find(s => s.side === 'US' && s.cls.type === 'DD');
  const pCA = N.Combat.torpTriggerChance(ca);
  const pDD = N.Combat.torpTriggerChance(dd);
  if (!(pCA > pDD + 0.15)) {
    problems.push(`鱼雷引信自检: 重巡触发率 ${pCA.toFixed(2)} 不比驱逐 ${pDD.toFixed(2)} 高多少`);
  }
  if (pCA > 0.98 || pDD < 0.4) {
    problems.push(`鱼雷引信自检: 触发率区间不合理（驱逐 ${pDD.toFixed(2)}，重巡 ${pCA.toFixed(2)}）`);
  }
  // 统计验证：同一个引信概率下，大船被判定触发的次数必须显著更多
  let hitCA = 0, hitDD = 0, N0 = 4000;
  for (let i = 0; i < N0; i++) {
    if (w.rng.chance(pCA)) hitCA++;
    if (w.rng.chance(pDD)) hitDD++;
  }
  if (hitCA - hitDD < N0 * 0.10) {
    problems.push(`鱼雷引信自检: 4000 次抽样里大船只多触发 ${hitCA - hitDD} 次`);
  }
  console.log(`鱼雷引信自检: 驱逐 ${(pDD * 100).toFixed(0)}% / 重巡 ${(pCA * 100).toFixed(0)}% 触发，` +
    `4000 次抽样 ${hitDD} vs ${hitCA}`);
}

function testGrounding() {
  const w = zoneWorld();
  const s = w.ships.find(x => x.side === 'US' && x.cls.type === 'CA');
  const hull0 = s.hull, power0 = s.power;
  // 找一块陆地，把船摆在离岸约 9 km 的开阔水面上，全速冲上去
  let shore = null;
  for (let lon = 155.6; lon <= 161.0 && !shore; lon += 0.2) {
    for (let lat = -9.6; lat <= -6.6 && !shore; lat += 0.2) {
      const p = N.MAP.at(lon, lat);
      if (!w.isLand(p.x, p.y)) continue;
      for (let a = 0; a < 360; a += 15) {
        // 岸要够「厚」：从 p 往内陆走 1.5 km 还得是陆地。
        // 否则可能选中多边形边缘上的一个点，船从旁边擦过去，测的就不是搁浅了。
        let inland = true;
        for (let d = 300; d <= 1500; d += 300) {
          const r = N.Geo.dest(p, (a + 180) % 360, d);
          if (!w.isLand(r.x, r.y)) { inland = false; break; }
        }
        if (!inland) continue;
        const q = N.Geo.dest(p, a, 6000);
        if (w.isLand(q.x, q.y)) continue;
        let clear = true;
        for (let d = 1000; d < 5000; d += 500) {
          const r = N.Geo.dest(q, (a + 180) % 360, d);
          if (w.isLand(r.x, r.y)) { clear = false; break; }
        }
        if (clear) { shore = { sea: q, hdg: (a + 180) % 360 }; break; }
      }
    }
  }
  if (!shore) { problems.push('搁浅自检: 找不到测试用的海岸'); return; }
  s.pos.x = shore.sea.x; s.pos.y = shore.sea.y;
  s.heading = s.orderedHeading = shore.hdg;
  s.speed = 26; s.orderedSpeed = 26;

  let grounded = false;
  for (let i = 0; i < 9000 && !grounded; i++) {
    w.update(0.1);
    if (s.aground) grounded = true;
  }
  if (!grounded) { problems.push('搁浅自检: 全速冲向海岸却没有搁浅'); return; }
  if (s.hull >= hull0 - 3) problems.push(`搁浅自检: 搁浅几乎没伤到舰体（${hull0} → ${s.hull.toFixed(0)}）`);
  if (s.power >= power0 - 2) problems.push(`搁浅自检: 搁浅没有损失动力（${power0} → ${s.power.toFixed(0)}）`);
  if (s.flood <= 0 && s.floodRate <= 0) problems.push('搁浅自检: 搁浅没有进水');
  if (s.speed > 5) problems.push(`搁浅自检: 搁浅后还有 ${s.speed.toFixed(0)} 节`);
  if (w.isLand(s.pos.x, s.pos.y)) problems.push('搁浅自检: 舰体中心跑到陆地上去了');

  // 搁浅之后还得能自己蹭出来
  for (let i = 0; i < 3000; i++) w.update(0.1);
  if (s.aground) problems.push('搁浅自检: 搁浅后一直脱不了困');
  console.log(`搁浅自检: 26 节触底，舰体 ${hull0.toFixed(0)} → ${s.hull.toFixed(0)}，` +
    `动力 ${power0.toFixed(0)} → ${s.power.toFixed(0)}%，进水 ${s.flood.toFixed(0)}%，随后自行脱困`);
}

function testCollision() {
  const w = zoneWorld();
  const a = w.ships.find(x => x.side === 'US' && x.cls.type === 'DD');
  const b = w.ships.find(x => x.side === 'US' && x.cls.type === 'CA');
  if (!a || !b) { problems.push('撞船自检: 找不到测试舰'); return; }
  // 让驱逐舰迎头撞巡洋舰
  const base = N.MAP.at(159.60, -8.00);
  a.pos.x = base.x; a.pos.y = base.y; a.heading = a.orderedHeading = 90;
  b.pos.x = base.x + 600; b.pos.y = base.y; b.heading = b.orderedHeading = 270;
  a.speed = a.orderedSpeed = 24;
  b.speed = b.orderedSpeed = 24;
  const ah0 = a.hull, bh0 = b.hull;
  let hit = false;
  for (let i = 0; i < 200 && !hit; i++) {
    w.update(0.1);
    if (a.hull < ah0 || b.hull < bh0) hit = true;
  }
  if (!hit) { problems.push('撞船自检: 迎头撞上却没有损伤'); return; }
  const aLost = ah0 - a.hull, bLost = bh0 - b.hull;
  if (aLost <= 0 || bLost <= 0) problems.push('撞船自检: 只有一方受伤');
  if (aLost < bLost * 0.8) {
    problems.push(`撞船自检: 驱逐舰撞巡洋舰反而伤得更轻（${aLost.toFixed(1)} vs ${bLost.toFixed(1)}）`);
  }
  console.log(`撞船自检: 驱逐舰 24 节迎头撞巡洋舰，驱逐掉 ${aLost.toFixed(1)} 点、` +
    `巡洋舰掉 ${bLost.toFixed(1)} 点（小船吃亏）`);
}

/* ==========================================================================
 *  气象自检：风浪雨月，以及它们怎么通过雷达 / 瞭望 / 无线电改战局
 * ========================================================================== */
function testWeather() {
  if (!N.Weather) { problems.push('气象自检: 没有 N.Weather'); return; }

  /* 1) 开局能见度必须等于剧本值（标定过，否则夜战会被月光压到 3 km 以下） */
  for (const sc of N.Scenarios.available()) {
    const w = new N.World(sc, { seed: 11 });
    if (Math.abs(w.weather.visibility - sc.env.visibility) > 1) {
      problems.push(`气象自检: ${sc.id} 开局能见度 ${Math.round(w.weather.visibility)}，` +
        `剧本写的是 ${sc.env.visibility}`);
      break;
    }
  }

  /* 2) 同种子 = 同天气；换种子要不一样（回放靠这个复现） */
  const a = new N.World(N.Scenarios.get('savo_melee'), { seed: 4242 });
  const b = new N.World(N.Scenarios.get('savo_melee'), { seed: 4242 });
  for (let i = 0; i < 2400; i++) { a.update(0.1); b.update(0.1); }
  if (N.Weather.status(a) !== N.Weather.status(b)) {
    problems.push('气象自检: 同一个种子跑出了两种天气，回放会漂');
  }
  const c = new N.World(N.Scenarios.get('savo_melee'), { seed: 999 });
  for (let i = 0; i < 2400; i++) c.update(0.1);
  if (N.Weather.status(c) === N.Weather.status(a)) {
    problems.push('气象自检: 换了种子天气没变，随机没生效');
  }

  /* 3) 40 分钟内天气要真的动起来 */
  const e = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  const t0 = N.Weather.status(e);
  let moved = 0, visMin = e.weather.visibility, visMax = e.weather.visibility;
  for (let i = 0; i < 300; i++) {
    e.time += N.Weather.STEP;
    N.Weather.step(e);
    e.weather.visibility = N.Weather.effectiveVisibility(e.weather);
    if (N.Weather.status(e) !== t0) moved++;
    visMin = Math.min(visMin, e.weather.visibility);
    visMax = Math.max(visMax, e.weather.visibility);
  }
  if (!moved) problems.push('气象自检: 40 分钟里天气一动没动');
  if (visMax - visMin < 200) problems.push('气象自检: 能见度几乎没变化');

  /* 4) 雷达：雨越大越短，雨飑里更短；海况高时小船先被海杂波埋掉 */
  const r = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  r.weather.squall = 0; r.weather.rain = 0; r.weather.seaState = 2;
  const clearR = N.Weather.radarFactor(r);
  r.weather.rain = 0.8;
  const wetR = N.Weather.radarFactor(r);
  if (!(wetR < clearR - 0.1)) problems.push('气象自检: 大雨没有削弱雷达');
  r.weather.rain = 0; r.weather.squall = 1;
  const sqR = N.Weather.radarFactor(r);
  if (!(sqR < wetR)) problems.push('气象自检: 雨飑里雷达没再打折');
  r.weather.squall = 0;
  const dd = r.ships.find(s => s.cls.type === 'DD');
  const ca = r.ships.find(s => s.cls.type === 'CA');
  r.weather.seaState = 6;
  const clutDd = N.Weather.seaClutter(r, dd);
  const clutCa = N.Weather.seaClutter(r, ca);
  if (!(clutDd < 0.95)) problems.push('气象自检: 高海况没有海杂波');
  if (!(clutCa > clutDd)) problems.push('气象自检: 海杂波没按吨位区分，大舰也该吃亏');

  /* 5) 瞭望：月光亮看得远，阴天把月光遮掉 */
  const n = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  n.weather.light = 'night'; n.weather.rain = 0; n.weather.cloud = 0;
  n.weather.baseVisibility = 9000;
  n.weather.moon = 0.02;
  const dark = N.Weather.effectiveVisibility(n.weather);
  n.weather.moon = 1;
  const bright = N.Weather.effectiveVisibility(n.weather);
  if (!(bright > dark * 1.25)) problems.push('气象自检: 满月没有比新月看得远');
  n.weather.cloud = 1;
  const cloudy = N.Weather.effectiveVisibility(n.weather);
  if (!(cloudy < bright - 100)) problems.push('气象自检: 阴天没有把月光遮住');

  /* 6) 无线电：雨和浪要加重丢包 */
  const rc = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  rc.weather.rain = 0; rc.weather.seaState = 2; rc.weather.squall = 0;
  const dryRadio = N.Weather.radioExtra(rc);
  rc.weather.rain = 0.9;
  const wetRadio = N.Weather.radioExtra(rc);
  if (!(wetRadio > dryRadio + 0.1)) problems.push('气象自检: 大雨没有加重无线电丢包');

  /* 7) 起火冒烟 + 火烟挡视线 */
  const f = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  const s0 = f.ships[0], s1 = f.ships[1];
  const mid = { x: (s0.pos.x + s1.pos.x) / 2, y: (s0.pos.y + s1.pos.y) / 2 };
  const before = N.Sensors.fireSmokeBlocks(f, s0.pos, s1.pos);
  f.smokes.push({ kind: 'fire', pos: mid, radius: 900, born: 0, life: 999, drift: { x: 0, y: 0 } });
  const after = N.Sensors.fireSmokeBlocks(f, s0.pos, s1.pos);
  if (!(after < before)) problems.push('气象自检: 火烟挡在中间却不影响瞭望');

  const g = new N.World(N.Scenarios.get('savo_melee'), { seed: 5 });
  const burn = g.ships.find(s => !s.sunk);
  burn.fire = 60;
  for (let i = 0; i < 300; i++) { g.time += 0.1; g.updateSmoke(0.1); }
  if (!g.smokes.some(s => s.kind === 'fire')) problems.push('气象自检: 起火的舰不冒烟');

  console.log(`气象自检: 40 分钟里天气变了 ${moved} 次，` +
    `能见度 ${(visMin / 1000).toFixed(1)}~${(visMax / 1000).toFixed(1)} km，` +
    `雷达 晴 ${clearR.toFixed(2)} / 雨 ${wetR.toFixed(2)} / 飑 ${sqR.toFixed(2)}，` +
    `夜视 新月 ${(dark / 1000).toFixed(1)} / 满月 ${(bright / 1000).toFixed(1)} km`);
}

/* ==========================================================================
 *  设备级损害与损管自检
 * ========================================================================== */
function testDamage() {
  if (!N.Damage) { problems.push('设备自检: 没有 N.Damage'); return; }
  const D = N.Damage;
  const w = new N.World(N.Scenarios.get('savo_melee'), { seed: 123 });
  const s = w.ships.find(x => x.side === 'US' && x.cls.type === 'CA');
  if (!s) { problems.push('设备自检: 找不到测试巡洋舰'); return; }

  /* 1) 设备表齐全，血条加起来正好等于结构区 */
  if (!s.engines || !s.engines.length) problems.push('设备自检: 没有主机');
  if (!s.rudder) problems.push('设备自检: 没有舵机');
  if (!s.electrical) problems.push('设备自检: 没有电力系统');
  const sumWeap = s.devList.filter(d => d.group === 'weapons').reduce((a, d) => a + d.hpMax, 0);
  if (Math.abs(sumWeap - s.zoneMax.weapons) > 0.01) {
    problems.push(`设备自检: 武器设备血条合计 ${sumWeap.toFixed(2)}，` +
      `武器结构区是 ${s.zoneMax.weapons.toFixed(2)}`);
  }
  const sumComm = s.devList.filter(d => d.group === 'comms').reduce((a, d) => a + d.hpMax, 0);
  if (Math.abs(sumComm - s.zoneMax.comms) > 0.01) {
    problems.push(`设备自检: 通讯设备血条合计 ${sumComm.toFixed(2)}，` +
      `通讯结构区是 ${s.zoneMax.comms.toFixed(2)}`);
  }
  const sumPower = D.powerDevices(s).reduce((a, d) => a + d.hpMax, 0);
  if (Math.abs(sumPower - s.zoneMax.power) > 0.01) {
    problems.push(`设备自检: 动力设备血条合计 ${sumPower.toFixed(2)}，` +
      `动力结构区是 ${s.zoneMax.power.toFixed(2)}`);
  }

  /* 1b) 三大系统：上层结构 = 武器 + 通讯 + 其他，动力系统 = 发动机 + 舵机 + 电力 */
  const y0 = D.systems(s);
  if (Math.abs(y0.upper - 1) > 0.001 || Math.abs(y0.power - 1) > 0.001 || Math.abs(y0.hull - 1) > 0.001) {
    problems.push('设备自检: 完好状态下三大系统不是满值');
  }
  const wSave = s.zone.weapons, cSave = s.zone.comms, oSave = s.zone.superstructure;
  s.zone.weapons = 0; s.zone.comms = 0; s.zone.superstructure = 0;
  if (D.systems(s).upper > 0.001) problems.push('设备自检: 上层结构三块全打光了上层结构还没归零');
  s.zone.weapons = wSave; s.zone.comms = cSave; s.zone.superstructure = oSave;
  // 打武器区 12 点：武器掉血、炮塔跟着掉、上层结构一起掉，动力不受影响
  const before = {
    w: s.zone.weapons, p: s.zone.power,
    dev: s.devList.filter(d => d.group === 'weapons').reduce((a, d) => a + d.hp, 0)
  };
  s.hitZone('weapons', 12, w);
  const devAfter = s.devList.filter(d => d.group === 'weapons').reduce((a, d) => a + d.hp, 0);
  if (!(devAfter < before.dev)) problems.push('设备自检: 武器区挨打炮塔没掉血');
  if (Math.abs((before.dev - devAfter) - 12) > 0.01) {
    problems.push(`设备自检: 武器区掉 12 点，设备只掉了 ${(before.dev - devAfter).toFixed(2)} 点`);
  }
  if (s.zone.power !== before.p) problems.push('设备自检: 武器区挨打动力区跟着掉');
  if (!(D.systems(s).upper < 0.999)) problems.push('设备自检: 武器区挨打上层结构没掉');
  // 直接击毁一台设备，账要对得上
  s.killDevice(s.mounts[1], 'weapons', w);
  const wSum1 = s.devList.filter(d => d.group === 'weapons').reduce((a, d) => a + d.hp, 0);
  if (Math.abs(s.zone.weapons - wSum1) > 0.01) {
    problems.push(`设备自检: 直接击毁设备后武器区 ${s.zone.weapons.toFixed(2)} 与设备合计 ${wSum1.toFixed(2)} 对不上`);
  }

  /* 2) 主机血量 → 动力损失档位（25% / 50% / 90%） */
  const setAllEng = (frac) => {
    s.engines.forEach(e => {
      e.hp = e.hpMax * frac; e.faulted = false; e.faultLoss = 0; e.destroyed = frac <= 0;
    });
  };
  const cases = [[1.0, 1.0], [0.9, 0.75], [0.7, 0.5], [0.4, 0.1], [0.0, 0.0]];
  for (const [frac, want] of cases) {
    setAllEng(frac);
    const got = D.propulsion(s);
    if (Math.abs(got - want) > 0.002) {
      problems.push(`设备自检: 主机血量 ${Math.round(frac * 100)}% 时推进 ${got.toFixed(2)}，应为 ${want}`);
    }
  }

  /* 3) 故障掉的动力与损坏叠加 */
  setAllEng(1.0);
  s.engines[0].faultLoss = 50;
  const mixed = D.propulsion(s);
  const wantMixed = (1 + 1 + 1 + 0.5) / s.engines.length;
  if (Math.abs(mixed - wantMixed) > 0.002) {
    problems.push(`设备自检: 一台主机故障 50% 后推进 ${mixed.toFixed(3)}，应为 ${wantMixed.toFixed(3)}`);
  }
  s.engines[0].faultLoss = 0;

  /* 4) 舵机：损坏 ×2/×3/×5，故障再 ×2 */
  s.rudder.faulted = false;
  const rudderCases = [[1.0, 1], [0.9, 2], [0.7, 3], [0.4, 5]];
  for (const [frac, want] of rudderCases) {
    s.rudder.hp = s.rudder.hpMax * frac;
    const got = D.turnFactor(s);
    if (got !== want) problems.push(`设备自检: 舵机血量 ${Math.round(frac * 100)}% 时转向倍数 ${got}，应为 ${want}`);
  }
  s.rudder.hp = s.rudder.hpMax;
  s.rudder.faulted = true;
  if (D.turnFactor(s) !== 2) problems.push('设备自检: 舵机故障没有让转向变慢一倍');
  s.rudder.faulted = false;

  /* 5) 电力系统失灵的五条后果 */
  s.electrical.faulted = false;
  if (D.elecFailed(s)) problems.push('设备自检: 电力系统正常时判定失灵');
  s.electrical.faulted = true;
  if (!D.elecFailed(s)) problems.push('设备自检: 电力系统故障没判定为失灵');
  if (D.radarOk(s)) problems.push('设备自检: 电力失灵了雷达还能用');
  if (D.radioOk(s)) problems.push('设备自检: 电力失灵了电台还能用');
  if (D.iffOk(s)) problems.push('设备自检: 电力失灵了识别器还能用');
  if (Math.abs(D.gunRate(s) - 1 / 1.5) > 1e-6) problems.push('设备自检: 电力失灵炮击间隔不是 ×1.5');
  if (Math.abs(D.torpRate(s) - 0.5) > 1e-6) problems.push('设备自检: 电力失灵鱼雷装填不是 ×2');
  if (D.radioDelayBonus(s) !== 60) problems.push('设备自检: 电力失灵无线电延迟不是 +60 秒');
  if (Math.abs(D.iffError(s) - 0.02) > 1e-6) problems.push('设备自检: 电力失灵识别错误率不是 +1%');
  s.electrical.faulted = false;

  /* 6) 动力系统低于 25% → 电力系统连带失灵 */
  const powerSave = s.zone.power;
  s.zone.power = s.zoneMax.power * 0.2;
  if (!D.elecFailed(s)) problems.push('设备自检: 动力不足 25% 时电力系统没有失灵');
  s.zone.power = powerSave;

  /* 7) 损管：每 10 分钟按损管档位给船体和上层回血，不动武器/通信/动力 */
  s.hull = s.hullMax * 0.5;
  s.zone.superstructure = s.zoneMax.superstructure * 0.5;
  const hull0 = s.hull, super0 = s.zone.superstructure;
  const weap0 = s.zone.weapons, pow0 = s.zone.power;
  s.lastFireTime = -9999;
  s.speed = 0; s.orderedSpeed = 0;
  s._faultT = -600;          // 压住故障判定，只看损管
  s._healT = 0;
  D.update(s, 600, w);
  const dh = s.hull - hull0, ds = s.zone.superstructure - super0;
  const healMul = D.profile(s).fire;
  const wantHull = s.hullMax * 0.05 * healMul;
  const wantSuper = s.zoneMax.superstructure * 0.05 * healMul;
  if (Math.abs(dh - wantHull) > 0.05) {
    problems.push(`设备自检: 损管 10 分钟给船体回了 ${dh.toFixed(2)}，应为 ${wantHull.toFixed(2)}`);
  }
  if (Math.abs(ds - wantSuper) > 0.05) {
    problems.push(`设备自检: 损管 10 分钟给上层回了 ${ds.toFixed(2)}，应为 ${wantSuper.toFixed(2)}`);
  }
  if (s.zone.weapons > weap0 || s.zone.power > pow0) problems.push('设备自检: 损管修了不该修的地方');

  /* 7b) 损管档位：美军必须明显强于日军（进水慢、灭火快、抢修快、殉爆少） */
  {
    const usShip = w.ships.find(x => x.side === 'US');
    const jpShip = w.ships.find(x => x.side === 'JP');
    const pu = D.profile(usShip), pj = D.profile(jpShip);
    if (!(pj.flood > pu.flood * 1.2)) {
      problems.push(`设备自检: 日军进水倍率 ${pj.flood.toFixed(2)} 没有明显高于美军 ${pu.flood.toFixed(2)}`);
    }
    if (!(pu.fire > pj.fire * 1.2)) {
      problems.push(`设备自检: 美军灭火倍率 ${pu.fire.toFixed(2)} 没有明显高于日军 ${pj.fire.toFixed(2)}`);
    }
    if (!(pj.magazine > pu.magazine * 1.5)) {
      problems.push(`设备自检: 日军殉爆倍率 ${pj.magazine.toFixed(2)} 没有明显高于美军 ${pu.magazine.toFixed(2)}`);
    }
    // 同样的进水缺口，跑 10 分钟后日军进的水必须更多
    const floodRun = (ship) => {
      ship.flood = 0; ship.floodRate = 0.02; ship.fire = 0; ship.list = 0;
      for (let i = 0; i < 600; i++) ship.updateDamage(1, w);
      return ship.flood;
    };
    const fu = floodRun(usShip), fj = floodRun(jpShip);
    if (!(fj > fu * 1.15)) {
      problems.push(`设备自检: 同样进水缺口，日军进 ${fj.toFixed(1)} 不多于美军 ${fu.toFixed(1)}`);
    }
  }

  /* 8) 打坏的设备修不好（不可逆） */
  const m0 = s.mounts[0];
  m0.disabled = true; m0.destroyed = true; m0.hp = 0; m0.fault = false;
  for (let i = 0; i < 400; i++) {
    s._faultT = 299.9; s._healT = -1e9;
    D.update(s, 0.2, w);
  }
  if (!m0.disabled || m0.hp > 0) problems.push('设备自检: 被打毁的炮塔被损管修好了');

  /* 9) 故障率：平时 1% 上下，开火时更高（具体数值按损管档位缩放） */
  const g = new N.World(N.Scenarios.get('savo_melee'), { seed: 9 });
  const t = g.ships.find(x => x.side === 'US' && x.cls.type === 'CA');
  const rateOf = (firing) => {
    let hits = 0, trials = 0;
    for (let i = 0; i < 1200; i++) {
      t.devList.forEach(d => { d.fault = false; });
      t.engines.forEach(e => { e.faulted = false; e.faultLoss = 0; });
      t.rudder.faulted = false; t.electrical.faulted = false;
      t.speed = 0; t.orderedSpeed = 0;
      t.lastFireTime = firing ? g.time : -9999;
      t._faultT = 299.9; t._healT = -1e9;
      D.update(t, 0.2, g);
      hits += t.devList.filter(d => d.fault).length;
      trials += t.devList.length;
    }
    return hits / trials;
  };
  const idle = rateOf(false), hot = rateOf(true);
  if (idle < 0.006 || idle > 0.014) problems.push(`设备自检: 平时故障率 ${(idle * 100).toFixed(2)}%，应在 1% 上下`);
  if (hot < idle + 0.012) problems.push(`设备自检: 开火时故障率 ${(hot * 100).toFixed(2)}%，` +
    `应比平时的 ${(idle * 100).toFixed(2)}% 高 2 个点`);

  console.log(`设备自检: 上层 ${s.devList.length} 台设备 / 动力 ${D.powerDevices(s).length} 台，` +
    `故障率 平时 ${(idle * 100).toFixed(2)}% · 开火 ${(hot * 100).toFixed(2)}%`);
}

/* ==========================================================================
 *  近失弹自检
 * ========================================================================== */
function testNearMiss() {
  const w = zoneWorld();
  const s = w.ships.find(x => x.side === 'US' && x.cls.type === 'CA');
  if (!s) { problems.push('近失弹自检: 找不到测试舰'); return; }
  const base = N.MAP.at(159.20, -8.40);
  s.pos.x = base.x; s.pos.y = base.y;
  s.heading = s.orderedHeading = 0;
  const gun = { caliber: 203, shellWeight: 125, maxRange: 27000, pen: [[0, 250]],
    deckPen: [[0, 60]], rof: 3.5, maxDescent: 30 };

  const reset = () => { s.hull = s.hullMax; s.flood = 0; s.floodRate = 0; s.fire = 0; };

  // 打一发落在 (x, y) 的炮弹，返回这 0.1 秒里舰体掉了多少
  const fireAt = (x, y, salvo) => {
    reset();
    const h0 = s.hull;
    w.shells.push({ side: 'JP', ownerId: 'x', gun: gun, to: { x: x, y: y }, t: 0, tf: 0,
      range: 8000, salvoId: salvo || 'NM', aim: { x: x, y: y } });
    w.update(0.1);
    return h0 - s.hull;
  };
  const fireGap = (gap, salvo) => fireAt(base.x + s.cls.beam / 2 + gap, base.y, salvo);

  // 1) 贴着舷侧 8 米：必须算近失弹（已经出了船体矩形的 6 米余量），而且会进水
  reset();
  const f0 = s.floodRate;
  w.shells.push({ side: 'JP', ownerId: 'x', gun: gun,
    to: { x: base.x + s.cls.beam / 2 + 8, y: base.y }, t: 0, tf: 0, range: 8000,
    salvoId: 'NM', aim: { x: base.x, y: base.y } });
  w.update(0.1);
  if (!(s.hull < s.hullMax - 1e-6)) problems.push('近失弹自检: 舷侧 8 米的近失弹没有伤到舰体');
  if (!(s.floodRate > f0)) problems.push('近失弹自检: 近失弹没有造成进水');

  // 2) 离舷侧 200 米：完全不该有伤害
  const far = fireGap(200);
  if (far > 1e-6) problems.push(`近失弹自检: 200 米外的落点也造成了 ${far.toFixed(3)} 点伤害`);

  // 3) 越近越狠（两个都在近失弹区间里，否则比的就不是近失弹了）
  const a = fireGap(8);
  const b = fireGap(18);
  if (!(a > b)) problems.push(`近失弹自检: 8 米 ${a.toFixed(2)} 点，18 米 ${b.toFixed(2)} 点，近的没更狠`);

  // 4) 近失弹的水柱要能被渲染出来
  fireGap(8);
  if (!w.splashes.filter(x => x.kind === 'near').length) problems.push('近失弹自检: 没有生成 near 水柱');

  // 5) 量级：近失弹要明显小于直接命中。
  //    两边都取 40 发的平均值 —— 单发直接命中的伤害随机性极大（打中炮塔和打中
  //    机舱差好几倍），拿单发去比平均值是拿噪声当结论。
  let sum = 0;
  for (let i = 0; i < 40; i++) sum += fireAt(base.x, base.y, 'NM2');
  const avgDirect = sum / 40;
  let sumNear = 0;
  for (let i = 0; i < 40; i++) sumNear += fireGap(8, 'NM3');
  const avgNear = sumNear / 40;
  if (avgNear > avgDirect * 0.45) {
    problems.push(`近失弹自检: 近失弹平均 ${avgNear.toFixed(2)} 点已经接近直接命中的平均值 ${avgDirect.toFixed(2)} 点了`);
  }

  console.log(`近失弹自检: 舷侧 8 米 ${a.toFixed(2)} 点（均 ${avgNear.toFixed(2)}） / 18 米 ${b.toFixed(2)} 点 / ` +
    `200 米 ${far.toFixed(2)} 点，直接命中平均 ${avgDirect.toFixed(2)} 点，杀伤半径 ` +
    `${(7 + 1.35 * Math.sqrt(125)).toFixed(0)} 米`);
}
testSquad();testSquadNumbering();testFormationShape();
testFormationEdit();
testReplayShape();
testCommand();
testSquadCommander();
testTorpedoAttribution();
testZones();
testTorpedoTrigger();
testGrounding();
testCollision();
testWeather();
testDamage();
testNearMiss();

const ids = only ? [only] : N.Scenarios.available().map(s => s.id);
const results = [];

for (const id of ids) {
  const sc = N.Scenarios.get(id);
  results.push([sc.title, run(id, '被动（玩家不操作）', { seed: 20241115 })]);
  results.push([sc.title, run(id, 'AI 全自动', { seed: 777, autopilot: true })]);
}

console.log('\n========== 汇总 ==========');
for (const [title, r] of results) {
  console.log(`${title}: 命中 ${r.totalHits}  时长 ${(r.world.time / 60).toFixed(0)}分  ` +
    `结果 ${r.world.result ? r.world.result.result : '未结束'}  录像 ${r.world.recorder.frames.length} 帧`);
}

if (problems.length) {
  console.error('\n❌ 问题:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('\n✅ 无头测试通过');
