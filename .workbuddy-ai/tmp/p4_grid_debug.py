"""Debug：为什么 A 场景（规则林+受光面连片区）的网格回检不触发。"""
import sys

import numpy as np
from scipy.ndimage import label as ndi_label, find_objects
from scipy.spatial import cKDTree

sys.path.insert(0, "scripts")
from landcover import detect_grass, LandcoverParams
from grid_prior import detect_tree_centers

PX = 0.1
SIZE = 2000
PITCH = 8.45
ROW = PITCH * np.sin(np.radians(60))

rng = np.random.default_rng(20261014)
yy, xx = np.mgrid[0:SIZE, 0:SIZE]
img = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
img[..., 0], img[..., 1], img[..., 2] = 150, 125, 95
valid = np.ones((SIZE, SIZE), dtype=bool)
crown_r = 3.5 / PX
for iy in range(int(SIZE * PX / ROW) + 2):
    for ix in range(int(SIZE * PX / PITCH) + 2):
        mx = (ix * PITCH + iy * PITCH / 2) / PX
        my = (iy * ROW) / PX
        if 0 <= mx < SIZE and 0 <= my < SIZE:
            m = (xx - mx) ** 2 + (yy - my) ** 2 <= crown_r ** 2
            img[m] = (70, 130, 55)
            core = (xx - mx) ** 2 + (yy - my) ** 2 <= (0.8 / PX) ** 2
            img[core] = (95, 155, 65)
img = np.clip(img + rng.normal(0, 4, img.shape), 0, 255).astype(np.uint8)

i0, j0 = SIZE // 2 - 160, SIZE // 2 - 120
img[i0:i0 + 320, j0:j0 + 240] = (100, 180, 55)
rgb = np.clip(img + rng.normal(0, 4, img.shape), 0, 255).astype(np.uint8)

# ---- 手动复现 detect_grass 到 opened，再走一遍 filter 逻辑 ----
from landcover import _features
from scipy.ndimage import gaussian_filter, distance_transform_edt

ds_f = 4
small = rgb[::ds_f, ::ds_f]
small_valid = valid[::ds_f, ::ds_f]
px_s = PX * ds_f
lum, sat, exg = _features(small)
sigma = max(1.0, 1.0 / px_s)
exg_s = gaussian_filter(exg.astype(np.float32), sigma=sigma)
sat_s = gaussian_filter(sat.astype(np.float32), sigma=sigma)
raw = small_valid & (exg_s > 130.0) & (sat_s > 0.60)
r = max(1, int(round(2.0 / px_s)))
dist_in = distance_transform_edt(raw)
eroded = dist_in > r
dist_out = distance_transform_edt(~eroded)
opened = (dist_out <= r) & raw
print(f"small {small.shape}  raw {raw.sum()} px  opened {opened.sum()} px "
      f"= {opened.sum()*px_s*px_s:.1f} m²")

p = LandcoverParams()
pts = detect_tree_centers(small, small_valid, px_s)
print(f"树心 {len(pts)} 个")
pts_m = pts * px_s
lab, n = ndi_label(opened)
objs = find_objects(lab)
print(f"连通域 {n} 个")
for i in range(1, n + 1):
    sl = objs[i - 1]
    if sl is None:
        continue
    y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
    area = (lab[sl] == i).sum() * px_s * px_s
    margin = p.grass_grid_margin_m / px_s
    y0e, x0e = max(0, y0 - margin), max(0, x0 - margin)
    y1e = min(opened.shape[0], y1 + margin)
    x1e = min(opened.shape[1], x1 + margin)
    sel = ((pts[:, 0] >= x0e) & (pts[:, 0] < x1e) &
           (pts[:, 1] >= y0e) & (pts[:, 1] < y1e))
    sub = pts_m[sel]
    print(f"  域{i}: 面积 {area:.1f} m²  bbox=({x0},{y0})-({x1},{y1}) "
          f"外扩margin {margin:.1f}px → ({x0e},{y0e})-({x1e},{y1e})")
    print(f"        邻域树心 {len(sub)} 个（需 ≥{p.grass_grid_min_pts}）")
    if len(sub) >= 2:
        d, _ = cKDTree(sub).query(sub, k=2)
        sub_nn = d[:, 1]
        lo, hi = 0.7 * p.grass_grid_pitch_m, 1.4 * p.grass_grid_pitch_m
        frac = float(((sub_nn >= lo) & (sub_nn <= hi)).mean())
        med = float(np.median(sub_nn))
        print(f"        nn 中位 {med:.2f} m  环带内比例 {frac:.2f}  "
              f"环带 [{lo:.1f},{hi:.1f}]  双闸门: "
              f"{frac >= p.grass_grid_frac and lo <= med <= hi}")
