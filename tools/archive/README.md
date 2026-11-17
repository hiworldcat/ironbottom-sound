# tools/archive —— 退休的脚本

这里放的是**已经不用的**一次性脚本。留着是因为它们记录过当时的做法，
真要翻旧账还能看；但**别再照着跑**，跑出来的结果没有参考价值。

| 文件 | 为什么退休 |
|---|---|
| `fetch-photos-ja2.mjs` | 抓日文维基舰艇照片的第二版，被 `fetch-photos-ja.mjs` 取代 |
| `fetch-photos-ja3.mjs` | 第三版，同上。三版并存过一阵，最后留的是 `ja` |
| `replay-probe.py` | 11 月 3 日查回放帧的一个一次性探针，功能已被 `attr-probe.mjs` 覆盖 |
| `inspect-shot.py` | 同上，当时用来看截图里的某个色块，已被 `shot-stats.py` / `check-canvas.py` 取代 |
| `torp-probe.mjs` | 查鱼雷射界的老探针。它只加载了 9 个模块（缺 `damage` / `tactics` / `squad` / `command` / `weather`），`World` 根本跑不起来，输出是退化的；鱼雷相关的检查现在在 `ai-probe.mjs` 和 `attr-probe.mjs` 里 |

## 注意

移进这个目录之后，**脚本里的相对路径就不成立了** ——
比如 `fetch-photos-ja2.mjs` 读的是 `photo-manifest.json`，现在它在上一层。
真要再跑，先把它挪回 `tools/`，别在这里直接跑。
