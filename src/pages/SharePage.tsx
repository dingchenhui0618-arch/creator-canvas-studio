import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Download, Link2Off, Loader2, MessageCircle, Play, Printer, Share2, Star, Heart } from 'lucide-react'
import { formatCount, formatDuration, getSharedTemplate } from '../api/radar'
import { describeTiming, paceLabel, type ReplicaTemplate, type SharedTemplate } from '../domain/radar'
import { downloadTemplateMarkdown } from '../lib/templateExport'
import '../styles/share.css'

// 只读分享页：给没有账号的人看（剪辑、客户、甲方），所以这里不能有工作台外壳、侧栏和任何编辑动作。
// 内容来自 GET /api/share/<token>，服务端按白名单给字段；帧图也走同一条带 token 的地址。

const isParsed = (template: SharedTemplate) => template.kind !== 'saved'

// 下载 Markdown 复用模板库那份纯函数：补上导出需要的归属字段就是一个普通模板
const asTemplate = (shared: SharedTemplate): ReplicaTemplate => ({
  ...shared,
  sourceId: '',
  origin: shared.kind === 'flow' ? 'canvas' : 'ai',
  createdAt: shared.sharedAt,
})

const dayLabel = (iso: string) => {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="share-block">
      <div className="share-block-head">
        <h2>{title}</h2>
        {note ? <span>{note}</span> : null}
      </div>
      {children}
    </section>
  )
}

export default function SharePage({ token }: { token: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [template, setTemplate] = useState<SharedTemplate | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    // 换一条分享链接时 App 会整页重挂（key 是 token），所以这里不用先清状态
    let alive = true
    getSharedTemplate(token)
      .then((result) => {
        if (!alive) return
        setTemplate(result.template)
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
      <div className="share-page share-page--center">
        <div className="share-state">
          <Loader2 size={16} className="vq-spin" />
          <span>正在打开分享内容</span>
        </div>
      </div>
    )
  }

  if (status === 'missing' || !template) {
    return (
      <div className="share-page share-page--center">
        <div className="share-state share-state--missing">
          <Link2Off size={20} />
          <strong>这个分享链接已经失效</strong>
          {/* 服务端的「已失效」和标题重复了，那种情况改用一句人话说明 */}
          <p>{message && !/失效|停止分享/.test(message) ? message : '分享者可能已经停止分享，或者换过一条新链接。'}</p>
          <p className="share-state-note">停止分享后，同一个地址会立即失效，重新开启会生成一条新链接。</p>
          <button type="button" className="share-button share-button--primary" onClick={openWorkbench}>
            打开 VisionQA
            <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
    )
  }

  const parsed = isParsed(template)
  const isFlow = template.kind === 'flow'

  return (
    <div className="share-page">
      <header className="share-topbar">
        <div className="share-brand">
          <span className="share-brand-dot" aria-hidden="true" />
          <span className="share-brand-name">VisionQA</span>
          <span className="share-badge">只读分享</span>
        </div>
        <div className="share-actions">
          <button
            type="button"
            className="share-button"
            onClick={() => downloadTemplateMarkdown(asTemplate(template))}
          >
            <Download size={14} />下载 Markdown
          </button>
          <button type="button" className="share-button" onClick={() => window.print()}>
            <Printer size={14} />打印
          </button>
        </div>
      </header>

      <main className="share-doc">
        <div className="share-head">
          <span className="share-kicker">模板分享 / SHARED TEMPLATE</span>
          <h1>{template.title}</h1>
          <div className="share-meta">
            <span>{isFlow ? '画布工作流' : parsed ? template.contentType : '待解析'}</span>
            <span>{template.platformLabel}</span>
            {template.author ? <span>{template.author}</span> : null}
            {isFlow ? <span>{(template.flowNodes || []).length} 个节点</span> : <span>{formatDuration(template.durationSec)}</span>}
            {template.sharedAt ? <span>分享于 {dayLabel(template.sharedAt)}</span> : null}
          </div>
          {template.tags.length ? (
            <div className="share-tags">
              {template.tags.map((tag) => (
                <span className="share-tag" key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}
        </div>

        {isFlow ? (
          <Block title="流程节点" note={(template.flowNodes || []).length + ' 个'}>
            <ol className="share-node-list">
              {(template.flowNodes || []).map((node, index) => (
                <li key={index}>
                  <span className="share-node-index">{String(index + 1).padStart(2, '0')}</span>
                  <span>{node.title}</span>
                  <em>{node.kind}</em>
                </li>
              ))}
            </ol>
            {(template.analysis?.reusableRules || []).length ? (
              <ul className="share-list">
                {template.analysis.reusableRules.map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
            ) : null}
            <p className="share-note">这是画布上另存的工作流。要在自己的画布里照着搭一遍，需要登录 VisionQA 后套用这条模板。</p>
          </Block>
        ) : (
          <>
            <Block title="互动数据" note="检索当时的平台公开数据">
              <div className="share-stats">
                {(template.stats?.plays || 0) > 0 ? (
                  <span><Play size={12} />播放 <b>{formatCount(template.stats.plays || 0)}</b></span>
                ) : null}
                <span><Heart size={12} />点赞 <b>{formatCount(template.stats?.likes || 0)}</b></span>
                <span><Star size={12} />收藏 <b>{formatCount(template.stats?.collects || 0)}</b></span>
                <span><MessageCircle size={12} />评论 <b>{formatCount(template.stats?.comments || 0)}</b></span>
                <span><Share2 size={12} />转发 <b>{formatCount(template.stats?.shares || 0)}</b></span>
              </div>
            </Block>

            {parsed ? (
              <>
                {template.hook || template.hookType ? (
                  <Block title="开头钩子" note={template.hookType || undefined}>
                    {template.hook ? <p className="share-quote">{template.hook}</p> : null}
                  </Block>
                ) : null}

                {template.structure.length ? (
                  <Block title="脚本结构" note={template.structure.length + ' 段'}>
                    <ol className="beat-list share-beats">
                      {template.structure.map((beat, index) => (
                        <li key={index} className="beat-item">
                          <span className="beat-time">
                            {beat.startSec}s – {beat.endSec}s
                            {beat.fit === 'tight' && <em className="beat-time-warn">台词约需 {beat.expectedSec}s</em>}
                          </span>
                          <div>
                            <strong>{beat.beat}</strong>
                            <p>{beat.voiceover}</p>
                            {beat.onScreen ? (
                              <span className="beat-onscreen">
                                屏幕字：{beat.onScreen.replace(/^(建议)?(屏幕字|字幕)\s*[：:]\s*/, '')}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </Block>
                ) : null}

                {template.storyboard.length ? (
                  <Block title="分镜表" note={template.storyboard.length + ' 个镜头'}>
                    {template.timing && template.timing.estimatedSec > 0 ? (
                      <p className={'timing-note timing-note--' + template.timing.fit}>
                        <strong>台词约需 {template.timing.estimatedSec}s</strong>
                        <span>
                          原片 {template.timing.durationSec}s · 按{paceLabel(template.timing.pace)}速估（{template.timing.rate ?? 0} 字/秒）· {describeTiming(template.timing)}
                        </span>
                      </p>
                    ) : null}
                    <div className="shot-table">
                      {template.storyboard.map((shot) => (
                        <div className="shot-row" key={shot.shotNo}>
                          <div className="shot-frame">
                            {shot.frameUrl ? <img src={shot.frameUrl} alt="" loading="lazy" /> : <span>{shot.shotNo}</span>}
                            <em>#{shot.shotNo} · {shot.startSec}s</em>
                          </div>
                          <div className="shot-copy">
                            <strong>{shot.visual || '画面描述待补充'}</strong>
                            <div className="shot-tags">
                              <span>{shot.camera || '机位未标注'}</span>
                              {shot.caption ? <span>字幕：{shot.caption}</span> : null}
                              {shot.expectedSec && shot.fit === 'tight' ? <span className="is-tight">念完约 {shot.expectedSec}s</span> : null}
                              {shot.audio ? <span>{shot.audio}</span> : null}
                            </div>
                            {shot.purpose ? <p>{shot.purpose}</p> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Block>
                ) : null}

                {template.analysis?.viralPoints?.length || template.analysis?.reusableRules?.length ? (
                  <Block title="爆款分析" note={template.analysis.pacing ? '节奏：' + template.analysis.pacing : undefined}>
                    {template.analysis.viralPoints?.length ? (
                      <>
                        <h3 className="share-subhead">爆点</h3>
                        <ul className="share-list">
                          {template.analysis.viralPoints.map((point, index) => (
                            <li key={index}>{point}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {template.analysis.reusableRules?.length ? (
                      <>
                        <h3 className="share-subhead">可复用规则</h3>
                        <ul className="share-list">
                          {template.analysis.reusableRules.map((rule, index) => (
                            <li key={index}>{rule}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </Block>
                ) : null}
              </>
            ) : (
              <Block title="还没解析" note="只有原链接">
                <p className="share-note">
                  这条分享里只有原链接、作者和互动数据。脚本结构与分镜要由账号主人跑一次解析才会出现，
                  解析结果再分享出来时这里会自动补上。
                </p>
              </Block>
            )}

            <Block title="来源" note="未下载或转存原视频">
              <div className="share-source">
                <span>{template.platformLabel} · {template.id}</span>
                {template.sourceUrl ? (
                  <a href={template.sourceUrl} target="_blank" rel="noreferrer">
                    打开原视频
                    <ArrowUpRight size={13} />
                  </a>
                ) : (
                  <span className="is-muted">原链接缺失</span>
                )}
              </div>
            </Block>
          </>
        )}

        <footer className="share-foot">
          <div className="share-foot-copy">
            <span>由 VisionQA 分享的只读页面：不能在这里修改内容、套用模板或看到账号信息。</span>
            <span>链接由分享者随时停用，停用后同一地址立即失效。复刻请用自己的素材，并遵守原平台规则。</span>
          </div>
          <button type="button" className="share-button" onClick={openWorkbench}>
            打开 VisionQA
            <ArrowUpRight size={14} />
          </button>
        </footer>
      </main>
    </div>
  )
}
