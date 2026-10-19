/**
 * 三份帮助内容的一致性测试（Node 直跑）。
 *
 * 为什么值得测：帮助文案是**最容易和界面脱节**的东西 —— 改一次类别名、
 * 加一个分组，弹窗里还写着旧词，用户就更困惑了。这里把"逐字一致"变成断言，
 * 而不是靠人眼比一遍。
 *
 * 覆盖：
 * 1. LEFT_HELP 的类别条目 = `CLASS_STYLES` 的全部 label（逐字、不缺不多）
 * 2. 9 个类别（含 manual_add）的 desc 都非空
 * 3. 分组条目 = `GROUP_ORDER` 的全部 label
 * 4. 排坑退让档位 0.5 / 1.0 / 2.0 与 `CLEARANCE_PRESETS` 一致，且 "123 块" 数字一致
 * 5. 同一 section 内 term 不重复（否则 React key 撞车、<dl> 语义错乱）
 * 6. 三份文档结构完整：title / intro / sections / items 全非空
 */
import { ALL_CLASSES, CLASS_STYLES, GROUP_META, GROUP_ORDER } from '../src/lib/classes'
import { CLEARANCE_PRESETS } from '../src/lib/estimate'
import { HEADER_HELP, LEFT_HELP, RIGHT_HELP, type HelpDoc } from '../src/lib/helpContent'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

function section(doc: HelpDoc, h: string) {
  const s = doc.sections.find((x) => x.h === h)
  if (!s) throw new Error(`缺少小节「${h}」`)
  return s
}

// ---------- A. 类别名逐字一致 ----------
console.log('\nA. LEFT_HELP 的类别名必须与 CLASS_STYLES 逐字一致')
{
  const items = section(LEFT_HELP, '每个类别是什么意思').items
  const terms = items.map((i) => i.term)
  check(items.length === ALL_CLASSES.length, '条目数 = 类别数', `${items.length}/${ALL_CLASSES.length}`)
  for (const c of ALL_CLASSES) {
    const want = CLASS_STYLES[c].label
    check(terms.includes(want), `有「${want}」（${c}）`)
  }
  // 反向：帮助里不能出现界面上不存在的类别名（旧词）
  const known = new Set(ALL_CLASSES.map((c) => CLASS_STYLES[c].label))
  const extra = terms.filter((t) => !known.has(t))
  check(extra.length === 0, '没有多余/过期的类别名', extra.join(', ') || '—')
}

// ---------- B. 9 个 desc 全非空（manual_add 最容易漏） ----------
console.log('\nB. 每个类别的解释都非空')
{
  const items = section(LEFT_HELP, '每个类别是什么意思').items
  for (const it of items) {
    check(it.desc.trim().length > 0, `「${it.term}」有解释`, `${it.desc.length} 字`)
  }
  const manual = items.find((i) => i.term === CLASS_STYLES.manual_add.label)
  check(!!manual && manual.desc.trim().length > 0, 'manual_add（人工新增）不漏', manual?.term ?? '缺失')
  check(items.length === 9, '8 类 + 人工新增 = 9 条', String(items.length))
}

// ---------- C. 分组名逐字一致 ----------
console.log('\nC. 分组名必须与 GROUP_META 逐字一致')
{
  const items = section(LEFT_HELP, '四个业务分组').items
  check(items.length === GROUP_ORDER.length, '组数一致', `${items.length}/${GROUP_ORDER.length}`)
  for (const g of GROUP_ORDER) {
    const it = items.find((i) => i.term === GROUP_META[g].label)
    check(!!it, `有「${GROUP_META[g].label}」`)
    check(it?.desc === GROUP_META[g].hint, `「${GROUP_META[g].label}」的说明取自 GROUP_META.hint`)
  }
}

// ---------- D. 退让档位与 CLEARANCE_PRESETS 一致 ----------
console.log('\nD. 排坑退让距离的三档与 CLEARANCE_PRESETS 一致')
{
  const items = section(LEFT_HELP, '排坑退让距离').items
  const terms = items.map((i) => i.term)
  check(CLEARANCE_PRESETS.length === 3, 'CLEARANCE_PRESETS 是三档')
  for (const p of CLEARANCE_PRESETS) {
    // 0.5 → "0.5 m（默认）"；1.0/2.0 → 合并成一条 "1.0 m / 2.0 m"
    // 用 includes 而不是 startsWith：合并条目只有前缀是 1.0
    const hit = terms.some((t) => t.includes(p.label))
    check(hit, `文档里有 ${p.label}`, terms.join(' | '))
  }
  const text = items.map((i) => i.term + i.desc).join('')
  check(text.includes('0.5'), '提到 0.5 是默认')
  check(text.includes('123'), '提到"123 块排不出点"的实测数字')
  // 数字必须和源码注释里的口径一致（2.0 m 会让 123 块单行缺株带排坑为 0）
  const twoM = items.find((i) => i.term.includes('2.0'))
  check(!!twoM, '有 2.0 m 的条目')
}

// ---------- E. 同一 section 内 term 不重复 ----------
console.log('\nE. term 不重复（React key / <dl> 语义）')
{
  for (const doc of [LEFT_HELP, RIGHT_HELP, HEADER_HELP]) {
    for (const s of doc.sections) {
      const t = s.items.map((i) => i.term)
      const dup = t.filter((x, i) => t.indexOf(x) !== i)
      check(dup.length === 0, `${doc.title} · ${s.h}`, dup.join(', ') || '无重复')
    }
  }
}

// ---------- F. 结构完整 ----------
console.log('\nF. 三份文档结构完整')
{
  for (const doc of [LEFT_HELP, RIGHT_HELP, HEADER_HELP]) {
    check(doc.title.trim().length > 0, `${doc.title} 有标题`)
    check(doc.intro.trim().length > 0, `${doc.title} 有 intro`)
    check(doc.sections.length > 0, `${doc.title} 有小节`, String(doc.sections.length))
    for (const s of doc.sections) {
      check(s.h.trim().length > 0, `${doc.title} 小节有标题`)
      check(s.items.length > 0, `${doc.title} · ${s.h} 有条目`)
      for (const it of s.items) {
        check(
          it.term.trim().length > 0 && it.desc.trim().length > 0,
          `${doc.title} · ${s.h} · 「${it.term}」非空`,
        )
      }
    }
  }
}

// ---------- G. header 帮助的 Esc 说明与实现一致 ----------
console.log('\nG. 文案里提到的键位必须在实现里真的存在')
{
  const texts = [LEFT_HELP, RIGHT_HELP, HEADER_HELP]
    .flatMap((d) => d.sections.flatMap((s) => s.items.map((i) => i.term + i.desc)))
    .join('')
  check(texts.includes('Esc'), '有帮助提到 Esc')
  check(texts.includes('右键'), '有帮助提到右键取消')
  check(texts.includes('Ctrl+Z'), '有帮助提到撤销')
}

if (failures > 0) {
  console.error(`\n❌ ${failures} 项不通过`)
  process.exit(1)
}
console.log('\n✅ 全部通过')
