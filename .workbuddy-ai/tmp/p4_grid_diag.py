"""诊断：三种"网格判据"在三个区域候选斑块上的分离度。

候选斑块来源：detect_grass 颜色+开运算（grid off）。
对每个斑块算四组量：
  n_in      斑块内部（不外扩）树心数
  nn_med    内部+外扩2m 树心的最近邻距中位（米）
  d_center  斑块质心到全图最近树心的距离（米）
  frac_m    外扩8.45m 邻域内"落在株距环带"的树心比例（当前实现）
"""
import sys

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import label as ndi_label, find_objects
from scipy.spatial import cKDTree

sys.path.insert(0, "scripts")
from landcover import detect_grass, LandcoverParams, _features
from grid_prior import detect_tree_centers, _nn_stats

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX = 0.03299
PITCH = 8.45
LO, HI = 0.7 * PITCH, 1.4 * PITCH
ZONES = [
    (40000, 30000, "南部草地"),
    (37900, 25600, "受光面区"),
    (22343, 23565, "密林"),
]

ds = rasterio.open(IMG)
p_off = LandcoverParams(grass_grid=False)

for row, col, tag in ZONES:
    size = 1024
    r0 = max(0, row - size // 2)
    c0 = max(0, col - size // 2)
    d = ds.read(window=Window(c0, r0, size, size), out_dtype="uint8")
    rgb = np.transpose(d[:3], (1, 2, 0))
    valid = ~np.all(d[:3] == 0, axis=0)

    # 低分辨率候选（与 detect_grass 内部一致的 1/4 尺度）
    ds_f = 4
    small = rgb[::ds_f, ::ds_f]
    small_valid = valid[::ds_f, ::ds_f]
    px_s = PX * ds_f
    mask = detect_grass(rgb, valid, PX, p_off)
    # detect_grass 返回的是原尺寸；降到 1/4 与树心同尺度
    cand = mask[::ds_f, ::ds_f]

    pts = detect_tree_centers(small, small_valid, px_s)     # (N,2) px
    pts_m = pts * px_s
    print(f"\n===== [{tag}] 候选面积 {mask.sum()*PX*PX:.1f} m²，"
          f"低分候选 {(cand.sum()*px_s*px_s):.1f} m²，树心 {len(pts)} 个 =====")
    if not cand.any():
        continue

    lab, n = ndi_label(cand)
    objs = find_objects(lab)
    tree_all = cKDTree(pts_m) if len(pts) else None

    rows = []
    for i in range(1, n + 1):
        sl = objs[i - 1]
        if sl is None:
            continue
        y0, y1 = sl[0].start, sl[0].stop
        x0, x1 = sl[1].start, sl[1].stop
        inb = lab[sl] == i
        area = inb.sum() * px_s * px_s
        if area < 0.5:
            continue
        # 质心（低分坐标）
        ys, xs = np.nonzero(inb)
        cx, cy = xs.mean() + x0, ys.mean() + y0

        # 内部树心（斑块 bbox 内）
        sel_in = ((pts[:, 0] >= x0) & (pts[:, 0] < x1) &
                  (pts[:, 1] >= y0) & (pts[:, 1] < y1))
        sub_in = pts_m[sel_in]
        n_in = len(sub_in)
        nn_med = float("nan")
        if n_in >= 3:
            dd, _ = cKDTree(sub_in).query(sub_in, k=2)
            nn_med = float(np.median(dd[:, 1]))
        # 质心到最近树心
        d_center = float("inf")
        if tree_all is not None:
            dd, _ = tree_all.query([[cx * px_s, cy * px_s]])
            d_center = float(dd[0])
        # 外扩邻域 frac
        m = 8.45 / px_s
        y0e = max(0, y0 - m); x0e = max(0, x0 - m)
        y1e = min(cand.shape[0], y1 + m)
        x1e = min(cand.shape[1], x1 + m)
        sel_e = ((pts[:, 0] >= x0e) & (pts[:, 0] < x1e) &
                 (pts[:, 1] >= y0e) & (pts[:, 1] < y1e))
        sub_e = pts_m[sel_e]
        frac_m = float("nan")
        if len(sub_e) >= 5:
            dd, _ = cKDTree(sub_e).query(sub_e, k=2)
            frac_m = float(((dd[:, 1] >= LO) & (dd[:, 1] <= HI)).mean())
        rows.append((area, n_in, nn_med, d_center, frac_m))

    rows.sort(key=lambda t: -t[0])
    print(f"  斑块数 {len(rows)}（按面积降序，前 12）：")
    print(f"  {'面积m²':>8} {'内部树心':>8} {'内部nn中位m':>12} {'质心距树心m':>12} {'邻域frac':>9}")
    for area, n_in, nn_med, dc, fm in rows[:12]:
        print(f"  {area:8.1f} {n_in:8d} {nn_med:12.2f} {dc:12.2f} {fm:9.2f}")
    arr = np.array([(r[1], r[2], r[3], r[4]) for r in rows],
                   dtype=float)
    print(f"  中位汇总: 内部树心 {np.median(arr[:,0]):.1f} | "
          f"内部nn中位 {np.nanmedian(arr[:,1]):.2f} | "
          f"质心距树心 {np.nanmedian(arr[:,2]):.2f} | "
          f"邻域frac {np.nanmedian(arr[:,3]):.2f}")
ds.close()
