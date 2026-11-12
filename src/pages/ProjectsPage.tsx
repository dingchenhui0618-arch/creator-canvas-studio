import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Clapperboard, RefreshCw } from 'lucide-react'
import PageHead from '../components/PageHead'
import ProjectStatusPill from '../components/ProjectStatus'
import { listProjects } from '../api/projects'
import { reviewsForVersion, type ProjectShareBrief, type ProjectSummary } from '../domain/project'
import { CLIENT_LABEL, stampTime } from '../domain/share'
import '../styles/projects.css'

const pad2 = (value: number) => String(value).padStart(2, '0')

function updatedLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  return sameDay ? '今天 ' + time : pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + time
}

/**
 * 卡片上的分享状态只说三件事：还在不在分享、打开过几次、最近一次什么时候。
 * 详细到每一轮的记录在作品页的分享面板里，卡片上不铺开。
 */
function shareHint(share: ProjectShareBrief): string {
  const rounds = share.rounds > 1 ? '共 ' + share.rounds + ' 轮链接' : '一条链接'
  if (!share.opens) return rounds + (share.live ? '，还没人打开' : '，停用前没人打开')
  const client = CLIENT_LABEL[share.lastClient] || '未知设备'
  const when = share.lastAt ? '，最近一次 ' + stampTime(share.lastAt) + '（' + client + '）' : ''
  return rounds + '，打开 ' + share.opens + ' 次' + when
}

/**
 * 作品列表：一条内容一条记录。
 * 列表只回答「做到哪一步」——脚本和分镜的段数、评审次数、最后一次改动；
 * 打开某一项才进作品页看脚本、画布与评审结论。
 */
export default function ProjectsPage({
  onOpenProject,
  onBrowseTemplates,
}: {
  onOpenProject: (id: string) => void
  onBrowseTemplates: () => void
}) {
  const [items, setItems] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listProjects()
      setItems(data.items)
    } catch (caught) {
      setItems([])
      setError(caught instanceof Error ? caught.message : '作品列表读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  return (
    <div className="page vq-page">
      <PageHead
        kicker="作品 / PROJECTS"
        title={loading && !items.length ? '正在读取…' : '作品'}
        desc="一条内容一条记录：用的是哪条模板、开的哪块画布、评审过几次都挂在这里。脚本与分镜仍然在模板上，改模板作品跟着变，不会留一份过期副本。"
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'vq-spin' : undefined} />
              刷新
            </button>
            <button type="button" className="vq-button vq-button--primary" onClick={onBrowseTemplates}>
              <Clapperboard size={14} />
              从模板开始
            </button>
          </>
        }
      />

      {error ? (
        <p className="vq-note vq-note--error" role="status">
          {error}
        </p>
      ) : null}

      {!loading && !error && !items.length ? (
        <div className="vq-empty vq-projects-empty">
          <strong>还没有作品</strong>
          <span>作品要从一条拆好的模板开始：在模板库挑一条，点「用它做作品」，脚本和分镜会跟着进这条作品。</span>
          <button type="button" className="vq-button vq-button--primary" onClick={onBrowseTemplates}>
            去模板库挑一条
            <ArrowRight size={13} />
          </button>
        </div>
      ) : null}

      {items.length ? (
        <div className="vq-projects-grid">
          {items.map((item) => (
            <button type="button" className="vq-project-card" key={item.id} onClick={() => onOpenProject(item.id)}>
              <span className="vq-project-card-head">
                <span className="vq-project-card-tags">
                  <ProjectStatusPill project={item} reviewCount={reviewsForVersion(item.versionCounts || {}, item.version).count} />
                  {item.share ? (
                    <span className={'vq-project-share' + (item.share.live ? ' is-live' : '')} title={shareHint(item.share)}>
                      {item.share.live ? <span className="vq-project-share-dot" aria-hidden="true" /> : null}
                      {item.share.live ? '分享中' : '已停用'}
                    </span>
                  ) : null}
                  {item.version > 1 ? <span className="vq-project-card-version vq-mono">v{item.version}</span> : null}
                </span>
                <span className="vq-mono">{updatedLabel(item.updatedAt)}</span>
              </span>
              <strong className="vq-project-card-title">{item.title}</strong>
              {item.template ? (
                // 作品标题默认就是模板标题：两者一样时不再重复一遍，只保留真正多出来的信息
                item.template.title !== item.title ? <span className="vq-project-card-source">模板 · {item.template.title}</span> : null
              ) : (
                <span className="vq-project-card-source">绑定的模板已删除</span>
              )}
              <span className="vq-project-card-meta">
                <span>
                  <em>脚本</em>
                  <b>{item.template ? item.template.beats + ' 段' : '—'}</b>
                </span>
                <span>
                  <em>分镜</em>
                  <b>{item.template ? item.template.shots + ' 镜' : '—'}</b>
                </span>
                <span>
                  <em>评审</em>
                  <b>{item.reviews.count ? item.reviews.count + ' 次' : '—'}</b>
                </span>
                <span>
                  <em>运行</em>
                  <b>{item.runs?.count ? item.runs.count + ' 次' : '—'}</b>
                </span>
                <span>
                  <em>打开</em>
                  <b>{item.share?.opens ? item.share.opens + ' 次' : '—'}</b>
                </span>
              </span>
              <span className="vq-project-card-go">
                打开作品
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
