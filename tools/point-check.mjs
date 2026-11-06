/* 检查一组经纬度是水是陆，并给出最近的水面 */
import fs from "node:fs";

const files = [
  "js/core.js", "js/data/ships.js", "js/data/coastline.js",
  "js/data/scenarios.js", "js/sim/weather.js", "js/sim/damage.js"
];
for (const f of files) (0, eval)(fs.readFileSync(f, "utf8"));
const N = globalThis.Naval;

function at(lon, lat) { return N.Geo.lonLatToXY(lon, lat, N.MAP.refLon, N.MAP.refLat); }
function isLand(lon, lat) { const p = at(lon, lat); return N.MAP.isLandAt(p.x, p.y); }
function nearestWater(lon, lat) {
  const p = at(lon, lat);
  for (let r = 500; r <= 40000; r += 500) {
    for (let a = 0; a < 360; a += 15) {
      const q = { x: p.x + Math.cos(a * Math.PI / 180) * r, y: p.y + Math.sin(a * Math.PI / 180) * r };
      if (!N.MAP.isLandAt(q.x, q.y)) {
        return { lon: q.x / 110155 + N.MAP.refLon, lat: q.y / 111320 + N.MAP.refLat, d: r };
      }
    }
  }
  return null;
}

const pts = process.argv.slice(2);
for (let i = 0; i < pts.length; i += 2) {
  const lon = Number(pts[i]), lat = Number(pts[i + 1]);
  const land = isLand(lon, lat);
  let s = (land ? "陆 " : "水 ") + lon.toFixed(3) + "," + lat.toFixed(3);
  if (land) {
    const w = nearestWater(lon, lat);
    s += w ? "  → 最近水面 " + w.lon.toFixed(3) + "," + w.lat.toFixed(3) + " (" + (w.d / 1000).toFixed(1) + " km)" : "  → 40km 内没水";
  }
  console.log(s);
}
