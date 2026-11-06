import { formatDateTime, useApi, type BdcPort, type BdcStatus, type VersionInfo } from './data'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

function PortRow({ name, port }: { name: string; port: BdcPort }) {
  return (
    <div className="admin-port">
      <span className="admin-port-name">{name}</span>
      <span className="admin-mono">{port.url || '—'}</span>
      <Badge tone={port.up ? 'ok' : 'warn'}>{port.up ? '在线' : '未部署'}</Badge>
      <span className="admin-cell-sub">{port.up ? `HTTP ${port.status}` : port.error || '无响应'}</span>
    </div>
  )
}

export default function SystemSection() {
  const version = useApi<VersionInfo>('/api/version')
  const bdc = useApi<BdcStatus>('/api/bdc/status')

  const errors = [
    version.error ? `GET /api/version：${version.error}` : '',
    bdc.error ? `GET /api/bdc/status：${bdc.error}` : '',
  ].filter(Boolean)

  const reload = () => {
    version.reload()
    bdc.reload()
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / SYSTEM"
        title="系统与版本"
        description="版本、VisionQA Canvas 三端口与数据目录说明。所有状态来自真实接口；未部署就如实写未部署。"
        actions={<RefreshButton onClick={reload} busy={version.loading || bdc.loading} />}
      />

      {errors.length ? <ErrorBanner message={errors.join('；')} onRetry={reload} /> : null}

      <div className="admin-grid admin-grid--two">
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">当前版本</p>
              <p className="admin-sub">来自服务端读取的 package.json 与启动时间。</p>
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
                <dd className="admin-mono">{version.data.name}</dd>
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
              <p className="admin-sub">三端口状态，不启动、不探测额外地址。</p>
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
                <span>deployed = {String(bdc.data.deployed)}</span>
              </p>
              <div className="admin-ports">
                <PortRow name="Web" port={bdc.data.web} />
                <PortRow name="Admin" port={bdc.data.admin} />
                <PortRow name="API" port={bdc.data.api} />
              </div>
            </>
          ) : null}
        </section>
      </div>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">数据目录</p>
            <p className="admin-sub">服务端未暴露容量接口，本页只说明目录构成，不估算占用。</p>
          </div>
          <SourceTag kind="local" source="server 数据目录约定" />
        </div>
        <div className="admin-doc-row">
          <code>data/</code>
          <span className="admin-cell-sub">模板库 JSON、抽帧、下载视频</span>
        </div>
        <p className="admin-hint">
          目录占用需要在文件系统查看；当前 API 没有返回磁盘用量的字段，因此这里不编造数字。
        </p>
      </section>

      <section className="admin-card admin-block admin-danger">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">危险操作</p>
            <p className="admin-sub">全部为占位按钮，点击不会删除任何数据。</p>
          </div>
          <Badge tone="warn">未实现</Badge>
        </div>
        <div className="admin-danger-actions">
          <button type="button" className="admin-btn admin-btn--danger" disabled title="未实现：需要后端删除接口与二次确认。">
            清空模板库
          </button>
          <button type="button" className="admin-btn admin-btn--danger" disabled title="未实现：运行记录只读，不提供删除。">
            清空运行记录
          </button>
          <button type="button" className="admin-btn admin-btn--danger" disabled title="未实现：演示账号由代码常量提供。">
            重置演示账号
          </button>
        </div>
        <p className="admin-hint">这些按钮没有绑定任何请求，只用于标明后台将来的危险操作区。</p>
      </section>
    </>
  )
}
