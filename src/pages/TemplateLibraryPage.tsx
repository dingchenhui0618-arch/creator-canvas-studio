import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Copy, Download, ExternalLink, Film, Heart, Layers, MessageCircle, Play, Printer, RefreshCw, ScanEye, Search, Share2, Sparkles, Star, Trash2, X } from 'lucide-react'
import { applyTemplate, coverSrc, deleteTemplate, formatCount, formatDuration, getHealth, getTemplate, listTemplates } from '../api/radar'
import { downloadTemplateMarkdown } from '../lib/templateExport'
import { describeTiming, paceLabel } from '../domain/radar'
import type { MediaItem, ReplicaTemplate } from '../domain/radar'
import { requestReview } from '../state/review'
import { ReplicateModal } from '../components/ReplicateModal'
import { TrashModal } from '../components/TrashModal'
import PageHead from '../components/PageHead'
import '../styles/radar.css'

// 类型标签按库里真实的内容类型生成：写死一份清单，一旦运营改了分类就会出现「点了没结果」的空标签
const pickTypes = (byType: Record<string, number>, saved: number) => {
  const names = Object.entries(byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
  if (saved > 0 && !names.includes('待解析')) names.push('待解析')
  return ['全部', ...names]
}

// 模板详情里需要 MediaItem 才能跑复刻：这里把模板还原成检索卡片
function asMedia(template: ReplicaTemplate): MediaItem {
  return {
    id: template.sourceId,
    platform: template.platform,
    platformLabel: template.platformLabel,
    title: template.title,
    author: template.author,
    cover: template.cover,
    url: template.sourceUrl,
    publishedAt: template.publishedAt,
    durationSec: template.durationSec || null,
    stats: template.stats,
  }
}

const isParsed = (template: ReplicaTemplate) => template.kind !== 'saved'

// 解析过的模板用本地帧图；只存链接的用平台封面，必须走 /api/cover 代理（直连会 403 / mixed content）
const coverFor = (template: ReplicaTemplate) => {
  const url = template.thumb || template.cover || ''
  if (!url) return ''
  return url.startsWith('/media/') || url.startsWith('/api/') ? url : coverSrc(url)
}

export function TemplateLibraryPage({ onToast, onBack, onOpenCanvas }: { onToast: (message: string) => void; onBack: () => void; onOpenCanvas: (flowId?: string) => void }) {
  const [items, setItems] = useState<ReplicaTemplate[]>([])
  const [byType, setByType] = useState<Record<string, number>>({})
  const [parsed, setParsed] = useState(0)
  const [saved, setSaved] = useState(0)
  const [flowTemplates, setFlowTemplates] = useState(0)
  const [type, setType] = useState('全部')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ReplicaTemplate | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [health, setHealth] = useState<{ redfox: boolean; vision: boolean }>({ redfox: false, vision: false })
  const [replicateItem, setReplicateItem] = useState<MediaItem | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)

  const totalReuse = useMemo(() => items.reduce((sum, item) => sum + (item.reuseCount || 0), 0), [items])
  const typeOptions = useMemo(() => pickTypes(byType, saved), [byType, saved])
  // 分类被后台改名后，旧分类已经不在标签里：渲染时直接落回「全部」，不用再开一个 setState 副作用
  const activeType = type === '全部' || typeOptions.includes(type) ? type : '全部'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listTemplates({ q: keyword.trim(), type: activeType === '全部' ? '' : activeType })
      setItems(result.items)
      setByType(result.byType || {})
      setParsed(result.parsed || 0)
      setSaved(result.saved || 0)
      setFlowTemplates(result.flows || 0)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [keyword, activeType])

  // 数据来自本地 API，挂载与筛选变化时由外部系统触发一次重新拉取
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    getHealth()
      .then((result) => setHealth({ redfox: result.redfox, vision: result.vision }))
      .catch(() => setHealth({ redfox: false, vision: false }))
  }, [])

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



  return (
    <div className="page page--templates">
      <PageHead
        kicker="模板库 / TEMPLATES"
        title="模板库"
        desc="只存原链接、互动数据和解析出来的脚本与分镜，不保存原视频文件。雷达里点「加入模板库」先存一条待解析条目，点「解析」才补上脚本与分镜；解析结果可直接交给拍摄，平台当前不出成片。"
        actions={
          <>
            <button className="button button--ghost" onClick={onBack}>回到雷达</button>
            <button className="button button--ghost" onClick={() => setTrashOpen(true)}>
              <Trash2 size={15} />回收站
            </button>
            <button className="button button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />刷新
            </button>
          </>
        }
      />

      <div className="asset-summary template-summary">
        <div><span className="section-kicker">模板总数</span><strong>{items.length}</strong><span>条</span></div>
        <div><span className="section-kicker">已解析</span><strong>{parsed}</strong><span>有脚本与分镜</span></div>
        <div><span className="section-kicker">待解析</span><strong>{saved}</strong><span>只有链接</span></div>
        <div><span className="section-kicker">画布工作流</span><strong>{flowTemplates}</strong><span>个</span></div>
        <div><span className="section-kicker">累计复用</span><strong>{totalReuse}</strong><span>次</span></div>
      </div>

      <div className="asset-toolbar">
        <label className="inline-search">
          <Search size={15} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、钩子、标签或可复用规则" />
        </label>
        <div className="filter-tabs template-type-tabs">
          {typeOptions.map((value) => (
            <button key={value} className={activeType === value ? 'is-active' : ''} onClick={() => setType(value)}>
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
          <span>去「爆款雷达」检索一条：点「加入模板库」先存链接与互动数据，点「解析」再拆脚本和分镜（出成片要自己拍）。</span>
          <button className="button button--primary" onClick={onBack}>去检索一条</button>
        </div>
      ) : (
        <div className="template-grid">
          {items.map((item) => (
            <article className="template-card" key={item.id} onClick={() => void openDetail(item.id)}>
              <div className="template-cover">
                {coverFor(item) ? <img src={coverFor(item)} alt="" loading="lazy" /> : <span className="template-cover-empty">{item.platformLabel}</span>}
                <span className={'template-type' + (isParsed(item) ? '' : ' is-pending')}>{isParsed(item) ? item.contentType : '待解析'}</span>
                <span className="radar-duration"><Film size={11} />{item.kind === 'flow' ? (item.flowNodes?.length ?? 0) + ' 节点' : formatDuration(item.durationSec)}</span>
              </div>
              <div className="template-copy">
                <strong>{item.title}</strong>
                <span className="template-hook">
                  {item.kind === 'flow'
                    ? '来自画布 · 套用后原样开回一张新画布'
                    : isParsed(item) ? item.hook : item.author ? item.author + ' · 只有原链接，还没解析' : '只有原链接，还没解析'}
                </span>
                {item.kind === 'flow' ? null : (
                  <div className="template-stats">
                    {(item.stats?.plays || 0) > 0 && <span><Play size={11} />{formatCount(item.stats.plays || 0)}</span>}
                    <span><Heart size={11} />{formatCount(item.stats?.likes || 0)}</span>
                    <span><Star size={11} />{formatCount(item.stats?.collects || 0)}</span>
                    <span><MessageCircle size={11} />{formatCount(item.stats?.comments || 0)}</span>
                    <span><Share2 size={11} />{formatCount(item.stats?.shares || 0)}</span>
                  </div>
                )}
                <div className="template-meta">
                  {item.kind === 'flow' ? (
                    <>
                      <span>{(item.flowNodes || []).slice(0, 3).map((node) => node.title).join(' · ') || '流程节点'}</span>
                    </>
                  ) : isParsed(item) ? (
                    <>
                      <span>{item.structure.length} 段脚本</span>
                      <span>{item.storyboard.length} 个分镜</span>
                    </>
                  ) : (
                    <span>点开可去解析</span>
                  )}
                </div>
                <div className="template-foot">
                  <span>
                    {item.shared ? <span className="template-shared">官方示例</span> : null}
                    {item.platformLabel}
                    {item.author ? ' · ' + item.author : ''}
                  </span>
                  <span>{item.reuseCount ? '已复用 ' + item.reuseCount + ' 次' : '未复用'}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {(detail || detailLoading) && createPortal(
        <div className="drawer-backdrop" onMouseDown={() => setDetail(null)}>
          <aside className="template-drawer" onMouseDown={(event) => event.stopPropagation()}>
            {detailLoading && !detail ? (
              <div className="drawer-loading"><RefreshCw size={16} className="spin" />加载模板详情</div>
            ) : detail ? (
              <>
                <header className="drawer-head">
                  <div>
                    <span className="section-kicker">{detail.kind === 'flow' ? '工作流' : (isParsed(detail) ? detail.contentType : '待解析') + ' · ' + detail.platformLabel}</span>
                    <strong>{detail.title}</strong>
                    <span className="drawer-sub">
                      {detail.kind === 'flow'
                        ? '来自画布 · 套用后开回一张新画布 · ' + (detail.flowNodes?.length || 0) + ' 个节点'
                        : (detail.author || '未知作者') + ' · ' + formatDuration(detail.durationSec)}
                      {' · 模板 ' + detail.id}
                    </span>
                  </div>
                  <button className="icon-button" onClick={() => setDetail(null)} aria-label="关闭"><X size={16} /></button>
                </header>

                <div className="drawer-body">
                  {detail.kind === 'flow' ? (
                    <section className="drawer-section">
                      <div className="drawer-section-head"><h3>流程节点</h3><span>{detail.flowNodes?.length || 0} 个</span></div>
                      <ul className="drawer-list drawer-list--flow">
                        {(detail.flowNodes || []).map((node, index) => (
                          <li key={index}><span className="vq-mono">{String(index + 1).padStart(2, '0')}</span>{node.title}<em>{node.kind}</em></li>
                        ))}
                      </ul>
                      {(detail.analysis?.reusableRules || []).length ? (
                        <>
                          <div className="drawer-section-head drawer-section-head--tight"><h4>节点提示词</h4></div>
                          <ul className="drawer-list drawer-list--rules">
                            {detail.analysis.reusableRules.map((rule, index) => <li key={index}>{rule}</li>)}
                          </ul>
                        </>
                      ) : null}
                    </section>
                  ) : (
                  <>
                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>互动数据</h3><span>来自检索结果</span></div>
                    <div className="drawer-stats">
                      {(detail.stats?.plays || 0) > 0 && <span>播放 <b>{formatCount(detail.stats.plays || 0)}</b></span>}
                      <span>点赞 <b>{formatCount(detail.stats?.likes || 0)}</b></span>
                      <span>收藏 <b>{formatCount(detail.stats?.collects || 0)}</b></span>
                      <span>评论 <b>{formatCount(detail.stats?.comments || 0)}</b></span>
                      <span>转发 <b>{formatCount(detail.stats?.shares || 0)}</b></span>
                    </div>
                  </section>

                  {isParsed(detail) ? (
                    <>
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
                              <span className="beat-time">
                                {beat.startSec}s – {beat.endSec}s
                                {beat.fit === 'tight' && <em className="beat-time-warn">台词约需 {beat.expectedSec}s</em>}
                              </span>
                              <div>
                                <strong>{beat.beat}</strong>
                                <p>{beat.voiceover}</p>
                                {beat.onScreen && (
                                  <span className="beat-onscreen">
                                    屏幕字：{beat.onScreen.replace(/^(建议)?(屏幕字|字幕)s*[：:]s*/, '')}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>

                      <section className="drawer-section">
                        <div className="drawer-section-head"><h3>分镜表</h3><span>{detail.storyboard.length} 个镜头</span></div>
                        {detail.timing && detail.timing.estimatedSec > 0 ? (
                          <p className={`timing-note timing-note--${detail.timing.fit}`}>
                            <strong>台词约需 {detail.timing.estimatedSec}s</strong>
                            <span>
                              原片 {detail.timing.durationSec}s · 按{paceLabel(detail.timing.pace)}速估（{detail.timing.rate ?? 0} 字/秒）· {describeTiming(detail.timing)}
                            </span>
                          </p>
                        ) : null}
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
                                  {shot.expectedSec && shot.fit === 'tight' ? <span className="is-tight">念完约 {shot.expectedSec}s</span> : null}
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
                    </>
                  ) : (
                    <section className="drawer-section drawer-section--pending">
                      <div className="drawer-section-head"><h3>还没解析</h3><span>只有原链接</span></div>
                      <p className="drawer-pending-copy">
                        这条是你在雷达里点「加入模板库」存下来的：原链接、作者、互动数据都在，
                        脚本结构和分镜需要跑一次解析才有。解析要下载视频抽帧，所以单独点一次。
                      </p>
                      <button
                        className="button button--primary"
                        disabled={!detail.sourceUrl}
                        onClick={() => setReplicateItem(asMedia(detail))}
                      >
                        <Sparkles size={14} />去解析这条
                      </button>
                    </section>
                  )}

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>来源</h3><span>不保存视频文件</span></div>
                    <div className="drawer-source">
                      <span>{detail.platformLabel} · {detail.sourceId}</span>
                      {detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开原视频</a> : <span className="is-muted">原链接缺失（示例数据或直链测试）</span>}
                    </div>
                  </section>
                  </>
                  )}

                  <section className="drawer-section drawer-section--export">
                    <div className="drawer-section-head"><h3>导出</h3><span>把这条拿走去用</span></div>
                    <div className="drawer-export-actions">
                      <button
                        className="button button--ghost"
                        onClick={() => {
                          const name = downloadTemplateMarkdown(detail)
                          onToast('已下载 ' + name + '，可直接贴进飞书或 Notion')
                        }}>
                        <Download size={14} />下载 Markdown
                      </button>
                      <button className="button button--ghost" onClick={() => window.print()}>
                        <Printer size={14} />打印或存 PDF
                      </button>
                    </div>
                    <p className="drawer-export-note">
                      Markdown 里是分镜表、口播和每镜建议秒数；打印出来是纯白 A4 稿，在打印对话框里选「另存为 PDF」就能归档或发给剪辑。
                    </p>
                  </section>
                </div>

                <footer className="drawer-foot">
                  {detail.kind === 'flow' ? null : (
                    <>
                      <button
                        className="button button--ghost"
                        title="打开视觉评审页并用这条的首帧预填；在评审页点「开始评审」才会扣积分"
                        onClick={() => {
                          const firstFrame = detail.frames?.[0]?.url || ''
                          const media = firstFrame.replace(/^\/media\//, '')
                          requestReview({
                            media: media || undefined,
                            imageUrl: media ? undefined : detail.cover || undefined,
                            label: detail.title,
                            intent: '评审这条模板的首帧是否适合作为封面/开场',
                          })
                        }}>
                        <ScanEye size={14} />去评审
                      </button>
                      <button className="button button--ghost" disabled={!isParsed(detail)} onClick={() => {
                        const list = [detail.hook, ...detail.structure.map((beat) => beat.beat + '：' + beat.voiceover), 'CTA：' + (detail.structure.at(-1)?.purpose || '')].join('\n')
                        void navigator.clipboard?.writeText(list).then(() => onToast('脚本已复制到剪贴板')).catch(() => onToast('复制失败'))
                      }}>
                        <Copy size={14} />复制脚本
                      </button>
                    </>
                  )}
                  <button
                    className="button button--primary"
                    disabled={detail.kind !== 'flow' && !isParsed(detail)}
                    onClick={() => {
                      void applyTemplate(detail.id)
                        .then((result) => {
                          setDetail({ ...detail, reuseCount: result.template.reuseCount })
                          onToast(detail.kind === 'flow' ? '已打开画布：' + result.flow.name : '已生成画布草稿：' + result.flow.name)
                          onOpenCanvas(result.flow.id)
                        })
                        .catch((caught) => onToast(caught instanceof Error ? caught.message : '套用模板失败'))
                    }}
                  >
                    <Layers size={14} />{detail.kind === 'flow' ? '在画布打开' : '套用到画布'}
                  </button>
                  <button className="button button--danger button--tiny" onClick={() => { void deleteTemplate(detail.id).then(() => { setDetail(null); onToast('已移到回收站，30 天内可以恢复'); void load() }) }}>
                    <Trash2 size={13} />删除
                  </button>
                </footer>
              </>
            ) : null}
          </aside>
        </div>,
        document.body,
      )}

      {trashOpen && (
        <TrashModal
          onClose={() => setTrashOpen(false)}
          onToast={onToast}
          onRestored={() => { void load() }}
        />
      )}

      {replicateItem && (
        <ReplicateModal
          item={replicateItem}
          hasKey={health.redfox}
          visionReady={health.vision}
          onClose={() => setReplicateItem(null)}
          onDone={(title) => { setReplicateItem(null); setDetail(null); onToast('解析完成，模板已更新：' + title); void load() }}
          onOpenTemplates={() => { setReplicateItem(null); setDetail(null); void load() }}
        />
      )}
    </div>
  )
}
