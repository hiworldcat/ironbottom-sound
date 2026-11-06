/* 大图版：给放大查看用，维基只认 960 这一档 */
import fs from "node:fs";
import path from "node:path";

const UA = "ironbottom-sound/1.0 (WWII naval game; https://github.com/hiworldcat)";
const manifest = JSON.parse(fs.readFileSync("tools/photo-manifest.json", "utf8"));
const OUT = "assets/ships/lg";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429) { await sleep(1500); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

const done = new Set();
let n = 0;
for (const name in manifest) {
  const m = manifest[name];
  if (done.has(m.file)) continue;
  const dest = path.join(OUT, m.file);
  if (fs.existsSync(dest)) { done.add(m.file); continue; }

  let src = null;
  if (/^https?:\/\//.test(m.page)) {
    const t = decodeURIComponent(m.page.split("/wiki/")[1] || "");
    if (t) {
      const host = (m.page.match(/^https?:\/\/([^\/]+)/) || [])[1] || "en.wikipedia.org";
      const j = await getJson("https://" + host + "/api/rest_v1/page/summary/" + encodeURIComponent(t));
      const im = j && (j.originalimage || j.thumbnail);
      if (im) src = im.source;
    }
  }
  if (!src) { console.log("✗ " + name + "（找不到源图）"); continue; }
  const base = src.split("?")[0];
  const mm = base.match(/^(.*\/thumb\/.*\/)(\d+)px-([^/]+)$/);
  const url = mm ? mm[1] + "960px-" + mm[3] : base;
  try {
    let r = null;
    for (let i = 0; i < 3; i++) {
      r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.ok) break;
      await sleep(1000);
    }
    if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "?"));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 8000) throw new Error("图太小");
    fs.writeFileSync(dest, buf);
    done.add(m.file);
    n++;
    if (n % 20 === 0) console.log("… 已存 " + n);
  } catch (e) {
    console.log("✗ " + name + " " + e.message);
  }
  await sleep(200);
}
console.log("大图 " + done.size + " 张");
