import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  ImagePlus,
  Loader2,
  RefreshCw,
  ShoppingBag,
  UserRound,
  X,
} from 'lucide-react'
import type { Session } from '../auth/session'
import type { IconComponent } from '../domain/types'
import {
  ASSET_KIND_META,
  ASSET_NAME_MAX,
  DEFAULT_ASSET_LIMITS,
  ONBOARDING_CATEGORIES,
  ONBOARDING_DIRECTION_MAX,
  ONBOARDING_IDENTITIES,
  assetErrorInfo,
  completeOnboarding,
  createAsset,
  generateAsset,
  getOnboarding,
  listAssets,
  saveOnboarding,
  slotsFor,
  uploadSourceImage,
  watchAsset,
  type Asset,
  type AssetKind,
  type AssetLimits,
  type AssetSource,
  type OnboardingIdentityId,
  type OnboardingState,
} from '../api/assets'
import '../styles/assets.css'

const IDENTITY_ICON: Record<OnboardingIdentityId, IconComponent> = {
  creator: UserRound,
  commerce: ShoppingBag,
  agency: Building2,
}

/** 已经提示过「还没建资产」的账号：同一次页面生命周期只提示一次，不跟着每次重渲染刷屏。 */
const nudgedUsers = new Set<string>()

function upsertAsset(items: Asset[], asset: Asset): Asset[] {
  const next = items.filter((item) => item.id !== asset.id)
  return [asset, ...next]
}

/** 资产上一个「AI 生成」标记：生成的图不能让人误以为是实拍。 */
export function AiBadge() {
  return <span className="vq-ai-badge">AI 生成</span>
}

/** 槽位图：加载失败也保留占位块，不能出现浏览器的破图标。 */
function SlotImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="vq-slot-state">图片没加载出来</span>
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
}

/**
 * 建一套资产：上传来源图 → 创建（不扣费）→ 生成（后台 4 张）→ 看结果。
 * 引导弹窗第三步与「我的资产」的新建弹窗共用这一块，所以放在这里导出。
 */
export function AssetBuilder({
  kind,
  limits = DEFAULT_ASSET_LIMITS,
  freeSeatUsed = false,
  categoryOptions = ONBOARDING_CATEGORIES,
  initialCategory = '',
  initialName = '',
  onAssetChange,
  onSettled,
  onToast,
}: {
  kind: AssetKind
  limits?: AssetLimits
  freeSeatUsed?: boolean
  categoryOptions?: readonly string[]
  initialCategory?: string
  initialName?: string
  onAssetChange?: (asset: Asset | null) => void
  onSettled?: (asset: Asset) => void
  onToast?: (message: string) => void
}) {
  const meta = ASSET_KIND_META[kind]
  const slots = slotsFor(kind)
  const maxSources = kind === 'product' ? limits.sourcesProduct : limits.sourcesAvatar
  const [name, setName] = useState(initialName)
  const [category, setCategory] = useState(initialCategory)
  const [sources, setSources] = useState<AssetSource[]>([])
  const [asset, setAsset] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef(onAssetChange)
  const settledRef = useRef(onSettled)

  useEffect(() => {
    changeRef.current = onAssetChange
  }, [onAssetChange])

  useEffect(() => {
    settledRef.current = onSettled
  }, [onSettled])

  const generating = asset?.status === 'generating'
  const refs = asset?.refs ?? []
  const done = asset?.progress.done ?? 0
  const total = asset?.progress.total || slots.length
  const settled = Boolean(asset && !generating)
  const missing = slots.filter((slot) => !refs.some((ref) => ref.slot === slot.slot))

  // 轮询只认「当前这条正在生成」：换一套或生成结束就停，不会留下定时器。
  const watchingId = asset && asset.status === 'generating' ? asset.id : ''
  useEffect(() => {
    if (!watchingId) return
    const controller = new AbortController()
    let alive = true
    watchAsset(
      watchingId,
      (next) => {
        if (!alive) return
        setAsset(next)
        changeRef.current?.(next)
      },
      controller.signal,
    )
      .then((next) => {
        if (alive) settledRef.current?.(next)
      })
      .catch((caught) => {
        if (!alive) return
        // 取不到进度不等于任务失败：任务在服务端继续跑，重进资产库还能看到。
        setError(assetErrorInfo(caught).message || '进度没取到，稍后刷新资产库查看结果。')
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [watchingId])

  // 真实等待时长：只用来告诉用户「等了多久」，进度仍以服务端 done 为准。
  useEffect(() => {
    if (!generating) return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [generating])

  const addFiles = async (files: FileList | null) => {
    if (!files || !files.length) return
    const room = maxSources - sources.length
    if (room <= 0) {
      setError(`${meta.label}最多 ${maxSources} 张来源图`)
      return
    }
    const picks = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, room)
    if (!picks.length) {
      setError('只支持图片文件（JPG / PNG / WebP）')
      return
    }
    setUploading(true)
    setError('')
    try {
      const uploaded: AssetSource[] = []
      for (const file of picks) {
        const result = await uploadSourceImage(file)
        uploaded.push({
          id: result.asset.id,
          name: result.asset.name,
          width: result.asset.width,
          height: result.asset.height,
          previewUrl: result.asset.previewUrl,
        })
      }
      setSources((previous) => [...previous, ...uploaded])
    } catch (caught) {
      setError(assetErrorInfo(caught).message)
    } finally {
      setUploading(false)
    }
  }

  const begin = async () => {
    if (submitting || generating) return
    const title = name.trim()
    if (!asset && !title) {
      setError('先给它起个名字：以后在模板、画布里按名字调用它')
      return
    }
    if (!asset && !sources.length) {
      setError(meta.sourceHint)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      let current = asset
      if (!current) {
        const created = await createAsset({
          kind,
          name: title,
          category: category.trim() || undefined,
          sourceAssetIds: sources.map((source) => source.id),
        })
        current = created.asset
        setAsset(current)
        changeRef.current?.(current)
      }
      const running = await generateAsset(current.id)
      setAsset(running.asset)
      changeRef.current?.(running.asset)
      setSeconds(0)
    } catch (caught) {
      const info = assetErrorInfo(caught)
      setError(info.message)
      onToast?.(info.message)
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setAsset(null)
    setSources([])
    setName('')
    setError('')
    setSeconds(0)
    changeRef.current?.(null)
  }

  const free = Boolean(asset?.free)
  const price = Number(limits.paidCreditsPerImage) || 0
  // 单价只认接口下发的 limits，不在前端写死（服务端换了通道价就会变）。
  const costLabel = free
    ? '首套免费：这一套不扣积分'
    : !asset && !freeSeatUsed
      ? '这一类第一套免费：4 张不扣积分'
      : price > 0
        ? `每张 ${price} 积分，共 ${total} 张；没出成的会按张退回`
        : '单价以服务端计价为准；没出成的会按张退回'

  const actionLabel = generating
    ? '生成中，关掉也会继续'
    : asset?.status === 'ready'
      ? `已生成 ${refs.length} 张`
      : asset && missing.length
        ? `继续生成（补 ${missing.length} 张）`
        : asset
          ? '开始生成 4 张'
          : '创建并生成 4 张'

  return (
    <div className="vq-builder">
      {asset ? (
        <p className="vq-builder-summary">
          来源图 {asset.sources.length} 张 · 已用于这一套生成；要换图请到「我的资产」里新建一套
        </p>
      ) : (
        <>
          <div className="vq-builder-source-head">
            <div>
              <strong>来源图</strong>
              <p>{meta.sourceHint}</p>
            </div>
            <span className="vq-builder-count">
              {sources.length} / {maxSources}
            </span>
          </div>

          <div className="vq-builder-sources">
            {sources.map((source) => (
              <div className="vq-builder-source" key={source.id}>
                <img src={source.previewUrl} alt={source.name || '来源图'} />
                <button
                  type="button"
                  className="vq-builder-source-remove"
                  aria-label={`移除 ${source.name || '这张图'}`}
                  onClick={() => setSources((previous) => previous.filter((item) => item.id !== source.id))}
                >
                  <X size={12} />
                </button>
              </div>
            ))}

            {sources.length < maxSources && (
              <button
                type="button"
                className="vq-builder-add"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 size={16} className="vq-spin" /> : <ImagePlus size={16} />}
                <span>{uploading ? '正在上传…' : sources.length ? '再加一张' : '上传来源图'}</span>
              </button>
            )}
            <input
              ref={inputRef}
              className="vq-builder-file"
              type="file"
              accept="image/*"
              multiple={kind === 'product'}
              onChange={(event) => {
                void addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </div>
        </>
      )}

      {!asset && (
        <div className="vq-builder-form">
          <label className="vq-builder-field">
            <span>
              名称 <em className="vq-mono">name</em>
            </span>
            <input
              type="text"
              value={name}
              maxLength={ASSET_NAME_MAX}
              placeholder={kind === 'product' ? '例如：粗针织开衫' : '例如：林可 · 通勤人设'}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="vq-builder-field">
            <span>
              类目 <em className="vq-mono">category · 可选</em>
            </span>
            <div className="vq-builder-chips" role="group" aria-label="资产类目">
              {categoryOptions.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={'vq-builder-chip' + (category === item ? ' is-active' : '')}
                  aria-pressed={category === item}
                  onClick={() => setCategory(category === item ? '' : item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {generating && (
        <div className="vq-builder-progress" role="status" aria-live="polite">
          <span className="vq-builder-bar" aria-hidden="true">
            <i style={{ width: (total ? Math.min(100, (done / total) * 100) : 0) + '%' }} />
          </span>
          <span>
            第 {Math.min(done + 1, total)} / {total} 张
            {done > 0 ? ` · 已出 ${done} 张` : ''} · 大概 20–90 秒一张 · 已等 {seconds} 秒
          </span>
        </div>
      )}

      <div className="vq-slots" aria-label="资产图">
        {slots.map((slot) => {
          const ref = refs.find((item) => item.slot === slot.slot)
          const pending = Boolean(generating && !ref)
          return (
            <figure key={slot.slot} className={'vq-slot' + (ref ? ' has-image' : '')}>
              <div className="vq-slot-frame">
                {ref ? (
                  <SlotImage src={ref.url} alt={`${slot.label}（AI 生成）`} />
                ) : pending ? (
                  <span className="vq-slot-state">
                    <Loader2 size={16} className="vq-spin" />
                    生成中
                  </span>
                ) : (
                  <span className="vq-slot-state">{settled ? '这一张失败' : '待生成'}</span>
                )}
                {ref ? <AiBadge /> : null}
              </div>
              <figcaption>
                <strong>{slot.label}</strong>
                <span>{slot.hint}</span>
              </figcaption>
            </figure>
          )
        })}
      </div>

      {asset?.error && (
        <div className="vq-builder-report" role="alert">
          <strong>
            {asset.status === 'failed' ? '这次一张都没出成' : `有 ${missing.length} 张没出成`}
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
          <p>
            {asset.free
              ? '首套免费，这次没有扣积分。'
              : '没出成的那几张已经按张退回积分；账本里能看到退款记录。'}
          </p>
        </div>
      )}

      {error && (
        <p className="vq-builder-error" role="alert">
          {error}
        </p>
      )}

      <div className="vq-builder-actions">
        <span className="vq-builder-cost">{costLabel}</span>
        {asset?.status === 'ready' ? (
          <button type="button" className="vq-button vq-button--ghost" onClick={reset}>
            再建一套
          </button>
        ) : (
          <button
            type="button"
            className="vq-button vq-button--primary"
            onClick={() => void begin()}
            disabled={submitting || generating}
          >
            {submitting || generating ? <Loader2 size={15} className="vq-spin" /> : asset ? <RefreshCw size={15} /> : <ImagePlus size={15} />}
            {submitting && !asset ? '正在创建…' : actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 注册后的身份引导：身份 → 类目与方向 → 建第一套资产。
 * 只在账号（kind === 'account'）、还没做完引导（done === false）时自己出现；
 * 管理员、演示账号与访客都不弹。第一步没有关闭入口，第三步可以「以后再说」。
 */
export function OnboardingGate({
  session,
  onDone,
  onOpenAssets,
  onToast,
}: {
  session: Session
  onDone?: () => void
  onOpenAssets?: () => void
  onToast?: (message: string) => void
}) {
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<OnboardingState | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [identity, setIdentity] = useState<OnboardingIdentityId | ''>('')
  const [category, setCategory] = useState('')
  const [direction, setDirection] = useState('')
  const [kind, setKind] = useState<AssetKind>('product')
  const [items, setItems] = useState<Asset[]>([])
  const [limits, setLimits] = useState<AssetLimits>(DEFAULT_ASSET_LIMITS)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const userId = session.user.id
  const isAccount = session.user.kind === 'account'

  useEffect(() => {
    if (!isAccount) return
    const controller = new AbortController()
    let alive = true
    void Promise.all([getOnboarding(controller.signal), listAssets('all').catch(() => null)])
      .then(([next, list]) => {
        if (!alive) return
        if (list) {
          setItems(list.items)
          setLimits(list.limits ?? DEFAULT_ASSET_LIMITS)
        }
        if (next.done) {
          // 引导做完但一件资产都没有：进工作台时提示一次，别每次重渲染都弹。
          if (next.needs?.asset && !nudgedUsers.has(userId)) {
            nudgedUsers.add(userId)
            onToast?.('还没有自己的资产：先去「我的资产」建一套，生成时才有参考图')
          }
          return
        }
        setState(next)
        setIdentity(next.identity)
        setCategory(next.category)
        setDirection(next.direction)
        setStep(next.needs?.identity === false ? 2 : 1)
        setVisible(true)
      })
      .catch(() => {
        // 引导状态取不到时不弹（数据库没迁移 / 接口未部署）：宁可不打扰，也不给一个填不出去的弹窗。
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [isAccount, onToast, userId])

  // 弹窗期间锁住背景滚动，并把 Esc 拦下来：这个引导不是可以顺手关掉的浮层。
  useEffect(() => {
    if (!visible) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [visible])

  const saveIdentity = async (targetStep: 1 | 2 | 3) => {
    if (!identity || saving) return
    setSaving(true)
    setError('')
    try {
      const next = await saveOnboarding({
        identity,
        ...(targetStep === 3 ? { category, direction } : {}),
      })
      setState(next)
      setStep(targetStep)
    } catch (caught) {
      setError(assetErrorInfo(caught).message)
    } finally {
      setSaving(false)
    }
  }

  const finish = async (skipAssets: boolean, goAssets = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await completeOnboarding(skipAssets)
      setVisible(false)
      onToast?.(skipAssets ? '引导已完成；资产可以之后在「我的资产」里补' : '引导已完成')
      onDone?.()
      if (goAssets) onOpenAssets?.()
    } catch (caught) {
      setError(assetErrorInfo(caught).message)
    } finally {
      setBusy(false)
    }
  }

  if (!visible || !state) return null

  const identities = state.identities?.length ? state.identities : ONBOARDING_IDENTITIES
  const categories = state.categories?.length ? state.categories : ONBOARDING_CATEGORIES
  const accountAssets = items.filter((item) => item.kind === kind)
  const freeSeatUsed = accountAssets.some(
    (item) => item.free && ['generating', 'ready', 'partial'].includes(item.status),
  )
  // 「完成」要看到至少一张出图；只建了草稿不算走完（那时仍可「以后再说」）
  const hasGenerated = items.some((item) => item.refs.length > 0)
  const createdCount = items.length

  const acceptAsset = (next: Asset | null) => {
    if (!next) return
    setItems((previous) => upsertAsset(previous, next))
  }

  return (
    <div className="vq-gate">
      <div className="vq-gate-backdrop" aria-hidden="true" />
      <div
        className="vq-gate-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vq-gate-title"
      >
        <header className="vq-gate-head">
          <span className="vq-mono">Setup · 第 {step} / 3 步</span>
          <h1 id="vq-gate-title">
            {step === 1
              ? '先确认你在做什么'
              : step === 2
                ? '从一个类目和一个方向开始'
                : '先建一件你自己的商品'}
          </h1>
          <p>
            {step === 1
              ? '这一步决定资产类目与之后的模板推荐；选错可以随时在「我的资产」里改。'
              : step === 2
                ? '类目只选一个；方向写一句就够，例如「穿搭口播」，它会成为生成时的默认风格。'
                : '复刻要拿你自己的商品图和脸做参考。建过之后，每个工作流和对话预设都能直接调用它。'}
          </p>
          <ol className="vq-gate-steps" aria-label="引导步骤">
            {['身份', '类目', '建资产'].map((label, index) => {
              const number = index + 1
              const isDone = number < step
              const isCurrent = number === step
              return (
                <li
                  key={label}
                  className={'vq-gate-step' + (isDone ? ' is-done' : '') + (isCurrent ? ' is-current' : '')}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="vq-gate-step-index">{isDone ? <Check size={12} /> : number}</span>
                  {label}
                </li>
              )
            })}
          </ol>
        </header>

        <div className="vq-gate-body">
          {step === 1 && (
            <div className="vq-gate-choices" role="radiogroup" aria-label="选择身份">
              {identities.map((item) => {
                const Icon = IDENTITY_ICON[item.id] ?? UserRound
                const active = identity === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={'vq-gate-choice' + (active ? ' is-active' : '')}
                    onClick={() => setIdentity(item.id)}
                  >
                    <span className="vq-gate-choice-icon">
                      <Icon size={18} />
                    </span>
                    <span className="vq-gate-choice-copy">
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </span>
                    {active ? <Check size={16} className="vq-gate-choice-check" /> : null}
                  </button>
                )
              })}
            </div>
          )}

          {step === 2 && (
            <div className="vq-gate-form">
              <div className="vq-builder-field">
                <span>
                  类目 <em className="vq-mono">category</em>
                </span>
                <div className="vq-builder-chips" role="group" aria-label="经营类目">
                  {categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={'vq-builder-chip' + (category === item ? ' is-active' : '')}
                      aria-pressed={category === item}
                      onClick={() => setCategory(category === item ? '' : item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              <label className="vq-builder-field">
                <span>
                  方向 <em className="vq-mono">direction · 可选</em>
                </span>
                <input
                  type="text"
                  value={direction}
                  maxLength={ONBOARDING_DIRECTION_MAX}
                  placeholder="例如：穿搭口播、家居收纳好物"
                  onChange={(event) => setDirection(event.target.value)}
                />
                <small className="vq-gate-counter">
                  {direction.length} / {ONBOARDING_DIRECTION_MAX}
                </small>
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="vq-gate-assets">
              <div className="vq-gate-kinds" role="group" aria-label="资产类型">
                {(['product', 'avatar'] as AssetKind[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={'vq-gate-kind' + (kind === item ? ' is-active' : '')}
                    aria-pressed={kind === item}
                    onClick={() => setKind(item)}
                  >
                    {ASSET_KIND_META[item].short}资产
                  </button>
                ))}
                <span className="vq-gate-kind-note">
                  一次 {slotsFor(kind).length} 张 · {ASSET_KIND_META[kind].hint}
                </span>
              </div>

              <AssetBuilder
                key={kind}
                kind={kind}
                limits={limits}
                freeSeatUsed={freeSeatUsed}
                categoryOptions={categories}
                initialCategory={category}
                onAssetChange={acceptAsset}
                onToast={onToast}
              />

              {items.length > 0 && (
                <p className="vq-gate-note">
                  已经有 {createdCount} 套资产。数字人这一版只是定妆参考图，不做唇形驱动，也不会直接出说话视频。
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="vq-gate-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="vq-gate-foot">
          {step === 1 && (
            <>
              <span className="vq-gate-note">身份是必填的，没有可以跳过的入口。</span>
              <button
                type="button"
                className="vq-button vq-button--primary"
                onClick={() => void saveIdentity(2)}
                disabled={!identity || saving}
              >
                {saving ? <Loader2 size={15} className="vq-spin" /> : null}
                继续
                <ArrowRight size={15} />
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <button type="button" className="vq-button vq-button--quiet" onClick={() => setStep(1)}>
                <ArrowLeft size={15} />
                上一步
              </button>
              <button
                type="button"
                className="vq-button vq-button--primary"
                onClick={() => void saveIdentity(3)}
                disabled={saving || !identity}
              >
                {saving ? <Loader2 size={15} className="vq-spin" /> : null}
                继续
                <ArrowRight size={15} />
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <button
                type="button"
                className="vq-button vq-button--quiet"
                onClick={() => void finish(!hasGenerated)}
                disabled={busy}
              >
                {hasGenerated ? '留在工作台' : '以后再说'}
              </button>
              <button
                type="button"
                className="vq-button vq-button--primary"
                onClick={() => void finish(false, true)}
                disabled={!hasGenerated || busy}
                title={hasGenerated ? undefined : '先生成，至少看到一张图再继续'}
              >
                {busy ? <Loader2 size={15} className="vq-spin" /> : null}
                完成，去我的资产
                <ArrowRight size={15} />
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
