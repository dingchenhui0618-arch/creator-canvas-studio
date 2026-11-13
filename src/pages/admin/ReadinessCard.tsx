// 上线就绪（v0.9.67）：六道门一屏看清，每一行都说「缺什么」与「去哪填」。
// 数字全部来自 /api/admin/readiness 现算（邮件通道、告警通道、备份、档位、额度、公示信息），
// 这里不做二次推断：后端说 ready 才显示就绪，说 todo 就显示未配。
import { useApi } from './data'
import { Badge, LoadingLine, SourceTag } from './ui'

type GateState = 'ready' | 'partial' | 'todo'

type ReadinessGate = {
  key: string
  label: string
  state: GateState
  summary: string
  action: { label: string; section: string }
}

type Readiness = {
  ok: boolean
  checkedAt: string
  gates: ReadinessGate[]
  totals: { total: number; ready: number; partial: number; todo: number }
  verdict: 'ready' | 'not-ready'
  verdictText: string
}

const STATE_LABEL: Record<GateState, string> = { ready: '就绪', partial: '一半', todo: '未配' }
const STATE_TONE = { ready: 'ok', partial: 'warn', todo: 'fail' } as const

export default function ReadinessCard() {
  const { data, error, loading } = useApi<Readiness>('/api/admin/readiness')

  return (
    <section className="admin-card admin-block admin-block--readiness">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">上线就绪</p>
          <p className="admin-sub">
            对外收费前要过的六道门。每一项都来自当前真实配置：没有的写「未配」，不估算、不假装；点右边按钮直接去填。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/readiness" />
          {data ? (
            <Badge tone={data.verdict === 'ready' ? 'ok' : data.totals.todo ? 'warn' : 'neutral'}>
              {data.verdictText}
            </Badge>
          ) : null}
        </div>
      </div>

      {loading && !data ? <LoadingLine label="/api/admin/readiness" /> : null}
      {error ? <p className="admin-hint">读取失败：{error}</p> : null}

      {data ? (
        <>
          <div className="admin-readiness">
            {data.gates.map((gate) => (
              <div className="admin-readiness-row" key={gate.key} data-state={gate.state}>
                <span className="admin-readiness-dot" aria-hidden="true" />
                <span className="admin-readiness-name">
                  {gate.label}
                  <Badge tone={STATE_TONE[gate.state]}>{STATE_LABEL[gate.state]}</Badge>
                </span>
                <span className="admin-readiness-note">{gate.summary}</span>
                <a className="vq-button vq-button--ghost" href={'#/admin/' + gate.action.section}>
                  {gate.action.label}
                </a>
              </div>
            ))}
          </div>
          <p className="admin-hint">
            就绪 {data.totals.ready} / {data.totals.total}；「一半」表示机制已经有了、还缺一个数或一条通道。
            {data.verdict === 'ready' ? '六项都齐，可以对外收费。' : '六项没齐之前，这一屏不会说「可以收费了」。'}
          </p>
        </>
      ) : null}
    </section>
  )
}
