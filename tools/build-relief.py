# -*- coding: utf-8 -*-
"""
从 AWS Terrain Tiles（SRTM 等公开高程数据，公有领域）生成海域的山体阴影图。

输出 assets/map/relief.png：陆地处是着色过的晕渲，海面全透明，
运行时直接 drawImage 到地图上，不做逐像素计算。

用法：python tools/build-relief.py
瓦片缓存在 %TEMP%\\terrarium，删掉会重新下。
"""
import base64
import io
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

LON0, LON1 = 151.6, 163.4
LAT0, LAT1 = -11.9, -3.7
ZOOM = 8            # 约 610 米/像素；输出 1500 宽已经比它粗，再高一级是浪费
OUT_W, OUT_H = 1500, 1080
WORKERS = 8
CACHE = os.path.join(os.environ.get('TEMP', '.'), 'terrarium')
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png'


def lonlat_to_px(lon, lat, z):
    n = 256 * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def fetch(z, x, y):
    p = os.path.join(CACHE, '%d_%d_%d.png' % (z, x, y))
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    os.makedirs(CACHE, exist_ok=True)
    tmp = p + '.part'
    for _ in range(4):
        try:
            urllib.request.urlretrieve(URL % (z, x, y), tmp)
            if os.path.getsize(tmp) > 0:
                os.replace(tmp, p)
                return p
        except Exception as e:
            print('重试 %d/%d/%d %s' % (z, x, y, e), flush=True)
    return None


def fetch_all(z, coords):
    """并发下载。串行一晚上也下不完，S3 单连接限得厉害。"""
    from concurrent.futures import ThreadPoolExecutor
    done = [0]
    total = len(coords)

    def one(c):
        r = fetch(z, c[0], c[1])
        done[0] += 1
        if done[0] % 10 == 0 or done[0] == total:
            print('  瓦片 %d/%d' % (done[0], total), flush=True)
        return r

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(one, coords))


def main():
    x0, y0 = lonlat_to_px(LON0, LAT1, ZOOM)      # 左上（纬度大的在上面）
    x1, y1 = lonlat_to_px(LON1, LAT0, ZOOM)      # 右下
    tx0, ty0 = int(x0 // 256), int(y0 // 256)
    tx1, ty1 = int(x1 // 256), int(y1 // 256)
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    print('瓦片 %d x %d = %d 张（z=%d）' % (nx, ny, nx * ny, ZOOM), flush=True)

    coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    fetch_all(ZOOM, coords)

    big = np.zeros((ny * 256, nx * 256), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = os.path.join(CACHE, '%d_%d_%d.png' % (ZOOM, tx, ty))
            if not os.path.exists(p) or os.path.getsize(p) == 0:
                continue
            im = Image.open(p).convert('RGB')
            a = np.asarray(im, dtype=np.float32)
            h = a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0
            big[(ty - ty0) * 256:(ty - ty0) * 256 + 256,
                (tx - tx0) * 256:(tx - tx0) * 256 + 256] = h

    # 裁出海域
    cx0, cy0 = int(round(x0 - tx0 * 256)), int(round(y0 - ty0 * 256))
    cx1, cy1 = int(round(x1 - tx0 * 256)), int(round(y1 - ty0 * 256))
    crop = big[cy0:cy1, cx0:cx1]
    print('裁剪后 %s' % (crop.shape,), flush=True)

    img = Image.fromarray(crop.astype(np.float32), mode='F').resize(
        (OUT_W, OUT_H), Image.BILINEAR)
    z = np.asarray(img, dtype=np.float32)
    z = np.maximum(z, 0.0)

    # 晕渲：西北方向来光，这是制图惯例
    dy, dx = np.gradient(z)
    # 每个像素对应多少米，用来把坡度归一化
    mx = (LON1 - LON0) * 111320.0 * math.cos(math.radians((LAT0 + LAT1) / 2)) / OUT_W
    my = (LAT1 - LAT0) * 110574.0 / OUT_H
    sx = dx / mx
    sy = dy / my
    az, alt = math.radians(315.0), math.radians(45.0)
    lx, ly = math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt)
    lz = math.sin(alt)
    norm = np.sqrt(sx * sx + sy * sy + 1.0)
    shade = (-sx * lx - sy * ly + lz) / norm
    shade = np.clip(shade, 0.0, 1.0)
    shade = 0.50 + 0.65 * shade          # 保留一点环境光，别让背光面死黑

    # 高程配色：低地深绿，山脊偏黄绿，再高一点泛灰
    t = np.clip(z / 2600.0, 0.0, 1.0)
    lo = np.array([44.0, 74.0, 42.0])
    mid = np.array([86.0, 112.0, 66.0])
    hi = np.array([140.0, 148.0, 116.0])
    col = np.empty(z.shape + (3,), dtype=np.float32)
    for c in range(3):
        col[:, :, c] = np.where(t < 0.5,
                                lo[c] + (mid[c] - lo[c]) * (t / 0.5),
                                mid[c] + (hi[c] - mid[c]) * ((t - 0.5) / 0.5))
    col *= shade[:, :, None]

    # 海面透明；海岸附近给一点羽化，免得和矢量海岸线打架
    alpha = np.clip((z - 2.0) / 60.0, 0.0, 1.0)

    out = np.zeros(z.shape + (4,), dtype=np.uint8)
    out[:, :, :3] = np.clip(col, 0, 255).astype(np.uint8)
    out[:, :, 3] = (alpha * 255).astype(np.uint8)

    # 存成 data URI 内联进 JS，而不是丢一个 png 到 assets 里。
    # 原因：file:// 打开的页面里，画过外部图片的 canvas 会被污染，
    # captureStream（录像功能）会直接抛 SecurityError；data URI 不会。
    img = Image.fromarray(out, mode='RGBA').quantize(colors=256, method=Image.FASTOCTREE)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    png = buf.getvalue()
    b64 = base64.b64encode(png).decode('ascii')

    dest = os.path.join('js', 'data', 'relief.js')
    text = ('/* =====================================================================\n'
            ' *  陆地晕渲图 —— 所罗门群岛\n'
            ' *  ---------------------------------------------------------------------\n'
            ' *  高程来自 AWS Terrain Tiles（SRTM 等公开数据，公有领域），\n'
            ' *  在 tools/build-relief.py 里算好坡度、按西北来光做晕渲，再染成丛林色。\n'
            ' *  海面全透明，运行时按世界坐标整张贴上去，不做逐像素计算。\n'
            ' *\n'
            ' *  为什么是 data URI 而不是 assets 里的 png：file:// 下画过外部图片的\n'
            ' *  canvas 会被污染，captureStream 录像会抛 SecurityError。data URI 不会。\n'
            ' *  由 tools/build-relief.py 生成，别手改。\n'
            ' * ===================================================================== */\n'
            '(function (N) {\n'
            '  N.RELIEF_SRC = "data:image/png;base64,' + b64 + '";\n'
            '})(globalThis.Naval = globalThis.Naval || {});\n')
    with io.open(dest, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('写出 %s：PNG %.0f KB / JS %.0f KB' % (
        dest, len(png) / 1024.0, len(text.encode('utf-8')) / 1024.0))
    print('高程范围 %.0f ~ %.0f 米' % (z.min(), z.max()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
