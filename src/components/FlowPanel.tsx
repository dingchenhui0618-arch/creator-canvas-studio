import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Loader2, Plus, Workflow } from 'lucide-react'
import { createFlow, listFlows, type ApiFlow } from '../api/flows'

/**
 * 快捷创作里的「工作流」页签（r256）。
 *
 * 为什么要有它：工作流以前只在侧栏有一个入口，点进去是一张画布，和「这次创作」看不到关系——
 * 用户的原话是「跟快捷创作联动起来才有意义，别让它变成孤零零一个独立页」。
 * 这里把「你手上的工作流」摊在创作入口旁边：几条、几步、上次什么时候跑过、挂在哪条作品上，
 * 点一行就进那张画布；没有就地从这里新建一张，或者空着从作品 / 模板起手。
 *
 * 只读元数据，不跑流程、不扣积分：真正跑仍在工作流页里按次计费。
 */
function flowMeta(flow: ApiFlow): string {
  const nodes = flow.nodes?.length ?? 0
  const edges = flow.edges?.length ?? 0
  const parts = [nodes + ' 步', edges + ' 条连线']
  if (flow.project?.title) return parts.join(' · ') + ' · 在帮《' + flow.project.title + '》'
  return parts.join(' · ')
}

function flowWhen(flow: ApiFlow): string {
  if (flow.runCount > 0 && flow.lastRunAt) {
    const at = new Date(flow.lastRunAt)
    if (Number.isFinite(at.getTime())) {
      const pad = (value: number) => String(value).padStart(2, '0')
      return '跑过 ' + flow.runCount + ' 次 · 最近 ' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
    }
    return '跑过 ' + flow.runCount + ' 次'
  }
  return '还没跑过'
}

export function FlowPanel({
  onOpenFlow,
  onToast,
}: {
  onOpenFlow: (flowId: string) => void
  onToast?: (message: string) => void
}) {
  const [flows, setFlows] = useState<ApiFlow[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  // 状态只在请求回来之后落（不在 effect 里同步 setState）：一进页签先读一次列表
  const load = useCallback(
    () =>
      listFlows()
        .then((list) => {
          setFlows(list)
          setError('')
        })
        .catch((caught: unknown) => {
          setFlows([])
          setError(caught instanceof Error ? caught.message : '读取失败')
        }),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const createNew = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
      onOpenFlow(created.id)
    } catch (caught) {
      onToast?.('没建成：' + (caught instanceof Error ? caught.message : String(caught)))
    } finally {
      setCreating(false)
    }
  }, [creating, onOpenFlow, onToast])

  const sorted = (flows ?? []).slice().sort((left, right) => {
    const a = left.lastRunAt ? new Date(left.lastRunAt).getTime() : new Date(left.updatedAt).getTime()
    const b = right.lastRunAt ? new Date(right.lastRunAt).getTime() : new Date(right.updatedAt).getTime()
    return b - a
  })

  return (
    <section className="agx-flowpanel" aria-label="工作流">
      <header className="agx-flowpanel-head">
        <span className="agx-flowpanel-icon" aria-hidden>
          <Workflow size={16} strokeWidth={1.6} />
        </span>
        <div className="agx-flowpanel-copy">
          <strong>工作流是这条创作的做法</strong>
          <p>按顺序排好的几步：素材 → 脚本 → 出图 → 评审。跑完的结果会回到「作品」里。</p>
        </div>
        <button
          type="button"
          className="vq-button vq-button--ghost agx-flowpanel-new"
          onClick={() => void createNew()}
          disabled={creating}
        >
          {creating ? <Loader2 size={13} className="agx-flowpanel-spin" /> : <Plus size={13} />}
          {creating ? '创建中' : '新建'}
        </button>
      </header>

      {error ? (
        <p className="agx-flowpanel-error" role="alert">
          读不到工作流列表：{error}
        </p>
      ) : null}

      {flows === null ? (
        <p className="agx-flowpanel-empty">正在读取工作流…</p>
      ) : sorted.length === 0 ? (
        <div className="agx-flowpanel-empty">
          <p>还没有工作流。可以从一件作品或一条模板起手，也可以从空白开始。</p>
          <button type="button" className="vq-button vq-button--ghost" onClick={() => onOpenFlow('')}>
            去工作流页起手
          </button>
        </div>
      ) : (
        <ul className="agx-flowpanel-list">
          {sorted.map((flow) => (
            <li key={flow.id}>
              <button type="button" className="agx-flowpanel-row" onClick={() => onOpenFlow(flow.id)}>
                <span className="agx-flowpanel-name">{flow.name || '未命名流程'}</span>
                <span className="agx-flowpanel-meta">{flowMeta(flow)}</span>
                <span className="agx-flowpanel-when">{flowWhen(flow)}</span>
                <ArrowUpRight size={14} className="agx-flowpanel-go" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="agx-flowpanel-note">这里只列你自己的工作流；打开不扣积分，跑一次才按次计费。</p>
    </section>
  )
}
