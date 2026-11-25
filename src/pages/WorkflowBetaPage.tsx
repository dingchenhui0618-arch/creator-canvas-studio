// 工作流 Beta 落地页（r313）：非管理员从收藏、旧链接、命令面板进来时落在这里。
//
// 不是错误页：工作流没删，只是收回给管理员。所以语气是「还在重做 + 这几个地方可以先做」，
// 而不是「你没有权限」。页面上不出现节点、流程、运行这些词，免得再把人往那边引。
import { Link2, LayoutTemplate, Radar, Sparkles } from 'lucide-react'
import { WORKFLOW_BETA_NOTE, WORKFLOW_BETA_TITLE } from '../domain/features'

export default function WorkflowBetaPage({ onGo }: { onGo: (page: 'overview' | 'radar' | 'templates' | 'agents') => void }) {
  return (
    <div className="vq-page vq-workflow-beta">
      <div className="vq-workflow-beta-card">
        <span className="vq-workflow-beta-kicker">Beta / Admin only</span>
        <h1>{WORKFLOW_BETA_TITLE}</h1>
        <p>{WORKFLOW_BETA_NOTE}</p>
        <div className="vq-workflow-beta-links">
          <button type="button" className="vq-button vq-button--primary" onClick={() => onGo('radar')}>
            <Radar size={15} />
            去爆款雷达找一条
          </button>
          <button type="button" className="vq-button" onClick={() => onGo('templates')}>
            <LayoutTemplate size={15} />
            打开模板库
          </button>
          <button type="button" className="vq-button" onClick={() => onGo('agents')}>
            <Sparkles size={15} />
            去快捷创作
          </button>
        </div>
        <p className="vq-workflow-beta-foot">
          <Link2 size={13} aria-hidden="true" />
          收藏的旧工作流链接仍然可用，只是这个账号现在打不开它。
        </p>
      </div>
    </div>
  )
}
