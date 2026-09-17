"""米游社极验滑块：算缺口位置。

输入：同目录下（其实是系统临时目录）由 server.mjs 落盘的三张图
      bg.png（有缺口）/ fullbg.png（无缺口）/ slice.png（滑块拼图块）
输出：把拖动距离写进 gt_gap.txt，server.mjs 读它

算法：bg 与 fullbg 做差分 → 阈值 → 取最大轮廓的左边界，减去拼图块起点。
      差分比模板匹配/边缘匹配稳（实测：模板匹配会被背景纹理带偏）。
"""
import cv2
import numpy as np
import os
import sys
import tempfile
import time

# 工作目录由调用方传入（并发时每个任务一个，避免互相覆盖中间图）。
# 不传则退回系统临时目录（单任务场景）。
TMP = sys.argv[1] if len(sys.argv) > 1 else tempfile.gettempdir()
GAPFILE = os.path.join(TMP, 'gt_gap.txt')
BG = os.path.join(TMP, 'bg.png')
FB = os.path.join(TMP, 'fullbg.png')
SL = os.path.join(TMP, 'slice.png')

# 等 server.mjs 把三张图落盘（它抓完图才会启本脚本）
if os.path.exists(GAPFILE):
    os.remove(GAPFILE)
for _ in range(40):
    if all(os.path.exists(p) for p in (BG, FB, SL)):
        break
    time.sleep(1)

bg = cv2.imread(BG)
fb = cv2.imread(FB)
sl = cv2.imread(SL, cv2.IMREAD_UNCHANGED)
if bg is None or fb is None or sl is None:
    open(GAPFILE, 'w').write('0')
    raise SystemExit('三张图没到齐')

# 拼图块的有效像素范围（去掉透明边），它的左边界就是拖动起点
alpha = sl[:, :, 3]
cols = np.where(np.any(alpha > 50, axis=0))[0]
if not len(cols):
    open(GAPFILE, 'w').write('0')
    raise SystemExit('拼图块全透明')
sx = int(cols[0])

# 差分：有缺口 vs 无缺口的差异就是缺口
diff = cv2.absdiff(bg, fb)
gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
_, th = cv2.threshold(gray, 20, 255, cv2.THRESH_BINARY)
th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

if cnts:
    x, y, w, h = cv2.boundingRect(max(cnts, key=cv2.contourArea))
    dist = max(0, int(x - sx))
    print(f'缺口 x={x} 拼图起点={sx} → 拖动距离={dist}')
    open(GAPFILE, 'w').write(str(dist))
else:
    print('未找到缺口')
    open(GAPFILE, 'w').write('0')
