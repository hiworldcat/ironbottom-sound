/* 从维基百科抓每艘舰的历史照片，存到 assets/ships/，并生成 js/data/ship-photos.js */
import fs from "node:fs";
import path from "node:path";

const UA = "ironbottom-sound/1.0 (WWII naval game; https://github.com/hiworldcat)";

const ART = JSON.parse(fs.readFileSync("tools/photo-titles.json", "utf8"));
const CLASS_FALLBACK = JSON.parse(fs.readFileSync("tools/photo-class.json", "utf8"));
const roster = JSON.parse(fs.readFileSync("tools/roster.json", "utf8"));

const OUT = "assets/ships";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(t) {
  return t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function getJson(url, tries) {
  for (let i = 0; i < (tries || 4); i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

async function leadImage(title) {
  const t = title.replace(/ /g, "_");
  let j = await getJson("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t));
  if (j) {
    const c = j.originalimage || j.thumbnail;
    if (c && c.source) return { src: c.source, w: c.width || 0, h: c.height || 0, title: j.title, page: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || "" };
  }
  // 有些条目首图不在 summary 里，用 pageimages 再试一次
  const api = "https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages|info&inprop=url" +
    "&piprop=original&titles=" + encodeURIComponent(title);
  const q = await getJson(api);
  if (q && q.query && q.query.pages) {
    for (const k in q.query.pages) {
      const p = q.query.pages[k];
      if (p.original && p.original.source) {
        return { src: p.original.source, w: p.original.width || 0, h: p.original.height || 0, title: p.title, page: p.fullurl || "" };
      }
    }
  }
  // 最后再翻条目里用到的图片，挑一张文件名像这条船的
  const api2 = "https://en.wikipedia.org/w/api.php?action=query&format=json&prop=images&imlimit=30&titles=" + encodeURIComponent(title);
  const q2 = await getJson(api2);
  if (!q2 || !q2.query || !q2.query.pages) return null;
  for (const k in q2.query.pages) {
    const p = q2.query.pages[k];
    if (!p.images) continue;
    const cands = p.images
      .map((x) => x.title)
      .filter((x) => /\.(jpg|jpeg)$/i.test(x))
      .filter((x) => !/commons-logo|wiki|icon|question|edit|symbol|disambig/i.test(x));
    for (const c of cands) {
      const ii = await getJson("https://en.wikipedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size&titles=" +
        encodeURIComponent(c));
      if (!ii || !ii.query || !ii.query.pages) continue;
      for (const kk in ii.query.pages) {
        const pp = ii.query.pages[kk];
        const info = pp.imageinfo && pp.imageinfo[0];
        if (info && info.width >= 400) {
          return { src: info.url, w: info.width, h: info.height, title: title, page: pp.descriptionurl || "" };
        }
      }
    }
  }
  return null;
}

function thumbUrl(src, width) {
  const q = src.indexOf("?");
  const base = q >= 0 ? src.slice(0, q) : src;
  const m = base.match(/^(.*\/thumb\/.*\/)(\d+)px-([^/]+)$/);
  if (m) {
    // 维基现在只认几个固定宽度，乱填会回 400；500 是稳定可用的那一档
    return m[1] + "500px-" + m[3];
  }
  return base;
}

const manifest = {};
const usedFiles = new Set();
let ok = 0, fail = 0;

for (const ship of roster) {
  const title = ART[ship.name] || CLASS_FALLBACK[ship.cls];
  if (!title) { fail++; continue; }
  const file = slug(title) + ".jpg";
  const dest = path.join(OUT, file);

  if (usedFiles.has(file) || fs.existsSync(dest)) {
    const info = await leadImage(title);
    manifest[ship.name] = {
      file: file,
      title: (info && info.title) || title,
      page: (info && info.page) || "https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"))
    };
    usedFiles.add(file);
    ok++;
    continue;
  }

  const info = await leadImage(title);
  // 舰徽、旗帜、地图、线图都不是照片；文件名能挡掉大部分
  const bad = info && /crest|badge|seal|emblem|wappen|shield|coat[ _]of[ _]arms|flag|map|plan|diagram|silhouette|logo|icon/i
    .test(decodeURIComponent(info.src || ""));
  const wide = ship.cls === "barge" ? 0.55 : 0.65;
  if (!info || !info.w || bad || info.w / info.h < wide || info.w < 400) {
    console.log("✗  " + ship.name.padEnd(10, "　") + " → " + title + (info ? "（图不合适 " + info.w + "x" + info.h + "）" : "（无图）"));
    fail++;
    continue;
  }
  try {
    let r = null;
    for (let i = 0; i < 4; i++) {
      r = await fetch(thumbUrl(info.src, 620), { headers: { "User-Agent": UA } });
      if (r.ok) break;
      await sleep(1000 * (i + 1));
    }
    if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "?"));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) throw new Error("图太小 " + buf.length);
    fs.writeFileSync(dest, buf);
    usedFiles.add(file);
    manifest[ship.name] = {
      file: file,
      title: info.title || title,
      page: info.page || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")))
    };
    ok++;
    console.log("✓  " + ship.name.padEnd(10, "　") + " → " + title + "  " + Math.round(buf.length / 1024) + " KB");
  } catch (e) {
    console.log("✗  " + ship.name + " 下载失败: " + e.message);
    fail++;
  }
  await sleep(220);
}

fs.writeFileSync("tools/photo-manifest.json", JSON.stringify(manifest, null, 1));
console.log("\n成功 " + ok + " / " + roster.length + "，失败 " + fail);
