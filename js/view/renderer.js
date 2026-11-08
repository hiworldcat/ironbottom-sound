/* =============================================================================
 *  view/renderer.js —— Canvas 2D 渲染
 *
 *  视觉原则：
 *    · 己方舰艇是“实体”，画成带炮塔的舰影
 *    · 敌方只有“航迹”，画成带误差圈的接触符号，绝不给真实舰体
 *    · 落水水柱、浓烟、火光、鱼雷航迹 —— 这些才是你唯一能看到的敌情
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;
  var DEG = U.DEG;
  var TAU = Math.PI * 2;

  /* ==========================================================================
   *  舰况速览：血条 + 故障标签
   *
   *  海图上不可能摊开详情面板，但“这条舰还能不能打”必须一眼看得出来。
   *  血条按一级分区切段（船体 / 上层 / 武器 / 通信 / 动力），每段自己变色；
   *  坏掉的功能在船上方挂小标签 —— 只在真坏了的时候才挂。
   *  回放里也画，而且两边都画：复盘看的是真相。
   * ========================================================================== */

  /* 五个一级分区的默认权重（和 N.zonesFor 的兜底值一致） */
  var ZONE_W = [0.44, 0.15, 0.19, 0.06, 0.16];

  /** 血量比例 → 颜色 */
  function hpColor(f) {
    if (f > 0.66) return '#5fe08a';
    if (f > 0.33) return '#ffc857';
    return '#ff5f5f';
  }

  /* 和 N.Damage.FAIL 的位一一对应 */
  /* 顺序 = 严重程度 = 被 +N 吃掉的先后。
     原则：先写“还能不能打、还能不能动”，再写“能不能看、能不能报”。
     电台坏了这种事不该把“半边炮哑了”挤进 +N。 */
  var FAIL_TAGS = [
    [64, '火炮', '#ff6b6b'],   // GUNS
    [128, '鱼雷', '#8fb8ff'],  // TORPS
    [16, '舵机', '#ffc857'],   // RUDDER
    [32, '动力', '#c2ccd6'],   // POWER —— 主机
    [256, '电力', '#e8d95f'],  // ELEC —— 全船没电
    [8, '火控', '#c08bff'],    // FC
    [1, '雷达', '#4ad9d9'],    // RADAR
    [2, '电台', '#7fe0b0'],    // RADIO
    [4, '识别器', '#9be07f']   // IFF
  ];

  /* 没电的时候雷达/电台/识别器是一起灭的 —— 那是「电力」的后果，不再单独挂标签 */
  var ELEC_CAUSED = 1 | 2 | 4;

  /** 在 (sx,sy) 处沿罗经航向 hdg 画一根指针 */
  function needle(ctx, sx, sy, hdg, r, color, w, arrow, dash) {
    var a = (hdg - 90) * DEG;
    var ex = sx + Math.cos(a) * r, ey = sy + Math.sin(a) * r;
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.restore();
    if (arrow) {
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-6, -3.5);
      ctx.lineTo(-6, 3.5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
  }

  var COL = {
    seaTop: '#0a1a26',
    seaBot: '#050d14',
    grid: 'rgba(110,170,200,0.075)',
    gridMajor: 'rgba(110,170,200,0.14)',
    land: '#1a2a1d',
    landHi: '#22371f',
    landEdge: '#3c5a37',
    own: '#57d7ff',
    ownDim: '#2b7fa0',
    ownGlow: 'rgba(87,215,255,0.35)',
    contact: '#ffc15c',
    contactId: '#ff7a63',
    hostile: '#ff6b5e',
    text: '#cfe6f2',
    textDim: 'rgba(207,230,242,0.45)',
    accent: '#39e0c4',
    warn: '#ffb347',
    danger: '#ff5252',
    white: '#ffffff'
  };

  /* ------------------------------------------------------------------ 相机 */
  function Camera() {
    this.x = 0;
    this.y = 0;
    this.zoom = 0.055;        // 像素 / 米
    this.minZoom = 0.0012;
    this.maxZoom = 0.85;
  }
  Camera.prototype.w2s = function (p, W, H) {
    return { x: (p.x - this.x) * this.zoom + W / 2, y: H / 2 - (p.y - this.y) * this.zoom };
  };
  Camera.prototype.s2w = function (p, W, H) {
    return { x: (p.x - W / 2) / this.zoom + this.x, y: (H / 2 - p.y) / this.zoom + this.y };
  };
  Camera.prototype.visibleRect = function (W, H) {
    var hw = W / 2 / this.zoom, hh = H / 2 / this.zoom;
    return { x0: this.x - hw, x1: this.x + hw, y0: this.y - hh, y1: this.y + hh };
  };
  Camera.prototype.clampTo = function (bounds) {
    var mx = (bounds.x1 - bounds.x0) * 0.12;
    var my = (bounds.y1 - bounds.y0) * 0.12;
    this.x = U.clamp(this.x, bounds.x0 - mx, bounds.x1 + mx);
    this.y = U.clamp(this.y, bounds.y0 - my, bounds.y1 + my);
  };
  Camera.prototype.zoomAt = function (screenPt, factor, W, H) {
    var before = this.s2w(screenPt, W, H);
    this.zoom = U.clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    var after = this.s2w(screenPt, W, H);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  };

  /* ---------------------------------------------------------------- 渲染器 */
  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 0; this.H = 0; this.dpr = 1;
    this.resize();
    var self = this;
    window.addEventListener('resize', function () { self.resize(); });
  }

  Renderer.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = this.canvas.clientWidth || window.innerWidth;
    var h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.W = w; this.H = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /* ------------------------------------------------------------------ 主绘制 */
  Renderer.prototype.draw = function (world, ui) {
    var ctx = this.ctx, W = this.W, H = this.H, cam = ui.camera;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    this.drawSea(ctx, W, H);
    this.drawGrid(ctx, cam, W, H);
    this.drawBathymetry(ctx, cam, W, H);
    this.drawLand(ctx, cam, W, H);
    this.drawZones(ctx, world, cam, W, H);
    this.drawShoreTargets(ctx, world, cam, W, H);
    this.drawIllumination(ctx, world, cam, W, H);
    this.drawSmoke(ctx, world, cam, W, H);
    this.drawTrails(ctx, world, cam, W, H);
    this.drawWakes(ctx, world, cam, W, H);
    this.drawTorpedoes(ctx, world, cam, W, H);
    this.drawSplashes(ctx, world, cam, W, H);
    this.drawSquads(ctx, world, cam, W, H);
    this.drawTracks(ctx, world, ui, cam, W, H);
    this.drawPlanes(ctx, world, cam, W, H);
    this.drawShips(ctx, world, ui, cam, W, H);
    this.drawShipTooltip(ctx, world, ui, cam, W, H);
    this.drawAttribution(ctx, world, cam, W, H);
    this.drawSelection(ctx, world, ui, cam, W, H);
    this.drawBearingReadout(ctx, world, ui, cam, W, H);

    if (world.env && world.env.light && world.env.light !== 'day') this.drawNightTint(ctx, world, W, H);
    // 天气覆盖层：雨丝 + 低能见度的雾感（画在夜色之上、照明弹之下）
    this.drawWeather(ctx, world, W, H);
    // 照明弹画在夜色之上：它是光源，不该被夜色压暗
    this.drawIllumination(ctx, world, cam, W, H);

    this.drawCompass(ctx, world, ui, W, H);
    this.drawScale(ctx, cam, W, H);
    this.drawWind(ctx, world, W, H);

    ctx.restore();
  };

  /* ------------------------------------------------------- 岛屿包围盒 / 可见性 */
  function islandBB(is) {
    // World.isLand 也会缓存 _bb，但它只有 x0/y0/x1/y1，没有中心点
    if (is._bb && is._bb.cx !== undefined) return is._bb;
    var x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (var i = 0; i < is.poly.length; i++) {
      var p = is.poly[i];
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    is._bb = { x0: x0, y0: y0, x1: x1, y1: y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    return is._bb;
  }
  function bbVisible(bb, cam, W, H, pad) {
    pad = pad || 0;
    var a = cam.w2s({ x: bb.x0, y: bb.y1 }, W, H);   // 左上
    var b = cam.w2s({ x: bb.x1, y: bb.y0 }, W, H);   // 右下
    return !(b.x < -pad || a.x > W + pad || b.y < -pad || a.y > H + pad);
  }
  function pathIsland(ctx, poly, cam, W, H) {
    ctx.beginPath();
    for (var j = 0; j < poly.length; j++) {
      var p = cam.w2s(poly[j], W, H);
      if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  /* -------------------------------------------------------------------- 海面 */
  Renderer.prototype.drawSea = function (ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, COL.seaTop);
    g.addColorStop(1, COL.seaBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 轻微的深浅变化，避免大面积纯色
    var rg = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.75);
    rg.addColorStop(0, 'rgba(30,90,120,0.10)');
    rg.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  };

  /* ---------------------------------------------------------------- 近岸水深 */
  /*
   * 用「以岛界为中心线的粗描边」模拟等深线：描边有一半落在陆地下面，
   * 露出水面的那一半就是一条从海岸向外变深的浅水带。比真的做多边形
   * 内缩便宜得多，视觉上已经足够像海图。
   */
  Renderer.prototype.drawBathymetry = function (ctx, cam, W, H) {
    var isl = N.ISLANDS;
    var bands = [
      [11000, 'rgba(44,116,146,0.055)'],
      [5200, 'rgba(48,132,160,0.075)'],
      [2000, 'rgba(56,152,176,0.10)']
    ];
    ctx.save();
    ctx.lineJoin = 'round';
    for (var i = 0; i < isl.length; i++) {
      var bb = islandBB(isl[i]);
      if (!bbVisible(bb, cam, W, H, 200)) continue;
      for (var b = 0; b < bands.length; b++) {
        var lw = bands[b][0] * 2 * cam.zoom;
        if (lw < 1.5) continue;
        pathIsland(ctx, isl[i].poly, cam, W, H);
        ctx.lineWidth = lw;
        ctx.strokeStyle = bands[b][1];
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  Renderer.prototype.drawGrid = function (ctx, cam, W, H) {
    var r = cam.visibleRect(W, H);
    var step = 5000;
    // 缩放太小时放大网格间距
    while (step * cam.zoom < 45) step *= 2;
    var x0 = Math.floor(r.x0 / step) * step;
    var y0 = Math.floor(r.y0 / step) * step;

    ctx.lineWidth = 1;
    ctx.font = '10px "Consolas", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (var x = x0; x <= r.x1; x += step) {
      var sx = (x - cam.x) * cam.zoom + W / 2;
      var major = Math.abs(x) % (step * 4) < 1;
      ctx.strokeStyle = major ? COL.gridMajor : COL.grid;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (var y = y0; y <= r.y1; y += step) {
      var sy = H / 2 - (y - cam.y) * cam.zoom;
      var major2 = Math.abs(y) % (step * 4) < 1;
      ctx.strokeStyle = major2 ? COL.gridMajor : COL.grid;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }

    // 主网格标尺：只在缩得比较远的时候显示，避免糊在舰艇上
    if (cam.zoom > 0.02) return;
    ctx.font = '10px "Consolas", monospace';
    ctx.fillStyle = 'rgba(120,180,205,0.35)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (var gx = x0; gx <= r.x1; gx += step * 4) {
      var gsx = (gx - cam.x) * cam.zoom + W / 2;
      if (gsx < 4 || gsx > W - 60) continue;
      ctx.fillText((Math.abs(gx) / 1000).toFixed(0) + (gx < 0 ? 'W' : 'E'), gsx + 3, 4);
    }
    for (var gy = y0; gy <= r.y1; gy += step * 4) {
      var gsy = H / 2 - (gy - cam.y) * cam.zoom;
      if (gsy < 4 || gsy > H - 16) continue;
      ctx.fillText((Math.abs(gy) / 1000).toFixed(0) + (gy < 0 ? 'S' : 'N'), 4, gsy + 2);
    }
  };

  /* -------------------------------------------------------------------- 陆地 */
  Renderer.prototype.drawLand = function (ctx, cam, W, H) {
    var isl = N.ISLANDS;
    var i, bb;

    for (i = 0; i < isl.length; i++) {
      bb = islandBB(isl[i]);
      if (!bbVisible(bb, cam, W, H, 160)) continue;
      var poly = isl[i].poly;

      pathIsland(ctx, poly, cam, W, H);

      var top = cam.w2s({ x: bb.cx, y: bb.y1 }, W, H).y;
      var bot = cam.w2s({ x: bb.cx, y: bb.y0 }, W, H).y;
      var g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, COL.landHi);
      g.addColorStop(1, COL.land);
      ctx.fillStyle = g;
      ctx.fill();

      // 岛内等高线：把海岸线往内偏移着画几圈，用描边 + 裁剪实现，
      // 比把轮廓按比例缩向重心靠谱得多（真实海岸线是不规则形状）
      ctx.save();
      ctx.clip();
      /* 等高线按真实海拔来：萨沃 485 米画出来是层层叠叠的锥，图拉吉 100 米
         就只是一道浅边。这是玩家判断"哪座岛藏得住船"的唯一线索 ——
         地图上看见的，和模拟里算遮挡的，必须是同一件事。 */
      var pk = isl[i].peak || 0;
      var nRing = pk >= 1200 ? 6 : pk >= 500 ? 5 : pk >= 200 ? 3 : pk > 0 ? 2 : 1;
      for (var k = 0; k < nRing; k++) {
        pathIsland(ctx, poly, cam, W, H);
        ctx.strokeStyle = 'rgba(140,190,120,' + (0.045 + 0.022 * (nRing - k)) + ')';
        ctx.lineWidth = Math.max(1, (bb.x1 - bb.x0) * cam.zoom * 0.03 * (k + 1));
        ctx.stroke();
      }
      // 山脊高光：越高的山越亮
      var ridgeA = U.clamp(pk / 1500, 0.08, 0.36);
      var rg = ctx.createRadialGradient(
        cam.w2s({ x: bb.cx, y: bb.cy }, W, H).x, cam.w2s({ x: bb.cx, y: bb.cy }, W, H).y, 0,
        cam.w2s({ x: bb.cx, y: bb.cy }, W, H).x, cam.w2s({ x: bb.cx, y: bb.cy }, W, H).y,
        Math.max(8, (bb.x1 - bb.x0) * cam.zoom * 0.6)
      );
      rg.addColorStop(0, 'rgba(96,132,86,' + ridgeA.toFixed(2) + ')');
      rg.addColorStop(1, 'rgba(96,132,86,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 海岸线 + 浪花
      pathIsland(ctx, poly, cam, W, H);
      ctx.strokeStyle = COL.landEdge;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(150,215,205,0.16)';
      ctx.lineWidth = 3.2;
      ctx.stroke();
    }

    // 岛屿名称
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < isl.length; i++) {
      if (!isl[i].label) continue;              // 无名小岛只画轮廓
      bb = islandBB(isl[i]);
      var anchor = isl[i].labelPos || { x: bb.cx, y: bb.cy };
      var s = cam.w2s(anchor, W, H);
      if (s.x < -80 || s.x > W + 80 || s.y < -30 || s.y > H + 30) continue;
      var span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * cam.zoom;
      if (span < 26) continue;
      var fs = Math.round(U.clamp(span * 0.12, 10, 17));
      ctx.font = '600 ' + fs + 'px "Microsoft YaHei", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(isl[i].label, s.x + 1, s.y + 1);
      ctx.fillStyle = 'rgba(168,214,178,' + (fs > 12 ? 0.72 : 0.55) + ')';
      ctx.fillText(isl[i].label, s.x, s.y);
      // 山顶标高：拉近了才写，说明这座岛够不够高挡住视线
      if (isl[i].peak >= 100 && span > 110 && cam.zoom > 0.04) {
        var pfs = Math.round(U.clamp(span * 0.055, 9, 12));
        ctx.font = '500 ' + pfs + 'px "Microsoft YaHei", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(146,190,156,0.46)';
        ctx.fillText('▲ ' + isl[i].peak + ' m', s.x, s.y + fs * 1.2);
      }
    }

    // 海峡 / 海湾标注
    var labs = N.MAP.labels || [];
    ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
    for (i = 0; i < labs.length; i++) {
      var lp = cam.w2s(labs[i].pos, W, H);
      if (lp.x < -60 || lp.x > W + 60 || lp.y < -20 || lp.y > H + 20) continue;
      ctx.fillStyle = 'rgba(120,190,215,0.42)';
      ctx.textAlign = 'center';
      ctx.fillText(labs[i].text, lp.x, lp.y);
    }
  };

  /* -------------------------------------------------------------------- 特效 */
  Renderer.prototype.drawSmoke = function (ctx, world, cam, W, H) {
    for (var i = 0; i < world.smokes.length; i++) {
      var sm = world.smokes[i];
      var s = cam.w2s(sm.pos, W, H);
      var rr = sm.radius * cam.zoom;
      if (s.x < -rr || s.x > W + rr || s.y < -rr || s.y > H + rr) continue;
      var age = world.time - sm.born;
      var a = U.clamp01(1 - age / sm.life) * 0.30;
      var g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, Math.max(4, rr));
      g.addColorStop(0, 'rgba(200,205,210,' + a + ')');
      g.addColorStop(0.6, 'rgba(160,168,175,' + (a * 0.6) + ')');
      g.addColorStop(1, 'rgba(140,150,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(4, rr), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /**
   * 回放专用：每艘舰最近 90 秒的运动轨迹，用来复盘双方的机动。
   */
  Renderer.prototype.drawTrails = function (ctx, world, cam, W, H) {
    if (!world.replay || !world.ships) return;
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      var tl = sh.trail;
      if (!tl || tl.length < 2) continue;
      var foe = sh.side !== world.playerSide;
      ctx.save();
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (var j = 1; j < tl.length; j++) {
        var a = cam.w2s(tl[j - 1], W, H);
        var b = cam.w2s(tl[j], W, H);
        var k = 0.08 + 0.42 * (j / tl.length);
        ctx.strokeStyle = foe
          ? 'rgba(255,150,110,' + k.toFixed(3) + ')'
          : 'rgba(120,215,255,' + k.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawWakes = function (ctx, world, cam, W, H) {
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      if (sh.side !== world.playerSide && !world.showAllSides) continue;
      if (!sh.wake || sh.wake.length < 2) continue;
      var foe = sh.side !== world.playerSide;
      var wv = this.plotView(world, sh);
      if (wv && (world.time - (wv.reportedAt || 0)) > 18) continue;
      ctx.beginPath();
      for (var j = 0; j < sh.wake.length; j++) {
        var p = cam.w2s(sh.wake[j], W, H);
        if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = foe ? 'rgba(255,170,140,0.16)' : 'rgba(160,220,255,0.16)';
      ctx.lineWidth = Math.max(1, 5 * cam.zoom * 10);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  };

  Renderer.prototype.drawTorpedoes = function (ctx, world, cam, W, H) {
    var replay = !!world.replay;
    for (var i = 0; i < world.torpedoes.length; i++) {
      var t = world.torpedoes[i];
      var own = t.side === world.playerSide;
      // 实战里没被发现的敌方鱼雷看不见；回放是上帝视角，一律画出来
      if (!own && !t.spotted && !replay) continue;
      var unseen = !own && !t.spotted;          // 回放里“当时其实没发现”
      var a = cam.w2s(t.start || t.pos, W, H);
      var b = cam.w2s(t.pos, W, H);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (own) {
        ctx.strokeStyle = 'rgba(120,230,255,0.55)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([]);
      } else if (unseen) {
        // 未被发现的鱼雷：暗橙点线，提醒玩家“你当时根本不知道它来了”
        ctx.strokeStyle = 'rgba(255,140,110,0.34)';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([2, 5]);
      } else {
        ctx.strokeStyle = 'rgba(255,120,90,0.75)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // 雷头
      ctx.beginPath();
      ctx.arc(b.x, b.y, own ? 2.2 : 2.8, 0, Math.PI * 2);
      ctx.fillStyle = own ? 'rgba(150,240,255,0.9)'
        : (unseen ? 'rgba(255,150,120,0.55)' : 'rgba(255,120,90,0.95)');
      ctx.fill();
    }
  };

  Renderer.prototype.drawSplashes = function (ctx, world, cam, W, H) {
    var replay = !!world.replay;
    for (var i = 0; i < world.splashes.length; i++) {
      var sp = world.splashes[i];
      var s = cam.w2s(sp.pos, W, H);
      var rr = Math.max(1.5, sp.r * cam.zoom);
      var life = U.clamp01(1 - sp.t / sp.life);
      var isEnemy = sp.side !== world.playerSide;

      ctx.beginPath();
      ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
      if (sp.kind === 'dud') {
        ctx.strokeStyle = 'rgba(255,180,90,' + (life * 0.8) + ')';
      } else if (sp.kind === 'near') {
        // 近失弹：水柱更大更白，边缘带一点暖色，一眼能看出「差一点」
        ctx.strokeStyle = 'rgba(255,236,210,' + (life * 0.9) + ')';
      } else if (replay && sp.kind !== 'torpedo') {
        // 回放里按发射方染色，一眼看出这轮齐射是谁打的
        ctx.strokeStyle = isEnemy
          ? 'rgba(255,150,120,' + (life * 0.85) + ')'
          : 'rgba(150,235,255,' + (life * 0.85) + ')';
      } else {
        ctx.strokeStyle = 'rgba(230,245,255,' + (life * 0.75) + ')';
      }
      ctx.lineWidth = sp.kind === 'torpedo' ? 2.5 : (sp.kind === 'near' ? 2 : 1.5);
      ctx.stroke();

      if (sp.kind === 'torpedo') {
        ctx.fillStyle = 'rgba(255,200,120,' + (life * 0.35) + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, rr * 0.5, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = sp.kind === 'near'
          ? 'rgba(255,240,220,' + (life * 0.30) + ')'
          : 'rgba(210,235,255,' + (life * 0.22) + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, rr * 0.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  };

  /* -------------------------------------------------------- 回放：交战溯源 */
  /* 回放是上帝视角：每发水柱、每条鱼雷都要标出是谁打的，
     哪怕当时瞭望哨根本没看见。放大到一定比例才显示文字，避免糊成一片。 */
  var LABEL_ZOOM = 0.055;

  function drawTag(ctx, x, y, text, color) {
    ctx.save();
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(6,12,20,0.74)';
    ctx.fillRect(x - 2, y - 7, w + 7, 14);
    ctx.strokeStyle = 'rgba(120,190,220,0.20)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2.5, y - 7.5, w + 8, 15);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 1.5, y);
    ctx.restore();
  }

  function calText(mm) {
    if (!mm) return '';
    var inch = mm / 25.4;
    var v = inch >= 7.5 ? Math.round(inch) : Math.round(inch * 10) / 10;
    return v + '″';
  }

  Renderer.prototype.drawAttribution = function (ctx, world, cam, W, H) {
    if (!world.replay) return;
    if (cam.zoom < LABEL_ZOOM) return;

    var byId = {};
    for (var i = 0; i < world.ships.length; i++) byId[world.ships[i].id] = world.ships[i];

    function onScreen(p) {
      var s = cam.w2s(p, W, H);
      return s.x > -60 && s.x < W + 60 && s.y > -40 && s.y < H + 40 ? s : null;
    }

    /* --- 水柱：每个发射舰只标最“新”的一发，避免刷屏 --- */
    var freshest = {};
    for (i = 0; i < world.splashes.length; i++) {
      var sp = world.splashes[i];
      if (!sp.ownerName || sp.kind === 'torpedo' || sp.kind === 'dud') continue;
      var k = sp.ownerName;
      if (!freshest[k] || sp.r > freshest[k].r) freshest[k] = sp;
    }
    for (var nm in freshest) {
      var s0 = freshest[nm];
      var s = onScreen(s0.pos);
      if (!s) continue;
      var own = s0.side === world.playerSide;
      var text = nm + (s0.cal ? ' ' + calText(s0.cal) : '');
      drawTag(ctx, s.x + 8, s.y - 8, text,
        own ? 'rgba(165,240,255,0.96)' : 'rgba(255,178,148,0.96)');

      // 一条极淡的引线，指向开火的舰
      var sh = s0.ownerId ? byId[s0.ownerId] : null;
      if (sh && sh.pos) {
        var e = onScreen(sh.pos);
        if (e) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(e.x, e.y);
          ctx.strokeStyle = own ? 'rgba(120,220,255,0.16)' : 'rgba(255,140,110,0.16)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }

    /* --- 鱼雷：起点标注发射舰，未发现的额外提示 --- */
    for (i = 0; i < world.torpedoes.length; i++) {
      var t = world.torpedoes[i];
      if (!t.ownerName) continue;
      var a = onScreen(t.start || t.pos);
      if (!a) continue;
      var ownT = t.side === world.playerSide;
      var label = t.ownerName + ' 鱼雷';
      if (!ownT && !t.spotted) label += '（当时未发现）';
      drawTag(ctx, a.x + 6, a.y + 12, label,
        ownT ? 'rgba(165,240,255,0.96)'
          : (!t.spotted ? 'rgba(255,190,150,0.72)' : 'rgba(255,178,148,0.96)'));
    }
  };

  /* -------------------------------------------------------------------- 航迹 */
  Renderer.prototype.drawTracks = function (ctx, world, ui, cam, W, H) {
    var list = N.Sensors.trackList(world, world.playerSide);
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      var s = cam.w2s(tr.pos, W, H);
      if (s.x < -200 || s.x > W + 200 || s.y < -200 || s.y > H + 200) continue;

      var age = tr.age != null ? tr.age : world.time - tr.lastSeen;
      var stale = age > 45;
      var identified = tr.idLevel >= N.Sensors.ID.TYPE && !tr.esmOnly && !tr.fromFlash;
      // 电探只能测向：紫色，且画一条方位线出来
      var esm = !!tr.esmOnly;
      // 炮口闪光：不是一条船，是"那边有人在开炮"，暖橙色
      var flash = !!tr.fromFlash;
      var col = esm ? '#d9a6ff' : (flash ? '#ffb060' : (identified ? COL.contactId : COL.contact));
      var alpha = stale ? 0.45 : 1.0;
      var unc = Math.max(14, tr.uncertainty * cam.zoom);
      var selected = ui.selectedTrackId === tr.id;

      ctx.save();
      ctx.globalAlpha = alpha;

      /* 电探方位线：从本阵一直拉过接触点，说明"只知道在这个方向上" */
      if (esm) {
        var ref = world.playerReference();
        var rs = cam.w2s(ref, W, H);
        var dx = s.x - rs.x, dy = s.y - rs.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        ctx.beginPath();
        ctx.moveTo(rs.x, rs.y);
        ctx.lineTo(s.x + dx / len * 60, s.y + dy / len * 60);
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = 'rgba(217,166,255,0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 误差圈。雷达的测距准、测向糊 —— 画出来是一条沿视线的细长椭圆，
      // 而不是一个漂亮的圆。这就是雷达该有的样子。
      var useEllipse = !esm && tr.errR > 0 && tr.errC > 0 && tr.axis != null &&
        Math.abs(tr.errC - tr.errR) > tr.errR * 0.25;
      ctx.beginPath();
      if (useEllipse) {
        var aR = Math.max(10, tr.errR * cam.zoom);
        var aC = Math.max(10, tr.errC * cam.zoom);
        var rot = (tr.axis - 90) * DEG;      // 长轴沿视线方向
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(rot);
        ctx.ellipse(0, 0, aC, aR, 0, 0, Math.PI * 2);
        ctx.restore();
      } else {
        ctx.arc(s.x, s.y, unc, 0, Math.PI * 2);
      }
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.55)'
        : (esm ? 'rgba(217,166,255,0.38)' : 'rgba(255,193,92,0.32)');
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      if (selected) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, unc, 0, Math.PI * 2);
        ctx.fillStyle = esm ? 'rgba(217,166,255,0.07)' : 'rgba(255,193,92,0.06)';
        ctx.fill();
      }

      // 接触符号
      if (identified) {
        this.drawContactHull(ctx, s.x, s.y, tr.course, tr.typeGuess, col);
      } else {
        // 未知接触：问号菱形
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
      }

      /* ---- 火光：这条船在烧 ----
         只有瞭望哨看得见（雷达对一团火无感），所以 tr.fireSeen 只由目视刷新，
         看不见之后会慢慢变旧 —— 图上写「火光 42s前」，你自己掂量还准不准。 */
      var fireAge = tr.seenFireAt ? world.time - tr.seenFireAt : 1e9;
      var burning = (tr.fireSeen || 0) >= 12 && fireAge < 150 && !flash;
      if (burning) {
        var fA = U.clamp01((tr.fireSeen - 12) / 40) * 0.9 + 0.35;
        var fFade = fireAge > 90 ? U.clamp01(1 - (fireAge - 90) / 60) : 1;
        ctx.save();
        ctx.globalAlpha = alpha * fA * fFade;
        // 一小簇火苗
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 13);
        ctx.quadraticCurveTo(s.x + 4.5, s.y - 8, s.x, s.y - 4);
        ctx.quadraticCurveTo(s.x - 4.5, s.y - 8, s.x, s.y - 13);
        ctx.fillStyle = '#ff9a3c';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 10.5);
        ctx.quadraticCurveTo(s.x + 2.2, s.y - 8, s.x, s.y - 5.5);
        ctx.quadraticCurveTo(s.x - 2.2, s.y - 8, s.x, s.y - 10.5);
        ctx.fillStyle = '#ffe08a';
        ctx.fill();
        // 光晕
        var fg = ctx.createRadialGradient(s.x, s.y - 8, 0, s.x, s.y - 8, 16);
        fg.addColorStop(0, 'rgba(255,150,60,0.30)');
        fg.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.beginPath();
        ctx.arc(s.x, s.y - 8, 16, 0, Math.PI * 2);
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.restore();
      }

      // 航向箭头（电探和闪光都没有航向，别画）
      if (tr.speed > 1 && !esm && !flash) {
        var hv = Geo.headingVec(tr.course);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + hv.x * 22, s.y - hv.y * 22);
        ctx.strokeStyle = 'rgba(255,193,92,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 标签
      var label = esm ? '雷达辐射源' : N.Sensors.idText(tr);
      if (flash) label = '炮口闪光';
      var dist = V.dist(world.playerReference(), tr.pos);
      var errTxt = tr.uncertainty >= 1000
        ? '±' + (tr.uncertainty / 1000).toFixed(1) + 'km'
        : '±' + Math.round(tr.uncertainty) + 'm';
      // 椭圆的接触：把两个方向分开写，让人一眼看出"测距准、测向糊"
      if (useEllipse) {
        var f = function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'km' : Math.round(v) + 'm'; };
        errTxt = '测距±' + f(tr.errR) + ' 测向±' + f(tr.errC);
      }
      ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col;
      ctx.fillText(label, s.x + unc + 6, s.y - 7);
      ctx.fillStyle = esm ? 'rgba(217,166,255,0.72)' : 'rgba(255,193,92,0.65)';
      ctx.font = '10px "Consolas", monospace';
      ctx.fillText(((esm || flash) ? '仅方位  ' : U.fmtRange(dist) + '  ') +
        ((esm || flash) ? '' : Math.round(tr.course) + '° / ' + tr.speed.toFixed(0) + 'kn  ') +
        errTxt + (age >= 5 ? '  ' + Math.round(age) + 's前' : '') +
        (stale ? '  (陈旧)' : '') +
        (burning ? '  火光' + (fireAge > 20 ? ' ' + Math.round(fireAge) + 's前' : '') : ''),
        s.x + unc + 6, s.y + 7);

      ctx.restore();
    }
  };

  /** 已识别目标的轮廓（依据推断舰种，尺寸是估计值） */
  Renderer.prototype.drawContactHull = function (ctx, x, y, course, type, col) {
    var L = type === 'CA' ? 17 : (type === 'CL' ? 15 : 11);
    var B = type === 'CA' ? 4 : (type === 'CL' ? 3.6 : 3);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((course - 90) * DEG);
    ctx.beginPath();
    ctx.moveTo(L * 0.55, 0);
    ctx.lineTo(L * 0.15, -B);
    ctx.lineTo(-L * 0.5, -B * 0.8);
    ctx.lineTo(-L * 0.5, B * 0.8);
    ctx.lineTo(L * 0.15, B);
    ctx.closePath();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,120,99,0.12)';
    ctx.fill();
    ctx.restore();
  };

  /* ------------------------------------------------------------- 水上侦察机 */
  /**
   * 水侦画成一个小飞机 + 一条淡淡的航迹，外面套一圈"飞行员能看多远"的
   * 搜索圈。圈是虚的：它只说明飞机此刻能看见的范围，不是雷达覆盖。
   */
  Renderer.prototype.drawPlanes = function (ctx, world, cam, W, H) {
    if (!world.planes || !world.planes.length) return;
    var own = world.playerSide;
    for (var i = 0; i < world.planes.length; i++) {
      var p = world.planes[i];
      var s = cam.w2s(p.pos, W, H);
      if (s.x < -120 || s.x > W + 120 || s.y < -120 || s.y > H + 120) continue;
      var mine = p.side === own;
      var col = mine ? 'rgba(150,220,255,0.95)' : 'rgba(255,150,150,0.9)';

      // 航迹
      if (p.trail && p.trail.length > 1) {
        ctx.beginPath();
        for (var k = 0; k < p.trail.length; k++) {
          var ts = cam.w2s(p.trail[k], W, H);
          if (k === 0) ctx.moveTo(ts.x, ts.y); else ctx.lineTo(ts.x, ts.y);
        }
        ctx.strokeStyle = mine ? 'rgba(150,220,255,0.22)' : 'rgba(255,150,150,0.18)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 搜索圈
      var sr = (N.Floatplane ? N.Floatplane.sightRange(world) : 20000) * cam.zoom;
      if (sr > 20 && sr < Math.max(W, H) * 1.4) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, sr, 0, Math.PI * 2);
        ctx.strokeStyle = mine ? 'rgba(150,220,255,0.13)' : 'rgba(255,150,150,0.10)';
        ctx.setLineDash([2, 7]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 小飞机
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((p.heading - 90) * DEG);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(1.6, 0);
      ctx.lineTo(6, 2.4);
      ctx.lineTo(1.6, 3.4);
      ctx.lineTo(0, 6);
      ctx.lineTo(-1.6, 3.4);
      ctx.lineTo(-6, 2.4);
      ctx.lineTo(-1.6, 0);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();

      // 标注
      if (cam.zoom > 0.03) {
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = mine ? 'rgba(150,220,255,0.8)' : 'rgba(255,150,150,0.7)';
        var st = p.state === 'back' ? '返航' : (p.state === 'search' ? '搜索' : '出航');
        ctx.fillText(p.name + ' · ' + st, s.x + 9, s.y - 9);
      }
    }
  };

  /* -------------------------------------------------------------------- 舰艇 */
  /**
   * 己方舰画在"图上位置"上，不是真实位置。
   * 视距内指挥舰直接看得见，图上位置就是真位置；视距外只能靠无线电报告，
   * 位置是几十秒前的，还带导航误差。回放看的是真相，不走这套。
   */
  Renderer.prototype.plotView = function (world, sh) {
    if (!N.Command || world.replay || sh.side !== world.playerSide) return null;
    return N.Command.ownView(world, sh);
  };

  Renderer.prototype.drawShips = function (ctx, world, ui, cam, W, H) {
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      // 敌方永远不画真实舰体；回放模式除外（那是复盘，看的是真相）
      if (sh.side !== world.playerSide && !world.showAllSides) continue;
      if (sh.sunk) continue;
      var pv = this.plotView(world, sh);
      var pp = (pv && pv.pos) ? pv.pos : sh.pos;
      var s = cam.w2s(pp, W, H);
      if (s.x < -150 || s.x > W + 150 || s.y < -150 || s.y > H + 150) continue;
      var foe = sh.side !== world.playerSide;
      var stale = pv ? (world.time - (pv.reportedAt || 0)) > 18 : false;
      this.drawShip(ctx, sh, s.x, s.y, cam.zoom, ui, foe,
        pv && pv.heading != null ? pv.heading : sh.heading, stale, pv);

      /* 舰况速览：己方舰一直显示；回放里两边都显示（复盘看的是真相） */
      if (!foe || world.replay) {
        var sL = Math.max(sh._replay ? 22 : 12, sh.cls.length * cam.zoom);
        var sB = Math.max(sh._replay ? 8 : 4, sh.cls.beam * cam.zoom);
        this.drawShipStatus(ctx, sh, s.x, s.y, sL, sB, {
          alpha: stale ? 0.5 : 1,
          report: pv
        });
      }

      // 回放：指令航向（和实际航向不一致时）与舰名
      if (world.replay) {
        // 当时的航向命令目标点
        if (sh.moveTarget && !sh.sunk) {
          var mp = cam.w2s(sh.moveTarget, W, H);
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(mp.x, mp.y);
          ctx.setLineDash([2, 6]);
          ctx.strokeStyle = foe ? 'rgba(255,170,140,0.30)' : 'rgba(120,215,255,0.30)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(mp.x - 4, mp.y - 4); ctx.lineTo(mp.x + 4, mp.y + 4);
          ctx.moveTo(mp.x + 4, mp.y - 4); ctx.lineTo(mp.x - 4, mp.y + 4);
          ctx.strokeStyle = foe ? 'rgba(255,170,140,0.55)' : 'rgba(120,215,255,0.55)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();
        }
        if (sh.orderedHeading != null && !sh.sunk) {
          var diff = Math.abs(U.angDiff(sh.orderedHeading, sh.heading));
          if (diff > 8) {
            var v = Geo.headingVec(sh.orderedHeading);
            var len = Math.max(26, 1600 * cam.zoom);
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(s.x + v.x * len, s.y - v.y * len);
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = 'rgba(255,205,120,0.60)';
            ctx.lineWidth = 1.1;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(s.x + v.x * len, s.y - v.y * len, 2.2, 0, TAU);
            ctx.fillStyle = 'rgba(255,205,120,0.75)';
            ctx.fill();
            ctx.restore();
          }
        }

        var L = Math.max(22, sh.cls.length * cam.zoom);
        var nm = sh.name;
        if (sh.sunk) nm += '（已沉没）';
        else if (sh.speed > 0.4) nm += '  ' + Math.round(sh.speed) + 'kn';
        ctx.save();
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var tw = ctx.measureText(nm).width;
        var ty = s.y + L * 0.6 + 6;
        ctx.fillStyle = 'rgba(6,12,20,0.62)';
        ctx.fillRect(s.x - tw / 2 - 3, ty - 1, tw + 6, 13);
        ctx.fillStyle = sh.sunk ? 'rgba(150,160,170,0.85)'
          : (foe ? 'rgba(255,178,148,0.95)' : 'rgba(180,235,255,0.95)');
        ctx.fillText(nm, s.x, ty);
        ctx.restore();
      }
    }
  };

  /**
   * 五个一级分区的血量比例（0~1）。
   * 三种来源，优先级从高到低：
   *   1. pv   —— 指挥舰收到的**报告**（视距外的舰，这是唯一正确的来源）
   *   2. sh.zfrac —— 回放壳舰，录像里录下来的
   *   3. 现算 —— 指挥舰自己、或者视距内直接看得见的舰
   */
  Renderer.prototype.shipHealth = function (sh, pv) {
    if (pv && pv.zfrac && pv.zfrac.length === 5) return pv.zfrac;
    if (sh.zfrac && sh.zfrac.length === 5) return sh.zfrac;
    if (N.Damage && N.Damage.zoneFracs) return N.Damage.zoneFracs(sh);
    var z = sh.zone || {}, zm = sh.zoneMax || {};
    function f(cur, max) { return max > 0 ? U.clamp01(cur / max) : 1; }
    return [
      f(sh.hull, sh.hullMax),
      f(z.superstructure, zm.superstructure),
      f(z.weapons, zm.weapons),
      f(z.comms, zm.comms),
      f(z.power, zm.power)
    ];
  };

  /** 这条舰现在该挂哪些标签（没毛病就返回空数组）。pv 是报告，有就用报告的 */
  Renderer.prototype.shipTags = function (sh, pv) {
    var out = [];
    var src = (pv && pv.zfrac) ? pv : sh;
    var flood = src.flood != null ? src.flood : sh.flood;
    var fire = src.fire != null ? src.fire : sh.fire;
    if ((flood || 0) >= 6) out.push({ t: '进水', c: '#4aa8ff' });
    if ((fire || 0) >= 5) out.push({ t: '火灾', c: '#ff8a3d' });
    var mask = (src.failMask != null) ? src.failMask
      : ((N.Damage && N.Damage.failMask) ? N.Damage.failMask(sh) : 0);
    if (mask & 256) mask &= ~ELEC_CAUSED;
    for (var i = 0; i < FAIL_TAGS.length; i++) {
      if (mask & FAIL_TAGS[i][0]) out.push({ t: FAIL_TAGS[i][1], c: FAIL_TAGS[i][2] });
    }
    return out;
  };

  /**
   * 画一条舰的血条和故障标签。
   * (x,y) 是舰体在屏幕上的中心，L/B 是舰影的长宽（像素）。
   */
  Renderer.prototype.drawShipStatus = function (ctx, sh, x, y, L, B, opts) {
    opts = opts || {};
    var pv = opts.report || null;
    var bars = this.shipHealth(sh, pv);
    var hurt = false, i;
    for (i = 0; i < bars.length; i++) { if (bars[i] < 0.995) hurt = true; }

    /* ---- 血条：五段拼成一条，按分区权重分宽度 ---- */
    var wts = (sh.zones && sh.zones.hull) ? [
      sh.zones.hull, sh.zones.superstructure, sh.zones.weapons,
      sh.zones.comms, sh.zones.power
    ] : ZONE_W;
    var wsum = 0;
    for (i = 0; i < 5; i++) wsum += (wts[i] || 0);
    if (!(wsum > 0)) { wts = ZONE_W; wsum = 1; }

    var w = U.clamp(L * 1.2, 18, 54);
    var hgt = hurt ? 3.4 : 2.6;
    var bx = x - w / 2;
    var by = y - B * 0.5 - 6 - hgt;
    var alpha = opts.alpha == null ? 1 : opts.alpha;

    ctx.save();
    ctx.globalAlpha = alpha * (hurt ? 0.95 : 0.5);
    // 底槽
    ctx.fillStyle = 'rgba(4,10,16,0.72)';
    ctx.fillRect(bx - 1, by - 1, w + 2, hgt + 2);
    var cx = bx;
    for (i = 0; i < 5; i++) {
      var sw = w * (wts[i] || 0) / wsum;
      if (sw < 0.6) sw = 0.6;
      // 空的槽
      ctx.fillStyle = 'rgba(120,140,155,0.22)';
      ctx.fillRect(cx, by, sw - 0.6, hgt);
      // 有血的那一截
      var f = bars[i];
      if (f > 0.004) {
        ctx.fillStyle = hpColor(f);
        ctx.fillRect(cx, by, (sw - 0.6) * f, hgt);
      }
      cx += sw;
    }
    ctx.restore();

    /* ---- 故障标签：最多挂三个，多出来的写 +N（悬浮可展开全部） ---- */
    var tags = this.shipTags(sh, pv);
    if (!tags.length) return;
    var maxShow = opts.maxTags || 3;
    var shown = tags.slice(0, maxShow);
    if (tags.length > maxShow) shown.push({ t: '+' + (tags.length - maxShow), c: '#9aa7b4', more: true });

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var pad = 2.5, gap = 2, th = 11;
    var widths = [], total = 0;
    for (i = 0; i < shown.length; i++) {
      var tw = ctx.measureText(shown[i].t).width + pad * 2;
      widths.push(tw);
      total += tw + (i ? gap : 0);
    }
    var tx = x - total / 2;
    var ty = by - th - 3;
    for (i = 0; i < shown.length; i++) {
      var tw2 = widths[i];
      ctx.fillStyle = shown[i].more ? 'rgba(20,30,42,0.86)' : 'rgba(4,10,16,0.78)';
      ctx.fillRect(tx, ty, tw2, th);
      ctx.fillStyle = shown[i].c;
      ctx.fillRect(tx, ty, 1.6, th);
      ctx.fillStyle = shown[i].c;
      ctx.fillText(shown[i].t, tx + tw2 / 2 + 0.8, ty + th / 2 + 0.5);
      if (shown[i].more) {
        // 虚框：告诉玩家“这里还有，鼠标移上去看全”
        ctx.strokeStyle = 'rgba(154,167,180,0.55)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(tx + 0.4, ty + 0.4, tw2 - 0.8, th - 0.8);
        ctx.setLineDash([]);
      }
      tx += tw2 + gap;
    }
    ctx.restore();
  };

  /**
   * 鼠标停在己方舰上时，弹出完整的舰况：五个分区的具体百分比 + 全部标签。
   * 图上最多只挂三个标签（再多就糊了），被 +N 收起来的那些在这里展开。
   */
  Renderer.prototype.drawShipTooltip = function (ctx, world, ui, cam, W, H) {
    if (!ui || !ui.mouseWorld) return;
    var ms = cam.w2s(ui.mouseWorld, W, H);
    var best = null, bestD = 1e9;
    for (var i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i];
      if (sh.sunk) continue;
      var foe = sh.side !== world.playerSide;
      if (foe && !world.replay) continue;
      var pv = this.plotView(world, sh);
      var pp = (pv && pv.pos) ? pv.pos : sh.pos;
      var sp = cam.w2s(pp, W, H);
      var d = Math.sqrt((sp.x - ms.x) * (sp.x - ms.x) + (sp.y - ms.y) * (sp.y - ms.y));
      if (d < 26 && d < bestD) { bestD = d; best = { sh: sh, pv: pv, sp: sp }; }
    }
    if (!best) return;

    var sh = best.sh, pv = best.pv;
    var bars = this.shipHealth(sh, pv);
    var tags = this.shipTags(sh, pv);
    var wts = (sh.zones && sh.zones.hull) ? [
      sh.zones.hull, sh.zones.superstructure, sh.zones.weapons,
      sh.zones.comms, sh.zones.power
    ] : ZONE_W;
    var names = ['舰体', '上层', '武器', '通讯', '动力'];

    var pad = 8, rowH = 13, bw = 54, bh = 4;
    var pw = 148, ph = pad * 2 + 16 + 5 * rowH + (tags.length ? 8 + tags.length * 12 : 0);
    var px = best.sp.x + 18, py = best.sp.y - ph - 12;
    if (px + pw > W - 6) px = best.sp.x - pw - 18;
    if (py < 6) py = best.sp.y + 16;
    if (px < 6) px = 6;
    if (py + ph > H - 6) py = H - 6 - ph;

    ctx.save();
    ctx.fillStyle = 'rgba(6,13,21,0.92)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = 'rgba(120,200,240,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(190,235,255,0.98)';
    var ageTxt = pv ? Math.round(world.time - (pv.reportedAt || world.time)) : 0;
    ctx.fillText(sh.name, px + pad, py + pad + 6);
    if (pv && ageTxt > 3) {
      ctx.font = '9px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(255,205,120,0.85)';
      ctx.textAlign = 'right';
      ctx.fillText('报告 ' + ageTxt + 's 前', px + pw - pad, py + pad + 6);
      ctx.textAlign = 'left';
    }

    var ry = py + pad + 20;
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    for (var k = 0; k < 5; k++) {
      ctx.fillStyle = 'rgba(170,190,205,0.9)';
      ctx.fillText(names[k], px + pad, ry + bh);
      ctx.fillStyle = 'rgba(120,140,155,0.25)';
      ctx.fillRect(px + pad + 24, ry, bw, bh);
      ctx.fillStyle = hpColor(bars[k]);
      ctx.fillRect(px + pad + 24, ry, bw * bars[k], bh);
      ctx.textAlign = 'right';
      ctx.fillStyle = hpColor(bars[k]);
      ctx.fillText(Math.round(bars[k] * 100) + '%', px + pw - pad, ry + bh);
      ctx.textAlign = 'left';
      ry += rowH;
    }

    if (tags.length) {
      ry += 4;
      ctx.font = '9px "Microsoft YaHei", sans-serif';
      var tx = px + pad;
      for (var t = 0; t < tags.length; t++) {
        var tw = ctx.measureText(tags[t].t).width + 8;
        if (tx + tw > px + pw - pad) { tx = px + pad; ry += 13; }
        ctx.fillStyle = 'rgba(4,10,16,0.9)';
        ctx.fillRect(tx, ry, tw, 11);
        ctx.fillStyle = tags[t].c;
        ctx.fillRect(tx, ry, 1.6, 11);
        ctx.fillText(tags[t].t, tx + 4.5, ry + 6);
        tx += tw + 3;
      }
    }
    ctx.restore();
  };

  Renderer.prototype.drawShip = function (ctx, sh, x, y, zoom, ui, foe, heading, stale, pv) {
    var L = Math.max(sh._replay ? 22 : 12, sh.cls.length * zoom);
    var B = Math.max(sh._replay ? 8 : 4, sh.cls.beam * zoom);
    var selected = ui.selected && ui.selected.has(sh.id);
    var sinking = sh.sinking;
    var alpha = sinking ? U.clamp01(sh.sinkTimer / 90) * 0.8 + 0.2 : 1;
    if (stale) alpha *= 0.55;
    var hdg = (heading != null) ? heading : sh.heading;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate((hdg - 90) * DEG);

    /* 舰体 */
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.lineTo(L * 0.28, -B * 0.5);
    ctx.lineTo(-L * 0.42, -B * 0.5);
    ctx.lineTo(-L * 0.5, -B * 0.32);
    ctx.lineTo(-L * 0.5, B * 0.32);
    ctx.lineTo(-L * 0.42, B * 0.5);
    ctx.lineTo(L * 0.28, B * 0.5);
    ctx.closePath();

    var g = ctx.createLinearGradient(0, -B, 0, B);
    if (foe) {
      g.addColorStop(0, '#ffb894');
      g.addColorStop(1, '#8e2d1f');
    } else {
      g.addColorStop(0, '#7fe4ff');
      g.addColorStop(1, '#1d6a8c');
    }
    ctx.fillStyle = sinking ? '#3c4a52' : g;
    ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff'
      : (foe ? 'rgba(255,160,130,0.85)' : 'rgba(120,220,255,0.85)');
    ctx.lineWidth = selected ? 1.6 : 1;
    ctx.stroke();

    /* 炮塔 */
    if (L > 16) {
      for (var i = 0; i < sh.mounts.length; i++) {
        var m = sh.mounts[i];
        if (m.disabled) continue;
        var mx = m.localX * zoom;
        ctx.save();
        ctx.translate(mx, 0);
        ctx.rotate(m.train * DEG);
        ctx.fillStyle = m.ready ? '#bff3ff' : '#6fb9cf';
        var gw = Math.max(1.6, B * 0.55);
        ctx.fillRect(0, -gw / 2, Math.max(2, L * 0.06), gw);
        ctx.restore();
      }
    }

    /* 舰桥 */
    ctx.fillStyle = 'rgba(200,245,255,0.85)';
    ctx.fillRect(L * 0.02, -B * 0.28, Math.max(2, L * 0.10), B * 0.56);

    ctx.restore();

    /* 起火 / 受损闪光 */
    var sinceHit = ui.worldTime - (sh._flash || -999);
    if (sinceHit < 0.7) {
      ctx.beginPath();
      ctx.arc(x, y, L * 0.7 + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,240,200,' + (0.55 * (1 - sinceHit / 0.7)) + ')';
      ctx.fill();
    }
    var fireNow = (pv && pv.fire != null) ? pv.fire : sh.fire;
    if (fireNow > 15 && !sinking) {
      var fa = U.clamp01(fireNow / 100) * 0.55;
      var rg = ctx.createRadialGradient(x, y, 0, x, y, L * 0.9);
      rg.addColorStop(0, 'rgba(255,150,60,' + fa + ')');
      rg.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(x, y, L * 0.9, 0, Math.PI * 2); ctx.fill();
    }
    if (sinking) {
      ctx.beginPath();
      ctx.arc(x, y, L * 0.8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,80,60,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* 选中环 */
    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, L * 0.75 + 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 报告过期：位置不确定圈 */
    if (stale && pv) {
      var ur = Math.max(L * 0.8, (pv.posErr || 200) * zoom);
      ctx.beginPath();
      ctx.arc(x, y, ur, 0, Math.PI * 2);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,205,120,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 舰名 */
    if (zoom > 0.02) {
      ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = stale ? 'rgba(255,205,120,0.85)' : 'rgba(180,235,255,0.9)';
      var nm2 = sh.name;
      if (stale) nm2 += ' · ' + Math.round(ui.worldTime - (pv.reportedAt || 0)) + 's前';
      ctx.fillText(nm2, x, y - L * 0.5 - 8);
    }
  };

  /* -------------------------------------------------------------------- 选择 */
  /* -------------------------------------------------------------- 小队/战列线 */
  /**
   * 画战列线：领舰航迹、计划航线、站位、轴线/航向箭头。
   *
   * 航迹那条线是重点 —— 后舰就是沿着它在走，转弯的时候能直接看出来
   * “前面的船拐过去了，后面的船晚一点沿同一个弯拐”。
   */
  Renderer.prototype.drawSquads = function (ctx, world, cam, W, H) {
    if (!world.squads || !world.squads.length || !N.Squad) return;
    var replay = !!world.replay;

    for (var qi = 0; qi < world.squads.length; qi++) {
      var sq = world.squads[qi];
      if (!sq.shipIds || !sq.shipIds.length) continue;
      if (!replay && sq.side !== world.playerSide) continue;

      var own = (sq.side === world.playerSide);
      var col = own ? '120,230,255' : '255,150,120';
      var n = sq.shipIds.length;
      var lines = N.Squad.lineCountOf(sq);
      var i, k, st, sp;

      ctx.save();

      /* ---- 领舰航迹：后舰走的就是这条线 ---- */
      if (sq.track && sq.track.length > 1 && cam.zoom > 0.014) {
        ctx.beginPath();
        var started = false;
        for (i = 0; i < sq.track.length; i++) {
          var tp = cam.w2s(sq.track[i], W, H);
          if (tp.x < -200 || tp.x > W + 200 || tp.y < -200 || tp.y > H + 200) {
            started = false;
            continue;
          }
          if (!started) { ctx.moveTo(tp.x, tp.y); started = true; }
          else ctx.lineTo(tp.x, tp.y);
        }
        ctx.lineWidth = Math.min(3, 1 + cam.zoom * 6);
        ctx.strokeStyle = 'rgba(' + col + ',0.16)';
        ctx.stroke();
      }

      /* ---- 计划航线：航路点连线 + 编号 ---- */
      if (sq.route && sq.route.length) {
        var rp = [cam.w2s(sq.anchor, W, H)];
        for (i = 0; i < sq.route.length; i++) rp.push(cam.w2s(sq.route[i], W, H));
        ctx.setLineDash([5, 7]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(' + col + ',0.45)';
        ctx.beginPath();
        ctx.moveTo(rp[0].x, rp[0].y);
        for (i = 1; i < rp.length; i++) ctx.lineTo(rp[i].x, rp[i].y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (i = 1; i < rp.length; i++) {
          ctx.beginPath();
          ctx.arc(rp[i].x, rp[i].y, 6, 0, TAU);
          ctx.fillStyle = 'rgba(' + col + ',0.16)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(' + col + ',0.65)';
          ctx.lineWidth = 1;
          ctx.stroke();
          if (cam.zoom > 0.03) {
            ctx.fillStyle = 'rgba(' + col + ',0.85)';
            ctx.fillText(String(i), rp[i].x, rp[i].y + 0.5);
          }
        }
      }

      /* 每条战列线一条虚线，把站位串起来（编号是行优先：i%lines 是第几条线）。
         同转不保持战列线，画出来就是撒谎，所以只画各舰自己的位置。 */
      if (sq.turnMode === 'line') {
        for (k = 0; k < lines; k++) {
          var first = -1, last = -1;
          for (i = 0; i < n; i++) {
            if (i % lines !== k) continue;
            if (first < 0) first = i;
            last = i;
          }
          if (first < 0 || last < 0 || first === last) continue;
          var a = cam.w2s(N.Squad.stationOf(sq, first).pos, W, H);
          var b = cam.w2s(N.Squad.stationOf(sq, last).pos, W, H);
          ctx.setLineDash([6, 7]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(' + col + ',0.22)';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        /* 站位圈：舰在圈里就画实心 */
        for (i = 0; i < n; i++) {
          st = N.Squad.stationOf(sq, i);
          sp = cam.w2s(st.pos, W, H);
          var sh = world.shipById ? world.shipById(sq.shipIds[i]) : null;
          var onStation = sh && !sh.sunk && V.dist(sh.pos, st.pos) < 260;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 4, 0, TAU);
          if (onStation) {
            ctx.fillStyle = 'rgba(' + col + ',0.55)';
            ctx.fill();
          } else {
            ctx.strokeStyle = 'rgba(' + col + ',0.30)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      /* 锚点：航向箭头（实线）与队形轴向（细虚线） */
      var ap = cam.w2s(sq.anchor, W, H);
      var courseEnd = cam.w2s(Geo.dest(sq.anchor, sq.course, 1400), W, H);
      var axisEnd = cam.w2s(Geo.dest(sq.anchor, sq.axis, 1400), W, H);

      this.drawArrow(ctx, ap, axisEnd, 'rgba(' + col + ',0.30)', 1, [4, 5]);
      this.drawArrow(ctx, ap, courseEnd, 'rgba(' + col + ',0.85)', 1.6, null);

      /* 队名 */
      if (cam.zoom > 0.02) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(' + col + ',0.75)';
        var label = sq.name + ' · ' +
          (sq.turnMode === 'line' ? (lines + ' 线 · 依次') : '同转') + ' · ' +
          Math.round(sq.course) + '°';
        if (sq.route && sq.route.length) label += ' · 航路 ' + sq.route.length;
        ctx.fillText(label, ap.x + 7, ap.y - 7);
      }

      /* 终点十字 */
      if (sq.goal) {
        var gp = cam.w2s(sq.goal, W, H);
        ctx.strokeStyle = 'rgba(' + col + ',0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 7, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(gp.x - 4, gp.y); ctx.lineTo(gp.x + 4, gp.y);
        ctx.moveTo(gp.x, gp.y - 4); ctx.lineTo(gp.x, gp.y + 4);
        ctx.stroke();
      }

      ctx.restore();
    }
  };

  /** 从 a 到 b 画一条带箭头的线 */
  Renderer.prototype.drawArrow = function (ctx, a, b, color, width, dash) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 6) return;
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    var ux = dx / len, uy = dy / len;
    var hs = Math.min(9, len * 0.28);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * hs - uy * hs * 0.5, b.y - uy * hs + ux * hs * 0.5);
    ctx.lineTo(b.x - ux * hs + uy * hs * 0.5, b.y - uy * hs - ux * hs * 0.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };

  /* -------------------------------------------------------------- 选中 */

  Renderer.prototype.drawSelection = function (ctx, world, ui, cam, W, H) {
    // 移动目标标记
    for (var mi = 0; mi < world.ships.length; mi++) {
      var ms = world.ships[mi];
      if (ms.side !== world.playerSide || !ms.moveTarget) continue;
      var mp = cam.w2s(ms.moveTarget, W, H);
      ctx.save();
      ctx.strokeStyle = 'rgba(120,230,255,0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(mp.x - 5, mp.y - 5); ctx.lineTo(mp.x + 5, mp.y + 5);
      ctx.moveTo(mp.x + 5, mp.y - 5); ctx.lineTo(mp.x - 5, mp.y + 5);
      ctx.stroke();
      ctx.restore();
    }

    var sel = ui.selected;
    if (!sel || sel.size === 0) return;
    if (typeof world.shipById !== 'function') return;

    var self = this;
    var compact = sel.size > 1;
    sel.forEach(function (id) {
      var sh = world.shipById(id);
      if (!sh || sh.sunk) return;
      var s = cam.w2s(sh.pos, W, H);
      self.drawCourseRing(ctx, world, sh, s.x, s.y, cam, compact);
    });
  };

  /* ------------------------------------------------------------ 航向角度环 */
  Renderer.prototype.drawCourseRing = function (ctx, world, ship, sx, sy, cam, compact) {
    var R = compact ? 44 : 58;
    var hdg = U.norm360(ship.heading);
    var ord = U.norm360(ship.pendingOrder ? ship.pendingOrder.heading : ship.orderedHeading);
    var turn = U.angDiff(ord, hdg);
    var d, a, major, inner;

    ctx.save();

    /* 外圈 */
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, TAU);
    ctx.strokeStyle = 'rgba(110,200,235,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 刻度：每 10° 一小格，每 30° 一大格 */
    for (d = 0; d < 360; d += 10) {
      major = (d % 30 === 0);
      a = (d - 90) * DEG;
      inner = R - (major ? 7 : 3.5);
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * inner, sy + Math.sin(a) * inner);
      ctx.lineTo(sx + Math.cos(a) * R, sy + Math.sin(a) * R);
      ctx.strokeStyle = major ? 'rgba(140,225,250,0.42)' : 'rgba(140,225,250,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* 方位数字 */
    ctx.font = '8px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (d = 0; d < 360; d += 30) {
      a = (d - 90) * DEG;
      var lbl = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d);
      ctx.fillStyle = (d % 90 === 0) ? 'rgba(175,238,255,0.80)' : 'rgba(150,215,240,0.40)';
      ctx.fillText(lbl, sx + Math.cos(a) * (R + 11), sy + Math.sin(a) * (R + 11));
    }

    /* 转向弧 + 角度 */
    if (Math.abs(turn) > 2) {
      var a0 = (hdg - 90) * DEG;
      var a1 = (ord - 90) * DEG;
      ctx.beginPath();
      ctx.arc(sx, sy, R - 3, a0, a1, turn < 0);
      ctx.strokeStyle = 'rgba(255,193,92,0.55)';
      ctx.lineWidth = 1.6;
      ctx.stroke();

      var mid = (hdg + turn / 2 - 90) * DEG;
      var tx = sx + Math.cos(mid) * (R - 17);
      var ty = sy + Math.sin(mid) * (R - 17);
      ctx.font = 'bold 9px "Consolas", monospace';
      ctx.fillStyle = 'rgba(255,208,125,0.98)';
      ctx.fillText((turn > 0 ? '右' : '左') + Math.abs(Math.round(turn)) + '°', tx, ty);
    }

    /* 当前航向（实线 + 箭头） */
    needle(ctx, sx, sy, hdg, R - 4, 'rgba(205,248,255,0.9)', 1.6, true, null);

    /* 指令航向（虚线，琥珀色） */
    needle(ctx, sx, sy, ord, R - 4, 'rgba(255,193,92,0.8)', 1.2, true, [4, 4]);

    /* 目标方位 */
    var tgtPos = null, tgtCol = 'rgba(255,110,90,0.75)';
    if (ship.bombardTargetId && world.shoreTargetById) {
      var st = world.shoreTargetById(ship.bombardTargetId);
      if (st && !st.destroyed) { tgtPos = st.pos; tgtCol = 'rgba(255,190,120,0.8)'; }
    } else if (ship.targetTrackId) {
      var tr = N.Sensors.trackFor(world, ship, ship.targetTrackId);
      if (tr) tgtPos = tr.pos;
    }
    if (tgtPos) {
      var lb = ship.losBlocked;
      var blocked = lb && (world.time - lb.t) < 6;
      if (blocked) tgtCol = 'rgba(255,92,92,0.95)';
      var tb = Geo.bearing(ship.pos, tgtPos);
      var ta = (tb - 90) * DEG;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(ta) * (R + 2), sy + Math.sin(ta) * (R + 2));
      ctx.lineTo(sx + Math.cos(ta) * (R + 16), sy + Math.sin(ta) * (R + 16));
      ctx.strokeStyle = tgtCol;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = '9px "Consolas", monospace';
      ctx.fillStyle = tgtCol;
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(tb) + '°', sx + Math.cos(ta) * (R + 27), sy + Math.sin(ta) * (R + 27));
      // 射界被挡住：在方位刻度上打一个红叉，并在旁边写明被谁挡的
      if (blocked) {
        var cx = sx + Math.cos(ta) * (R + 9), cy = sy + Math.sin(ta) * (R + 9);
        ctx.strokeStyle = 'rgba(255,92,92,0.95)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 4); ctx.lineTo(cx + 4, cy + 4);
        ctx.moveTo(cx + 4, cy - 4); ctx.lineTo(cx - 4, cy + 4);
        ctx.stroke();
        ctx.font = 'bold 9px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(255,120,110,0.95)';
        ctx.textAlign = 'center';
        ctx.fillText('射界被' + (lb.kind === 'land' ? '' : '友舰') + '「' + lb.name + '」挡住',
          sx + Math.cos(ta) * (R + 40), sy + Math.sin(ta) * (R + 40) + 3);
      }
    }

    ctx.restore();
  };

  /* -------------------------------------------------------- 鼠标方位读数 */
  Renderer.prototype.drawBearingReadout = function (ctx, world, ui, cam, W, H) {
    if (!ui.bearingFrom || !ui.mouseWorld) return;
    var p = cam.w2s(ui.bearingFrom, W, H);
    var m = cam.w2s(ui.mouseWorld, W, H);
    var dx = m.x - p.x, dy = m.y - p.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 16) return;

    var brg = U.norm360(Math.atan2(dx, -dy) * U.RAD);
    var distM = len / cam.zoom;

    ctx.save();

    /* 方位线 */
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(m.x, m.y);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(200,240,255,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    /* 从正北扫到该方位的角度弧 */
    var rr = Math.min(52, Math.max(16, len * 0.45));
    ctx.beginPath();
    for (var k = 0; k <= 40; k++) {
      var ang = (-90 + brg * k / 40) * DEG;
      var px2 = p.x + Math.cos(ang) * rr;
      var py2 = p.y + Math.sin(ang) * rr;
      if (k === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
    }
    ctx.strokeStyle = 'rgba(255,205,120,0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    /* 读数框 */
    var label = Math.round(brg) + '°  ' + U.fmtRange(distM);
    var sub = U.bearingName(brg);
    ctx.font = 'bold 11px "Consolas", monospace';
    var w1 = ctx.measureText(label).width;
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    var w2 = ctx.measureText(sub).width;
    var bw = Math.max(w1, w2) + 14;
    var bx = m.x + 14, by = m.y - 30;

    ctx.fillStyle = 'rgba(6,18,28,0.82)';
    ctx.fillRect(bx, by, bw, 30);
    ctx.strokeStyle = 'rgba(255,205,120,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, 30);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 11px "Consolas", monospace';
    ctx.fillStyle = 'rgba(255,214,140,0.98)';
    ctx.fillText(label, bx + 7, by + 4);
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(200,225,240,0.65)';
    ctx.fillText(sub, bx + 7, by + 17);

    ctx.restore();
  };

  /* ------------------------------------------------------------------ 区域 */
  Renderer.prototype.drawZones = function (ctx, world, cam, W, H) {
    var zones = world.zones;
    if (!zones || !zones.length) return;
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (!z || !z.pos) continue;
      var p = cam.w2s(z.pos, W, H);
      var r = z.r * cam.zoom;
      if (p.x + r < -50 || p.x - r > W + 50 || p.y + r < -50 || p.y - r > H + 50) continue;
      if (r < 6) r = 6;

      var col = z.kind === 'landing' ? '255,150,90'
        : (z.kind === 'exit' ? '90,235,180' : '120,200,255');

      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fillStyle = 'rgba(' + col + ',0.055)';
      ctx.fill();

      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = 'rgba(' + col + ',0.42)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);

      // 内圈
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.45, 0, TAU);
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(' + col + ',0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      // 名称
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(' + col + ',0.75)';
      ctx.fillText(z.name, p.x, p.y - r - 6);
      ctx.restore();
    }
  };

  /* -------------------------------------------------------------- 岸上目标 */
  Renderer.prototype.drawShoreTargets = function (ctx, world, cam, W, H) {
    var list = world.shoreTargets;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !t.pos) continue;
      var p = cam.w2s(t.pos, W, H);
      if (p.x < -90 || p.x > W + 90 || p.y < -90 || p.y > H + 90) continue;

      var dead = t.destroyed;
      var col = dead ? '150,165,175'
        : (t.kind === 'airfield' ? '255,170,90'
          : t.kind === 'supply' ? '255,215,110' : '255,140,120');

      ctx.save();

      // 刚被命中的闪光
      if (!dead && world.time - (t._flash || -999) < 1.5) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 24, 0, TAU);
        ctx.fillStyle = 'rgba(255,200,120,0.22)';
        ctx.fill();
      }

      // 菱形符号
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 9);
      ctx.lineTo(p.x + 9, p.y);
      ctx.lineTo(p.x, p.y + 9);
      ctx.lineTo(p.x - 9, p.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(' + col + ',0.20)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + col + ',0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      if (dead) {
        ctx.beginPath();
        ctx.moveTo(p.x - 6, p.y - 6); ctx.lineTo(p.x + 6, p.y + 6);
        ctx.moveTo(p.x + 6, p.y - 6); ctx.lineTo(p.x - 6, p.y + 6);
        ctx.strokeStyle = 'rgba(190,205,215,0.8)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 名称
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(' + col + ',0.92)';
      ctx.fillText(t.name + (dead ? '（已毁）' : ''), p.x, p.y - 13);

      // 血条
      var bw = 46, bh = 3, bx = p.x - bw / 2, by = p.y + 13;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = 'rgba(' + col + ',0.9)';
      ctx.fillRect(bx, by, bw * U.clamp01(t.hp / t.maxHp), bh);

      ctx.restore();
    }
  };

  /* ------------------------------------------------------------ 照明弹光域 */
  Renderer.prototype.drawIllumination = function (ctx, world, cam, W, H) {
    var t = world.time || 0;

    /* ---- 在空中的照明弹：一条上升的曳光 ---- */
    var air = world.starshells || [];
    for (var k = 0; k < air.length; k++) {
      var s = air[k];
      if (t >= s.burstT) continue;
      var k2 = U.clamp01((t - s.fireT) / Math.max(0.1, s.burstT - s.fireT));
      var a = cam.w2s(s.from, W, H);
      var b = cam.w2s(s.pos, W, H);
      var px = U.lerp(a.x, b.x, k2), py = U.lerp(a.y, b.y, k2);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(px, py);
      ctx.strokeStyle = 'rgba(255,225,150,0.30)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, TAU);
      ctx.fillStyle = 'rgba(255,240,180,0.9)';
      ctx.fill();
      ctx.restore();
    }

    var list = world.illum;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var il = list[i];
      var p = cam.w2s(il.pos, W, H);
      var r = Math.max(8, il.r * cam.zoom);
      var left = il.until != null ? Math.max(0, il.until - t) : 0;

      ctx.save();
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(255,248,215,0.34)');
      g.addColorStop(0.35, 'rgba(255,240,180,0.20)');
      g.addColorStop(0.72, 'rgba(255,232,160,0.11)');
      g.addColorStop(1, 'rgba(255,230,160,0.03)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();

      // 边界：虚线圆 = 照明半径
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.setLineDash([6, 7]);
      ctx.strokeStyle = 'rgba(255,244,200,0.72)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);

      // 半径与剩余时间
      ctx.font = '10px "Consolas", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var lab = '照明 ' + (il.r / 1000).toFixed(1) + 'km · ' + Math.ceil(left) + 's';
      var tw = ctx.measureText(lab).width;
      ctx.fillStyle = 'rgba(8,14,20,0.62)';
      ctx.fillRect(p.x - tw / 2 - 4, p.y + r + 3, tw + 8, 13);
      ctx.fillStyle = 'rgba(255,242,200,0.92)';
      ctx.fillText(lab, p.x, p.y + r + 9.5);

      // 照明弹本体 + 光晕
      var pulse = 0.65 + 0.35 * Math.sin(t * 6 + i);
      var core = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14 * pulse);
      core.addColorStop(0, 'rgba(255,255,240,0.95)');
      core.addColorStop(0.4, 'rgba(255,238,170,0.55)');
      core.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14 * pulse, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.8, 0, TAU);
      ctx.fillStyle = 'rgba(255,252,235,1)';
      ctx.fill();
      ctx.restore();
    }
  };

  /* ------------------------------------------------------------------ 夜色 */
  Renderer.prototype.drawNightTint = function (ctx, world, W, H) {
    var light = (world.env && world.env.light) || 'day';
    var k = light === 'night' ? 1 : (light === 'dawn' || light === 'dusk' ? 0.45 : 0);
    if (k <= 0) return;
    ctx.save();
    var g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.10,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(3,10,22,' + (0.20 * k).toFixed(3) + ')');
    g.addColorStop(0.55, 'rgba(2,8,18,' + (0.42 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(1,5,13,' + (0.74 * k).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };

  /* ------------------------------------------------------------------ 天气 */
  /**
   * 雨丝 + 低能见度雾感。
   * 雨丝用固定伪随机相位，随时间平移 —— 不占世界的随机流，回放也稳。
   */
  Renderer.prototype.drawWeather = function (ctx, world, W, H) {
    var wx = world.weather;
    if (!wx) return;
    var rain = wx.rain || 0;
    var vis = wx.visibility;
    var baseVis = wx.baseVisibility || vis;

    ctx.save();

    /* ---- 低能见度：四边压暗 + 一层灰白雾 ---- */
    var haze = U.clamp01(1 - vis / Math.max(1, baseVis));
    if (haze > 0.06) {
      var g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.22,
        W * 0.5, H * 0.5, Math.max(W, H) * 0.70);
      var nightish = (wx.light === 'night') ? 0.55 : 1;
      g.addColorStop(0, 'rgba(150,168,178,0)');
      g.addColorStop(0.6, 'rgba(150,168,178,' + (0.10 * haze * nightish).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(140,158,170,' + (0.34 * haze * nightish).toFixed(3) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    /* ---- 雨丝 ---- */
    if (rain > 0.12) {
      var windDir = wx.windDir == null ? 90 : wx.windDir;
      var slant = Math.cos((windDir + 180) * Math.PI / 180) * 0.55;
      var count = Math.round(40 + 240 * rain);
      var len = 12 + 16 * rain;
      var t = world.time;
      ctx.strokeStyle = 'rgba(178,204,216,' + (0.10 + 0.22 * rain).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var i = 0; i < count; i++) {
        // 固定相位 + 时间平移，雨就一直往下走
        var sx = ((i * 137.5) % 1) * 0 + ((i * 61.803) % 100) / 100 * W;
        var sy = (((i * 97.31) % 100) / 100 * H + t * (620 + (i % 7) * 60)) % H;
        var x = (sx + sy * slant * 0.25) % W;
        ctx.moveTo(x, sy);
        ctx.lineTo(x + slant * len, sy + len);
      }
      ctx.stroke();
    }

    ctx.restore();
  };

  /* ------------------------------------------------------------------ 罗盘 */
  Renderer.prototype.drawCompass = function (ctx, world, ui, W, H) {
    var cx = W - 66, cy = 78, r = 34;
    var d, a, major, inner;

    ctx.save();
    ctx.globalAlpha = 0.9;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.strokeStyle = 'rgba(150,210,235,0.40)';
    ctx.lineWidth = 1;
    ctx.stroke();

    for (d = 0; d < 360; d += 15) {
      major = (d % 45 === 0);
      a = (d - 90) * DEG;
      inner = r - (major ? 6 : 3);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.strokeStyle = major ? 'rgba(170,225,245,0.6)' : 'rgba(150,210,235,0.25)';
      ctx.stroke();
    }

    ctx.font = '9px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var names = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']];
    for (var n = 0; n < names.length; n++) {
      var an = (names[n][0] - 90) * DEG;
      ctx.fillStyle = names[n][0] === 0 ? 'rgba(255,140,120,0.9)' : 'rgba(180,220,240,0.7)';
      ctx.fillText(names[n][1], cx + Math.cos(an) * (r + 9), cy + Math.sin(an) * (r + 9));
    }

    // 选中舰艇的航向指针
    var ship = null;
    if (ui && ui.selected && ui.selected.size) {
      ui.selected.forEach(function (id) {
        if (!ship) ship = world.shipById(id);
      });
    }
    if (ship && !ship.sunk) {
      needle(ctx, cx, cy, U.norm360(ship.orderedHeading), r - 5, 'rgba(255,193,92,0.85)', 1.2, true, [3, 3]);
      needle(ctx, cx, cy, U.norm360(ship.heading), r - 2, 'rgba(205,248,255,0.95)', 1.8, true, null);

      ctx.font = 'bold 10px "Consolas", monospace';
      ctx.fillStyle = 'rgba(205,248,255,0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(Math.round(U.norm360(ship.heading))).padStart(3, '0') + '°', cx, cy + r + 8);
    } else {
      needle(ctx, cx, cy, 0, r - 5, 'rgba(255,140,120,0.7)', 1.4, true, null);
    }

    ctx.restore();
  };

  Renderer.prototype.drawScale = function (ctx, cam, W, H) {
    var targetPx = 120;
    var meters = targetPx / cam.zoom;
    var nice = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    var pick = nice[0];
    for (var i = 0; i < nice.length; i++) {
      if (nice[i] <= meters) pick = nice[i];
    }
    var px = pick * cam.zoom;
    var x = 24, y = H - 26;

    ctx.save();
    ctx.strokeStyle = 'rgba(180,225,245,0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
    ctx.stroke();

    ctx.font = '10px "Consolas", monospace';
    ctx.fillStyle = 'rgba(180,225,245,0.75)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(pick >= 1000 ? (pick / 1000) + ' km' : pick + ' m', x + px + 8, y + 4);
    ctx.restore();
  };

  Renderer.prototype.drawWind = function (ctx, world, W, H) {
    var env = world.env;
    var x = W - 62, y = 140;
    var hv = Geo.headingVec(U.norm360(env.windDir + 180));
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - hv.x * 16, y + hv.y * 16);
    ctx.lineTo(x + hv.x * 16, y - hv.y * 16);
    ctx.strokeStyle = 'rgba(160,220,240,0.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + hv.x * 16, y - hv.y * 16, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(160,220,240,0.9)';
    ctx.fill();
    ctx.font = '9px "Consolas", monospace';
    ctx.fillStyle = 'rgba(160,220,240,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(env.windSpeed + ' kn', x, y + 26);
    ctx.restore();
  };

  N.Camera = Camera;
  N.Renderer = Renderer;
  N.COLORS = COL;
})(globalThis.Naval = globalThis.Naval || {});
