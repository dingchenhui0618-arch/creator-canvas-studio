import { useState } from 'react'
import docUrl from '../../../docs/replication-pipeline.md?url'
import { request } from '../../api/client'
import { useApi } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

const DOC_PATH = 'docs/replication-pipeline.md'

type ProviderConfig = {
  ok: boolean
  vision: {
    enabled: boolean
    baseUrl: string
    model: string
    models: string[]
    fallbacks: string[]
    apiKeyMasked: string
    timeoutMs: number
  }
  llm: { enabled: boolean; model: string; fallbacks: string[] }
  redfox: { enabled: boolean; baseUrl: string; apiKeyMasked: string; source: string }
  remote: { enabled: boolean; label: string }
  limits: { maxVideoMb: number; maxFrames: number }
  envKeys: { key: string; purpose: string; current: string }[]
}

type Probe = { ok: boolean; status?: number; count?: number; models?: string[]; error?: string }

export default function KeysSection() {
  const config = useApi<ProviderConfig>('/api/config')
  const [probe, setProbe] = useState<Probe | null>(null)
  const [probing, setProbing] = useState(false)
  const [copied, setCopied] = useState('')
  // 默认只露产品口径（VisionQA 模型 / 检索服务），真实模型 ID、上游地址与环境变量值收进「技术详情」
  const [showTech, setShowTech] = useState(false)

  const copyDocPath = async () => {
    try {
      await navigator.clipboard.writeText(DOC_PATH)
      setCopied('已复制路径')
    } catch {
      setCopied('复制失败，请手动选择路径')
    }
  }

  const runProbe = async () => {
    setProbing(true)
    setProbe(null)
    try {
      const result = await request<Probe>('/api/config/probe', { method: 'POST' })
      setProbe(result)
    } catch (cause) {
      setProbe({ ok: false, error: cause instanceof Error ? cause.message : '探测失败' })
    } finally {
      setProbing(false)
    }
  }

  const data = config.data

  return (
    <>
      <AdminHead
        kicker="ADMIN / KEYS"
        title="模型与密钥"
        description="读服务端当前生效的配置：模型、地址、凭证末四位。凭证值本身永不下发，只回答「配了没有、几位」。"
        actions={
          <div className="admin-doc-actions">
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => setShowTech((value) => !value)}
              aria-pressed={showTech}
            >
              {showTech ? '隐藏技术详情' : '显示技术详情'}
            </button>
            <RefreshButton onClick={config.reload} busy={config.loading} />
          </div>
        }
      />

      {config.error ? <ErrorBanner message={`GET /api/config：${config.error}`} onRetry={config.reload} /> : null}
      {config.loading && !data ? <LoadingLine label="/api/config" /> : null}

      {data ? (
        <>
          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">当前生效的接入</p>
                <p className="admin-sub">
                  文本与视觉分开配置：便宜的快模型能聊天，但它看不了图，抽帧评审必须走多模态模型。
                  「已配置」只说明服务端拿到了凭证，能不能通信要看下面的自检。
                </p>
              </div>
              <SourceTag kind="api" source="GET /api/config" />
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>能力</th>
                    <th>状态</th>
                    <th>当前配置</th>
                    <th>凭证</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>文本模型</strong>
                      <span className="admin-cell-sub">智能体对话、模板标题、画布节点</span>
                    </td>
                    <td>
                      <Badge tone={data.llm.enabled ? 'ok' : 'warn'}>{data.llm.enabled ? '已配置' : '未配置'}</Badge>
                    </td>
                    <td className="admin-mono">{showTech ? data.llm.model : 'VisionQA 通用模型'}</td>
                    <td className="admin-mono">与视觉共用同一把 key</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>多模态模型</strong>
                      <span className="admin-cell-sub">抽帧评审 / 模板解析（要能读图）</span>
                    </td>
                    <td>
                      <Badge tone={data.vision.enabled ? 'ok' : 'warn'}>{data.vision.enabled ? '已配置' : '未配置'}</Badge>
                    </td>
                    <td className="admin-mono">
                      {showTech ? data.vision.model : 'VisionQA 视觉模型'}
                      <span className="admin-cell-sub">{showTech ? data.vision.baseUrl : '地址与模型标识由服务端维护'}</span>
                    </td>
                    <td className="admin-mono">{data.vision.apiKeyMasked || '—'}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>检索服务</strong>
                      <span className="admin-cell-sub">抖音 / 小红书真实素材</span>
                    </td>
                    <td>
                      <Badge tone={data.redfox.enabled ? 'ok' : 'warn'}>{data.redfox.enabled ? '已配置' : '未配置'}</Badge>
                    </td>
                    <td className="admin-mono">{showTech ? data.redfox.baseUrl : '已配置（地址由服务端维护）'}</td>
                    <td className="admin-mono">{data.redfox.apiKeyMasked || '—'}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>远端算力</strong>
                      <span className="admin-cell-sub">解析 / 抽帧是否交给远端</span>
                    </td>
                    <td>
                      <Badge tone={data.remote.enabled ? 'ok' : 'neutral'}>{data.remote.enabled ? '已接入' : '本机执行'}</Badge>
                    </td>
                    <td className="admin-mono">{data.remote.enabled ? data.remote.label : '本机 ffmpeg'}</td>
                    <td className="admin-mono">上限 {data.limits.maxVideoMb} MB / {data.limits.maxFrames} 帧</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="admin-doc-actions">
              <button type="button" className="admin-btn admin-btn--ghost" onClick={runProbe} disabled={probing || !data.vision.enabled}>
                {probing ? '探测中…' : '连通性自检'}
              </button>
              {probe ? (
                <Badge tone={probe.ok ? 'ok' : 'fail'}>
                  {probe.ok
                    ? `可用 · 上游 ${probe.count ?? 0} 个模型`
                    : `不可用${probe.status ? ' · HTTP ' + probe.status : ''}${probe.error ? ' · ' + probe.error : ''}`}
                </Badge>
              ) : null}
            </div>
            <p className="admin-hint">
              自检只请求上游 <code>/models</code>（列模型，不产生推理费用），用真实 key 判断「现在通不通」，不把配置存在当成可用。
            </p>
          </section>

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">接入清单</p>
                <p className="admin-sub">再接一把 key 就是改这里的一行，重启服务生效，代码里没有第二处要改。</p>
              </div>
              <SourceTag kind="local" source={DOC_PATH} />
            </div>

            {showTech ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>环境变量</th>
                      <th>用途</th>
                      <th>当前值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.envKeys.map((item) => (
                      <tr key={item.key}>
                        <td className="admin-mono">{item.key}</td>
                        <td>{item.purpose}</td>
                        <td className="admin-mono">{item.current || <span className="admin-cell-sub">未设置</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-hint">
                共 {data.envKeys.length} 项环境变量，含模型与检索服务的技术标识；默认不展示，点右上角「显示技术详情」可查看完整清单与当前值。
              </p>
            )}

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
              改完 .env 执行 <code>sudo systemctl restart visionqa</code>；模型下拉框读 <code>/api/models</code>，清单变化会自动出现。
            </p>
          </section>
        </>
      ) : null}
    </>
  )
}
