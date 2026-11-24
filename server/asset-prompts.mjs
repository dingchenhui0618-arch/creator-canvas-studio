// 自有资产（r311）：产品资产与数字人资产的槽位定义和出图提示词。
//
// 为什么把提示词单独放一个文件：这是「同一个商品 / 同一张脸在四张图里还是不是它」的唯一开关，
// 改动它等于改产品质量，必须能单测、能一眼对比版本，不该藏在路由的字符串拼接里。
//
// 三条写法上的硬约束（每一条都是为了让模型少自由发挥）：
//  1) 明写「严格保持参考图中的商品/人物的 X、Y、Z 不变」，并逐个点名形状、颜色、材质、logo、
//     五官、发型、肤色 —— 只写「保持商品不变」模型会当成风格建议；
//  2) 明写「不出现任何文字、水印」：电商图最容易被模型顺手加上一排英文小字，那种图不能直接用；
//  3) 每张图只改一个变量（背景 / 视角 / 景别 / 场景），四张一起改模型就守不住主体了。

export const ASSET_KINDS = ['product', 'avatar']

// 槽位顺序就是生成顺序，也是界面上从左到右的顺序：
// 先出最能验收的一张（白底主图 / 正面定妆），一眼就知道这个主体有没有被守住。
export const ASSET_SLOTS = {
  product: [
    { slot: 'hero', label: '白底主图', hint: '电商第一张：纯白背景、商品居中' },
    { slot: 'scene', label: '场景图', hint: '真实使用场景，背景虚化' },
    { slot: 'detail', label: '细节特写', hint: '材质、缝线或按键的微距' },
    { slot: 'pack', label: '成套平铺', hint: '商品与配件俯拍平铺' },
  ],
  avatar: [
    { slot: 'front', label: '正面定妆', hint: '肩部以上、看镜头、中性表情' },
    { slot: 'half', label: '半身景别', hint: '微微侧身、自然微笑' },
    { slot: 'side', label: '侧脸角度', hint: '三分之四侧脸，同一张脸' },
    { slot: 'action', label: '场景中使用', hint: '室内环境、生活化抓拍' },
  ],
}

// 出图尺寸：商品图要方图（详情页 / 主图都吃 1:1），人像要竖图（小红书 / 抖音封面都是竖的）
export const ASSET_SIZE = {
  product: '1024x1024',
  avatar: '1024x1536',
}

const NO_TEXT = '画面里不出现任何文字、水印或叠加的 logo。'

const PRODUCT_PROMPTS = {
  hero:
    '电商商品白底主图。严格保持参考图中商品的形状、轮廓、颜色、材质、纹理、logo 与包装文字完全不变，' +
    '不要新增或删掉任何部件，不要改变比例。商品居中，正面或 45 度视角，纯白背景（#FFFFFF），' +
    '柔和均匀的摄影棚光，干净利落的投影。高分辨率商品摄影。' + NO_TEXT,
  scene:
    '把参考图中同一件商品放进真实生活场景：浅色木质桌面与米白墙面，自然窗光，浅景深背景虚化，' +
    '商品保持完全一致（形状、颜色、材质、logo 都不变）。生活方式静物摄影，构图干净、留白充足。' + NO_TEXT,
  detail:
    '参考图中商品的关键细节特写：材质纹理、缝线、logo 或按键处，微距镜头，浅景深，光线柔和。' +
    '保持与参考图是同一件商品：颜色、材质与结构完全一致，不要臆造不存在的部件。' + NO_TEXT,
  pack:
    '参考图中的同一件商品与它的配件、包装一起俯拍平铺（flat lay），米白背景，柔和阴影，' +
    '构图整齐留白，商品外观保持一致。' + NO_TEXT,
}

const AVATAR_PROMPTS = {
  front:
    '人物正面定妆照。严格保持参考图中人物的脸型、五官比例、眼睛形状、鼻子、嘴型、发型与肤色完全一致，' +
    '必须是同一个人，不要美化、不要换脸。中性自然的轻微微笑，看向镜头，肩部以上半身，' +
    '纯浅灰色背景，柔和均匀的棚拍光，真实摄影质感。' + NO_TEXT,
  half:
    '保持参考图中人物的脸型、五官、发型与肤色完全不变（必须还是同一个人）的半身像，' +
    '身体微微侧转十五度，自然微笑看向镜头，浅米色背景，柔和自然光，真实摄影质感。' + NO_TEXT,
  side:
    '保持参考图中人物的五官、发型与肤色不变（是同一张脸）的三分之四侧脸，肩部以上，视线看向镜头，' +
    '简洁浅色背景，柔光，真实摄影质感。' + NO_TEXT,
  action:
    '保持参考图中人物的脸型、五官、发型与肤色不变（是同一张脸），在明亮的室内环境自然站立，' +
    '手持手机，半身取景，生活方式抓拍风格，背景轻微虚化，真实摄影质感。' + NO_TEXT,
}

const PROMPTS = { product: PRODUCT_PROMPTS, avatar: AVATAR_PROMPTS }

export function validAssetKind(value) {
  return ASSET_KINDS.includes(String(value || '')) ? String(value) : ''
}

export function slotsFor(kind) {
  return ASSET_SLOTS[validAssetKind(kind)] || []
}

export function slotSpec(kind, slot) {
  return slotsFor(kind).find((item) => item.slot === String(slot || '')) || null
}

/**
 * 拼一条出图提示词：主体信息在前（模型先读到「这是什么」），约束在后（读完再确认一遍）。
 * name / category 是用户自己填的，只做长度裁剪，不做任何美化。
 */
export function buildAssetPrompt({ kind, slot, name = '', category = '' } = {}) {
  const spec = slotSpec(kind, slot)
  const body = PROMPTS[validAssetKind(kind)]?.[spec?.slot]
  if (!body) return ''
  const subject = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const group = String(category || '').replace(/\s+/g, ' ').trim().slice(0, 20)
  const head = kind === 'product' ? '这是一件商品' : '这是一个真人照片'
  const intro = subject
    ? head + '，名称：' + subject + (group ? '（类目：' + group + '）' : '') + '。'
    : head + '。'
  return intro + body
}

/** 一次生成 4 张：返回 [{ slot, label, prompt, size }]，给 Worker 按顺序跑。 */
export function assetJobPlan({ kind, name = '', category = '' } = {}) {
  const size = ASSET_SIZE[validAssetKind(kind)] || ASSET_SIZE.product
  return slotsFor(kind).map((item) => ({
    slot: item.slot,
    label: item.label,
    prompt: buildAssetPrompt({ kind, slot: item.slot, name, category }),
    size,
  }))
}
