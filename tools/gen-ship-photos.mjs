/* 生成 js/data/ship-photos.js：舰名 → 本地照片文件 + 出处 */
import fs from "node:fs";
import path from "node:path";

const roster = JSON.parse(fs.readFileSync("tools/roster.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("tools/photo-manifest.json", "utf8"));
const CLASS_FALLBACK = JSON.parse(fs.readFileSync("tools/photo-class.json", "utf8"));
const OUT = "assets/ships";

function slug(t) {
  return t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
function exists(f) {
  return fs.existsSync(path.join(OUT, f));
}

const entries = [];
let own = 0, cls = 0, none = 0;

for (const ship of roster) {
  let m = manifest[ship.name];
  if (m && exists(m.file)) {
    entries.push({ name: ship.name, file: m.file, title: m.title, page: m.page, same: false });
    own++;
    continue;
  }
  const ct = CLASS_FALLBACK[ship.cls];
  if (ct) {
    const f = slug(ct) + ".jpg";
    if (exists(f)) {
      entries.push({
        name: ship.name, file: f, title: ct,
        page: "https://en.wikipedia.org/wiki/" + encodeURIComponent(ct.replace(/ /g, "_")),
        same: true
      });
      cls++;
      continue;
    }
  }
  none++;
}

const lines = entries.map((e) =>
  "    " + JSON.stringify(e.name) + ": { file: " + JSON.stringify(e.file) +
  ", title: " + JSON.stringify(e.title) + ", page: " + JSON.stringify(e.page) +
  (e.same ? ", same: 1" : "") +
  (fs.existsSync(path.join(OUT, "lg", e.file)) ? ", lg: 1" : "") + " }"
);

const head = `/* =====================================================================
 *  舰艇历史照片
 *  ---------------------------------------------------------------------
 *  每艘舰一张它自己历史上的照片（找不到的用同型舰代表照片，标 same: 1）。
 *  图片来自 Wikimedia Commons / 维基百科条目，已下载到 assets/ships/ 本地，
 *  断网也能显示。page 是原始条目地址，界面上会标出来源。
 * ===================================================================== */
(function (N) {
  N.SHIP_PHOTOS = {
`;
const tail = `  };
})(globalThis.Naval = globalThis.Naval || {});
`;
fs.writeFileSync("js/data/ship-photos.js", head + lines.join(",\n") + "\n" + tail, "utf8");
console.log("本舰照片 " + own + "，同型舰代表 " + cls + "，没有 " + none + "，合计 " + entries.length);
console.log("文件 " + (fs.statSync("js/data/ship-photos.js").size / 1024).toFixed(0) + " KB");
