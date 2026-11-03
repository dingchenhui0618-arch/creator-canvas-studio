import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Copy, ExternalLink, Film, Layers, RefreshCw, ScanEye, Search, Trash2, X } from 'lucide-react'
import { deleteTemplate, formatCount, formatDuration, getTemplate, listTemplates, reuseTemplate } from '../api/radar'
import type { ReplicaTemplate } from '../domain/radar'
import { requestReview } from '../state/review'

const TYPES = ['全部', '口播干货', '剧情演绎', '教程拆解', '产品测评', '种草分享', '开箱体验', '探店vlog', '混剪卡点']

export function TemplateLibraryPage({ onToast, onBack }: { onToast: (message: string) => void; onBack: () => void }) {
  const [items, setItems] = useState<ReplicaTemplate[]>([])
  const [byType, setByType] = useState<Record<string, number>>({})
  const [type, setType] = useState('全部')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ReplicaTemplate | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listTemplates({ q: keyword.trim(), type: type === '全部' ? '' : type })
      setItems(result.items)
      setByType(result.byType || {})
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [keyword, type])

  // 数据来自本地 API，挂载与筛选变化时由外部系统触发一次重新拉取
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    try {
      setDetail(await getTemplate(id))
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDetailLoading(false)
    }
  }

  const totalReuse = useMemo(() => items.reduce((sum, item) => sum + (item.reuseCount || 0), 0), [items])
  const coveredTypes = useMemo(() => Object.keys(byType).length, [byType])

  return (
    <div className="page page--templates">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" />模板库</div>
          <h1>复刻模板库</h1>
          <p>每条模板都保留了脚本结构、分镜表和原视频链接，可以按内容类型检索，再拿去复用。</p>
        </div>
        <div className="heading-actions">
          <button className="button button--ghost" onClick={onBack}>回到雷达</button>
          <button className="button button--ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />刷新
          </button>
        </div>
      </div>

      <div className="asset-summary template-summary">
        <div><span className="section-kicker">模板总数</span><strong>{items.length}</strong><span>可检索</span></div>
        <div><span className="section-kicker">内容类型</span><strong>{coveredTypes}</strong><span>已归类</span></div>
        <div><span className="section-kicker">累计复用</span><strong>{totalReuse}</strong><span>次</span></div>
      </div>

      <div className="asset-toolbar">
        <label className="inline-search">
          <Search size={15} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、钩子、标签或可复用规则" />
        </label>
        <div className="filter-tabs template-type-tabs">
          {TYPES.map((value) => (
            <button key={value} className={type === value ? 'is-active' : ''} onClick={() => setType(value)}>
              {value}
              {value !== '全部' && byType[value] ? <span className="tab-count">{byType[value]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="radar-banner radar-banner--error"><AlertCircle size={15} /><span>{error}</span></div>}

      {!loading && !items.length ? (
        <div className="radar-empty">
          <Layers size={22} />
          <strong>模板库还是空的</strong>
          <span>去「爆款雷达」挑一条内容，点「一键复刻」，拆出来的脚本和分镜会存到这里。</span>
          <button className="button button--primary" onClick={onBack}>去检索一条</button>
        </div>
      ) : (
        <div className="template-grid">
          {items.map((item) => (
            <article className="template-card" key={item.id} onClick={() => void openDetail(item.id)}>
              <div className="template-cover">
                {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <span className="template-cover-empty">{item.platformLabel}</span>}
                <span className="template-type">{item.contentType}</span>
                <span className="radar-duration"><Film size={11} />{formatDuration(item.durationSec)}</span>
              </div>
              <div className="template-copy">
                <strong>{item.title}</strong>
                <span className="template-hook">{item.hook}</span>
                <div className="template-meta">
                  <span>{item.structure.length} 段脚本</span>
                  <span>{item.storyboard.length} 个分镜</span>
                  {item.stats?.likes ? <span>{formatCount(item.stats.likes)} 赞</span> : null}
                </div>
                <div className="template-foot">
                  <span>{item.platformLabel}{item.author ? ' · ' + item.author : ''}</span>
                  <span>{item.reuseCount ? '已复用 ' + item.reuseCount + ' 次' : '未复用'}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {(detail || detailLoading) && (
        <div className="drawer-backdrop" onMouseDown={() => setDetail(null)}>
          <aside className="template-drawer" onMouseDown={(event) => event.stopPropagation()}>
            {detailLoading && !detail ? (
              <div className="drawer-loading"><RefreshCw size={16} className="spin" />加载模板详情</div>
            ) : detail ? (
              <>
                <header className="drawer-head">
                  <div>
                    <span className="section-kicker">{detail.contentType} · {detail.platformLabel}</span>
                    <strong>{detail.title}</strong>
                    <span className="drawer-sub">{detail.author || '未知作者'} · {formatDuration(detail.durationSec)} · 模板 {detail.id}</span>
                  </div>
                  <button className="icon-button" onClick={() => setDetail(null)} aria-label="关闭"><X size={16} /></button>
                </header>

                <div className="drawer-body">
                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>开头钩子</h3><span className="tag">{detail.hookType}</span></div>
                    <p className="drawer-quote">{detail.hook}</p>
                    <div className="drawer-tags">{detail.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>脚本结构</h3><span>{detail.structure.length} 段</span></div>
                    <ol className="beat-list">
                      {detail.structure.map((beat, index) => (
                        <li key={index} className="beat-item">
                          <span className="beat-time">{beat.startSec}s – {beat.endSec}s</span>
                          <div>
                            <strong>{beat.beat}</strong>
                            <p>{beat.voiceover}</p>
                            {beat.onScreen && <span className="beat-onscreen">屏幕字：{beat.onScreen}</span>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>分镜表</h3><span>{detail.storyboard.length} 个镜头</span></div>
                    <div className="shot-table">
                      {detail.storyboard.map((shot) => (
                        <div className="shot-row" key={shot.shotNo}>
                          <div className="shot-frame">
                            {shot.frameUrl ? <img src={shot.frameUrl} alt="" loading="lazy" /> : <span>{shot.shotNo}</span>}
                            <em>#{shot.shotNo} · {shot.startSec}s</em>
                          </div>
                          <div className="shot-copy">
                            <strong>{shot.visual || '画面描述待补充'}</strong>
                            <div className="shot-tags">
                              <span>{shot.camera || '机位未标注'}</span>
                              {shot.caption && <span>字幕：{shot.caption}</span>}
                              {shot.audio && <span>{shot.audio}</span>}
                            </div>
                            {shot.purpose && <p>{shot.purpose}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>爆款分析</h3><span>节奏：{detail.analysis.pacing}</span></div>
                    <ul className="drawer-list">
                      {detail.analysis.viralPoints.map((point, index) => <li key={index}>{point}</li>)}
                    </ul>
                    <div className="drawer-section-head drawer-section-head--tight"><h4>可复用规则</h4></div>
                    <ul className="drawer-list drawer-list--rules">
                      {detail.analysis.reusableRules.map((rule, index) => <li key={index}>{rule}</li>)}
                    </ul>
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>来源</h3><span>数据可追溯</span></div>
                    <div className="drawer-source">
                      <span>{detail.platformLabel} · {detail.sourceId}</span>
                      {detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开原视频</a> : <span className="is-muted">原链接缺失（示例数据或直链测试）</span>}
                    </div>
                  </section>
                </div>

                <footer className="drawer-foot">
                  <button className="button button--ghost" onClick={() => {
                    const firstFrame = detail.frames?.[0]?.url || ''
                    const media = firstFrame.replace(/^\/media\//, '')
                    requestReview({
                      media: media || undefined,
                      imageUrl: media ? undefined : detail.cover || undefined,
                      label: detail.title,
                      intent: '评审这条模板的首帧是否适合作为封面/开场',
                    })
                  }}>
                    <ScanEye size={14} />送去评审
                  </button>
                  <button className="button button--ghost" onClick={() => {
                    const list = [detail.hook, ...detail.structure.map((beat) => beat.beat + '：' + beat.voiceover), 'CTA：' + (detail.structure.at(-1)?.purpose || '')].join('\n')
                    void navigator.clipboard?.writeText(list).then(() => onToast('脚本已复制到剪贴板')).catch(() => onToast('复制失败'))
                  }}>
                    <Copy size={14} />复制脚本
                  </button>
                  <button className="button button--primary" onClick={() => { void reuseTemplate(detail.id).then((next) => { setDetail({ ...detail, reuseCount: next.reuseCount }); onToast('已标记复用，脚本结构可以直接套用') }) }}>
                    <Layers size={14} />复用此模板
                  </button>
                  <button className="button button--danger button--tiny" onClick={() => { void deleteTemplate(detail.id).then(() => { setDetail(null); onToast('模板已删除'); void load() }) }}>
                    <Trash2 size={13} />删除
                  </button>
                </footer>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  )
}
