import { useUiMode } from '../../api/app'
import { formatDateTime, formatDuration, useApi, type BdcPort, type BdcStatus, type VersionInfo } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type StorageItem = { name: string; bytes: number; files: number }
type StorageInfo = {
  ok: boolean
  dataDir: string
  bytes: number
  files: number
  items: StorageItem[]
  disk: { totalBytes: number; freeBytes: number } | null
  checkedAt: string
}

type DiagnosticsInfo = {
  ok: boolean
  mode: string
  generatedAt: string
  package: { name: string; version: string }
  process: {
    pid: number
    node: string
    platform: string
    startedAt: string
    uptimeSec: number
    memoryMb: { rss: number; heapUsed: number; heapTotal: number; external: number }
  }
  config: {
    dataDir: string
    uiMode: string
    models: { chat: string; chatFallbacks: string[]; vision: string; visionFallbacks: string[]; visionModels: string[] }
    upstream: {
      visionBaseUrl: string
      visionKeyConfigured: boolean
      searchKeyConfigured: boolean
      remoteWorker: boolean
      remoteWorkerLabel: string
    }
    auth: { requireAuth: boolean; registrationEnabled: boolean }
    limits: Record<string, number>
    webRead: { timeoutMs: number; maxBytes: number; maxChars: number }
    credits: { prices: Record<string, number>; concurrency: Record<string, number> }
  }
  tools: {
    list: { id: string; label: string; state: string }[]
    webRead: {
      enabled: boolean
      last: { at: string; ok: boolean; host: string; chars: number; ms: number; title: string; code: string } | null
    }
  }
  logs: {
    access: { at: string; id: string; m: string; p: string; s: number; ms: number; u: string; ip: string }[]
    errors: { at: string; id: string; msg: string; scope?: string; method?: string; path?: string }[]
    totals: { access: number; errors: number }
    limits: { access: number; errors: number }
  }
}

// 后台只需要「大概多大」，用十进制单位；少于 1 KB 也写清楚，不显示 0 B 之外的奇怪精度。
function formatBytes(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return value + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[index]
}

function PortRow({ name, port, internal }: { name: string; port: BdcPort; internal: boolean }) {
  // 生产环境只给结论：回调地址、内网端口属于排障信息，留在内部环境
  const showUrl = internal || !/127\.0\.0\.1|localhost|\[::1\]/.test(port.url || '')
  return (
    <div className="admin-port">
      <span className="admin-port-name">{name}</span>
      <span className="admin-mono">{showUrl ? port.url || '—' : '内网地址'}</span>
      <Badge tone={port.up ? 'ok' : 'warn'}>{port.up ? '在线' : '未部署'}</Badge>
      <span className="admin-cell-sub">{port.up ? (internal ? `HTTP ${port.status}` : '可访问') : internal ? port.error || '无响应' : '不可用'}</span>
    </div>
  )
}

export default function SystemSection() {
  const { internal } = useUiMode()
  const version = useApi<VersionInfo>('/api/version')
  const bdc = useApi<BdcStatus>('/api/bdc/status')
  const storage = useApi<StorageInfo>('/api/admin/storage')

  const errors = [
    version.error ? `GET /api/version：${version.error}` : '',
    bdc.error ? `GET /api/bdc/status：${bdc.error}` : '',
    storage.error ? `GET /api/admin/storage：${storage.error}` : '',
  ].filter(Boolean)

  const reload = () => {
    version.reload()
    bdc.reload()
    storage.reload()
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / SYSTEM"
        title="系统与版本"
        description={
          internal
            ? '版本、VisionQA Canvas 三端口与数据目录说明。所有状态来自真实接口；未部署就如实写未部署。'
            : '版本、画布服务状态与数据占用；没有数据的地方写空状态，不估算、不编造。'
        }
        actions={<RefreshButton onClick={reload} busy={version.loading || bdc.loading || storage.loading} />}
      />

      {errors.length ? <ErrorBanner message={errors.join('；')} onRetry={reload} /> : null}

      <div className="admin-grid admin-grid--two">
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">当前版本</p>
              <p className="admin-sub">{internal ? '来自服务端读取的 package.json 与启动时间。' : '当前部署的版本与启动时间。'}</p>
            </div>
            <SourceTag kind="api" source="GET /api/version" />
          </div>
          {version.loading && !version.data ? <LoadingLine label="/api/version" /> : null}
          {version.data ? (
            <dl className="admin-kv">
              <div>
                <dt>版本</dt>
                <dd>
                  <span className="admin-value admin-value--inline">v{version.data.version}</span>
                </dd>
              </div>
              <div>
                <dt>服务名</dt>
                <dd className={internal ? 'admin-mono' : ''}>{internal ? version.data.name : 'VisionQA 工作台'}</dd>
              </div>
              <div>
                <dt>启动时间</dt>
                <dd className="admin-mono">{formatDateTime(version.data.startedAt)}</dd>
              </div>
            </dl>
          ) : null}
        </section>

        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">VisionQA Canvas</p>
              <p className="admin-sub">{internal ? '三端口状态，不启动、不探测额外地址。' : '画布服务的运行状态与访问地址。'}</p>
            </div>
            <SourceTag kind="api" source="GET /api/bdc/status" />
          </div>
          {bdc.loading && !bdc.data ? <LoadingLine label="/api/bdc/status" /> : null}
          {bdc.data ? (
            <>
              <p className="admin-deploy-line">
                <Badge tone={bdc.data.deployed ? 'ok' : 'warn'}>
                  {bdc.data.deployed ? '已部署' : '未部署'}
                </Badge>
                {internal ? <span>deployed = {String(bdc.data.deployed)}</span> : null}
              </p>
              <div className="admin-ports">
                <PortRow name="Web" port={bdc.data.web} internal={internal} />
                <PortRow name="Admin" port={bdc.data.admin} internal={internal} />
                <PortRow name="API" port={bdc.data.api} internal={internal} />
              </div>
            </>
          ) : null}
        </section>
      </div>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">数据存储</p>
            <p className="admin-sub">
              {internal ? '真实统计 data 目录的文件与占用；磁盘余量来自操作系统，不在前端估算。' : '模板、运行记录与账号数据的实际占用；换机器或备份前先看这里。'}
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/admin/storage" />
        </div>

        {storage.loading && !storage.data ? <LoadingLine label="/api/admin/storage" /> : null}

        {storage.data ? (
          <>
            <dl className="admin-kv">
              <div>
                <dt>总占用</dt>
                <dd>
                  <span className="admin-value admin-value--inline">{formatBytes(storage.data.bytes)}</span>
                  <span className="admin-cell-sub">共 {storage.data.files} 个文件</span>
                </dd>
              </div>
              {storage.data.disk ? (
                <div>
                  <dt>磁盘余量</dt>
                  <dd>
                    <span className="admin-mono">{formatBytes(storage.data.disk.freeBytes)}</span>
                    <span className="admin-cell-sub">可用 / 共 {formatBytes(storage.data.disk.totalBytes)}</span>
                  </dd>
                </div>
              ) : null}
              {internal ? (
                <div>
                  <dt>数据目录</dt>
                  <dd className="admin-mono">{storage.data.dataDir}</dd>
                </div>
              ) : null}
            </dl>

            {storage.data.items.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table admin-table--runs">
                  <thead>
                    <tr>
                      <th>条目</th>
                      <th>文件数</th>
                      <th>占用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.data.items.map((item) => (
                      <tr key={item.name}>
                        <td className={internal ? 'admin-mono' : ''}>{item.name}</td>
                        <td className="admin-mono">{item.files}</td>
                        <td className="admin-mono">{formatBytes(item.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-hint">数据目录还是空的：第一次检索、评审或运行之后，这里会出现真实文件。</p>
            )}

            <p className="admin-hint">
              {internal
                ? `统计时间 ${formatDateTime(storage.data.checkedAt)}；只统计 data 目录，不包含 node_modules 与构建产物。`
                : `统计时间 ${formatDateTime(storage.data.checkedAt)}；只统计业务数据，不包含程序文件。`}
            </p>
          </>
        ) : null}

        {!storage.loading && storage.error ? (
          <p className="admin-hint">占用读取失败：{internal ? storage.error : '稍后刷新再试；如果一直失败，请联系维护人员。'}</p>
        ) : null}
      </section>

      {internal ? <DiagnosticsCard /> : null}
    </>
  )
}

// 内部环境专用：最近请求与错误只在进程内存里，重启即清空；生产环境该接口直接 404。
function DiagnosticsCard() {
  const { data, error, loading, reload } = useApi<DiagnosticsInfo>('/api/admin/diagnostics')
  const errors = [...(data?.logs.errors ?? [])].reverse().slice(0, 8)
  const requests = [...(data?.logs.access ?? [])].reverse().slice(0, 12)

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">排查信息</p>
          <p className="admin-sub">
            只在内部环境提供：进程、模型配置是否就绪、最近请求与错误都来自当前进程，生产环境不会暴露这个接口。
          </p>
        </div>
        <div className="admin-diag-actions">
          <SourceTag kind="api" source="GET /api/admin/diagnostics" />
          <button type="button" className="admin-btn admin-btn--ghost" onClick={reload} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={`GET /api/admin/diagnostics：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/diagnostics" /> : null}

      {data ? (
        <>
          <dl className="admin-kv">
            <div>
              <dt>进程</dt>
              <dd>
                <span className="admin-mono">PID {data.process.pid} · Node {data.process.node}</span>
                <span className="admin-cell-sub">启动 {formatDateTime(data.process.startedAt)}</span>
              </dd>
            </div>
            <div>
              <dt>运行时长</dt>
              <dd>
                <span className="admin-mono">{formatDuration(data.process.uptimeSec * 1000)}</span>
                <span className="admin-cell-sub">版本 v{data.package.version}</span>
              </dd>
            </div>
            <div>
              <dt>内存</dt>
              <dd>
                <span className="admin-mono">RSS {data.process.memoryMb.rss} MB</span>
                <span className="admin-cell-sub">
                  heap {data.process.memoryMb.heapUsed} / {data.process.memoryMb.heapTotal} MB
                </span>
              </dd>
            </div>
            <div>
              <dt>对话模型</dt>
              <dd>
                <span className="admin-mono">{data.config.models.chat}</span>
                <span className="admin-cell-sub">
                  {data.config.models.chatFallbacks.length ? '降级 ' + data.config.models.chatFallbacks.join(' / ') : '没有配置降级模型'}
                </span>
              </dd>
            </div>
            <div>
              <dt>视觉模型</dt>
              <dd>
                <span className="admin-mono">{data.config.models.vision}</span>
                <span className="admin-cell-sub">
                  {data.config.models.visionModels.length ? '候选 ' + data.config.models.visionModels.join(' / ') : '候选沿用默认'}
                </span>
              </dd>
            </div>
            <div>
              <dt>上游地址</dt>
              <dd className="admin-mono">{data.config.upstream.visionBaseUrl}</dd>
            </div>
            <div>
              <dt>凭证状态</dt>
              <dd>
                模型 {data.config.upstream.visionKeyConfigured ? '已配置' : '未配置'} · 检索{' '}
                {data.config.upstream.searchKeyConfigured ? '已配置' : '未配置'}
              </dd>
            </div>
            <div>
              <dt>网页读取</dt>
              <dd>
                <span>
                  {data.tools.webRead.last
                    ? data.tools.webRead.last.ok
                      ? '最近一次成功 · ' + data.tools.webRead.last.host + ' · ' + data.tools.webRead.last.chars + ' 字'
                      : '最近一次失败 · ' + (data.tools.webRead.last.host || '无来源') + ' · ' + data.tools.webRead.last.code
                    : '本次启动还没有读取记录'}
                </span>
                <span className="admin-cell-sub">
                  {data.tools.webRead.last ? formatDateTime(data.tools.webRead.last.at) : '超时 ' + Math.round(data.config.webRead.timeoutMs / 1000) + ' 秒'}
                </span>
              </dd>
            </div>
            <div>
              <dt>智能体工具</dt>
              <dd>
                <span className="admin-mono">
                  {data.tools.list.filter((tool) => tool.state === 'ready').map((tool) => tool.label).join(' · ')}
                </span>
                <span className="admin-cell-sub">
                  待接入：{data.tools.list.filter((tool) => tool.state !== 'ready').map((tool) => tool.label).join(' / ') || '无'}
                </span>
              </dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd className="admin-mono">{data.config.dataDir}</dd>
            </div>
          </dl>

          <div className="admin-diag-grid">
            <section>
              <p className="admin-label">
                最近错误
                <span className="admin-cell-sub">本次启动共 {data.logs.totals.errors} 条</span>
              </p>
              {errors.length ? (
                <ul className="admin-diag-errors">
                  {errors.map((item, index) => (
                    <li key={item.id + '-' + index}>
                      <div className="admin-diag-error-head">
                        <span>{formatDateTime(item.at)}</span>
                        <span className="admin-mono">{item.id || '进程级'}</span>
                      </div>
                      <p>{String(item.msg || '').split('\n')[0] || '（没有错误信息）'}</p>
                      {item.path ? (
                        <span className="admin-cell-sub admin-mono">
                          {item.method || ''} {item.path}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-hint">本次启动以来没有错误。请求走到这里之后产生的 5xx 会出现在这里。</p>
              )}
            </section>

            <section>
              <p className="admin-label">
                最近请求
                <span className="admin-cell-sub">本次启动共 {data.logs.totals.access} 条</span>
              </p>
              {requests.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table admin-table--diag">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>方法</th>
                        <th>路径</th>
                        <th>状态</th>
                        <th>耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.map((item, index) => (
                        <tr key={item.id + '-' + index}>
                          <td className="admin-mono">{formatDateTime(item.at)}</td>
                          <td className="admin-mono">{item.m}</td>
                          <td className="admin-mono admin-diag-path" title={item.p}>
                            {item.p}
                          </td>
                          <td>
                            <Badge tone={item.s >= 500 ? 'fail' : item.s >= 400 ? 'warn' : 'ok'}>{item.s}</Badge>
                          </td>
                          <td className="admin-mono">{Math.round(item.ms)} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-hint">还没有请求记录：刷新页面或调一次接口，这里就会出现。</p>
              )}
            </section>
          </div>

          <p className="admin-hint">
            内存里只保留最近 {data.logs.limits.access} 条请求 / {data.logs.limits.errors} 条错误，进程重启即清空；完整访问日志仍在服务器的系统日志里。
            网页读取可用 <span className="admin-mono">POST /api/admin/tools/web-read</span> 单独自检，不经过模型。
          </p>
        </>
      ) : null}
    </section>
  )
}
