/* =============================================================================
 *  core.js —— 基础层：数学 / 随机 / 地理 / 时钟 / 事件总线
 *  纯逻辑，不依赖 DOM。可在 Node 中直接加载做无头测试。
 * ========================================================================== */
(function (N) {
  'use strict';

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var KNOT_MS = 0.514444;   // 1 节 = 0.514444 m/s

  /* ---------------------------------------------------------------- 数学工具 */
  var U = {
    DEG: DEG,
    RAD: RAD,
    KNOT_MS: KNOT_MS,

    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    clamp01: function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    invLerp: function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); },

    norm360: function (d) { d %= 360; return d < 0 ? d + 360 : d; },
    /** 有符号最小角差 a-b，取值 (-180, 180] */
    angDiff: function (a, b) {
      var d = (a - b) % 360;
      if (d > 180) d -= 360;
      if (d <= -180) d += 360;
      return d;
    },
    /** 把 cur 朝 target 转动，单步最大 maxStep 度 */
    approachAngle: function (cur, target, maxStep) {
      var d = U.angDiff(target, cur);
      if (Math.abs(d) <= maxStep) return U.norm360(target);
      return U.norm360(cur + Math.sign(d) * maxStep);
    },

    /** 分段线性插值表：[[x0,y0],[x1,y1],...]（x 递增） */
    table: function (pts, x) {
      if (!pts || pts.length === 0) return 0;
      if (x <= pts[0][0]) return pts[0][1];
      var n = pts.length;
      if (x >= pts[n - 1][0]) return pts[n - 1][1];
      for (var i = 1; i < n; i++) {
        if (x <= pts[i][0]) {
          var a = pts[i - 1], b = pts[i];
          var t = (x - a[0]) / (b[0] - a[0] || 1);
          return a[1] + (b[1] - a[1]) * t;
        }
      }
      return pts[n - 1][1];
    },

    /** 数字格式化 */
    fmt: function (v, digits) {
      if (!isFinite(v)) return '—';
      return v.toFixed(digits === undefined ? 0 : digits);
    },
    /** 距离显示：m -> "12.4 km" / "850 m" */
    fmtRange: function (m) {
      if (!isFinite(m)) return '—';
      if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
      return Math.round(m) + ' m';
    },
    /** 航速显示 */
    fmtSpeed: function (kn) { return (kn).toFixed(1) + ' kn'; },

    /** 0-1 之间的平滑过渡 */
    smoothstep: function (t) { t = U.clamp01(t); return t * t * (3 - 2 * t); },

    /** 角度转 16 方位文字 */
    bearingName: function (deg) {
      var names = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
        '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
      var i = Math.round(U.norm360(deg) / 22.5) % 16;
      return names[i];
    }
  };

  /* ------------------------------------------------------------------- 随机 */
  /** mulberry32：可复现的伪随机数发生器 */
  function RNG(seed) {
    this.s = (seed === undefined ? 20241114 : seed) >>> 0;
  }
  RNG.prototype.next = function () {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (a, b) { return Math.floor(this.range(a, b + 1)); };
  /** 标准正态分布（Box-Muller） */
  RNG.prototype.gauss = function () {
    var u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  /** 以 0 为中心、标准差 sigma 的截断正态 */
  RNG.prototype.dev = function (sigma) { return this.gauss() * sigma; };
  RNG.prototype.chance = function (p) { return this.next() < p; };
  RNG.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length)]; };
  RNG.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(this.next() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  /* ------------------------------------------------------------------ 向量 */
  var V = {
    make: function (x, y) { return { x: x || 0, y: y || 0 }; },
    add: function (a, b) { return { x: a.x + b.x, y: a.y + b.y }; },
    sub: function (a, b) { return { x: a.x - b.x, y: a.y - b.y }; },
    mul: function (a, k) { return { x: a.x * k, y: a.y * k }; },
    len: function (a) { return Math.sqrt(a.x * a.x + a.y * a.y); },
    dist: function (a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); },
    norm: function (a) {
      var l = Math.sqrt(a.x * a.x + a.y * a.y);
      return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
    },
    dot: function (a, b) { return a.x * b.x + a.y * b.y; },
    /** 逆时针旋转（数学正方向），单位弧度 */
    rot: function (a, rad) {
      var c = Math.cos(rad), s = Math.sin(rad);
      return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
    }
  };

  /* ------------------------------------------------------------------ 地理 */
  var Geo = {
    /** 航向（度，0=北，顺时针）转单位向量（x 东，y 北） */
    headingVec: function (headingDeg) {
      var r = headingDeg * DEG;
      return { x: Math.sin(r), y: Math.cos(r) };
    },
    /** 向量转航向 */
    vecHeading: function (v) { return U.norm360(Math.atan2(v.x, v.y) * RAD); },
    /** A 指向 B 的方位角 */
    bearing: function (from, to) {
      return U.norm360(Math.atan2(to.x - from.x, to.y - from.y) * RAD);
    },
    /** 沿某方位前进 dist 米 */
    dest: function (pos, bearingDeg, dist) {
      var v = Geo.headingVec(bearingDeg);
      return { x: pos.x + v.x * dist, y: pos.y + v.y * dist };
    },
    /**
     * 拦截航向：从 self 以 speed 追击以 tgtHeading/tgtSpeed 运动的目标，
     * 返回一个方位（度）。无解时返回直接方位。
     */
    interceptBearing: function (self, tgt, tgtHeading, tgtSpeed, speed) {
      var r = V.dist(self, tgt);
      if (r < 1) return Geo.bearing(self, tgt);
      var tv = Geo.headingVec(tgtHeading);
      var vx = tv.x * tgtSpeed, vy = tv.y * tgtSpeed;
      var dx = tgt.x - self.x, dy = tgt.y - self.y;
      // 求解 |d + v*t| = speed*t
      var a = vx * vx + vy * vy - speed * speed;
      var b = 2 * (dx * vx + dy * vy);
      var c = dx * dx + dy * dy;
      var t = -1;
      if (Math.abs(a) < 1e-6) {
        if (Math.abs(b) > 1e-9) t = -c / b;
      } else {
        var disc = b * b - 4 * a * c;
        if (disc >= 0) {
          var sq = Math.sqrt(disc);
          var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
          var cands = [t1, t2].filter(function (x) { return x > 0; });
          if (cands.length) t = Math.min.apply(null, cands);
        }
      }
      if (t <= 0) return Geo.bearing(self, tgt);
      var px = tgt.x + vx * t, py = tgt.y + vy * t;
      return U.norm360(Math.atan2(px - self.x, py - self.y) * RAD);
    },
    /**
     * 提前量：目标在 tFlight 秒后的预测位置
     */
    lead: function (tgtPos, tgtHeading, tgtSpeed, tFlight) {
      var v = Geo.headingVec(tgtHeading);
      return { x: tgtPos.x + v.x * tgtSpeed * tFlight, y: tgtPos.y + v.y * tgtSpeed * tFlight };
    },
    /**
     * 判定点 p 是否落在以 pos 为中心、朝向 heading、长 len 宽 beam 的矩形内
     * （用于命中判定；pad 为额外余量）
     */
    inShipRect: function (p, pos, heading, len, beam, pad) {
      pad = pad || 0;
      var dx = p.x - pos.x, dy = p.y - pos.y;
      var r = -heading * DEG;
      var c = Math.cos(r), s = Math.sin(r);
      // 旋转到船体坐标系：u 沿船首方向
      var u = dx * s + dy * c;
      var w = dx * c - dy * s;
      return Math.abs(u) <= len / 2 + pad && Math.abs(w) <= beam / 2 + pad;
    },
    /**
     * 两个舰体矩形是否相交（分离轴定理）。用于撞船判定。
     * a/b 需要 { pos, heading, cls: { length, beam } }
     */
    shipRectHit: function (a, b, pad) {
      pad = pad || 0;
      var dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
      var reach = (a.cls.length + b.cls.length) / 2 + pad;
      if (dx * dx + dy * dy > reach * reach) return false;
      for (var i = 0; i < 2; i++) {
        var ang = (i === 0 ? a.heading : b.heading) * DEG;
        var fwd = { x: Math.sin(ang), y: Math.cos(ang) };
        var rgt = { x: Math.cos(ang), y: -Math.sin(ang) };
        if (!this._rectOverlapAxis(a, b, fwd, dx, dy, pad)) return false;
        if (!this._rectOverlapAxis(a, b, rgt, dx, dy, pad)) return false;
      }
      return true;
    },
    /** 舰体矩形在某根轴上的半投影长度 */
    _rectRadius: function (sh, axis) {
      var ang = sh.heading * DEG;
      var fx = Math.sin(ang), fy = Math.cos(ang);
      var rx = Math.cos(ang), ry = -Math.sin(ang);
      return Math.abs(axis.x * fx + axis.y * fy) * sh.cls.length / 2 +
        Math.abs(axis.x * rx + axis.y * ry) * sh.cls.beam / 2;
    },
    _rectOverlapAxis: function (a, b, axis, dx, dy, pad) {
      var d = Math.abs(axis.x * dx + axis.y * dy);
      return d <= this._rectRadius(a, axis) + this._rectRadius(b, axis) + pad;
    },
    /** 点到线段的距离 */
    distToSegment: function (p, a, b) {
      var vx = b.x - a.x, vy = b.y - a.y;
      var wx = p.x - a.x, wy = p.y - a.y;
      var l2 = vx * vx + vy * vy;
      if (l2 < 1e-9) return Math.sqrt(wx * wx + wy * wy);
      var t = U.clamp01((wx * vx + wy * vy) / l2);
      var px = a.x + vx * t, py = a.y + vy * t;
      var dx = p.x - px, dy = p.y - py;
      return Math.sqrt(dx * dx + dy * dy);
    },
    /** 经纬度 -> 本地平面米（以 refLon/refLat 为原点） */
    lonLatToXY: function (lon, lat, refLon, refLat) {
      var mPerLat = 111320;
      var mPerLon = 111320 * Math.cos(refLat * DEG);
      return { x: (lon - refLon) * mPerLon, y: (lat - refLat) * mPerLat };
    },
    /** 本地平面米 -> 经纬度（上面那个的逆运算，写战报坐标用） */
    xyToLonLat: function (x, y, refLon, refLat) {
      var mPerLat = 111320;
      var mPerLon = 111320 * Math.cos(refLat * DEG);
      return { lon: x / mPerLon + refLon, lat: y / mPerLat + refLat };
    },
    /** 射线与多边形边界的交点检测（用于判断航路上是否有陆地） */
    segIntersectsPolygon: function (a, b, poly) {
      for (var i = 0; i < poly.length; i++) {
        var c = poly[i], d = poly[(i + 1) % poly.length];
        if (Geo._segSeg(a, b, c, d)) return true;
      }
      return false;
    },
    _segSeg: function (p1, p2, p3, p4) {
      function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x); }
      return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
    },
    pointInPolygon: function (p, poly) {
      var inside = false;
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }
  };

  /* ------------------------------------------------------------------ 时钟 */
  /**
   * 场景内时钟：以 scenario.startTime（秒，当日 0 点起算）为起点。
   */
  function Clock(startSeconds) {
    this.t = 0;                 // 场景经过秒数
    this.start = startSeconds || 0;
    this.scale = 1;             // 时间倍率
    this.paused = false;
  }
  Clock.prototype.absolute = function () { return this.start + this.t; };
  Clock.prototype.hhmmss = function () { return U.formatClock(this.absolute()); };
  Clock.prototype.hhmm = function () { return U.formatClock(this.absolute()).slice(0, 5); };

  U.formatClock = function (sec) {
    sec = ((sec % 86400) + 86400) % 86400;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    return p(h) + ':' + p(m) + ':' + p(s);
  };
  U.formatDuration = function (sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + '分' + (s < 10 ? '0' + s : s) + '秒';
  };

  /* -------------------------------------------------------------- 事件总线 */
  function EventBus() { this.map = {}; }
  EventBus.prototype.on = function (evt, fn) {
    (this.map[evt] = this.map[evt] || []).push(fn);
    return this;
  };
  EventBus.prototype.off = function (evt, fn) {
    var a = this.map[evt];
    if (!a) return this;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
    return this;
  };
  EventBus.prototype.emit = function (evt, payload) {
    var a = this.map[evt];
    if (a) for (var i = 0; i < a.length; i++) a[i](payload);
    return this;
  };

  /* ------------------------------------------------------------------ 导出 */
  N.U = U;
  N.V = V;
  N.Geo = Geo;
  N.RNG = RNG;
  N.Clock = Clock;
  N.EventBus = EventBus;

  N.const = {
    DEG: DEG,
    RAD: RAD,
    KNOT_MS: KNOT_MS,
    /** 通用伤害/装甲单位 */
    MM: 1
  };

  // 版本信息，便于排查
  N.VERSION = '0.1.0';
})(globalThis.Naval = globalThis.Naval || {});
