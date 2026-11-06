import fs from "node:fs";

const CLIP = [152.30, -11.30, 162.55, -4.30];

function ringsOf(g) {
  const out = [];
  for (const f of g.features) {
    const gm = f.geometry;
    if (!gm) continue;
    if (gm.type === "Polygon") out.push(gm.coordinates);
    else if (gm.type === "MultiPolygon") for (const p of gm.coordinates) out.push(p);
  }
  return out;
}
function clipRing(ring, box) {
  const [x0, y0, x1, y1] = box;
  let pts = ring.map(p => [p[0], p[1]]);
  const inside = [p => p[0] >= x0, p => p[0] <= x1, p => p[1] >= y0, p => p[1] <= y1];
  const cut = [
    (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])],
    (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]
  ];
  for (let e = 0; e < 4; e++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside[e](cur), pi = inside[e](prev);
      if (ci) { if (!pi) out.push(cut[e](prev, cur)); out.push(cur); }
      else if (pi) out.push(cut[e](prev, cur));
    }
    pts = out;
    if (!pts.length) return null;
  }
  return pts;
}
function simplify(pts, tol) {
  if (pts.length < 5) return pts;
  const sq = tol * tol;
  function segDist(p, a, b) {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }
  const keep = [0];
  (function step(a, b) {
    let maxD = sq, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0) { step(a, idx); keep.push(idx); step(idx, b); }
  })(0, pts.length - 1);
  keep.push(pts.length - 1);
  keep.sort((a, b) => a - b);
  const out = [];
  for (const i of keep) {
    const p = pts[i];
    if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
  }
  return out;
}
function areaKm2(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2) * 111.32 * 110.57 * Math.cos(8 * Math.PI / 180);
}

const NAMED = [
  ["新爱尔兰", "新爱尔兰", 152.92, -4.72, 200],
  ["布卡", "布卡", 154.65, -5.25, 60],
  ["布干维尔", "布干维尔", 155.15, -6.10, 80],
  ["肖特兰", "肖特兰", 155.75, -7.05, 40],
  ["舒瓦瑟尔", "舒瓦瑟尔", 157.05, -7.05, 80],
  ["韦拉拉韦拉", "韦拉拉韦拉", 156.65, -7.72, 40],
  ["吉佐", "吉佐", 156.82, -8.07, 25],
  ["科隆班加拉", "科隆班加拉", 157.10, -8.00, 40],
  ["新乔治亚", "新乔治亚", 157.55, -8.30, 60],
  ["伦多瓦", "伦多瓦", 157.33, -8.55, 35],
  ["特特帕雷", "特特帕雷", 157.55, -8.72, 30],
  ["圣伊萨贝尔", "圣伊萨贝尔", 159.15, -8.05, 80],
  ["拉塞尔", "拉塞尔", 159.12, -9.05, 25],
  ["瓜达尔卡纳尔", "瓜达尔卡纳尔", 160.15, -9.62, 80],
  ["佛罗里达", "佛罗里达", 160.20, -9.05, 40],
  ["萨沃", "萨沃", 159.82, -9.13, 20],
  ["马莱塔", "马莱塔", 160.90, -8.85, 70],
  ["圣克里斯托瓦尔", "圣克里斯托瓦尔", 161.55, -9.70, 90],
  ["旺古努", "旺古努", 157.95, -8.62, 20],
  ["加托凯", "加托凯", 158.20, -8.80, 20]
];

const polys = [];
for (const f of ["land10", "minor10"]) {
  const g = JSON.parse(fs.readFileSync("tools/nedata/" + f + ".geojson", "utf8"));
  for (const poly of ringsOf(g)) {
    const outer = poly[0];
    const box = CLIP;
    if (!outer.some(p => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3])) continue;
    const c = clipRing(outer, box);
    if (!c || c.length < 4) continue;
    const s = simplify(c, 0.0009);
    if (s.length < 4) continue;
    const km2 = areaKm2(s);
    if (km2 < 0.7) continue;
    let sx = 0, sy = 0;
    for (const p of s) { sx += p[0]; sy += p[1]; }
    polys.push({
      ring: s.map(p => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]),
      area: km2, lon: sx / s.length, lat: sy / s.length,
      name: "", label: ""
    });
  }
}
polys.sort((a, b) => b.area - a.area);

const used = new Set();
for (const [name, label, lon, lat, maxKm] of NAMED) {
  let best = null, bd = 1e9;
  for (const p of polys) {
    if (used.has(p)) continue;
    const d = Math.hypot((p.lon - lon) * 108.5, (p.lat - lat) * 111);
    if (d < bd) { bd = d; best = p; }
  }
  if (best && bd <= maxKm) {
    best.name = name; best.label = label;
    best.anchor = [lon, lat];
    used.add(best);
    console.log("✓ " + label + "  ←  " + best.lon.toFixed(2) + "," + best.lat.toFixed(2) + "  " + best.area.toFixed(0) + "km²  " + bd.toFixed(1) + "km");
  } else {
    console.log("✗ " + label + "  找不到（最近 " + (best ? bd.toFixed(0) + "km " + best.area.toFixed(0) + "km²" : "无") + "）");
  }
}

// 图拉吉太小，10m 数据里没有 —— 手工补一个小岛
polys.push({
  name: "图拉吉", label: "图拉吉", area: 2.1, lon: 160.15, lat: -9.10, anchor: [160.15, -9.10],
  ring: [[160.135,-9.075],[160.165,-9.075],[160.170,-9.100],[160.160,-9.125],[160.140,-9.120],[160.130,-9.095]]
});

const out = polys.map(p => {
  const pts = p.ring.map(q => "[" + q[0] + "," + q[1] + "]").join(",");
  const a = p.anchor ? "[" + p.anchor[0] + "," + p.anchor[1] + "]" : "null";
  return "  { name:" + JSON.stringify(p.name) + ", label:" + JSON.stringify(p.label) +
         ", at:" + a + ", lonLat:[" + pts + "] }";
});
fs.writeFileSync("tools/nedata/coast-final.json", JSON.stringify(polys));
console.log("\n共 " + polys.length + " 个多边形，命名 " + polys.filter(p => p.label).length + " 个，总点数 " + polys.reduce((a, b) => a + b.ring.length, 0));
