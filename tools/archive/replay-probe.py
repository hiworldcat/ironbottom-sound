# -*- coding: utf-8 -*-
"""回放截图检查：分别统计青色（我方）与橙红色（敌方）的舰体团块。"""
import sys
from PIL import Image

def blobs(path, pred, minarea=60):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    out = []
    for y0 in range(0, h):
        for x0 in range(0, w):
            i = y0 * w + x0
            if seen[i]:
                continue
            r, g, b = px[x0, y0]
            if not pred(r, g, b):
                continue
            stack = [(x0, y0)]
            seen[i] = 1
            n = 0
            minx = maxx = x0
            miny = maxy = y0
            while stack:
                x, y = stack.pop()
                n += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if nx < 0 or ny < 0 or nx >= w or ny >= h:
                        continue
                    j = ny * w + nx
                    if seen[j]:
                        continue
                    rr, gg, bb = px[nx, ny]
                    if pred(rr, gg, bb):
                        seen[j] = 1
                        stack.append((nx, ny))
            if n >= minarea:
                out.append((n, minx, miny, maxx - minx + 1, maxy - miny + 1))
    out.sort(reverse=True)
    return out

CYAN = lambda r, g, b: b > 110 and g > 95 and b > r + 40 and g > r + 15
ORANGE = lambda r, g, b: r > 130 and r > b + 45 and g < r - 25

for p in sys.argv[1:]:
    c = blobs(p, CYAN)
    o = blobs(p, ORANGE)
    print(p)
    print("  我方(青) 团块 %d 个，最大: %s" % (len(c), c[:4]))
    print("  敌方(橙) 团块 %d 个，最大: %s" % (len(o), o[:4]))
