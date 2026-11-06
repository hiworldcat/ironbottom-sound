/* =============================================================================
 *  data/scenarios.js —— 场景注册表与任务定义
 *
 *  设计说明
 *  ---------------------------------------------------------------------------
 *  一个场景 = 一份纯数据描述 + 若干可选钩子。战斗内核（world / sensors /
 *  combat / ai）完全不知道具体场景，只读取下面这些字段，因此新增任务
 *  只需要再写一份场景数据，不必改动仿真层。
 *
 *  ScenarioDef {
 *    id           唯一标识
 *    title        标题
 *    subtitle     副标题
 *    date         史实/虚构日期文本
 *    startTime    当日秒数（例如 08:20 -> 8*3600+20*60）
 *    timeOfDay    'day' | 'night' | 'dawn' | 'dusk'
 *    location     海域名
 *    available    是否已实现
 *    tags         标签，用于筛选
 *
 *    env          { visibility, windDir, windSpeed, seaState, weather, light, rain }
 *                 —— 环境直接决定探测距离与火控质量
 *
 *    playerSide   'US' | 'JP'
 *    forces       [{ side, class, name, hull, x, y, heading, speed, group, role,
 *                    destination, damage:{hull,flood,fire,power,steering},
 *                    aiRole, aiExitZone, aiControlled }]
 *                 x/y 为本地平面坐标（米，东为 +x，北为 +y）
 *                 role: 'flagship' | 'cruiser' | 'screen' | 'transport' | 'escortee'
 *                 aiRole: 'bombard' 时该舰会自动寻找岸上目标
 *
 *    objectives   [{ id, text, kind, check(world) -> {progress, done, note} }]
 *    victory      { timeLimit }   —— 具体胜负由 check(world) 决定
 *
 *    zones        [{ id, name, kind:'landing'|'exit'|'objective'|'patrol', x, y, r }]
 *    shoreTargets [{ id, name, kind, x, y, hp }]
 *    check        (world) -> { result:'win'|'loss'|'draw', reason } | null
 *    update       (world, dt) => void     每帧钩子（登陆区压制、增援等）
 *    onStart      (world) => void
 *    reinforcements [{ at, side, forces:[...] }]   预留
 *  }
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U;
  var V = N.V;
  var Geo = N.Geo;

  /* ------------------------------------------------------------- 地图基准 */
  /*
   * 战场覆盖所罗门群岛中部：布干维尔以南 → 圣克里斯托瓦尔西北。
   * 这样每一个战役都能放在它真正发生的那片水域里，而不是全挤在图拉吉门口。
   *
   *   x：东为 +，1 米 = 1 米；y：北为 +
   *   投影是等距圆柱（局部平面），在所罗门这种小范围内误差可以忽略
   */
  N.MAP = {
    refLon: 158.5,
    refLat: -8.3,
    // 北到新爱尔兰南端（圣乔治角），南到马基拉岛南岸，东到马基拉东端
    lonMin: 152.55, lonMax: 162.45,
    latMin: -11.05, latMax: -4.55,
    name: '所罗门群岛'
  };

  // 地图四角换算成本地米
  N.MAP.bounds = (function () {
    var a = N.Geo.lonLatToXY(N.MAP.lonMin, N.MAP.latMin, N.MAP.refLon, N.MAP.refLat);
    var b = N.Geo.lonLatToXY(N.MAP.lonMax, N.MAP.latMax, N.MAP.refLon, N.MAP.refLat);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  })();

  /** 经纬度 → 本地米坐标（写剧本时用，比记 30 万米的数字可靠） */
  function at(lon, lat) {
    return N.Geo.lonLatToXY(lon, lat, N.MAP.refLon, N.MAP.refLat);
  }
  N.MAP.at = at;
  function lx(lon, lat) { return Math.round(at(lon, lat).x); }
  function ly(lon, lat) { return Math.round(at(lon, lat).y); }
  N.MAP.lx = lx;
  N.MAP.ly = ly;

  /** 以经纬度为锚点、按纵队展开的一队舰 */
  function fleet(side, group, lon, lat, hdg, spd, list) {
    var p = at(lon, lat);
    return column(side, group, p.x, p.y, hdg, spd, list);
  }

  /**
   * 单舰：直接用经纬度、航向、航速摆位。
   * 史实剧本里每条船都有自己的位置和航向，用这个写比记几十万米的本地坐标可靠得多。
   */
  function vessel(side, group, cls, name, lon, lat, hdg, spd, role, hull, extra) {
    var p = at(lon, lat);
    var o = {
      side: side, group: group, class: cls, name: name, hull: hull || '',
      x: Math.round(p.x), y: Math.round(p.y),
      heading: hdg, speed: spd, role: role || 'screen'
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  /** 区域（登陆区 / 撤离区 / 目标区） */
  function zone(id, name, kind, lon, lat, r) {
    return { id: id, name: name, kind: kind, x: lx(lon, lat), y: ly(lon, lat), r: r };
  }

  /** 岸上目标 */
  function shore(id, name, kind, lon, lat, hp) {
    return { id: id, name: name, kind: kind, x: lx(lon, lat), y: ly(lon, lat), hp: hp };
  }

  /** 点是不是落在某个岛上 */
  function isLandAt(x, y) {
    for (var i = 0; i < N.ISLANDS.length; i++) {
      var is = N.ISLANDS[i];
      // 先用包围盒粗筛：59 个岛、两千多个顶点，不筛的话每帧要算几十万次
      var bb = is._bb;
      if (!bb) {
        var x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
        for (var j = 0; j < is.poly.length; j++) {
          var q = is.poly[j];
          if (q.x < x0) x0 = q.x;
          if (q.x > x1) x1 = q.x;
          if (q.y < y0) y0 = q.y;
          if (q.y > y1) y1 = q.y;
        }
        bb = is._bb = { x0: x0, y0: y0, x1: x1, y1: y1 };
      }
      if (x < bb.x0 || x > bb.x1 || y < bb.y0 || y > bb.y1) continue;
      if (N.Geo.pointInPolygon({ x: x, y: y }, is.poly)) return true;
    }
    return false;
  }
  /** 从 (x,y) 向外螺旋找最近的陆地（岸上目标必须钉在岸上） */
  function nearestLand(x, y, maxR) {
    maxR = maxR || 30000;
    if (isLandAt(x, y)) return { x: x, y: y, d: 0 };
    for (var r = 300; r <= maxR; r += 300) {
      var n = Math.max(12, Math.round(r / 80));
      for (var i = 0; i < n; i++) {
        var p = Geo.dest({ x: x, y: y }, i * 360 / n, r);
        if (isLandAt(p.x, p.y)) return { x: p.x, y: p.y, d: r };
      }
    }
    return null;
  }
  N.MAP.isLandAt = isLandAt;

  /* ------------------------------------------------------------ 岛屿轮廓 */
  /* 真实海岸线来自 js/data/coastline.js（Natural Earth 1:10m），
     这里只负责把经纬度换算成平面米坐标。没名字的岛只有轮廓，不标注。 */
  N.ISLANDS = (N.COASTLINE || []).map(function (c) {
    return {
      name: c.name || '',
      label: c.label || '',
      at: c.at || null,
      area: c.area || 0,
      lonLat: c.lonLat
    };
  });

  /* --------------------------------------------------------- 海峡 / 海湾标注 */
  /* 只画名字，不参与碰撞；缩放太小时自然被裁掉 */
  N.MAP.labels = [
    { text: '铁底湾', pos: null, lon: 159.98, lat: -9.18 },
    { text: '槽　海', pos: null, lon: 158.35, lat: -8.42 },
    { text: '库拉湾', pos: null, lon: 157.16, lat: -8.075 },
    { text: '布兰奇海峡', pos: null, lon: 157.32, lat: -8.50 },
    { text: '新乔治亚海峡', pos: null, lon: 158.42, lat: -8.16 },
    { text: '印迪斯彭萨布尔海峡', pos: null, lon: 156.72, lat: -7.50 },
    { text: '圣乔治海峡', pos: null, lon: 157.90, lat: -8.02 },
    { text: '韦拉拉韦拉海峡', pos: null, lon: 156.90, lat: -7.62 }
  ];

  // 预转换为本地米坐标
  N.ISLANDS.forEach(function (is) {
    is.poly = is.lonLat.map(function (p) {
      return N.Geo.lonLatToXY(p[0], p[1], N.MAP.refLon, N.MAP.refLat);
    });
    if (!is.label) is.label = is.name;
    // 岛名落点：真实海岸线是不规则形状，重心经常落在海里，所以单独给锚点
    is.labelPos = is.at
      ? N.Geo.lonLatToXY(is.at[0], is.at[1], N.MAP.refLon, N.MAP.refLat)
      : null;
  });
  N.MAP.labels.forEach(function (l) { l.pos = N.MAP.at(l.lon, l.lat); });

  /* 把本地坐标翻回经纬度，并说清楚“这是哪片海”。
   * 玩家在图上拖来拖去时，顶栏用这个显示视野中心。 */
  N.MAP.lonLatOf = function (x, y) {
    return { lon: x / 110155 + N.MAP.refLon, lat: y / 111320 + N.MAP.refLat };
  };
  N.MAP.describe = function (x, y) {
    var ll = N.MAP.lonLatOf(x, y);
    var best = null, bd = Infinity, i, k;
    function consider(name, px, py) {
      var d = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
      if (d < bd) { bd = d; best = name; }
    }
    for (i = 0; i < N.ISLANDS.length; i++) {
      var is = N.ISLANDS[i];
      var pts = is.poly || [];
      if (!pts.length) continue;
      var cx = 0, cy = 0;
      for (k = 0; k < pts.length; k++) { cx += pts[k].x; cy += pts[k].y; }
      consider(is.label || is.name, cx / pts.length, cy / pts.length);
    }
    for (i = 0; i < N.MAP.labels.length; i++) {
      var lb = N.MAP.labels[i];
      consider(lb.text || lb.name, lb.pos.x, lb.pos.y);
    }
    var area = (best && bd < 55000) ? best + '附近' : '开阔海域';
    var ns = Math.abs(ll.lat).toFixed(2) + '°' + (ll.lat < 0 ? 'S' : 'N');
    var ew = Math.abs(ll.lon).toFixed(2) + '°' + (ll.lon < 0 ? 'W' : 'E');
    return {
      lon: ll.lon, lat: ll.lat, area: area, near: best, nearDist: bd,
      text: ns + ' ' + ew + ' · ' + area
    };
  };

  /* ---------------------------------------------------------- 场景注册表 */
  var registry = {};
  var order = [];

  /* 任务类型：任务选择界面按这个分组 */
  var TYPES = [
    { id: 'surface', name: '水面炮战', desc: '两支水面编队正面交火' },
    { id: 'escort', name: '夜间护航', desc: '把运输队送过去，或者拦住别人的运输队' },
    { id: 'landing', name: '掩护登陆', desc: '守住登陆区，别让敌舰冲进来' },
    { id: 'bombard', name: '对岸炮击', desc: '压制滩头与机场' },
    { id: 'retreat', name: '掩护撤退', desc: '把受创的舰带出去' }
  ];

  var Scenarios = {
    /** 注册一个场景定义 */
    register: function (def) {
      if (!def || !def.id) throw new Error('场景必须有 id');
      if (!registry[def.id]) order.push(def.id);
      registry[def.id] = def;
      return def;
    },
    get: function (id) { return registry[id] || null; },
    all: function () {
      return order.map(function (id) { return registry[id]; });
    },
    available: function () {
      return Scenarios.all().filter(function (s) { return s.available; });
    },
    byTag: function (tag) {
      return Scenarios.all().filter(function (s) {
        return (s.tags || []).indexOf(tag) >= 0;
      });
    },
    types: function () { return TYPES; },
    typeName: function (id) {
      for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i].name;
      return '其他';
    },
    /** 按任务类型分组（只返回已实现的） */
    grouped: function () {
      var out = [];
      for (var i = 0; i < TYPES.length; i++) {
        var list = Scenarios.available().filter(function (s) { return s.type === TYPES[i].id; });
        if (list.length) out.push({ id: TYPES[i].id, name: TYPES[i].name, desc: TYPES[i].desc, list: list });
      }
      var other = Scenarios.available().filter(function (s) { return !s.type; });
      if (other.length) out.push({ id: 'other', name: '其他', desc: '', list: other });
      return out;
    },
    first: function () { return Scenarios.available()[0] || null; }
  };
  N.Scenarios = Scenarios;

  /* ------------------------------------------------------- 通用判定小工具 */
  function transports(world, side) {
    return world.ships.filter(function (s) {
      return s.side === side && s.role === 'transport';
    });
  }
  function aliveOf(list) {
    return list.filter(function (s) { return !s.sunk; });
  }
  function timeLimit(world) {
    return (world.scenario.victory && world.scenario.victory.timeLimit) || 2700;
  }

  /* 编队小工具：从领舰位置沿航向反向依次排开一条纵队
     list 每项：{ c:舰级, n:舰名, hull, role, gap:距领舰距离, off:横向偏移(+右舷), spd, extra } */
  function column(side, group, leadX, leadY, hdg, spd, list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var gap = d.gap != null ? d.gap : i * 900;
      var p = Geo.dest({ x: leadX, y: leadY }, U.norm360(hdg + 180), gap);
      if (d.off) {
        p = Geo.dest(p, U.norm360(hdg + (d.off > 0 ? 90 : -90)), Math.abs(d.off));
      }
      var o = {
        side: side, group: group, class: d.c, name: d.n, hull: d.hull || '',
        x: Math.round(p.x), y: Math.round(p.y),
        heading: hdg, speed: d.spd || spd, role: d.role || 'screen'
      };
      if (d.extra) for (var k in d.extra) o[k] = d.extra[k];
      out.push(o);
    }
    return out;
  }

  /** 汇入 forces 数组的小工具（单舰） */
  function one(side, group, c, n, hull, x, y, hdg, spd, role, extra) {
    var o = {
      side: side, group: group, class: c, name: n, hull: hull || '',
      x: x, y: y, heading: hdg, speed: spd, role: role || 'screen'
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  /** 常用目标判定 */
  function objSink(world, side, n) {
    var list = world.ships.filter(function (s) { return s.side === side; });
    var sunk = list.filter(function (s) { return s.sunk; }).length;
    return { progress: U.clamp01(sunk / n), done: sunk >= n, note: sunk + '/' + n };
  }

  /* ==========================================================================
   *  场景 1：白昼水面炮战
   * ========================================================================== */
  Scenarios.register({
    id: 'day_surface_action',
    type: 'surface',
    title: '铁底湾 · 白昼水面炮战',
    subtitle: 'TF 64.2 对 日本海军第二水雷战队',
    date: '1942 年 11 月 15 日',
    startTime: 8 * 3600 + 20 * 60,
    timeOfDay: 'day',
    location: '所罗门群岛 · 萨沃岛以东海域',
    available: true,
    tags: ['炮战', '昼间', '主力对决'],

    env: {
      visibility: 22000,
      windDir: 120,
      windSpeed: 12,
      seaState: 2,
      weather: '晴，少云',
      light: 'day',
      sunAzimuth: 105,
      rain: 0
    },

    playerSide: 'US',

    brief: [
      '08:20，你的编队正以 18 节向西北航行，位于萨沃岛以东约 12 海里。',
      '夜间的炮战已经结束，天亮后双方都在重新集结。侦察机报告：一支日本水面部队正从西北方向南下，可能包含重巡洋舰。',
      '你的任务是拦住它。',
      '',
      '· 敌方兵力、编成、位置均不确切，情报可能已经过时。',
      '· 你只能看到雷达和瞭望哨报告的目标航迹，看不到敌舰的真实状态。',
      '· 日方装备九三式氧气鱼雷：射程极远，且几乎不产生可见航迹。'
    ],

    intel: '无线电测向：西北方向有日军水面舰艇通讯活动。侦察机 07:40 报告“两艘重巡、数艘驱逐”，位置与航向未经证实。',

    objectives: [
      {
        id: 'destroy_enemy',
        text: '击沉或瘫痪敌方主力（敌方战力降至 40% 以下）',
        kind: 'primary',
        check: function (world) {
          var e = world.powerRatio('JP');
          return { progress: U.clamp01((1 - e) / 0.60), done: e <= 0.40 };
        }
      },
      {
        id: 'preserve_force',
        text: '保持己方编队战力不低于 40%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.40), done: o >= 0.40 };
        }
      },
      {
        id: 'sink_cruiser',
        text: '（可选）击沉一艘日本重巡洋舰',
        kind: 'secondary',
        check: function (world) {
          var list = world.ships.filter(function (s) {
            return s.side === 'JP' && s.cls.type === 'CA';
          });
          var sunk = list.filter(function (s) { return s.sunk; }).length;
          return { progress: sunk > 0 ? 1 : 0, done: sunk > 0 };
        }
      }
    ],

    victory: {
      timeLimit: 2700          // 45 分钟
    },

    search: {
      US: at(159.78, -9.18),
      JP: at(160.08, -9.18)
    },

    zones: [
      zone('patrol', '交战海域', 'patrol', 159.93, -9.18, 9000)
    ],

    forces: [
      vessel('US', 'TF 64.2', 'neworleans', '旧金山', 159.78, -9.18, 90, 20, 'flagship', 'CA-38'),
      vessel('US', 'TF 64.2', 'neworleans', '波特兰', 159.776, -9.177, 90, 20, 'cruiser', 'CA-33'),
      vessel('US', 'TF 64.2', 'brooklyn', '海伦娜', 159.772, -9.183, 90, 20, 'cruiser', 'CL-50'),
      vessel('US', 'TF 64.2', 'fletcher', '弗莱彻', 159.79, -9.168, 90, 20, 'screen', 'DD-445'),
      vessel('US', 'TF 64.2', 'fletcher', '奥班农', 159.794, -9.192, 90, 20, 'screen', 'DD-450'),
      vessel('US', 'TF 64.2', 'fletcher', '尼古拉斯', 159.786, -9.164, 90, 20, 'screen', 'DD-449'),
      vessel('JP', '第二水雷战队', 'myoko', '妙高', 160.08, -9.18, 270, 24, 'flagship', ''),
      vessel('JP', '第二水雷战队', 'myoko', '羽黑', 160.084, -9.177, 270, 24, 'cruiser', ''),
      vessel('JP', '第二水雷战队', 'sendai', '长良', 160.088, -9.183, 270, 24, 'cruiser', ''),
      vessel('JP', '第二水雷战队', 'kagero', '敷波', 160.07, -9.168, 270, 24, 'screen', ''),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '时雨', 160.066, -9.192, 270, 24, 'screen', ''),
    ]
  });

  /* ==========================================================================
   *  场景 2：夜间护航 —— 把运输船队带出铁底湾
   * ========================================================================== */
  Scenarios.register({
    id: 'night_escort',
    type: 'escort',
    title: '铁底湾 · 第一次瓜岛夜战',
    subtitle: '卡拉汉的巡洋舰队在黑暗里撞上阿部弘毅的炮击编队',
    date: '1942 年 11 月 13 日 01:50',
    startTime: 1 * 3600 + 50 * 60,
    timeOfDay: 'night',
    location: '铁底湾 · 萨沃岛以东',
    available: true,
    tags: ['夜战', '护航'],

    env: {
      visibility: 3600,
      windDir: 100, windSpeed: 8, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '01:50，铁底湾。阿部弘毅的炮击编队来了：两艘战列舰、一艘轻巡、五艘驱逐舰，任务是压制亨德森机场。',
      '你手里是卡拉汉的 TF 67.4：五艘巡洋舰、四艘驱逐舰。你的船比他多，但最大的炮只有 8 英寸。',
      '拦住它。哪怕只是打乱它的炮击阵位，天亮后的机场就还在。',
      '',
      '· 本作没有战列舰，比叡、雾岛以重巡的数据代替 —— 但装甲和炮口数量按战列舰算过头了，别硬顶。',
      '· 夜战是日方的强项：九三式鱼雷在这种距离上几乎无法规避。',
      '· 雷达测距准、测向差，而且无法分辨舰种；瞭望哨能看清是什么船，但看不远。'
    ],

    intel: '无线电情报：日方炮击编队已进入“槽海”南口，编成含战列舰。预计午夜后突入铁底湾。',

    objectives: [
      {
        id: 'escort_through',
        text: '至少 1 艘运输船抵达撤离区',
        kind: 'primary',
        check: function (world) {
          var tr = transports(world, 'US');
          var arrived = aliveOf(tr).filter(function (s) { return world.shipInZone(s, 'exit'); }).length;
          return { progress: tr.length ? arrived / tr.length : 0, done: arrived >= 1, note: arrived + '/' + tr.length };
        }
      },
      {
        id: 'keep_transports',
        text: '保住运输船队',
        kind: 'primary',
        check: function (world) {
          var tr = transports(world, 'US');
          var alive = aliveOf(tr).length;
          return { progress: tr.length ? alive / tr.length : 0, done: alive === tr.length, note: alive + '/' + tr.length };
        }
      },
      {
        id: 'sink_cl',
        text: '（可选）击沉日方轻巡洋舰',
        kind: 'secondary',
        check: function (world) {
          var list = world.ships.filter(function (s) { return s.side === 'JP' && s.cls.type === 'CL'; });
          var sunk = list.filter(function (s) { return s.sunk; }).length;
          return { progress: sunk > 0 ? 1 : 0, done: sunk > 0 };
        }
      }
    ],

    victory: { timeLimit: 1800 },

    zones: [
      zone('landing', '伦加锚地', 'landing', 160.01, -9.36, 4200)
    ],

    search: {
      US: at(159.885, -9.02),
      JP: at(159.965, -9.1)
    },

    forces: [
      vessel('US', '登陆船队', 'transport', '麦考利', 160.0, -9.345, 45, 8, 'transport', 'AP-10', { destination: at(160.020, -9.355) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 160.015, -9.35, 45, 8, 'transport', 'AP-11', { destination: at(160.035, -9.360) }),
      vessel('US', 'TF 67.4', 'neworleans', '旧金山', 159.965, -9.1, 320, 18, 'flagship', 'CA-38'),
      vessel('US', 'TF 67.4', 'neworleans', '波特兰', 159.968, -9.103, 320, 18, 'cruiser', 'CA-33'),
      vessel('US', 'TF 67.4', 'atlanta', '亚特兰大', 159.962, -9.097, 320, 18, 'cruiser', 'CL-51'),
      vessel('US', 'TF 67.4', 'atlanta', '朱诺', 159.959, -9.094, 320, 18, 'cruiser', 'CL-52'),
      vessel('US', 'TF 67.4', 'brooklyn', '海伦娜', 159.956, -9.091, 320, 18, 'cruiser', 'CL-50'),
      vessel('US', 'TF 67.4', 'fletcher', '库欣', 159.972, -9.108, 320, 18, 'screen', 'DD-376'),
      vessel('US', 'TF 67.4', 'fletcher', '拉菲', 159.975, -9.111, 320, 18, 'screen', 'DD-459'),
      vessel('US', 'TF 67.4', 'fletcher', '奥班农', 159.969, -9.115, 320, 18, 'screen', 'DD-450'),
      vessel('US', 'TF 67.4', 'fletcher', '斯特雷特', 159.966, -9.118, 320, 18, 'screen', 'DD-407'),
      vessel('JP', '增援部队', 'myoko', '比叡', 159.885, -9.02, 140, 20, 'flagship', 'BB'),
      vessel('JP', '增援部队', 'myoko', '雾岛', 159.888, -9.017, 140, 20, 'cruiser', 'BB'),
      vessel('JP', '增援部队', 'sendai', '长良', 159.882, -9.014, 140, 20, 'cruiser', ''),
      vessel('JP', '增援部队', 'kagero', '晓', 159.892, -9.024, 140, 20, 'screen', ''),
      vessel('JP', '增援部队', 'kagero', '雷', 159.895, -9.027, 140, 20, 'screen', ''),
      vessel('JP', '增援部队', 'shiratsuyu', '夕立', 159.878, -9.01, 140, 20, 'screen', ''),
      vessel('JP', '增援部队', 'shiratsuyu', '春雨', 159.875, -9.007, 140, 20, 'screen', ''),
    ],

    check: function (world) {
      var tr = transports(world, 'US');
      var alive = aliveOf(tr);
      var arrived = alive.filter(function (s) { return world.shipInZone(s, 'exit'); });

      if (alive.length === 0) {
        return { result: 'loss', reason: '运输船队全灭。滩头的陆战队失去了这批补给。' };
      }
      if (arrived.length >= 1) {
        return { result: 'win', reason: '运输船已进入撤离区，护航任务达成。' };
      }
      if (world.time >= timeLimit(world)) {
        return { result: 'draw', reason: '时限已到，运输船队仍未通过海峡，但船还在。' };
      }
      if (world.allSunk('US')) {
        return { result: 'loss', reason: '护航编队全灭。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 3：掩护登陆 —— 守住图拉吉登陆区
   * ========================================================================== */
  Scenarios.register({
    id: 'cover_landing',
    type: 'landing',
    title: '图拉吉 · 掩护登陆',
    subtitle: '阻止日方水面舰艇突入登陆区',
    date: '1942 年 8 月 7 日 06:40',
    startTime: 6 * 3600 + 40 * 60,
    timeOfDay: 'dawn',
    location: '图拉吉岛 · 佛罗里达群岛',
    available: true,
    tags: ['登陆', '拂晓'],

    env: {
      visibility: 12000,
      windDir: 140, windSpeed: 10, seaState: 2,
      weather: '晨雾', light: 'dawn', sunAzimuth: 95, rain: 0
    },

    playerSide: 'US',

    brief: [
      '06:40，晨雾把能见度压到 6 海里。登陆部队正在图拉吉滩头展开，运输船正往锚地开，准备卸货。',
      '侦察报告：一支日本重巡部队正从西北方沿“槽海”南下，企图冲进登陆区炮击运输船。',
      '它们不需要打赢你 —— 只要冲进登陆区打上几分钟，滩头就会变成一片火海。',
      '',
      '· 登陆区（虚线圆）是你的底线：敌舰在区内每多待一秒，运输船就多挨一发炮弹。',
      '· 拂晓的薄雾会降低识别能力，你可能看不清来的是什么船。'
    ],

    intel: '海岸监视哨报告：西北方向出现舰影，至少两艘重巡，航向东南，速度约 24 节。',

    objectives: [
      {
        id: 'hold_zone',
        text: '不让敌舰突入登陆区（累计 90 秒即失败）',
        kind: 'primary',
        check: function (world) {
          var t = world._landingTime || 0;
          return { progress: U.clamp01(1 - t / 90), done: false, note: Math.round(t) + ' 秒' };
        }
      },
      {
        id: 'keep_transports',
        text: '保住登陆运输船',
        kind: 'primary',
        check: function (world) {
          var tr = transports(world, 'US');
          var alive = aliveOf(tr).length;
          return { progress: tr.length ? alive / tr.length : 0, done: alive === tr.length, note: alive + '/' + tr.length };
        }
      },
      {
        id: 'drive_off',
        text: '击退日方炮击编队（战力降至 40% 以下）',
        kind: 'primary',
        check: function (world) {
          var e = world.powerRatio('JP');
          return { progress: U.clamp01((1 - e) / 0.60), done: e <= 0.40 };
        }
      }
    ],

    victory: { timeLimit: 2700 },

    zones: [
      zone('landing', '图拉吉登陆区', 'landing', 160.090, -9.120, 4500)
    ],

    search: {
      US: at(159.94, -9.03),
      JP: at(160.085, -9.17)
    },

    forces: [
      vessel('US', '登陆船队', 'transport', '麦考利', 160.085, -9.17, 45, 3, 'transport', 'AP-10', { destination: at(160.111, -9.145) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 160.1, -9.175, 45, 3, 'transport', 'AP-11', { destination: at(160.126, -9.150) }),
      vessel('US', 'TF 62.2', 'brooklyn', '海伦娜', 160.035, -9.15, 315, 18, 'flagship', 'CL-50'),
      vessel('US', 'TF 62.2', 'brooklyn', '圣路易斯', 160.032, -9.153, 315, 18, 'cruiser', 'CL-49'),
      vessel('US', 'TF 62.2', 'neworleans', '芝加哥', 160.029, -9.156, 315, 18, 'cruiser', 'CA-29'),
      vessel('US', 'TF 62.2', 'fletcher', '帕特森', 160.04, -9.144, 315, 18, 'screen', 'DD-392'),
      vessel('US', 'TF 62.2', 'fletcher', '巴格利', 160.043, -9.141, 315, 18, 'screen', 'DD-386'),
      vessel('JP', '第八舰队', 'myoko', '鸟海', 159.94, -9.03, 135, 24, 'flagship', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'myoko', '青叶', 159.937, -9.033, 135, 24, 'cruiser', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'myoko', '古鹰', 159.934, -9.036, 135, 24, 'cruiser', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'kagero', '夕凪', 159.945, -9.024, 135, 24, 'screen', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'kagero', '岚', 159.948, -9.021, 135, 24, 'screen', '', { aiRole: 'raid' }),
    ],

    update: function (world, dt) {
      var zone = world.zoneById('landing');
      if (!zone) return;
      var intruders = world.aliveShips('JP').filter(function (s) {
        return world.inZone(s.pos, zone);
      });
      if (intruders.length === 0) return;

      world._landingTime = (world._landingTime || 0) + dt;

      // 敌舰在区内：运输船持续挨炮
      var tr = aliveOf(transports(world, 'US'));
      if (tr.length && world.rng.chance(0.9 * dt * intruders.length)) {
        var t = world.rng.pick(tr);
        t.applyDamage({ hull: 1.4, flood: 0.9, floodRate: 0.004, fire: 1.8 }, world);
        if (world.time - (world._lastLandingLog || -99) > 12) {
          world._lastLandingLog = world.time;
          world.log('US', '⚠ 登陆区遭到炮击：' + t.name + ' 中弹起火', 'critical');
        }
      }
    },

    check: function (world) {
      if ((world._landingTime || 0) >= 90) {
        return { result: 'loss', reason: '日舰突入登陆区并持续炮击，滩头被压制。' };
      }
      if (world.allSunk('JP')) return { result: 'win', reason: '日方炮击编队全灭，登陆区安全。' };
      if (world.powerRatio('JP') <= 0.40) return { result: 'win', reason: '日方编队失去战斗力，被迫撤退。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '登陆船队与掩护编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if (aliveOf(transports(world, 'US')).length > 0) {
          return { result: 'win', reason: '登陆作业完成，运输船仍在。' };
        }
        return { result: 'draw', reason: '时限已到，登陆区守住了，但运输船损失惨重。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 4：炮击登陆部队 —— 你是日方
   * ========================================================================== */
  Scenarios.register({
    id: 'shore_bombardment',
    type: 'bombard',
    title: '瓜岛 · 炮击登陆区',
    subtitle: '以重巡压制美军滩头阵地',
    date: '1942 年 10 月 13 日 02:20',
    startTime: 2 * 3600 + 20 * 60,
    timeOfDay: 'night',
    location: '瓜达尔卡纳尔岛 · 北岸',
    available: true,
    tags: ['岸轰', '夜战'],

    env: {
      visibility: 5000,
      windDir: 200, windSpeed: 6, seaState: 1,
      weather: '阴', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'JP',

    brief: [
      '02:20，你的舰队从西北方接近瓜达尔卡纳尔岛北岸。岸上是亨德森机场和美军的登陆补给区。',
      '任务很简单：把它们炸掉。',
      '',
      '· 在左键点选舰艇后，点击岸上目标即可下达炮击命令；舰艇会自动进入射程并对岸射击。',
      '· 美军水面舰艇通常会在半小时内赶到 —— 在它们出现之前尽可能多地摧毁目标。',
      '· 岸轰的命中率不高，但岸上目标不会还击。'
    ],

    intel: '侦察机报告：瓜岛北岸有大型机场与补给堆积区，防空火力不强，但美军水面舰艇在东南方向活动。',

    objectives: [
      {
        id: 'destroy_targets',
        text: '摧毁至少 2 处岸上目标',
        kind: 'primary',
        check: function (world) {
          var total = world.shoreTargets.length;
          var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
          return { progress: total ? dead / 2 : 0, done: dead >= 2, note: dead + '/' + total };
        }
      },
      {
        id: 'survive',
        text: '保持编队战力不低于 40%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio(world.playerSide);
          return { progress: U.clamp01(o / 0.40), done: o >= 0.40 };
        }
      }
    ],

    victory: { timeLimit: 2100 },

    zones: [
      zone('bombard_area', '炮击区', 'objective', 160.05, -9.39, 6000)
    ],

    search: {
      US: at(160.1, -9.22),
      JP: at(159.88, -9.2)
    },

    shoreTargets: [
      shore('airfield', '亨德森机场', 'airfield', 160.05, -9.46, 600),
      shore('supply', '补给堆积区', 'supply', 160.08, -9.47, 400),
      shore('beachhead', '滩头阵地', 'troops', 160.01, -9.45, 400)
    ],

    forces: [
      vessel('JP', '第八舰队', 'myoko', '妙高', 159.88, -9.2, 90, 20, 'flagship', '', { aiRole: 'bombard', autoBombard: true }),
      vessel('JP', '第八舰队', 'myoko', '羽黑', 159.884, -9.197, 90, 20, 'cruiser', '', { aiRole: 'bombard', autoBombard: true }),
      vessel('JP', '第八舰队', 'kagero', '雪风', 159.874, -9.206, 90, 20, 'screen', ''),
      vessel('JP', '第八舰队', 'kagero', '浜风', 159.878, -9.209, 90, 20, 'screen', ''),
      vessel('US', 'TF 64.2', 'brooklyn', '海伦娜', 160.1, -9.22, 270, 24, 'flagship', 'CL-50'),
      vessel('US', 'TF 64.2', 'fletcher', '弗莱彻', 160.104, -9.217, 270, 24, 'screen', 'DD-445'),
      vessel('US', 'TF 64.2', 'fletcher', '奥班农', 160.108, -9.214, 270, 24, 'screen', 'DD-450'),
      vessel('US', 'TF 64.2', 'fletcher', '尼古拉斯', 160.096, -9.223, 270, 24, 'screen', 'DD-449'),
    ],

    onStart: function (world) {
      // 开场就把重巡指向机场，玩家也可以随时改派
      world.ships.forEach(function (s) {
        if (s.side === 'JP' && s.cls.type === 'CA' && world.shoreTargets.length) {
          s.bombardTargetId = world.shoreTargets[0].id;
        }
      });
      world.log('JP', '岸轰目标已指定：' + world.shoreTargets[0].name, 'info');
    },

    check: function (world) {
      var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
      if (dead >= 2) return { result: 'win', reason: '岸上目标被摧毁，压制任务达成。' };
      if (world.allSunk('JP')) return { result: 'loss', reason: '炮击编队全灭。' };
      if (world.powerRatio('JP') <= 0.40) return { result: 'loss', reason: '编队战力不足，被迫撤离。' };
      if (world.time >= timeLimit(world)) {
        if (dead >= 1) return { result: 'draw', reason: '只摧毁了 ' + dead + ' 处目标，天亮前撤离。' };
        return { result: 'loss', reason: '未能对岸上目标造成有效破坏。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 5：掩护撤退 —— 把受创的巡洋舰带回去
   * ========================================================================== */
  Scenarios.register({
    id: 'covering_retreat',
    type: 'retreat',
    title: '铁底湾 · 掩护撤退',
    subtitle: '把受创的巡洋舰带出追击',
    date: '1942 年 11 月 30 日 23:40',
    startTime: 23 * 3600 + 40 * 60,
    timeOfDay: 'night',
    location: '铁底湾 · 萨沃岛以东',
    available: true,
    tags: ['夜战', '撤退'],

    env: {
      visibility: 6000,
      windDir: 90, windSpeed: 10, seaState: 3,
      weather: '阴，有雨', light: 'night', sunAzimuth: 0, rain: 0.35
    },

    playerSide: 'US',

    brief: [
      '23:40。明尼阿波利斯号在夜战中被两条九三式鱼雷命中，舰艏几乎被削掉，现在只能跑 18 节。',
      '日方仍在追击。你的任务是把它带到东北方的撤离区，而不是赢下这场战斗。',
      '',
      '· 明尼阿波利斯不会听你的指挥 —— 它只会一路向撤离区开。',
      '· 用驱逐舰挡住追击者，必要时施放烟幕。',
      '· 你的舰艇战力不如对方，正面硬拼会输。'
    ],

    intel: '追击兵力：两艘妙高级重巡与数艘驱逐舰，航速明显快于受创的巡洋舰。',

    objectives: [
      {
        id: 'get_home',
        text: '明尼阿波利斯抵达撤离区',
        kind: 'primary',
        check: function (world) {
          var e = world.ships.filter(function (s) { return s.role === 'escortee'; })[0];
          if (!e) return { progress: 0, done: false };
          if (e.sunk) return { progress: 0, done: false };
          var z = world.zoneById('exit');
          var d = z ? V.dist(e.pos, z.pos) : 99999;
          var total = 22000;
          return {
            progress: U.clamp01(1 - d / total),
            done: world.shipInZone(e, 'exit'),
            note: U.fmtRange(d)
          };
        }
      },
      {
        id: 'keep_escort',
        text: '保住至少 2 艘护航舰',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) {
            return s.side === 'US' && s.role !== 'escortee';
          });
          var alive = aliveOf(list).length;
          return { progress: list.length ? U.clamp01(alive / 2) : 0, done: alive >= 2, note: alive + '/' + list.length };
        }
      }
    ],

    victory: { timeLimit: 3000 },

    zones: [
      zone('exit', '撤离区', 'exit', 160.1, -9.22, 4500)
    ],

    search: {
      US: at(159.76, -9.12),
      JP: at(159.9, -9.2)
    },

    forces: [
      vessel('US', 'TF 67.2', 'neworleans', '明尼阿波利斯', 159.9, -9.2, 90, 15, 'escortee', 'CA-36', { aiExitZone: 'exit', damage: { hull: 0.45, flood: 15, power: 15, fire: 0 } }),
      vessel('US', 'TF 67.2', 'brooklyn', '海伦娜', 159.896, -9.204, 90, 18, 'flagship', 'CL-50'),
      vessel('US', 'TF 67.2', 'fletcher', '弗莱彻', 159.905, -9.195, 90, 18, 'screen', 'DD-445'),
      vessel('US', 'TF 67.2', 'fletcher', '奥班农', 159.909, -9.192, 90, 18, 'screen', 'DD-450'),
      vessel('US', 'TF 67.2', 'fletcher', '尼古拉斯', 159.913, -9.189, 90, 18, 'screen', 'DD-449'),
      vessel('JP', '第二水雷战队', 'myoko', '妙高', 159.76, -9.12, 110, 28, 'flagship', '', { pursue: true }),
      vessel('JP', '第二水雷战队', 'myoko', '羽黑', 159.757, -9.123, 110, 28, 'cruiser', '', { pursue: true }),
      vessel('JP', '第二水雷战队', 'kagero', '雪风', 159.766, -9.114, 110, 28, 'screen', '', { pursue: true }),
      vessel('JP', '第二水雷战队', 'kagero', '浜风', 159.769, -9.111, 110, 28, 'screen', '', { pursue: true }),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '时雨', 159.772, -9.108, 110, 28, 'screen', '', { pursue: true }),
    ],

    check: function (world) {
      var e = world.ships.filter(function (s) { return s.role === 'escortee'; })[0];
      if (!e) return { result: 'draw', reason: '没有需要掩护的舰艇。' };
      if (e.sunk) return { result: 'loss', reason: '明尼阿波利斯号沉没。' };
      if (world.shipInZone(e, 'exit')) {
        return { result: 'win', reason: '明尼阿波利斯号进入撤离区，脱离接触。' };
      }
      if (world.allSunk('US')) return { result: 'loss', reason: '掩护编队全灭。' };
      if (world.time >= timeLimit(world)) {
        return { result: 'loss', reason: '时限已到，受创的巡洋舰仍未能脱离。' };
      }
      return null;
    }
  });


  /* ==========================================================================
   *  场景 6：埃斯佩兰斯角海战 —— 1942-10-11 夜，美军第一次靠雷达抢到 T 字
   * ========================================================================== */
  Scenarios.register({
    id: 'cape_esperance',
    type: 'surface',
    title: '埃斯佩兰斯角 · 夜战',
    subtitle: '美军第一次靠雷达横切日方纵队',
    date: '1942 年 10 月 11 日 23:25',
    startTime: 23 * 3600 + 25 * 60,
    timeOfDay: 'night',
    location: '瓜达尔卡纳尔岛西北 · 埃斯佩兰斯角',
    available: true,
    tags: ['夜战', '雷达', 'T 字横切'],

    env: {
      visibility: 4800,
      windDir: 110, windSpeed: 9, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '23:25，埃斯佩兰斯角以西。你的四艘巡洋舰排成纵队北上，SG 雷达在 12 海里外抓到一片回波。',
      '对方是五藤存知少将的第六战队：三艘重巡、一艘驱逐舰，正沿着槽海南下，准备炮击亨德森机场。',
      '你在他前面横过去。这是整场战争里美军第一次在夜战中抢先开火。',
      '',
      '· 雷达测距很准，测向很差 —— 你大概知道他在哪，但不知道他多宽。',
      '· 横切的一瞬间把全部炮门对准敌人，代价是你自己的队形会很薄。',
      '· 日军有九三式鱼雷。他们发现你之前，你只有几分钟。'
    ],

    intel: '无线电测向：西北方有日方水面编队南下，预计凌晨前后通过埃斯佩兰斯角。编成疑为三艘重巡、两艘驱逐。',

    objectives: [
      {
        id: 'sink_two',
        text: '击沉至少 2 艘日方舰艇',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 2); }
      },
      {
        id: 'preserve',
        text: '己方编队战力不低于 50%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.50), done: o >= 0.50 };
        }
      },
      {
        id: 'sink_flag',
        text: '（可选）击沉敌方旗舰',
        kind: 'secondary',
        check: function (world) {
          var f = world.ships.filter(function (s) {
            return s.side === 'JP' && s.role === 'flagship';
          })[0];
          return { progress: f && f.sunk ? 1 : 0, done: !!(f && f.sunk) };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    search: {
      US: at(159.47, -9.235),
      JP: at(159.76, -9.215)
    },

    zones: [],

    forces: [
      vessel('US', 'TF 64.2', 'neworleans', '旧金山', 159.47, -9.235, 90, 20, 'flagship', 'CA-38'),
      vessel('US', 'TF 64.2', 'neworleans', '盐湖城', 159.467, -9.238, 90, 20, 'cruiser', 'CA-25'),
      vessel('US', 'TF 64.2', 'brooklyn', '海伦娜', 159.464, -9.241, 90, 20, 'cruiser', 'CL-50'),
      vessel('US', 'TF 64.2', 'brooklyn', '博伊西', 159.461, -9.244, 90, 20, 'cruiser', 'CL-47'),
      vessel('US', 'TF 64.2', 'fletcher', '法伦霍尔特', 159.476, -9.229, 90, 20, 'screen', 'DD-491'),
      vessel('US', 'TF 64.2', 'fletcher', '邓肯', 159.479, -9.226, 90, 20, 'screen', 'DD-485'),
      vessel('US', 'TF 64.2', 'fletcher', '拉菲', 159.482, -9.223, 90, 20, 'screen', 'DD-459'),
      vessel('US', 'TF 64.2', 'fletcher', '布坎南', 159.485, -9.22, 90, 20, 'screen', 'DD-484'),
      vessel('JP', '第六战队', 'myoko', '青叶', 159.76, -9.215, 270, 22, 'flagship', ''),
      vessel('JP', '第六战队', 'myoko', '古鹰', 159.763, -9.212, 270, 22, 'cruiser', ''),
      vessel('JP', '第六战队', 'myoko', '衣笠', 159.766, -9.209, 270, 22, 'cruiser', ''),
      vessel('JP', '第六战队', 'fubuki', '吹雪', 159.769, -9.206, 270, 22, 'screen', ''),
      vessel('JP', '第六战队', 'fubuki', '初雪', 159.772, -9.203, 270, 22, 'screen', ''),
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      if (sunk >= 3) return { result: 'win', reason: '日方第六战队被打散，三艘沉没。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '美军编队全灭。' };
      if (world.powerRatio('US') <= 0.35) return { result: 'loss', reason: '己方战力不足，被迫脱离。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 2) return { result: 'win', reason: '击沉 ' + sunk + ' 艘日舰，日方撤退。' };
        if (sunk >= 1) return { result: 'draw', reason: '只击沉 ' + sunk + ' 艘，双方脱离接触。' };
        return { result: 'loss', reason: '夜战未能取得战果。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 7：萨沃岛夜战混战 —— 1942-11-13 01:50，双方撞进彼此队形里
   * ========================================================================== */
  Scenarios.register({
    id: 'savo_melee',
    type: 'surface',
    title: '萨沃岛 · 夜袭铁底湾',
    subtitle: '三川军一的八艘舰从两个方向切进美军的巡洋舰队列',
    date: '1942 年 8 月 9 日 01:45',
    startTime: 1 * 3600 + 45 * 60,
    timeOfDay: 'night',
    location: '铁底湾 · 萨沃岛以北',
    available: true,
    tags: ['夜战', '探照灯', '鱼雷'],

    env: {
      visibility: 3000,
      windDir: 95, windSpeed: 7, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0.1
    },

    playerSide: 'US',

    brief: [
      '01:45，萨沃岛以北。你的北区编队：堪培拉、阿斯托里亚、昆西、文森斯，外加两艘驱逐舰。',
      '南边刚刚传来炮声 —— 南区已经被打穿了。现在轮到你了，而你还不知道对面是谁。',
      '三川军一的第八舰队从萨沃岛东侧摸进来，八艘舰排成单纵队，已经在你侧翼。',
      '',
      '· 他们没有雷达，但有探照灯和九三式鱼雷，而且已经装定好诸元。',
      '· 你只有几秒钟：第一轮齐射打准，还能还手；打偏，就再也来不及了。',
      '· 日方会同时打出鱼雷 —— 水面上的航迹比炮口闪光更值得盯。'
    ],

    intel: '南区通报：日方巡洋舰编队已突破萨沃岛以南，正在向北转向。编成疑为五艘重巡、两艘轻巡、一艘驱逐舰。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉至少 3 艘日方舰艇',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_three',
        text: '至少 2 艘己方舰艇仍在战斗',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) { return s.side === 'US'; });
          var alive = aliveOf(list).length;
          return { progress: U.clamp01(alive / 2), done: alive >= 2, note: alive + '/' + list.length };
        }
      }
    ],

    victory: { timeLimit: 1800 },

    search: {
      US: at(159.96, -9.13),
      JP: at(159.88, -9.062)
    },

    zones: [],

    forces: [
      vessel('US', '北区', 'neworleans', '堪培拉', 159.88, -9.062, 270, 12, 'flagship', 'HMAS'),
      vessel('US', '北区', 'neworleans', '阿斯托里亚', 159.877, -9.059, 270, 12, 'cruiser', 'CA-34'),
      vessel('US', '北区', 'neworleans', '昆西', 159.874, -9.056, 270, 12, 'cruiser', 'CA-39'),
      vessel('US', '北区', 'neworleans', '文森斯', 159.871, -9.053, 270, 12, 'cruiser', 'CA-44'),
      vessel('US', '北区', 'fletcher', '帕特森', 159.883, -9.065, 270, 12, 'screen', 'DD-392'),
      vessel('US', '北区', 'fletcher', '布鲁', 159.886, -9.068, 270, 12, 'screen', 'DD-387'),
      vessel('JP', '第八舰队', 'myoko', '鸟海', 159.96, -9.13, 315, 26, 'flagship', ''),
      vessel('JP', '第八舰队', 'myoko', '青叶', 159.963, -9.127, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'myoko', '古鹰', 159.966, -9.124, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'myoko', '衣笠', 159.969, -9.121, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'myoko', '加古', 159.972, -9.118, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'sendai', '天龙', 159.975, -9.115, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'sendai', '夕张', 159.978, -9.112, 315, 26, 'cruiser', ''),
      vessel('JP', '第八舰队', 'kagero', '夕凪', 159.981, -9.109, 315, 26, 'screen', ''),
    ],

    check: function (world) {
      var sunkJP = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      var aliveUS = world.aliveShips('US').length;
      if (sunkJP >= 3 && aliveUS >= 3) return { result: 'win', reason: '日方增援部队被击退。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '美军编队被打光。' };
      if (aliveUS < 3) return { result: 'loss', reason: '己方只剩 ' + aliveUS + ' 艘还能打，被迫撤退。' };
      if (world.time >= timeLimit(world)) {
        if (sunkJP >= 2) return { result: 'draw', reason: '击沉 ' + sunkJP + ' 艘，但没能彻底击退。' };
        return { result: 'loss', reason: '混战中没有取得决定性战果。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 8：库拉湾 —— 1943-07-06，掩护登陆时日军增援部队突入
   * ========================================================================== */
  Scenarios.register({
    id: 'kula_gulf',
    type: 'escort',
    title: '库拉湾 · 增援拦截',
    subtitle: '把登陆船队送到锚地，同时挡住日方增援',
    date: '1943 年 7 月 6 日 01:20',
    startTime: 1 * 3600 + 20 * 60,
    timeOfDay: 'night',
    location: '新乔治亚 · 库拉湾',
    available: true,
    tags: ['夜战', '护航', '登陆'],

    env: {
      visibility: 5200,
      windDir: 130, windSpeed: 8, seaState: 2,
      weather: '阴，有阵雨', light: 'night', sunAzimuth: 0, rain: 0.2
    },

    playerSide: 'US',

    brief: [
      '01:20，库拉湾。三艘运输船载着第 43 步兵师的两个营，正在你的掩护下向莱斯锚地靠近。',
      '雷达发现日方增援部队从南面压上来：六艘驱逐舰，正沿着库拉湾北上，任务是阻止这次登陆。',
      '两件事同时做：把船送到锚地，别让它们靠近船队。',
      '',
      '· 运输船很慢，也很难躲 —— 它们只会朝锚地开。',
      '· 日方驱逐舰的鱼雷在这种距离上最危险，注意航迹和突然的转向。',
      '· 你的巡洋舰炮多，但侧面薄。别让它们贴上来。'
    ],

    intel: '海岸监视哨：南面有日方舰影，六艘驱逐舰，航向正北，速度约 30 节。旗舰是新月号。',

    objectives: [
      {
        id: 'deliver',
        text: '至少 2 艘运输船抵达锚地',
        kind: 'primary',
        check: function (world) {
          var tr = aliveOf(transports(world, 'US'));
          var z = world.zoneById('landing');
          var inside = tr.filter(function (s) { return z && world.shipInZone(s, 'landing'); }).length;
          return { progress: U.clamp01(inside / 2), done: inside >= 2, note: inside + '/2' };
        }
      },
      {
        id: 'sink_three',
        text: '击沉至少 3 艘日方驱逐舰',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_escorts',
        text: '（可选）保住 3 艘以上护航舰',
        kind: 'secondary',
        check: function (world) {
          var list = world.ships.filter(function (s) {
            return s.side === 'US' && s.role !== 'transport';
          });
          var alive = aliveOf(list).length;
          return { progress: U.clamp01(alive / 3), done: alive >= 3, note: alive + '/' + list.length };
        }
      }
    ],

    victory: { timeLimit: 3000 },

    zones: [
      zone('landing', '莱斯锚地', 'landing', 157.320, -8.060, 4000)
    ],

    search: {
      US: at(157.262, -7.99),
      JP: at(157.212, -8.148)
    },

    forces: [
      vessel('US', '登陆船队', 'transport', '麦考利', 157.23, -8.1, 350, 12, 'transport', 'AP-10', { destination: at(157.320, -8.060) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 157.234, -8.104, 350, 12, 'transport', 'AP-11', { destination: at(157.320, -8.060) }),
      vessel('US', '登陆船队', 'transport', '利伯蒂', 157.238, -8.108, 350, 12, 'transport', 'AP-12', { destination: at(157.320, -8.060) }),
      vessel('US', 'TF 36.1', 'brooklyn', '海伦娜', 157.212, -8.148, 350, 20, 'flagship', 'CL-50'),
      vessel('US', 'TF 36.1', 'brooklyn', '圣路易斯', 157.209, -8.151, 350, 20, 'cruiser', 'CL-49'),
      vessel('US', 'TF 36.1', 'brooklyn', '檀香山', 157.206, -8.154, 350, 20, 'cruiser', 'CL-48'),
      vessel('US', 'TF 36.1', 'fletcher', '尼古拉斯', 157.215, -8.142, 350, 20, 'screen', 'DD-449'),
      vessel('US', 'TF 36.1', 'fletcher', '奥班农', 157.218, -8.139, 350, 20, 'screen', 'DD-450'),
      vessel('US', 'TF 36.1', 'fletcher', '雷德福', 157.203, -8.157, 350, 20, 'screen', 'DD-446'),
      vessel('US', 'TF 36.1', 'fletcher', '詹金斯', 157.2, -8.16, 350, 20, 'screen', 'DD-447'),
      vessel('JP', '第三水雷战队', 'kagero', '新月', 157.262, -7.99, 170, 30, 'flagship', ''),
      vessel('JP', '第三水雷战队', 'kagero', '长月', 157.259, -7.987, 170, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '皋月', 157.256, -7.984, 170, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '夕凪', 157.253, -7.981, 170, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'fubuki', '天雾', 157.25, -7.978, 170, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'fubuki', '初雪', 157.247, -7.975, 170, 30, 'screen', ''),
    ],

    check: function (world) {
      var tr = transports(world, 'US');
      var alive = aliveOf(tr).length;
      var inside = aliveOf(tr).filter(function (s) { return world.shipInZone(s, 'landing'); }).length;
      if (inside >= 2) return { result: 'win', reason: '两艘运输船抵达锚地，登陆部队上岸。' };
      if (alive === 0) return { result: 'loss', reason: '运输船队全灭。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '护航编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if (alive >= 2) return { result: 'draw', reason: '船队保住了，但没能在天亮前进入锚地。' };
        return { result: 'loss', reason: '船队损失过半，登陆被迫取消。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 9：塔萨法隆加 —— 1942-11-30，田中赖三的“驱逐舰运输”
   * ========================================================================== */
  Scenarios.register({
    id: 'tassafaronga',
    type: 'escort',
    title: '塔萨法隆加 · 拦截运输队',
    subtitle: '拦住田中的“东京快车”',
    date: '1942 年 11 月 30 日 22:40',
    startTime: 22 * 3600 + 40 * 60,
    timeOfDay: 'night',
    location: '铁底湾 · 塔萨法隆加外海',
    available: true,
    tags: ['夜战', '拦截', '鱼雷战'],

    env: {
      visibility: 4600,
      windDir: 100, windSpeed: 8, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '22:40。雷达抓到一支从西北方下来的日方编队：六艘驱逐舰，甲板上绑满了补给桶。',
      '它们要把这些桶扔在瓜岛滩头，然后掉头就跑。你不能让它们过去。',
      '',
      '· 驱逐舰装的是九三式鱼雷 —— 它们会在转向的同时把鱼雷放出来。',
      '· 你的巡洋舰炮多，但侧面就是一堆弹药库和机舱。',
      '· 一旦看到日方驱逐舰转向，立刻准备规避：那不是撤退，是发射前的动作。'
    ],

    intel: '无线电通报：田中的驱逐舰运输队约六艘，航向东南，预计午夜前后抵达瓜岛北岸。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉至少 3 艘日方驱逐舰',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_power',
        text: '己方战力不低于 40%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.40), done: o >= 0.40 };
        }
      },
      {
        id: 'keep_cruisers',
        text: '（可选）没有巡洋舰沉没',
        kind: 'secondary',
        check: function (world) {
          var ca = world.ships.filter(function (s) {
            return s.side === 'US' && s.cls.type === 'CA';
          });
          var lost = ca.filter(function (s) { return s.sunk; }).length;
          return { progress: ca.length ? 1 - lost / ca.length : 1, done: lost === 0 };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    search: {
      US: at(159.82, -9.22),
      JP: at(160.04, -9.3)
    },

    zones: [
      zone('landing', '塔萨法隆加滩头', 'landing', 159.86, -9.24, 4000)
    ],

    forces: [
      vessel('US', 'TF 67', 'neworleans', '明尼阿波利斯', 160.04, -9.3, 300, 20, 'flagship', 'CA-36'),
      vessel('US', 'TF 67', 'neworleans', '新奥尔良', 160.043, -9.297, 300, 20, 'cruiser', 'CA-32'),
      vessel('US', 'TF 67', 'neworleans', '彭萨科拉', 160.046, -9.294, 300, 20, 'cruiser', 'CA-24'),
      vessel('US', 'TF 67', 'brooklyn', '檀香山', 160.049, -9.291, 300, 20, 'cruiser', 'CL-48'),
      vessel('US', 'TF 67', 'neworleans', '北安普顿', 160.052, -9.288, 300, 20, 'cruiser', 'CA-26'),
      vessel('US', 'TF 67', 'fletcher', '弗莱彻', 160.034, -9.306, 300, 20, 'screen', 'DD-445'),
      vessel('US', 'TF 67', 'fletcher', '珀金斯', 160.031, -9.309, 300, 20, 'screen', 'DD-377'),
      vessel('US', 'TF 67', 'fletcher', '莫里', 160.028, -9.312, 300, 20, 'screen', 'DD-401'),
      vessel('US', 'TF 67', 'fletcher', '杜拉尼', 160.025, -9.315, 300, 20, 'screen', 'DD-366'),
      vessel('JP', '第二水雷战队', 'kagero', '高波', 159.82, -9.22, 120, 25, 'flagship', ''),
      vessel('JP', '第二水雷战队', 'kagero', '长波', 159.817, -9.217, 120, 25, 'screen', ''),
      vessel('JP', '第二水雷战队', 'kagero', '亲潮', 159.814, -9.214, 120, 25, 'screen', ''),
      vessel('JP', '第二水雷战队', 'kagero', '黑潮', 159.811, -9.211, 120, 25, 'screen', ''),
      vessel('JP', '第二水雷战队', 'kagero', '江风', 159.808, -9.208, 120, 25, 'screen', ''),
      vessel('JP', '第二水雷战队', 'kagero', '凉风', 159.805, -9.205, 120, 25, 'screen', ''),
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      if (sunk >= 4) return { result: 'win', reason: '日方运输队被打散，补给桶全数沉海。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '美军编队全灭。' };
      if (world.powerRatio('US') <= 0.25) return { result: 'loss', reason: '编队失去战斗力，脱离接触。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 3) return { result: 'win', reason: '击沉 ' + sunk + ' 艘，运输队放弃任务。' };
        if (sunk >= 2) return { result: 'draw', reason: '击沉 ' + sunk + ' 艘，但大部分补给还是送上了岸。' };
        return { result: 'loss', reason: '拦截失败，补给送达瓜岛。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 10：伦加角登陆 —— 1942-08-07 拂晓，瓜岛第一波登陆
   * ========================================================================== */
  Scenarios.register({
    id: 'lunga_landing',
    type: 'landing',
    title: '伦加角 · 第一波登陆',
    subtitle: '把陆战队送上瓜达尔卡纳尔',
    date: '1942 年 8 月 7 日 06:50',
    startTime: 6 * 3600 + 50 * 60,
    timeOfDay: 'dawn',
    location: '瓜达尔卡纳尔岛北岸 · 伦加角',
    available: true,
    tags: ['登陆', '拂晓', '护航'],

    env: {
      visibility: 11000,
      windDir: 120, windSpeed: 9, seaState: 2,
      weather: '晨雾转晴', light: 'dawn', sunAzimuth: 80, rain: 0
    },

    playerSide: 'US',

    brief: [
      '06:50，伦加角外海。两艘运输船正开进锚地，准备放登陆艇，滩头上还什么都没有。',
      '侦察报告：日方一支水雷战队正从西北方高速南下，企图在登陆场还没建立之前冲进来。',
      '船队卸载需要时间 —— 你得替它们把这段时间买下来。',
      '',
      '· 运输船进入登陆区后会开始卸载，卸载进度决定胜负。',
      '· 敌舰进入登陆区会直接打断卸载，还会打伤运输船。',
      '· 拂晓的晨雾会让测距变差，第一轮炮击通常会偏。'
    ],

    intel: '海岸监视哨与侦察机报告：西北方向有日方轻巡与驱逐舰数艘，航向东南，速度约 28 节。',

    objectives: [
      {
        id: 'unload',
        text: '登陆区卸载进度达到 100%',
        kind: 'primary',
        check: function (world) {
          var p = U.clamp01((world._unload || 0) / 100);
          return { progress: p, done: p >= 1, note: Math.round(world._unload || 0) + '%' };
        }
      },
      {
        id: 'keep_transports',
        text: '至少 2 艘运输船幸存',
        kind: 'primary',
        check: function (world) {
          var tr = transports(world, 'US');
          var alive = aliveOf(tr).length;
          return { progress: tr.length ? alive / 2 : 0, done: alive >= 2, note: alive + '/' + tr.length };
        }
      },
      {
        id: 'drive_off',
        text: '（可选）击退日方突入编队',
        kind: 'secondary',
        check: function (world) {
          var e = world.powerRatio('JP');
          return { progress: U.clamp01((1 - e) / 0.60), done: e <= 0.40 };
        }
      }
    ],

    victory: { timeLimit: 3000 },

    zones: [
      zone('landing', '伦加登陆区', 'landing', 160.01, -9.37, 4500)
    ],

    search: {
      US: at(159.86, -9.14),
      JP: at(160.0, -9.34)
    },

    forces: [
      vessel('US', '登陆船队', 'transport', '麦考利', 160.0, -9.34, 45, 3, 'transport', 'AP-10', { destination: at(160.027, -9.340) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 160.015, -9.345, 45, 3, 'transport', 'AP-11', { destination: at(160.042, -9.345) }),
      vessel('US', 'TF 62.2', 'neworleans', '芝加哥', 159.96, -9.3, 315, 16, 'flagship', 'CA-29'),
      vessel('US', 'TF 62.2', 'neworleans', '波特兰', 159.963, -9.297, 315, 16, 'cruiser', 'CA-33'),
      vessel('US', 'TF 62.2', 'brooklyn', '海伦娜', 159.966, -9.294, 315, 16, 'cruiser', 'CL-50'),
      vessel('US', 'TF 62.2', 'fletcher', '帕特森', 159.954, -9.306, 315, 16, 'screen', 'DD-392'),
      vessel('US', 'TF 62.2', 'fletcher', '巴格利', 159.951, -9.309, 315, 16, 'screen', 'DD-386'),
      vessel('JP', '第八舰队', 'myoko', '鸟海', 159.86, -9.14, 135, 26, 'flagship', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'myoko', '青叶', 159.857, -9.143, 135, 26, 'cruiser', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'kagero', '夕凪', 159.863, -9.134, 135, 26, 'screen', '', { aiRole: 'raid' }),
      vessel('JP', '第八舰队', 'kagero', '岚', 159.866, -9.131, 135, 26, 'screen', '', { aiRole: 'raid' }),
    ],

    update: function (world, dt) {
      var zone = world.zoneById('landing');
      if (!zone) return;
      var tr = aliveOf(transports(world, 'US'));
      var inside = tr.filter(function (s) { return world.inZone(s.pos, zone); }).length;
      var intruders = world.aliveShips('JP').filter(function (s) { return world.inZone(s.pos, zone); }).length;

      if (inside > 0 && intruders === 0) {
        world._unload = Math.min(100, (world._unload || 0) + dt * 0.045 * inside);
      } else if (intruders > 0 && inside > 0) {
        // 敌舰冲进登陆区：卸载中断，运输船挨打
        if (world.rng.chance(0.8 * dt * intruders)) {
          var victim = tr[Math.floor(world.rng.next() * tr.length)];
          if (victim) {
            world.addSplash(victim.pos, 'JP', 'shell', null, 203);
            victim.applyDamage({ hull: 3, fire: 2 }, world);
          }
        }
      }
    },

    check: function (world) {
      var tr = transports(world, 'US');
      var alive = aliveOf(tr).length;
      if ((world._unload || 0) >= 100) return { result: 'win', reason: '登陆部队与补给全部上岸。' };
      if (alive === 0) return { result: 'loss', reason: '运输船队全灭，登陆失败。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '掩护编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if ((world._unload || 0) >= 70) return { result: 'draw', reason: '卸载 ' + Math.round(world._unload) + '%，登陆未完成。' };
        return { result: 'loss', reason: '卸载不足，登陆部队被迫撤回。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 11：新乔治亚登陆 —— 1943-06-30 夜
   * ========================================================================== */
  Scenarios.register({
    id: 'new_georgia_landing',
    type: 'landing',
    title: '新乔治亚 · 夜登陆',
    subtitle: '在日军增援赶到之前把部队送上岸',
    date: '1943 年 6 月 30 日 23:10',
    startTime: 23 * 3600 + 10 * 60,
    timeOfDay: 'night',
    location: '新乔治亚 · 伦多瓦锚地',
    available: true,
    tags: ['登陆', '夜战'],

    env: {
      visibility: 4000,
      windDir: 80, windSpeed: 10, seaState: 3,
      weather: '阴，有雨', light: 'night', sunAzimuth: 0, rain: 0.4
    },

    playerSide: 'US',

    brief: [
      '23:10，伦多瓦锚地。两艘运输船摸黑进入锚地，登陆艇已经在放。',
      '日方增援部队正从北面下来 —— 他们知道这次登陆，也知道时间。',
      '',
      '· 夜里的登陆是纯粹的赛跑：你比他们先卸完，就赢了。',
      '· 雷达能抓到他们的距离，但测向误差很大，别指望精确拦截。',
      '· 照明弹可以让你看清冲进来的是什么，也会让他们的炮打得准。'
    ],

    intel: '无线电测向：北面有日方驱逐舰编队南下，数量不明。',

    objectives: [
      {
        id: 'unload',
        text: '锚地卸载进度达到 100%',
        kind: 'primary',
        check: function (world) {
          var p = U.clamp01((world._unload || 0) / 100);
          return { progress: p, done: p >= 1, note: Math.round(world._unload || 0) + '%' };
        }
      },
      {
        id: 'keep_transports',
        text: '至少 1 艘运输船幸存',
        kind: 'primary',
        check: function (world) {
          var tr = transports(world, 'US');
          var alive = aliveOf(tr).length;
          return { progress: tr.length ? alive / 1 : 0, done: alive >= 1, note: alive + '/' + tr.length };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    zones: [
      zone('landing', '伦多瓦登陆区', 'landing', 157.27, -8.48, 4000)
    ],

    search: {
      US: at(157.36, -8.40),
      JP: at(157.24, -8.475)
    },

    shoreTargets: [
      shore('munda', '蒙达机场', 'airfield', 157.280, -8.320, 520),
      shore('depot', '伦多瓦补给站', 'supply', 157.25, -8.56, 320)
    ],

    forces: [
      vessel('US', '登陆船队', 'transport', '麦考利', 157.255, -8.46, 90, 8, 'transport', 'AP-10', { destination: at(157.275, -8.465) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 157.259, -8.465, 90, 8, 'transport', 'AP-11', { destination: at(157.279, -8.470) }),
      vessel('US', 'TF 31.1', 'brooklyn', '檀香山', 157.24, -8.475, 90, 16, 'flagship', 'CL-48'),
      vessel('US', 'TF 31.1', 'brooklyn', '圣路易斯', 157.237, -8.478, 90, 16, 'cruiser', 'CL-49'),
      vessel('US', 'TF 31.1', 'fletcher', '尼古拉斯', 157.243, -8.469, 90, 16, 'screen', 'DD-449'),
      vessel('US', 'TF 31.1', 'fletcher', '奥班农', 157.246, -8.466, 90, 16, 'screen', 'DD-450'),
      vessel('US', 'TF 31.1', 'fletcher', '泰勒', 157.249, -8.463, 90, 16, 'screen', 'DD-468'),
      vessel('JP', '第二水雷战队', 'kagero', '新月', 157.370, -8.350, 200, 26, 'flagship', '', { aiRole: 'raid' }),
      vessel('JP', '第二水雷战队', 'kagero', '长月', 157.367, -8.353, 200, 26, 'screen', '', { aiRole: 'raid' }),
      vessel('JP', '第二水雷战队', 'kagero', '皋月', 157.364, -8.356, 200, 26, 'screen', '', { aiRole: 'raid' }),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '时雨', 157.361, -8.359, 200, 26, 'screen', '', { aiRole: 'raid' }),
    ],

    update: function (world, dt) {
      var zone = world.zoneById('landing');
      if (!zone) return;
      var tr = aliveOf(transports(world, 'US'));
      var inside = tr.filter(function (s) { return world.inZone(s.pos, zone); }).length;
      var intruders = world.aliveShips('JP').filter(function (s) { return world.inZone(s.pos, zone); }).length;
      if (inside > 0 && intruders === 0) {
        world._unload = Math.min(100, (world._unload || 0) + dt * 0.06 * inside);
      }
    },

    check: function (world) {
      var tr = transports(world, 'US');
      var alive = aliveOf(tr).length;
      if ((world._unload || 0) >= 100) return { result: 'win', reason: '登陆部队上岸，锚地建立。' };
      if (alive === 0) return { result: 'loss', reason: '运输船全灭。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '掩护编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if ((world._unload || 0) >= 60) return { result: 'draw', reason: '卸载 ' + Math.round(world._unload) + '%，部队只上去了半个营。' };
        return { result: 'loss', reason: '登陆被迫中止。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 12：炮击马坦尼考 —— 1942-08-08 拂晓，压制瓜岛北岸的日军阵地
   * ========================================================================== */
  Scenarios.register({
    id: 'tulagi_bombardment',
    type: 'bombard',
    title: '马坦尼考 · 炮击日军阵地',
    subtitle: '登陆第二天，把河口一带的补给点和岸炮打掉',
    date: '1942 年 8 月 8 日 04:20',
    startTime: 4 * 3600 + 20 * 60,
    timeOfDay: 'night',
    location: '瓜达尔卡纳尔岛 · 马坦尼考河口',
    available: true,
    tags: ['岸轰', '夜战', '拂晓'],

    env: {
      visibility: 5500,
      windDir: 120, windSpeed: 8, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '04:20，瓜岛北岸外海。陆战队昨天在伦加滩头站住了脚，但西边马坦尼考的日军还在往滩头打冷炮。',
      '你的任务是把河口一带的补给站和岸炮阵地犁一遍，给明天的推进铺路。',
      '日方的水雷战队在天亮前后可能从北面压下来。',
      '',
      '· 左键点选舰艇，再点岸上目标即可下达炮击命令。',
      '· 夜间的岸轰命中率很低，靠近一点再打。',
      '· 岸上不会还击，但日方水面舰艇会 —— 注意北面的雷达回波。'
    ],

    intel: '侦察报告：马坦尼考河口有日军阵地一处、补给站一处、岸炮阵地若干。日方水面部队在北面活动。',

    objectives: [
      {
        id: 'destroy_two',
        text: '摧毁至少 2 处岸上目标',
        kind: 'primary',
        check: function (world) {
          var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
          var total = world.shoreTargets.length;
          return { progress: U.clamp01(dead / 2), done: dead >= 2, note: dead + '/' + total };
        }
      },
      {
        id: 'survive',
        text: '保持编队战力不低于 50%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.50), done: o >= 0.50 };
        }
      }
    ],

    victory: { timeLimit: 2100 },

    zones: [
      zone('bombard_area', '炮击区', 'objective', 160.0, -9.36, 6000)
    ],

    search: {
      US: at(160.14, -9.22),
      JP: at(160.0, -9.3)
    },

    shoreTargets: [
      shore('seaplane', '马坦尼考阵地', 'airfield', 160.0, -9.45, 480),
      shore('depot', '河口补给站', 'supply', 160.03, -9.46, 340),
      shore('gun', '岸炮阵地', 'position', 159.97, -9.44, 300)
    ],

    forces: [
      vessel('US', 'TF 62.2', 'brooklyn', '海伦娜', 160.0, -9.3, 270, 15, 'flagship', 'CL-50'),
      vessel('US', 'TF 62.2', 'brooklyn', '圣路易斯', 159.997, -9.303, 270, 15, 'cruiser', 'CL-49'),
      vessel('US', 'TF 62.2', 'brooklyn', '檀香山', 159.994, -9.306, 270, 15, 'cruiser', 'CL-48'),
      vessel('US', 'TF 62.2', 'fletcher', '尼古拉斯', 160.003, -9.294, 270, 15, 'screen', 'DD-449'),
      vessel('US', 'TF 62.2', 'fletcher', '奥班农', 160.006, -9.291, 270, 15, 'screen', 'DD-450'),
      vessel('JP', '东京快车', 'kagero', '夕凪', 160.14, -9.22, 315, 26, 'flagship', ''),
      vessel('JP', '东京快车', 'kagero', '岚', 160.143, -9.217, 315, 26, 'screen', ''),
      vessel('JP', '东京快车', 'kagero', '江风', 160.146, -9.214, 315, 26, 'screen', ''),
      vessel('JP', '东京快车', 'shiratsuyu', '时雨', 160.149, -9.211, 315, 26, 'screen', ''),
    ],

    onStart: function (world) {
      if (world.shoreTargets.length) {
        world.log('US', '炮击目标已指定：' + world.shoreTargets[0].name, 'info');
      }
    },

    check: function (world) {
      var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
      if (dead >= 3) return { result: 'win', reason: '岛上日军阵地被彻底压制。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '炮击编队全灭。' };
      if (world.powerRatio('US') <= 0.35) return { result: 'loss', reason: '编队战力不足，被迫撤离。' };
      if (world.time >= timeLimit(world)) {
        if (dead >= 2) return { result: 'win', reason: '摧毁 ' + dead + ' 处目标，任务达成。' };
        if (dead >= 1) return { result: 'draw', reason: '只摧毁 ' + dead + ' 处目标。' };
        return { result: 'loss', reason: '炮击没有造成有效破坏。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 13：炮击亨德森机场 —— 1942-10-13 夜，日方重巡夜袭
   * ========================================================================== */
  Scenarios.register({
    id: 'henderson_bombardment',
    type: 'bombard',
    title: '亨德森机场 · 夜袭',
    subtitle: '金刚、榛名用 14 英寸主炮把机场犁一遍',
    date: '1942 年 10 月 13 日 22:30',
    startTime: 22 * 3600 + 30 * 60,
    timeOfDay: 'night',
    location: '瓜达尔卡纳尔岛 · 伦加角',
    available: true,
    tags: ['岸轰', '夜战', '日军视角'],

    env: {
      visibility: 4600,
      windDir: 90, windSpeed: 9, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'JP',

    brief: [
      '22:30，金刚、榛名两艘战列舰从西北方接近瓜岛北岸。岸上就是亨德森机场 —— 白天它炸沉了你的运输船，今晚轮到它了。',
      '美军的水面舰艇在东南方向，通常半小时内会赶到。',
      '',
      '· 左键点选舰艇，再点岸上目标下达炮击命令。',
      '· 本作没有战列舰，金刚、榛名以重巡的数据代替。',
      '· 你的炮弹不多，别把时间浪费在已经被摧毁的目标上。',
      '· 美军驱逐舰会放鱼雷。夜里的鱼雷航迹几乎看不见。'
    ],

    intel: '侦察机报告：亨德森机场跑道完好，油料与弹药堆积区在跑道东南侧，岸防炮位若干。美军水面舰艇在东南方向待机。',

    objectives: [
      {
        id: 'destroy_two',
        text: '摧毁至少 2 处岸上目标',
        kind: 'primary',
        check: function (world) {
          var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
          var total = world.shoreTargets.length;
          return { progress: U.clamp01(dead / 2), done: dead >= 2, note: dead + '/' + total };
        }
      },
      {
        id: 'survive',
        text: '保持编队战力不低于 45%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('JP');
          return { progress: U.clamp01(o / 0.45), done: o >= 0.45 };
        }
      },
      {
        id: 'sink_dd',
        text: '（可选）击沉一艘美军驱逐舰',
        kind: 'secondary',
        check: function (world) {
          var dd = world.ships.filter(function (s) {
            return s.side === 'US' && s.cls.type === 'DD';
          });
          var sunk = dd.filter(function (s) { return s.sunk; }).length;
          return { progress: sunk > 0 ? 1 : 0, done: sunk > 0 };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    zones: [
      zone('bombard_area', '炮击区', 'objective', 160.05, -9.39, 6000)
    ],

    search: {
      US: at(160.06, -9.22),
      JP: at(159.88, -9.2)
    },

    shoreTargets: [
      shore('airfield', '亨德森机场', 'airfield', 160.05, -9.46, 600),
      shore('fuel', '航空燃料库', 'supply', 160.08, -9.47, 380),
      shore('aa', '高射炮阵地', 'position', 160.02, -9.45, 300)
    ],

    forces: [
      vessel('JP', '前进部队', 'myoko', '金刚', 159.88, -9.2, 90, 18, 'flagship', 'BB', { aiRole: 'bombard', autoBombard: true }),
      vessel('JP', '前进部队', 'myoko', '榛名', 159.884, -9.197, 90, 18, 'cruiser', 'BB', { aiRole: 'bombard', autoBombard: true }),
      vessel('JP', '前进部队', 'sendai', '长良', 159.888, -9.194, 90, 18, 'cruiser', ''),
      vessel('JP', '前进部队', 'kagero', '照月', 159.874, -9.206, 90, 18, 'screen', ''),
      vessel('JP', '前进部队', 'shiratsuyu', '村雨', 159.878, -9.209, 90, 18, 'screen', ''),
      vessel('JP', '前进部队', 'shiratsuyu', '五月雨', 159.87, -9.212, 90, 18, 'screen', ''),
      vessel('JP', '前进部队', 'shiratsuyu', '时雨', 159.866, -9.215, 90, 18, 'screen', ''),
      vessel('US', 'TF 64.2', 'fletcher', '弗莱彻', 160.06, -9.22, 270, 26, 'flagship', 'DD-445'),
      vessel('US', 'TF 64.2', 'fletcher', '奥班农', 160.064, -9.217, 270, 26, 'screen', 'DD-450'),
    ],

    onStart: function (world) {
      if (world.shoreTargets.length) {
        world.log('JP', '炮击目标已指定：' + world.shoreTargets[0].name, 'info');
      }
    },

    check: function (world) {
      var dead = world.shoreTargets.filter(function (t) { return t.destroyed; }).length;
      if (dead >= 3) return { result: 'win', reason: '亨德森机场被炸成废墟。' };
      if (world.allSunk('JP')) return { result: 'loss', reason: '炮击编队全灭。' };
      if (world.powerRatio('JP') <= 0.30) return { result: 'loss', reason: '编队失去战斗力，被迫撤离。' };
      if (world.time >= timeLimit(world)) {
        if (dead >= 2) return { result: 'win', reason: '摧毁 ' + dead + ' 处目标。' };
        if (dead >= 1) return { result: 'draw', reason: '只摧毁 ' + dead + ' 处目标，天亮前撤离。' };
        return { result: 'loss', reason: '炮击毫无效果。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 14：萨沃岛之后 —— 1942-08-09，掩护运输队撤离
   * ========================================================================== */
  Scenarios.register({
    id: 'savo_withdrawal',
    type: 'retreat',
    title: '萨沃岛之后 · 撤离',
    subtitle: '把剩下的运输船带出铁底湾',
    date: '1942 年 8 月 9 日 05:40',
    startTime: 5 * 3600 + 40 * 60,
    timeOfDay: 'dawn',
    location: '铁底湾 · 萨沃岛东南',
    available: true,
    tags: ['撤退', '拂晓', '护航'],

    env: {
      visibility: 9000,
      windDir: 110, windSpeed: 10, seaState: 3,
      weather: '晨雾', light: 'dawn', sunAzimuth: 78, rain: 0
    },

    playerSide: 'US',

    brief: [
      '05:40。昨夜萨沃岛以北的夜战里，三艘重巡沉了。现在剩下的运输船还停在铁底湾，卸了一半的货。',
      '天快亮了。日方的重巡编队随时会回头把运输船补掉。',
      '把它们带到东南方的撤离区，任务就算完成 —— 这不是一场要打赢的战斗。',
      '',
      '· 运输船受创，只能跑 12 节。',
      '· 你的巡洋舰打不过对面的三艘重巡，别硬拼。',
      '· 烟幕可以挡住它们的炮，但挡不住鱼雷。'
    ],

    intel: '无线电通报：日方第八舰队仍在萨沃岛以西，可能再次东进。美军航空兵要到 07:00 之后才能提供掩护。',

    objectives: [
      {
        id: 'get_out',
        text: '至少 2 艘运输船抵达撤离区',
        kind: 'primary',
        check: function (world) {
          var tr = aliveOf(transports(world, 'US'));
          var z = world.zoneById('exit');
          var inside = tr.filter(function (s) { return z && world.shipInZone(s, 'exit'); }).length;
          return { progress: U.clamp01(inside / 2), done: inside >= 2, note: inside + '/2' };
        }
      },
      {
        id: 'keep_cruiser',
        text: '芝加哥号不得沉没',
        kind: 'primary',
        check: function (world) {
          var c = world.ships.filter(function (s) { return s.name === '芝加哥'; })[0];
          return { progress: c && c.sunk ? 0 : 1, done: !!(c && !c.sunk) };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    zones: [
      zone('exit', '撤离区', 'exit', 159.99, -9.22, 4000)
    ],

    search: {
      US: at(159.76, -9.11),
      JP: at(159.84, -9.2)
    },

    forces: [
      vessel('US', 'TF 62.2', 'neworleans', '芝加哥', 159.84, -9.2, 90, 10, 'flagship', 'CA-29', { aiExitZone: 'exit', damage: { hull: 0.30, flood: 8, power: 10, fire: 0 } }),
      vessel('US', 'TF 62.2', 'fletcher', '帕特森', 159.845, -9.195, 90, 12, 'screen', 'DD-392'),
      vessel('US', 'TF 62.2', 'fletcher', '巴格利', 159.85, -9.19, 90, 12, 'screen', 'DD-386'),
      vessel('US', '登陆船队', 'transport', '麦考利', 159.88, -9.21, 90, 12, 'transport', 'AP-10', { destination: at(159.990, -9.220) }),
      vessel('US', '登陆船队', 'transport', '巴尼特', 159.884, -9.214, 90, 12, 'transport', 'AP-11', { destination: at(159.990, -9.220) }),
      vessel('JP', '第八舰队', 'myoko', '鸟海', 159.76, -9.11, 110, 28, 'flagship', '', { pursue: true }),
      vessel('JP', '第八舰队', 'myoko', '青叶', 159.763, -9.107, 110, 28, 'cruiser', '', { pursue: true }),
      vessel('JP', '第八舰队', 'sendai', '天龙', 159.766, -9.104, 110, 28, 'cruiser', '', { pursue: true }),
      vessel('JP', '第八舰队', 'sendai', '夕张', 159.769, -9.101, 110, 28, 'cruiser', '', { pursue: true }),
    ],

    check: function (world) {
      var tr = transports(world, 'US');
      var alive = aliveOf(tr).length;
      var out = aliveOf(tr).filter(function (s) { return world.shipInZone(s, 'exit'); }).length;
      if (out >= 2) return { result: 'win', reason: '两艘运输船脱离铁底湾。' };
      if (alive === 0) return { result: 'loss', reason: '运输船全灭。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '掩护编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if (out >= 1) return { result: 'draw', reason: '只有 1 艘运输船撤出。' };
        return { result: 'loss', reason: '船队被困在铁底湾。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 15：维拉拉维拉 —— 1943-10-06，掩护撤离编队
   * ========================================================================== */
  Scenarios.register({
    id: 'vella_lavella_retreat',
    type: 'retreat',
    title: '维拉拉维拉 · 掩护撤离',
    subtitle: '三艘驱逐舰挡住日方的撤离舰队',
    date: '1943 年 10 月 6 日 22:30',
    startTime: 22 * 3600 + 30 * 60,
    timeOfDay: 'night',
    location: '维拉拉维拉岛以北 · 韦拉拉韦拉海峡',
    available: true,
    tags: ['撤退', '夜战', '驱逐舰'],

    env: {
      visibility: 4200,
      windDir: 85, windSpeed: 9, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '23:20，维拉拉维拉以北。你的三艘驱逐舰正掩护一艘自走炮登陆舰向北撤离。',
      '日方派了四艘驱逐舰来拦 —— 他们要把这条船留下来。',
      '',
      '· 你只有三艘驱逐舰，火力不如对方，但雷达比他们好。',
      '· 驱逐舰对驱逐舰，先发现、先转向、先放鱼雷的一方赢。',
      '· 撤离舰很慢，别把它一个人留在后面。'
    ],

    intel: '无线电测向：北面有日方驱逐舰四艘，航向东南。',

    objectives: [
      {
        id: 'get_home',
        text: '撤离舰抵达撤离区',
        kind: 'primary',
        check: function (world) {
          var e = world.ships.filter(function (s) { return s.role === 'escortee'; })[0];
          if (!e) return { progress: 0, done: false };
          if (e.sunk) return { progress: 0, done: false };
          var z = world.zoneById('exit');
          var d = z ? V.dist(e.pos, z.pos) : 99999;
          return {
            progress: U.clamp01(1 - d / 18000),
            done: world.shipInZone(e, 'exit'),
            note: U.fmtRange(d)
          };
        }
      },
      {
        id: 'keep_two',
        text: '保住至少 2 艘驱逐舰',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) {
            return s.side === 'US' && s.role !== 'escortee';
          });
          var alive = aliveOf(list).length;
          return { progress: list.length ? U.clamp01(alive / 2) : 0, done: alive >= 2, note: alive + '/' + list.length };
        }
      }
    ],

    victory: { timeLimit: 2700 },

    zones: [
      zone('exit', '撤离区', 'exit', 156.9, -7.53, 4000)
    ],

    search: {
      US: at(156.7, -7.49),
      JP: at(156.76, -7.54)
    },

    forces: [
      vessel('US', 'TF 39.1', 'fletcher', '塞尔弗里奇', 156.76, -7.54, 45, 20, 'flagship', 'DD-357'),
      vessel('US', 'TF 39.1', 'fletcher', '谢瓦利埃', 156.763, -7.537, 45, 20, 'screen', 'DD-451'),
      vessel('US', 'TF 39.1', 'fletcher', '奥班农', 156.766, -7.534, 45, 20, 'screen', 'DD-450'),
      vessel('US', 'TF 39.1', 'transport', '自走炮登陆舰', 156.755, -7.548, 45, 12, 'escortee', 'LCI-70', { destination: at(156.900, -7.530) }),
      vessel('JP', '输送队', 'kagero', '夕云', 156.7, -7.49, 220, 25, 'flagship', ''),
      vessel('JP', '输送队', 'kagero', '矶风', 156.703, -7.487, 220, 25, 'screen', ''),
      vessel('JP', '输送队', 'shiratsuyu', '时雨', 156.706, -7.484, 220, 25, 'screen', ''),
      vessel('JP', '输送队', 'shiratsuyu', '五月雨', 156.709, -7.481, 220, 25, 'screen', ''),
    ],

    check: function (world) {
      var e = world.ships.filter(function (s) { return s.role === 'escortee'; })[0];
      if (!e) return { result: 'draw', reason: '没有需要掩护的舰艇。' };
      if (e.sunk) return { result: 'loss', reason: '撤离舰被击沉。' };
      if (world.shipInZone(e, 'exit')) return { result: 'win', reason: '撤离舰进入撤离区。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '掩护编队全灭。' };
      if (world.time >= timeLimit(world)) return { result: 'loss', reason: '时限已到，撤离舰仍未脱离。' };
      return null;
    }
  });


  /* ==========================================================================
   *  场景 16：科隆班加拉海战 —— 1943-07-13 01:00
   *  安斯沃思的三艘轻巡 + 十艘驱逐舰，在科隆班加拉以北撞上神通率领的输送队。
   * ========================================================================== */
  Scenarios.register({
    id: 'kolombangara',
    type: 'surface',
    title: '科隆班加拉 · 夜战',
    subtitle: '四艘轻巡横在日方输送队前面，双方同时把鱼雷管打空',
    date: '1943 年 7 月 13 日 01:00',
    startTime: 1 * 3600,
    timeOfDay: 'night',
    location: '科隆班加拉岛以北 · 库拉湾北口',
    available: true,
    tags: ['夜战', '鱼雷战', '雷达'],

    env: {
      visibility: 5200,
      windDir: 120, windSpeed: 8, seaState: 2,
      weather: '阴，无月', light: 'night', sunAzimuth: 0, rain: 0.1
    },

    playerSide: 'US',

    brief: [
      '01:00，科隆班加拉岛以北。你的编队北上：檀香山、圣路易斯，加上新西兰海军的利安得，另有八艘驱逐舰。',
      '目标是支往维拉送援兵的日方输送队 —— 神通号轻巡带着五艘驱逐舰，刚卸完货正在返航。',
      '这是整场战役里最典型的鱼雷伏击：双方都会在发现对方后几秒内把鱼雷管打空，然后各自转向。',
      '',
      '· 九三式鱼雷射程远、航迹小，日方习惯在转向的同时发射 —— 看到对方转向就要准备规避。',
      '· 你的优势是雷达：你先看见他们，但看见不等于打得中。',
      '· 利安得是新西兰海军的船，装甲比美式轻巡薄，别把它放在最前面。'
    ],

    intel: '海岸监视哨：日方输送队已在维拉卸货，正沿库拉湾南下返航。旗舰疑为轻巡，另有五艘驱逐舰。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉至少 3 艘日方舰艇',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_half',
        text: '己方战力不低于 50%',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.50), done: o >= 0.50 };
        }
      },
      {
        id: 'sink_cl',
        text: '（可选）击沉日方轻巡洋舰',
        kind: 'secondary',
        check: function (world) {
          var cl = world.ships.filter(function (s) {
            return s.side === 'JP' && s.cls.type === 'CL';
          })[0];
          if (!cl) return { progress: 0, done: false };
          return { progress: cl.sunk ? 1 : 0, done: cl.sunk };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    zones: [],

    search: { US: at(157.100, -7.800), JP: at(157.100, -7.690) },

    forces: [
      vessel('US', 'TF 18.1', 'brooklyn', '檀香山', 157.060, -7.800, 355, 20, 'flagship', 'CL-48'),
      vessel('US', 'TF 18.1', 'brooklyn', '圣路易斯', 157.056, -7.797, 355, 20, 'cruiser', 'CL-49'),
      vessel('US', 'TF 18.1', 'brooklyn', '利安得', 157.052, -7.794, 355, 20, 'cruiser', 'HMNZS'),
      vessel('US', 'TF 18.1', 'fletcher', '尼古拉斯', 157.064, -7.806, 355, 20, 'screen', 'DD-449'),
      vessel('US', 'TF 18.1', 'fletcher', '奥班农', 157.068, -7.810, 355, 20, 'screen', 'DD-450'),
      vessel('US', 'TF 18.1', 'fletcher', '泰勒', 157.072, -7.814, 355, 20, 'screen', 'DD-468'),
      vessel('US', 'TF 18.1', 'fletcher', '詹金斯', 157.076, -7.818, 355, 20, 'screen', 'DD-447'),
      vessel('US', 'TF 18.1', 'fletcher', '雷德福', 157.048, -7.790, 355, 20, 'screen', 'DD-446'),
      vessel('US', 'TF 18.1', 'fletcher', '拉尔夫·塔尔博特', 157.044, -7.786, 355, 20, 'screen', 'DD-390'),
      vessel('US', 'TF 18.1', 'fletcher', '布坎南', 157.040, -7.782, 355, 20, 'screen', 'DD-484'),
      vessel('US', 'TF 18.1', 'fletcher', '格温', 157.036, -7.778, 355, 20, 'screen', 'DD-433'),
      vessel('JP', '第三水雷战队', 'sendai', '神通', 157.120, -7.700, 175, 30, 'flagship', ''),
      vessel('JP', '第三水雷战队', 'kagero', '雪风', 157.123, -7.697, 175, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '浜风', 157.126, -7.694, 175, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '清波', 157.129, -7.691, 175, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '夕凪', 157.132, -7.688, 175, 30, 'screen', ''),
      vessel('JP', '第三水雷战队', 'shiratsuyu', '凉风', 157.135, -7.685, 175, 30, 'screen', '')
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      if (sunk >= 4) return { result: 'win', reason: '日方输送队被打散，增援没送到维拉。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '美军编队全灭。' };
      if (world.powerRatio('US') <= 0.35) return { result: 'loss', reason: '己方战力不足，被迫脱离。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 3) return { result: 'win', reason: '击沉 ' + sunk + ' 艘日舰，日方撤退。' };
        if (sunk >= 1) return { result: 'draw', reason: '只击沉 ' + sunk + ' 艘，双方脱离接触。' };
        return { result: 'loss', reason: '夜战未能取得战果。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 17：布莱克特海峡 —— 1943-03-06，三艘轻巡的第一次雷达伏击
   * ========================================================================== */
  Scenarios.register({
    id: 'blackett_strait',
    type: 'surface',
    title: '布莱克特海峡 · 雷达伏击',
    subtitle: '三艘轻巡，两艘驱逐舰，一场没有打成混战的夜战',
    date: '1943 年 3 月 6 日 01:00',
    startTime: 1 * 3600,
    timeOfDay: 'night',
    location: '科隆班加拉以南 · 布莱克特海峡',
    available: true,
    tags: ['夜战', '雷达', '伏击'],

    env: {
      visibility: 4600,
      windDir: 110, windSpeed: 7, seaState: 2,
      weather: '阴，低云', light: 'night', sunAzimuth: 0, rain: 0.1
    },

    playerSide: 'US',

    brief: [
      '01:00，布莱克特海峡以南。你的三艘轻巡和三条驱逐舰刚完成炮击任务，正在返航。',
      '雷达上出现两个目标：两艘驱逐舰刚从维拉卸完补给出港，正沿着海峡北上。',
      '这是美军第一次在夜战里把雷达、队形和射速同时用对 —— 别打成混战，保持距离，用炮。',
      '',
      '· 你有 12 门 6 英寸炮，对方只有 5 英寸。把距离拉开就是优势。',
      '· 日军驱逐舰的氧气鱼雷在这种夜里很致命，但它们刚卸完货，未必装填好了。',
      '· 不要追进海峡：浅水、暗礁，而且天一亮日机就来了。'
    ],

    intel: '海岸监视哨：两艘日方驱逐舰 00:40 离开维拉锚地，航向正北，速度约 24 节。',

    objectives: [
      {
        id: 'sink_two',
        text: '击沉两艘日方驱逐舰',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 2); }
      },
      {
        id: 'preserve',
        text: '我方战力保持在 60% 以上',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.60), done: o >= 0.60 };
        }
      },
      {
        id: 'no_loss',
        text: '（可选）不损失任何舰艇',
        kind: 'secondary',
        check: function (world) {
          var lost = world.ships.filter(function (s) { return s.side === 'US' && s.sunk; }).length;
          return { progress: lost ? 0 : 1, done: lost === 0 };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    search: {
      US: at(156.980, -8.280),
      JP: at(157.010, -8.210)
    },

    forces: [
      vessel('US', 'TF 68.3', 'cleveland', '克利夫兰', 156.980, -8.280, 350, 22, 'flagship', 'CL-55'),
      vessel('US', 'TF 68.3', 'cleveland', '蒙彼利埃', 156.984, -8.283, 350, 22, 'cruiser', 'CL-57'),
      vessel('US', 'TF 68.3', 'cleveland', '丹佛', 156.988, -8.286, 350, 22, 'cruiser', 'CL-58'),
      vessel('US', 'TF 68.3', 'fletcher', '康威', 156.972, -8.274, 350, 22, 'screen', 'DD-507'),
      vessel('US', 'TF 68.3', 'fletcher', '沃勒', 156.976, -8.277, 350, 22, 'screen', 'DD-466'),
      vessel('US', 'TF 68.3', 'fletcher', '普林格尔', 156.968, -8.271, 350, 22, 'screen', 'DD-477'),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '村雨', 157.010, -8.210, 170, 26, 'flagship', ''),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '峰云', 157.014, -8.207, 170, 26, 'screen', '')
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      if (sunk >= 2) return { result: 'win', reason: '两艘日舰全沉，海峡清空。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '编队被打散。' };
      if (world.powerRatio('US') <= 0.30) return { result: 'loss', reason: '战力不足，被迫脱离。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 1) return { result: 'draw', reason: '击沉一艘，另一艘带伤跑掉。' };
        return { result: 'loss', reason: '夜战没有战果，日舰穿过了海峡。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 18：韦拉湾 —— 1943-08-06，六艘驱逐舰不开炮先放鱼雷
   * ========================================================================== */
  Scenarios.register({
    id: 'vella_gulf',
    type: 'surface',
    title: '韦拉湾 · 六艘驱逐舰的伏击',
    subtitle: '不开炮，先放鱼雷',
    date: '1943 年 8 月 6 日 23:30',
    startTime: 23 * 3600 + 30 * 60,
    timeOfDay: 'night',
    location: '科隆班加拉与韦拉拉韦拉之间 · 韦拉湾',
    available: true,
    tags: ['夜战', '鱼雷', '驱逐舰'],

    env: {
      visibility: 5000,
      windDir: 140, windSpeed: 9, seaState: 2,
      weather: '阴，有阵雨', light: 'night', sunAzimuth: 0, rain: 0.15
    },

    playerSide: 'US',

    brief: [
      '23:30，韦拉湾。你手上有六艘弗莱彻级，对面是四艘日军驱逐舰，正在往科隆班加拉送兵。',
      '这一仗的规矩很简单：**先放鱼雷，别开炮**。一开炮，对方就知道你在哪，鱼雷就白放了。',
      '六艘舰排成两列，各自瞄准不同目标，鱼雷在 4 公里外齐射 —— 这是太平洋战争里第一次这么打的伏击。',
      '',
      '· 你没有巡洋舰，只有 5 英寸炮和鱼雷。贴上去打炮是自杀。',
      '· 鱼雷要打提前量：瞄准接触的**估计**位置，而不是你以为它会在的地方。',
      '· 打完就转向脱离，日军的九三式鱼雷射程比你的 Mk 15 远得多。'
    ],

    intel: '海岸监视哨：四艘日方驱逐舰 23:10 从布因方向进入韦拉湾，航向东南，速度约 24 节。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉三艘日方驱逐舰',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_five',
        text: '至少保住 5 艘己方驱逐舰',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) { return s.side === 'US'; });
          var alive = aliveOf(list).length;
          return { progress: U.clamp01(alive / 5), done: alive >= 5, note: alive + '/' + list.length };
        }
      },
      {
        id: 'no_loss',
        text: '（可选）零损失',
        kind: 'secondary',
        check: function (world) {
          var lost = world.ships.filter(function (s) { return s.side === 'US' && s.sunk; }).length;
          return { progress: lost ? 0 : 1, done: lost === 0 };
        }
      }
    ],

    victory: { timeLimit: 1800 },

    search: {
      US: at(156.880, -7.940),
      JP: at(156.950, -7.880)
    },

    forces: [
      vessel('US', 'TF 31.2', 'fletcher', '邓拉普', 156.880, -7.940, 320, 22, 'flagship', 'DD-384'),
      vessel('US', 'TF 31.2', 'fletcher', '克雷文', 156.884, -7.943, 320, 22, 'screen', 'DD-382'),
      vessel('US', 'TF 31.2', 'fletcher', '莫里', 156.888, -7.946, 320, 22, 'screen', 'DD-401'),
      vessel('US', 'TF 31.2', 'fletcher', '朗', 156.872, -7.934, 320, 22, 'screen', 'DD-399'),
      vessel('US', 'TF 31.2', 'fletcher', '斯特雷特', 156.876, -7.937, 320, 22, 'screen', 'DD-407'),
      vessel('US', 'TF 31.2', 'fletcher', '斯塔克', 156.868, -7.931, 320, 22, 'screen', 'DD-406'),
      vessel('JP', '第四水雷战队', 'kagero', '岚', 156.950, -7.880, 140, 24, 'flagship', ''),
      vessel('JP', '第四水雷战队', 'kagero', '萩风', 156.954, -7.877, 140, 24, 'screen', ''),
      vessel('JP', '第四水雷战队', 'shiratsuyu', '川风', 156.946, -7.883, 140, 24, 'screen', ''),
      vessel('JP', '第四水雷战队', 'shiratsuyu', '时雨', 156.958, -7.874, 140, 24, 'screen', '')
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      if (sunk >= 3) return { result: 'win', reason: '三艘日舰沉没，运输队被打散。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '六艘驱逐舰全部损失。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 2) return { result: 'draw', reason: '击沉 ' + sunk + ' 艘，剩下的跑了。' };
        return { result: 'loss', reason: '伏击没能奏效，日方增援上岸。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 19：霍拉尼乌 —— 1943-08-18，四艘驱逐舰拦一支驳船队
   * ========================================================================== */
  Scenarios.register({
    id: 'horaniu',
    type: 'escort',
    title: '霍拉尼乌 · 拦截驳船队',
    subtitle: '四艘驱逐舰挡住一支登陆驳船队',
    date: '1943 年 8 月 18 日 00:30',
    startTime: 30 * 60,
    timeOfDay: 'night',
    location: '韦拉拉韦拉岛以北 · 霍拉尼乌外海',
    available: true,
    tags: ['夜战', '拦截', '驱逐舰'],

    env: {
      visibility: 4200,
      windDir: 150, windSpeed: 10, seaState: 3,
      weather: '阴，小雨', light: 'night', sunAzimuth: 0, rain: 0.3
    },

    playerSide: 'US',

    brief: [
      '00:30，韦拉拉韦拉岛以北。日方四艘驱逐舰掩护着一支驳船队，正从西北方向靠近霍拉尼乌。',
      '驳船上是一个大队的兵。它们只要靠上滩头，岛上就会多出一千多人。',
      '你的四艘驱逐舰要做的不是打赢一场海战 —— 是**把驳船打掉**。',
      '',
      '· 驳船很慢、很脆，但会贴着岸边跑。',
      '· 日方驱逐舰不会拼命，它们的任务是拖住你，让驳船过去。',
      '· 别为了追驱逐舰跑远 —— 驳船靠岸就算你输。'
    ],

    intel: '海岸监视哨：西北方向有驳船队，四艘驱逐舰护航，航向东南，速度约 12 节。',

    objectives: [
      {
        id: 'sink_barges',
        text: '击沉至少 2 艘驳船',
        kind: 'primary',
        check: function (world) {
          var b = transports(world, 'JP');
          var sunk = b.filter(function (s) { return s.sunk; }).length;
          return { progress: U.clamp01(sunk / 2), done: sunk >= 2, note: sunk + '/2' };
        }
      },
      {
        id: 'keep_dd',
        text: '至少保住 3 艘己方驱逐舰',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) { return s.side === 'US'; });
          var alive = aliveOf(list).length;
          return { progress: U.clamp01(alive / 3), done: alive >= 3, note: alive + '/' + list.length };
        }
      },
      {
        id: 'all_barges',
        text: '（可选）把三艘驳船全打掉',
        kind: 'secondary',
        check: function (world) {
          var b = transports(world, 'JP');
          var sunk = b.filter(function (s) { return s.sunk; }).length;
          return { progress: U.clamp01(sunk / 3), done: sunk >= 3, note: sunk + '/3' };
        }
      }
    ],

    victory: { timeLimit: 2700 },

    zones: [
      zone('landing', '霍拉尼乌滩头外海', 'landing', 156.780, -7.600, 3000)
    ],

    search: {
      US: at(156.800, -7.560),
      JP: at(156.700, -7.500)
    },

    forces: [
      vessel('US', '第 25 驱逐舰分队', 'fletcher', '尼古拉斯', 156.800, -7.560, 300, 22, 'flagship', 'DD-449'),
      vessel('US', '第 25 驱逐舰分队', 'fletcher', '奥班农', 156.804, -7.563, 300, 22, 'screen', 'DD-450'),
      vessel('US', '第 25 驱逐舰分队', 'fletcher', '泰勒', 156.808, -7.566, 300, 22, 'screen', 'DD-468'),
      vessel('US', '第 25 驱逐舰分队', 'fletcher', '切瓦利尔', 156.796, -7.557, 300, 22, 'screen', 'DD-451'),
      vessel('JP', '第二水雷战队', 'kagero', '滨风', 156.705, -7.500, 150, 24, 'flagship', ''),
      vessel('JP', '第二水雷战队', 'kagero', '矶风', 156.709, -7.497, 150, 24, 'screen', ''),
      vessel('JP', '第二水雷战队', 'fubuki', '狭雾', 156.701, -7.503, 150, 24, 'screen', ''),
      vessel('JP', '第二水雷战队', 'shiratsuyu', '时雨', 156.713, -7.494, 150, 24, 'screen', ''),
      vessel('JP', '驳船队', 'barge', '大发 1', 156.712, -7.510, 150, 8, 'transport', '', { destination: at(156.780, -7.600) }),
      vessel('JP', '驳船队', 'barge', '大发 2', 156.716, -7.507, 150, 8, 'transport', '', { destination: at(156.780, -7.600) }),
      vessel('JP', '驳船队', 'barge', '大发 3', 156.720, -7.504, 150, 8, 'transport', '', { destination: at(156.780, -7.600) })
    ],

    check: function (world) {
      var b = transports(world, 'JP');
      var sunk = b.filter(function (s) { return s.sunk; }).length;
      var landed = aliveOf(b).filter(function (s) { return world.shipInZone(s, 'landing'); }).length;
      if (landed >= 2) return { result: 'loss', reason: '两艘驳船靠上滩头，增援上岸。' };
      if (sunk >= 3) return { result: 'win', reason: '驳船队全灭，滩头安全。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '护航驱逐舰全灭。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 2) return { result: 'win', reason: '击沉 ' + sunk + ' 艘驳船，日方撤退。' };
        return { result: 'loss', reason: '驳船队突破了拦截。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 20：奥古斯塔皇后湾 —— 1943-11-02，所罗门最大的一场巡洋舰对决
   * ========================================================================== */
  Scenarios.register({
    id: 'empress_augusta',
    type: 'surface',
    title: '奥古斯塔皇后湾 · 四艘轻巡',
    subtitle: '所罗门战役里最大的一场巡洋舰对决',
    date: '1943 年 11 月 2 日 02:30',
    startTime: 2 * 3600 + 30 * 60,
    timeOfDay: 'night',
    location: '布干维尔岛西岸 · 奥古斯塔皇后湾',
    available: true,
    tags: ['夜战', '主力对决', '巡洋舰'],

    env: {
      visibility: 6000,
      windDir: 100, windSpeed: 8, seaState: 2,
      weather: '晴，无云', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '02:30，奥古斯塔皇后湾外。陆战队正在托罗基纳角登陆，你的四艘轻巡和八艘驱逐舰挡在海湾口。',
      '雷达报上来的是硬货：两艘重巡、两艘轻巡、六艘驱逐舰，从北面压下来。这是日军最后一次拿水面舰队来争夺登陆场。',
      '你的炮多、射速快，但对面是 8 英寸炮。别让它们贴到 10 公里以内。',
      '',
      '· 四艘轻巡一起打一个目标，比四艘各打各的管用得多。',
      '· 驱逐舰的鱼雷是这一仗的关键 —— 日方重巡最怕近距雷击。',
      '· 队形不要散。散开之后就是混战，混战里重巡占便宜。'
    ],

    intel: '侦察机 01:50 报告：日方舰队从拉包尔南下，两艘重巡、两艘轻巡、六艘驱逐舰，航向正南。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉至少 3 艘日方舰艇',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'hold_landing',
        text: '日方舰艇不得进入登陆区',
        kind: 'primary',
        check: function (world) {
          var inZone = world.ships.filter(function (s) {
            return s.side === 'JP' && !s.sunk && world.shipInZone(s, 'landing');
          }).length;
          return { progress: inZone ? 0 : 1, done: inZone === 0 };
        }
      },
      {
        id: 'preserve',
        text: '我方战力保持在 40% 以上',
        kind: 'primary',
        check: function (world) {
          var o = world.powerRatio('US');
          return { progress: U.clamp01(o / 0.40), done: o >= 0.40 };
        }
      }
    ],

    victory: { timeLimit: 3600 },

    zones: [
      zone('landing', '托罗基纳登陆区', 'landing', 155.120, -6.340, 4000)
    ],

    search: {
      US: at(155.000, -6.360),
      JP: at(154.900, -6.180)
    },

    forces: [
      vessel('US', 'TF 39', 'cleveland', '克利夫兰', 155.000, -6.360, 20, 20, 'flagship', 'CL-55'),
      vessel('US', 'TF 39', 'cleveland', '哥伦比亚', 155.004, -6.363, 20, 20, 'cruiser', 'CL-56'),
      vessel('US', 'TF 39', 'cleveland', '蒙彼利埃', 155.008, -6.366, 20, 20, 'cruiser', 'CL-57'),
      vessel('US', 'TF 39', 'cleveland', '丹佛', 155.012, -6.369, 20, 20, 'cruiser', 'CL-58'),
      vessel('US', 'TF 39', 'fletcher', '查尔斯·奥斯本', 154.992, -6.354, 20, 20, 'screen', 'DD-570'),
      vessel('US', 'TF 39', 'fletcher', '克拉克斯顿', 154.996, -6.357, 20, 20, 'screen', 'DD-571'),
      vessel('US', 'TF 39', 'fletcher', '戴森', 154.988, -6.351, 20, 20, 'screen', 'DD-572'),
      vessel('US', 'TF 39', 'fletcher', '斯彭斯', 154.984, -6.348, 20, 20, 'screen', 'DD-512'),
      vessel('US', 'TF 39', 'fletcher', '撒切尔', 154.980, -6.372, 20, 20, 'screen', 'DD-514'),
      vessel('US', 'TF 39', 'fletcher', '康弗斯', 154.976, -6.375, 20, 20, 'screen', 'DD-509'),
      vessel('US', 'TF 39', 'fletcher', '富特', 154.972, -6.378, 20, 20, 'screen', 'DD-511'),
      vessel('US', 'TF 39', 'fletcher', '斯坦利', 154.968, -6.381, 20, 20, 'screen', 'DD-478'),
      vessel('JP', '第五战队', 'myoko', '妙高', 154.900, -6.180, 200, 22, 'flagship', ''),
      vessel('JP', '第五战队', 'myoko', '羽黑', 154.904, -6.177, 200, 22, 'cruiser', ''),
      vessel('JP', '第三水雷战队', 'sendai', '川内', 154.896, -6.183, 200, 22, 'cruiser', ''),
      vessel('JP', '第三水雷战队', 'sendai', '阿贺野', 154.892, -6.186, 200, 22, 'cruiser', ''),
      vessel('JP', '第三水雷战队', 'shiratsuyu', '时雨', 154.908, -6.174, 200, 22, 'screen', ''),
      vessel('JP', '第三水雷战队', 'shiratsuyu', '五月雨', 154.912, -6.171, 200, 22, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '长波', 154.916, -6.168, 200, 22, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '初风', 154.920, -6.165, 200, 22, 'screen', ''),
      vessel('JP', '第三水雷战队', 'kagero', '若月', 154.924, -6.162, 200, 22, 'screen', ''),
      vessel('JP', '第三水雷战队', 'fubuki', '天雾', 154.928, -6.159, 200, 22, 'screen', '')
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      var inZone = world.ships.filter(function (s) {
        return s.side === 'JP' && !s.sunk && world.shipInZone(s, 'landing');
      }).length;
      if (inZone > 0) return { result: 'loss', reason: '日舰突入登陆区，运输船队被迫疏散。' };
      if (sunk >= 3) return { result: 'win', reason: '击沉 ' + sunk + ' 艘，日方舰队掉头撤退。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '编队全灭。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 2) return { result: 'draw', reason: '击沉 ' + sunk + ' 艘，日方脱离接触。' };
        return { result: 'loss', reason: '没能挡住日方舰队。' };
      }
      return null;
    }
  });

  /* ==========================================================================
   *  场景 21：圣乔治角 —— 1943-11-25，所罗门战役的最后一场水面战
   * ========================================================================== */
  Scenarios.register({
    id: 'cape_st_george',
    type: 'surface',
    title: '圣乔治角 · 31 节追击',
    subtitle: '五艘驱逐舰追着五艘驱逐舰打',
    date: '1943 年 11 月 25 日 01:40',
    startTime: 1 * 3600 + 40 * 60,
    timeOfDay: 'night',
    location: '布卡岛以北 · 圣乔治角外海',
    available: true,
    tags: ['夜战', '追击', '驱逐舰'],

    env: {
      visibility: 5500,
      windDir: 90, windSpeed: 6, seaState: 1,
      weather: '晴，无云', light: 'night', sunAzimuth: 0, rain: 0
    },

    playerSide: 'US',

    brief: [
      '01:40，布卡岛以北。你的五艘驱逐舰刚在布卡卸完炮弹，雷达上出现五个目标 —— 日方的运输驱逐舰正在返航。',
      '这一仗拼的不是火力，是**谁跑得快**。你的舰能跑 36 节，它们跑不了。',
      '雷达先发现、鱼雷先出手、然后用炮追着打。这是所罗门战役的最后一场水面战。',
      '',
      '· 鱼雷打头一轮，打掉队形之后再用炮追。',
      '· 追击时保持队形，别让某一条舰冲到前面去当靶子。',
      '· 天快亮了 —— 天亮之后日机就会来，别追得太远。'
    ],

    intel: '无线电测向：布卡岛以北有日方驱逐舰通讯，五艘，航向约 200°，速度约 22 节。',

    objectives: [
      {
        id: 'sink_three',
        text: '击沉三艘日方驱逐舰',
        kind: 'primary',
        check: function (world) { return objSink(world, 'JP', 3); }
      },
      {
        id: 'keep_four',
        text: '至少保住 4 艘己方驱逐舰',
        kind: 'primary',
        check: function (world) {
          var list = world.ships.filter(function (s) { return s.side === 'US'; });
          var alive = aliveOf(list).length;
          return { progress: U.clamp01(alive / 4), done: alive >= 4, note: alive + '/' + list.length };
        }
      },
      {
        id: 'no_loss',
        text: '（可选）零损失',
        kind: 'secondary',
        check: function (world) {
          var lost = world.ships.filter(function (s) { return s.side === 'US' && s.sunk; }).length;
          return { progress: lost ? 0 : 1, done: lost === 0 };
        }
      }
    ],

    victory: { timeLimit: 2400 },

    search: {
      US: at(154.160, -5.120),
      JP: at(154.260, -5.040)
    },

    forces: [
      vessel('US', '第 45 驱逐舰分队', 'fletcher', '查尔斯·奥斯本', 154.160, -5.120, 20, 30, 'flagship', 'DD-570'),
      vessel('US', '第 45 驱逐舰分队', 'fletcher', '克拉克斯顿', 154.164, -5.123, 20, 30, 'screen', 'DD-571'),
      vessel('US', '第 45 驱逐舰分队', 'fletcher', '戴森', 154.168, -5.126, 20, 30, 'screen', 'DD-572'),
      vessel('US', '第 45 驱逐舰分队', 'fletcher', '康弗斯', 154.156, -5.117, 20, 30, 'screen', 'DD-509'),
      vessel('US', '第 45 驱逐舰分队', 'fletcher', '斯彭斯', 154.152, -5.114, 20, 30, 'screen', 'DD-512'),
      vessel('JP', '第三十一驱逐舰分队', 'kagero', '大波', 154.260, -5.040, 200, 22, 'flagship', ''),
      vessel('JP', '第三十一驱逐舰分队', 'kagero', '卷波', 154.264, -5.037, 200, 22, 'screen', ''),
      vessel('JP', '第三十一驱逐舰分队', 'fubuki', '夕雾', 154.256, -5.043, 200, 22, 'screen', ''),
      vessel('JP', '第三十一驱逐舰分队', 'fubuki', '卯月', 154.268, -5.034, 200, 22, 'screen', ''),
      vessel('JP', '第三十一驱逐舰分队', 'fubuki', '天雾', 154.272, -5.031, 200, 22, 'screen', '')
    ],

    check: function (world) {
      var sunk = world.ships.filter(function (s) { return s.side === 'JP' && s.sunk; }).length;
      var usAlive = world.ships.filter(function (s) { return s.side === 'US' && !s.sunk; }).length;
      if (sunk >= 3 && usAlive >= 3) return { result: 'win', reason: '三艘日舰沉没，追击结束。' };
      if (world.allSunk('US')) return { result: 'loss', reason: '五艘驱逐舰全部损失。' };
      if (world.time >= timeLimit(world)) {
        if (sunk >= 2) return { result: 'draw', reason: '击沉 ' + sunk + ' 艘，其余跑掉了。' };
        return { result: 'loss', reason: '追击没有战果。' };
      }
      return null;
    }
  });

})(globalThis.Naval = globalThis.Naval || {});
