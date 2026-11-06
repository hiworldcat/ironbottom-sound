/* 点名查日文维基条目 —— 搜索会串到同型舰或者别的船，这里直接按条目名取 */
import fs from "node:fs";
import path from "node:path";

const UA = "ironbottom-sound/1.0 (WWII naval game; https://github.com/hiworldcat)";
const manifest = JSON.parse(fs.readFileSync("tools/photo-manifest.json", "utf8"));
const OUT = "assets/ships";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TITLES = {
  "雷": "雷 (吹雪型駆逐艦)",
  "夕立": "夕立 (白露型駆逐艦)",
  "春雨": "春雨 (白露型駆逐艦)",
  "初雪": "初雪 (吹雪型駆逐艦)",
  "皋月": "皐月 (睦月型駆逐艦)",
  "江风": "江風 (駆逐艦)",
  "川风": "川風 (駆逐艦)",
  "夕雾": "夕霧 (吹雪型駆逐艦)",
  "高波": "高波 (駆逐艦)",
  "照月": "照月 (駆逐艦)",
  "大波": "大波 (駆逐艦)"
};

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

for (const name in TITLES) {
  const title = TITLES[name];
  const q = "https://ja.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages|info&inprop=url" +
    "&piprop=original&redirects=1&titles=" + encodeURIComponent(title);
  const j = await getJson(q);
  if (!j || !j.query || !j.query.pages) { console.log("✗ " + name + " 查不到 " + title); continue; }
  let page = null;
  for (const k in j.query.pages) page = j.query.pages[k];
  if (!page || page.missing !== undefined) { console.log("✗ " + name + " 条目不存在: " + title); continue; }
  const img = page.original;
  if (!img || !img.width) { console.log("✗ " + name + " " + title + " 没图，稍后用同型舰"); continue; }
  const file = slug("ja-" + (page.title || title)) + ".jpg";
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
    manifest[name] = { file: file, title: page.title || title, page: page.fullurl || "" };
    console.log("✓ " + name.padEnd(8, "　") + " → " + (page.title || title) + "  " + Math.round(buf.length / 1024) + " KB");
  } catch (e) {
    console.log("✗ " + name + " 下载失败: " + e.message);
  }
  await sleep(400);
}
fs.writeFileSync("tools/photo-manifest.json", JSON.stringify(manifest, null, 1));
console.log("\n共 " + Object.keys(manifest).length + " 艘");
