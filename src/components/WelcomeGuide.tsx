// 上手引导：工作台里的弹窗，不是单独一页。
// 这一版教的是「一条作品的主线」（v0.9.41）：找 → 拆 → 做 → 交，四步各落在一级导航里；
// 画布与评审在这里只作为「作品里的工具」出现，不再单独占一步——它们是能力，不是目的地。
// 数字全部来自真实接口（模板、作品、交付、积分单价与余额）：哪一步还没有就把人送去哪一步，不写死。
import { ArrowRight, Clapperboard, Compass, Package, ScanSearch, Scissors, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSiteInfo } from '../api/app'
import { getCredits, type CreditsResponse } from '../api/credits'
import { listDeliveries, listProjects } from '../api/projects'
import { listTemplates } from '../api/radar'
import type { Page } from '../domain/types'

type Props = {
  onClose: () => void
  onGo: (page: Page) => void
}

type Step = {
  key: 'discover' | 'template' | 'project' | 'deliver'
  page: Page
  icon: typeof ScanSearch
  kicker: string
  title: string
  body: string
}

// 四步就是这条主线，别再多加：引导讲成页面清单就又回到「八个各自不错的页面」。
const STEPS: Step[] = [
  {
    key: 'discover',
    page: 'radar',
    icon: ScanSearch,
    kicker: '01 · 找 · 发现',
    title: '先挑一条值得拆的',
    body: '按关键词看抖音与小红书的互动数据。检索不会自己跑：点一次才查一次，结果里会标出库里已经有的那条。',
  },
  {
    key: 'template',
    page: 'templates',
    icon: Scissors,
    kicker: '02 · 拆 · 模板库',
    title: '加进模板库，点「去解析」',
    body: '只存原链接与解析结果，不下载原视频；解析完就有脚本、分镜，和每段台词的预计时长。',
  },
  {
    key: 'project',
    page: 'projects',
    icon: Clapperboard,
    kicker: '03 · 做 · 作品',
    title: '开成作品，一条做到尾',
    body: '改脚本、进画布出画面、送去评审，都在同一条作品里；画布与评审是它的工具，不是另一条线。开画布不扣积分。',
  },
  {
    key: 'deliver',
    page: 'projects',
    icon: Package,
    kicker: '04 · 交 · 交付',
    title: '交付这一版，把链接发出去',
    body: '作品页「交付」出 Markdown、A4 打印稿、现场页与评审对照；只读链接只带脚本与分镜，停用即失效。',
  },
]

// 当前走到哪一步：模板库空着就是「找」，有模板没作品是「拆」，有作品没交付是「做」，交付过就是「交」。
type Stage = 'find' | 'adapt' | 'make' | 'ship'

type Counts = {
  templates: number
  parsed: number
  projects: number
  delivered: number
}

export function WelcomeGuide({ onClose, onGo }: Props) {
  const site = useSiteInfo()
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    Promise.allSettled([getCredits(1), listTemplates(), listProjects(), listDeliveries()]).then((results) => {
      if (!alive) return
      const [creditResult, templateResult, projectResult, deliveryResult] = results
      setCredits(creditResult.status === 'fulfilled' ? creditResult.value : null)
      // 三路里只要一路没读到就整体当作「没读到」：宁可只写「从发现开始」，
      // 也不拿 0 冒充「你还没有模板」——引导上写错状态，人会照着错的那一步走。
      if (templateResult.status === 'fulfilled' && projectResult.status === 'fulfilled' && deliveryResult.status === 'fulfilled') {
        setCounts({
          templates: Math.max(0, Number(templateResult.value.total) || 0),
          parsed: Math.max(0, Number(templateResult.value.parsed) || 0),
          projects: Math.max(0, Number(projectResult.value.total) || 0),
          delivered: Math.max(0, Number(deliveryResult.value.total) || 0),
        })
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // 打开时把焦点放进弹窗，Esc 关闭；滚动锁在 body 上，避免背景跟着滚。
  useEffect(() => {
    closeRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const go = useCallback(
    (page: Page) => {
      onClose()
      onGo(page)
    },
    [onClose, onGo],
  )

  const prices = credits?.prices
  const balance = credits?.balance
  // 单价只写服务端真的在收的那几笔（search / replicate / review / flow_run）：
  // 开画布、导出、分享都不计费，别让人以为「点进画布就开始烧积分」。
  const costOf = (key: Step['key']): string => {
    // 画布这一步有两笔钱：跑一次画布、评一次画面；开画布本身不计费（这句写在卡面文案里）
    if (key === 'project') {
      const run = prices?.flow_run
      const review = prices?.review
      if (typeof run === 'number' && typeof review === 'number') return '跑一次 ' + run + ' 积分 · 评审 ' + review + ' 积分'
      return '跑画布与评审按次计'
    }
    if (key === 'deliver') return '导出与分享不扣积分'
    const price = key === 'discover' ? prices?.search : prices?.replicate
    if (typeof price !== 'number') return '按次计费'
    return (key === 'discover' ? '检索' : '解析') + '每次 ' + price + ' 积分'
  }

  // 卡片脚注右侧写「已经有几条」：只在真读到了计数时才写，读不到就什么都不说。
  const countOf = (key: Step['key']): string => {
    if (!counts) return ''
    if (key === 'template' && counts.templates) return '已有 ' + counts.templates + ' 条'
    if (key === 'project' && counts.projects) return '已有 ' + counts.projects + ' 条'
    if (key === 'deliver' && counts.delivered) return '已交 ' + counts.delivered + ' 次'
    return ''
  }

  const stage: Stage | null = !counts
    ? null
    : counts.templates === 0
      ? 'find'
      : counts.projects === 0
        ? 'adapt'
        : counts.delivered === 0
          ? 'make'
          : 'ship'

  // 「下一步」只认一个去处：这一步的下一步，就是上面那张卡片。
  const next = (() => {
    if (stage === 'find') return { label: '去发现挑一条', page: 'radar' as Page }
    if (stage === 'adapt') return { label: '去模板库挑一条', page: 'templates' as Page }
    if (stage === 'make' || stage === 'ship') return { label: '去作品接着做', page: 'projects' as Page }
    return { label: '开始使用', page: null as Page | null }
  })()

  const stateText = (() => {
    if (!counts) return '积分按次消耗，失败原路退回；单价与余额以「设置 · 积分」为准。'
    if (stage === 'find') return '账号下还没有模板：先在「发现」挑一条加进模板库，再点「去解析」拆出脚本与分镜。'
    if (stage === 'adapt') {
      const pending = Math.max(0, counts.templates - counts.parsed)
      return pending
        ? '模板库已有 ' + counts.templates + ' 条，其中 ' + pending + ' 条只存了链接：打开卡片点「去解析」，解析完原地升级，再点「用这条改编」就开出第一条作品。'
        : '模板库已有 ' + counts.templates + ' 条，还没开成作品：打开一条点「用这条改编」，就开出第一条作品。'
    }
    if (stage === 'make') {
      return '手上有 ' + counts.projects + ' 条作品，还没交出去过：先在工作台的「下一步」接着做，出画面、评一次，再回作品页点「交付」。'
    }
    return '手上有 ' + counts.projects + ' 条作品，已经交出去 ' + counts.delivered + ' 次：工作台「交出去的」按时间排，开过新版也查得到。'
  })()

  return (
    <div className="vq-modal-backdrop vq-guide-backdrop" onMouseDown={onClose}>
      <div
        className="vq-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vq-guide-title"
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="vq-guide-head">
          <div>
            <span className="vq-mono">VisionQA · 上手引导</span>
            <h2 id="vq-guide-title">欢迎使用 VisionQA</h2>
            <p>
              一级只有四个地方：工作台、作品、发现、模板库。一条内容从「发现」里进来，在「作品」里做完，交付与分享也在那一条上；
              画布、视觉评审、运行记录在工具区，它们是这条作品里的步骤。
            </p>
          </div>
          <button ref={closeRef} type="button" className="vq-button vq-button--icon" aria-label="关闭引导" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="vq-guide-steps">
          {STEPS.map((step) => (
            <button key={step.key} type="button" className="vq-guide-step" onClick={() => go(step.page)}>
              <span className="vq-guide-step-head">
                <step.icon size={15} />
                <span className="vq-mono">{step.kicker}</span>
              </span>
              <strong>{step.title}</strong>
              <span className="vq-guide-step-body">{step.body}</span>
              <span className="vq-guide-step-foot">
                <span>{costOf(step.key)}</span>
                <span className="vq-guide-step-go">
                  {countOf(step.key) ? <span className="vq-guide-step-count vq-mono">{countOf(step.key)}</span> : null}
                  <ArrowRight size={13} />
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="vq-guide-note">
          <span className="vq-guide-state">
            {stateText}{' '}
            <span className="vq-mono">
              {typeof balance === 'number' ? '当前余额 ' + balance + ' 积分。' : '积分按次消耗，失败会原路退回。'}
            </span>
          </span>
          <button
            type="button"
            className="vq-button vq-button--primary"
            onClick={() => {
              if (next.page) go(next.page)
              else onClose()
            }}
          >
            {next.label}
            <ArrowRight size={14} />
          </button>
        </div>

        <footer className="vq-guide-foot">
          <span className="vq-guide-hint">
            <Compass size={12} />
            随时可从左下角账号菜单 ›「使用引导」再看 · Ctrl / ⌘ + K 跳到任何一页
          </span>
          <span className="vq-guide-links">
            <a className="vq-link" href="#/legal/terms">服务条款</a>
            <a className="vq-link" href="#/legal/privacy">隐私说明</a>
            {site.supportEmail ? <span>联系：{site.supportEmail}</span> : null}
            {site.icp ? <span className="vq-mono">{site.icp}</span> : null}
          </span>
        </footer>
      </div>
    </div>
  )
}
