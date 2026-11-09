import { useApi, type Health, type RunsResponse, type TemplatesResponse } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

export default function OverviewSection() {
  const health = useApi<Health>('/api/health')
  const templates = useApi<TemplatesResponse>('/api/templates')
  const runs = useApi<RunsResponse>('/api/runs')

  const errors = [
    health.error ? `GET /api/health：${health.error}` : '',
    templates.error ? `GET /api/templates：${templates.error}` : '',
    runs.error ? `GET /api/runs：${runs.error}` : '',
  ].filter(Boolean)

  const retryAll = () => {
    health.reload()
    templates.reload()
    runs.reload()
  }

  const busy = health.loading || templates.loading || runs.loading

  return (
    <>
      <AdminHead
        kicker="ADMIN / OVERVIEW"
        title="后台总览"
        description="用户、模板、运行与依赖的实时汇总。每个数字都标注来源，不混用演示数据与真实接口。"
        actions={<RefreshButton onClick={retryAll} busy={busy} />}
      />

      {errors.length ? <ErrorBanner message={errors.join('；')} onRetry={retryAll} /> : null}

      <div className="admin-grid admin-grid--stats">
        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">用户数</span>
            <SourceTag kind="local" source="data/auth.db（SQLite 用户表）" />
          </div>
          <p className="admin-value">—</p>
          <p className="admin-foot">
            账号已落库（data/auth.db，SQLite），但还没有管理员用户列表接口，所以这里不给数字。
          </p>
        </article>

        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">模板数</span>
            <SourceTag kind="api" source="GET /api/templates" />
          </div>
          <p className="admin-value">
            {templates.loading ? '—' : (templates.data?.items.length ?? '—')}
          </p>
          <p className="admin-foot">来自模板库实际条目，含 AI 入库与复用来源。</p>
        </article>

        <article className="admin-card admin-stat">
          <div className="admin-stat-top">
            <span className="admin-label">运行数</span>
            <SourceTag kind="api" source="GET /api/runs" />
          </div>
          <p className="admin-value">{runs.loading ? '—' : (runs.data?.total ?? '—')}</p>
          <p className="admin-foot">画布流程实际运行记录总数，按服务端返回计。</p>
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
            {health.data ? `视觉模型 ${health.data.visionModel || '—'}` : '等待 /api/health 返回。'}
          </p>
        </article>
      </div>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">依赖明细</p>
            <p className="admin-sub">GET /api/health 的原始字段，不做推断。</p>
          </div>
          <SourceTag kind="api" source="GET /api/health" />
        </div>

        {health.loading && !health.data ? <LoadingLine label="/api/health" /> : null}

        {health.data ? (
          <dl className="admin-kv">
            <div>
              <dt>红狐检索</dt>
              <dd>
                <Badge tone={health.data.redfox ? 'ok' : 'warn'}>
                  {health.data.redfox ? '已配置' : '未配置'}
                </Badge>
                <span className="admin-mono">health.redfox = {String(health.data.redfox)}</span>
              </dd>
            </div>
            <div>
              <dt>视觉模型</dt>
              <dd>
                <Badge tone={health.data.vision ? 'ok' : 'warn'}>
                  {health.data.vision ? '已配置' : '未配置'}
                </Badge>
                <span className="admin-mono">{health.data.visionModel || '—'}</span>
              </dd>
            </div>
            <div>
              <dt>模板统计</dt>
              <dd>
                <span className="admin-mono">{health.data.templates} 条</span>
                <span>health.templates，与模板列表数量一致。</span>
              </dd>
            </div>
            <div>
              <dt>API 健康</dt>
              <dd>
                <Badge tone={health.data.ok ? 'ok' : 'fail'}>{health.data.ok ? '正常' : '异常'}</Badge>
                <span>health.ok = {String(health.data.ok)}</span>
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="admin-note">
        <p>说明</p>
        <ul>
          <li>账号已落库到 <code>data/auth.db</code>，但本页还没接用户列表接口，所以只展示当前会话。</li>
          <li>模板数、运行数、依赖状态分别来自 <code>/api/templates</code>、<code>/api/runs</code>、<code>/api/health</code>。</li>
          <li>health 接口只暴露「是否配置」布尔值；红狐未配置时检索会回退示例数据，界面上会明确标注。</li>
        </ul>
      </section>
    </>
  )
}
