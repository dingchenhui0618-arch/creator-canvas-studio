import { useState } from 'react'
import docUrl from '../../../docs/replication-pipeline.md?url'
import { useApi, type Health } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

const DOC_PATH = 'docs/replication-pipeline.md'

export default function KeysSection() {
  const health = useApi<Health>('/api/health')
  const [copied, setCopied] = useState('')

  const copyDocPath = async () => {
    try {
      await navigator.clipboard.writeText(DOC_PATH)
      setCopied('已复制路径')
    } catch {
      setCopied('复制失败，请手动选择路径')
    }
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / KEYS"
        title="模型与密钥"
        description="只读状态视图：只发起 /api/health 请求，不读取、不展示任何密钥值，也不向外部模型发起调用。"
        actions={<RefreshButton onClick={health.reload} busy={health.loading} />}
      />

      {health.error ? <ErrorBanner message={`GET /api/health：${health.error}`} onRetry={health.reload} /> : null}
      {health.loading && !health.data ? <LoadingLine label="/api/health" /> : null}

      {health.data ? (
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">配置状态</p>
              <p className="admin-sub">服务端只返回布尔值；本页不接触 .env 内容。</p>
            </div>
            <SourceTag kind="api" source="GET /api/health" />
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>能力</th>
                  <th>配置</th>
                  <th>可用状态</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>红狐检索</strong>
                    <span className="admin-cell-sub">RedFox · 抖音 / 小红书素材</span>
                  </td>
                  <td>
                    <Badge tone={health.data.redfox ? 'ok' : 'warn'}>
                      {health.data.redfox ? '已配置' : '未配置'}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone="neutral">调用时才知道</Badge>
                    <span className="admin-cell-sub">
                      配额、频控与 Key 状态由红狐侧决定；调用失败会回退示例数据并标注。
                    </span>
                  </td>
                  <td className="admin-mono">/api/health → redfox={String(health.data.redfox)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>视觉模型</strong>
                    <span className="admin-cell-sub">Vision · 截图评审与模板解析</span>
                  </td>
                  <td>
                    <Badge tone={health.data.vision ? 'ok' : 'warn'}>
                      {health.data.vision ? '已配置' : '未配置'}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone="neutral">已配置 · 未调用验证</Badge>
                    <span className="admin-cell-sub">health 只证明配置存在，本页不发起模型请求。</span>
                  </td>
                  <td className="admin-mono">
                    /api/health → vision={String(health.data.vision)} · {health.data.visionModel || '—'}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>模板库</strong>
                    <span className="admin-cell-sub">本地 JSON + 抽帧目录</span>
                  </td>
                  <td>
                    <Badge tone="ok">可用</Badge>
                  </td>
                  <td>
                    <span className="admin-mono">{health.data.templates} 条</span>
                  </td>
                  <td className="admin-mono">/api/health → templates</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="admin-hint">
            health 只回答「有没有配置」，不回答「调用是否成功」。红狐 Key 被禁用（3105）或积分不足时，检索接口会返回示例数据并在界面上标注，不冒充真实结果。
          </p>
        </section>
      ) : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">配置文档</p>
            <p className="admin-sub">环境变量、频控与 3105 的说明都在仓库文档里；页面只给路径，不展示值。</p>
          </div>
          <SourceTag kind="local" source="docs/replication-pipeline.md" />
        </div>

        <div className="admin-doc-row">
          <code>{DOC_PATH}</code>
          <div className="admin-doc-actions">
            <button type="button" className="admin-btn admin-btn--ghost" onClick={copyDocPath}>
              复制路径
            </button>
            <a className="admin-btn admin-btn--ghost" href={docUrl} target="_blank" rel="noreferrer">
              打开文档
            </a>
          </div>
        </div>
        {copied ? <p className="admin-hint">{copied}</p> : null}
        <p className="admin-hint">
          文档对应 <code>.env</code> 里的红狐与视觉模型配置；链接指向构建时的文档副本，修改文档后需重新构建才会更新。
        </p>
      </section>

      <section className="admin-note">
        <p>边界</p>
        <ul>
          <li>不请求红狐接口、不调用视觉模型，避免用一次真实调用去「证明」状态。</li>
          <li>不展示任何 key 值，也不展示脱敏片段；只显示「已配置 / 未配置」。</li>
          <li>3105 与频控说明以服务端实现为准，页面不把它包装成「已是最新」之类的假状态。</li>
        </ul>
      </section>
    </>
  )
}
