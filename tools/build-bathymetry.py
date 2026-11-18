# -*- coding: utf-8 -*-
"""
把 Natural Earth 1:10m 的海深多边形裁到本作的海域，简化后写成 js/data/bathymetry.js。

数据来源：Natural Earth 1:10m Physical Vectors —— bathymetry（公有领域）。
每一层是"比这个深度更深的全部海域"，所以画的时候从浅到深一层层叠上去就是分带。

用法：python tools/build-bathymetry.py
原始 GeoJSON 会缓存在 %TEMP%\\ne-bathy，删掉就会重新下。
"""
import io
import json
import os
import sys

# 海域范围（比 N.MAP.bounds 稍微放大一圈，免得拖到边缘看见断口）
LON0, LON1 = 152.0, 163.0
LAT0, LAT1 = -11.7, -3.9

TOL = 0.0008          # 简化容差，度（约 90 米，和 coastline.js 一致）
MIN_AREA = 0.00002    # 丢掉小于这个面积（平方度，约 0.24 平方公里）的碎片
CACHE = os.path.join(os.environ.get('TEMP', '.'), 'ne-bathy')
LAYERS = ['K_200', 'J_1000', 'I_2000', 'H_3000', 'G_4000',
          'F_5000', 'E_6000', 'D_7000', 'C_8000', 'B_9000', 'A_10000']
BASE = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/'
        'master/geojson/ne_10m_bathymetry_%s.geojson')


# ----------------------------------------------------------------- 几何工具
def clip_ring(ring, x0, y0, x1, y1):
    """Sutherland–Hodgman：把一条环裁到矩形里。矩形外的部分直接切掉。"""
    def clip_edge(pts, inside, inter):
        out = []
        n = len(pts)
        if not n:
            return out
        prev = pts[-1]
        pin = inside(prev)
        for cur in pts:
            cin = inside(cur)
            if cin:
                if not pin:
                    out.append(inter(prev, cur))
                out.append(cur)
            elif pin:
                out.append(inter(prev, cur))
            prev, pin = cur, cin
        return out

    def ix(a, b, x):
        t = (x - a[0]) / (b[0] - a[0])
        return [x, a[1] + t * (b[1] - a[1])]

    def iy(a, b, y):
        t = (y - a[1]) / (b[1] - a[1])
        return [a[0] + t * (b[0] - a[0]), y]

    pts = list(ring)
    for inside, inter in (
        (lambda p: p[0] >= x0, lambda a, b: ix(a, b, x0)),
        (lambda p: p[0] <= x1, lambda a, b: ix(a, b, x1)),
        (lambda p: p[1] >= y0, lambda a, b: iy(a, b, y0)),
        (lambda p: p[1] <= y1, lambda a, b: iy(a, b, y1)),
    ):
        pts = clip_edge(pts, inside, inter)
        if not pts:
            return []
    return pts


def dp(pts, tol):
    """Douglas–Peucker，迭代写法（递归会爆栈）。"""
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if den < 1e-18:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / den
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if best > tol * tol and bi > 0:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [pts[i] for i in range(n) if keep[i]]


def ring_area(pts):
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def rings_of(geom):
    """把 Polygon / MultiPolygon 拆成环列表。

    必须连洞一起留：这些图层是“比 d 米更深的全部海域”，岛和浅滩是以洞的
    形式挖掉的。只留外环的话，深水会把整片浅滩都盖住。
    画的时候用 even-odd 填充，洞自然会空出来，不依赖环的绕向。
    """
    t = geom.get('type')
    if t == 'Polygon':
        return list(geom['coordinates'])
    if t == 'MultiPolygon':
        out = []
        for poly in geom['coordinates']:
            out.extend(poly)
        return out
    return []


# ----------------------------------------------------------------- 主流程
def main():
    out = []
    total_pts = 0
    for name in LAYERS:
        path = os.path.join(CACHE, name + '.geojson')
        if not os.path.exists(path):
            print('缺文件：' + path, file=sys.stderr)
            return 1
        with io.open(path, encoding='utf-8') as f:
            gj = json.load(f)
        depth = int(name.split('_')[-1])
        rings = []
        for feat in gj['features']:
            for r in rings_of(feat['geometry']):
                c = clip_ring([[p[0], p[1]] for p in r], LON0, LAT0, LON1, LAT1)
                if len(c) < 4:
                    continue
                if ring_area(c) < MIN_AREA:
                    continue
                s = dp(c, TOL)
                if len(s) < 4 or ring_area(s) < MIN_AREA:
                    continue
                rings.append([[round(p[0], 4), round(p[1], 4)] for p in s])
        n = sum(len(r) for r in rings)
        total_pts += n
        out.append((depth, rings))
        print('%-8s 环 %4d 点 %6d' % (name, len(rings), n), flush=True)

    js = ['/* =====================================================================',
          ' *  真实海深（等深线）—— 所罗门群岛',
          ' *  ---------------------------------------------------------------------',
          ' *  数据来源：Natural Earth 1:10m Physical Vectors —— bathymetry，公有领域。',
          ' *  裁到本作海域后用 Douglas–Peucker 简化到约 90 米，和 coastline.js 一致。',
          ' *',
          ' *  每层是"比 d 米更深的全部海域"（嵌套的），所以从浅到深一层层叠上去，',
          ' *  露出来的就是 0-200 / 200-1000 / … 的分带。lonLat 是 [经度, 纬度]。',
          ' *  由 tools/build-bathymetry.py 生成，别手改。',
          ' * ===================================================================== */',
          '(function (N) {',
          '  N.BATHY_LL = [']
    for depth, rings in out:
        js.append('    { d: %d, rings: [' % depth)
        for r in rings:
            js.append('      [' + ','.join('[%g,%g]' % (p[0], p[1]) for p in r) + '],')
        js.append('    ] },')
    js.append('  ];')
    js.append('})(globalThis.Naval = globalThis.Naval || {});')
    text = '\n'.join(js) + '\n'

    dest = os.path.join('js', 'data', 'bathymetry.js')
    with io.open(dest, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('\n写出 %s：%.1f KB，共 %d 个点' % (dest, len(text.encode('utf-8')) / 1024.0, total_pts))
    return 0


if __name__ == '__main__':
    sys.exit(main())
