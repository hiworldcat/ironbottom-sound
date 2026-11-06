/* 在终端里画一小块海图的 ASCII 图，用来核对坐标落在水里还是岸上 */
import fs from "node:fs";

const files = [
  "js/core.js", "js/data/ships.js", "js/data/coastline.js",
  "js/data/scenarios.js", "js/sim/weather.js", "js/sim/damage.js"
];
for (const f of files) (0, eval)(fs.readFileSync(f, "utf8"));
const N = globalThis.Naval;

const [lon0, lat1, lon1, lat0] = process.argv.slice(2, 6).map(Number);
const W = Number(process.argv[6] || 78);
const H = Number(process.argv[7] || 30);

const rows = [];
for (let r = 0; r < H; r++) {
  let line = "";
  for (let c = 0; c < W; c++) {
    const lon = lon0 + (lon1 - lon0) * (c / (W - 1));
    const lat = lat1 + (lat0 - lat1) * (r / (H - 1));
    const p = N.Geo.lonLatToXY(lon, lat, N.MAP.refLon, N.MAP.refLat);
    line += N.MAP.isLandAt(p.x, p.y) ? "#" : ".";
  }
  rows.push(line);
}
console.log("  " + lon0.toFixed(2) + "E → " + lon1.toFixed(2) + "E   " + lat1.toFixed(2) + "S → " + lat0.toFixed(2) + "S");
for (let r = 0; r < H; r++) {
  const lat = lat1 + (lat0 - lat1) * (r / (H - 1));
  console.log(lat.toFixed(2).padStart(6) + " " + rows[r]);
}
let foot = "       ";
for (let c = 0; c < W; c += 10) {
  const lon = lon0 + (lon1 - lon0) * (c / (W - 1));
  foot += lon.toFixed(2).padEnd(10);
}
console.log(foot);

