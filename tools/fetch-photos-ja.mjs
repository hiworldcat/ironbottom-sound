/* 英文维基没有照片的日舰，去日文维基找 —— 日文条目几乎都有舰影写真 */
import fs from "node:fs";
import path from "node:path";

const UA = "ironbottom-sound/1.0 (WWII naval game; https://github.com/hiworldcat)";
const roster = JSON.parse(fs.readFileSync("tools/roster.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("tools/photo-manifest.json", "utf8"));
const OUT = "assets/ships";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIMP2JP = { "风": "風", "云": "雲", "雾": "霧", "滨": "浜", "皋": "皐", "矶": "磯", "卷": "巻", "雪风": "雪風", "滨风": "浜風" };
function toJa(n) {
  if (SIMP2JP[n]) return SIMP2JP[n];
  let s = n;
  for (const k in SIMP2JP) s = s.split(k).join(SIMP2JP[k]);
  return s;
}
function slug(t) {
  return t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429) { await sleep(1500); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}
function thumb500(src) {
  const base = src.split("?")[0];
  const m = base.match(/^(.*\/thumb\/.*\/)(\d+)px-([^/]+)$/);
  return m ? m[1] + "500px-" + m[3] : base;
}

let ok = 0;
for (const ship of roster) {
  if (manifest[ship.name]) continue;
  if (ship.cls === "barge" || ship.cls === "transport") continue;
  const ja = toJa(ship.name);
  const q = "https://ja.wikipedia.org/w/api.php?action=query&format=json&generator=search" +
    "&gsrsearch=" + encodeURIComponent(ja + " 駆逐艦") + "&gsrlimit=1&prop=pageimages|info&inprop=url&piprop=original";
  const j = await getJson(q);
  if (!j || !j.query || !j.query.pages) { console.log("✗ " + ship.name + "（日文维基也没搜到）"); continue; }
  let best = null;
  for (const k in j.query.pages) best = j.query.pages[k];
  const img = best.original;
  if (!img || !img.width) { console.log("✗ " + ship.name + "（" + best.title + " 没图）"); continue; }
  const bad = /crest|badge|seal|emblem|wappen|shield|flag|map|plan|diagram|silhouette|logo|icon/i
    .test(decodeURIComponent(img.source));
  if (bad || img.width / img.height < 0.6) { console.log("✗ " + ship.name + "（图不合适）"); continue; }
  const file = slug("ja-" + best.title) + ".jpg";
  const dest = path.join(OUT, file);
  try {
    let r = null;
    for (let i = 0; i < 3; i++) {
      r = await fetch(thumb500(img.source), { headers: { "User-Agent": UA } });
      if (r.ok) break;
      await sleep(1200);
    }
    if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "?"));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) throw new Error("图太小");
    fs.writeFileSync(dest, buf);
    manifest[ship.name] = { file: file, title: best.title, page: best.fullurl || "" };
    ok++;
    console.log("✓ " + ship.name.padEnd(8, "　") + " → " + best.title + "  " + Math.round(buf.length / 1024) + " KB");
  } catch (e) {
    console.log("✗ " + ship.name + " 下载失败: " + e.message);
  }
  await sleep(400);
}
fs.writeFileSync("tools/photo-manifest.json", JSON.stringify(manifest, null, 1));
console.log("\n日文维基补了 " + ok + " 张，现在共 " + Object.keys(manifest).length + " 艘有照片");
