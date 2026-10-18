import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 出错时显示的区域名（便于定位是哪个面板挂了） */
  area?: string
}

interface State {
  error: Error | null
}

/**
 * 错误边界。
 *
 * ⚠️ 为什么必须有：React 18 里组件（含 useEffect）抛出的错误若无人捕获，
 * 会**卸载整棵组件树** → 用户看到的是"整个界面消失"，而不是某个区域坏掉。
 * 本项目实测就踩过一次：MapCanvas 的 Terra Draw 在 map style 未就绪时
 * `start()` 抛出 `Style is not done loading.`，导致**整页白屏**
 * （headless 截图只剩一个纯背景色）。
 *
 * 有了它：地图挂了，工具栏 / 图层列表 / 状态栏仍然可用，
 * 并且能把真实错误显示出来，而不是让用户面对一片空白。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 走 console 而不是弹窗：Tauri 里 console 会被宿主收集进日志
    console.error(`[ErrorBoundary${this.props.area ? ' · ' + this.props.area : ''}]`, error)
    if (info.componentStack) console.error(info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h3>{this.props.area ? `${this.props.area}渲染出错` : '界面渲染出错'}</h3>
        <pre>{error.message || String(error)}</pre>
        <p className="dim">
          其它区域仍可正常使用。若这是地图区域，常见原因是显卡驱动 / WebGL 不可用 ——
          可在浏览器打开 <code>chrome://gpu</code> 确认。
        </p>
        <button className="btn" onClick={this.reset}>
          重试渲染
        </button>
      </div>
    )
  }
}
