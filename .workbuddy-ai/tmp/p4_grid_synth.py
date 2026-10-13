"""方案 B 合成验证：网格回检必须「该剔的剔、该留的留」。

场景（px_m=0.1 便于用小图表达米制尺度）：
  A. 规则三角形种植林（8.45 m 格）—— 中间 4×3 格的树冠整体换成
     「受光面亮绿」（高 ExG + 高饱和 + 连片），模拟油棕受光面/幼林连片区
     期望：颜色+开运算能检出候选；网格回检必须剔除（树心规则）
  B. 同一片林下方的「草荒区」—— 土壤底上铺不规则亮绿纹理（无树心格）
     期望：网格回检必须保留（无种植周期）
"""
import sys

import numpy as np

sys.path.insert(0, "scripts")
from landcover import detect_grass, LandcoverParams
from grid_prior import detect_tree_centers, _nn_stats

PX = 0.1                      # 10 cm/px
SIZE = 2000                   # 200 m 见方
PITCH = 8.45
ROW = PITCH * np.sin(np.radians(60))     # 7.32 m 行距

rng = np.random.default_rng(20261014)
yy, xx = np.mgrid[0:SIZE, 0:SIZE]

# 基底：裸露土壤（棕）
img = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
img[..., 0], img[..., 1], img[..., 2] = 150, 125, 95
valid = np.ones((SIZE, SIZE), dtype=bool)

# --- 规则三角形林：每株一个暗绿高斯斑（冠幅 3.5 m）---
crown_r = 3.5 / PX
n_row = int(SIZE * PX / ROW) + 2
n_col = int(SIZE * PX / PITCH) + 2
centers = []
for iy in range(n_row):
    for ix in range(n_col):
        mx = (ix * PITCH + iy * PITCH / 2) / PX
        my = (iy * ROW) / PX
        if 0 <= mx < SIZE and 0 <= my < SIZE:
            centers.append((mx, my))
            m = (xx - mx) ** 2 + (yy - my) ** 2 <= crown_r ** 2
            img[m] = (70, 130, 55)          # 油棕暗绿
            # 中心留一个更亮的「树心」
            core = (xx - mx) ** 2 + (yy - my) ** 2 <= (0.8 / PX) ** 2
            img[core] = (95, 155, 65)
img += rng.normal(0, 4, img.shape)
img = np.clip(img, 0, 255).astype(np.uint8)

# --- A：受光面连片区：中间 4×3 格的树冠换亮绿 ---
i0, j0 = SIZE // 2 - 160, SIZE // 2 - 120
img[i0:i0 + 320, j0:j0 + 240] = (100, 180, 55)     # ExG≈205、sat≈0.69
img = np.clip(img + rng.normal(0, 4, img.shape), 0, 255).astype(np.uint8)
rgb_a = img.copy()

# --- B：草荒区：右下角铺不规则亮绿噪声纹理（无树心格）---
img_b = img.copy()
gy0, gx0 = SIZE - 700, SIZE - 500      # (行, 列) 起点，避免越界
tex = np.zeros((500, 700, 3), dtype=np.float32)
tex[..., 0], tex[..., 1], tex[..., 2] = 120, 175, 60   # 草绿
tex += rng.normal(0, 10, tex.shape)
img_b[gx0:gx0 + 500, gy0:gy0 + 700] = np.clip(tex, 0, 255).astype(np.uint8)
rgb_b = img_b

p_on = LandcoverParams()
p_off = LandcoverParams(grass_grid=False)

for tag, rgb in (("A 规则林+受光面连片区", rgb_a), ("B 草荒区(无树心格)", rgb_b)):
    off = detect_grass(rgb, valid, PX, p_off)
    on = detect_grass(rgb, valid, PX, p_on)
    pts = detect_tree_centers(rgb[::4, ::4], valid[::4, ::4], PX * 4)
    nn, med, cv = _nn_stats(pts * PX * 4) if len(pts) else (np.array([]), float("nan"), float("nan"))
    print(f"[{tag}]")
    print(f"  树心 {len(pts)} 个，nn 中位 {med:.2f} m，CV {cv:.3f}")
    print(f"  候选(网格关) {off.sum() * PX * PX:8.1f} m²  "
          f"候选(网格开) {on.sum() * PX * PX:8.1f} m²  "
          f"剔除 {off.sum() - (off & on).sum()} px"
          f"（{(off.sum() - (off & on).sum()) / max(off.sum(), 1) * 100:.1f}%）")
ds = None
