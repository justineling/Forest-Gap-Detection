/**
 * CHM 阈值预设与互锁的单元测试（Node 直跑）。
 *
 * 重点：
 * 1. 三档预设的数值必须与台账一致（成熟 5.2/1.2、中龄 3.5/0.8、幼龄 2.2/0.5）
 * 2. **互锁必须拦住 veto ≥ core** —— 否则区间逻辑反转且静默不可预期
 * 3. 夹取策略是"改动的那条为准，另一条让步"（滑块手感）
 */
import {
  CHM_PRESETS,
  CHM_DEFAULT,
  CHM_MIN_VETO,
  CHM_MIN_GAP,
  chmError,
  clampChm,
  matchPreset,
  isDefaultChm,
  presetByKey,
} from '../src/lib/chm'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

// ---------- A. 预设数值 ----------
console.log('\nA. 三档预设的数值必须与缺陷台账一致')
{
  const m = presetByKey('mature')!
  const d = presetByKey('mid')!
  const y = presetByKey('young')!
  check(m.core === 5.2 && m.veto === 1.2, '成熟林 = 5.2 / 1.2（Stage 14 基线）', `${m.core}/${m.veto}`)
  check(d.core === 3.5 && d.veto === 0.8, '中龄林 = 3.5 / 0.8', `${d.core}/${d.veto}`)
  check(y.core === 2.2 && y.veto === 0.5, '幼龄林 = 2.2 / 0.5', `${y.core}/${y.veto}`)
  check(CHM_PRESETS.length === 3, '只有三档（不多不少）', String(CHM_PRESETS.length))
  check(CHM_DEFAULT.core === 5.2 && CHM_DEFAULT.veto === 1.2, '默认 = 成熟林')
  check(y.hint.includes('复核清单'), '幼龄林带"配合复核清单"的提示')
  for (const p of CHM_PRESETS) {
    check(chmError(p.core, p.veto) === null, `${p.label} 自身满足互锁`)
  }
}

// ---------- B. 互锁校验 ----------
console.log('\nB. 互锁：0.2 ≤ veto ≤ core − 0.5')
{
  check(chmError(5.2, 1.2) === null, '5.2 / 1.2 合法')
  check(chmError(3.0, 3.0 - CHM_MIN_GAP) === null, '间距恰好等于下限，合法（边界）')

  const e1 = chmError(3.0, 4.0)
  check(e1 !== null && e1.includes('否决线必须比救援线低'), '★ veto > core 被拦住', String(e1))

  const e2 = chmError(3.0, 2.6)
  check(e2 !== null && e2.includes('至少 0.5'), '★ 间距不足 0.5 被拦住', String(e2))

  const e3 = chmError(3.0, 0.1)
  check(e3 !== null && e3.includes('不能低于 0.2'), 'veto < 0.2 被拦住', String(e3))

  const e4 = chmError(20, 1.0)
  check(e4 !== null && e4.includes('不能高于'), 'core 超上限被拦住', String(e4))

  check(chmError(0.3, 0.2) !== null, 'core 低于下限被拦住')
  check(chmError(Number.NaN, 1.0) !== null, 'NaN 被拦住')
}

// ---------- C. 夹取策略 ----------
console.log('\nC. 夹取：改动的那条为准，另一条让步')
{
  // 把救援线拉低到 1.0，否决线 1.2 必须跟着降到 0.5
  const a = clampChm(1.0, 1.2, 'core')
  check(a.core === 1.0, '改 core 时 core 不被弹回', `${a.core}`)
  check(a.veto === 0.5, '★ veto 让步到 core−0.5 = 0.5', `${a.veto}`)
  check(chmError(a.core, a.veto) === null, '夹取后一定合法')

  // 把否决线拉高到 4.0，救援线必须抬到 4.5
  const b = clampChm(3.0, 4.0, 'veto')
  check(b.veto === 4.0, '改 veto 时 veto 不被弹回', `${b.veto}`)
  check(b.core === 4.5, '★ core 让步到 veto+0.5 = 4.5', `${b.core}`)
  check(chmError(b.core, b.veto) === null, '夹取后一定合法')

  // 下限夹取
  const c = clampChm(5.2, 0.05, 'veto')
  check(c.veto === CHM_MIN_VETO, 'veto 被抬到下限 0.2', `${c.veto}`)
  check(chmError(c.core, c.veto) === null, '夹取后一定合法')

  // 上限夹取
  const d = clampChm(99, 1.2, 'core')
  check(d.core <= 15, 'core 被压到上限 15', `${d.core}`)
  check(chmError(d.core, d.veto) === null, '夹取后一定合法')

  // 步长 0.1（不能出现 3.0499999 这种）
  const e = clampChm(3.0499999, 1.2, 'core')
  check(e.core === 3.0, '四舍五入到 0.1 步长', `${e.core}`)
}

// ---------- D. 反查与默认判断 ----------
console.log('\nD. 反查档位与"是否默认"')
{
  check(matchPreset(5.2, 1.2) === 'mature', '5.2/1.2 → 成熟林')
  check(matchPreset(3.5, 0.8) === 'mid', '3.5/0.8 → 中龄林')
  check(matchPreset(2.2, 0.5) === 'young', '2.2/0.5 → 幼龄林')
  check(matchPreset(4.0, 1.0) === 'custom', '4.0/1.0 → 自定义')
  check(matchPreset(5.21, 1.19) === 'mature', '浮点误差 0.01 仍判为成熟林')

  check(isDefaultChm(5.2, 1.2) === true, '5.2/1.2 是默认')
  check(isDefaultChm(3.5, 0.8) === false, '3.5/0.8 非默认（报告要高亮）')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
