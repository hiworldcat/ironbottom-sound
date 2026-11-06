import fs from "node:fs";

/* 把 coast-final.json 变成 js/data/coastline.js */

const MAP = { lonMin: 152.55, lonMax: 162.45, latMin: -11.05, latMax: -4.55 };

let polys = JSON.parse(fs.readFileSync("tools/nedata/coast-final.json", "utf8"));

// 去掉完全重复的（land 与 minor_islands 两份数据有重叠）
const seen = new Set();
polys = polys.filter((p) => {
  const k = p.lon.toFixed(3) + "|" + p.lat.toFixed(3) + "|" + Math.round(p.area);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// 只保留在地图范围内的岛（中心点可以稍微出界）
polys = polys.filter(
  (p) =>
    p.lon > MAP.lonMin - 0.15 && p.lon < MAP.lonMax + 0.15 &&
    p.lat > MAP.latMin - 0.15 && p.lat < MAP.latMax + 0.15
);

// 圣克里斯托瓦尔在 10m 数据里被拆成两块，名字挂到大的那块上
let makira = null;
for (const p of polys) {
  if (p.label === "圣克里斯托瓦尔" && (!makira || p.area > makira.area)) makira = p;
}
if (makira) {
  for (const p of polys) {
    if (p.label === "圣克里斯托瓦尔" && p !== makira) p.label = "";
  }
}

polys.sort((a, b) => b.area - a.area);

const lines = [];
for (const p of polys) {
  const ring = p.ring.map((q) => "[" + q[0] + "," + q[1] + "]").join(",");
  const at = p.anchor ? "[" + p.anchor[0] + "," + p.anchor[1] + "]" : "null";
  lines.push(
    "    { name: " + JSON.stringify(p.name || "") +
    ", label: " + JSON.stringify(p.label || "") +
    ", at: " + at +
    ", area: " + Math.round(p.area) +
    ",\n      lonLat: [" + ring + "] }"
  );
}

const head = `/* =====================================================================
 *  真实海岸线 —— 所罗门群岛
 *  ---------------------------------------------------------------------
 *  数据来源：Natural Earth 1:10m Physical Vectors（land + minor islands），
 *  公有领域。裁到所罗门群岛范围后，用 Douglas–Peucker 简化到约 90 米，
 *  经纬度保留四位小数 —— 在这个比例尺下（一格 5 公里）已经看不出锯齿。
 *
 *  lonLat 是 [经度, 纬度]；at 是岛名的落点（岛屿重心经常落在海里，
 *  所以名字位置单独给）。area 是平方公里，只用来决定画多细。
 * ===================================================================== */
(function (N) {
  N.COASTLINE = [
`;
const tail = `  ];
})(globalThis.Naval = globalThis.Naval || {});
`;

fs.writeFileSync("js/data/coastline.js", head + lines.join(",\n") + "\n" + tail, "utf8");
const kb = (fs.statSync("js/data/coastline.js").size / 1024).toFixed(0);
console.log("多边形", polys.length, "命名", polys.filter((p) => p.label).length,
  "总点数", polys.reduce((a, b) => a + b.ring.length, 0), "文件", kb + " KB");
console.log("最大的几个：");
for (const p of polys.slice(0, 8)) console.log("  " + (p.label || "(无名)") + "  " + p.area.toFixed(0) + "km²");
