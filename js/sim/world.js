/* =============================================================================
 *  sim/world.js —— 战场世界：实体容器、主循环、胜负判定
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  function World(scenario, opts) {
    opts = opts || {};
    this.scenario = scenario;
    this.env = {};
    for (var k in scenario.env) this.env[k] = scenario.env[k];

    this.seedValue = opts.seed || (scenario.id === 'day_surface_action' ? 19421115 : 12345);
    this.rng = new N.RNG(this.seedValue);
    this.bus = new N.EventBus();
    this.time = 0;
    this.playerSide = scenario.playerSide;

    /* 气象：风、浪、雨、云、月光（weather.js）——用自己的随机流，可复现 */
    this.weather = null;
    if (N.Weather) N.Weather.init(this, scenario);
    this.autopilot = !!opts.autopilot;   // true 时友方也由 AI 全权驾驶（用于测试/观战）
    this.ended = false;
    this.result = null;
    this.tickCount = 0;

    this.ships = [];
    this.squads = [];
    this.tracks = { US: {}, JP: {} };
    this.command = { US: null, JP: null };   // 指挥舰与无线电链路（command.js）
    this.shells = [];
    this.torpedoes = [];
    this.splashes = [];
    this.smokes = [];
    this.illum = [];
    this.starshells = [];
    this.salvoes = {};
    this.messages = [];

    /* 场景要素：区域与岸上目标 */
    this.zones = (scenario.zones || []).map(function (z) {
      return {
        id: z.id, name: z.name, kind: z.kind || 'objective',
        pos: { x: z.x, y: z.y }, r: z.r || 3000,
        side: z.side || null
      };
    });
    this.shoreTargets = (scenario.shoreTargets || []).map(function (t) {
      return {
        id: t.id, name: t.name, kind: t.kind || 'position',
        pos: { x: t.x, y: t.y },
        hp: t.hp || 100, maxHp: t.hp || 100,
        destroyed: false, fire: 0, _flash: -999
      };
    });

    /* 已知航迹记录（用于生成“新接触”报告） */
    this._known = {};
    this._lastVictoryCheck = 0;

    /* 地图 */
    var b = N.MAP.bounds;
    this.bounds = b;
    // 默认的集结/撤退海域：取本方旗舰的初始位置（剧本里每条船都在水面上），
    // 这样换一张海图也不会把 AI 的集结点点到岛上去。
    this.homePos = {};
    var _fl = scenario.forces || [];
    for (var _i = 0; _i < _fl.length; _i++) {
      var _f = _fl[_i];
      if (!_f || _f.x == null || !_f.side) continue;
      if (!this.homePos[_f.side] || _f.role === 'flagship') {
        this.homePos[_f.side] = { x: _f.x, y: _f.y };
      }
    }
    if (!this.homePos.US) this.homePos.US = { x: b.x0 + 60000, y: (b.y0 + b.y1) / 2 };
    if (!this.homePos.JP) this.homePos.JP = { x: b.x1 - 60000, y: (b.y0 + b.y1) / 2 };
    if (scenario.home) {
      for (var hs in scenario.home) this.homePos[hs] = scenario.home[hs];
    }
    // 无目标时 AI 前往搜索的海域
    this.searchPos = {};
    for (var ss in this.homePos) this.searchPos[ss] = this.homePos[ss];
    if (scenario.search) {
      for (var sp in scenario.search) this.searchPos[sp] = scenario.search[sp];
    }

    /* 集结 / 搜索海域同样不能落在岛上：剧本写错就挪到最近水面并记下来 */
    this.posFixups = [];
    var anchorSets = [['homePos', this.homePos], ['searchPos', this.searchPos]];
    for (var as = 0; as < anchorSets.length; as++) {
      var setName = anchorSets[as][0], set = anchorSets[as][1];
      for (var sside in set) {
        var ap = set[sside];
        if (!this.isLand(ap.x, ap.y)) continue;
        var aw = this.nearestWater(ap.x, ap.y, 40000);
        if (!aw) continue;
        this.posFixups.push({
          kind: setName, side: sside,
          from: { x: Math.round(ap.x), y: Math.round(ap.y) },
          to: { x: Math.round(aw.x), y: Math.round(aw.y) }, d: Math.round(aw.d)
        });
        ap.x = aw.x;
        ap.y = aw.y;
      }
    }

    /* 建舰 */
    var self = this;
    (scenario.forces || []).forEach(function (f) {
      var s = new N.Ship(f, self);
      s.home = self.homePos[s.side];
      if (s.side === self.playerSide) {
        if (s.cls.type === 'AK' || s.role === 'transport' || s.role === 'escortee' || s.aiControlled) {
          // 友方但不可指挥：运输船、撤退舰等
          s.aiControlled = true;
          s.isPlayerControlled = false;
        } else {
          s.isPlayerControlled = true;
          s.autoTarget = true;
        }
      }
      self.ships.push(s);
    });

    this.initialPower = { US: 0, JP: 0 };
    this.ships.forEach(function (s) {
      self.initialPower[s.side] += s.cls.combatPower;
    });

    /* 出生点校正：剧本万一把舰放在岛上，挪到最近水面并记下来。
       spawnFixups 非空说明剧本坐标写错了——无头测试会因此失败。 */
    this.spawnFixups = [];
    this.ships.forEach(function (s) {
      if (!self.isLand(s.pos.x, s.pos.y)) return;
      var w = self.nearestWater(s.pos.x, s.pos.y, 20000);
      if (!w) return;
      self.spawnFixups.push({
        side: s.side, name: s.name,
        from: { x: Math.round(s.pos.x), y: Math.round(s.pos.y) },
        to: { x: Math.round(w.x), y: Math.round(w.y) },
        d: Math.round(w.d)
      });
      s.pos.x = w.x;
      s.pos.y = w.y;
    });

    /* 场景钩子 */
    if (typeof scenario.onStart === 'function') scenario.onStart(this);

    /* 指挥体系：选出双方的指挥舰 */
    if (N.Command) N.Command.init(this);

    /* 录像（在首条战报之前创建，保证事件完整） */
    this.recorder = opts.noRecord ? null : new N.Recorder(this, {
      interval: opts.recordInterval || 1.0
    });

    this.log(this.playerSide, '战斗开始 · ' + scenario.title, 'info');
  }

  /* ------------------------------------------------------------------ 查询 */
  World.prototype.shipById = function (id) {
    for (var i = 0; i < this.ships.length; i++) if (this.ships[i].id === id) return this.ships[i];
    return null;
  };

  World.prototype.squadById = function (id) {
    for (var i = 0; i < this.squads.length; i++) if (this.squads[i].id === id) return this.squads[i];
    return null;
  };

  /** 某舰所在的小队（没有则 null） */
  World.prototype.squadOf = function (ship) {
    return (ship && ship.squadId) ? this.squadById(ship.squadId) : null;
  };

  World.prototype.shipsOf = function (side) {
    return this.ships.filter(function (s) { return s.side === side; });
  };

  World.prototype.aliveShips = function (side) {
    return this.ships.filter(function (s) { return s.side === side && s.alive && !s.sunk; });
  };

  World.prototype.powerRatio = function (side) {
    var total = this.initialPower[side] || 1;
    var now = 0;
    for (var i = 0; i < this.ships.length; i++) {
      if (this.ships[i].side === side) now += this.ships[i].combatPowerNow();
    }
    return U.clamp01(now / total);
  };

  /* -------------------------------------------------------------- 场景要素 */
  World.prototype.zoneById = function (id) {
    for (var i = 0; i < this.zones.length; i++) if (this.zones[i].id === id) return this.zones[i];
    return null;
  };

  World.prototype.shoreTargetById = function (id) {
    for (var i = 0; i < this.shoreTargets.length; i++) {
      if (this.shoreTargets[i].id === id) return this.shoreTargets[i];
    }
    return null;
  };

  /** 最近的未摧毁岸上目标 */
  World.prototype.nearestShoreTarget = function (pos, aliveOnly) {
    var best = null, bestD = 1e12;
    for (var i = 0; i < this.shoreTargets.length; i++) {
      var t = this.shoreTargets[i];
      if (aliveOnly && t.destroyed) continue;
      var d = V.dist(pos, t.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };

  /** 舰艇/位置是否位于某区域内 */
  World.prototype.inZone = function (pos, zone) {
    return zone ? V.dist(pos, zone.pos) <= zone.r : false;
  };

  /** 某舰是否在指定 id 的区域内 */
  World.prototype.shipInZone = function (ship, zoneId) {
    var z = this.zoneById(zoneId);
    return z ? this.inZone(ship.pos, z) : false;
  };

  /**
   * 该位置是否被照明弹照亮；返回照明后的可视距离（米），未被照亮返回 0。
   * 照明弹是“照亮一片海面”，不是“标记一艘舰”——
   * 只要目标在这个圈里，任何一方的瞭望都能在 illumVis 距离上看到它。
   */
  World.prototype.illuminationAt = function (pos) {
    var best = 0;
    for (var i = 0; i < this.illum.length; i++) {
      var il = this.illum[i];
      if (V.dist(pos, il.pos) < il.r) best = Math.max(best, il.vis || 11000);
    }
    return best;
  };

  /**
   * 发射照明弹。
   *  · 射向鼠标所指海域，最远 6500 m；
   *  · 3.5 秒后到达并爆燃，燃烧 50 秒；
   *  · 燃烧期间以爆点为圆心、半径 4.2 km 的海面被照亮，
   *    圈内目标的可见距离提升到 11 km（双方都受益）；
   *  · 每艘舰携带数量有限，发射后需装填 25 秒。
   * 返回 null 表示成功，否则返回失败原因。
   */
  World.prototype.fireStarshell = function (ship, pos) {
    if (!ship || ship.sunk) return 'no-ship';
    if (!ship.starshells) return 'empty';
    if (ship.starshellCd > 0) return 'cooldown';

    var target = pos || Geo.dest(ship.pos, ship.heading, 5000);
    var d = V.dist(ship.pos, target);
    var at = Geo.dest(ship.pos, Geo.bearing(ship.pos, target), Math.min(6500, d));

    ship.starshells--;
    ship.starshellCd = 25;

    this.starshells.push({
      pos: { x: at.x, y: at.y },
      from: { x: ship.pos.x, y: ship.pos.y },
      side: ship.side,
      shipName: ship.name,
      range: Math.round(V.dist(ship.pos, at)),
      r: 4200, vis: 11000,
      fireT: this.time,
      burstT: this.time + 3.5,
      until: this.time + 3.5 + 50
    });
    this.log(ship.side, ship.name + ' 发射照明弹，3.5 秒后爆燃', 'info');
    return null;
  };

  World.prototype.updateIllum = function (dt) {
    var i, s;
    for (i = 0; i < this.ships.length; i++) {
      s = this.ships[i];
      if (s.starshellCd > 0) s.starshellCd = Math.max(0, s.starshellCd - dt);
    }

    // 由“在空中的照明弹”推导出“正在燃烧的照明区”
    this.illum.length = 0;
    for (i = 0; i < this.starshells.length; i++) {
      s = this.starshells[i];
      if (this.time >= s.burstT && this.time <= s.until) {
        if (!s._logged) {
          s._logged = true;
          this.log(s.side, s.shipName + ' 的照明弹在 ' + U.fmtRange(s.range) + ' 处爆燃，照亮半径 4.2 km', 'info');
        }
        this.illum.push({
          pos: s.pos, r: s.r, vis: s.vis,
          side: s.side, born: s.burstT, until: s.until
        });
      }
    }
    for (i = this.starshells.length - 1; i >= 0; i--) {
      if (this.time > this.starshells[i].until) this.starshells.splice(i, 1);
    }

    for (var j = 0; j < this.shoreTargets.length; j++) {
      var t = this.shoreTargets[j];
      if (t.fire > 0) t.fire = Math.max(0, t.fire - 0.4 * dt);
    }
  };

  World.prototype.updateShoreTargets = function (dt) {
    for (var i = 0; i < this.shoreTargets.length; i++) {
      var t = this.shoreTargets[i];
      if (t.destroyed) continue;
      if (t.hp <= 0) {
        t.destroyed = true;
        this.log(this.playerSide, '◆ 岸上目标已摧毁：' + t.name, 'good');
      }
    }
  };

  /** 岸上目标受损（由炮击命中调用） */
  World.prototype.damageShoreTarget = function (t, amount, world) {
    if (!t || t.destroyed) return;
    t.hp = Math.max(0, t.hp - amount);
    t.fire = Math.min(100, t.fire + amount * 2.5);
    t._flash = this.time;
    if (t.hp <= 0 && !t.destroyed) {
      t.destroyed = true;
      this.log(this.playerSide, '◆ 岸上目标被摧毁：' + t.name, 'good');
      this.bus.emit('shoreTargetDestroyed', t);
    }
  };

  /** 任务目标进度（供 HUD 显示） */
  World.prototype.evaluateObjectives = function () {
    var out = [];
    var list = this.scenario.objectives || [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var st = {
        id: o.id, text: o.text, kind: o.kind || 'primary',
        progress: 0, done: false, note: ''
      };
      if (typeof o.check === 'function') {
        try {
          var r = o.check(this) || {};
          st.progress = U.clamp01(r.progress || 0);
          st.done = !!r.done;
          if (r.note) st.note = r.note;
        } catch (e) { /* 目标函数出错不应中断战斗 */ }
      }
      out.push(st);
    }
    return out;
  };

  /** 某方是否已全灭 */
  World.prototype.allSunk = function (side) {
    return this.aliveShips(side).length === 0;
  };

  /** 按角色筛选（护航对象、运输船等） */
  World.prototype.shipsByRole = function (side, role) {
    return this.ships.filter(function (s) {
      return s.side === side && s.role === role;
    });
  };

  /* ------------------------------------------------------------------ 陆地 */
  /** 找最近的水面点：出生点校正与搁浅脱困都靠它 */
  World.prototype.nearestWater = function (x, y, maxR) {
    maxR = maxR || 12000;
    if (!this.isLand(x, y)) return { x: x, y: y, d: 0, bearing: null };
    for (var r = 150; r <= maxR; r += 150) {
      var n = Math.max(12, Math.round(r / 60));
      for (var i = 0; i < n; i++) {
        var a = i * 360 / n;
        var p = Geo.dest({ x: x, y: y }, a, r);
        if (!this.isLand(p.x, p.y)) return { x: p.x, y: p.y, d: r, bearing: a };
      }
    }
    return null;
  };

  World.prototype.isLand = function (x, y) {
    var b = this.bounds;
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return true;
    var isl = N.ISLANDS;
    for (var i = 0; i < isl.length; i++) {
      var poly = isl[i].poly;
      // 快速包围盒
      var minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12;
      if (!isl[i]._bb) {
        for (var j = 0; j < poly.length; j++) {
          if (poly[j].x < minx) minx = poly[j].x;
          if (poly[j].x > maxx) maxx = poly[j].x;
          if (poly[j].y < miny) miny = poly[j].y;
          if (poly[j].y > maxy) maxy = poly[j].y;
        }
        isl[i]._bb = { x0: minx, y0: miny, x1: maxx, y1: maxy };
      }
      var bb = isl[i]._bb;
      if (x < bb.x0 || x > bb.x1 || y < bb.y0 || y > bb.y1) continue;
      if (Geo.pointInPolygon({ x: x, y: y }, poly)) return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------ 航迹清理 */
  /** 目标已沉没：立刻抹掉它的航迹，并报告战果 */
  World.prototype.pruneTracks = function () {
    for (var side in this.tracks) {
      var tracks = this.tracks[side];
      for (var id in tracks) {
        var s = this.shipById(id);
        if (!s || s.sunk) {
          var tr = tracks[id];
          delete tracks[id];
          delete this._known[id];
          if (side === this.playerSide && s) {
            this.log(side, '◆ 目标沉没：' + (N.Sensors.idText(tr)), 'good');
          }
        }
      }
    }
  };

  /* ------------------------------------------------------------------ 特效 */
  World.prototype.addSplash = function (pos, side, kind, ownerId, caliber) {
    var big = kind === 'near';
    this.splashes.push({
      pos: { x: pos.x, y: pos.y },
      r: big ? 10 : 6,
      maxR: kind === 'torpedo' ? 60 : (big ? 48 : 32),
      t: 0,
      life: kind === 'torpedo' ? 4.5 : (big ? 3.6 : 3.0),
      side: side, kind: kind || 'shell',
      ownerId: ownerId || null,
      cal: caliber || 0
    });
  };

  /* ------------------------------------------------------------------ 日志 */
  World.prototype.log = function (side, text, kind) {
    if (side !== this.playerSide) return;
    var last = this.messages[this.messages.length - 1];
    if (last && last.text === text && this.time - last.t < 3) return;
    this._msgId = (this._msgId || 0) + 1;
    this.messages.push({ id: this._msgId, t: this.time, text: text, kind: kind || 'info' });
    if (this.messages.length > 160) this.messages.shift();
    this.bus.emit('message', this.messages[this.messages.length - 1]);
  };

  /* ------------------------------------------------------------------ 指令 */
  /**
   * 从指挥舰给某艘舰下命令。
   * 视距内灯光旗语，几秒到；视距外走无线电，几十秒，还可能丢。
   * @return {ok, delay, lost, reason}
   */
  World.prototype.issueOrder = function (ship, heading, speed) {
    if (!ship || ship.sunk || ship.sinking) return { ok: false, reason: 'sunk' };
    if (N.Command) return N.Command.sendOrder(this, ship, heading, speed);
    ship.pendingOrder = {
      heading: heading === undefined ? ship.orderedHeading : U.norm360(heading),
      speed: speed === undefined ? ship.orderedSpeed : speed,
      at: this.time + 2
    };
    return { ok: true, delay: 2 };
  };

  World.prototype.applyPendingOrders = function () {
    for (var i = 0; i < this.ships.length; i++) {
      var s = this.ships[i];
      if (!s.pendingOrder) continue;
      if (this.time >= s.pendingOrder.at) {
        s.orderedHeading = s.pendingOrder.heading;
        s.orderedSpeed = s.pendingOrder.speed;
        s.pendingOrder = null;
      }
    }
  };

  /* ------------------------------------------------------------------ 鱼雷瞭望 */
  /**
   * 瞭望哨偶然发现来袭鱼雷航迹。
   * 九三式氧气鱼雷几乎不产生气泡（wake≈0.04），因此极难被看见；
   * 美军 Mk 15 的航迹则明显得多。发现后才会触发规避。
   */
  World.prototype.updateTorpedoSpotting = function (dt) {
    for (var i = 0; i < this.torpedoes.length; i++) {
      var t = this.torpedoes[i];
      if (t.spotted) continue;
      for (var j = 0; j < this.ships.length; j++) {
        var s = this.ships[j];
        if (s.side === t.side || s.sunk || !s.alive) continue;
        var d = V.dist(s.pos, t.pos);
        if (d > 2000) continue;
        // 每秒发现概率：航迹越明显越高
        var p = (0.004 + t.wake * 0.11) * dt;
        if (this.rng.chance(p)) {
          t.spotted = true;
          t.spottedTime = this.time;
          if (s.side === this.playerSide) {
            this.log(this.playerSide, '⚠ 瞭望哨发现鱼雷航迹！方位 ' +
              Math.round(Geo.bearing(s.pos, t.pos)) + '°', 'critical');
          }
          break;
        }
      }
    }
  };

  /* ------------------------------------------------------------------ 烟幕 */
  World.prototype.updateSmoke = function (dt) {
    var wx = this.weather;
    var windDir = wx ? wx.windDir : this.env.windDir;
    var windSpd = wx ? wx.windSpeed : this.env.windSpeed;
    // 风越大，烟飘得越快、散得越快；风小的时候烟会赖在原地
    var wind = Geo.headingVec(U.norm360(windDir + 180));
    var driftK = 0.25 * (0.5 + windSpd / 20);

    for (var i = 0; i < this.ships.length; i++) {
      var s = this.ships[i];
      if (s.sunk || s.sinking) continue;

      /* 主动施放烟幕 */
      if (s.smokeScreen) {
        s.smokeTimer -= dt;
        if (s.smokeTimer <= 0) {
          s.smokeTimer = 5.5;
          this.smokes.push({
            kind: 'screen',
            pos: Geo.dest(s.pos, U.norm360(s.heading + 180), s.cls.length * 0.4),
            radius: 520, born: this.time, life: 210,
            drift: { x: wind.x * windSpd * driftK, y: wind.y * windSpd * driftK }
          });
        }
      }

      /* 起火：烧起来的舰自己就是一根烟囱，烟顺风压过去 */
      if ((s.fire || 0) > 12) {
        s.fireSmokeTimer = (s.fireSmokeTimer == null ? 1.5 : s.fireSmokeTimer) - dt;
        if (s.fireSmokeTimer <= 0) {
          s.fireSmokeTimer = Math.max(2.2, 7 - s.fire * 0.05);
          var jitter = this.rng.dev(180);
          this.smokes.push({
            kind: 'fire',
            pos: Geo.dest(s.pos, U.norm360(windDir + 180 + jitter / 60), s.cls.length * 0.25),
            radius: 300, born: this.time,
            life: 150,
            drift: { x: wind.x * windSpd * driftK * 1.25, y: wind.y * windSpd * driftK * 1.25 }
          });
        }
      }
    }

    for (var k = this.smokes.length - 1; k >= 0; k--) {
      var sm = this.smokes[k];
      var age = this.time - sm.born;
      if (age > sm.life) { this.smokes.splice(k, 1); continue; }
      sm.pos.x += sm.drift.x * dt;
      sm.pos.y += sm.drift.y * dt;
      // 风大时烟散得快（半径涨得快、活得短），风小时浓烟久久不散
      var grow = sm.kind === 'fire' ? (0.8 + windSpd * 0.05) : 1.1;
      sm.radius = (sm.kind === 'fire' ? 300 : 520) + age * grow;
    }
    // 性能兜底：烟太多的时候先扔最老的
    if (this.smokes.length > 260) this.smokes.splice(0, this.smokes.length - 260);
    for (var m = this.splashes.length - 1; m >= 0; m--) {
      var sp = this.splashes[m];
      sp.t += dt;
      sp.r += (sp.maxR - sp.r) * Math.min(1, dt * 4.5);
      if (sp.t > sp.life) this.splashes.splice(m, 1);
    }
  };

  /* ------------------------------------------------------------------ 撞船 */
  /**
   * 舰体矩形相交 + 有相对速度 = 撞船。两舰都挨，按相对速度的平方和
   * 对方/自己的吨位比结算：驱逐舰撞巡洋舰，吃亏的是驱逐舰。
   * 撞完把两舰轻轻推开，免得卡在一起每帧重复触发。
   */
  World.prototype.checkCollisions = function () {
    if (!this._collT) this._collT = {};
    var list = this.ships, i, j;
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.sunk || !a.alive || a.sinking) continue;
      for (j = i + 1; j < list.length; j++) {
        var b = list[j];
        if (b.sunk || !b.alive || b.sinking) continue;

        var dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        var d2 = dx * dx + dy * dy;
        var reach = (a.cls.length + b.cls.length) / 2;
        if (d2 > reach * reach) continue;
        if (!Geo.shipRectHit(a, b, 0)) continue;

        var d = Math.sqrt(d2) || 1;
        var nx = dx / d, ny = dy / d;
        var va = Geo.headingVec(a.heading), vb = Geo.headingVec(b.heading);
        var closing = Math.abs((va.x * a.speed - vb.x * b.speed) * nx +
          (va.y * a.speed - vb.y * b.speed) * ny);

        var key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (closing > 1.2 && this.time - (this._collT[key] || -999) > 6) {
          this._collT[key] = this.time;
          a.collisionHit(this, b, closing);
          b.collisionHit(this, a, closing);
          this.log(this.playerSide, '💢 ' + a.name + ' 与 ' + b.name + ' 相撞！', 'critical');
          if (this.bus) this.bus.emit('shipCollision', { a: a, b: b, speed: closing });
        }

        /* 推开：每帧 1.2 m（固定步长 0.1 s，约 12 m/s），慢慢挤开而不是瞬移 */
        var push = 1.2;
        a.pos.x -= nx * push; a.pos.y -= ny * push;
        b.pos.x += nx * push; b.pos.y += ny * push;
      }
    }
  };

  /* ------------------------------------------------------------------ 主循环 */
  World.prototype.update = function (dt) {
    if (this.ended) return;
    this.time += dt;
    this.tickCount++;

    /* 0.5 小队与战列线（航迹推进、站位）——要在 AI 之前，站位才是最新的 */
    if (N.Squad) N.Squad.update(this, dt);

    /* 0.6 指挥链路：送达上一帧发出的报告、刷新本舰状态、指挥交接 */
    if (N.Command) N.Command.update(this, dt);

    /* 0.7 气象推演：风浪雨一直在变，雷达和瞭望跟着变 */
    if (N.Weather) N.Weather.update(this, dt);

    /* 1. AI（敌方全权，友方自动分配目标） */
    N.AI.update(this, dt, 'JP', true);
    N.AI.update(this, dt, 'US', this.autopilot);

    /* 2. 指令延迟 */
    this.applyPendingOrders();

    /* 3. 舰艇 */
    for (var i = 0; i < this.ships.length; i++) {
      this.ships[i].update(dt, this);
    }
    this.checkCollisions();
    this.pruneTracks();

    /* 4. 探测与航迹 */
    N.Sensors.updateTracks(this, 'US', dt);
    N.Sensors.updateTracks(this, 'JP', dt);

    /* 5. 战斗 */
    N.Combat.update(this, dt);
    this.updateTorpedoSpotting(dt);

    /* 6. 特效 */
    this.updateSmoke(dt);
    this.updateIllum(dt);
    this.updateShoreTargets(dt);

    /* 6.5 场景自定义逻辑 */
    if (typeof this.scenario.update === 'function') {
      try { this.scenario.update(this, dt); } catch (e) { /* 忽略场景脚本错误 */ }
    }

    /* 7. 接触报告 */
    this.reportNewContacts();

    /* 8. 清理 */
    if (this.tickCount % 20 === 0) this.cleanup();

    /* 8.5 录像 */
    if (this.recorder) this.recorder.capture(false);

    /* 9. 胜负 */
    if (this.time - this._lastVictoryCheck > 1) {
      this._lastVictoryCheck = this.time;
      this.checkVictory();
    }
  };

  World.prototype.cleanup = function () {
    for (var i = this.shells.length - 1; i >= 0; i--) {
      if (this.shells[i].t > 120) this.shells.splice(i, 1);
    }
  };

  World.prototype.reportNewContacts = function () {
    var list = N.Sensors.trackList(this, this.playerSide);
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      var key = tr.id;
      var prev = this._known[key];
      if (!prev) {
        this._known[key] = { idLevel: tr.idLevel, name: null };
        var src = tr.source === 'radar' ? '雷达' : (tr.source === 'both' ? '雷达与瞭望' : '瞭望');
        // 这条接触是谁报上来的（视距外就是无线电，会晚几十秒）
        var via = tr.via ? '（' + tr.via + ' 报：' + src + '）' : '（' + src + '）';
        this.log(this.playerSide,
          '发现新目标' + via + '：方位 ' + Math.round(Geo.bearing(this.playerReference(), tr.pos)) +
          '°，距离 ' + U.fmtRange(V.dist(this.playerReference(), tr.pos)),
          'contact');
      } else if (tr.idLevel > prev.idLevel) {
        prev.idLevel = tr.idLevel;
        this.log(this.playerSide, '目标识别更新：' + N.Sensors.idText(tr), 'contact');
      }
    }
    // 消失的接触
    for (var k in this._known) {
      if (!this.tracks[this.playerSide][k]) {
        delete this._known[k];
        this.log(this.playerSide, '失去接触', 'contact');
      }
    }
  };

  /** 玩家旗舰位置，用于报方位 */
  World.prototype.playerReference = function () {
    // 报方位以指挥舰为准 —— 你就在指挥舰上
    if (N.Command) {
      var f = N.Command.flagshipOf(this, this.playerSide);
      if (f) return f.pos;
    }
    var p = this.ships.filter(function (s) {
      return s.side === this.playerSide && s.alive && !s.sunk;
    }, this);
    if (p.length === 0) return { x: 0, y: 0 };
    var flag = p.filter(function (s) { return s.role === 'flagship'; })[0];
    return (flag || p[0]).pos;
  };

  /* ------------------------------------------------------------------ 胜负 */
  World.prototype.checkVictory = function () {
    if (this.ended) return;

    // 场景自定义胜负（护航、岸轰、撤退等）
    if (typeof this.scenario.check === 'function') {
      var r = null;
      try { r = this.scenario.check(this); } catch (e) { r = null; }
      if (r && r.result) return this.end(r.result, r.reason);
      return;
    }

    var v = this.scenario.victory || {};
    var enemySide = this.playerSide === 'US' ? 'JP' : 'US';
    var enemyPower = this.powerRatio(enemySide);
    var ownPower = this.powerRatio(this.playerSide);

    var enemyAlive = this.aliveShips(enemySide).length;
    var ownAlive = this.aliveShips(this.playerSide).length;

    if (enemyAlive === 0) return this.end('win', '敌方编队已全灭。');
    if (ownAlive === 0) return this.end('loss', '我方编队已全灭。');

    var eThr = v.enemyPowerRatio !== undefined ? v.enemyPowerRatio : 0.4;
    var oThr = v.ownPowerRatio !== undefined ? v.ownPowerRatio : 0.4;

    if (enemyPower <= eThr) return this.end('win', '敌方战力已降至 ' + Math.round(enemyPower * 100) + '%，失去战斗能力。');
    if (ownPower <= oThr) return this.end('loss', '我方战力已降至 ' + Math.round(ownPower * 100) + '%，被迫脱离。');

    if (v.timeLimit && this.time >= v.timeLimit) {
      if (enemyPower < ownPower - 0.1) return this.end('win', '时限已到，我方保持优势。');
      if (ownPower < enemyPower - 0.1) return this.end('loss', '时限已到，我方损失更大。');
      return this.end('draw', '时限已到，双方脱离接触。');
    }
  };

  World.prototype.end = function (result, reason) {
    this.ended = true;
    this.result = { result: result, reason: reason, time: this.time };
    this.bus.emit('battleEnd', this.result);
    return this.result;
  };

  /* ------------------------------------------------------------------ 统计 */
  World.prototype.summary = function () {
    var self = this;
    var enemySide = this.playerSide === 'US' ? 'JP' : 'US';
    function sideStat(side) {
      var list = self.shipsOf(side);
      return {
        total: list.length,
        sunk: list.filter(function (s) { return s.sunk; }).length,
        crippled: list.filter(function (s) { return !s.sunk && (s.sinking || s.hull < s.hullMax * 0.4); }).length,
        power: self.powerRatio(side)
      };
    }
    return {
      playerSide: this.playerSide,
      own: sideStat(this.playerSide),
      enemy: sideStat(enemySide),
      time: this.time,
      result: this.result
    };
  };

  N.World = World;
})(globalThis.Naval = globalThis.Naval || {});
