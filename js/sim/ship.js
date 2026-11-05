/* =============================================================================
 *  sim/ship.js —— 舰艇实体：运动、炮塔/鱼雷发射管、损伤状态
 * ========================================================================== */
(function (N) {
  'use strict';

  var U = N.U, V = N.V, Geo = N.Geo;

  var _uid = 0;

  /**
   * @param {Object} def  场景里的舰艇条目 { side, class, name, hull, x, y, heading, speed, group, role }
   * @param {Object} world
   */
  function Ship(def, world) {
    var cls = N.ShipClasses[def.class];
    if (!cls) throw new Error('未知舰级: ' + def.class);

    this.id = 'S' + (++_uid);
    this.side = def.side;
    this.cls = cls;
    this.clsId = def.class;
    this.name = def.name;
    this.hullNumber = def.hull || '';
    this.group = def.group || '';
    this.role = def.role || 'ship';
    this.isPlayerControlled = false;
    this.aiControlled = !!def.aiControlled;   // 友方但由 AI 驾驶（护航对象、撤退舰等）
    this.aiRole = def.aiRole || null;
    this.pursue = !!def.pursue;               // 追击姿态：无目标时全速搜索
    this.autoBombard = !!def.autoBombard;     // 岸轰目标被摧毁后自动改派
    this.destination = def.destination ? { x: def.destination.x, y: def.destination.y } : null;
    this.cargo = def.cargo || null;

    /* ---- 运动 ---- */
    this.pos = { x: def.x || 0, y: def.y || 0 };
    this.heading = def.heading || 0;
    this.speed = def.speed || 12;
    this.orderedSpeed = def.speed || 12;
    this.orderedHeading = def.heading || 0;
    this.accel = cls.accel;
    this.decel = cls.decel;
    this.turnRateNow = cls.turnRate;

    /* ---- 损伤 ---- */
    this.hullMax = cls.hull;
    this.hull = cls.hull;
    this.flood = 0;
    this.floodRate = 0;
    this.fire = 0;
    this.power = 100;          // 动力 %
    this.steering = 100;       // 操舵 %
    this.radarDestroyed = false;
    this.fcDestroyed = false;
    this.radioDestroyed = false;   // 收发机被打掉：视距外的报告和命令全断
    this.iffDestroyed = false;     // 敌我识别器被打掉：只能靠目视判别

    /* ---- 结构分区 ----------------------------------------------------
       一艘舰的结构拆成五块，各有各的血条。hull 就是上面那条主血条，
       另外四块（上层/武器/通信/动力）的满值按结构比例从 hull 换算：
           该区满值 = cls.hull * (该区比例 / hull 比例)
       所以一艘 110 血的重巡，武器结构 = 110 * 0.19/0.44 ≈ 47.5，
       打光这 47.5 点，炮就彻底打不响了 —— 而不是要先把整条舰打沉。 */
    this.zones = (N.zonesFor ? N.zonesFor(cls) : null) ||
      { hull: 0.44, superstructure: 0.15, weapons: 0.19, comms: 0.06, power: 0.16 };
    this.zoneMax = {
      superstructure: cls.hull * this.zones.superstructure / this.zones.hull,
      weapons: cls.hull * this.zones.weapons / this.zones.hull,
      comms: cls.hull * this.zones.comms / this.zones.hull,
      power: cls.hull * this.zones.power / this.zones.hull
    };
    this.zone = {
      superstructure: this.zoneMax.superstructure,
      weapons: this.zoneMax.weapons,
      comms: this.zoneMax.comms,
      power: this.zoneMax.power
    };
    this.zoneLost = { superstructure: false, weapons: false, comms: false, power: false };
    this.ownTracks = {};           // 本舰自己看到的（即时，本舰火控用）
    this.list = 0;             // 横倾，仅用于表现
    this.aground = false;
    this.groundT = -99;        // 上一次触底的时刻
    this.collideT = -99;       // 上一次撞船的时刻
    this.alive = true;
    this.sinking = false;
    this.sunk = false;
    this.sinkTimer = 0;
    this.deadTime = 0;

    /* ---- 火控 ---- */
    this.engage = false;
    this.targetTrackId = null;
    this.bombardTargetId = null;   // 岸轰目标
    this.fireMode = 'AP';
    this.errorScale = 1.0;     // 火控解算误差系数，随校射收敛
    this.salvosFired = 0;

    /* ---- 照明弹 ---- */
    // 只有巡洋舰/驱逐舰带照明弹；数量有限，打完就没有了
    this.starshells = def.starshells != null ? def.starshells
      : (cls.type === 'CA' ? 10 : cls.type === 'CL' ? 8 : cls.type === 'DD' ? 5 : 0);
    this.starshellCd = 0;
    this.lastFireTime = -999;
    this.lastTargetSwitch = -999;
    this.solution = null;
    this.spotting = null;      // 最近一次校射结果

    /* ---- 烟幕 ---- */
    this.smokeScreen = false;
    this.smokeTimer = 0;

    /* ---- 指令延迟（信号旗 / 传声管 / 无线电） ---- */
    this.pendingOrder = null;

    /* ---- 航迹尾迹 ---- */
    this.wake = [];
    this.wakeAccum = 0;

    /* ---- 炮塔 ---- */
    this.mounts = cls.mounts.map(function (m, i) {
      var g = N.Guns[m.gun];
      return {
        idx: i,
        label: m.label,
        def: m,
        gun: g,
        count: m.count,
        armor: m.armor,
        arc: m.arc,
        localX: m.pos * cls.length / 2,
        train: 0,              // 相对舰首的炮塔指向（度）
        elevation: 0,
        reload: 0,
        ready: true,
        disabled: false,
        ammo: m.count * 160,     // 每门炮备弹约 160 发
        shotsFired: 0,
        trainRate: g.caliber >= 200 ? 5 : (g.caliber >= 150 ? 7 : 10)
      };
    });

    /* ---- 鱼雷发射管 ---- */
    var self = this;
    this.torps = cls.torps.map(function (t, i) {
      var td = N.Torpedoes[t.torp];
      return {
        idx: i,
        label: t.label,
        def: t,
        torp: td,
        tubes: t.tubes,
        loaded: t.tubes,
        reload: 0,
        reloadTime: t.reload,
        localX: t.pos * cls.length / 2,
        disabled: false,
        salvoesFired: 0
      };
    });

    /* ---- 探测能力汇总 ---- */
    this.gunRangeMax = N.classGunRange(cls);
    this.mainCaliber = N.classMainCaliber(cls);
    this.torpRangeMax = this.torps.length ? this.torps[0].torp.range : 0;
    this.torpSpeed = this.torps.length ? this.torps[0].torp.speed : 0;

    /* ---- 设备级损害（damage.js）：炮塔 / 鱼雷管 / 雷达 / 电台 / 识别器 /
            发动机 / 舵机 / 电力系统，各自的血条与故障状态 ---- */
    if (N.Damage) N.Damage.init(this, world);

    /* ---- 统计 ---- */
    this.hitsTaken = 0;
    this.hitsDealt = 0;
    this.torpsHitTaken = 0;
    this.torpsFired = 0;
    this.damageReports = [];
    this.lastDamageTime = -999;

    /* ---- 场景预设损伤（例如撤退任务中已经受创的巡洋舰） ---- */
    if (def.damage) {
      var dmg = def.damage;
      if (dmg.hull !== undefined) this.hull = Math.max(1, this.hullMax * U.clamp01(dmg.hull));
      if (dmg.flood) this.flood = dmg.flood;
      if (dmg.floodRate) this.floodRate = dmg.floodRate;
      if (dmg.fire) this.fire = dmg.fire;
      if (dmg.power) this.setPowerPct(100 - dmg.power);
      if (dmg.steering) {
        var stPct = Math.max(0, 100 - dmg.steering);
        this.steering = stPct;
        if (N.Damage) N.Damage.setSteering(this, stPct);
      }
      if (dmg.zones) {
        for (var zk in dmg.zones) {
          if (this.zone[zk] != null) this.zone[zk] = this.zoneMax[zk] * U.clamp01(dmg.zones[zk]);
        }
        if (dmg.zones.power != null) this.setPowerPct(100 * U.clamp01(dmg.zones.power));
        this.syncZones(world);
      }
      this.hull = U.clamp(this.hull, 1, this.hullMax);
    }
  }

  /* ======================================================================= */
  /*  结构分区                                                                */
  /* ======================================================================= */

  /** 某个结构区还剩几成（0..1） */
  Ship.prototype.zoneFrac = function (k) {
    var m = this.zoneMax ? this.zoneMax[k] : 0;
    if (!m) return 1;
    return U.clamp01(this.zone[k] / m);
  };

  /** 武器结构 → 炮塔装填与齐射的速度系数（打光了只剩 30% 射速，实际等于哑火） */
  Ship.prototype.weaponFactor = function () {
    return 0.30 + 0.70 * this.zoneFrac('weapons');
  };

  /** 通信结构 → 无线电可用度（打光了只剩旗语，等于没有无线电） */
  Ship.prototype.commsFactor = function () {
    return 0.25 + 0.75 * this.zoneFrac('comms');
  };

  /** 上层建筑 → 雷达/火控可用度 */
  Ship.prototype.sensorFactor = function () {
    return 0.45 + 0.55 * this.zoneFrac('superstructure');
  };

  /** 动力结构 → 直接写回 power 百分比（兼容老代码） */
  Ship.prototype.setPowerPct = function (pct) {
    var p = U.clamp(pct, 0, 100);
    if (N.Damage && this.engines) {
      N.Damage.setPowerPct(this, p);
      return;
    }
    if (this.zoneMax && this.zoneMax.power > 0) {
      this.zone.power = this.zoneMax.power * p / 100;
    }
    this.power = p;
  };

  /**
   * 直接把一台设备打成 0 血（炮弹正中炮塔之类），并把它的剩余血量从所属结构区里扣掉，
   * 保证「设备血条之和 = 结构区血条」这条账始终对得上。
   */
  Ship.prototype.killDevice = function (dev, zoneKey, world) {
    if (!dev) return;
    dev.hp = 0;
    if (!this.zone || this.zone[zoneKey] == null) return;
    // 结构区血条 = 底下所有设备之和，直接重算，账目永远对得上
    if (N.Damage) N.Damage.syncZone(this, zoneKey);
    else this.zone[zoneKey] = Math.max(0, this.zone[zoneKey] - 0);
    if (this.zone[zoneKey] <= 0 && !this.zoneLost[zoneKey]) {
      this.zoneLost[zoneKey] = true;
      this.onZoneLost(zoneKey, world);
    }
  };

  /**
   * 把某个结构区打掉若干点（单位与 hull 相同），并结算"这一块没了"的后果。
   * 返回 true 表示这一下刚好把它打光。
   */
  Ship.prototype.hitZone = function (k, amount, world, route) {
    if (!this.zone || this.zone[k] == null || !(amount > 0)) return false;
    var before = this.zone[k];
    // 有具体设备的区（武器 / 通信 / 动力）交给设备去分摊，
    // 结构区血条由 syncZone 反推 —— 这样"设备血条之和 = 结构区血条"永远成立
    var backed = N.Damage && (k === 'weapons' || k === 'comms' || k === 'power') &&
      N.Damage.zoneDevices(this, k).length > 0;
    if (backed) {
      N.Damage.routeDamage(this, k, amount, world, route);
    } else {
      this.zone[k] = Math.max(0, before - amount);
    }
    if (k === 'power') {
      this.power = 100 * (N.Damage && this.engines ? N.Damage.propulsion(this) : this.zoneFrac('power'));
    }
    var wasAlive = before > 0;
    if (wasAlive && this.zone[k] <= 0 && !this.zoneLost[k]) {
      this.zoneLost[k] = true;
      this.onZoneLost(k, world);
      return true;
    }
    return false;
  };

  /** 某个结构区被打光时，对应能力成比例地丧失 */
  Ship.prototype.onZoneLost = function (k, world) {
    if (N.Damage) N.Damage.onZoneLost(this, k, world);
    if (k === 'weapons') {
      if (world) world.log(this.side, '💀 ' + this.name + ' 的武器结构全毁，火炮鱼雷都哑了', 'critical');
    } else if (k === 'comms') {
      this.radioDestroyed = true;
      this.iffDestroyed = true;
      if (world) world.log(this.side, '📻 ' + this.name + ' 通信室被毁，无线电与敌我识别中断', 'critical');
    } else if (k === 'superstructure') {
      this.radarDestroyed = true;
      this.fcDestroyed = true;
      if (world) world.log(this.side, '📡 ' + this.name + ' 上层建筑塌了，雷达与火控一起报废', 'critical');
    } else if (k === 'power') {
      this.power = 0;
      if (world) world.log(this.side, '⚙ ' + this.name + ' 动力全毁，失去航行能力', 'critical');
    }
    if (world && world.bus) world.bus.emit('zoneLost', { ship: this, zone: k });
  };

  /** 把 power 百分比与 power 结构区对齐（读档 / 场景预设损伤后用） */
  Ship.prototype.syncZones = function (world) {
    if (!this.zone) return;
    if (N.Damage && this.engines) {
      // 动力现在是主机算出来的，不要用旧字段反推
      this.power = 100 * N.Damage.propulsion(this);
    } else {
      this.zone.power = this.zoneMax.power * U.clamp(this.power, 0, 100) / 100;
    }
    for (var k in this.zoneLost) {
      if (this.zoneLost[k]) continue;
      if (this.zone[k] <= 0) { this.zoneLost[k] = true; this.onZoneLost(k, world); }
    }
  };

  /** 给玩家看的结构摘要（只列已经打坏的） */
  Ship.prototype.structureText = function () {
    if (N.Damage && this.devList) {
      // 三大系统：船体 / 上层结构（武器·通讯·其他）/ 动力系统（发动机·舵机·电力）
      var y = N.Damage.systems(this);
      var parts = [];
      if (y.upper < 0.995) {
        var sub = [];
        if (y.weapons < 0.995) sub.push('武器' + Math.round(y.weapons * 100));
        if (y.comms < 0.995) sub.push('通讯' + Math.round(y.comms * 100));
        if (y.other < 0.995) sub.push('其他' + Math.round(y.other * 100));
        parts.push('上层' + Math.round(y.upper * 100) + '%' + (sub.length ? '（' + sub.join(' ') + '）' : ''));
      }
      if (y.power < 0.995) {
        var sub2 = [];
        if (y.engines < 0.995) sub2.push('机' + Math.round(y.engines * 100));
        if (y.rudder < 0.995) sub2.push('舵' + (y.rudder <= 0 ? '毁' : Math.round(y.rudder * 100)));
        if (y.elec < 0.995) sub2.push('电' + (y.elec <= 0 ? '毁' : Math.round(y.elec * 100)));
        parts.push('动力' + Math.round(y.power * 100) + '%' + (sub2.length ? '（' + sub2.join(' ') + '）' : ''));
      }
      return parts.join(' · ');
    }
    var old = [];
    var name = { weapons: '武器', comms: '通信', superstructure: '上层', power: '动力' };
    for (var k in name) {
      var f = this.zoneFrac(k);
      if (f >= 0.995) continue;
      old.push(name[k] + (f <= 0 ? '全毁' : Math.round(f * 100) + '%'));
    }
    return old.join(' · ');
  };

  /* ======================================================================= */
  /*  运动                                                                    */
  /* ======================================================================= */

  Ship.prototype.effectiveMaxSpeed = function () {
    var base = this.cls.maxSpeed;
    // 推进力现在来自具体的主机：血量掉的 + 故障掉的，逐台算完再平均
    var p = N.Damage && this.engines ? N.Damage.propulsion(this)
      : U.clamp(this.power / 100, 0, 1);
    this.power = 100 * p;
    var floodPenalty = U.clamp(1 - this.flood / 130, 0.15, 1);
    var hullPenalty = U.clamp(0.55 + 0.45 * (this.hull / this.hullMax), 0.3, 1);
    return base * p * floodPenalty * hullPenalty;
  };

  Ship.prototype.updateMotion = function (dt, world) {
    if (this.sunk) return;

    if (this.sinking) {
      this.sinkTimer -= dt;
      this.orderedSpeed = 0;
      this.speed = Math.max(0, this.speed - 0.6 * dt);
      this.list = Math.min(35, this.list + 0.6 * dt);
      if (this.sinkTimer <= 0) {
        this.sunk = true;
        this.alive = false;
        this.deadTime = world.time;
        world.bus.emit('shipSunk', this);
      }
      // 惯性滑行
      var vv = Geo.headingVec(this.heading);
      this.pos.x += vv.x * this.speed * U.KNOT_MS * dt;
      this.pos.y += vv.y * this.speed * U.KNOT_MS * dt;
      return;
    }

    /* --- 转向：舵机被打坏 / 卡死，转同样的角度要多花好几倍时间 --- */
    var speedFrac = U.clamp(this.speed / Math.max(6, this.cls.maxSpeed), 0.25, 1);
    var turnFactor = (N.Damage && this.rudder) ? N.Damage.turnFactor(this) : 1;
    var steerF = 1 / Math.max(1, turnFactor);
    this.turnRateNow = this.cls.turnRate * (0.35 + 0.65 * speedFrac) * steerF;
    var maxStep = this.turnRateNow * dt;
    this.heading = U.approachAngle(this.heading, this.orderedHeading, maxStep);

    /* --- 变速 --- */
    var targetSpeed = U.clamp(this.orderedSpeed, 0, this.effectiveMaxSpeed());
    if (this.speed < targetSpeed) this.speed = Math.min(targetSpeed, this.speed + this.accel * dt);
    else this.speed = Math.max(targetSpeed, this.speed - this.decel * dt);

    /* --- 位移 --- */
    var hv = Geo.headingVec(this.heading);
    var nx = this.pos.x + hv.x * this.speed * U.KNOT_MS * dt;
    var ny = this.pos.y + hv.y * this.speed * U.KNOT_MS * dt;

    /* --- 搁浅：船头或舰体触到陆地 --------------------------------------
       不是"撞到就扣 4 点血"，而是按撞击速度的平方结算：
       20 节冲上礁盘能把重巡的动力结构打掉两成、上层建筑震裂、船底撕开进水。
       搁浅之后只能以 4 节以内的速度慢慢往外蹭。 */
    var bowX = nx + hv.x * this.cls.length * 0.42;
    var bowY = ny + hv.y * this.cls.length * 0.42;
    // 船头、下一位置、还有舰体中心，只要有一个在陆地上就算触底 ——
    // 少算中心的话，慢速蹭过窄礁盘的舰会一直"压着陆地"却不算搁浅
    var onLand = world.isLand(nx, ny) || world.isLand(bowX, bowY) ||
      world.isLand(this.pos.x, this.pos.y);

    if (onLand) {
      if (!this.aground && this.speed > 1.5 && world.time - this.groundT > 6) {
        this.groundT = world.time;
        this.groundHit(world, this.speed, bowX, bowY);
      }
      this.aground = true;

      /* 搁浅后只能慢慢往外蹭 */
      this.speed = Math.min(this.speed, 4);
      // 哪怕主机全毁，搁浅的舰也会被浪一点点推离礁盘 —— 否则会永远卡在岸上
      if (this.speed < 1.2) this.speed = 1.2;
      // 舵机打坏也得能蹭出来：搁浅时靠拖船和倒车，不按舵效算
      var escapeTurn = Math.max(this.turnRateNow, this.cls.turnRate * 0.45);
      var wpt = world.nearestWater ? world.nearestWater(bowX, bowY, 20000) : null;
      if (wpt) {
        var escHdg = Geo.bearing({ x: bowX, y: bowY }, wpt);
        this.heading = U.approachAngle(this.heading, escHdg, escapeTurn * dt * 2.5);
        this.orderedHeading = escHdg;
        this.orderedSpeed = 4;
        var hv3 = Geo.headingVec(this.heading);
        var mx = this.pos.x + hv3.x * this.speed * U.KNOT_MS * dt;
        var my = this.pos.y + hv3.y * this.speed * U.KNOT_MS * dt;
        // 已经陷在岸上的允许往外爬，否则一步也不许再往陆地里走
        var stuckIn = world.isLand(this.pos.x, this.pos.y);
        if (stuckIn) {
          // 舰体中心已经在陆地上：拖船把它往最近的水面拽，越深拽得越快，
          // 免得一艘残废的舰以 4 节的速度在岛中央爬好几分钟
          var wpt2 = world.nearestWater ? world.nearestWater(this.pos.x, this.pos.y, 30000) : null;
          if (wpt2) {
            var dd = V.dist(this.pos, wpt2);
            var tug = Math.min(dd, 4 + dd * 0.012);          // 米/秒
            var ux = (wpt2.x - this.pos.x) / (dd || 1);
            var uy = (wpt2.y - this.pos.y) / (dd || 1);
            var stepLen = Math.min(dd, tug * dt);
            this.pos.x += ux * stepLen;
            this.pos.y += uy * stepLen;
            this.heading = U.approachAngle(this.heading, Geo.bearing(this.pos, wpt2),
              escapeTurn * dt * 2.5);
            this.speed = Math.max(this.speed, 1.2);
          }
        } else if (!world.isLand(mx, my)) {
          this.pos.x = mx;
          this.pos.y = my;
        } else {
          this.speed = Math.min(this.speed, 1.2);
        }
      } else {
        this.speed = 0;
        this.orderedSpeed = 0;
      }
      return;
    }
    this.aground = false;
    this.pos.x = nx;
    this.pos.y = ny;

    /* --- 尾迹 --- */
    this.wakeAccum += this.speed * U.KNOT_MS * dt;
    if (this.wakeAccum > 25) {
      this.wakeAccum = 0;
      this.wake.push({ x: this.pos.x, y: this.pos.y, t: world.time, s: this.speed });
      if (this.wake.length > 90) this.wake.shift();
    }
    while (this.wake.length && world.time - this.wake[0].t > 240) this.wake.shift();
  };

  /* ======================================================================= */
  /*  炮塔                                                                    */
  /* ======================================================================= */

  /** 目标相对舰首的方位（度，-180..180） */
  Ship.prototype.relativeBearing = function (targetPos) {
    return U.angDiff(Geo.bearing(this.pos, targetPos), this.heading);
  };

  Ship.prototype.mountArcOk = function (mount, relBearing) {
    var a = Math.abs(relBearing);
    if (mount.arc === 'all') return true;
    if (mount.arc === 'fwd') return a <= 150;
    if (mount.arc === 'aft') return a >= 30;
    return true;
  };

  Ship.prototype.torpedoArcOk = function (relBearing) {
    var a = Math.abs(relBearing);
    return a > 32 && a < 148;
  };

  /** 更新炮塔转向、俯仰与装填 */
  Ship.prototype.updateMounts = function (dt, world) {
    if (this.sunk || this.sinking) {
      for (var k = 0; k < this.mounts.length; k++) this.mounts[k].ready = false;
      return;
    }

    var track = this.targetTrackId ? N.Sensors.trackFor(world, this, this.targetTrackId) : null;
    var aimPos = null;
    if (this.bombardTargetId && world.shoreTargetById) {
      var st = world.shoreTargetById(this.bombardTargetId);
      if (st && !st.destroyed) aimPos = st.pos;
    }
    if (!aimPos && track) aimPos = track.pos;

    var rel = aimPos ? this.relativeBearing(aimPos) : 0;
    var range = aimPos ? V.dist(this.pos, aimPos) : 0;
    var aiming = !!aimPos && (this.engage || !!this.bombardTargetId);
    // 电力失灵：扬弹机、击发电路全受影响，炮击间隔 ×1.5
    var rate = this.weaponFactor() * (N.Damage ? N.Damage.gunRate(this) : 1);

    for (var i = 0; i < this.mounts.length; i++) {
      var m = this.mounts[i];
      if (m.disabled || m.destroyed) { m.ready = false; continue; }
      if (m.fault) { m.ready = false; continue; }     // 炮塔自己坏了，先修

      /* 装填：武器结构越破，扬弹机和装填机越慢 */
      if (!m.ready) {
        m.reload -= dt * rate;
        if (m.reload <= 0) { m.ready = true; m.reload = 0; }
      }

      /* 炮塔转向：无目标时回到正前方/正后方 */
      var wantTrain = 0;
      if (aimPos && aiming) {
        wantTrain = U.angDiff(rel, 0);   // 相对舰首
        // 归到本炮塔的射界中心附近
        if (m.arc === 'aft') wantTrain = U.angDiff(rel, 180) + 180;
      } else {
        wantTrain = (m.arc === 'aft') ? 180 : 0;
      }
      var step = m.trainRate * dt;
      m.train = U.approachAngle(m.train, wantTrain, step);

      /* 俯仰 */
      var wantElev = 0;
      if (aimPos && aiming && range > 500) {
        wantElev = (m.gun.maxRange > 0)
          ? Math.pow(U.clamp01(range / m.gun.maxRange), 0.7) * (m.gun.caliber >= 200 ? 42 : 30)
          : 0;
      }
      m.elevation += U.clamp(wantElev - m.elevation, -6 * dt, 6 * dt);
    }
  };

  /**
   * 触礁：按撞击速度结算。速度的平方进船体（动能），
   * 动力结构（螺旋桨、轴系、锅炉底座）和上层建筑（桅杆、烟囱）跟着挨震。
   */
  Ship.prototype.groundHit = function (world, v, bx, by) {
    var k = U.clamp(v, 0, 40);
    var dmg = {
      hull: 0.055 * k * k,
      flood: 0.06 * k,
      floodRate: 0.0045 * k,
      // 搁浅伤的是船底、螺旋桨和轴系：动力区的伤害直接记在主机上
      powerRoute: 'engine',
      struct: {
        power: 0.020 * k * k,
        superstructure: 0.010 * k * k,
        weapons: 0.004 * k * k
      }
    };
    if (world.rng.chance(U.clamp01(k / 45))) dmg.fire = 3 + k * 0.2;
    this.applyDamage(dmg, world);
    world.log(this.side, '⚠ ' + this.name + ' 触礁搁浅！撞击航速 ' + Math.round(k) + ' 节',
      'critical');
    if (world.bus) world.bus.emit('grounding', { ship: this, speed: k, pos: { x: bx, y: by } });
  };

  /**
   * 撞船：两舰都挨。相对速度越大、对方越重，自己伤得越狠；
   * 轻的舰（驱逐舰）撞重的舰（巡洋舰）几乎是自己找死。
   *
   * @param {Ship} other  对方
   * @param {number} relV  沿碰撞法线的相对速度（节）
   */
  Ship.prototype.collisionHit = function (world, other, relV) {
    if (this.sunk || relV <= 0.5) return;
    var k = U.clamp(relV, 0, 40);
    var myMass = Math.max(400, this.cls.displacement || 2000);
    var theirMass = Math.max(400, other.cls.displacement || 2000);
    // 质量比：被大舰撞 → 系数 >1；撞小船 → 系数 <1
    var massRatio = U.clamp(theirMass / myMass, 0.25, 3.0);
    var dmg = {
      hull: 0.035 * k * k * massRatio,
      flood: 0.05 * k * massRatio,
      floodRate: 0.0030 * k * massRatio,
      struct: {
        superstructure: 0.010 * k * k * massRatio,
        weapons: 0.005 * k * k * massRatio,
        power: 0.006 * k * k * massRatio
      }
    };
    if (world.rng.chance(U.clamp01(k / 60))) dmg.fire = 2 + k * 0.15;
    this.applyDamage(dmg, world);
    if (world.bus) {
      world.bus.emit('collision', { ship: this, other: other, relSpeed: k });
    }
  };

  /* ======================================================================= */
  /*  损伤                                                                    */
  /* ======================================================================= */

  /**
   * @param {Object} d { hull, flood, floodRate, fire, power, steering, mountHit,
   *                     radar, fc, radio, iff, struct: {weapons|comms|superstructure|power} }
   *
   *  `struct` 里是各结构区挨了多少点（单位与 hull 相同）。
   *  `power` 是老接口，单位是百分比，内部换算成动力结构点。
   */
  Ship.prototype.applyDamage = function (d, world) {
    if (this.sunk) return;
    if (d.hull) this.hull = Math.max(0, this.hull - d.hull);
    if (d.flood) this.flood = Math.min(140, this.flood + d.flood);
    if (d.floodRate) this.floodRate += d.floodRate;
    if (d.fire) this.fire = Math.min(100, this.fire + d.fire);

    /* --- 结构分区 --- */
    var zi, zk;
    if (d.power) this.hitZone('power', this.zoneMax.power * d.power / 100, world);
    if (d.struct) {
      for (zk in d.struct) {
        if (!this.zone || this.zone[zk] == null) continue;
        this.hitZone(zk, d.struct[zk], world, zk === 'power' ? d.powerRoute : null);
      }
    }

    if (d.steering) {
      this.steering = Math.max(0, this.steering - d.steering);
      if (N.Damage && this.rudder) N.Damage.setSteering(this, this.steering);
    }
    if (d.mountHit !== undefined && this.mounts[d.mountHit]) {
      var mh = this.mounts[d.mountHit];
      this.killDevice(mh, 'weapons', world);
      mh.disabled = true;
      mh.ready = false;
      mh.destroyed = true;
    }
    if (d.radar) { this.killDevice(this.radarDev, 'comms', world); this.radarDestroyed = true; }
    if (d.fc) this.fcDestroyed = true;
    if (d.radio) { this.killDevice(this.radioDev, 'comms', world); this.radioDestroyed = true; }
    if (d.iff) { this.killDevice(this.iffDev, 'comms', world); this.iffDestroyed = true; }

    this.hitsTaken++;
    this.lastDamageTime = world.time;
    this._flash = world.time;

    if (this.hull <= 0 && !this.sinking) this.beginSinking(world);
    if (this.flood >= 100 && !this.sinking) this.beginSinking(world);
  };

  Ship.prototype.beginSinking = function (world) {
    if (this.sinking || this.sunk) return;
    this.sinking = true;
    this.sinkTimer = 45 + (this.cls.displacement > 8000 ? 90 : 30);
    this.orderedSpeed = 0;
    world.bus.emit('shipSinking', this);
  };

  /** 每秒的损伤演进：进水、火灾、损管 */
  Ship.prototype.updateDamage = function (dt, world) {
    if (this.sunk) return;
    if (this.sinking) {
      this.flood = Math.min(140, this.flood + 2.5 * dt);
      return;
    }

    var dc = this.cls.damageControl;

    /* 进水 */
    if (this.floodRate > 0) {
      this.flood = Math.min(140, this.flood + this.floodRate * dt * dc);
      // 损管逐步堵漏
      this.floodRate = Math.max(0, this.floodRate - 0.0025 * dt * dc);
    }
    // 大量进水导致横倾，进一步恶化
    if (this.flood > 55) this.list = Math.min(30, this.list + 0.15 * dt);

    /* 火灾 */
    if (this.fire > 0) {
      this.hull = Math.max(0, this.hull - this.fire * 0.0035 * dt);
      this.fire = Math.max(0, this.fire - 0.55 * dc * dt);
      // 弹药库殉爆
      if (this.fire > 55) {
        var p = (this.fire - 55) / 45 * 0.00022 * dt;
        if (world.rng.chance(p)) {
          this.hull = 0;
          world.log(this.side, '💥 ' + this.name + ' 弹药库殉爆！', 'critical');
          this.beginSinking(world);
          return;
        }
      }
    }

    /* 进水到一定程度会失速 */
    if (this.flood > 70) this.orderedSpeed = Math.min(this.orderedSpeed, this.effectiveMaxSpeed());

    if (this.hull <= 0 && !this.sinking) this.beginSinking(world);
    if (this.flood >= 100 && !this.sinking) this.beginSinking(world);
  };

  /* ======================================================================= */
  /*  综合                                                                   */
  /* ======================================================================= */

  Ship.prototype.update = function (dt, world) {
    // 设备故障 / 修复 / 损管抢修：每 5 分钟、每 10 分钟各判一次
    if (N.Damage) N.Damage.update(this, dt, world);
    this.updateDamage(dt, world);
    this.updateMotion(dt, world);
    this.updateMounts(dt, world);
    // 鱼雷管装填（电力失灵时装填间隔 ×2）
    var tRate = this.weaponFactor() * (N.Damage ? N.Damage.torpRate(this) : 1);
    for (var i = 0; i < this.torps.length; i++) {
      var t = this.torps[i];
      if (t.disabled || t.destroyed || t.fault) continue;
      if (t.loaded < t.tubes) {
        t.reload -= dt * tRate;
        if (t.reload <= 0) { t.loaded = t.tubes; t.reload = 0; }
      }
    }
  };

  /** 当前战力（用于胜负判定） */
  Ship.prototype.combatPowerNow = function () {
    if (this.sunk) return 0;
    if (this.sinking) return this.cls.combatPower * 0.15;
    var h = U.clamp(this.hull / this.hullMax, 0, 1);
    var s = U.clamp(this.effectiveMaxSpeed() / this.cls.maxSpeed, 0.1, 1);
    var f = U.clamp(1 - this.fire / 160, 0.4, 1);
    var guns = 0, total = 0;
    for (var i = 0; i < this.mounts.length; i++) {
      total += this.mounts[i].count;
      if (!this.mounts[i].disabled) guns += this.mounts[i].count;
    }
    var g = total > 0 ? (0.35 + 0.65 * guns / total) : 1;
    return this.cls.combatPower * (0.15 + 0.85 * h) * (0.55 + 0.45 * s) * f * g;
  };

  /** 给玩家看的损管摘要 */
  Ship.prototype.statusText = function () {
    if (this.sunk) return '已沉没';
    if (this.sinking) return '正在沉没';
    var parts = [];
    if (this.flood > 40) parts.push('进水' + Math.round(this.flood) + '%');
    if (this.fire > 20) parts.push('起火' + Math.round(this.fire) + '%');
    var dev = N.Damage ? N.Damage.summary(this) : '';
    if (dev) parts.push(dev);
    var st = this.structureText();
    if (st) parts.push(st);
    if (parts.length === 0) return this.hull < this.hullMax * 0.8 ? '轻伤' : '完好';
    return parts.join(' · ');
  };

  N.Ship = Ship;
})(globalThis.Naval = globalThis.Naval || {});
