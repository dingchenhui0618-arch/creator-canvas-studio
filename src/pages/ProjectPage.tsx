import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Clapperboard, CopyPlus, Pencil, RefreshCw, ScanEye, Trash2, Workflow } from 'lucide-react'
import PageHead from '../components/PageHead'
import ProjectStatusPill from '../components/ProjectStatus'
import { deleteProject, getProject, startProjectVersion, updateProject } from '../api/projects'
import { applyTemplate } from '../api/radar'
import { describeTiming } from '../domain/radar'
import { projectStep, reviewsForVersion, type ProjectDetail } from '../domain/project'
import '../styles/projects.css'

const VERDICT_LABEL: Record<string, string> = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }
const KIND_LABEL: Record<string, string> = { replica: '原片拆解', adapted: '改编版', flow: '工作流', saved: '待解析' }

const pad2 = (value: number) => String(value).padStart(2, '0')

function stamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function seconds(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toFixed(1) + 's'
}

/**
 * 作品页：一条内容的完整现场。
 * 首屏只回答「下一步点哪里」（套用模板开画布 → 送评审 → 继续改 → 交付），
 * 然后是版本对照，下面才是现场：脚本、分镜、画布、评审。
 * 脚本与分镜来自这条作品绑定的模板，页面不留副本；版本只存画布指针。
 */
export default function ProjectPage({
  projectId,
  onBack,
  onOpenFlow,
  onOpenReview,
  onBrowseTemplates,
  onToast,
}: {
  projectId: string
  onBack: () => void
  onOpenFlow: (flowId: string) => void
  onOpenReview: (projectId: string) => void
  onBrowseTemplates: () => void
  onToast: (message: string) => void
}) {
  const [data, setData] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'canvas' | 'done' | 'delete' | 'title' | 'version'>('')
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await getProject(projectId))
    } catch (caught) {
      setData(null)
      setError(caught instanceof Error ? caught.message : '作品读取失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 作品第一次绑画布就是这里：套用模板真的建一张流程画布，建完立刻绑上作品，
  // 再打开画布。失败时如实报错，不留下「画布里有一张、作品上还是空的」这种半截状态。
  const openCanvas = useCallback(async () => {
    if (!data) return
    if (data.project.flowId) {
      onOpenFlow(data.project.flowId)
      return
    }
    if (!data.template) {
      onToast('这条作品绑定的模板不见了，先去模板库挑一条再开画布')
      return
    }
    setBusy('canvas')
    try {
      const applied = await applyTemplate(data.template.id)
      await updateProject(data.project.id, { flowId: applied.flow.id })
      onToast('已生成画布：' + applied.flow.name)
      onOpenFlow(applied.flow.id)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开画布失败')
    } finally {
      setBusy('')
    }
  }, [data, onOpenFlow, onToast])

  const toggleDone = async () => {
    if (!data) return
    const next = data.project.status === 'done' ? 'active' : 'done'
    setBusy('done')
    try {
      const result = await updateProject(data.project.id, { status: next })
      setData({ ...data, project: result.project })
      onToast(next === 'done' ? '已标记为交付' : '已重新打开这条作品')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '状态没保存成功')
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    if (!data) return
    if (!window.confirm('删除这条作品？画布与评审不会被删掉，只解除关联。')) return
    setBusy('delete')
    try {
      await deleteProject(data.project.id)
      onToast('已删除作品，画布与评审仍在')
      onBack()
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '删除失败')
      setBusy('')
    }
  }

  const beginRename = () => {
    if (!data) return
    setDraftTitle(data.project.title)
    setRenaming(true)
  }

  const saveTitle = async () => {
    if (!data) return
    const title = draftTitle.trim()
    if (!title) {
      onToast('作品名不能是空的')
      return
    }
    if (title === data.project.title) {
      setRenaming(false)
      return
    }
    setBusy('title')
    try {
      const result = await updateProject(data.project.id, { title })
      setData({ ...data, project: result.project })
      setRenaming(false)
      onToast('作品名已改成「' + result.project.title + '」')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '改名没保存成功')
    } finally {
      setBusy('')
    }
  }

  // 开新版＝复制当前画布；旧画布归档成 vN，作品立刻指向新画布。
  const startVersion = async () => {
    if (!data) return
    setBusy('version')
    try {
      const result = await startProjectVersion(data.project.id)
      await load()
      onToast('已开 v' + result.project.version + '：画布从上一版复制过来，接着改这一版')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '开新版本失败')
    } finally {
      setBusy('')
    }
  }

  if (loading && !data) {
    return (
      <div className="page vq-page">
        <p className="vq-note">正在打开作品…</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page vq-page">
        <p className="vq-note vq-note--error" role="status">
          {error || '作品不存在或已被删除'}
        </p>
        <button type="button" className="vq-button vq-button--ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          回到作品列表
        </button>
      </div>
    )
  }

  const { project, template, flow, reviews } = data
  // 状态与「下一步」只看当前这一版评过没有：新版刚开出来时不能因为上一版评过就跳过评审
  const currentReviews = reviewsForVersion(data.versionCounts, project.version)
  const step = projectStep(project, currentReviews.count)
  const timingNote = template ? describeTiming(template.timing) : ''
  const versionRows = [
    {
      n: project.version,
      flowId: project.flowId,
      name: flow ? flow.name : '当前画布',
      archivedAt: '',
      available: Boolean(flow),
      nodes: flow ? flow.nodes : 0,
      current: true,
    },
    ...data.versions.map((item) => ({ ...item, current: false })),
  ].sort((a, b) => b.n - a.n)

  return (
    <div className="page vq-page vq-project-page">
      <button type="button" className="vq-project-back" onClick={onBack}>
        <ArrowLeft size={13} />
        全部作品
      </button>

      <PageHead
        kicker={
          <>
            <span>作品</span>
            <span className="vq-head-sep" aria-hidden="true">·</span>
            <span className="vq-mono">{project.id}</span>
            {project.version ? (
              <>
                <span className="vq-head-sep" aria-hidden="true">·</span>
                <span className="vq-mono">v{project.version}</span>
              </>
            ) : null}
          </>
        }
        title={
          renaming ? (
            <form
              className="vq-rename"
              onSubmit={(event) => {
                event.preventDefault()
                void saveTitle()
              }}
            >
              <input
                className="vq-rename-input"
                value={draftTitle}
                maxLength={80}
                autoFocus
                aria-label="作品名"
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(false)
                }}
              />
              <button type="submit" className="vq-button vq-button--primary" disabled={busy === 'title'}>
                保存
              </button>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => setRenaming(false)}>
                取消
              </button>
            </form>
          ) : (
            <span className="vq-title-edit">
              {project.title}
              <button type="button" className="vq-title-edit-btn" onClick={beginRename} aria-label="改作品名" title="改作品名">
                <Pencil size={14} />
              </button>
            </span>
          )
        }
        desc={
          <>
            <span className="vq-project-headline">
              <ProjectStatusPill project={project} reviewCount={currentReviews.count} />
              <span className="vq-mono">更新 {stamp(project.updatedAt)}</span>
              {template && template.title !== project.title ? <span className="vq-mono">模板 · {template.title}</span> : null}
            </span>
          </>
        }
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'vq-spin' : undefined} />
              刷新
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void toggleDone()} disabled={busy === 'done'}>
              {project.status === 'done' ? '重新打开' : '标记交付'}
            </button>
            <button type="button" className="vq-button vq-button--ghost is-danger" onClick={() => void remove()} disabled={busy === 'delete'}>
              <Trash2 size={14} />
              删除
            </button>
          </>
        }
      />

      <section className="vq-next vq-project-hero" aria-labelledby="vq-project-next">
        <div className="vq-next-main">
          <span className="vq-next-label">{step.label}</span>
          <h2 id="vq-project-next">{step.title}</h2>
          <p className="vq-project-hint">{step.hint}</p>
          <button
            type="button"
            className="vq-next-cta"
            disabled={busy === 'canvas'}
            onClick={() => {
              if (step.key === 'review') onOpenReview(project.id)
              else void openCanvas()
            }}
          >
            {busy === 'canvas' ? '正在生成画布…' : step.cta}
            <ArrowRight size={15} />
          </button>
        </div>
        <dl className="vq-next-stats">
          <div>
            <dt>脚本</dt>
            <dd>{template ? template.beats : 0}</dd>
          </div>
          <div>
            <dt>分镜</dt>
            <dd>{template ? template.shots : 0}</dd>
          </div>
          <div>
            <dt>评审</dt>
            <dd>{reviews.length}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{project.version ? 'v' + project.version : '—'}</dd>
          </div>
        </dl>
      </section>

      {project.version ? (
        <section className="vq-project-versions" aria-labelledby="vq-project-versions-head">
          <div className="vq-project-versions-head">
            <h2 id="vq-project-versions-head">
              版本对照
              <span className="vq-mono">{project.version} 版</span>
            </h2>
            <p className="vq-project-versions-note">旧版本的画布还能打开看，但再改它不会写回那一版：要改就在最新一版上改。</p>
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => void startVersion()}
              disabled={busy === 'version'}
            >
              <CopyPlus size={14} />
              {busy === 'version' ? '正在复制画布…' : '开一版新的'}
            </button>
          </div>
          <ol className="vq-version-list">
            {versionRows.map((row) => {
              const counter = reviewsForVersion(data.versionCounts, row.n)
              const verdict = VERDICT_LABEL[counter.lastVerdict] || ''
              return (
                <li className={'vq-version-row' + (row.current ? ' is-current' : '')} key={row.n}>
                  <span className="vq-version-n vq-mono">v{row.n}</span>
                  <div className="vq-version-main">
                    <strong>{row.name}</strong>
                    <span className="vq-version-meta">
                      <span className="vq-mono">{row.current ? '最新' : '归档 ' + stamp(row.archivedAt)}</span>
                      <span>{row.nodes} 节点</span>
                      <span>{counter.count ? counter.count + ' 次评审' : '未评审'}</span>
                      {verdict ? <span className={'vq-project-verdict is-' + counter.lastVerdict}>{verdict}</span> : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="vq-button vq-button--ghost vq-version-open"
                    onClick={() => onOpenFlow(row.flowId)}
                    disabled={!row.available}
                    title={row.available ? '在画布里打开 v' + row.n : '这一版的画布已被删除'}
                  >
                    {row.available ? '打开画布' : '画布已删除'}
                    {row.available ? <ArrowRight size={13} /> : null}
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      <div className="vq-project-body">
        <div className="vq-project-col">
          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>脚本大纲</h2>
              <span className="vq-mono">{template ? template.beats + ' 段' : '没有脚本'}</span>
            </div>
            {template && template.structure.length ? (
              <>
                {template.hook ? <p className="vq-project-hook">开头钩子 · {template.hook}</p> : null}
                <ol className="vq-beat-list">
                  {template.structure.map((beat, index) => (
                    <li key={index} className="vq-beat-row">
                      <span className="vq-mono vq-beat-index">{pad2(index + 1)}</span>
                      <div className="vq-beat-copy">
                        <span className="vq-beat-name">
                          {beat.beat}
                          <span className="vq-mono">
                            {beat.startSec ?? 0}–{beat.endSec ?? 0} 秒
                            {beat.expectedSec ? ' · 要念 ' + beat.expectedSec + ' 秒' : ''}
                          </span>
                        </span>
                        <p>{beat.voiceover || '（这段没有口播）'}</p>
                        {beat.onScreen ? <span className="vq-beat-onscreen">屏幕字 · {beat.onScreen}</span> : null}
                      </div>
                    </li>
                  ))}
                </ol>
                {timingNote ? <p className="vq-project-timing">{timingNote}</p> : null}
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>{template ? '这条模板还没解析出脚本' : '绑定的模板已被删除'}</strong>
                <span>脚本与分镜都在模板上：回模板库解析或改编一条，再回来这里就会跟上。</span>
                <button type="button" className="vq-button vq-button--ghost" onClick={onBrowseTemplates}>
                  去模板库
                  <ArrowRight size={13} />
                </button>
              </div>
            )}
          </section>

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>分镜</h2>
              <span className="vq-mono">{template ? template.shots + ' 镜' : '没有分镜'}</span>
            </div>
            {template && template.storyboard.length ? (
              <ol className="vq-shot-list">
                {template.storyboard.map((shot, index) => (
                  <li key={index} className="vq-shot-row">
                    <span className="vq-mono vq-shot-index">{pad2(shot.shotNo ?? index + 1)}</span>
                    <div className="vq-shot-copy">
                      <span className="vq-shot-head">
                        {shot.camera || '机位待定'}
                        <span className="vq-mono">{(shot.startSec ?? 0) + '–' + (shot.endSec ?? 0) + ' 秒'}</span>
                      </span>
                      <p>{shot.visual || '（画面待补）'}</p>
                      {shot.caption ? <span className="vq-shot-caption">字幕 · {shot.caption}</span> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="vq-project-empty">
                <strong>还没有分镜</strong>
                <span>分镜跟着模板走：解析一条原片，或在模板里改编出你自己的一版。</span>
              </div>
            )}
          </section>
        </div>

        <aside className="vq-project-side">
          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>画布</h2>
              <Workflow size={14} />
            </div>
            {flow ? (
              <>
                <strong className="vq-project-flow-name">{flow.name}</strong>
                <p className="vq-project-flow-meta vq-mono">
                  {flow.nodes} 个节点 · 更新 {stamp(flow.updatedAt)}
                </p>
                <button type="button" className="vq-button vq-button--primary vq-project-full" onClick={() => void openCanvas()}>
                  打开画布
                  <ArrowRight size={13} />
                </button>
              </>
            ) : (
              <div className="vq-project-empty">
                <strong>还没开画布</strong>
                <span>用这条模板生成一张画布草稿，脚本和分镜会带过去。</span>
                <button type="button" className="vq-button vq-button--ghost" onClick={() => void openCanvas()} disabled={busy === 'canvas'}>
                  <Clapperboard size={13} />
                  {busy === 'canvas' ? '生成中…' : '开画布'}
                </button>
              </div>
            )}
          </section>

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>评审</h2>
              <span className="vq-mono">{reviews.length ? reviews.length + ' 次' : '还没评过'}</span>
            </div>
            {reviews.length ? (
              <ul className="vq-project-reviews">
                {reviews.map((review) => (
                  <li key={review.id}>
                    <div className="vq-project-review-flags">
                      <span className={'vq-project-verdict is-' + (review.verdict || 'none')}>
                        {VERDICT_LABEL[review.verdict] || '未记录'}
                      </span>
                      {review.version ? (
                        <span className="vq-mono vq-project-review-version">v{review.version}</span>
                      ) : null}
                    </div>
                    <div>
                      <p>{review.summary || review.intent || '这次评审没有留下结论摘要'}</p>
                      <span className="vq-mono">{stamp(review.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="vq-project-empty">
                <strong>这一版还没进评审</strong>
                <span>拿你这一版的画面跑一次视觉评审，结论会记在这条作品下。</span>
              </div>
            )}
            <button type="button" className="vq-button vq-button--ghost vq-project-full" onClick={() => onOpenReview(project.id)}>
              <ScanEye size={13} />
              {currentReviews.count ? '再评一次' : '用评审看这版'}
            </button>
          </section>

          <section className="vq-project-panel">
            <div className="vq-project-panel-head">
              <h2>来源</h2>
              <span className="vq-mono">{template ? KIND_LABEL[template.kind] || template.kind : '—'}</span>
            </div>
            {template ? (
              <dl className="vq-project-source">
                <div>
                  <dt>模板</dt>
                  <dd>{template.title}</dd>
                </div>
                <div>
                  <dt>内容类型</dt>
                  <dd>{template.contentType || '—'}</dd>
                </div>
                <div>
                  <dt>原片时长</dt>
                  <dd className="vq-mono">{seconds(template.durationSec)}</dd>
                </div>
                <div>
                  <dt>复用</dt>
                  <dd className="vq-mono">{template.reuseCount} 次</dd>
                </div>
              </dl>
            ) : (
              <p className="vq-project-note">绑定的模板已被删除；作品本身还在，画布与评审不受影响。</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
