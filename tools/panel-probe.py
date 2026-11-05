import sys
from collections import deque
from PIL import Image

def clusters(px, w, h, pred, min_px=6):
    seen=bytearray(w*h); out=[]
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

im = Image.open(sys.argv[1]).convert('RGB')
px = im.load()
# 右侧详情面板
box = (1292, 56, 1600, 900)
crop = im.crop(box); w,h = crop.size; cpx = crop.load()
cyan = lambda r,g,b: g>120 and b>150 and b>r+40
cl = clusters(cpx,w,h,cyan,6)
print('详情面板 青色团块', len(cl))
for c in cl[:10]:
    print('   area=%3d center=(%3d,%3d) size=%dx%d' % c)
