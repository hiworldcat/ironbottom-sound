import sys
from collections import deque
from PIL import Image
CANVAS = (234, 56, 1292, 748)

def clusters(px, w, h, pred, min_px=8):
    seen = bytearray(w*h); out=[]
    for y in range(h):
        for x in range(w):
            i=y*w+x
            if seen[i] or not pred(*px[x,y]): continue
            seen[i]=1; q=deque([(x,y)]); n=0; sx=sy=0
            minx=maxx=x; miny=maxy=y
            while q:
                cx,cy=q.popleft(); n+=1; sx+=cx; sy+=cy
                minx=min(minx,cx); maxx=max(maxx,cx); miny=min(miny,cy); maxy=max(maxy,cy)
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx,ny=cx+dx,cy+dy
                    if 0<=nx<w and 0<=ny<h and not seen[ny*w+nx] and pred(*px[nx,ny]):
                        seen[ny*w+nx]=1; q.append((nx,ny))
            if n>=min_px: out.append((n,sx//n,sy//n,maxx-minx+1,maxy-miny+1))
    out.sort(reverse=True)
    return out

for path in sys.argv[1:]:
    im = Image.open(path).convert('RGB').crop(CANVAS)
    w,h = im.size; px = im.load()
    warm = lambda r,g,b: r > b + 22 and r > 55 and g > b - 5
    cl = clusters(px,w,h,warm,10)
    print(path, '暖色团块', len(cl))
    for c in cl[:16]:
        print('   area=%3d center=(%4d,%4d) size=%dx%d' % c)
