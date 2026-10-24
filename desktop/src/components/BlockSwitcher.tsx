import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri, listBlocks, type BlockInfo } from '../api/backend'
import {
  blockSubtitle,
  blockWarnings,
  canSwitchTo,
  shortJob,
  shouldShowSwitcher,
} from '../lib/blocks'

/**
 * 浏览器预览数据（`?blocks=1`）。
 *
 * 为什么需要：`list_blocks` 是 Tauri 命令，浏览器里直接返回 `[]` ——
 * 那样这个下拉在截图 / 回归里永远是一句"还没有任何区块结果"，
 * 看不到"当前 / 影像丢失 / 无高度图"这几种关键形态。
 * 与 `?more=1`（展开更多菜单）、`?roi=1` 是同一套预览开关，**不进打包逻辑**。
 */
function previewBlocks(): BlockInfo[] {
  const now = Math.floor(Date.now() / 1000)
  return [
    {
      job: 'wgr17-002',
      image: 'D:/data/drone data/WGR17-002.tif',
      image_exists: true,
      gaps: 'D:/data/output/wgr17-002-gaps.geojson',
      chm: 'D:/data/output/wgr17-002-chm.tif',
      modified: now - 180,
      size_mb: 15.2,
      current: true,
    },
    {
      job: 'wgr17-003',
      image: 'E:/园区B/WGR17-003.tif',
      image_exists: true,
      gaps: 'D:/data/output/wgr17-003-gaps.geojson',
      chm: 'D:/data/output/wgr17-003-chm.tif',
      modified: now - 86_400,
      size_mb: 14.8,
      current: false,
    },
    {
      job: 'wgr17-004',
      image: 'F:/已移走/WGR17-004.tif',
      image_exists: false,
      gaps: 'D:/data/output/wgr17-004-gaps.geojson',
      chm: null,
      modified: now - 3 * 86_400,
      size_mb: 11.3,
      current: false,
    },
  ]
}

interface Props {
  /** 当前区块名（后端 `get_status` 给的；拿不到时 null） */
  current: string | null
  /** 切到另一块（由 App 负责真正调用后端 + 载入结果） */
  onSwitch: (job: string) => void
  /** 正在切（禁用按钮，避免连点触发两次重启） */
  busy?: boolean
}

/**
 * 「区块」下拉 —— 多区块下唯一能回答"我跑过哪几块、现在在哪块"的东西。
 *
 * ## 为什么需要它（2026-10-24 审计 C 条）
 *
 * 以前 16 个命令里**没有 list**。用户检测完 block A 再检测 block B，
 * 想切回 A 只能重新走"换影像 → 在文件对话框里翻出那张 3.5 GB 的 tif"。
 * 几十块之后，"哪块跑过、哪块已交付、现在在哪块"全靠记忆 ——
 * 而"当前是哪个区块"从来没被列出来过，每次都是从影像路径现推。
 *
 * ## 为什么打开时才拉清单（而不是启动就拉）
 *
 * `list_blocks` 要扫 `output/` 并读每份结果的文件头（每份 256 KB）。
 * 二十块就是 5 MB 的读盘 —— 启动时做一次纯属拖慢冷启动，
 * 而这个清单**只在用户点开时才需要**。
 */
export default function BlockSwitcher({ current, onSwitch, busy }: Props) {
  // 浏览器模式下 `?blocks=1` 直接展开并填预览数据（截图 / 回归用）
  const preview = !isTauri() && new URLSearchParams(location.search).has('blocks')
  const [open, setOpen] = useState(preview)
  const [blocks, setBlocks] = useState<BlockInfo[]>(preview ? previewBlocks() : [])
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (preview) {
      setBlocks(previewBlocks())
      return
    }
    setLoading(true)
    try {
      setBlocks(await listBlocks())
    } finally {
      setLoading(false)
    }
  }, [preview])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) void refresh()
  }

  // 点外面 / Esc 关闭（与 MoreMenu 同一套交互，用户不需要学第二种）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 显示用的"当前区块"：后端 `get_status.job` 优先；拿不到时用清单里的
  // `current` 标记兜底（清单是磁盘真相，比一个可能为 null 的显示字段更可靠）
  const shown = current ?? blocks.find((b) => b.current)?.job ?? null

  if (!shouldShowSwitcher(blocks) && !shown) return null

  return (
    <div className="block-wrap" ref={boxRef}>
      <button
        type="button"
        className={open ? 'btn block-btn active' : 'btn block-btn'}
        onClick={toggle}
        disabled={busy}
        title={
          shown
            ? `当前区块：${shown}（点此切换到别的区块）`
            : '还没有跑过检测 —— 点此查看磁盘上已有的区块'
        }
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="block-btn-label">{shown ? shortJob(shown) : '区块'}</span>
        <span className="block-btn-caret">▾</span>
      </button>

      {open && (
        <div className="more-menu block-menu" role="menu">
          <div className="more-group">
            <div className="more-group-title">
              磁盘上的区块{blocks.length > 1 ? `（${blocks.length} 块）` : ''}
            </div>
            {loading && <div className="block-empty">正在读取…</div>}
            {!loading && blocks.length === 0 && (
              <div className="block-empty">
                还没有任何区块结果。
                <br />
                跑完一次检测后，这里会列出所有跑过的影像。
              </div>
            )}
            {!loading &&
              blocks.map((b) => {
                const warn = blockWarnings(b)
                return (
                  <button
                    key={b.gaps}
                    role="menuitem"
                    disabled={!canSwitchTo(b) || busy}
                    onClick={() => {
                      setOpen(false)
                      onSwitch(b.job)
                    }}
                    title={b.gaps}
                  >
                    <span className="more-item-label">
                      {shortJob(b.job)}
                      {b.current && <span className="block-tag">当前</span>}
                    </span>
                    <span className="more-item-desc">{blockSubtitle(b)}</span>
                    {warn.length > 0 && (
                      <span className="block-warn">⚠ {warn.join('；')}</span>
                    )}
                  </button>
                )
              })}
          </div>
          <div className="mm-note">
            切换区块只换数据，不会删任何东西；每块的结果各自独立保存。
          </div>
        </div>
      )}
    </div>
  )
}
