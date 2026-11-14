// 只读分享的离线包：拿到链接的人不用登录，也能把这一版的现场页、评审对照和帧图带走。
//
// 边界：
//  1. 包里只放分享页已经展示过的东西：前 12 镜、这一版的脚本、每版最近一次评审、已打开时的两版对照。
//     不另开一扇门：作品编号、归属账号、画布、模板 id、原始素材路径与 token 都不进包。
//  2. 没有评审 / 没有帧图 / 没有上一版时照实少放文件，不拿别的东西顶，说明里也不写不存在的文件。
//  3. 两版对照只在分享者已经打开开关时进包；离线包的凭据仍是同一条分享链接，停用后地址打不开。
//  4. 包里带一页「校验.html」：收包人（通常没有账号）解压后双击，把 zip 拖进去，就在自己机器上
//     逐条重算 CRC32、再算整包 SHA-256。清单只列包内文件名与字节，不含作品编号、token 与内部路径。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { aiLabelFootText } from './ai-label.mjs'
import { packageVerifyHtml, VERIFY_PAGE_NAME } from './package-verify-page.mjs'
import { compareSheetHtml } from './project-compare-sheet.mjs'
import { versionCompareView } from './project-compare.mjs'
import { storyboardFrames } from './project-frames.mjs'
import { reviewImageRef, reviewSheetHtml } from './project-review-sheet.mjs'
import { setSheetHtml } from './project-set-sheet.mjs'
import { buildZip } from './zip-store.mjs'

// 与分享页同一个上限：页面上只展示前 12 镜，包里也不多放。
export const SHARE_BUNDLE_SHOTS = 12

const pad2 = (value) => String(value).padStart(2, '0')

function stamp(value, tzOffsetMinutes) {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return '时间未知'
  const date = new Date(ms + tzOffsetMinutes * 60000)
  return (
    date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

/** 下载文件名只留作品名与版次：不带作品编号，也不让路径字符跑进响应头。 */
export function shareBundleFileName(project) {
  const title = String(project?.title || '未命名作品')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '未命名作品'
  const version = Math.max(0, Math.round(Number(project?.version) || 0))
  return 'VisionQA-' + title + '-v' + version + '-离线包.zip'
}

/**
 * 包里那张说明。只写包里真的有的文件；不写作品编号、token 与内部路径。
 */
export function shareBundleNote({
  project = {},
  generatedAt = new Date(),
  tzOffsetMinutes = 480,
  frameCount = 0,
  reviewSheetCount = 0,
  comparePair = null,
  shotTotal = 0,
} = {}) {
  const lines = [
    'VisionQA 离线包',
    '',
    '作品：' + (String(project.title || '').trim() || '未命名作品') + '（v' + (Number(project.version) || 0) + '）',
    '导出：' + stamp(generatedAt, tzOffsetMinutes),
    '',
    '现场页.html      只带脚本与分镜的一张 A4（含原片帧图），双击打开就能打印 / 存 PDF',
    ...(reviewSheetCount
      ? ['评审对照页.html  评审说过的问题框在当时的画面上；左边框上的编号就是右边问题列表的编号']
      : []),
    ...(comparePair
      ? ['两版对照页.html  v' + comparePair.base + ' → v' + comparePair.target + ' 的画布参数、脚本口播、评审与交付并排']
      : []),
    '校验.html        收包人自己验包：把收到的 zip 拖进去，逐条比 CRC32，对不上的点名；不上传、不联网、不要账号',
    frameCount
      ? 'frames/          原片帧图 ' + frameCount + ' 张，按镜头编号命名（shot-01.jpg …），与现场页一一对应'
      : 'frames/          这条作品没有可打包的帧图：模板待解析，或者抽帧没有落盘',
    ...(shotTotal > SHARE_BUNDLE_SHOTS
      ? ['镜头：分享页只展示前 ' + SHARE_BUNDLE_SHOTS + ' 镜，离线包也只放这 ' + SHARE_BUNDLE_SHOTS + ' 镜（原片共 ' + shotTotal + ' 镜）；其余在作品页看。']
      : []),
    '',
    '这份包来自只读分享链接：分享者停用后原链接会打不开，已经下载的包不受影响。',
    '包里不含账号、积分、完整画布、作品编号与分享 token。',
    '口径：口播与时长以脚本为准（按台词估算），镜头时间来自模板；改过脚本不会自动重排镜头时间。',
    '',
    aiLabelFootText(),
    '',
  ]
  return lines.join('\n')
}

/**
 * 生成分享离线包。
 * @param {object} args.project 归一化后的作品（含 share / versions / deliveries）
 * @param {object|null} args.template 绑定的模板；已删除时为 null
 * @param {object|null} args.script 当前这一版的脚本视图
 * @param {Array} args.reviewRecords 每版最近一次评审的完整记录（最多 3 版）
 * @param {Array} args.decisions 这条作品的拍板记录
 * @param {Date} args.now
 * @param {number} args.tzOffsetMinutes
 */
export async function buildShareBundle({
  project,
  template,
  script,
  reviewRecords = [],
  decisions = [],
  now = new Date(),
  tzOffsetMinutes = 480,
}) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Math.max(-720, Math.min(840, Math.round(Number(tzOffsetMinutes)))) : 480
  const publicProject = { title: project.title, version: project.version }
  const publicTemplate = template
    ? { ...template, storyboard: (Array.isArray(template.storyboard) ? template.storyboard : []).slice(0, SHARE_BUNDLE_SHOTS) }
    : null
  const frames = await storyboardFrames(publicTemplate, { limit: SHARE_BUNDLE_SHOTS })
  const packagedByFile = new Map(frames.map((frame) => [frame.file, frame.name]))
  const sheet = setSheetHtml({
    project: publicProject,
    script,
    template: publicTemplate,
    frameBase: 'frames/',
    availableFrames: new Set(frames.map((frame) => frame.name)),
    offline: true,
    generatedAt: now.toISOString(),
    tzOffsetMinutes: tz,
    projectId: '',
  })

  // 评审评的那张图如果就是包里某张分镜，直接复用；不在分镜里才复制进「评审/」。
  // 只复制这条模板自己的帧：分享页的评审纸也只认可映射到当前模板的那些。
  const reviewImages = new Map()
  const reviewExtras = []
  for (const record of reviewRecords) {
    const image = reviewImageRef(record.source)
    if (!image || !template?.id || image.templateId !== template.id) continue
    const packaged = packagedByFile.get(image.file)
    if (packaged) {
      reviewImages.set(record.id, 'frames/' + packaged)
      continue
    }
    try {
      const data = await fsp.readFile(path.join(config.framesDir, image.templateId, image.file))
      const name = '评审/对照-' + pad2(reviewExtras.length + 1) + '.jpg'
      reviewExtras.push({ name, data })
      reviewImages.set(record.id, name)
    } catch {
      // 帧图被清理过：评审纸只印问题与编号，不拿别的图顶
    }
  }

  const reviewSheet = reviewRecords.length
    ? reviewSheetHtml({
        project: publicProject,
        records: reviewRecords,
        decisions,
        now,
        tzOffsetMinutes: tz,
        projectId: '',
        offline: true,
        imageSrc: (block) => reviewImages.get(block.id) || '',
        imageNote: (block) => {
          const source = reviewImages.get(block.id)
          return source ? '画面：离线包里是 ' + source : ''
        },
      })
    : ''

  // 两版对照只跟着分享者已经打开的开关走：固定当前版 vs 上一版，不接受任意版次。
  let compareSheet = ''
  let comparePair = null
  const targetNo = Math.max(0, Math.round(Number(project.version) || 0))
  const baseNo = targetNo - 1
  const hasBase = baseNo >= 1 && (Array.isArray(project.versions) ? project.versions : [])
    .some((entry) => Math.round(Number(entry?.n) || 0) === baseNo)
  if (project.share?.compare === true && hasBase) {
    const built = await versionCompareView(project, null, baseNo, targetNo)
    if (built.ok) {
      compareSheet = compareSheetHtml({
        project: publicProject,
        compare: built.view,
        now,
        tzOffsetMinutes: tz,
        projectId: '',
        offline: true,
      })
      comparePair = { base: baseNo, target: targetNo }
    }
  }

  const note = shareBundleNote({
    project,
    generatedAt: now,
    tzOffsetMinutes: tz,
    frameCount: frames.length,
    reviewSheetCount: reviewRecords.length,
    comparePair,
    shotTotal: Array.isArray(template?.storyboard) ? template.storyboard.length : 0,
  })
  // 校验页的清单要覆盖包内其它所有条目：先把它们排好，再生成页面、插回说明.txt 后面。
  // 页面本身不进清单（它没法记自己的哈希），与交付包里的那一页同一套判据。
  const entries = [
    { name: '现场页.html', data: Buffer.from(sheet, 'utf8') },
    ...(reviewSheet ? [{ name: '评审对照页.html', data: Buffer.from(reviewSheet, 'utf8') }] : []),
    ...(compareSheet ? [{ name: '两版对照页.html', data: Buffer.from(compareSheet, 'utf8') }] : []),
    { name: '说明.txt', data: Buffer.from(note, 'utf8') },
    ...frames.map((frame) => ({ name: 'frames/' + frame.name, data: frame.data })),
    ...reviewExtras,
  ]
  const verify = packageVerifyHtml({
    project: publicProject,
    zipName: shareBundleFileName(project),
    entries,
    generatedAt: now.toISOString(),
    tzOffsetMinutes: tz,
    packageKind: '离线包',
  })
  entries.splice(entries.findIndex((entry) => entry.name === '说明.txt') + 1, 0, {
    name: VERIFY_PAGE_NAME,
    data: Buffer.from(verify, 'utf8'),
  })
  const archive = buildZip(entries, { mtime: now })
  return {
    fileName: shareBundleFileName(project),
    archive,
    counts: {
      frames: frames.length,
      reviewSheet: Boolean(reviewSheet),
      compareSheet: Boolean(compareSheet),
      reviewExtras: reviewExtras.length,
    },
  }
}
