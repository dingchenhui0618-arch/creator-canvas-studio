// 新用户引导页：第一次进工作台先看这一屏，把「检索 → 拆解 → 评审」三步讲清楚。
// 数字全部来自真实接口（积分单价与余额），不写死；不摆假进度条、不做自动播放动画。
import { ArrowRight, ScanSearch, Scissors, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSiteInfo } from '../api/app'
import { getCredits, type CreditsResponse } from '../api/credits'
import { navigate } from '../router'
import '../styles/shell.css'

type Props = { name: string; onDone: () => void }

export function WelcomePage({ name, onDone }: Props) {
  const site = useSiteInfo()
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  useEffect(() => {
    getCredits(1)
      .then(setCredits)
      .catch(() => setCredits(null))
  }, [])
  const prices = credits?.prices
  const balance = credits?.balance
  const steps = [
    { key: 'radar', icon: ScanSearch, kicker: '01 · 找', title: '先在爆款雷达里检索', body: '按关键词看抖音与小红书的真实互动数，挑一条值得拆的。', cost: prices ? prices.search : null, page: 'radar' as const },
    { key: 'templates', icon: Scissors, kicker: '02 · 拆', title: '加进模板库，拆成脚本与分镜', body: '只存原链接与解析结果，不下载原视频；每段台词带预计时长。', cost: prices ? prices.replicate : null, page: 'templates' as const },
    { key: 'review', icon: ShieldCheck, kicker: '03 · 验', title: '出画面后做视觉评审', body: '按七项维度给结论，每条判断都指向画面里的具体位置。', cost: prices ? prices.review : null, page: 'review' as const },
  ]
  return (
    <main className="vq-welcome">
      <div className="vq-welcome-inner">
        <span className="vq-mono vq-welcome-kicker">VisionQA · 开始</span>
        <h1>欢迎{name ? '，' + name : ''}</h1>
        <p className="vq-welcome-lede">把一条爆款变成能给编导直接拍的方案：检索真实数据、拆出脚本与分镜、出画面后按证据评审。</p>

        <div className="vq-welcome-steps">
          {steps.map((step) => (
            <button key={step.key} type="button" className="vq-welcome-step" onClick={() => { onDone(); navigate({ kind: 'page', page: step.page }) }}>
              <span className="vq-welcome-step-head">
                <step.icon size={15} />
                <span className="vq-mono">{step.kicker}</span>
              </span>
              <strong>{step.title}</strong>
              <span className="vq-welcome-step-body">{step.body}</span>
              <span className="vq-welcome-step-foot">
                {step.cost === null ? '按次计费' : '每次 ' + step.cost + ' 积分'}
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>

        <div className="vq-welcome-note">
          <span>
            {typeof balance === 'number' ? '当前余额 ' + balance + ' 积分。' : '积分按次消耗，失败会原路退回。'}
            不够用时到「设置 → 积分」申请，管理员发放后立即到账。
          </span>
          <button type="button" className="vq-button vq-button--primary" onClick={onDone}>
            直接进工作台
            <ArrowRight size={14} />
          </button>
        </div>

        <footer className="vq-welcome-foot">
          <a className="vq-link" href="#/legal/terms">服务条款</a>
          <a className="vq-link" href="#/legal/privacy">隐私说明</a>
          {site.supportEmail ? <span>联系：{site.supportEmail}</span> : <span>遇到问题找工作区管理员</span>}
          {site.icp ? <span>{site.icp}</span> : null}
        </footer>
      </div>
    </main>
  )
}
