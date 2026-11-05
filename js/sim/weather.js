/* =============================================================================
 *  sim/weather.js —— 气象：风、浪、雨、云、月光
 *
 *  这一版的气象**不直接改炮术、也不改航速** —— 它改的是「你知不知道对面在哪」：
 *
 *    · 雷达   雨幕衰减、高海况海杂波（小船淹没在浪回波里）
 *    · 瞭望哨 能见度（雨/雾/浪沫）、月光（云量遮月）、烟（含起火冒的烟）
 *    · 无线电 雨静电与海况让指挥链路更容易丢包
 *
 *  换句话说：天坏了，先瞎的是眼睛和耳朵，不是炮。
 *
 *  气象每 STEP 秒推演一次，全部走 world.weatherRng（独立于战斗随机流），
 *  所以同一个种子 + 同一串指令 = 同一场天气，回放可复现。
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U;

  var STEP = 8;                 // 气象推演步长（秒）
  var SQUALL_CHANCE = 0.005;    // 每个步长起一次雨飑的概率

  var SEA_NAME = ['无浪', '微浪', '小浪', '轻浪', '中浪', '大浪', '巨浪', '狂浪'];
  var COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

  /* ------------------------------------------------------------------ 换算 */

  /** 风速（节）→ 大致海况等级（蒲福风级近似） */
  function seaFromWind(kn) {
    if (kn < 4) return 1;
    if (kn < 8) return 2;
    if (kn < 13) return 3;
    if (kn < 19) return 4;
    if (kn < 25) return 5;
    if (kn < 32) return 6;
    return 7;
  }

  function seaName(v) {
    return SEA_NAME[Math.round(U.clamp(v, 0, 7))] || '狂浪';
  }

  function windName(dir) {
    return COMPASS[Math.round(U.norm360(dir) / 45) % 8] + '风';
  }

  /** moon 是「月光照度」0..1：0 新月，1 满月 */
  function moonName(m) {
    if (m < 0.08) return '新月';
    if (m < 0.32) return '蛾眉月';
    if (m < 0.60) return '上下弦月';
    if (m < 0.90) return '盈凸月';
    return '满月';
  }

  /** 被云挡掉一部分的月光 */
  function moonEff(w) {
    return U.clamp01(w.moon * (1 - 0.55 * w.cloud));
  }

  /**
   * 能见度相对系数（不含基准值、不含下限）。
   * 雨、雨飑、夜间月光、浪沫依次打折。
   */
  function visFactor(w) {
    var v = 1;
    // 雨飑本身就是暴雨，别指望 rain 字段是 0
    var rain = w.squall ? Math.max(w.rain, 0.8) : w.rain;
    v *= (1 - 0.60 * rain);
    if (w.squall) v *= 0.55;
    if (w.light === 'night') v *= (0.78 + 0.44 * moonEff(w));
    else if (w.light === 'dusk' || w.light === 'dawn') v *= (0.86 + 0.18 * moonEff(w));
    if (w.seaState >= 6) v *= 0.92;          // 浪花飞沫糊住测距仪
    return v;
  }

  /** 当前有效能见度（米） */
  function effectiveVisibility(w) {
    return Math.max(900, w.baseVisibility * visFactor(w));
  }

  /* ------------------------------------------------------------------ 初始化 */

  function init(world, scenario) {
    var env = (scenario && scenario.env) || {};
    // 气象用自己的一条随机流，免得把战斗的随机序列搅乱
    var seed = ((world.seedValue || 12345) ^ 0x5EED17) >>> 0;
    var rng = world.weatherRng = new N.RNG(seed);

    var baseVis = env.visibility == null ? 12000 : env.visibility;
    var light = env.light || 'day';

    var w = world.weather = {
      light: light,
      windDir: env.windDir == null ? 90 : env.windDir,
      windSpeed: env.windSpeed == null ? 12 : env.windSpeed,
      seaState: env.seaState == null ? 3 : env.seaState,
      rain: env.rain == null ? 0 : env.rain,
      cloud: env.cloud == null ? (light === 'night' ? 0.35 : 0.5) : env.cloud,
      moon: env.moon == null ? rng.range(0.05, 0.95) : env.moon,

      baseVisibility: baseVis,
      visibility: baseVis,

      variance: env.variance == null ? 0.45 : env.variance,
      fixed: !!env.fixed,           // 剧本钉死天气，不再随机推演

      squall: 0,                    // 1 = 正在下飑
      squallUntil: -1,
      squallCooldown: rng.range(200, 780),
      squallWind: 0,

      trend: 0,                     // -1 变差 / 0 稳定 / +1 变好（给 HUD 用）
      _acc: 0,
      _lastTrendAt: 0,
      _lastLogAt: -999,
      _visBefore: baseVis
    };

    w.visibility = effectiveVisibility(w);
    // 标定：让开局能见度**正好等于剧本写的值**，之后才随雨和月光上下浮动。
    // 否则月光系数会一路把夜战压到 3 km 以下，跟简报对不上。
    var f0 = visFactor(w);
    if (f0 > 0.05) w.baseVisibility = baseVis / f0;
    w.visibility = effectiveVisibility(w);
    w._visBefore = w.visibility;
    return w;
  }

  /* ------------------------------------------------------------------ 推演 */

  function log(world, text, kind) {
    if (world.log) world.log(world.playerSide, text, kind || 'weather');
  }

  function step(world) {
    var w = world.weather, rng = world.weatherRng;
    if (!w || !rng) return;

    var v = w.variance;

    /* ---- 雨飑：来得快，去得也快 ---- */
    if (w.squall) {
      if (world.time >= w.squallUntil) {
        w.squall = 0;
        w.squallWind = 0;
        w.squallCooldown = world.time + rng.range(300, 1200);
        log(world, '雨飑过去，' + windName(w.windDir) + '减弱，能见度恢复到 ' +
          (w.visibility / 1000).toFixed(1) + ' km');
      }
    } else if (world.time > w.squallCooldown && rng.chance(SQUALL_CHANCE * (0.4 + v))) {
      w.squall = 1;
      w.squallUntil = world.time + rng.range(70, 210);
      w.squallWind = rng.range(22, 34);
      w.rain = Math.max(w.rain, rng.range(0.8, 1.0));
      w.cloud = Math.min(1, w.cloud + 0.3);
      w.visibility = effectiveVisibility(w);
      log(world, '⚠ 一条雨飑扫过战场：能见度骤降到 ' +
        (w.visibility / 1000).toFixed(1) + ' km，无线电杂音增大', 'warn');
    }

    if (w.fixed) return;

    /* ---- 风：方向和风速都在漂，但不会漂到天上去 ---- */
    w.windDir = U.norm360(w.windDir + rng.dev(5.0 * v));
    w.windSpeed = U.clamp(w.windSpeed + rng.dev(1.5 * v), 2, 40);

    /* ---- 海况追着风走，但有滞后 ---- */
    var targetSea = seaFromWind(w.windSpeed);
    var follow = 0.08 + 0.10 * v;
    w.seaState = U.clamp(w.seaState + (targetSea - w.seaState) * follow, 1, 7);

    /* ---- 雨：慢慢起，慢慢收 ---- */
    if (!w.squall) {
      var rainDrift = rng.dev(0.045 * v) - 0.015 * (w.rain > 0 ? 1 : 0);
      w.rain = U.clamp(w.rain + rainDrift, 0, 1);
      if (w.rain < 0.03) w.rain = 0;
      // 一阵骤雨（不是飑，就是一片雨，几分钟就过去）
      if (w.rain < 0.32 && rng.chance(0.006 * (0.4 + v))) {
        w.rain = rng.range(0.28, 0.72);
        w.cloud = Math.min(1, w.cloud + 0.18);
        w.visibility = effectiveVisibility(w);
        log(world, '下起阵雨：能见度降到 ' + (w.visibility / 1000).toFixed(1) +
          ' km，瞭望和测距都受影响');
      }
    } else {
      w.rain = Math.max(w.rain, 0.8);
    }

    /* ---- 云量跟着雨走；雨停了云慢慢散 ---- */
    w.cloud = U.clamp(w.cloud + rng.dev(0.035 * v) + (w.rain > 0.2 ? 0.05 : -0.03), 0, 1);

    /* ---- 能见度趋势（给 HUD 的箭头） ---- */
    w.visibility = effectiveVisibility(w);
    if (world.time - w._lastTrendAt > 90) {
      w.trend = w.visibility > w._visBefore * 1.08 ? 1 :
        (w.visibility < w._visBefore * 0.92 ? -1 : 0);
      w._visBefore = w.visibility;
      w._lastTrendAt = world.time;
    }
  }

  function update(world, dt) {
    var w = world.weather;
    if (!w) return;
    w._acc += dt;
    if (w._acc >= STEP) {
      var n = Math.floor(w._acc / STEP);
      w._acc -= n * STEP;
      for (var i = 0; i < n; i++) step(world);
    }
    w.visibility = effectiveVisibility(w);
  }

  /* ------------------------------------------------------------------ 影响 */

  /**
   * 雷达作用距离系数。
   * 雨幕对 X 波段是实打实的衰减；高海况的海杂波会把小船回波埋掉。
   */
  function radarFactor(world) {
    var w = world.weather;
    if (!w) return 1;
    var rain = w.squall ? Math.max(w.rain, 0.8) : w.rain;
    var f = 1 - 0.38 * rain;                         // 雨幕衰减
    if (w.squall) f *= 0.72;                         // 飑里基本靠不住
    if (w.seaState >= 5) f *= (1 - 0.035 * (w.seaState - 4));   // 海杂波
    return U.clamp(f, 0.40, 1);
  }

  /** 小目标在高海况下更容易被浪回波淹没（额外系数） */
  function seaClutter(world, target) {
    var w = world.weather;
    if (!w || w.seaState < 4 || !target || !target.cls) return 1;
    var d = target.cls.displacement || 2000;
    if (d > 6000) return 1;                          // 大舰回波够强
    var thin = U.clamp01((6000 - d) / 6000);
    return 1 - 0.30 * thin * U.clamp01((w.seaState - 3) / 3);
  }

  /** 无线电丢包加成：雨静电 + 海况让天线晃 */
  function radioExtra(world) {
    var w = world.weather;
    if (!w) return 0;
    var p = w.rain * 0.18;
    if (w.squall) p += 0.12;
    if (w.seaState >= 5) p += 0.05 * (w.seaState - 4);
    return p;
  }

  /** 夜间起火的目标更扎眼（火光是最好的灯塔） */
  function fireBeacon(world) {
    var w = world.weather;
    if (!w) return 1;
    if (w.light === 'day') return 1;
    var dark = w.light === 'night' ? (1 - 0.5 * moonEff(w)) : 0.55;
    return 1 + 0.55 * dark;
  }

  /* ------------------------------------------------------------------ 文字 */

  function status(world) {
    var w = world.weather;
    if (!w) return '';
    return '能见度 ' + (w.visibility / 1000).toFixed(1) + ' km · ' +
      windName(w.windDir) + ' ' + Math.round(w.windSpeed) + ' kn · ' +
      seaName(w.seaState) + ' ' + Math.round(w.seaState);
  }

  /** 战前简报用的一整句 */
  function brief(world) {
    var w = world.weather;
    if (!w) return '';
    var parts = [];
    parts.push(windName(w.windDir) + ' ' + Math.round(w.windSpeed) + ' 节');
    parts.push('海况 ' + Math.round(w.seaState) + '（' + seaName(w.seaState) + '）');
    parts.push('能见度 ' + (w.visibility / 1000).toFixed(1) + ' 公里');
    if (w.light === 'night' || w.light === 'dusk' || w.light === 'dawn') {
      parts.push(moonName(w.moon) + '（月光 ' + Math.round(moonEff(w) * 100) + '%）');
    }
    if (w.rain > 0.15) parts.push('有雨');
    if (w.cloud > 0.7) parts.push('阴天');
    return parts.join('，');
  }

  /** 天气对三种传感器的影响，给 UI 列出来 */
  function effects(world) {
    var w = world.weather;
    if (!w) return { radar: 1, radio: 0, visual: 1 };
    return {
      radar: radarFactor(world),
      radio: radioExtra(world),
      visual: w.baseVisibility > 0 ? w.visibility / w.baseVisibility : 1
    };
  }

  /** 战前「天气预报」：只用剧本 env，不含随机量（实际以现场为准） */
  function forecast(env) {
    env = env || {};
    var vis = env.visibility == null ? 12000 : env.visibility;
    var sea = env.seaState == null ? 3 : env.seaState;
    var parts = [];
    parts.push(windName(env.windDir == null ? 90 : env.windDir) + ' ' +
      Math.round(env.windSpeed == null ? 12 : env.windSpeed) + ' 节');
    parts.push('海况 ' + Math.round(sea) + '（' + seaName(sea) + '）');
    parts.push('能见度 ' + (vis / 1000).toFixed(1) + ' 公里');
    if (env.light === 'night' || env.light === 'dusk' || env.light === 'dawn') {
      parts.push('月相不定');
    }
    if ((env.rain || 0) > 0.15) parts.push('有雨');
    return parts.join('，');
  }

  N.Weather = {
    init: init,
    update: update,
    step: step,
    radarFactor: radarFactor,
    seaClutter: seaClutter,
    radioExtra: radioExtra,
    fireBeacon: fireBeacon,
    effectiveVisibility: effectiveVisibility,
    moonEff: moonEff,
    seaFromWind: seaFromWind,
    seaName: seaName,
    windName: windName,
    moonName: moonName,
    status: status,
    brief: brief,
    forecast: forecast,
    effects: effects,
    STEP: STEP
  };
})(globalThis.Naval = globalThis.Naval || {});
