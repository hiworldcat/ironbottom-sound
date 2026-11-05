/* =============================================================================
 *  data/ships.js —— 舰艇 / 火炮 / 鱼雷 / 装甲 数据表
 *
 *  数据尽量贴近 1942—1943 年所罗门海域的实际装备：
 *    · 美方：Mk 12 8"/55、Mk 16 6"/47、Mk 12 5"/38、Mk 15 鱼雷、SG 雷达
 *    · 日方：三年式 20cm/50、五十口径 14cm、五十口径 12.7cm、
 *            九三式氧气鱼雷（航迹几乎不可见）、九四式方位盘（优秀光学指挥仪）
 *
 *  所有距离单位为米，速度单位为节，装甲单位为毫米，重量为公斤。
 * ========================================================================== */
(function (N) {
  'use strict';

  /* ------------------------------------------------------------------ 火炮 */
  /**
   * pen / deckPen 为穿深表 [[距离m, 穿深mm], ...]
   * maxDescent：最大射程处的落角（度），用于判断命中舷侧还是甲板
   */
  N.Guns = {
    '8in55': {
      id: '8in55', name: '8"/55 Mk 12', caliber: 203, shellWeight: 152,
      mv: 853, maxRange: 27400, rof: 3.2, dispersion: 1.05,
      pen: [[0, 254], [5000, 193], [10000, 142], [15000, 104], [20000, 74], [25000, 50]],
      deckPen: [[0, 8], [5000, 16], [10000, 28], [15000, 45], [20000, 64], [25000, 85]],
      maxDescent: 42, shell: 'AP'
    },
    '6in47': {
      id: '6in47', name: '6"/47 Mk 16', caliber: 152, shellWeight: 59,
      mv: 812, maxRange: 23800, rof: 8.0, dispersion: 1.30,
      pen: [[0, 200], [5000, 143], [10000, 95], [15000, 58], [20000, 30]],
      deckPen: [[0, 6], [5000, 12], [10000, 22], [15000, 36], [20000, 52]],
      maxDescent: 38, shell: 'AP'
    },
    '5in38': {
      id: '5in38', name: '5"/38 Mk 12', caliber: 127, shellWeight: 25,
      mv: 792, maxRange: 16600, rof: 12.0, dispersion: 1.60,
      pen: [[0, 125], [5000, 76], [10000, 40], [15000, 21]],
      deckPen: [[0, 5], [5000, 10], [10000, 20], [15000, 31]],
      maxDescent: 35, shell: 'AP'
    },
    '20cm50': {
      id: '20cm50', name: '三年式 20cm/50', caliber: 200, shellWeight: 125.85,
      mv: 835, maxRange: 27400, rof: 2.8, dispersion: 1.10,
      pen: [[0, 250], [5000, 185], [10000, 135], [15000, 97], [20000, 68], [25000, 46]],
      deckPen: [[0, 8], [5000, 16], [10000, 29], [15000, 46], [20000, 66], [25000, 88]],
      maxDescent: 43, shell: 'AP'
    },
    '14cm50': {
      id: '14cm50', name: '五十口径 14cm', caliber: 140, shellWeight: 38,
      mv: 855, maxRange: 20000, rof: 5.5, dispersion: 1.40,
      pen: [[0, 150], [5000, 106], [10000, 68], [15000, 40]],
      deckPen: [[0, 5], [5000, 10], [10000, 19], [15000, 30]],
      maxDescent: 36, shell: 'AP'
    },
    '127mm50': {
      id: '127mm50', name: '五十口径 12.7cm', caliber: 127, shellWeight: 23,
      mv: 915, maxRange: 18400, rof: 6.0, dispersion: 1.70,
      pen: [[0, 110], [5000, 72], [10000, 38], [15000, 20]],
      deckPen: [[0, 4], [5000, 9], [10000, 18], [15000, 29]],
      maxDescent: 37, shell: 'AP'
    }
  };

  /* ------------------------------------------------------------------ 鱼雷 */
  /**
   * wake：航迹可见度 0—1。九三式氧气鱼雷几乎不产生气泡航迹（0.04），
   *       这是日方在夜战/昼战中最大的战术优势之一。
   * reliability：引信/定深可靠性（早期美军鱼雷较差）
   */
  N.Torpedoes = {
    'type93': {
      id: 'type93', name: '九三式氧气鱼雷', caliber: 610,
      warhead: 490, speed: 48, range: 20000,
      wake: 0.04, reliability: 0.85, hitRadius: 14
    },
    'mk15': {
      id: 'mk15', name: 'Mk 15 鱼雷', caliber: 533,
      warhead: 375, speed: 45, range: 6000,
      wake: 1.0, reliability: 0.72, hitRadius: 13
    }
  };

  /* ------------------------------------------------------------------ 舰级 */
  /**
   * mounts[].pos：沿舰体中心线的相对位置，-1 = 舰尾，+1 = 舰首
   * mounts[].arc：'fwd' 前向射界 / 'aft' 后向射界 / 'all' 全向
   * torps[].arc：固定为舷侧射界（必须把舷侧转向目标）
   */
  N.ShipClasses = {

    /* ============================ 美国海军 ============================ */

    'neworleans': {
      id: 'neworleans', name: '新奥尔良级', nameEn: 'New Orleans class',
      nation: 'US', type: 'CA', typeName: '重巡洋舰',
      displacement: 12700, length: 179.5, beam: 18.8, draft: 6.2,
      maxSpeed: 32.7, cruiseSpeed: 15, accel: 0.09, decel: 0.16,
      turnRate: 2.6, turnRateMin: 1.1,
      armor: { belt: 127, deck: 57, turret: 203, barbette: 152, ctic: 127 },
      hull: 110, floodCapacity: 100, damageControl: 1.0,
      mounts: [
        { label: 'A', pos: 0.70, count: 3, gun: '8in55', arc: 'fwd', armor: 203 },
        { label: 'B', pos: 0.46, count: 3, gun: '8in55', arc: 'fwd', armor: 203 },
        { label: 'X', pos: -0.62, count: 3, gun: '8in55', arc: 'aft', armor: 203 }
      ],
      torps: [
        { label: '1', pos: 0.10, tubes: 4, torp: 'mk15', reload: 240, arc: 'broadside' },
        { label: '2', pos: -0.18, tubes: 4, torp: 'mk15', reload: 240, arc: 'broadside' }
      ],
      radar: { name: 'SG 对海雷达', range: 26000, bearingErr: 2.5, rangeErr: 90 },
      fc: { name: 'Mk 3 火控雷达 + Mk 27 指挥仪', quality: 0.84, radarAssist: true },
      combatPower: 100
    },

    'brooklyn': {
      id: 'brooklyn', name: '布鲁克林级', nameEn: 'Brooklyn class',
      nation: 'US', type: 'CL', typeName: '轻巡洋舰',
      displacement: 10000, length: 185.4, beam: 18.8, draft: 6.0,
      maxSpeed: 33.5, cruiseSpeed: 15, accel: 0.10, decel: 0.18,
      turnRate: 2.8, turnRateMin: 1.2,
      armor: { belt: 127, deck: 51, turret: 165, barbette: 152, ctic: 152 },
      hull: 92, floodCapacity: 100, damageControl: 1.0,
      mounts: [
        { label: 'A', pos: 0.80, count: 3, gun: '6in47', arc: 'fwd', armor: 165 },
        { label: 'B', pos: 0.60, count: 3, gun: '6in47', arc: 'fwd', armor: 165 },
        { label: 'C', pos: 0.38, count: 3, gun: '6in47', arc: 'fwd', armor: 165 },
        { label: 'X', pos: -0.52, count: 3, gun: '6in47', arc: 'aft', armor: 165 },
        { label: 'Y', pos: -0.74, count: 3, gun: '6in47', arc: 'aft', armor: 165 }
      ],
      torps: [
        { label: '1', pos: 0.05, tubes: 5, torp: 'mk15', reload: 260, arc: 'broadside' },
        { label: '2', pos: -0.12, tubes: 5, torp: 'mk15', reload: 260, arc: 'broadside' }
      ],
      radar: { name: 'SG 对海雷达', range: 25000, bearingErr: 2.5, rangeErr: 90 },
      fc: { name: 'Mk 3 火控雷达 + Mk 34 指挥仪', quality: 0.80, radarAssist: true },
      combatPower: 68
    },

    'cleveland': {
      id: 'cleveland', name: '克利夫兰级', nameEn: 'Cleveland class',
      nation: 'US', type: 'CL', typeName: '轻巡洋舰',
      displacement: 11744, length: 185.4, beam: 18.8, draft: 6.0,
      maxSpeed: 32.5, cruiseSpeed: 15, accel: 0.10, decel: 0.18,
      turnRate: 2.8, turnRateMin: 1.2,
      armor: { belt: 127, deck: 51, turret: 165, barbette: 152, ctic: 127 },
      hull: 100, floodCapacity: 100, damageControl: 1.05,
      // 12 门 6 英寸：四座三联装，没有鱼雷发射管 —— 靠炮打，靠驱逐舰放雷
      mounts: [
        { label: 'A', pos: 0.78, count: 3, gun: '6in47', arc: 'fwd', armor: 165 },
        { label: 'B', pos: 0.58, count: 3, gun: '6in47', arc: 'fwd', armor: 165 },
        { label: 'X', pos: -0.54, count: 3, gun: '6in47', arc: 'aft', armor: 165 },
        { label: 'Y', pos: -0.74, count: 3, gun: '6in47', arc: 'aft', armor: 165 }
      ],
      torps: [],
      radar: { name: 'SG 对海雷达', range: 26000, bearingErr: 2.2, rangeErr: 85 },
      fc: { name: 'Mk 3 火控雷达 + Mk 34 指挥仪', quality: 0.82, radarAssist: true },
      combatPower: 72
    },

    'fletcher': {
      id: 'fletcher', name: '弗莱彻级', nameEn: 'Fletcher class',
      nation: 'US', type: 'DD', typeName: '驱逐舰',
      displacement: 2500, length: 114.8, beam: 12.0, draft: 4.0,
      maxSpeed: 36.5, cruiseSpeed: 15, accel: 0.16, decel: 0.30,
      turnRate: 4.2, turnRateMin: 1.8,
      armor: { belt: 19, deck: 13, turret: 13, barbette: 13, ctic: 13 },
      hull: 58, floodCapacity: 100, damageControl: 1.0,
      mounts: [
        { label: '1', pos: 0.80, count: 1, gun: '5in38', arc: 'fwd', armor: 13 },
        { label: '2', pos: 0.58, count: 1, gun: '5in38', arc: 'fwd', armor: 13 },
        { label: '3', pos: -0.40, count: 1, gun: '5in38', arc: 'aft', armor: 13 },
        { label: '4', pos: -0.62, count: 1, gun: '5in38', arc: 'aft', armor: 13 },
        { label: '5', pos: -0.82, count: 1, gun: '5in38', arc: 'aft', armor: 13 }
      ],
      torps: [
        { label: '1', pos: 0.05, tubes: 5, torp: 'mk15', reload: 220, arc: 'broadside' },
        { label: '2', pos: -0.15, tubes: 5, torp: 'mk15', reload: 220, arc: 'broadside' }
      ],
      radar: { name: 'SG 对海雷达', range: 22000, bearingErr: 3.0, rangeErr: 110 },
      fc: { name: 'Mk 4 火控雷达 + Mk 37 指挥仪', quality: 0.74, radarAssist: true },
      combatPower: 26
    },

    'atlanta': {
      id: 'atlanta', name: '亚特兰大级', nameEn: 'Atlanta class',
      nation: 'US', type: 'CL', typeName: '轻巡洋舰',
      displacement: 7400, length: 165.0, beam: 16.2, draft: 5.9,
      maxSpeed: 32.5, cruiseSpeed: 15, accel: 0.11, decel: 0.19,
      turnRate: 3.0, turnRateMin: 1.3,
      armor: { belt: 95, deck: 32, turret: 32, barbette: 32, ctic: 64 },
      hull: 78, floodCapacity: 100, damageControl: 1.0,
      mounts: [
        { label: 'A', pos: 0.82, count: 2, gun: '5in38', arc: 'fwd', armor: 32 },
        { label: 'B', pos: 0.66, count: 2, gun: '5in38', arc: 'fwd', armor: 32 },
        { label: 'C', pos: 0.50, count: 2, gun: '5in38', arc: 'fwd', armor: 32 },
        { label: 'X', pos: -0.52, count: 2, gun: '5in38', arc: 'aft', armor: 32 },
        { label: 'Y', pos: -0.68, count: 2, gun: '5in38', arc: 'aft', armor: 32 },
        { label: 'Z', pos: -0.84, count: 2, gun: '5in38', arc: 'aft', armor: 32 }
      ],
      torps: [
        { label: '1', pos: 0.06, tubes: 4, torp: 'mk15', reload: 240, arc: 'broadside' },
        { label: '2', pos: -0.12, tubes: 4, torp: 'mk15', reload: 240, arc: 'broadside' }
      ],
      radar: { name: 'SG 对海雷达', range: 24000, bearingErr: 2.8, rangeErr: 100 },
      fc: { name: 'Mk 4 火控雷达 + Mk 37 指挥仪', quality: 0.78, radarAssist: true },
      combatPower: 58
    },

    'transport': {
      id: 'transport', name: '运输船', nameEn: 'Transport',
      nation: 'US', type: 'AK', typeName: '运输船',
      displacement: 6800, length: 134.0, beam: 17.4, draft: 7.2,
      maxSpeed: 14.5, cruiseSpeed: 11.5, accel: 0.05, decel: 0.10,
      turnRate: 1.3, turnRateMin: 0.6,
      armor: { belt: 14, deck: 10, turret: 0, barbette: 0, ctic: 12 },
      hull: 92, floodCapacity: 150, damageControl: 0.8,
      mounts: [],
      torps: [],
      radar: null,
      fc: { name: '无火控', quality: 0.30, radarAssist: false },
      combatPower: 14
    },

    /* ============================ 日本帝国海军 ============================ */

    'fubuki': {
      id: 'fubuki', name: '吹雪级', nameEn: 'Fubuki class',
      nation: 'JP', type: 'DD', typeName: '驱逐舰',
      displacement: 1980, length: 118.5, beam: 10.4, draft: 3.8,
      maxSpeed: 35.0, cruiseSpeed: 15, accel: 0.16, decel: 0.30,
      turnRate: 4.4, turnRateMin: 1.8,
      armor: { belt: 12, deck: 8, turret: 3, barbette: 3, ctic: 12 },
      hull: 54, floodCapacity: 100, damageControl: 0.9,
      mounts: [
        { label: '1', pos: 0.78, count: 2, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '2', pos: 0.56, count: 2, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '3', pos: -0.68, count: 2, gun: '127mm50', arc: 'aft', armor: 3 }
      ],
      torps: [
        { label: '1', pos: 0.04, tubes: 3, torp: 'type93', reload: 240, arc: 'broadside' },
        { label: '2', pos: -0.14, tubes: 3, torp: 'type93', reload: 240, arc: 'broadside' },
        { label: '3', pos: -0.30, tubes: 3, torp: 'type93', reload: 240, arc: 'broadside' }
      ],
      radar: null,
      fc: { name: '九四式方位盘（光学）', quality: 0.76, radarAssist: false },
      combatPower: 25
    },

    'myoko': {
      id: 'myoko', name: '妙高级', nameEn: 'Myōkō class',
      nation: 'JP', type: 'CA', typeName: '重巡洋舰',
      displacement: 13500, length: 203.8, beam: 19.0, draft: 6.4,
      maxSpeed: 35.5, cruiseSpeed: 15, accel: 0.09, decel: 0.16,
      turnRate: 2.5, turnRateMin: 1.0,
      // 日舰重视水下防护与航速，甲板与炮塔装甲明显偏薄
      armor: { belt: 102, deck: 37, turret: 25, barbette: 75, ctic: 102 },
      hull: 108, floodCapacity: 100, damageControl: 0.9,
      mounts: [
        { label: '1', pos: 0.78, count: 2, gun: '20cm50', arc: 'fwd', armor: 25 },
        { label: '2', pos: 0.58, count: 2, gun: '20cm50', arc: 'fwd', armor: 25 },
        { label: '3', pos: 0.36, count: 2, gun: '20cm50', arc: 'fwd', armor: 25 },
        { label: '4', pos: -0.55, count: 2, gun: '20cm50', arc: 'aft', armor: 25 },
        { label: '5', pos: -0.76, count: 2, gun: '20cm50', arc: 'aft', armor: 25 }
      ],
      torps: [
        { label: '1', pos: 0.20, tubes: 3, torp: 'type93', reload: 300, arc: 'broadside' },
        { label: '2', pos: 0.07, tubes: 3, torp: 'type93', reload: 300, arc: 'broadside' },
        { label: '3', pos: -0.07, tubes: 3, torp: 'type93', reload: 300, arc: 'broadside' },
        { label: '4', pos: -0.20, tubes: 3, torp: 'type93', reload: 300, arc: 'broadside' }
      ],
      radar: null,   // 1942 年日方水面舰艇基本无雷达
      fc: { name: '九四式方位盘（光学）', quality: 0.88, radarAssist: false },
      combatPower: 100
    },

    'sendai': {
      id: 'sendai', name: '川内级', nameEn: 'Sendai class',
      nation: 'JP', type: 'CL', typeName: '轻巡洋舰',
      displacement: 5195, length: 163.0, beam: 14.2, draft: 4.9,
      maxSpeed: 35.3, cruiseSpeed: 15, accel: 0.13, decel: 0.22,
      turnRate: 3.4, turnRateMin: 1.4,
      armor: { belt: 64, deck: 29, turret: 20, barbette: 51, ctic: 51 },
      hull: 78, floodCapacity: 100, damageControl: 0.9,
      mounts: [
        { label: '1', pos: 0.80, count: 1, gun: '14cm50', arc: 'fwd', armor: 20 },
        { label: '2', pos: 0.34, count: 1, gun: '14cm50', arc: 'all', armor: 20 },
        { label: '3', pos: 0.18, count: 1, gun: '14cm50', arc: 'all', armor: 20 },
        { label: '4', pos: 0.02, count: 1, gun: '14cm50', arc: 'all', armor: 20 },
        { label: '5', pos: -0.22, count: 1, gun: '14cm50', arc: 'all', armor: 20 },
        { label: '6', pos: -0.55, count: 1, gun: '14cm50', arc: 'aft', armor: 20 },
        { label: '7', pos: -0.78, count: 1, gun: '14cm50', arc: 'aft', armor: 20 }
      ],
      torps: [
        { label: '1', pos: 0.00, tubes: 4, torp: 'type93', reload: 280, arc: 'broadside' },
        { label: '2', pos: -0.18, tubes: 4, torp: 'type93', reload: 280, arc: 'broadside' }
      ],
      radar: null,
      fc: { name: '九四式方位盘（光学）', quality: 0.80, radarAssist: false },
      combatPower: 52
    },

    'kagero': {
      id: 'kagero', name: '阳炎级', nameEn: 'Kagerō class',
      nation: 'JP', type: 'DD', typeName: '驱逐舰',
      displacement: 2490, length: 118.5, beam: 10.8, draft: 3.8,
      maxSpeed: 35.5, cruiseSpeed: 15, accel: 0.16, decel: 0.30,
      turnRate: 4.4, turnRateMin: 1.8,
      armor: { belt: 12, deck: 8, turret: 3, barbette: 3, ctic: 12 },
      hull: 56, floodCapacity: 100, damageControl: 0.9,
      mounts: [
        { label: '1', pos: 0.76, count: 2, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '2', pos: 0.50, count: 2, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '3', pos: -0.66, count: 2, gun: '127mm50', arc: 'aft', armor: 3 }
      ],
      torps: [
        { label: '1', pos: 0.06, tubes: 4, torp: 'type93', reload: 240, arc: 'broadside' },
        { label: '2', pos: -0.20, tubes: 4, torp: 'type93', reload: 240, arc: 'broadside' }
      ],
      radar: null,
      fc: { name: '九四式方位盘（光学）', quality: 0.75, radarAssist: false },
      combatPower: 27
    },

    'shiratsuyu': {
      id: 'shiratsuyu', name: '白露级', nameEn: 'Shiratsuyu class',
      nation: 'JP', type: 'DD', typeName: '驱逐舰',
      displacement: 1685, length: 110.0, beam: 9.9, draft: 3.5,
      maxSpeed: 34.0, cruiseSpeed: 15, accel: 0.17, decel: 0.32,
      turnRate: 4.6, turnRateMin: 1.9,
      armor: { belt: 12, deck: 8, turret: 3, barbette: 3, ctic: 12 },
      hull: 50, floodCapacity: 100, damageControl: 0.9,
      mounts: [
        { label: '1', pos: 0.80, count: 1, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '2', pos: 0.58, count: 1, gun: '127mm50', arc: 'fwd', armor: 3 },
        { label: '3', pos: -0.44, count: 1, gun: '127mm50', arc: 'aft', armor: 3 },
        { label: '4', pos: -0.64, count: 1, gun: '127mm50', arc: 'aft', armor: 3 },
        { label: '5', pos: -0.82, count: 1, gun: '127mm50', arc: 'aft', armor: 3 }
      ],
      torps: [
        { label: '1', pos: 0.04, tubes: 4, torp: 'type93', reload: 240, arc: 'broadside' },
        { label: '2', pos: -0.18, tubes: 4, torp: 'type93', reload: 240, arc: 'broadside' }
      ],
      radar: null,
      fc: { name: '九四式方位盘（光学）', quality: 0.74, radarAssist: false },
      combatPower: 22
    },

    'barge': {
      id: 'barge', name: '大发艇', nameEn: 'Daihatsu-class landing craft',
      nation: 'JP', type: 'AK', typeName: '登陆艇',
      displacement: 21, length: 14.9, beam: 3.7, draft: 0.8,
      maxSpeed: 8.0, cruiseSpeed: 7, accel: 0.10, decel: 0.20,
      turnRate: 6.0, turnRateMin: 3.0,
      armor: { belt: 0, deck: 0, turret: 0, barbette: 0, ctic: 0 },
      // 木壳小艇：一发 5 英寸炮弹就能打碎，浪头打过来都可能翻
      hull: 9, floodCapacity: 30, damageControl: 0.4,
      mounts: [],
      torps: [],
      radar: null,
      fc: { name: '无火控', quality: 0.20, radarAssist: false },
      combatPower: 2
    }
  };

  /* ------------------------------------------------------- 舰体结构分区 */
  /**
   * 一艘舰的“结构”不是一块铁，是几个各管一摊的部分。这里给出各部分
   * 占全舰结构强度的比例（和为 1）：
   *
   *   hull           舰体（水密结构、船壳）—— 就是 hull 那条血条
   *   superstructure 上层建筑（舰桥、桅杆、雷达天线基座、指挥仪）
   *   weapons        武器结构（炮塔、扬弹机、鱼雷发射管、火控指挥仪传动）
   *   comms          通信结构（无线电室、天线、敌我识别器）
   *   power          动力结构（锅炉、轮机、烟道、螺旋桨轴系）
   *
   * 后四项各有一条独立的血条，大小 = hull * (该区比例 / hull 比例)。
   * 打空了对应的能力就成比例地掉：武器结构没了炮就打不响，通信结构没了
   * 就只能靠旗语，上层建筑没了雷达和火控一起完蛋，动力结构没了就漂着。
   */
  N.ShipZones = {
    CA: { hull: 0.44, superstructure: 0.15, weapons: 0.19, comms: 0.06, power: 0.16 },
    CL: { hull: 0.43, superstructure: 0.15, weapons: 0.20, comms: 0.06, power: 0.16 },
    DD: { hull: 0.40, superstructure: 0.12, weapons: 0.24, comms: 0.05, power: 0.19 },
    AK: { hull: 0.55, superstructure: 0.12, weapons: 0.05, comms: 0.05, power: 0.23 }
  };

  /** 取某舰级的结构分区比例（舰级可用 cls.zones 覆盖） */
  N.zonesFor = function (cls) {
    if (cls && cls.zones) return cls.zones;
    return N.ShipZones[(cls && cls.type) || 'DD'] || N.ShipZones.DD;
  };

  /** 返回某舰级的最大火炮射程 */
  N.classGunRange = function (cls) {
    var best = 0;
    for (var i = 0; i < cls.mounts.length; i++) {
      var g = N.Guns[cls.mounts[i].gun];
      if (g && g.maxRange > best) best = g.maxRange;
    }
    return best;
  };

  /** 返回某舰级的主炮口径（mm） */
  N.classMainCaliber = function (cls) {
    var best = 0;
    for (var i = 0; i < cls.mounts.length; i++) {
      var g = N.Guns[cls.mounts[i].gun];
      if (g && g.caliber > best) best = g.caliber;
    }
    return best;
  };

  /** 返回某舰级可用的鱼雷型号 */
  N.classTorpedo = function (cls) {
    return cls.torps.length ? N.Torpedoes[cls.torps[0].torp] : null;
  };
})(globalThis.Naval = globalThis.Naval || {});
