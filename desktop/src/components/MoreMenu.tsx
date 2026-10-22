import { useEffect, useRef, useState } from 'react'

interface Props {
  gapCount: number
  hasImage: boolean
  onChangeData: () => void
  onReloadGaps: () => void
  onOpenSettings: () => void
  /** 生成高度图 / 林地边界（换园区必做） */
  onBuildDerived: () => void
  onAddGap: () => void
  onBoxSelect: () => void
  onEstimate: () => void
  onOpenLog: () => void
}

/**
 * 菜单项的数据结构。
 *
 * 为什么不是"每一项直接写一段 JSX"：分成三组之后，每组都是
 * 「小标题 + 若干项」，用数据描述才能保证每一组的渲染长得一样
 * （间距、说明文字的灰度、禁用态），不会写着写着就走形。
 */
interface MenuItem {
  /** 主文案：一句话说清"点了会发生什么" */
  label: string
  /** 一行灰色说明：给非技术用户的补充，解释"什么时候该用" */
  desc: string
  /** 点击后的动作 */
  onSelect: () => void
  /** 前置条件不满足时置灰（例如没有影像就不能重新载入结果） */
  disabled?: boolean
}

/**
 * 「⋯ 更多」菜单 —— 低频操作的收容所。
 *
 * 判定标准：**一件事多久做一次？**
 *   · 每次交付都做 → 留在主流程（选影像 / 检测 / 复核 / 导出）
 *   · 换园区、调参数、补画一块 → 一周几次 → 收进这里
 *   · 看快捷键、看日志 → 几乎不做 → 收进这里
 *
 * 这样 header 上不会再有"⚙"这种只有老用户才知道是干嘛的图标。
 * 注意：菜单里**不重复**主流程已有的动作（开始检测、导出），
 * 否则又变成"两个地方都能点、行为还可能不一样"。
 *
 * ## 为什么分三组并给每一项加一行说明
 *
 * 原来是一个 8 项的平铺列表，每项只有半句话（"检测参数""手动补画"），
 * 只有做过这个项目的人看得懂。第一次用的用户面对的是 8 个陌生名词，
 * 只能一个个点进去试 —— 试错成本比多读一行字高得多。
 *
 * 所以按**用户的心智**分组（我是在换数据？还是在调工具？还是在排障？），
 * 每项下面补一句"这东西什么时候用"。分组标题也顺带解决了一个问题：
 * 8 项平铺时，用户会以为它们是一个层级的并列选项，实际上不是。
 */
export default function MoreMenu({
  gapCount,
  hasImage,
  onChangeData,
  onReloadGaps,
  onOpenSettings,
  onBuildDerived,
  onAddGap,
  onBoxSelect,
  onEstimate,
  onOpenLog,
}: Props) {
  // 浏览器模式下 `?more=1` 直接展开（截图 / 回归用，不进打包逻辑）
  const [open, setOpen] = useState(
    () => !('__TAURI_INTERNALS__' in window) && new URLSearchParams(location.search).has('more'),
  )
  const boxRef = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc 关闭。⚠️ 必须用 capture 之外的普通监听，
  // 且要在菜单内部的点击里 stopPropagation，否则点菜单项会立刻被关掉。
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

  /** 点完就关 —— 菜单是"一次性"的，停留只会让界面变乱 */
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  /**
   * 三组菜单项。顺序 = 用户的使用顺序：
   * 先换数据 → 再调工具 → 出问题才来排障。
   *
   * `extra` 用来挂"不是按钮"的东西（快捷键折叠表）：它和按钮同组，
   * 但不需要 hover / disabled 那套样式，所以不走 MenuItem。
   */
  const groups: { title: string; items: MenuItem[]; extra?: JSX.Element }[] = [
    {
      title: '数据',
      items: [
        {
          label: '更换影像或结果文件…',
          desc: '换一张航拍图，或指定已有的检测结果',
          onSelect: run(onChangeData),
        },
        {
          label: '重新载入检测结果',
          desc: '从磁盘重新读一次（结果文件被外部更新时用）',
          onSelect: run(onReloadGaps),
          disabled: !hasImage,
        },
      ],
    },
    {
      title: '工具',
      items: [
        {
          label: '检测参数…',
          desc: '目标密度、并行进程数、林龄档位（影响判定松紧）',
          onSelect: run(onOpenSettings),
        },
        {
          // 放在「工具」而不是「数据」：它产出的是检测的**输入**，
          // 用户的心智是"我要准备检测用的东西"
          label: '生成高度图与林地边界…',
          desc: '换园区 / 换航拍批次必做',
          onSelect: run(onBuildDerived),
        },
        {
          label: '手工补画一块空地',
          desc: '算法漏掉的地方，自己画一块',
          onSelect: run(onAddGap),
          disabled: gapCount === 0,
        },
        {
          label: '框选多选',
          desc: '一次选中一片，批量改类别',
          onSelect: run(onBoxSelect),
          disabled: gapCount === 0,
        },
        {
          label: '估算可种植数量',
          desc: '按当前多边形算能种多少株',
          onSelect: run(onEstimate),
          disabled: gapCount === 0,
        },
      ],
    },
    {
      title: '帮助',
      items: [
        {
          label: '打开输出目录',
          desc: '交付包和排障日志都在这里；出错时把日志内容发给开发者',
          onSelect: run(onOpenLog),
        },
      ],
      // 快捷键不算"功能"，是查表 —— 折叠着不占地方
      extra: (
        <details className="mm-help">
          <summary>快捷键</summary>
          <dl>
            <dt>
              <kbd>Ctrl</kbd>+<kbd>Z</kbd>
            </dt>
            <dd>撤销（批量操作算一步）</dd>
            <dt>
              <kbd>Ctrl</kbd>+<kbd>Y</kbd>
            </dt>
            <dd>重做</dd>
            <dt>
              <kbd>Delete</kbd>
            </dt>
            <dd>删除选中</dd>
            <dt>
              <kbd>Shift</kbd>+点
            </dt>
            <dd>加选 / 减选</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>退出当前工具</dd>
          </dl>
        </details>
      ),
    },
  ]

  return (
    <div className="more-wrap" ref={boxRef}>
      <button
        type="button"
        className={open ? 'btn icon active' : 'btn icon'}
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>

      {open && (
        <div className="more-menu" role="menu">
          {groups.map((g) => (
            <div className="more-group" key={g.title} role="group" aria-label={g.title}>
              <div className="more-group-title">{g.title}</div>
              {g.items.map((it) => (
                <button
                  key={it.label}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={it.onSelect}
                >
                  <span className="more-item-label">{it.label}</span>
                  <span className="more-item-desc">{it.desc}</span>
                </button>
              ))}
              {g.extra}
            </div>
          ))}

          <div className="mm-note">
            排障用日志：<code>%LOCALAPPDATA%\fgd\logs\app.log</code>
          </div>
        </div>
      )}
    </div>
  )
}
