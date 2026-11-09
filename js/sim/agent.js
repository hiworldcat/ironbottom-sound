/* =====================================================================
 *  外部代理 —— 把一方的战场"报告"整理成简报，再把回的指令落到舰上
 *  ---------------------------------------------------------------------
 *  这里不碰网络，也不碰 DOM：给进去一个 world，出来一段 JSON 简报；
 *  给回来一段 JSON 指令，落到 orderedHeading / targetTrackId / engage 上。
 *  真正调模型的那一层在 js/view/ds-mode.js，测试里可以换成假的传输。
 *
 *  最要紧的一条：简报里**只有这一方看得见的东西** —— 敌舰是带误差的
 *  航迹，己方舰况是延迟的报告。给真值的话，这个模式就没什么意思了。
 * ===================================================================== */
(function (N) {
  var Agent = {};

  var FAIL_WORDS = [
    [1, '雷达坏'], [2, '电台坏'], [4, '识别器坏'], [8, '火控坏'],
    [16, '舵机坏'], [32, '动力故障'], [64, '火炮受损'], [128, '鱼雷管受损'],
    [256, '全船断电']
  ];

  function failWords(mask) {
    var out = [];
    for (var i = 0; i < FAIL_WORDS.length; i++) {
      if (mask & FAIL_WORDS[i][0]) out.push(FAIL_WORDS[i][1]);
    }
    return out;
  }

  function norm360(a) {
    a = Number(a) || 0;
    return ((a % 360) + 360) % 360;
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function km(m) { return Math.round(m / 100) / 10; }

  function clockText(world) {
    var t = (world.scenario && world.scenario.startTime ? world.scenario.startTime : 0) + world.time;
    t = ((t % 86400) + 86400) % 86400;
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /** 旗舰（没有就退化成第一条活着的舰） */
  function flagOf(world, side) {
    var list = world.shipsOf(side);
    for (var i = 0; i < list.length; i++) {
      if (list[i].role === 'flagship') return list[i];
    }
    return list[0] || null;
  }

  /* ------------------------------------------------------------------ 简报 */

  /**
   * 这一方现在"知道"什么。
   * 注意：己方舰况走 Command.ownView —— 视距外的舰拿到的是旧报告，
   * 和玩家在 HUD 上看到的是同一份东西。
   */
  Agent.brief = function (world, side) {
    var flag = flagOf(world, side);
    var from = flag ? flag.pos : { x: 0, y: 0 };

    var mine = world.shipsOf(side).map(function (s) {
      var v = N.Command ? N.Command.ownView(world, s) : null;
      var b = {
        id: s.id,
        name: s.name,
        cls: (s.cls && (s.cls.name || s.cls.type)) || '?',
        hdg: Math.round(norm360(s.orderedHeading)),
        spd: Math.round(s.orderedSpeed)
      };
      if (v) {
        b.hull_pct = Math.round(100 * (v.hull || 0) / (v.hullMax || 1));
        b.flood_pct = Math.round(v.flood || 0);
        if (v.fire) b.fire = true;
        if (v.zones) b.weapons_pct = Math.round(100 * (v.zones.weapons || 0));
        if (v.torps !== undefined) b.torps = v.torps;
        var bad = failWords(v.failMask || 0);
        if (bad.length) b.damage = bad;
        var age = Math.round(world.time - (v.reportedAt || world.time));
        if (!v.exact && age > 1) b.report_age_s = age;   // 这条是旧报告
        b.engage = !!v.engage;
        if (v.targetTrackId) b.target = v.targetTrackId;
      } else {
        b.status = '失联';
      }
      return b;
    });

    var tracks = (N.Sensors ? N.Sensors.trackList(world, side) : []).map(function (tr) {
      var t = {
        id: tr.id,
        what: N.Sensors.idText(tr),
        brg: Math.round(N.Geo.bearing(from, tr.pos)),
        rng_km: km(N.V.dist(from, tr.pos)),
        x_km: km(tr.pos.x),
        y_km: km(tr.pos.y),
        age_s: Math.round(world.time - (tr.lastSeen || world.time))
      };
      var err = Math.max(tr.errR || 0, tr.errC || 0);
      if (err) t.err_km = km(err);
      if (tr.phantom) t.suspect_false = true;
      if (tr.course !== undefined && tr.course !== null) t.course = Math.round(tr.course);
      if (tr.speed !== undefined && tr.speed !== null) t.speed = Math.round(tr.speed);
      if ((tr.fireSeen || 0) >= 12) t.burning = true;
      return t;
    });

    var shore = (world.shoreTargets || []).map(function (t) {
      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        rng_km: km(N.V.dist(from, t.pos)),
        hp_pct: Math.round(100 * (t.hp || 0) / (t.hpMax || 1)),
        destroyed: !!t.destroyed
      };
    });

    var obj = ((world.scenario && world.scenario.objectives) || []).map(function (o) {
      return (o.kind === 'primary' ? '◆ ' : '◇ ') + o.text;
    });

    var wx = world.weather || {};
    return {
      clock: clockText(world),
      elapsed_s: Math.round(world.time),
      side: side === 'US' ? '美军' : '日军',
      light: (world.env && world.env.light) || 'day',
      visibility_km: km(wx.visibility !== undefined ? wx.visibility : (world.env.visibility || 0)),
      rain: Math.round((wx.rain || 0) * 100) / 100,
      sea_state: wx.seaState,
      objective: obj,
      ships: mine,
      tracks: tracks,
      shore_targets: shore.length ? shore : undefined
    };
  };

  /* ------------------------------------------------------------------ 提示词 */

  Agent.systemPrompt = function () {
    return [
      '你在指挥一场 1942~1943 年所罗门群岛的夜战，一方是美军，一方是日军。',
      '你只能看到下面这份态势图 —— 敌舰是**带误差的估计**（err_km 是误差半径，age_s 是这条情报有多旧），',
      '己方舰况是**延迟的报告**（report_age_s 表示这条数据是多少秒前的）。你看不到真实位置，也看不到对方的血。',
      '',
      '单位与约定：',
      '- 距离一律公里，坐标 x_km 向东为正、y_km 向北为正。',
      '- 航向 0=正北，90=正东，180=正南，270=正西。',
      '- 舰炮有效射程约 10~16 公里；鱼雷 8~20 公里（日军九三式更远）。',
      '- 夜战开炮会有炮口闪光，十几公里外都看得见 —— 想藏就别乱开火。',
      '- 己方舰况：hull_pct 是舰体完好度，weapons_pct 是武器可用度，damage 是具体故障。',
      '',
      '你的任务见 objective。用最少的代价达成它：不要拿驱逐舰去和重巡对射，',
      '鱼雷要在 8 公里内、舷侧大致对准时才有效，受伤的舰可以撤出。',
      '',
      '**只输出一个 JSON 对象，不要任何解释文字**：',
      '{"think":"一句话说清这一轮想干什么",',
      ' "ships":{"S1":{"hdg":270,"spd":18,"engage":true,"target":"T3"},',
      '          "S5":{"torp":"T3"},',
      '          "S2":{"smoke":true}}}',
      '',
      '可用字段（都可以省略，省略就不改）：',
      'hdg 航向(0~360) / spd 航速(节) / engage 开火(true/false) / target 目标航迹 id /',
      'torp 对该航迹发射鱼雷 / smoke 施放烟幕(true/false) / starshell 对该航迹打照明弹。',
      '没提到航速的舰保持原航速；航向变了就按新航向走。'
    ].join('\n');
  };

  Agent.userPrompt = function (brief) {
    return '当前态势（JSON）：\n' + JSON.stringify(brief, null, 1);
  };

  /* ------------------------------------------------------------------ 解析 */

  /** 从模型输出里挖出 JSON —— 它经常包一层 ```json 或者写点前言 */
  Agent.parse = function (text) {
    if (!text) return null;
    var s = String(text).trim();
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      var o = JSON.parse(s.slice(i, j + 1));
      return (o && typeof o === 'object') ? o : null;
    } catch (e) {
      return null;
    }
  };

  /* ------------------------------------------------------------------ 落地 */

  /**
   * 把指令落到舰上。返回 { applied: [...], ignored: [...] } —— 给面板看的。
   * 所有字段都校验：模型编出来的舰 id、超范围的航速、不存在的航迹，一律丢掉。
   */
  Agent.apply = function (world, side, act) {
    var res = { applied: [], ignored: [] };
    if (!act || typeof act !== 'object') {
      res.ignored.push('返回的不是 JSON 对象');
      return res;
    }
    var byId = {};
    world.shipsOf(side).forEach(function (s) { byId[s.id] = s; });

    var orders = act.ships || {};
    for (var id in orders) {
      if (!Object.prototype.hasOwnProperty.call(orders, id)) continue;
      var s = byId[id];
      if (!s) { res.ignored.push('没有这艘舰：' + id); continue; }
      var o = orders[id] || {};
      var did = [];

      if (isNum(o.hdg)) {
        s.orderedHeading = norm360(o.hdg);
        did.push('航向 ' + Math.round(s.orderedHeading) + '°');
      }
      if (isNum(o.spd)) {
        var mx = s.effectiveMaxSpeed ? s.effectiveMaxSpeed() : 30;
        s.orderedSpeed = Math.max(0, Math.min(mx, o.spd));
        did.push('航速 ' + Math.round(s.orderedSpeed) + ' 节');
      }
      if (typeof o.engage === 'boolean') {
        s.engage = o.engage;
        s.playerFireOrder = o.engage;
        s.autoTarget = false;
        did.push(o.engage ? '开火' : '停火');
      }
      if (o.target) {
        var tr = N.Sensors.trackFor(world, s, o.target);
        if (!tr) { res.ignored.push(s.name + '：没有这条航迹 ' + o.target); }
        else {
          s.targetTrackId = tr.id;
          s.autoTarget = false;
          did.push('目标 ' + tr.id);
        }
      }
      if (o.torp) {
        var fired = Agent.fireTorpedoes(world, s, o.torp);
        if (fired > 0) did.push('鱼雷 ×' + fired);
        else if (fired === 0) res.ignored.push(s.name + '：鱼雷管没装填好');
        else res.ignored.push(s.name + '：舷侧没对准或没有鱼雷');
      }
      if (typeof o.smoke === 'boolean') {
        s.smokeScreen = o.smoke;
        s.smokeTimer = 0;
        did.push(o.smoke ? '施放烟幕' : '停止烟幕');
      }
      if (o.starshell) {
        var st = N.Sensors.trackFor(world, s, o.starshell);
        if (!st) res.ignored.push(s.name + '：照明弹没有目标 ' + o.starshell);
        else {
          var r = world.fireStarshell ? world.fireStarshell(s, st.pos) : null;
          if (r === null) did.push('照明弹');
          else res.ignored.push(s.name + '：照明弹打不出去');
        }
      }
      if (did.length) res.applied.push(s.name + '：' + did.join('、'));
    }
    if (act.think) res.think = String(act.think).slice(0, 200);
    return res;
  };

  /** 对某条航迹打一轮鱼雷，返回实际发射数（-1 = 舷侧没对准） */
  Agent.fireTorpedoes = function (world, ship, trackId) {
    var tr = N.Sensors.trackFor(world, ship, trackId);
    if (!tr) return -1;
    var total = 0, blocked = false;
    for (var i = 0; i < (ship.torps || []).length; i++) {
      var m = ship.torps[i];
      if (m.disabled || m.loaded <= 0) continue;
      var n = Math.min(m.loaded, 4);
      var fired = N.Combat.launchTorpedoes(world, ship, m, tr.pos, tr.course, tr.speed, n, 1.8);
      if (fired > 0) total += fired;
      else if (fired === -1) blocked = true;
    }
    return total > 0 ? total : (blocked ? -1 : 0);
  };

  /* ------------------------------------------------------------------ 兜底 */

  /**
   * 模型没回话、或者回了一坨解析不了的东西时，用这套保守策略顶一轮 ——
   * 否则一方会因为一次网络抖动整场站着不动，那录像就没法看了。
   */
  Agent.fallback = function (world, side) {
    var ships = world.shipsOf(side);
    var orders = {};
    var nearest = null, nd = 1e12;
    var tracks = N.Sensors.trackList(world, side);
    var flag = flagOf(world, side);
    if (flag) {
      for (var i = 0; i < tracks.length; i++) {
        var d = N.V.dist(flag.pos, tracks[i].pos);
        if (d < nd) { nd = d; nearest = tracks[i]; }
      }
    }
    for (var k = 0; k < ships.length; k++) {
      var s = ships[k];
      if (!nearest) { orders[s.id] = { hdg: Math.round(norm360(s.orderedHeading)), spd: Math.round(s.orderedSpeed) }; continue; }
      var brg = N.Geo.bearing(s.pos, nearest.pos);
      var rng = N.V.dist(s.pos, nearest.pos);
      var o = {};
      // 远就压上去，近就保持距离，别一头撞进对方队列
      if (rng > 14000) o.hdg = Math.round(brg);
      else if (rng < 6000) o.hdg = Math.round(norm360(brg + 180));
      o.spd = Math.round(s.effectiveMaxSpeed ? s.effectiveMaxSpeed() * 0.8 : 20);
      if (rng < (s.gunRangeMax || 14000) * 0.9) { o.engage = true; o.target = nearest.id; }
      orders[s.id] = o;
    }
    return { think: '（模型没有回话，按接触方位自行接敌）', ships: orders };
  };

  N.Agent = Agent;
})(globalThis.Naval = globalThis.Naval || {});
