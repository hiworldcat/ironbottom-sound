/* =============================================================================
 *  sim/damage.js —— 设备级损害与损管
 *
 *  一艘舰不再只是"五条血条"，而是拆成一堆**具体设备**：
 *
 *    上层建筑  武器   火炮 × n（每座炮塔独立）、鱼雷发射架 × 1~2
 *              通讯   雷达、无线电、敌我识别器
 *              其他   上层建筑本体（塌了雷达火控一起完）
 *    动力系统  发动机 × n、舵机 × 1、电力系统 × 1
 *    船体结构  主血条
 *
 *  每台设备同时有两种状态，互不相同：
 *
 *    故障 fault   自己坏的（设备老化、装填机卡壳、锅炉爆管）。
 *                 每 5 分钟 1% 概率，坏了还能修好（每 5 分钟 10%）。
 *                 开火、全速会让它更容易坏、更难修。
 *    损坏 damage  别人打的（炮弹、鱼雷、近失弹、自己起火）。
 *                 **不可逆**，只能靠损管抢修船体和上层建筑，
 *                 设备本身打坏了就是打坏了。
 *
 *  两者可以叠加：一台发动机可以先被打坏 50%，再故障掉 75%，最后只剩一成动力。
 *
 *  所有判定都走 world.rng，同一个种子回放能复现。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U;

  var FAULT_INTERVAL = 300;    // 5 分钟：故障 / 修复判定
  var DC_INTERVAL = 600;       // 10 分钟：损管维修回血

  var P = {
    fault: 0.01,             // 设备基础故障率（每 5 分钟）
    repair: 0.10,            // 设备基础修复率

    firingFault: 0.02,       // 开火：故障率 +2%
    firingRepair: 0.04,      // 开火：修复率 -4%
    fullFault: 0.01,         // 全速：故障率 +1%
    fullRepair: 0.02,        // 全速：修复率 -2%

    engFiringFault: 0.01,    // 发动机开火：故障率 +1%
    engFiringRepair: 0.02,
    engFullFault: 0.02,      // 发动机全速：故障率 +2%
    engFullRepair: 0.04,

    elecFiringFault: 0.03,   // 电力系统开火：故障率 +3%
    elecFiringRepair: 0.05,

    dcHeal: 0.05,            // 损管每 10 分钟回 5% 血
    dcFiring: 0.02,          // 开火时 -2%
    dcFull: 0.01,            // 全速时 -1%

    engSteps: [25, 50, 75],  // 发动机每次故障/修复的动力变化量

    elecRadioDelay: 60,      // 电力失灵：无线电延迟 +60 秒
    elecIffError: 0.01,      // 电力失灵：敌我识别错误率 +1%
    elecGun: 1.5,            // 电力失灵：炮击间隔 ×1.5
    elecTorp: 2.0,           // 电力失灵：鱼雷装填间隔 ×2
    elecPowerCut: 0.25       // 动力系统低于 25% 时电力系统失灵
  };

  /* ====================================================================== */
  /*  损管档位：美军 vs 日军                                                 */
  /* ====================================================================== */

  /**
   * 二战两国损管的真实差距，主要不是"水兵不怕死"，而是三件事：
   *
   *   1. 组织 —— 美军 1942 年后在每条船上编了专门的损管队（DCA），
   *      有独立电话回路、标图板、预制堵漏器材；日军损管由当值军官兼管，
   *      战斗一乱就没人统一指挥。
   *   2. 器材 —— 美军有便携电动泵、泡沫灭火、可快速关闭的水密门；
   *      日军很多舰的水密门形同虚设，泵的排量也不够。
   *   3. 反注水 —— 美军会主动向对侧注水纠正横倾；日军基本不做，
   *      一旦横倾就恶性循环（"加古"、"古鹰"都是这么翻的）。
   *
   * 数值是"相对美军标准舰"的倍率：
   *   flood    缺口进水倍率（<1 = 进得慢，损管好）
   *   fire     灭火 / 堵漏 / 抢修速度倍率（>1 = 快）
   *   list     横倾恶化倍率
   *   magazine 弹药库殉爆概率倍率
   *   torpedo  鱼雷发射管被击毁时诱爆的概率（九三式氧气鱼雷的锅）
   */
  var DC_PROFILE = {
    US: { flood: 0.72, fire: 1.42, list: 0.62, magazine: 0.45, torpedo: 0.06, fault: 0.85 },
    JP: { flood: 1.24, fire: 0.80, list: 1.38, magazine: 1.55, torpedo: 0.26, fault: 1.55 }
  };

  /**
   * 一条舰的实际损管倍率 = 阵营档位 × 舰级系数。
   * cls.damageControl 是老数据（1.0 = 标准，越大越好），这里统一成"越大越好"的语义。
   */
  function profile(ship) {
    var base = DC_PROFILE[ship.side] || DC_PROFILE.US;
    var k = ship.cls && ship.cls.damageControl ? ship.cls.damageControl : 1;
    return {
      flood: base.flood / k,
      fire: base.fire * k,
      list: base.list / k,
      magazine: base.magazine / k,
      torpedo: base.torpedo,
      // 设备故障率倍率：损管好的船维护也好，坏得少
      fault: base.fault / k,
      side: ship.side
    };
  }

  /* ====================================================================== */
  /*  建表                                                                  */
  /* ====================================================================== */

  /** 按权重把一块血条分给若干设备 */
  function shareHP(zoneMax, weights) {
    var sum = 0, k, out = {};
    for (k in weights) sum += weights[k];
    if (sum <= 0) return out;
    for (k in weights) out[k] = zoneMax * weights[k] / sum;
    return out;
  }

  function isFullSpeed(ship) {
    var max = ship.effectiveMaxSpeed ? ship.effectiveMaxSpeed() : ship.cls.maxSpeed;
    if (!(max > 2)) return false;
    return ship.speed >= max * 0.92 || ship.orderedSpeed >= max * 0.98;
  }

  function isFiring(ship, world) {
    if (!world) return false;
    var lf = ship.lastFireTime == null ? -999 : ship.lastFireTime;
    return (world.time - lf) < 20;
  }

  /**
   * 给一艘舰建好设备表。构造 Ship 时调用一次。
   */
  function init(ship, world) {
    var cls = ship.cls;

    /* ---- 动力系统：发动机 + 舵机 + 电力，三者瓜分 power 血条 ---- */
    var n = cls.engines || (cls.type === 'AK' ? 2 : (cls.type === 'DD' ? 2 : 4));
    n = Math.max(1, Math.min(8, Math.round(n)));

    var powerW = { elec: 0.25, rudder: 0.13 };
    var i;
    for (i = 0; i < n; i++) powerW['e' + i] = 0.62 / n;
    var php = shareHP(ship.zoneMax.power, powerW);

    ship.engines = [];
    for (i = 0; i < n; i++) {
      ship.engines.push({
        idx: i,
        name: (i + 1) + ' 号主机',
        hpMax: php['e' + i],
        hp: php['e' + i],
        faulted: false,
        faultLoss: 0,          // 故障掉的动力百分比（0/25/50/75）
        destroyed: false
      });
    }

    ship.rudder = {
      name: '舵机',
      hpMax: php.rudder, hp: php.rudder,
      faulted: false, destroyed: false
    };
    ship.electrical = {
      name: '电力系统',
      hpMax: php.elec, hp: php.elec,
      faulted: false, destroyed: false
    };

    /* ---- 上层建筑：武器（炮塔 / 鱼雷管）+ 通讯（雷达 / 电台 / 识别器 / 电探） ---- */
    var weaponW = {}, commW = { radar: 1.0, radio: 0.7, iff: 0.5 };
    if (ship.hasESM) commW.esm = 0.38;
    ship.mounts.forEach(function (m, k) { weaponW['m' + k] = 1.6; });
    ship.torps.forEach(function (t, k) { weaponW['t' + k] = 1.0; });
    var whp = shareHP(ship.zoneMax.weapons, weaponW);
    var chp = shareHP(ship.zoneMax.comms, commW);

    /* ---- 设备清单（统一遍历用） ---- */
    ship.devList = [];

    ship.mounts.forEach(function (m, k) {
      m.fault = false;
      m.destroyed = !!m.disabled;
      m.hpMax = whp['m' + k];
      m.hp = m.destroyed ? 0 : m.hpMax;
      ship.devList.push({
        kind: 'gun', group: 'weapons', obj: m,
        name: m.label + ' 炮塔', short: m.label + '炮',
        get hp() { return m.hp; }, set hp(v) { m.hp = v; },
        get hpMax() { return m.hpMax; },
        get fault() { return m.fault; }, set fault(v) { m.fault = v; },
        get destroyed() { return m.destroyed; }
      });
    });

    ship.torps.forEach(function (t, k) {
      t.fault = false;
      t.destroyed = !!t.disabled;
      t.hpMax = whp['t' + k];
      t.hp = t.destroyed ? 0 : t.hpMax;
      ship.devList.push({
        kind: 'torp', group: 'weapons', obj: t,
        name: t.label + ' 号鱼雷发射管', short: t.label + '号鱼雷',
        get hp() { return t.hp; }, set hp(v) { t.hp = v; },
        get hpMax() { return t.hpMax; },
        get fault() { return t.fault; }, set fault(v) { t.fault = v; },
        get destroyed() { return t.destroyed; }
      });
    });

    ship.radarDev = { hpMax: chp.radar, hp: ship.radarDestroyed ? 0 : chp.radar, faulted: false };
    ship.radioDev = { hpMax: chp.radio, hp: ship.radioDestroyed ? 0 : chp.radio, faulted: false };
    ship.iffDev = { hpMax: chp.iff, hp: ship.iffDestroyed ? 0 : chp.iff, faulted: false };

    ship.devList.push({
      kind: 'radar', group: 'comms', obj: ship.radarDev,
      name: (cls.radar && cls.radar.name) || '雷达', short: '雷达',
      get hp() { return ship.radarDev.hp; }, set hp(v) { ship.radarDev.hp = v; },
      get hpMax() { return ship.radarDev.hpMax; },
      get fault() { return ship.radarDev.faulted; }, set fault(v) { ship.radarDev.faulted = v; },
      get destroyed() { return ship.radarDestroyed; }
    });
    ship.devList.push({
      kind: 'radio', group: 'comms', obj: ship.radioDev,
      name: '无线电', short: '电台',
      get hp() { return ship.radioDev.hp; }, set hp(v) { ship.radioDev.hp = v; },
      get hpMax() { return ship.radioDev.hpMax; },
      get fault() { return ship.radioDev.faulted; }, set fault(v) { ship.radioDev.faulted = v; },
      get destroyed() { return ship.radioDestroyed; }
    });
    ship.devList.push({
      kind: 'iff', group: 'comms', obj: ship.iffDev,
      name: '敌我识别器', short: '识别器',
      get hp() { return ship.iffDev.hp; }, set hp(v) { ship.iffDev.hp = v; },
      get hpMax() { return ship.iffDev.hpMax; },
      get fault() { return ship.iffDev.faulted; }, set fault(v) { ship.iffDev.faulted = v; },
      get destroyed() { return ship.iffDestroyed; }
    });

    /* 电探受信机：只监听，不发射。美军雷达一开机它就能测到方向，
       但测不到距离 —— 这是它和雷达最大的区别，也是它最要命的地方。 */
    ship.esmDev = null;
    if (ship.hasESM) {
      ship.esmDev = { hpMax: chp.esm, hp: ship.esmDestroyed ? 0 : chp.esm, faulted: false };
      ship.devList.push({
        kind: 'esm', group: 'comms', obj: ship.esmDev,
        name: '电探受信机', short: '电探',
        get hp() { return ship.esmDev.hp; }, set hp(v) { ship.esmDev.hp = v; },
        get hpMax() { return ship.esmDev.hpMax; },
        get fault() { return ship.esmDev.faulted; }, set fault(v) { ship.esmDev.faulted = v; },
        get destroyed() { return ship.esmDestroyed; }
      });
    }

    /* ---- 计时器 ---- */
    ship._faultT = 0;
    ship._healT = 0;

    // 场景预设损伤：把 steering / power 映射到新设备上
    if (ship._presetSteering != null) {
      setSteering(ship, ship._presetSteering);
      ship._presetSteering = null;
    }
  }

  /* ====================================================================== */
  /*  设备查询                                                              */
  /* ====================================================================== */

  function techDevices(ship) {
    var out = [];
    if (!ship.devList) return out;
    for (var i = 0; i < ship.devList.length; i++) {
      var d = ship.devList[i];
      if (d.kind !== 'gun' && d.kind !== 'torp') out.push(d);
    }
    return out;
  }

  /** 某个结构区底下挂着哪些设备 */
  function zoneDevices(ship, zoneKey) {
    if (!ship.devList) return [];
    if (zoneKey === 'power') return powerDevices(ship);
    var out = [];
    for (var i = 0; i < ship.devList.length; i++) {
      if (ship.devList[i].group === zoneKey) out.push(ship.devList[i]);
    }
    return out;
  }

  function superDevices(ship) {
    return ship.devList || [];
  }

  function powerDevices(ship) {
    var out = [];
    if (!ship.engines) return out;
    for (var i = 0; i < ship.engines.length; i++) out.push(ship.engines[i]);
    if (ship.rudder) out.push(ship.rudder);
    if (ship.electrical) out.push(ship.electrical);
    return out;
  }

  /** 一组设备的血量占比（0..1），血条显示用 */
  function groupFrac(list) {
    var hp = 0, max = 0;
    for (var i = 0; i < list.length; i++) { hp += Math.max(0, list[i].hp); max += list[i].hpMax; }
    return max > 0 ? U.clamp01(hp / max) : 1;
  }

  /** 发动机整体的血量占比 */
  function engineFrac(ship) {
    return groupFrac(ship.engines || []);
  }

  /**
   * 三大系统：船体结构 / 上层结构 / 动力系统。
   * 上层结构 = 武器 + 通讯 + 其他上层结构 三块之和；
   * 动力系统 = 发动机 + 舵机 + 电力 三块之和。
   */
  function systems(ship) {
    var w = ship.zoneMax.weapons, c = ship.zoneMax.comms, s = ship.zoneMax.superstructure;
    var upperMax = w + c + s;
    var upperHp = ship.zone.weapons + ship.zone.comms + ship.zone.superstructure;
    return {
      hull: ship.hullMax > 0 ? U.clamp01(ship.hull / ship.hullMax) : 1,
      upper: upperMax > 0 ? U.clamp01(upperHp / upperMax) : 1,
      weapons: ship.zoneFrac('weapons'),
      comms: ship.zoneFrac('comms'),
      other: ship.zoneFrac('superstructure'),
      power: ship.zoneFrac('power'),
      engines: engineFrac(ship),
      rudder: ship.rudder ? U.clamp01(ship.rudder.hp / ship.rudder.hpMax) : 1,
      elec: ship.electrical ? U.clamp01(ship.electrical.hp / ship.electrical.hpMax) : 1
    };
  }

  /* ====================================================================== */
  /*  设备被打坏                                                             */
  /* ====================================================================== */

  function destroyDevice(ship, d, world) {
    var o = d.obj || d;
    if (d.kind === 'gun') {
      o.disabled = true; o.ready = false; o.destroyed = true; o.hp = 0;
    } else if (d.kind === 'torp') {
      o.disabled = true; o.destroyed = true; o.hp = 0;
      /* 九三式氧气鱼雷：发射管被击毁时，管内的纯氧和 490 kg 战斗部会一起炸。
         日军自己的记录里，好几艘巡洋舰就是这么被自己的鱼雷送走的。 */
      var prof = profile(ship);
      if (world && world.rng && world.rng.chance(prof.torpedo)) {
        var k = ship.hullMax * 0.16;
        ship.hull = Math.max(0, ship.hull - k);
        ship.flood = Math.min(140, ship.flood + 14);
        ship.fire = Math.min(100, ship.fire + 22);
        ship.floodRate += 0.006;
        if (world.log) {
          world.log(ship.side, '💥💥 ' + ship.name + ' 的' + d.name + '被击中，管内氧气鱼雷诱爆！', 'critical');
        }
      } else if (world && world.log) {
        world.log(ship.side, '💥 ' + ship.name + ' 的' + d.name + '被击毁', 'critical');
      }
      return;
    } else if (d.kind === 'radar') {
      ship.radarDestroyed = true; o.hp = 0;
    } else if (d.kind === 'radio') {
      ship.radioDestroyed = true; o.hp = 0;
    } else if (d.kind === 'iff') {
      ship.iffDestroyed = true; o.hp = 0;
    } else if (d.kind === 'esm') {
      ship.esmDestroyed = true; o.hp = 0;
    } else {
      o.hp = 0; o.destroyed = true;
    }
    if (world && world.log && d.kind) {
      world.log(ship.side, '💥 ' + ship.name + ' 的' + d.name + '被击毁', 'critical');
    }
  }

  /**
   * 结构区挨打时，把伤害也分到具体设备上。
   * 每个结构区只管自己挂着的设备：武器区 → 炮塔和鱼雷管，通讯区 → 雷达 / 电台 / 识别器，
   * 动力区 → 主机 / 舵机 / 电力。按剩余血量加权随机挑一台 —— 可能先掉 A 炮塔，
   * 也可能先掉 B 炮塔，但总量和原来的"结构区血条"完全一致。
   */
  function routeDamage(ship, zoneKey, amount, world, route) {
    if (!(amount > 0) || !ship.devList) return;
    var list = zoneDevices(ship, zoneKey);
    var pool = [], total = 0, i;
    for (i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.destroyed) continue;
      if (d.hp <= 0) continue;
      // 指定只打某一类设备（例如搁浅只伤螺旋桨和轴系）
      if (route === 'engine' && ship.engines && ship.engines.indexOf(d) < 0) continue;
      pool.push(d);
      total += d.hp;
    }
    if (!pool.length || total <= 0) return;

    /* 武器和通讯是"一大片设备"：一发炮弹扫过去是整片结构一起受损，
       所以按血量比例摊到每台设备上 —— 炮塔一台台慢慢打坏，而不是一发就没。
       动力区反过来：机舱里挨一发，就是某一台主机倒霉。 */
    if (zoneKey === 'weapons' || zoneKey === 'comms') {
      var drain = Math.min(amount, total);
      for (i = 0; i < pool.length; i++) {
        var dv2 = pool[i];
        dv2.hp = Math.max(0, dv2.hp - drain * (dv2.hp / total));
      }
      for (i = 0; i < pool.length; i++) {
        var dv3 = pool[i];
        if (dv3.hp <= 0.0001 && !dv3.destroyed) {
          dv3.hp = 0;
          if (dv3.kind) destroyDevice(ship, dv3, world);
          else dv3.destroyed = true;
        }
      }
      syncZone(ship, zoneKey);
      return;
    }

    // 一发炮弹打穿一台设备时，多出来的伤害要顺延到下一台，
    // 否则结构区掉的血比设备掉的血多，两边账目就对不上了
    var remain = amount;
    while (remain > 0 && pool.length) {
      var r = (world && world.rng ? world.rng.next() : Math.random()) * total;
      var idx = pool.length - 1;
      for (i = 0; i < pool.length; i++) {
        r -= pool[i].hp;
        if (r <= 0) { idx = i; break; }
      }
      var pick = pool[idx];
      var take = Math.min(remain, pick.hp);
      pick.hp -= take;
      remain -= take;
      total -= take;
      if (pick.hp <= 0.0001) {
        pick.hp = 0;
        if (!pick.destroyed) {
          if (pick.kind) destroyDevice(ship, pick, world);
          else pick.destroyed = true;
        }
        pool.splice(idx, 1);
      }
    }

    syncZone(ship, zoneKey);
  }

  /** 设备血量变了以后，把它所属的结构区血条拉回来对齐 */
  function syncZone(ship, zoneKey) {
    if (!ship.zone || ship.zone[zoneKey] == null) return;
    var list = zoneDevices(ship, zoneKey);
    if (!list.length) return;
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += Math.max(0, list[i].hp);
    ship.zone[zoneKey] = Math.min(ship.zoneMax[zoneKey], sum);
    if (zoneKey === 'power') ship.power = 100 * propulsion(ship);
  }

  /* ====================================================================== */
  /*  故障与修复                                                             */
  /* ====================================================================== */

  function logFault(ship, world, text, kind) {
    if (world && world.log) world.log(ship.side, text, kind || 'warn');
  }

  function rollFaults(ship, world) {
    if (!ship.devList || ship.sinking || ship.sunk) return;
    var rng = world.rng;
    var firing = isFiring(ship, world);
    var full = isFullSpeed(ship);
    var i, d, p;
    // 损管好的船：故障少、修得快
    var prof = profile(ship);
    var faultMul = prof.fault;

    /* ---- 技术设备：雷达 / 电台 / 识别器 / 电探 / 炮塔 / 鱼雷管 ---- */
    var tech = ship.devList;
    for (i = 0; i < tech.length; i++) {
      d = tech[i];
      if (d.destroyed) continue;
      if (d.fault) {
        p = (P.repair - (firing ? P.firingRepair : 0) - (full ? P.fullRepair : 0)) * prof.fire;
        if (p > 0 && rng.chance(p)) {
          d.fault = false;
          logFault(ship, world, '🔧 ' + ship.name + ' 的' + d.name + '修好了', 'info');
        }
      } else {
        p = (P.fault + (firing ? P.firingFault : 0) + (full ? P.fullFault : 0)) * faultMul;
        if (rng.chance(p)) {
          d.fault = true;
          logFault(ship, world, '⚠ ' + ship.name + ' 的' + d.name + '故障', 'warn');
        }
      }
    }

    /* ---- 发动机 ---- */
    for (i = 0; i < ship.engines.length; i++) {
      var e = ship.engines[i];
      if (e.destroyed) continue;
      if (e.faulted) {
        p = (P.repair - (firing ? P.engFiringRepair : 0) - (full ? P.engFullRepair : 0)) * prof.fire;
        if (p > 0 && rng.chance(p)) {
          var fix = P.engSteps[rng.int(0, 2)];
          e.faultLoss = Math.max(0, e.faultLoss - fix);
          if (e.faultLoss <= 0) {
            e.faulted = false;
            logFault(ship, world, '🔧 ' + ship.name + ' 的' + e.name + '恢复', 'info');
          } else {
            logFault(ship, world, '🔧 ' + ship.name + ' 的' + e.name + '抢修回 ' + fix + '%', 'info');
          }
        }
      } else {
        p = (P.fault + (firing ? P.engFiringFault : 0) + (full ? P.engFullFault : 0)) * faultMul;
        if (rng.chance(p)) {
          e.faulted = true;
          var lose = P.engSteps[rng.int(0, 2)];
          e.faultLoss = Math.min(100, e.faultLoss + lose);
          logFault(ship, world, '⚠ ' + ship.name + ' 的' + e.name + '故障，失去 ' + lose + '% 动力', 'warn');
        }
      }
    }

    /* ---- 舵机：只有全速时才容易出毛病，且不受其他因素影响 ---- */
    var rd = ship.rudder;
    if (rd && !rd.destroyed) {
      if (rd.faulted) {
        if (rng.chance(P.repair * prof.fire)) {
          rd.faulted = false;
          logFault(ship, world, '🔧 ' + ship.name + ' 的舵机修好了', 'info');
        }
      } else if (full && rng.chance(P.fault * faultMul)) {
        rd.faulted = true;
        logFault(ship, world, '⚠ ' + ship.name + ' 舵机卡死，转向明显变慢', 'warn');
      }
    }

    /* ---- 电力系统 ---- */
    var el = ship.electrical;
    if (el && !el.destroyed) {
      if (el.faulted) {
        p = (P.repair - (firing ? P.elecFiringRepair : 0)) * prof.fire;
        if (p > 0 && rng.chance(p)) {
          el.faulted = false;
          logFault(ship, world, '🔧 ' + ship.name + ' 电力系统恢复', 'info');
        }
      } else {
        p = (P.fault + (firing ? P.elecFiringFault : 0)) * faultMul;
        if (rng.chance(p)) {
          el.faulted = true;
          logFault(ship, world, '⚠ ' + ship.name + ' 电力系统失灵：雷达、无线电、火控全受影响', 'critical');
        }
      }
    }
  }

  /* ====================================================================== */
  /*  损管                                                                  */
  /* ====================================================================== */

  function damageControl(ship, world) {
    if (ship.sunk || ship.sinking) return;
    var firing = isFiring(ship, world);
    var full = isFullSpeed(ship);
    var prof = profile(ship);
    var heal = (P.dcHeal - (firing ? P.dcFiring : 0) - (full ? P.dcFull : 0)) * prof.fire;
    if (heal <= 0) return;

    var did = false;
    // 船体结构
    if (ship.hull < ship.hullMax * 0.999) {
      ship.hull = Math.min(ship.hullMax, ship.hull + ship.hullMax * heal);
      did = true;
    }
    // 其他上层建筑
    if (ship.zone && ship.zoneMax && ship.zone.superstructure < ship.zoneMax.superstructure * 0.999) {
      ship.zone.superstructure = Math.min(ship.zoneMax.superstructure,
        ship.zone.superstructure + ship.zoneMax.superstructure * heal);
      did = true;
    }
    if (did) {
      logFault(ship, world, '🛠 ' + ship.name + ' 损管抢修：船体与上层建筑各回 ' +
        Math.round(heal * 100) + '%', 'info');
    }
  }

  /* ====================================================================== */
  /*  主循环                                                                */
  /* ====================================================================== */

  function update(ship, dt, world) {
    if (ship.sunk || !ship.devList) return;
    ship._faultT = (ship._faultT || 0) + dt;
    if (ship._faultT >= FAULT_INTERVAL) {
      ship._faultT -= FAULT_INTERVAL;
      rollFaults(ship, world);
    }
    ship._healT = (ship._healT || 0) + dt;
    if (ship._healT >= DC_INTERVAL) {
      ship._healT -= DC_INTERVAL;
      damageControl(ship, world);
    }
  }

  /* ====================================================================== */
  /*  对外接口                                                              */
  /* ====================================================================== */

  /** 推进效率 0..1：发动机损坏 + 故障叠加后的总输出 */
  function propulsion(ship) {
    var eng = ship.engines;
    if (!eng || !eng.length) return U.clamp01(ship.power / 100);
    var sum = 0;
    for (var i = 0; i < eng.length; i++) {
      var e = eng[i];
      var frac = e.hpMax > 0 ? U.clamp01(e.hp / e.hpMax) : 1;
      if (e.destroyed || frac <= 0.001) continue;          // 彻底打烂 = 一点动力都不剩
      // 血量：<100% 掉 25%，<75% 掉 50%，<50% 掉 90%
      var out = frac >= 0.999 ? 1 : (frac >= 0.75 ? 0.75 : (frac >= 0.5 ? 0.5 : 0.10));
      // 故障：再乘上剩下的动力
      out *= (1 - U.clamp01(e.faultLoss / 100));
      sum += out;
    }
    return U.clamp01(sum / eng.length);
  }

  /** 转向时间倍数：舵机损坏 ×2/×3/×5，故障再 ×2 */
  function turnFactor(ship) {
    var r = ship.rudder;
    if (!r) return 1;
    var f = 1;
    var frac = r.hpMax > 0 ? U.clamp01(r.hp / r.hpMax) : 1;
    if (frac < 0.5) f *= 5;
    else if (frac < 0.75) f *= 3;
    else if (frac < 0.999) f *= 2;
    if (r.faulted) f *= 2;
    return f;
  }

  /** 电力系统失灵？故障、被打坏，或动力系统整体不足 25% */
  function elecFailed(ship) {
    var e = ship.electrical;
    if (!e) return false;
    if (e.destroyed || e.faulted) return true;
    if (ship.zoneFrac && ship.zoneFrac('power') < P.elecPowerCut) return true;
    return false;
  }

  function radarOk(ship) {
    if (ship.radarDestroyed) return false;
    if (ship.radarDev && ship.radarDev.faulted) return false;
    return !elecFailed(ship);
  }

  function iffOk(ship) {
    if (ship.iffDestroyed) return false;
    if (ship.iffDev && ship.iffDev.faulted) return false;
    return !elecFailed(ship);
  }

  function radioOk(ship) {
    if (ship.radioDestroyed) return false;
    if (ship.radioDev && ship.radioDev.faulted) return false;
    return !elecFailed(ship);
  }

  /** 电探受信机能不能用：没装、被打掉、故障、断电都不行 */
  function esmOk(ship) {
    if (!ship || !ship.hasESM || !ship.esmDev) return false;
    if (ship.esmDestroyed) return false;
    if (ship.esmDev.hp <= 0) return false;
    if (ship.esmDev.faulted) return false;
    return !elecFailed(ship);
  }

  function radioDelayBonus(ship) {
    return elecFailed(ship) ? P.elecRadioDelay : 0;
  }

  function iffError(ship) {
    var p = 0.01;
    if (elecFailed(ship)) p += P.elecIffError;
    return p;
  }

  /** 炮塔装填速度系数（1 = 正常；电力失灵时 1/1.5） */
  function gunRate(ship) {
    return elecFailed(ship) ? 1 / P.elecGun : 1;
  }

  /** 鱼雷装填速度系数（1 = 正常；电力失灵时 1/2） */
  function torpRate(ship) {
    return elecFailed(ship) ? 1 / P.elecTorp : 1;
  }

  /** 某座炮塔/鱼雷管现在能不能用 */
  function mountOk(m) {
    return !!m && !m.disabled && !m.fault && !m.destroyed;
  }

  /** 转向受损比例 → 写回 steering 字段（兼容老接口） */
  function setSteering(ship, pct) {
    if (!ship.rudder) { ship.steering = pct; return; }
    var f = U.clamp01(pct / 100);
    ship.rudder.hp = ship.rudder.hpMax * f;
    ship.steering = pct;
  }

  /** 动力百分比 → 写回各发动机（兼容 setPowerPct / 场景预设） */
  function setPowerPct(ship, pct) {
    var p = U.clamp01(pct / 100);
    ship.power = pct;
    if (ship.zoneMax && ship.zoneMax.power > 0) ship.zone.power = ship.zoneMax.power * p;
    if (!ship.engines) return;
    for (var i = 0; i < ship.engines.length; i++) {
      var e = ship.engines[i];
      e.hp = e.hpMax * p;
      e.faultLoss = 0;
      e.faulted = false;
      e.destroyed = false;
    }
  }

  /** 结构区被打光时的连带后果 */
  function onZoneLost(ship, k, world) {
    if (k === 'weapons') {
      ship.mounts.forEach(function (m) { m.hp = 0; m.disabled = true; m.ready = false; m.destroyed = true; });
      ship.torps.forEach(function (t) { t.hp = 0; t.disabled = true; t.destroyed = true; });
    } else if (k === 'comms') {
      ship.radioDestroyed = true;
      ship.iffDestroyed = true;
      ship.radarDestroyed = true;
      if (ship.radioDev) ship.radioDev.hp = 0;
      if (ship.iffDev) ship.iffDev.hp = 0;
      if (ship.radarDev) ship.radarDev.hp = 0;
    } else if (k === 'superstructure') {
      // 上层结构（船楼、桅杆、烟囱）塌了：雷达天线和火控指挥仪一起没了
      ship.radarDestroyed = true;
      ship.fcDestroyed = true;
      if (ship.radarDev && ship.killDevice) ship.killDevice(ship.radarDev, 'comms', world);
    } else if (k === 'power') {
      ship.power = 0;
      if (ship.engines) ship.engines.forEach(function (e) { e.hp = 0; e.destroyed = true; });
      if (ship.rudder) { ship.rudder.hp = 0; ship.rudder.destroyed = true; }
      if (ship.electrical) { ship.electrical.hp = 0; ship.electrical.destroyed = true; }
    }
  }

  /* ====================================================================== */
  /*  给 UI 的文字                                                           */
  /* ====================================================================== */

  /** 当前所有故障（供左栏和详情面板显示） */
  function faults(ship) {
    var out = [];
    if (!ship.devList) return out;
    var i;
    for (i = 0; i < ship.devList.length; i++) {
      var d = ship.devList[i];
      if (d.fault && !d.destroyed) out.push({ name: d.name, short: d.short, kind: d.kind });
    }
    if (ship.engines) {
      for (i = 0; i < ship.engines.length; i++) {
        var e = ship.engines[i];
        if (e.faulted && !e.destroyed) {
          out.push({ name: e.name, short: e.name.replace(' 号主机', '号机'), kind: 'engine', loss: e.faultLoss });
        }
      }
    }
    if (ship.rudder && ship.rudder.faulted) out.push({ name: '舵机', short: '舵机', kind: 'rudder' });
    if (ship.electrical && ship.electrical.faulted) out.push({ name: '电力系统', short: '电力', kind: 'elec' });
    return out;
  }

  /** 已经彻底打坏的设备 */
  function destroyedList(ship) {
    var out = [];
    if (!ship.devList) return out;
    for (var i = 0; i < ship.devList.length; i++) {
      var d = ship.devList[i];
      if (d.destroyed) out.push({ name: d.name, short: d.short, kind: d.kind });
    }
    if (ship.engines) {
      ship.engines.forEach(function (e) {
        if (e.destroyed) out.push({ name: e.name, short: e.name.replace(' 号主机', '号机'), kind: 'engine' });
      });
    }
    if (ship.rudder && ship.rudder.destroyed) out.push({ name: '舵机', short: '舵机', kind: 'rudder' });
    if (ship.electrical && ship.electrical.destroyed) out.push({ name: '电力系统', short: '电力', kind: 'elec' });
    return out;
  }

  /** 一行摘要 */
  function summary(ship) {
    if (!ship.devList) return '';
    var parts = [];
    var f = faults(ship), d = destroyedList(ship);
    if (d.length) parts.push('毁:' + d.map(function (x) { return x.short; }).join('/'));
    if (f.length) parts.push('故障:' + f.map(function (x) { return x.short; }).join('/'));
    return parts.join(' · ');
  }

  /* ====================================================================== */
  /*  图上小标签用的“哪些功能坏了”位掩码                                      */
  /*  渲染层只认这 8 个位，海图、回放、录像共用同一套定义                      */
  /* ====================================================================== */
  var FAIL = {
    RADAR: 1, RADIO: 2, IFF: 4, FC: 8,
    RUDDER: 16, POWER: 32, GUNS: 64, TORPS: 128,
    /* 电力是“根因”位：全船没电的时候，雷达、电台、识别器是一起灭的，
       图上只该写一条「电力」，不该把四个结果都挂出来 */
    ELEC: 256
  };

  /** 五个一级分区的血量比例（船体 / 上层 / 武器 / 通信 / 动力），0~1 */
  function zoneFracs(ship) {
    var z = ship.zone || {}, zm = ship.zoneMax || {};
    function f(cur, max) { return max > 0 ? U.clamp01(cur / max) : 1; }
    return [
      f(ship.hull, ship.hullMax),
      f(z.superstructure, zm.superstructure),
      f(z.weapons, zm.weapons),
      f(z.comms, zm.comms),
      f(z.power, zm.power)
    ];
  }

  function failMask(ship) {
    var m = 0, i;
    if (!radarOk(ship)) m |= FAIL.RADAR;
    if (!radioOk(ship)) m |= FAIL.RADIO;
    if (!iffOk(ship)) m |= FAIL.IFF;
    // 火控指挥仪被打掉，或者上层建筑塌了一半（测距仪、指挥仪都在上面）
    if (ship.fcDestroyed) m |= FAIL.FC;
    else if (ship.sensorFactor && ship.sensorFactor() < 0.55) m |= FAIL.FC;
    if (ship.rudder && (ship.rudder.destroyed || ship.rudder.faulted)) m |= FAIL.RUDDER;
    else if (ship.steering != null && ship.steering < 55) m |= FAIL.RUDDER;
    if (elecFailed(ship)) m |= FAIL.ELEC;
    if (ship.engines && ship.engines.length && engineFrac(ship) < 0.55) m |= FAIL.POWER;
    // 一半以上的炮 / 鱼雷管不能用了，才值得在图上标一笔
    var gn = 0, gok = 0, tn = 0, tok = 0;
    for (i = 0; i < ship.mounts.length; i++) {
      gn++;
      if (!ship.mounts[i].disabled && !ship.mounts[i].destroyed) gok++;
    }
    for (i = 0; i < ship.torps.length; i++) {
      tn++;
      if (!ship.torps[i].disabled && !ship.torps[i].destroyed) tok++;
    }
    if (gn && gok / gn <= 0.5) m |= FAIL.GUNS;
    if (tn && tok / tn <= 0.5) m |= FAIL.TORPS;
    return m;
  }

  N.Damage = {
    FAIL: FAIL,
    failMask: failMask,
    zoneFracs: zoneFracs,
    init: init,
    update: update,
    routeDamage: routeDamage,
  syncZone: syncZone,
    onZoneLost: onZoneLost,
    profile: profile,
    DC_PROFILE: DC_PROFILE,
    propulsion: propulsion,
    turnFactor: turnFactor,
    elecFailed: elecFailed,
    radarOk: radarOk,
    iffOk: iffOk,
    radioOk: radioOk,
    esmOk: esmOk,
    radioDelayBonus: radioDelayBonus,
    iffError: iffError,
    gunRate: gunRate,
    torpRate: torpRate,
    mountOk: mountOk,
    setSteering: setSteering,
    setPowerPct: setPowerPct,
    faults: faults,
    destroyedList: destroyedList,
    summary: summary,
    powerDevices: powerDevices,
    zoneDevices: zoneDevices,
    groupFrac: groupFrac,
    engineFrac: engineFrac,
    systems: systems,
    isFullSpeed: isFullSpeed,
    isFiring: isFiring,
    P: P,
    FAULT_INTERVAL: FAULT_INTERVAL,
    DC_INTERVAL: DC_INTERVAL
  };
})(globalThis.Naval = globalThis.Naval || {});
