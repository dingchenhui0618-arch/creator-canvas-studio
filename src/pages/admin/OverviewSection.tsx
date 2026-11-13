import { useUiMode } from '../../api/app'
import { useApi, type Health, type RunsResponse, type TemplatesResponse } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import ReadinessCard from './ReadinessCard'

export default function OverviewSection() {
  const health = useApi<Health>('/api/health')
  const templates = useApi<TemplatesResponse>('/api/templates')
  const runs = useApi<RunsResponse>('/api/runs')
  const users = useApi<{ items: { id: string }[]; total: number }>('/api/admin/users')
  const { internal } = useUiMode()

  const errors = [
    health.error ? `GET /api/health：${health.error}` : '',
    templates.error ? `GET /api/templates：${templates.error}` : '',
    runs.error ? `GET /api/runs：${runs.error}` : '',
    users.error ? `GET /api/admin/users：${users.error}` : '',
  ].filter(Boolean)

  const retryAll = () => {
    health.reload()
    templates.reload()
    runs.reload()
    users.reload()
  }

  const busy = health.loading || templates.loading || runs.loading || users.loading

  return (
    <>
      <AdminHead
        kicker="ADMIN / OVERVIEW"
        title="后台总览"
        description={internal ? '用户、模板、运行与依赖的实时汇总。每个数字都标注来源，不混用演示数据与真实接口。' : '用户、模板、运行与依赖的实时汇总；没有数据的区块写空状态，不放示例数字。'}
        actions={<RefreshButton onClick={retryAll} busy={busy} />}
      />

      {errors.length ? <ErrorBanner message={errors.join('；')} onRetry={retryAll} /> : null}

      <div className="admin-grid admin-grid--stats">
        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">用户数</span>
            <SourceTag kind="api" source="GET /api/admin/users" />
          </div>
          <p className="admin-value">{users.loading ? '—' : (users.data?.total ?? '—')}</p>
          <p className="admin-foot">{internal ? '真实账号表（含积分余额），不是示例数字。' : '账号列表（含积分余额），不是示例数字。'}</p>
        </article>

        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">模板数</span>
            <SourceTag kind="api" source="GET /api/templates" />
          </div>
          <p className="admin-value">
            {templates.loading ? '—' : (templates.data?.total ?? templates.data?.items.length ?? '—')}
          </p>
          <p className="admin-foot">来自模板库实际条目，含 AI 入库与复用来源。</p>
        </article>

        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">运行数</span>
            <SourceTag kind="api" source="GET /api/runs" />
          </div>
          <p className="admin-value">{runs.loading ? '—' : (runs.data?.total ?? '—')}</p>
          <p className="admin-foot">{internal ? '画布流程实际运行记录总数，按服务端返回计。' : '画布流程的实际运行记录总数。'}</p>
        </article>

        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">依赖状态</span>
            <SourceTag kind="api" source="GET /api/health" />
          </div>
          <p className="admin-value admin-value--text">
            {health.loading ? '检查中' : health.data?.vision ? '已配置' : '未配置'}
          </p>
          <p className="admin-foot">
            {health.data ? (health.data.vision ? '视觉模型已接入' : '视觉模型未接入') : '正在检查。'}
          </p>
        </article>
      </div>

      <ReadinessCard />

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">依赖明细</p>
            <p className="admin-sub">{internal ? 'GET /api/health 的原始字段，不做推断。' : '依赖检查的原始结果，不做推断。'}</p>
          </div>
          <SourceTag kind="api" source="GET /api/health" />
        </div>

        {health.loading && !health.data ? <LoadingLine label="/api/health" /> : null}

        {health.data ? (
          <dl className="admin-kv">
            <div>
              <dt>检索服务</dt>
              <dd>
                <Badge tone={health.data.redfox ? 'ok' : 'warn'}>
                  {health.data.redfox ? '已配置' : '未配置'}
                </Badge>
                <span>{internal ? '检索服务由服务端配置，这里只报状态。' : '检索服务由平台统一维护，这里只报状态。'}</span>
              </dd>
            </div>
            <div>
              <dt>视觉模型</dt>
              <dd>
                <Badge tone={health.data.vision ? 'ok' : 'warn'}>
                  {health.data.vision ? '已配置' : '未配置'}
                </Badge>
                <span>{internal ? '模型标识与地址在「模型 Key」页，需要时再展开技术详情。' : '模型由平台统一维护；需要时联系维护人员。'}</span>
              </dd>
            </div>
            <div>
              <dt>模板统计</dt>
              <dd>
                <span className="admin-mono">{health.data.templates} 条</span>
                <span>{internal ? 'health.templates，与模板列表数量一致。' : '与模板库条目数一致。'}</span>
              </dd>
            </div>
            <div>
              <dt>API 健康</dt>
              <dd>
                <Badge tone={health.data.ok ? 'ok' : 'fail'}>{health.data.ok ? '正常' : '异常'}</Badge>
                <span>{internal ? 'health.ok = ' + String(health.data.ok) : '健康检查结果'}</span>
              </dd>
            </div>
            {internal ? (
              <div>
                <dt>运行环境</dt>
                <dd>
                  <Badge tone="neutral">内部测试</Badge>
                  <span className="admin-mono">VQ_UI_MODE=internal · 仅内部环境展示技术字段</span>
                </dd>
              </div>
            ) : null}
            {internal && health.data.llmModel ? (
              <div>
                <dt>文本模型</dt>
                <dd>
                  <span className="admin-mono">{health.data.llmModel}</span>
                  <span>health.llmModel</span>
                </dd>
              </div>
            ) : null}
            {internal && health.data.visionModel ? (
              <div>
                <dt>视觉模型</dt>
                <dd>
                  <span className="admin-mono">{health.data.visionModel}</span>
                  <span>health.visionModel</span>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>

      <section className="admin-note">
        <p>说明</p>
        <ul>
          {internal ? (
            <>
              <li>用户数来自 <code>/api/admin/users</code> 的真实账号表，模板数与运行数分别来自 <code>/api/templates</code>、<code>/api/runs</code>。</li>
              <li>依赖状态来自 <code>/api/health</code>；检索服务未接入时雷达会回退示例数据并明确标注。</li>
              <li>生产环境只展示状态；模型标识、上游地址与环境变量清单只在内部测试环境（<code>VQ_UI_MODE=internal</code>）展示。</li>
            </>
          ) : (
            <>
              <li>用户数来自真实账号表，模板数与运行数是模板库、运行记录的实际条目数。</li>
              <li>依赖状态来自实时检查；检索服务不可用时，雷达会明确标注结果来源。</li>
              <li>模型、检索与算力都由平台统一维护，这里只展示是否可用。</li>
            </>
          )}
        </ul>
      </section>
    </>
  )
}
