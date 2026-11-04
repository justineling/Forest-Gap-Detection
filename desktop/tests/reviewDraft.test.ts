/**
 * 复核草稿（`lib/reviewDraft.ts`）+ store 自动恢复的回归测试。
 *
 * 要证明的只有一件事：**关窗前做的复核修改，重新打开同一份结果时一条不差地回来**，
 * 并且不会被贴到另一份结果上。
 *
 * Node 里没有 localStorage —— 用一个内存实现顶上（`globalThis.localStorage`），
 * 让 store 走与浏览器完全相同的代码路径。
 *
 * 跑法：npm test（见 package.json）
 */
import {
  DRAFT_KEEP,
  DRAFT_PREFIX,
  applyDraft,
  baselineSig,
  baselineSwitchAction,
  buildDraft,
  loadDraft,
  maxManualSeq,
  persistDraft,
  saveDraft,
} from '../src/lib/reviewDraft'
import { RESTORE_LABEL, useAppStore } from '../src/store/useAppStore'
import type { GapClass, GapFeature, PolygonGeometry } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

class MemStorage {
  private m = new Map<string, string>()
  failWrites = false
  get length(): number {
    return this.m.size
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
}

function sq(lon: number, lat: number, d = 0.0003): PolygonGeometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + d, lat],
        [lon + d, lat + d],
        [lon, lat + d],
        [lon, lat],
      ],
    ],
  }
}
function feat(id: string, cls: GapClass, i: number): GapFeature {
  return {
    type: 'Feature',
    geometry: sq(111.2 + i * 0.001, 1.18),
    properties: { gap_id: id, class: cls, area_sqm: 1000 + i, source: 'algo' },
  }
}
const BASE: GapFeature[] = [
  feat('B1', 'open_patch', 0),
  feat('B2', 'uncertain', 1),
  feat('B3', 'vacant_slot', 2),
  feat('B4', 'road', 3),
]
const counters0 = { manualAdded: 0, manualDeleted: 0, manualEdited: 0 }

// ---------- A. 签名 ----------
console.log('A. 基线签名')
{
  const s = baselineSig(BASE)
  check(s === baselineSig(BASE.slice()), '同一份结果 → 同一签名（与数组身份无关）', s)
  check(s !== baselineSig(BASE.slice(0, 3)), '少一块 → 签名不同')
  const renamed = BASE.map((f, i) => (i === 0 ? { ...f, properties: { ...f.properties, gap_id: 'X1' } } : f))
  check(s !== baselineSig(renamed), '★ gap_id 重编（重跑检测）→ 签名不同，旧草稿不会被贴上去')
  check(baselineSig([]) === '', '空结果 → 空签名（不存草稿）')
}

// ---------- B. 生成 / 应用 ----------
console.log('\nB. 草稿只存差异，且能原样贴回')
{
  const sig = baselineSig(BASE)
  check(buildDraft(sig, BASE, BASE.slice(), counters0) === null, '没改过 → 没有草稿')

  const reclass: GapFeature = { ...BASE[1], properties: { ...BASE[1].properties, class: 'open_patch', edited: true } }
  const reshaped: GapFeature = { ...BASE[2], geometry: sq(111.2021, 1.1801), properties: { ...BASE[2].properties, edited: true } }
  const manual: GapFeature = {
    type: 'Feature',
    geometry: sq(111.21, 1.18),
    properties: { gap_id: 'M0007', class: 'manual_add', area_sqm: 500, source: 'manual', edited: true },
  }
  // 删 B4、B2 改判、B3 改边界、补画 M0007
  const current = [manual, BASE[0], reclass, reshaped]
  const counters = { manualAdded: 1, manualDeleted: 1, manualEdited: 2 }
  const d = buildDraft(sig, BASE, current, counters, 1_700_000_000_000)!
  check(!!d, '有修改 → 生成草稿')
  check(JSON.stringify(d.deletedIds) === '["B4"]', '删除：只记 id', JSON.stringify(d.deletedIds))
  check(d.edited.length === 2, '改判 + 改边界 = 2 条', d.edited.map((e) => e.id).join(','))
  check(d.edited.find((e) => e.id === 'B2')?.geometry === undefined, '★ 只改判 → 不存几何（省配额）')
  check(!!d.edited.find((e) => e.id === 'B3')?.geometry, '改过边界 → 存几何')
  check(d.manual.length === 1 && d.manual[0].properties.gap_id === 'M0007', '补画：整块存')
  check(maxManualSeq(d) === 7, '补画序号上限 = 7（恢复后新补画从 M0008 起，不撞号）')

  // JSON 来回一趟（模拟真的写进 localStorage 再读出来）
  const back = applyDraft(BASE, JSON.parse(JSON.stringify(d)))
  const ids = back.features.map((f) => f.properties.gap_id).join(',')
  check(ids === 'M0007,B1,B2,B3', '★ 贴回后要素集合与关窗前一致', ids)
  check(back.features.find((f) => f.properties.gap_id === 'B2')?.properties.class === 'open_patch', '改判贴回')
  check(
    JSON.stringify(back.features.find((f) => f.properties.gap_id === 'B3')?.geometry) === JSON.stringify(reshaped.geometry),
    '改边界贴回',
  )
  check(
    back.deleted.length === 1 && back.deleted[0] === BASE[3],
    '★ 被删的块带着几何回来（重跑时 mergeEdits 要靠它重放删除）',
  )
  check(back.stats.missing === 0, '签名一致时没有对不上的条目')
}

// ---------- C. 存取 ----------
console.log('\nC. 存取与淘汰')
{
  const ls = new MemStorage()
  for (let i = 0; i < DRAFT_KEEP + 2; i++) {
    const sig = `s${i}`
    saveDraft(
      { v: 1, sig, savedAt: 1000 + i, deletedIds: ['x'], edited: [], manual: [], counters: counters0 },
      ls,
    )
  }
  const left = [...Array(ls.length).keys()].map((i) => ls.key(i)!).filter((k) => k.startsWith(DRAFT_PREFIX))
  check(left.length === DRAFT_KEEP, `最多保留 ${DRAFT_KEEP} 份`, String(left.length))
  check(!left.includes(DRAFT_PREFIX + 's0') && left.includes(DRAFT_PREFIX + 's6'), '淘汰最旧的，留最新的')
  check(loadDraft('s6', ls)?.sig === 's6', '按签名读回')
  ls.setItem(DRAFT_PREFIX + 'bad', '{not json')
  check(loadDraft('bad', ls) === null, '坏条目 → 当没有（不抛错）')
  ls.failWrites = true
  check(
    saveDraft({ v: 1, sig: 'q', savedAt: 1, deletedIds: [], edited: [], manual: [], counters: counters0 }, ls) === false,
    '配额满 → 返回 false（由调用方提示一次）',
  )
}

// ---------- D. store：载入同一份结果时自动恢复，且可一步撤销 ----------
console.log('\nD. store 自动恢复')
{
  const ls = new MemStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
  const S = useAppStore

  // 第一次会话：载入 → 删一块 + 改判一块 + 补画一块
  S.getState().setGaps(BASE.slice(), null)
  const sig = S.getState().baseSig
  S.getState().deleteGap('B4')
  S.getState().setGapClass('B2', 'open_patch')
  S.getState().addGap(sq(111.215, 1.18))
  const st1 = S.getState()
  const d = buildDraft(st1.baseSig, st1.baseGaps, st1.gaps, {
    manualAdded: st1.manualAdded,
    manualDeleted: st1.manualDeleted,
    manualEdited: st1.manualEdited,
  })!
  saveDraft(d, ls) // App 里由 800 ms 防抖的订阅完成，这里直接写
  const before = st1.gaps.map((f) => `${f.properties.gap_id}:${f.properties.class}`).sort().join('|')

  // "关窗"：内存清空
  S.getState().setGaps([], null)
  check(S.getState().gaps.length === 0, '前提：内存里的修改已经没了')

  // 第二次会话：读回**同一份**结果
  S.getState().setGaps(BASE.slice(), null)
  const st2 = S.getState()
  const after = st2.gaps.map((f) => `${f.properties.gap_id}:${f.properties.class}`).sort().join('|')
  check(st2.baseSig === sig, '同一份结果 → 同一签名')
  check(after === before, '★ 删除 / 改判 / 补画全部回来', after)
  check(st2.manualAdded === 1 && st2.manualDeleted === 1 && st2.manualEdited === 1, '留痕计数一并恢复（导出报告里的「人工修改」不归零）')
  check(st2.deletedFeatures.length === 1 && st2.deletedFeatures[0].properties.gap_id === 'B4', '删除记录带几何恢复')
  check(st2.draftRestored?.deleted === 1 && st2.draftRestored.manual === 1, '恢复统计挂到 store（清单顶部说明条用）')
  check(st2.past.length === 1 && st2.past[0].label === RESTORE_LABEL, '恢复是一步可撤销的操作')
  check(st2.logs[st2.logs.length - 1].includes('已恢复上次的复核修改'), '日志写明恢复了什么')
  // 草稿在导出后照样保留，恢复的可能正是交付过的修改 —— 文案不能断言「未导出」
  check(!st2.logs[st2.logs.length - 1].includes('未导出') && !RESTORE_LABEL.includes('未导出'), '★ 恢复文案不再声称「未导出」')
  check(st2.editRev !== 0, '恢复后版本号 ≠ 0（还没导出过这些修改）')

  // 恢复后再补画：序号不能撞上恢复回来的那块
  const restoredManual = st2.gaps.find((f) => f.properties.source === 'manual')!.properties.gap_id
  const nid = S.getState().addGap(sq(111.22, 1.18))
  check(nid !== restoredManual, '★ 恢复后新补画的编号不撞号', `${restoredManual} vs ${nid}`)
  S.getState().undo()

  S.getState().undo()
  const st3 = S.getState()
  check(st3.draftRestored === null, '★ 撤销恢复后说明条消失（不再声称"已恢复"）')
  S.getState().redo()
  check(S.getState().draftRestored?.deleted === 1, '重做恢复 → 说明条跟着回来')
  S.getState().dismissDraftNotice()
  S.getState().deleteGap('B1')
  S.getState().undo()
  check(S.getState().draftRestored === null, '★ 点过「知道了」后再撤销别的操作，说明条不会从快照里冒出来')
  S.getState().undo()
  check(
    st3.gaps.length === BASE.length && st3.gaps.every((f, i) => f === BASE[i]),
    '★ Ctrl+Z 一下 = 回到纯算法结果',
  )
  check(buildDraft(st3.baseSig, st3.baseGaps, st3.gaps, counters0) === null, '撤销恢复后草稿为空（订阅随后会删掉它）')

  // 撤销「重跑合并」：基线必须跟着回到重跑前，否则草稿拿旧数据比新基线，膨胀成"每块都改过"
  S.getState().setGaps(BASE.slice(), null)
  S.getState().undo() // 撤销恢复 → 纯基线
  S.getState().setGapClass('B1', 'uncertain')
  const sigA = S.getState().baseSig
  const preRerun = buildDraft(sigA, S.getState().baseGaps, S.getState().gaps, counters0)!
  const rerunFeats = BASE.map((f) => ({ ...f, properties: { ...f.properties, gap_id: 'R' + f.properties.gap_id } }))
  S.getState().applyRerun(rerunFeats, 'keep_manual')
  check(S.getState().baseSig === baselineSig(rerunFeats), '重跑合并 → 基线换成新结果')
  S.getState().undo()
  const su = S.getState()
  check(su.baseSig === sigA && su.baseGaps.length === BASE.length, '★ 撤销重跑合并 → 基线回到重跑前')
  const afterUndo = buildDraft(su.baseSig, su.baseGaps, su.gaps, counters0)!
  check(
    afterUndo.edited.length === preRerun.edited.length && afterUndo.deletedIds.length === preRerun.deletedIds.length,
    '★ 撤销重跑后草稿与重跑前一致（不会膨胀成"每块都改过"）',
    `edited ${afterUndo.edited.length} vs ${preRerun.edited.length}`,
  )
  S.getState().redo()
  check(S.getState().baseSig === baselineSig(rerunFeats), '重做重跑合并 → 基线再换回新结果')

  // persistDraft：有修改写、无修改删、无基线跳过、写不进去报 failed
  const mem = new MemStorage()
  const src = { baseSig: sigA, baseGaps: BASE, gaps: BASE.slice(1), ...counters0 }
  check(persistDraft(src, mem) === 'saved' && !!loadDraft(sigA, mem), 'persistDraft：有修改 → saved')
  check(persistDraft({ ...src, gaps: BASE.slice() }, mem) === 'removed' && !loadDraft(sigA, mem), 'persistDraft：改回原样 → 删掉旧草稿')
  check(persistDraft({ ...src, baseSig: '' }, mem) === 'skipped', 'persistDraft：没有基线 → 跳过')
  mem.failWrites = true
  check(persistDraft(src, mem) === 'failed', 'persistDraft：写不进去 → failed（由界面提示一次）')

  // 另一份结果（gap_id 重编）不能贴这份草稿
  const other = BASE.map((f) => ({ ...f, properties: { ...f.properties, gap_id: 'N' + f.properties.gap_id } }))
  S.getState().setGaps(other, null)
  check(S.getState().draftRestored === null && S.getState().past.length === 0, '★ 重跑后的新结果不会被贴上旧草稿')

  S.getState().setGaps([], null)
  delete (globalThis as { localStorage?: unknown }).localStorage
}

// ---------- E. 第三轮复审抓到的四条（2026-11-03） ----------
console.log('\nE. 基线自带人工块 · 二次重跑 · 撤销重跑 · 撤销后再拖')
{
  const ls = new MemStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
  const S = useAppStore

  // 1) 基线自己带人工块（重新打开导出的交付包）：没改东西就不该有草稿；旧草稿也不能贴出重复块
  const mBase: GapFeature = {
    type: 'Feature',
    geometry: sq(111.23, 1.18),
    properties: { gap_id: 'M0005', class: 'manual_add', area_sqm: 900, source: 'manual' },
  }
  const withManual = [mBase, ...BASE]
  const sigM = baselineSig(withManual)
  check(buildDraft(sigM, withManual, withManual.slice(), counters0) === null, '★ 基线里的人工块没动 → 不存草稿')
  const legacy = { v: 1 as const, sig: sigM, savedAt: 1, deletedIds: [], edited: [], manual: [mBase], counters: counters0 }
  const ids = applyDraft(withManual, legacy).features.map((f) => f.properties.gap_id)
  check(ids.length === withManual.length && new Set(ids).size === ids.length, '★ 旧版本存的草稿贴回也不出重复块', ids.join(','))
  S.getState().setGaps(withManual, null)
  const nid = S.getState().addGap(sq(111.24, 1.18))
  check(Number(nid.slice(1)) > 5, '★ 基线带 M0005 → 新补画续号不撞', nid)

  // 2) 同一会话连续两次重跑：第一次之前删掉的误报不能复活
  const A = BASE.map((f) => ({ ...f, properties: { ...f.properties, gap_id: 'A' + f.properties.gap_id } }))
  const B1 = BASE.map((f) => ({ ...f, properties: { ...f.properties, gap_id: 'X' + f.properties.gap_id } }))
  const B2 = BASE.map((f) => ({ ...f, properties: { ...f.properties, gap_id: 'Y' + f.properties.gap_id } }))
  S.getState().setGaps(A, null)
  S.getState().deleteGap('AB4')
  S.getState().applyRerun(B1, 'keep_manual')
  check(!S.getState().gaps.some((f) => f.properties.gap_id === 'XB4'), '第一次重跑：删除被重放')
  check(S.getState().deletedFeatures.some((f) => f.properties.gap_id === 'XB4'), '★ 删除记录换成新基线里被丢掉的那块（不是清空）')
  S.getState().applyRerun(B2, 'keep_manual')
  check(!S.getState().gaps.some((f) => f.properties.gap_id === 'YB4'), '★ 第二次重跑：那块误报仍然是删掉的（以前会复活）')

  // 3) 撤销重跑合并 → 标记"基线是撤销换的"，自动保存据此删掉被离开基线的草稿
  const beforeUndo = S.getState().baseSig
  S.getState().undo()
  const su = S.getState()
  check(su.baseSwitchedByHistory && su.baseSig !== beforeUndo, '撤销重跑合并 → baseSwitchedByHistory = true')
  check(su.logs[su.logs.length - 1].includes('磁盘上的结果文件已经是新一轮的'), '★ 撤销重跑合并时提示"撤回来的这份只在本次会话有效"')
  check(baselineSwitchAction(su, { baseSig: beforeUndo }) === 'remove-prev', '★ 撤销换的基线 → 删掉被离开基线的草稿')
  S.getState().setGaps(BASE.slice(), null)
  check(baselineSwitchAction(S.getState(), { baseSig: su.baseSig }) === 'flush-prev', '载入 / 换区块换的基线 → 按旧基线立刻落盘')
  check(baselineSwitchAction(S.getState(), S.getState()) === 'none', '基线没变 → 不处理')

  // 4) 撤销一次拖拽后马上再拖同一块：新拖拽必须单独进撤销栈，且清掉重做分支
  S.getState().setGaps(BASE.slice(), null)
  if (S.getState().past.length) S.getState().undo() // 有草稿时先撤掉恢复，回到纯基线
  S.getState().setGapClass('B2', 'open_patch')
  S.getState().updateGapGeometry('B1', sq(111.2001, 1.18))
  S.getState().undo()
  S.getState().updateGapGeometry('B1', sq(111.2002, 1.18))
  const s4 = S.getState()
  check(s4.past[s4.past.length - 1]?.label === '修改 B1 的边界' && s4.future.length === 0, '★ 撤销后马上再拖同一块：单独一步，重做分支清空')
  S.getState().undo()
  check(S.getState().gaps.find((f) => f.properties.gap_id === 'B2')?.properties.class === 'open_patch', '★ 再撤销只撤这次拖拽，不连带撤掉无关的改判')

  S.getState().setGaps([], null)
  delete (globalThis as { localStorage?: unknown }).localStorage
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
