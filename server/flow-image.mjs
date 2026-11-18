// 工作流「出图」节点：一次运行里真的画一张图，并把结果落到这次运行自己的目录。
//
// 为什么单独一个模块（而不是复用 /api/media/generate 那套后台任务）：
//  - 工作流的出图节点是同步语义：下游的评审节点要立刻拿到这张图，后台任务 + 轮询接不上下游；
//  - 但钱的规则必须和快捷创作一致：先扣后画、失败全额退、扣费单据能对上账；
//  - 文件放在 DATA_DIR/runs/<runId>/ 下，只有这次运行的主人能读（由路由层鉴权），
//    评审节点也可以直接用 runs/<runId>/<node>.png 这个相对路径读同一份字节。
//
// 诚实口径：真实出图会花上游额度。这里不做任何「假装成功」的兜底——上游没回图、下载失败、
// 积分不足都当节点失败处理，并在运行结果里写清原因。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { charge, outstandingCharge, refund } from './credits.mjs'
import { generateImage } from './gateway.mjs'
import { IMAGE_SIZES, defaultModelFor, findModel, listMediaModels } from './media-models.mjs'
import { downloadAsset, extensionFor } from './media-fetch.mjs'

export const FLOW_IMAGE_RATIOS = Object.keys(IMAGE_SIZES)
export const FLOW_IMAGE_DEFAULT_RATIO = '9:16'
const MAX_PROMPT = 1500
const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/

const RATIO_LABEL = { '1:1': '1:1 方形', '9:16': '9:16 竖版', '16:9': '16:9 横版' }

/** 检查器与运行前估价要用的选项：模型、比例、单价。全部来自 media-models 那张唯一真源。 */
export function imageNodeOptions() {
  const image = listMediaModels().image
  return {
    defaultModel: defaultModelFor('image'),
    defaultRatio: FLOW_IMAGE_DEFAULT_RATIO,
    models: image.map((item) => ({
      id: item.id,
      label: item.label,
      credits: Number(item.credits) || 0,
      verified: Boolean(item.verified),
    })),
    ratios: FLOW_IMAGE_RATIOS.map((ratio) => ({
      ratio,
      size: IMAGE_SIZES[ratio],
      label: RATIO_LABEL[ratio] || ratio,
    })),
  }
}

/** 节点单价：按所选模型的积分价；模型不认识时回落到默认模型的价。 */
export function imageNodeCredits(model) {
  const spec = findModel('image', model) || findModel('image', defaultModelFor('image'))
  return spec ? Number(spec.credits()) || 0 : 0
}

/** 这次运行里 K 个出图节点一共要花多少积分（运行前提示用，服务端按节点真扣）。 */
export function imageNodesCost(nodes, model) {
  const count = (Array.isArray(nodes) ? nodes : []).filter((node) => (node?.type || node?.data?.kind) === 'image').length
  return count * imageNodeCredits(model)
}

/** 运行目录：DATA_DIR/runs/<runId>；runId 不合法直接拒绝，避免拼出越界路径。 */
export function runDirOf(runId) {
  const id = String(runId || '')
  if (!SAFE_ID.test(id)) throw new Error('运行编号不合法，无法保存出图结果')
  return path.join(config.dataDir, 'runs', id)
}

/** 运行产物的绝对路径：只允许 runs/<runId>/ 下的一层文件名，不允许子目录与 .. */
export function runAssetPath(runId, fileName) {
  const name = String(fileName || '')
  if (!/^[A-Za-z0-9_-]{4,80}\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return ''
  const dir = runDirOf(runId)
  const target = path.join(dir, name)
  return target.startsWith(dir + path.sep) ? target : ''
}

/**
 * 真跑一次出图：扣费 → 调平台出图通道 → 下载落盘 → 返回可访问地址。
 * 任何一步失败都把这笔扣费退回去（按账本净额，重复调用不会多退），然后抛错给运行引擎记失败。
 */
export async function runImageGeneration({ ownerId, runId, nodeId, prompt, ratio = FLOW_IMAGE_DEFAULT_RATIO, model = '' } = {}) {
  const text = String(prompt ?? '').trim().slice(0, MAX_PROMPT)
  if (!text) throw new Error('出图节点没有提示词：在检查器里填写提示词，或把上游文本接到它上面')
  const spec = findModel('image', model) || findModel('image', defaultModelFor('image'))
  if (!spec) throw new Error('没有可用的出图模型：检查后台的模型与密钥')
  const size = IMAGE_SIZES[ratio] || IMAGE_SIZES[FLOW_IMAGE_DEFAULT_RATIO]
  const credits = Number(spec.credits()) || 0
  const ref = ('run:' + runId + ':' + nodeId).slice(0, 190)
  // 目录先算出来：runId 不合法要在扣费之前就失败，不然钱扣了却存不下结果
  const dir = runDirOf(runId)
  const paid = charge(ownerId, 'image_gen', {
    ref,
    amount: credits,
    meta: { label: '工作流出图 · ' + text.slice(0, 36) },
  })
  if (!paid.ok) {
    throw new Error('积分不足：这次出图需要 ' + credits + ' 积分，当前余额 ' + (paid.balance ?? 0) + ' 积分')
  }
  try {
    const result = await generateImage({ model: spec.id, prompt: text, size, n: 1 })
    const url = Array.isArray(result?.urls) ? result.urls[0] : ''
    if (!url) throw new Error('出图上游没有返回图片地址')
    const asset = await downloadAsset(url, 'image')
    const ext = extensionFor(asset.mime, 'image', '')
    const fileName = nodeId + '.' + ext
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.writeFile(path.join(dir, fileName), asset.buffer, { mode: 0o600 })
    const ratioLabel = RATIO_LABEL[ratio] || ratio
    return {
      // 节点输出的一段人话：作品流与运行记录都会显示它
      text: '出图完成：' + spec.label + ' · ' + ratioLabel + '（' + size + '）· 本次 ' + credits + ' 积分\n提示词：' + text,
      imagePath: 'runs/' + runId + '/' + fileName,
      imageUrl: '/api/runs/' + runId + '/assets/' + fileName,
      model: spec.id,
      modelLabel: spec.label,
      ratio,
      size,
      bytes: asset.buffer.length,
      mime: asset.mime,
      credits,
    }
  } catch (error) {
    try {
      const owed = outstandingCharge(ownerId, 'image_gen', ref)
      if (owed > 0) refund(ownerId, 'image_gen', { ref, amount: owed, meta: { label: '工作流出图失败退款' } })
    } catch {
      // 退款失败不该掩盖真正的失败原因；账本里还留着这笔待退，后台能看到
    }
    throw error
  }
}
