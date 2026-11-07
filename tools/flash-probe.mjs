/* =============================================================================
 *  tools/flash-probe.mjs —— 炮口闪光 / 无烟弹 / 弹药基数 专项自检
 *
 *  跑法： node tools/flash-probe.mjs
 *
 *  查的是这几件事：
 *    1. 主炮备弹按史实（每门炮多少发），打光了就打不动
 *    2. 鱼雷有限：日舰带一套备用雷、美军一条都没有，放完就没了
 *    3. 无烟弹（消焰发射药）按年代配发：1943 年 7 月以后美军才有
 *    4. 夜里用普通弹开炮会暴露位置：对方瞭望哨拿到一条"炮口闪光"接触，
 *       只有方位和很糟的距离，没有航向航速、也数不清几条船
 *    5. 用无烟弹就不暴露；白天本来就不暴露
 *    6. AI 不会拿一条闪光当射击目标
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

/**
 * 造一场最小对局：一条美舰对一条日舰，开阔水域。
 * 必须走真正的 World 构造 —— 指挥体系、气象、航迹表都在构造函数里建，
 * 事后替换 world.ships 会把指挥舰弄丢，整条情报链就断了。
 */
function duel(usClass, jpClass, distM, opts) {
  opts = opts || {};
  const date = opts.date || '1943 年 8 月 6 日 23:30';
  const sc = {
    id: 'probe_duel', type: 'surface', title: 'probe', subtitle: '',
    date: date, startTime: 23 * 3600, timeOfDay: opts.light || 'night',
    location: '', available: true, tags: [], floatplane: false,
    env: {
      visibility: opts.visibility == null ? 14000 : opts.visibility,
      windDir: 120, windSpeed: 8, seaState: 2, weather: '晴', light: opts.light || 'night',
      sunAzimuth: 0, rain: 0
    },
    playerSide: 'US',
    brief: [], intel: '',
    objectives: [], zones: [], shoreTargets: [], forces: [],
    victory: { timeLimit: 0 }
  };
  const at = (lon, lat) => N.MAP.at(lon, lat);
  const usP = at(159.60, -8.00);
  const jpP = at(159.60, -8.00);
  sc.forces.push({
    side: 'US', group: 'TF', class: usClass, name: '测试美舰', hull: '',
    x: Math.round(usP.x), y: Math.round(usP.y), heading: 0, speed: 0, role: 'flagship'
  });
  sc.forces.push({
    side: 'JP', group: 'IJN', class: jpClass, name: '测试日舰', hull: '',
    x: Math.round(jpP.x), y: Math.round(jpP.y - distM), heading: 180, speed: 0, role: 'flagship'
  });
  const w = new N.World(sc, { seed: 4242 });
  const us = w.ships.filter(s => s.side === 'US')[0];
  const jp = w.ships.filter(s => s.side === 'JP')[0];
  return { w, jp, us };
}

/** 让一条舰能朝正东的目标放雷（舷侧对准） */
function broadsideAim(w, ship, dist) {
  return { x: ship.pos.x + dist, y: ship.pos.y };
}

/* ------------------------------------------------ 1. 主炮备弹按史实 */
console.log('\n[1] 主炮备弹是有限的，而且按史实');
{
  const cases = [
    ['5in38', 350], ['8in55', 135], ['6in47', 200],
    ['20cm50', 120], ['14cm50', 150], ['127mm50', 200]
  ];
  for (const [gun, rpg] of cases) {
    ok(N.Guns[gun].rpg === rpg, `${gun} 每门 ${N.Guns[gun].rpg} 发（史实 ${rpg}）`);
  }
  const { w } = duel('fletcher', 'kagero', 8000);
  const f = w.ships.filter(s => s.cls.id === 'fletcher')[0];
  ok(f.mounts.every(m => m.ammo === m.count * m.gun.rpg),
    `弗莱彻每座炮塔的备弹 = 门数 × ${f.mounts[0].gun.rpg}（全舰 ${f.shellsLeft()} 发）`);
  ok(f.shellsLeft() > 1000 && f.shellsLeft() < 3000,
    `全舰 ${f.shellsLeft()} 发 —— 够打一场，但绝不是无限`);
}

/* ------------------------------------------------ 2. 炮弹打光就打不动 */
console.log('\n[2] 炮弹打光了就打不动了');
{
  const { w, us } = duel('fletcher', 'kagero', 8000);
  us.mounts.forEach(m => { m.ammo = 0; m.flashless = 0; });
  us.engage = true;
  us.targetTrackId = 'anything';
  const before = us.salvosFired;
  for (let i = 0; i < 600; i++) w.update(0.1);
  ok(us.salvosFired === before, `备弹清零后 60 秒内一次也没开炮（${us.salvosFired - before} 次）`);
  ok(us.shellsLeft() === 0, '弹药确实是 0，不是负数');
}

/* ------------------------------------------------ 3. 鱼雷有限 */
console.log('\n[3] 鱼雷是有限的：日舰带一套备用雷，美军一条都没有');
{
  {
    const { w, us } = duel('fletcher', 'kagero', 8000);
    ok(us.torpedoesLeft() === 10, `弗莱彻全舰 ${us.torpedoesLeft()} 条鱼雷（2×5，无备用雷）`);
    const aim = broadsideAim(w, us, 6000);
    let fired = 0;
    for (let k = 0; k < 6; k++) {
      for (const m of us.torps) {
        fired += Math.max(0, N.Combat.launchTorpedoes(w, us, m, aim, 0, 0, 5, 2));
      }
    }
    ok(fired === 10, `放完 10 条就再也放不出来了（实际 ${fired} 条）`);
    ok(us.torpedoesLeft() === 0, '全舰鱼雷余量归零');
    // 再等十分钟也不会重新装填 —— 美军不带备用雷
    for (let i = 0; i < 6000; i++) w.update(0.1);
    ok(us.torps.every(t => t.loaded === 0), '美军驱逐舰没有备用雷，空管就是空的');
  }
  {
    const { w, jp } = duel('fletcher', 'kagero', 8000);
    ok(jp.torpedoesLeft() === 16, `阳炎级全舰 ${jp.torpedoesLeft()} 条鱼雷（8 管 + 8 条备用）`);
    const aim = broadsideAim(w, jp, 6000);
    // 装填时间调到 0：让真实的"备用雷 → 发射管"逻辑跑起来，不用等四分钟
    jp.torps.forEach(t => { t.reloadTime = 0; t.reload = 0; });
    let fired = 0;
    for (let k = 0; k < 200; k++) {
      for (const m of jp.torps) {
        fired += Math.max(0, N.Combat.launchTorpedoes(w, jp, m, aim, 0, 0, 4, 2));
      }
      w.update(0.1);
      if (jp.torpedoesLeft() === 0) break;
    }
    ok(fired === 16, `阳炎级一共放出 ${fired} 条（8 管 + 8 条备用）`);
    ok(jp.torpedoesLeft() === 0, '备用雷用完后余量归零');
    for (let i = 0; i < 3000; i++) w.update(0.1);
    ok(jp.torps.every(t => t.loaded === 0), '空了的发射管不会再凭空装满（没有无限鱼雷）');
  }
}

/* ------------------------------------------------ 4. 无烟弹按年代配发 */
console.log('\n[4] 无烟弹（消焰发射药）1943 年 7 月以后才有');
{
  for (const [sid, want] of [['tassafaronga', false], ['savo_melee', false],
    ['vella_gulf', true], ['empress_augusta', true], ['cape_st_george', true]]) {
    const w = new N.World(N.Scenarios.get(sid), { seed: 3 });
    ok(w.flashlessAllowed === want,
      `${sid}（${N.Scenarios.get(sid).date}）：无烟弹${want ? '有' : '没有'}`);
  }
  const w2 = new N.World(N.Scenarios.get('vella_gulf'), { seed: 3 });
  const us = w2.ships.filter(s => s.side === 'US' && s.cls.type !== 'AK')[0];
  const jp = w2.ships.filter(s => s.side === 'JP' && s.cls.type !== 'AK')[0];
  const fl = us.flashlessLeft();
  const shells = us.shellsLeft();
  ok(fl > 0, `韦拉湾的美舰带了 ${fl} 发无烟弹`);
  ok(Math.abs(fl / shells - us.cls.flashless) < 0.02,
    `无烟弹占主炮弹药的 ${Math.round(100 * fl / shells)}%（设定 ${Math.round(100 * us.cls.flashless)}%）`);
  ok(jp.flashlessLeft() === 0, `日舰没有无烟弹（${jp.name}）`);
}

/* ------------------------------------------------ 5. 夜间开炮暴露位置 */
console.log('\n[5] 夜里用普通弹开炮，会被对方的瞭望哨看见');
{
  const { w, jp, us } = duel('neworleans', 'myoko', 8000, { light: 'night', date: '1942 年 11 月 30 日' });
  ok(!w.flashlessAllowed, '这一场是 1942 年的设定，美军也没有无烟弹');
  ok(us.flashlessLeft() === 0, '1942 年的美舰确实一发无烟弹都没有');

  w.exposeFlash(us, 203);
  for (let i = 0; i < 300; i++) w.update(0.1);   // 30 秒：够发报到指挥舰
  const flash = N.Sensors.trackList(w, 'JP').filter(t => t.fromFlash);
  ok(flash.length > 0, `日方图上出现了 ${flash.length} 条「炮口闪光」接触`);
  if (flash.length) {
    const t = flash[0];
    ok(t.idLevel === N.Sensors.ID.SURFACE, '识别等级只到「水面目标」');
    ok(t.countKnown === false, '数不清是几条船');
    ok(!t.typeGuess, '分不出舰种');
    ok(t.uncertainty > 1200, `误差 ${Math.round(t.uncertainty)} m —— 闪光—炮声时差测距，误差三成`);
    ok(!t.speed, '没有航速：那是"有人在开炮"，不是一条在走的船');
    ok(N.Sensors.idText(t).indexOf('闪光') >= 0, `标签写的是「${N.Sensors.idText(t)}」`);
  }
}

/* ------------------------------------------------ 6. 无烟弹 / 白天不暴露 */
console.log('\n[6] 同一场交火：用普通弹会暴露，用无烟弹不会');
{
  /** 打一场 90 秒的夜战，返回开炮次数和对方看到的闪光数 */
  function shootItOut(flashless) {
    const { w, us } = duel('neworleans', 'myoko', 8000, { light: 'night' });
    // 先跑 10 秒让双方建立接触
    for (let i = 0; i < 100; i++) w.update(0.1);
    const key = Object.keys(us.ownTracks || {})[0];
    us.targetTrackId = key;
    us.playerFireOrder = true;
    us.flashlessOn = flashless;
    if (flashless) us.mounts.forEach(m => { m.ammo = 0; });   // 只剩无烟弹
    const before = us.salvosFired;
    const fl0 = us.flashlessLeft();
    let sawFlash = 0;
    for (let i = 0; i < 900; i++) {
      w.update(0.1);
      sawFlash = Math.max(sawFlash, N.Sensors.trackList(w, 'JP').filter(t => t.fromFlash).length);
    }
    return { salvos: us.salvosFired - before, sawFlash, used: fl0 - us.flashlessLeft(), left: us.flashlessLeft() };
  }

  const normal = shootItOut(false);
  ok(normal.salvos > 0, `用普通弹打了 ${normal.salvos} 次齐射`);
  ok(normal.sawFlash > 0, `日方图上出现了「炮口闪光」接触（${normal.sawFlash} 条）`);

  const fl = shootItOut(true);
  ok(fl.salvos > 0, `用无烟弹打了 ${fl.salvos} 次齐射`);
  ok(fl.used > 0, `消耗了 ${fl.used} 发无烟弹`);
  ok(fl.sawFlash === 0, '日方图上一条闪光都没有 —— 位置没有暴露');
  ok(fl.used > 0 && fl.used % 3 === 0, `消耗 ${fl.used} 发（三联装，每次齐射 3 的倍数）`);

  {
    const { w, us } = duel('neworleans', 'myoko', 8000, { light: 'day' });
    w.exposeFlash(us, 203);
    for (let i = 0; i < 300; i++) w.update(0.1);
    const flash = N.Sensors.trackList(w, 'JP').filter(t => t.fromFlash);
    ok(flash.length === 0, '白天开炮不产生闪光接触（那点火光在日光下什么也不算）');
  }
}

/* ------------------------------------------------ 7. AI 不拿闪光当目标 */
console.log('\n[7] AI 不会对着一条闪光开炮');
{
  const { w, jp, us } = duel('neworleans', 'myoko', 9000, { light: 'night', date: '1942 年 11 月 30 日' });
  w.exposeFlash(us, 203);
  for (let i = 0; i < 300; i++) w.update(0.1);
  const flash = N.Sensors.trackList(w, 'JP').filter(t => t.fromFlash);
  ok(flash.length > 0, '日方图上确实有闪光接触');
  const picked = N.AI.pickTarget(w, jp);
  ok(!picked || !picked.fromFlash,
    `AI 挑的目标${picked ? '是 ' + N.Sensors.idText(picked) : '为空'}，不是闪光`);
}

console.log('');
if (bad === 0) console.log('✅ 炮口闪光与弹药自检全部通过');
else { console.log(`❌ ${bad} 项不通过`); process.exitCode = 1; }
