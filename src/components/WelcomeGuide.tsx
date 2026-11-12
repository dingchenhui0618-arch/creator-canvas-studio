// 上手引导：工作台里的弹窗，不是单独一页。
// 三步（找 → 拆 → 验）的数字全部来自真实接口（积分单价与余额），不写死；
// 关闭即记「看过一次」（按账号存），随时可从账号菜单再看。
import { ArrowRight, Compass, ScanSearch, Scissors, ShieldCheck, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSiteInfo } from '../api/app'
import { getCredits, type CreditsResponse } from '../api/credits'
import type { Page } from '../domain/types'

type Props = {
  onClose: () => void
  onGo: (page: Page) => void
}

const STEPS = [
  {
    key: 'radar',
    icon: ScanSearch,
    kicker: '01 · 找',
    title: '先在「发现」里检索',
    body: '按关键词看抖音与小红书的真实互动数，挑一条值得拆的。',
    page: 'radar' as Page,
  },
  {
    key: 'templates',
    icon: Scissors,
    kicker: '02 · 拆',
    title: '加进模板库，拆成脚本与分镜',
    body: '只存原链接与解析结果，不下载原视频；每段台词带预计时长。',
    page: 'templates' as Page,
  },
  {
    key: 'review',
    icon: ShieldCheck,
    kicker: '03 · 验',
    title: '出画面后做视觉评审',
    body: '按七项维度给结论，每条判断都指向画面里的具体位置。',
    page: 'review' as Page,
  },
]

export function WelcomeGuide({ onClose, onGo }: Props) {
  const site = useSiteInfo()
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    getCredits(1)
      .then((data) => {
        if (alive) setCredits(data)
      })
      .catch(() => {
        if (alive) setCredits(null)
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
  const costOf = (step: (typeof STEPS)[number]) => {
    if (!prices) return '按次计费'
    const map: Record<string, number> = { radar: prices.search, templates: prices.replicate, review: prices.review }
    const cost = map[step.key]
    return typeof cost === 'number' ? '每次 ' + cost + ' 积分' : '按次计费'
  }

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
            <p>把一条爆款变成能给编导直接拍的方案：检索真实数据、拆出脚本与分镜、出画面后按证据评审。</p>
          </div>
          <button ref={closeRef} type="button" className="vq-icon-button" aria-label="关闭引导" onClick={onClose}>
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
                {costOf(step)}
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>

        <div className="vq-guide-note">
          <span>
            {typeof balance === 'number' ? '当前余额 ' + balance + ' 积分。' : '积分按次消耗，失败会原路退回。'}
            不够用时到「设置 → 积分」提交申请，管理员发放后立即到账。
          </span>
          <button type="button" className="vq-button vq-button--primary" onClick={onClose}>
            开始使用
            <ArrowRight size={14} />
          </button>
        </div>

        <footer className="vq-guide-foot">
          <span className="vq-guide-hint">
            <Compass size={12} />
            随时可从左下角账号菜单 ›「使用引导」再看
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
