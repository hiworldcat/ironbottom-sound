"""截图颜色统计：确认海图区域确实有内容、夜战变暗、岸上目标/区域圈可见。

用法: python tools/shot-stats.py shot-day.png shot-night.png ...
"""
import sys
from collections import Counter
from PIL import Image

CANVAS = (234, 56, 1292, 748)   # 1600x900 下海图可视区域


def stats(path):
    im = Image.open(path).convert('RGB')
    px = im.crop(CANVAS)
    w, h = px.size
    data = list(px.getdata())
    n = len(data)

    total = [0, 0, 0]
    for r, g, b in data:
        total[0] += r
        total[1] += g
        total[2] += b
    avg = [round(c / n, 1) for c in total]

    def frac(pred):
        return round(sum(1 for c in data if pred(*c)) / n * 100, 2)

    # 亮青色（己方舰体）
    cyan = frac(lambda r, g, b: g > 150 and b > 180 and r < 150)
    # 琥珀/橙色（区域圈、岸上目标、指令航向）
    amber = frac(lambda r, g, b: r > 190 and g > 120 and b < 130 and r > b + 70)
    # 红色（敌方航迹、目标线）
    red = frac(lambda r, g, b: r > 180 and g < 120 and b < 120)
    # 近白（文字/标签）
    white = frac(lambda r, g, b: r > 225 and g > 235 and b > 235)

    colors = Counter(data)
    top = colors.most_common(4)

    print(f'{path}:')
    print(f'  平均色 RGB {avg}  亮度 {round(sum(avg) / 3, 1)}')
    print(f'  青色 {cyan}%  琥珀 {amber}%  红色 {red}%  白色 {white}%')
    print(f'  最多颜色: ' + ', '.join(f'{c}x{k}' for c, k in top))
    return avg


if __name__ == '__main__':
    for p in sys.argv[1:]:
        stats(p)
