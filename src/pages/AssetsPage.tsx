import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Expand,
  Images,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import PageHead from '../components/PageHead'
import MediaLightbox from '../components/MediaLightbox'
import { useModalFocus } from '../components/useModalFocus'
import { AssetBuilder } from '../components/OnboardingGate'
import { Pill } from '../components/ui'
import {
  ASSET_KIND_META,
  ASSET_NAME_MAX,
  ASSET_STATUS_META,
  DEFAULT_ASSET_LIMITS,
  assetErrorInfo,
  assetKindLabel,
  deleteAsset,
  generateAsset,
  listAssets,
  slotsFor,
  updateAsset,
  watchAsset,
  type Asset,
  type AssetKind,
  type AssetLimits,
} from '../api/assets'
import '../styles/assets.css'
import type { ToastFn } from '../domain/toast'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'product', label: '产品资产' },
  { id: 'avatar', label: '数字人资产' },
] as const

type Filter = (typeof FILTERS)[number]['id']

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function updatedLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 封面图加载失败也留在占位块里，不出现浏览器的破图标。 */
function CoverImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="vq-asset-cover-empty">图片没加载出来</span>
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

function upsert(items: Asset[], asset: Asset): Asset[] {
  return [asset, ...items.filter((item) => item.id !== asset.id)]
}

function missingSlots(asset: Asset) {
  return slotsFor(asset.kind).filter((slot) => !asset.refs.some((ref) => ref.slot === slot.slot))
}

/**
 * 我的资产：自己的商品图与数字人。
 * 这一页回答两件事：我手上有什么可被复用的东西、这套图生成到哪一步了。
 * 生成是后台任务，关页不丢：重新打开这一页会接着轮询还在 generating 的那几条。
 */
export default function AssetsPage({ onToast }: { onToast: ToastFn }) {
  const [items, setItems] = useState<Asset[]>([])
  const [limits, setLimits] = useState<AssetLimits>(DEFAULT_ASSET_LIMITS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [builderKind, setBuilderKind] = useState<AssetKind | null>(null)
  const [renaming, setRenaming] = useState<Asset | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<Asset | null>(null)
  const [lightbox, setLightbox] = useState<{ asset: Asset; index: number } | null>(null)
  // r328：这一页三个浮层的键盘边界（焦点进来、Tab 关在里面、背景不跟着滚、关掉之后还焦）。
  // 改名的输入框自己带了 autoFocus，那一层不抢焦点。
  const builderRef = useRef<HTMLDivElement | null>(null)
  const renameRef = useRef<HTMLDivElement | null>(null)
  const deleteRef = useRef<HTMLDivElement | null>(null)
  useModalFocus(builderRef, Boolean(builderKind), { initial: 'first', lockScroll: true })
  useModalFocus(renameRef, Boolean(renaming), { initial: 'none', lockScroll: true })
  useModalFocus(deleteRef, Boolean(deleting), { initial: 'first', lockScroll: true })
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listAssets('all')
      setItems(data.items)
      setLimits(data.limits ?? DEFAULT_ASSET_LIMITS)
    } catch (caught) {
      setError(assetErrorInfo(caught).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首屏先渲染页面骨架，再让出一次事件循环去取数（不在 effect 里同步 setState）。
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 只盯还在生成的那几条：每 2.5 秒 GET /api/assets/:id，结束就停。
  const generatingKey = useMemo(
    () =>
      items
        .filter((item) => item.status === 'generating')
        .map((item) => item.id)
        .sort()
        .join(','),
    [items],
  )

  useEffect(() => {
    if (!generatingKey) return
    const controller = new AbortController()
    let alive = true
    for (const id of generatingKey.split(',')) {
      watchAsset(
        id,
        (next) => {
          if (!alive) return
          setItems((previous) => previous.map((item) => (item.id === next.id ? next : item)))
        },
        controller.signal,
      ).catch(() => {
        // 单条失败不打断整页：刷新按钮仍然能拿到最新状态。
      })
    }
    return () => {
      alive = false
      controller.abort()
    }
  }, [generatingKey])

  const filtered = filter === 'all' ? items : items.filter((item) => item.kind === filter)
  const productCount = items.filter((item) => item.kind === 'product').length
  const avatarCount = items.filter((item) => item.kind === 'avatar').length

  const freeSeatUsed = (kind: AssetKind) =>
    items.some((item) => item.kind === kind && item.free && ['generating', 'ready', 'partial'].includes(item.status))

  const regenerate = async (asset: Asset) => {
    setBusyId(asset.id)
    setError('')
    try {
      const result = await generateAsset(asset.id)
      setItems((previous) => upsert(previous, result.asset))
      onToast('已开始生成，关掉页面也会继续')
    } catch (caught) {
      const info = assetErrorInfo(caught)
      setError(info.message)
      onToast(info.message, 'fail')
    } finally {
      setBusyId('')
    }
  }

  const saveRename = async () => {
    if (!renaming) return
    const name = renameValue.trim()
    if (!name) {
      onToast('名字不能为空', 'fail')
      return
    }
    try {
      const result = await updateAsset(renaming.id, { name })
      setItems((previous) => upsert(previous, result.asset))
      setRenaming(null)
      onToast('名字已改')
    } catch (caught) {
      onToast(assetErrorInfo(caught).message, 'fail')
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteAsset(deleting.id)
      setItems((previous) => previous.filter((item) => item.id !== deleting.id))
      setDeleting(null)
      onToast('已删除这一套资产')
    } catch (caught) {
      onToast(assetErrorInfo(caught).message, 'fail')
    }
  }

  const openLightbox = (asset: Asset, index: number) => setLightbox({ asset, index })

  return (
    <div className="vq-page vq-assets">
      <PageHead
        kicker={
          <>
            <span className="vq-mono">Assets</span>
            <span>自己的商品图与数字人</span>
          </>
        }
        title="我的资产"
        desc="生成与复刻都拿这里的图当参考：同一件商品、同一张脸换模板也不变，只有你的账号可见。"
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'vq-spin' : undefined} />
              刷新
            </button>
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => setBuilderKind('avatar')}
            >
              <Plus size={15} />
              新建数字人
            </button>
            <button
              type="button"
              className="vq-button vq-button--primary"
              onClick={() => setBuilderKind('product')}
            >
              <Plus size={15} />
              新建产品资产
            </button>
          </>
        }
      />

      <div className="vq-assets-toolbar">
        <div className="vq-assets-filters" role="group" aria-label="资产类型">
          {FILTERS.map((item) => {
            const count = item.id === 'all' ? items.length : item.id === 'product' ? productCount : avatarCount
            return (
              <button
                key={item.id}
                type="button"
                className={'vq-assets-filter' + (filter === item.id ? ' is-active' : '')}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <em>{count}</em>
              </button>
            )
          })}
        </div>
        <p className="vq-assets-limits">
          产品 {productCount} / {limits.product} · 数字人 {avatarCount} / {limits.avatar}
          {' · '}
          {Number(limits.paidCreditsPerImage) > 0
            ? '首套免费，之后每张 ' + limits.paidCreditsPerImage + ' 积分，没出成的按张退回'
            : '首套免费；单价以服务端计价为准，没出成的按张退回'}
        </p>
      </div>

      {error && (
        <p className="vq-note--error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="vq-assets-loading">
          <Loader2 size={16} className="vq-spin" />
          正在读取资产…
        </p>
      ) : filtered.length === 0 ? (
        <div className="vq-empty vq-assets-empty">
          <strong>
            {filter === 'avatar' ? '还没有数字人资产' : filter === 'product' ? '还没有产品资产' : '还没有自己的资产'}
          </strong>
          <span>
            {filter === 'avatar'
              ? '上传一张清楚的正脸照，生成正面、半身、侧脸与场景定妆四张参考图。这一版只是定妆参考，不做唇形驱动。'
              : '先建一件你自己的商品：上传 1–3 张商品图，生成白底主图、场景图、细节特写与成套平铺四张。之后在模板、工作流与对话预设里直接调用。'}
          </span>
          <div className="vq-assets-empty-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={() => setBuilderKind('product')}>
              <Plus size={15} />
              新建产品资产
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => setBuilderKind('avatar')}>
              <Plus size={15} />
              新建数字人
            </button>
          </div>
        </div>
      ) : (
        <div className="vq-asset-grid">
          {filtered.map((asset) => (
            <article className="vq-asset-card" key={asset.id}>
              <div className={'vq-asset-cover vq-asset-cover--' + asset.kind}>
                {asset.refs[0] ? (
                  <button type="button" className="vq-asset-cover-btn" onClick={() => openLightbox(asset, 0)} aria-label={'看大图：' + asset.name}>
                    <CoverImage src={asset.refs[0].url} alt={asset.name + ' · ' + asset.refs[0].label} />
                  </button>
                ) : (
                  <span className="vq-asset-cover-empty">
                    {asset.status === 'generating' ? <Loader2 size={20} className="vq-spin" /> : null}
                    {asset.status === 'generating' ? '正在生成' : asset.status === 'failed' ? '没有出图' : '待生成'}
                  </span>
                )}
                {asset.refs[0] ? <span className="vq-ai-badge">AI 生成</span> : null}
                <span className="vq-asset-status">
                  <Pill tone={ASSET_STATUS_META[asset.status].tone} dot>
                    {ASSET_STATUS_META[asset.status].label}
                  </Pill>
                </span>
              </div>

              <div className="vq-asset-body">
                <div className="vq-asset-title">
                  <strong>{asset.name}</strong>
                  <span className="vq-mono">{assetKindLabel(asset.kind)}</span>
                </div>
                <p className="vq-asset-meta">
                  {asset.category || '未选类目'} · 已出 {asset.refs.length} / {asset.progress.total} 张 · 更新于 {updatedLabel(asset.updatedAt)}
                </p>

                {asset.status === 'generating' && (
                  <div className="vq-asset-progress" role="status" aria-live="polite">
                    <span className="vq-asset-bar" aria-hidden="true">
                      <i
                        style={{
                          width:
                            (asset.progress.total ? Math.min(100, (asset.progress.done / asset.progress.total) * 100) : 0) + '%',
                        }}
                      />
                    </span>
                    <span>
                      第 {Math.min(asset.progress.done + 1, asset.progress.total)} / {asset.progress.total} 张 · 关掉页面也会继续
                    </span>
                  </div>
                )}

                {asset.error && (
                  <div className="vq-asset-error">
                    <strong>
                      {asset.status === 'failed' ? '这次一张都没出成' : '有 ' + missingSlots(asset).length + ' 张没出成'}
                    </strong>
                    <ul>
                      {asset.error
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                    </ul>
                    <p>{asset.free ? '首套免费，没有扣积分。' : '没出成的已按张退回积分，账本里有退款记录。'}</p>
                  </div>
                )}

                <div className="vq-asset-slots" aria-label="已出的图">
                  {slotsFor(asset.kind).map((slot) => {
                    const ref = asset.refs.find((item) => item.slot === slot.slot)
                    const index = asset.refs.findIndex((item) => item.slot === slot.slot)
                    return ref ? (
                      <button
                        key={slot.slot}
                        type="button"
                        className="vq-asset-slot"
                        onClick={() => openLightbox(asset, index)}
                        title={slot.label + '（AI 生成）'}
                      >
                        <img src={ref.url} alt={slot.label} loading="lazy" />
                        <span>{slot.label}</span>
                      </button>
                    ) : (
                      <span className="vq-asset-slot is-missing" key={slot.slot} title={slot.label + '：还没有出图'}>
                        <em>{asset.status === 'failed' ? '这一张失败' : '未出图'}</em>
                        <span>{slot.label}</span>
                      </span>
                    )
                  })}
                </div>

                <div className="vq-asset-actions">
                  {asset.status !== 'generating' && asset.status !== 'ready' && (
                    <button
                      type="button"
                      className="vq-button vq-button--primary vq-button--sm"
                      onClick={() => void regenerate(asset)}
                      disabled={busyId === asset.id}
                    >
                      {busyId === asset.id ? <Loader2 size={14} className="vq-spin" /> : <Images size={14} />}
                      {asset.status === 'draft' ? '开始生成' : '补生成 ' + missingSlots(asset).length + ' 张'}
                    </button>
                  )}
                  {asset.status === 'generating' && (
                    <span className="vq-asset-running">
                      <Loader2 size={14} className="vq-spin" />
                      生成中
                    </span>
                  )}
                  {asset.refs.length > 0 && (
                    <button type="button" className="vq-button vq-button--quiet vq-button--sm" onClick={() => openLightbox(asset, 0)}>
                      <Expand size={14} />
                      看大图
                    </button>
                  )}
                  <button
                    type="button"
                    className="vq-button vq-button--quiet vq-button--sm"
                    onClick={() => {
                      setRenaming(asset)
                      setRenameValue(asset.name)
                    }}
                  >
                    <Pencil size={14} />
                    改名
                  </button>
                  <button
                    type="button"
                    className="vq-button vq-button--quiet vq-button--sm"
                    onClick={() => setDeleting(asset)}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {lightbox && lightbox.asset.refs[lightbox.index] && (
        <MediaLightbox
          kind="image"
          src={lightbox.asset.refs[lightbox.index].url}
          alt={lightbox.asset.name + ' · ' + lightbox.asset.refs[lightbox.index].label}
          head={
            <span className="vq-asset-lightbox-head">
              {lightbox.asset.name} · {lightbox.asset.refs[lightbox.index].label}
              <span className="vq-ai-badge">AI 生成</span>
            </span>
          }
          note={
            (lightbox.asset.refs[lightbox.index].width ?? '—') +
            ' × ' +
            (lightbox.asset.refs[lightbox.index].height ?? '—') +
            ' · ' +
            formatBytes(lightbox.asset.refs[lightbox.index].bytes)
          }
          caption={lightbox.asset.category ? '类目：' + lightbox.asset.category : null}
          actions={
            <>
              <button
                type="button"
                className="vq-button vq-button--ghost vq-button--sm"
                disabled={lightbox.index === 0}
                onClick={() => setLightbox({ asset: lightbox.asset, index: lightbox.index - 1 })}
              >
                上一张
              </button>
              <span className="vq-mono">
                {lightbox.index + 1} / {lightbox.asset.refs.length}
              </span>
              <button
                type="button"
                className="vq-button vq-button--ghost vq-button--sm"
                disabled={lightbox.index >= lightbox.asset.refs.length - 1}
                onClick={() => setLightbox({ asset: lightbox.asset, index: lightbox.index + 1 })}
              >
                下一张
              </button>
            </>
          }
          onClose={() => setLightbox(null)}
        />
      )}

      {builderKind && (
        <div className="vq-modal-backdrop" onMouseDown={() => setBuilderKind(null)}>
          <div
            ref={builderRef}
            className="vq-assets-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vq-asset-new-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="vq-assets-modal-head">
              <div>
                <span className="vq-mono">New asset</span>
                <h2 id="vq-asset-new-title">新建一套{assetKindLabel(builderKind)}</h2>
              </div>
              <button type="button" className="vq-button vq-button--icon" onClick={() => setBuilderKind(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </header>
            <div className="vq-gate-kinds" role="group" aria-label="资产类型">
              {(['product', 'avatar'] as AssetKind[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={'vq-gate-kind' + (builderKind === item ? ' is-active' : '')}
                  aria-pressed={builderKind === item}
                  onClick={() => setBuilderKind(item)}
                >
                  {ASSET_KIND_META[item].label}
                </button>
              ))}
            </div>
            <div className="vq-assets-modal-body">
              <AssetBuilder
                key={builderKind}
                kind={builderKind}
                limits={limits}
                freeSeatUsed={freeSeatUsed(builderKind)}
                onAssetChange={(next) => {
                  if (next) setItems((previous) => upsert(previous, next))
                }}
                onToast={onToast}
              />
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="vq-modal-backdrop" onMouseDown={() => setRenaming(null)}>
          <div
            ref={renameRef}
            className="vq-assets-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vq-asset-rename-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="vq-asset-rename-title">改个名字</h2>
            <p className="vq-asset-meta">模板、工作流与对话预设按这个名字找它。</p>
            <input
              className="vq-asset-input"
              value={renameValue}
              maxLength={ASSET_NAME_MAX}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
            />
            <div className="vq-assets-dialog-actions">
              <button type="button" className="vq-button vq-button--ghost" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button type="button" className="vq-button vq-button--primary" onClick={() => void saveRename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="vq-modal-backdrop" onMouseDown={() => setDeleting(null)}>
          <div
            ref={deleteRef}
            className="vq-assets-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vq-asset-delete-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="vq-asset-delete-title">删掉这套「{deleting.name}」？</h2>
            <p className="vq-asset-meta">
              这一套的图会一起删掉，之后模板与工作流里再引用它就需要重新建。已经花掉的积分不会退回。
            </p>
            <div className="vq-assets-dialog-actions">
              <button type="button" className="vq-button vq-button--ghost" onClick={() => setDeleting(null)}>
                留着
              </button>
              <button type="button" className="vq-button vq-button--danger" onClick={() => void confirmDelete()}>
                删掉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
