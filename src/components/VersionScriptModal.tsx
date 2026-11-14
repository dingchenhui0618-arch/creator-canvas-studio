import { ArrowRight, X } from 'lucide-react'
import type { ProjectVersionScriptSnapshot } from '../domain/project'

// 某一版开新版时存下的脚本（v0.9.114）。
// 只读：这里展示的是快照原文，不在弹窗里改脚本；要改去当前版改。
export type VersionScriptState = {
  open: boolean
  n: number
  name: string
  change: string
  busy: boolean
  error: string
  script: ProjectVersionScriptSnapshot | null
  reason: string
}

export function VersionScriptModal({ state, onClose }: { state: VersionScriptState; onClose: () => void }) {
  if (!state.open) return null
  const script = state.script
  return (
    <div className="vq-modal-backdrop" onMouseDown={onClose}>
      <div
        className="vq-verscript-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vq-verscript-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="vq-verscript-head">
          <div>
            <span className="vq-mono">版本脚本 / SNAPSHOT · v{state.n}</span>
            <h2 id="vq-verscript-title">{state.name || 'v' + state.n}</h2>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭版本脚本" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {state.busy ? (
          <p className="vq-verscript-state">正在读这一版的脚本…</p>
        ) : state.error ? (
          <p className="vq-verscript-state is-error">{state.error}</p>
        ) : script ? (
          <>
            {state.n > 1 && state.change ? (
              <p className="vq-verscript-change">
                <span className="vq-mono">比 v{state.n - 1}</span>
                {state.change}
              </p>
            ) : null}
            <div className="vq-verscript-hook">
              <span className="vq-verscript-label">开头钩子</span>
              <p>{script.hook || '这一版没写钩子'}</p>
            </div>
            {script.structure.length ? (
              <ol className="vq-verscript-beats">
                {script.structure.map((beat, index) => (
                  <li className="vq-verscript-beat" key={index}>
                    <span className="vq-verscript-beat-n vq-mono">{String(index + 1).padStart(2, '0')}</span>
                    <div className="vq-verscript-beat-body">
                      <div className="vq-verscript-beat-head">
                        <strong>{beat.beat || '未命名段落'}</strong>
                        {beat.startSec || beat.endSec ? (
                          <span className="vq-mono">{beat.startSec}–{beat.endSec}s</span>
                        ) : null}
                      </div>
                      <p>{beat.voiceover || '（无口播）'}</p>
                      {beat.onScreen ? (
                        <p className="vq-verscript-onscreen">
                          <span>屏幕字</span>
                          {beat.onScreen}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="vq-verscript-state">这一版的脚本没有分段。</p>
            )}
            <p className="vq-verscript-note">
              {script.source === 'template'
                ? '这一版当时跟随模板；模板之后改了，这份快照仍然是当时的样子。'
                : '这一版自己的脚本；之后在作品页再改，只影响新版本。'}
              <span className="vq-verscript-more">
                要改脚本去当前版
                <ArrowRight size={11} />
              </span>
            </p>
          </>
        ) : (
          <p className="vq-verscript-state">{state.reason || '这一版没有脚本快照。'}</p>
        )}
      </div>
    </div>
  )
}
