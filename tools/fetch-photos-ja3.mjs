/* 日文维基补图（重做）：文件名用舰名的序号，避免中文标题被 slug 成 "ja" */
import fs from "node:fs";
import path from "node:path";

const UA = "ironbottom-sound/1.0 (WWII naval game; https://github.com/hiworldcat)";
const roster = JSON.parse(fs.readFileSync("tools/roster.json", "utf8"));
let manifest = JSON.parse(fs.readFileSync("tools/photo-manifest.json", "utf8"));
const OUT = "assets/ships";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先把上一轮串成 ja.jpg 的条目全部丢掉
const stale = [];
for (const n in manifest) {
  if (manifest[n].file === "ja.jpg") { stale.push(n); delete manifest[n]; }
}
console.log("清掉串图的条目:", stale.join(" "));
if (fs.existsSync(path.join(OUT, "ja.jpg"))) fs.unlinkSync(path.join(OUT, "ja.jpg"));

const TITLES = {
  "雷": "雷 (吹雪型駆逐艦)",
  "夕立": "夕立 (白露型駆逐艦)",
  "春雨": "春雨 (白露型駆逐艦)",
  "初雪": "初雪 (吹雪型駆逐艦)",
  "皋月": "皐月 (睦月型駆逐艦)",
  "夕雾": "夕霧 (吹雪型駆逐艦)",
  "雪风": "雪風 (駆逐艦)",
  "浜风": "浜風 (陽炎型駆逐艦)",
  "滨风": "浜風 (陽炎型駆逐艦)",
  "天雾": "天霧 (駆逐艦)",
  "五月雨": "五月雨 (駆逐艦)",
  "矶风": "磯風 (陽炎型駆逐艦)",
  "峰云": "峯雲 (駆逐艦)",
  "卷波": "巻波 (駆逐艦)",
  "卯月": "卯月 (睦月型駆逐艦)",
  "夕云": "夕雲型駆逐艦"
};

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

let i = 0;
for (const name in TITLES) {
  i++;
  const title = TITLES[name];
  const q = "https://ja.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages|info&inprop=url" +
    "&piprop=original&redirects=1&titles=" + encodeURIComponent(title);
  const j = await getJson(q);
  if (!j || !j.query || !j.query.pages) { console.log("✗ " + name); continue; }
  let page = null;
  for (const k in j.query.pages) page = j.query.pages[k];
  const img = page && page.original;
  if (!img || !img.width) { console.log("✗ " + name + " " + title + " 没图"); continue; }
  const file = "jp-" + String(i).padStart(2, "0") + ".jpg";
  const dest = path.join(OUT, file);
  try {
    let r = null;
    for (let t = 0; t < 3; t++) {
      r = await fetch(thumb500(img.source), { headers: { "User-Agent": UA } });
      if (r.ok) break;
      await sleep(1200);
    }
    if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "?"));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) throw new Error("图太小");
    fs.writeFileSync(dest, buf);
    manifest[name] = {
      file: file,
      title: page.title || title,
      page: page.fullurl || ("https://ja.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")))
    };
    console.log("✓ " + name.padEnd(8, "　") + " → " + (page.title || title) + "  " + Math.round(buf.length / 1024) + " KB");
  } catch (e) {
    console.log("✗ " + name + " 下载失败: " + e.message);
  }
  await sleep(400);
}
fs.writeFileSync("tools/photo-manifest.json", JSON.stringify(manifest, null, 1));
console.log("\n现在 " + Object.keys(manifest).length + " 艘有本舰照片");
