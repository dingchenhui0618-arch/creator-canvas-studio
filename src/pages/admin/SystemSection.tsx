import { useUiMode } from '../../api/app'
import { formatDateTime, useApi, type BdcPort, type BdcStatus, type VersionInfo } from './data'
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
    </>
  )
}
