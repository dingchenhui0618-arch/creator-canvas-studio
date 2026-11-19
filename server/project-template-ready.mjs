// 这条作品现在能不能沉淀成模板（r252）。
//
// 同一件事有两个页面要问：作品页要显示「存成模板」那张卡片，评审页要在结论是「通过」时
// 直接给一个「存成模板」的出口。两处必须同一个判断——否则会出现「按钮在、点了报错」或者
// 「明明能存却没有入口」。判断本身还在 project-template.mjs（纯函数），这里只负责把
// 作品需要的模板与脚本读出来。
import { getTemplate } from './templates.mjs'
import { scriptView } from './project-script.mjs'
import { projectTemplateSpec } from './project-template.mjs'

export async function projectTemplateReady(project, user = null) {
  const template = project?.templateId ? await getTemplate(project.templateId, user) : null
  const script = project ? scriptView(project, template) : null
  const spec = projectTemplateSpec({ project, template, script })
  return { ok: spec.status === 200, spec, template, script }
}
