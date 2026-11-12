import { useEffect, useState } from 'react'
import { ArrowUpRight, Link2Off, Loader2, Printer } from 'lucide-react'
import { getSharedProject } from '../api/projects'
import type { SharedProject } from '../domain/project'
import { describeTiming } from '../domain/radar'
import '../styles/project-share.css'

// 作品分享页：发给没有账号的人看（甲方、剪辑、客户）。
// 不套工作台外壳，也没有任何编辑动作；内容只来自 GET /api/share/project/<token>，
// 服务端按白名单给字段——这里看到的就是分享者愿意公开的那部分。

const VERDICT_LABEL: Record<string, string> = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }

const dayLabel = (iso: string) => {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
}

const seconds = (value: number) => (Number.isFinite(value) ? value.toFixed(1) + 's' : '—')

export default function ProjectSharePage({ token }: { token: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [view, setView] = useState<SharedProject | null>(null)
  const [message, setMessage] = useState('')

  // 分享页是独立入口：标签页标题写作品名，别让收到链接的人看到工作台的名字
  useEffect(() => {
    const previous = document.title
    document.title = view ? view.project.title + ' · VisionQA 只读分享' : 'VisionQA 只读分享'
    return () => {
      document.title = previous
    }
  }, [view])

  useEffect(() => {
    // 换一条分享链接时 App 会整页重挂（key 是 token），这里不用先清状态
    let alive = true
    getSharedProject(token)
      .then((result) => {
        if (!alive) return
        setView(result)
        setStatus('ready')
      })
      .catch((caught: unknown) => {
        if (!alive) return
        setMessage(caught instanceof Error ? caught.message : String(caught))
        setStatus('missing')
      })
    return () => {
      alive = false
    }
  }, [token])

  const openWorkbench = () => {
    window.location.hash = '#/overview'
  }

  if (status === 'loading') {
    return (
      <div className="pshare-page pshare-page--center">
        <div className="pshare-state">
          <Loader2 size={16} className="vq-spin" />
          <span>正在打开作品分享</span>
        </div>
      </div>
    )
  }

  if (status === 'missing' || !view) {
    return (
      <div className="pshare-page pshare-page--center">
        <div className="pshare-state pshare-state--missing">
          <Link2Off size={20} />
          <strong>这个分享链接已经失效</strong>
          <p>{message && !/失效|停止分享/.test(message) ? message : '分享者可能已经停止分享，或者换过一条新链接。'}</p>
          <p className="pshare-state-note">停止分享后，同一个地址会立即失效，重新开启会生成一条新链接。</p>
          <button type="button" className="pshare-button is-primary" onClick={openWorkbench}>
            打开 VisionQA
            <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
    )
  }

  const script = view.script
  const beats = script?.structure || []
  const verdict = VERDICT_LABEL[view.stats.lastVerdict] || ''

  return (
    <div className="pshare-page">
      <header className="pshare-topbar">
        <div className="pshare-brand">
          <span className="pshare-brand-dot" aria-hidden="true" />
          <span className="pshare-brand-name">VisionQA</span>
          <span className="pshare-badge">只读分享</span>
        </div>
        <div className="pshare-actions">
          <button type="button" className="pshare-button" onClick={() => window.print()}>
            <Printer size={14} />
            打印
          </button>
          <button type="button" className="pshare-button is-primary" onClick={openWorkbench}>
            打开 VisionQA
            <ArrowUpRight size={14} />
          </button>
        </div>
      </header>

      <main className="pshare-doc">
        <section className="pshare-head">
          <span className="pshare-kicker">作品分享 / SHARED PROJECT</span>
          <h1>{view.project.title}</h1>
          <div className="pshare-meta">
            <span className={'pshare-status is-' + view.project.status}>
              {view.project.status === 'done' ? '已交付' : '在做'}
            </span>
            {view.project.version ? <span className="pshare-mono">v{view.project.version}</span> : null}
            <span>更新 {dayLabel(view.project.updatedAt)}</span>
            {view.template ? <span>模板 · {view.template.title}</span> : null}
            {view.sharedAt ? <span>分享于 {dayLabel(view.sharedAt)}</span> : null}
          </div>
        </section>

        <dl className="pshare-stats">
          <div>
            <dt>脚本</dt>
            <dd>
              {view.stats.beats}
              <small> 段</small>
            </dd>
          </div>
          <div>
            <dt>分镜</dt>
            <dd>
              {view.stats.shots}
              <small> 镜</small>
            </dd>
          </div>
          <div>
            <dt>评审</dt>
            <dd>
              {view.stats.reviews}
              <small> 次</small>
            </dd>
          </div>
          <div>
            <dt>运行</dt>
            <dd>
              {view.stats.runs}
              <small> 次</small>
            </dd>
          </div>
        </dl>

        {script?.hook ? (
          <section className="pshare-block">
            <div className="pshare-block-head">
              <h2>开头钩子</h2>
              <span>前 3 秒决定留人</span>
            </div>
            <p className="pshare-quote">{script.hook}</p>
          </section>
        ) : null}

        <section className="pshare-block">
          <div className="pshare-block-head">
            <h2>脚本</h2>
            <span>{script ? (script.source === 'project' ? '按这条作品改过的版本' : '跟随模板') : '还没写脚本'}</span>
          </div>
          {beats.length ? (
            <ol className="pshare-beats">
              {beats.map((beat, index) => (
                <li key={index}>
                  <span className="pshare-beat-n pshare-mono">{String(index + 1).padStart(2, '0')}</span>
                  <div className="pshare-beat-main">
                    <div className="pshare-beat-row">
                      <strong>{beat.beat}</strong>
                      <span className="pshare-mono">
                        {seconds(Number(beat.startSec) || 0)}–{seconds(Number(beat.endSec) || 0)}
                      </span>
                      {beat.expectedSec ? <span className="pshare-beat-fit">口播约 {beat.expectedSec.toFixed(1)}s</span> : null}
                    </div>
                    {beat.voiceover ? <p className="pshare-beat-copy">{beat.voiceover}</p> : null}
                    {beat.onScreen ? <p className="pshare-beat-onscreen">屏幕字 · {beat.onScreen}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="pshare-empty">这条作品还没有脚本：它通常从一条模板开始，再到作品页把词改成自己的。</p>
          )}
          {script?.timing ? <p className="pshare-note">{describeTiming(script.timing)}</p> : null}
        </section>

        <section className="pshare-block">
          <div className="pshare-block-head">
            <h2>分镜</h2>
            <span>
              {view.template
                ? (view.template.platformLabel ? view.template.platformLabel + ' · ' : '') + '原片 ' + seconds(view.template.durationSec)
                : '模板已删除，只剩脚本'}
            </span>
          </div>
          {view.storyboard.length ? (
            <ol className="pshare-shots">
              {view.storyboard.map((shot) => (
                <li key={shot.shotNo}>
                  <span className="pshare-shot-frame">
                    {shot.frameUrl ? (
                      <img src={shot.frameUrl} alt={'第 ' + shot.shotNo + ' 镜画面'} />
                    ) : (
                      <span className="pshare-shot-blank pshare-mono">{String(shot.shotNo).padStart(2, '0')}</span>
                    )}
                  </span>
                  <div className="pshare-shot-main">
                    <div className="pshare-shot-row">
                      <strong>第 {shot.shotNo} 镜</strong>
                      <span className="pshare-mono">
                        {seconds(shot.startSec)}–{seconds(shot.endSec)}
                      </span>
                      {shot.camera ? <span className="pshare-shot-camera">{shot.camera}</span> : null}
                    </div>
                    {shot.visual ? <p className="pshare-shot-copy">{shot.visual}</p> : null}
                    {shot.caption ? <p className="pshare-shot-caption">字幕 · {shot.caption}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="pshare-empty">这条作品没有可展示的分镜。</p>
          )}
        </section>

        <section className="pshare-block">
          <div className="pshare-block-head">
            <h2>评审</h2>
            <span>结论由视觉模型给出，只作参考</span>
          </div>
          {view.stats.reviews ? (
            <div className="pshare-review-row">
              <span className={'pshare-verdict is-' + (view.stats.lastVerdict || 'none')}>{verdict || '有记录'}</span>
              <span>
                评过 {view.stats.reviews} 次
                {view.stats.lastAt ? ' · 最近 ' + dayLabel(view.stats.lastAt) : ''}
              </span>
            </div>
          ) : (
            <p className="pshare-empty">这条作品还没有进过评审。</p>
          )}
        </section>

        <footer className="pshare-foot">
          <div>
            <strong>关于这个链接</strong>
            <p>
              只读分享：只展示这条作品的脚本、分镜与评审次数，不展示账号、积分与画布内容。
              分享者停止分享后，这个地址会立即失效。
            </p>
          </div>
          <button type="button" className="pshare-button is-primary" onClick={openWorkbench}>
            打开 VisionQA
            <ArrowUpRight size={14} />
          </button>
        </footer>
      </main>
    </div>
  )
}
