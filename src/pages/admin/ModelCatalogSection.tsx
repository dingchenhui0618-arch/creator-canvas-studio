import { useState } from 'react'
import type { ModelCatalogResponse, ModelCatalogRow } from '../../api/adminModels'
import { formatDateTime, useApi } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import UpstreamBalanceCard from './UpstreamBalanceCard'

const CAPABILITY_LABELS: Record<ModelCatalogRow['capability'], string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  unknown: '未知',
}

type FilterId = 'all' | 'text' | 'image' | 'video'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文本' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
]

function capabilityCount(rows: ModelCatalogRow[], capability: ModelCatalogRow['capability']) {
  return rows.filter((row) => row.capability === capability).length
}

export default function ModelCatalogSection() {
  const [refreshAt, setRefreshAt] = useState(0)
  // 手动刷新带 force=1：服务端缓存 10 分钟，但管理员点了「刷新」就应该看到上游当前状态。
  const path = refreshAt
    ? '/api/admin/model-catalog?force=1&t=' + refreshAt
    : '/api/admin/model-catalog'
  const { data, error, loading } = useApi<ModelCatalogResponse>(path)
  const [capability, setCapability] = useState<'all' | ModelCatalogRow['capability']>('all')

  const rows = data?.rows || []
  const visible = capability === 'all' ? rows : rows.filter((row) => row.capability === capability)
  const counts: Record<FilterId, number> = {
    all: rows.length,
    text: capabilityCount(rows, 'text'),
    image: capabilityCount(rows, 'image'),
    video: capabilityCount(rows, 'video'),
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / MODELS"
        title="模型与上游"
        description="一条能力只走一条主路由，其余模型降为仅参考。下面按模型名合并两个上游：同一个模型出现在两边时并排显示来源与价格，价格是上游标价，不含平台加价。"
        actions={<RefreshButton onClick={() => setRefreshAt(Date.now())} busy={loading} />}
      />

      {error ? <ErrorBanner message={error} onRetry={() => setRefreshAt(Date.now())} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/model-catalog" /> : null}

      {data ? (
        <>
          <div className="model-catalog-platforms">
            {data.platforms.map((platform) => (
              <article className="admin-card model-platform" key={platform.id}>
                <div className="model-platform-head">
                  <div>
                    <p className="admin-label">{platform.label}</p>
                    <p className="model-platform-url admin-mono">{platform.baseUrl}</p>
                  </div>
                  <Badge tone={platform.connected ? 'ok' : 'warn'}>
                    {platform.connected ? '已连接' : '未配置 Key'}
                  </Badge>
                </div>
                <p className="model-platform-count">
                  <strong>{platform.modelCount}</strong>
                  <span> 个模型</span>
                </p>
                <p className="admin-hint">{platform.note}</p>
              </article>
            ))}
          </div>

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">统一路由</p>
                <p className="admin-sub">
                  一条能力只留一条主路由：{data.routes.primaryCount} 条在用，其余 {data.routes.referenceCount}{' '}
                  个模型降为「仅参考」——不进选择器、不做默认。要换路由改 server/model-routes.mjs，别在别处再写一份默认模型。
                </p>
              </div>
              <SourceTag kind="api" source="GET /api/admin/model-catalog" />
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table route-table">
                <thead>
                  <tr>
                    <th>能力</th>
                    <th>主路由模型</th>
                    <th>平台</th>
                    <th>上游单价</th>
                    <th>用在哪</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.routes.map((route) => (
                    <tr key={route.capability}>
                      <td data-label="能力">
                        <Badge tone="ok">{route.label}</Badge>
                      </td>
                      <td data-label="主路由模型">
                        <strong className="admin-mono model-catalog-model">{route.model}</strong>
                        <span className="admin-cell-sub">
                          {route.source === 'config' ? '来自环境变量' : '代码里定死'}
                          {route.inCatalog ? '' : ' · 上游目录里没有这一行'}
                        </span>
                      </td>
                      <td data-label="平台">{route.platformLabel}</td>
                      <td data-label="上游单价">
                        {route.price ? route.price.text : '—'}
                        {route.price?.note ? <span className="admin-cell-sub">{route.price.note}</span> : null}
                      </td>
                      <td data-label="用在哪">
                        <span className="admin-cell-sub">{route.usedBy.join(' · ')}</span>
                        <span className="admin-cell-sub">同能力另有 {route.referenceCount} 个仅参考</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <UpstreamBalanceCard />

          {data.notes.length ? (
            <section className="admin-card admin-note">
              <p className="admin-label">计价与连接口径</p>
              <ul>
                {data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">模型目录</p>
                <p className="admin-sub">
                  共 {rows.length} 个模型，抓取于 {formatDateTime(data.fetchedAt)}。接入状态按 Key 池当前声明的模型与能力现算，
                  与上游价格缓存无关。
                </p>
              </div>
              <SourceTag kind="api" source="GET /api/admin/model-catalog" />
            </div>

            <div className="model-filter" role="group" aria-label="按能力筛选模型">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className="model-filter-button"
                  aria-pressed={capability === filter.id}
                  onClick={() => setCapability(filter.id)}
                >
                  {filter.label}
                  <span>{counts[filter.id]}</span>
                </button>
              ))}
            </div>

            {visible.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table model-catalog-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>能力</th>
                      <th>路由</th>
                      <th>平台来源与上游单价</th>
                      <th>接入状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.model}>
                        <td data-label="模型">
                          <strong className="admin-mono model-catalog-model">{row.model}</strong>
                        </td>
                        <td data-label="能力">
                          <Badge tone="neutral">{CAPABILITY_LABELS[row.capability]}</Badge>
                        </td>
                        <td data-label="路由">
                          <Badge tone={row.route === 'primary' ? 'ok' : 'neutral'}>
                            {row.route === 'primary' ? '主路由' : '仅参考'}
                          </Badge>
                        </td>
                        <td data-label="平台来源与上游单价">
                          <div className={'model-offers' + (row.offers.length > 1 ? ' model-offers--dual' : '')}>
                            {row.offers.map((offer) => (
                              <div className="model-offer" key={offer.platform}>
                                <div className="model-offer-head">
                                  <span className="model-offer-platform">{offer.platformLabel}</span>
                                  <span
                                    className={'model-offer-dot' + (offer.connected ? ' is-on' : '')}
                                    title={offer.connected ? '平台已连接' : '平台未配置启用中的 Key'}
                                    aria-label={offer.connected ? '平台已连接' : '平台未配置启用中的 Key'}
                                  />
                                </div>
                                <p className="model-offer-price">{offer.price.text}</p>
                                {offer.price.note ? <p className="model-offer-note">{offer.price.note}</p> : null}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td data-label="接入状态">
                          <Badge tone={row.routable ? 'ok' : 'neutral'}>{row.routable ? '可路由' : '仅参考'}</Badge>
                          <span className="admin-cell-sub">
                            {row.routable ? '池里有 Key 同时声明了该模型与能力' : '池里没有同时声明该模型与能力的 Key'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title={rows.length ? '这个能力下没有模型' : '上游没有返回模型'}
                description={rows.length ? '切回「全部」查看其它能力。' : '检查 Key 池与上游连通性后点「刷新」。'}
              />
            )}
          </section>
        </>
      ) : null}
    </>
  )
}
