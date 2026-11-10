// 页面级错误边界：渲染抛错时只替换内容区，侧栏、面包屑和导航继续可用。
// 切页由 App 用路由 key 重新挂载；同一页里收到 vq:navigate 事件也会自动复位。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { navigate } from '../router'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

function summarizeError(error: Error): string {
  const name = error.name || 'Error'
  const message = error.message || String(error)
  const stack = (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // stack 第一行通常是「TypeError: message」，上面已经单独展示，避免重复。
    .filter((line) => !line.startsWith(name + ':'))
    .slice(0, 4)
  return [name + ': ' + message, ...stack].join('\n')
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidMount() {
    window.addEventListener('vq:navigate', this.reset)
  }

  componentWillUnmount() {
    window.removeEventListener('vq:navigate', this.reset)
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 开发时保留原始堆栈；生产构建里同样可从这里接入上报。
    console.error('[vq] 页面渲染出错：', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
  }

  private goOverview = () => {
    navigate({ kind: 'page', page: 'overview' })
    this.reset()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="vq-error-fallback" role="alert">
        <div className="vq-error-card">
          <span className="vq-error-kicker">页面异常</span>
          <h1>这个页面出错了</h1>
          <p>渲染在中途中断，已隔离在内容区；侧栏、地址栏和其余页面仍然可用。切页或点重试会重新挂载这一页。</p>
          <div className="vq-error-detail">
            <span className="vq-error-label">错误摘要</span>
            <pre className="vq-error-summary">{summarizeError(error)}</pre>
          </div>
          <div className="vq-error-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={this.reset}>
              重试
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={this.goOverview}>
              回工作台
            </button>
          </div>
        </div>
      </div>
    )
  }
}
