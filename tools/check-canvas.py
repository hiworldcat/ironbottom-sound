"""只分析海图区域：确认己方舰艇与敌方接触符号确实被画出来了。

用法: python tools/check-canvas.py shots/adv600.png
"""
import sys
from collections import deque
from PIL import Image

CANVAS = (234, 56, 1292, 748)   # 1600x900 下海图可视区域


def clusters(px, w, h, pred, min_px):
    seen = bytearray(w * h)
    out = []
    for y in range(h):
        base = y * w
        for x in range(w):
            i = base + x
            if seen[i] or not pred(px[x, y]):
                continue
            seen[i] = 1
            q = deque([(x, y)])
            n = 0
            sx = sy = 0
            minx = maxx = x
            miny = maxy = y
            while q:
                cx, cy = q.popleft()
                n += 1
                sx += cx
                sy += cy
                if cx < minx: minx = cx
                if cx > maxx: maxx = cx
                if cy < miny: miny = cy
                if cy > maxy: maxy = cy
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and pred(px[nx, ny]):
                            seen[j] = 1
                            q.append((nx, ny))
            if n >= min_px:
                out.append((n, sx // n, sy // n, maxx - minx + 1, maxy - miny + 1))
    out.sort(reverse=True)
    return out


def main(path):
    im = Image.open(path).convert('RGB')
    im = im.crop(CANVAS)
    w, h = im.size
    px = im.load()
    print(f"海图裁剪 {w}x{h}")

    cyan = clusters(px, w, h, lambda p: p[2] > 130 and p[1] > 120 and p[0] < 150, 12)
    amber = clusters(px, w, h, lambda p: p[0] > 170 and p[1] > 110 and p[2] < 150 and p[0] - p[2] > 60, 10)

    print(f"己方舰艇候选（青色团块）: {len(cyan)}")
    for n, cx, cy, bw, bh in cyan[:12]:
        print(f"   面积={n:4d} 中心=({cx:4d},{cy:4d}) 尺寸={bw}x{bh}")
    print(f"接触符号候选（琥珀色团块）: {len(amber)}")
    for n, cx, cy, bw, bh in amber[:12]:
        print(f"   面积={n:4d} 中心=({cx:4d},{cy:4d}) 尺寸={bw}x{bh}")

    ok = len(cyan) >= 3 and len(amber) >= 1
    print("✅ 海图上同时存在己方舰艇与敌方接触" if ok else "⚠ 海图元素不足，需要检查")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
