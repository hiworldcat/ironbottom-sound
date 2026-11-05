"""截图分析：无法直接看图时，用像素统计 + 连通域检测判断画面是否正常渲染。

用法: python tools/inspect-shot.py shots/adv600.png
"""
import sys
from collections import deque
from PIL import Image

BLOCK = 3   # 下采样块大小


def region_stats(im, box, label):
    crop = im.crop(box)
    px = list(crop.getdata())
    n = len(px)
    if n == 0:
        return
    r = sum(p[0] for p in px) / n
    g = sum(p[1] for p in px) / n
    b = sum(p[2] for p in px) / n
    bright = sum(1 for p in px if p[0] + p[1] + p[2] > 330)
    print(f"  {label:<12} mean=({r:5.1f},{g:5.1f},{b:5.1f})  亮像素={bright:6d}  色数={len(set(px)):5d}")


def blobs(im, pred, min_px=6, label=""):
    w, h = im.size
    sw, sh = w // BLOCK, h // BLOCK
    small = im.resize((sw, sh), Image.BILINEAR)
    px = small.load()
    mask = [[False] * sw for _ in range(sh)]
    for y in range(sh):
        for x in range(sw):
            r, g, b = px[x, y]
            if pred(r, g, b):
                mask[y][x] = True
    seen = [[False] * sw for _ in range(sh)]
    out = []
    for y in range(sh):
        for x in range(sw):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            pts = []
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < sw and 0 <= ny < sh and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(pts) >= min_px:
                mx = sum(p[0] for p in pts) / len(pts) * BLOCK
                my = sum(p[1] for p in pts) / len(pts) * BLOCK
                out.append((len(pts), int(mx), int(my)))
    out.sort(reverse=True)
    print(f"  {label}: {len(out)} 个连通域")
    for n, mx, my in out[:10]:
        print(f"     面积={n:4d}  中心=({mx:4d},{my:4d})")
    return out


def main(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    print(f"图像 {w}x{h}")
    print("区域统计:")
    region_stats(im, (0, 0, w, 56), '顶栏')
    region_stats(im, (0, 56, 234, h), '左侧编队')
    region_stats(im, (w - 308, 56, w, h), '右侧详情')
    region_stats(im, (234, h - 152, w - 308, h), '底部战报')
    region_stats(im, (234, 56, w - 308, h - 152), '海图区域')

    print("连通域:")
    blobs(im, lambda r, g, b: b > 150 and g > 150 and r < 160, 4, '青色(己方舰艇/UI)')
    blobs(im, lambda r, g, b: r > 190 and 110 < g < 210 and b < 130, 3, '琥珀(接触符号)')

    print("颜色覆盖:")
    small = im.resize((w // 2, h // 2), Image.BILINEAR)
    pxs = list(small.getdata())
    def frac(pred):
        return sum(1 for p in pxs if pred(*p)) / len(pxs) * 100
    print(f"  海色 {frac(lambda r,g,b: b>r+20 and b<120):.1f}%  "
          f"陆地 {frac(lambda r,g,b: g>r+8 and g>b+8 and g<110):.1f}%  "
          f"暗底 {frac(lambda r,g,b: r+g+b<90):.1f}%")

    uniq = len(set(pxs))
    if uniq < 40:
        print("❌ 画面接近纯色，可能没有渲染")
        return 1
    print("✅ 画面有内容")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
