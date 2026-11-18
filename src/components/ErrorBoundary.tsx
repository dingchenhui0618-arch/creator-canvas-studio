// 页面级错误边界：渲染抛错时只替换内容区，侧栏、面包屑和导航继续可用。
// 切页由 App 用路由 key 重新挂载；同一页里收到 vq:navigate 事件也会自动复位。
//
// 发版后旧标签页会撞上「取不到页面文件」（懒加载的 chunk 已经被新包替换）。那种情况重试没用，
// 因为地址里的文件名是旧的；自动重载由 src/main.tsx 先接一层，接不住才落到这里，给用户一个明确的按钮。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { navigate } from '../router'
import { reportReactError } from '../lib/clientErrors'
import { chunkFailureFile, isChunkLoadFailure } from '../domain/chunk-reload'

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
    // 开发时保留原始堆栈；生产里同时上报，后台「系统」页能看到是哪一页炸了。
    console.error('[vq] 页面渲染出错：', error, info.componentStack)
    reportReactError(error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
  }

  private goOverview = () => {
    navigate({ kind: 'page', page: 'overview' })
    this.reset()
  }

  private reload = () => {
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    // 取不到页面文件：不是这一页写坏了，是本地还攥着旧版本的文件名。说清楚原因，别让用户以为是自己点坏了。
    if (isChunkLoadFailure(error)) {
      const file = chunkFailureFile(error)
      return (
        <div className="vq-error-fallback" role="alert">
          <div className="vq-error-card">
            <span className="vq-error-kicker">页面已更新</span>
            <h1>这一页要用新的程序文件</h1>
            <p>
              你打开这个页面之后我们发布过新版本，旧版本的页面文件已经被换掉了，这个标签页里还记着旧文件名。重新载入就能拿到最新一版；已经保存的内容不受影响，正在填、还没提交的内容要重来一次。
            </p>
            {file ? (
              <div className="vq-error-detail">
                <span className="vq-error-label">取不到的文件</span>
                <pre className="vq-error-summary">{file}</pre>
              </div>
            ) : null}
            <div className="vq-error-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={this.reload}>
                重新载入
              </button>
              <button type="button" className="vq-button vq-button--ghost" onClick={this.goOverview}>
                回工作台
              </button>
            </div>
          </div>
        </div>
      )
    }

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
