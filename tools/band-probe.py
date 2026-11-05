import sys
from PIL import Image
CANVAS = (234, 56, 1292, 748)
for path in sys.argv[1:]:
    im = Image.open(path).convert('RGB').crop(CANVAS)
    w, h = im.size
    px = im.load()
    print(path, w, h)
    bands = 8
    for b in range(bands):
        y0 = h * b // bands
        y1 = h * (b + 1) // bands
        amber = red = cyan = 0
        for y in range(y0, y1):
            for x in range(w):
                r, g, bl = px[x, y]
                if r > 190 and g > 120 and bl < 130 and r > bl + 70: amber += 1
                if r > 180 and g < 120 and bl < 120: red += 1
                if g > 150 and bl > 180 and r < 150: cyan += 1
        print(f'  band {b} y{y0}-{y1}: amber {amber}  red {red}  cyan {cyan}')
