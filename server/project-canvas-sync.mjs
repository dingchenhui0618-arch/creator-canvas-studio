// 改完脚本，把画布里自动生成的复刻提示词一起换掉（2026-11-13 从作品路由里抽出来，
// 智能体草稿写进作品那条路（v0.9.30）用的是同一份——两条入口改的是同一份脚本，不能两处口径）。
//
// 只认我们生成的那一版（标题「复刻脚本」+ 提示词开头是固定句），用户手改过的整块跳过：
// 页面之间不能各说各话，也不能把别人手写的提示词悄悄覆盖掉。
import { getFlow, updateFlow } from './flows.mjs'
import { patchCanvasScript } from './script-draft.mjs'

export async function syncCanvasScript(project, template, script, prevHook, user) {
  if (!project?.flowId) return { synced: false, flowId: '', reason: 'no-canvas' }
  const flow = await getFlow(project.flowId, user)
  if (!flow) return { synced: false, flowId: project.flowId, reason: 'canvas-missing' }
  const patched = patchCanvasScript(flow.nodes, { template, script, prevHook })
  // 画布里的提示词本来就是这份脚本：不是「手改过」，也不是「没同步」。
  // （以前这里一律报 hand-edited，同一份脚本存两次会得到「你手改过，没动」这种假话。）
  if (!patched.changed) {
    return { synced: patched.promptUpdated, flowId: flow.id, reason: patched.promptUpdated ? 'synced' : 'hand-edited' }
  }
  const updated = await updateFlow(flow.id, { nodes: patched.nodes })
  if (!updated) return { synced: false, flowId: flow.id, reason: 'save-failed' }
  // synced 只看提示词：输入节点跟着换了但提示词是手改过的，不能说「画布用的是新脚本」
  return { synced: patched.promptUpdated, flowId: flow.id, reason: patched.promptUpdated ? 'synced' : 'hand-edited' }
}
