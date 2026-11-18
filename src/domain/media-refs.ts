// 参考素材挂到哪种生成方式上（r228）：出图 / 出视频两个面板共用这段判断。
//
// 为什么要单独抽出来：服务端 media-models 给每个方式定了 imageRefs / videoRefs 与 maxRefs，
// 而界面以前只判 maxRefs === 0（「这个方式不收素材」），于是：
//   1) 视频页签里拿一条生成的视频当参考，当前方式可能收图不收视频，界面不拦，等服务端 400；
//   2) 托架放满时只说「最多 N 个」，不说同一模型里哪个方式还放得下；
//   3) 「最近生成」的结果只能下载，出图 → 拿它当参考接着改这一步要人手传一遍。
// 现在把「放不放得下、要不要换方式、换哪个」收敛成一个可单测的结论，界面只照结论改状态。

export type RefKind = 'image' | 'video'

export type RefMode = {
  id: string
  label: string
  minRefs: number
  maxRefs: number
  imageRefs: number
  videoRefs: number
}

export type AttachPlan =
  | { ok: true; modeId: string; modeLabel: string; switched: boolean }
  | { ok: false; reason: 'duplicate' }
  | { ok: false; reason: 'no-mode'; kind: RefKind }
  | {
      ok: false
      reason: 'full'
      kind: RefKind
      modeLabel: string
      capacity: number
      alternative: { id: string; label: string } | null
    }

const UNIT = { image: '张参考图', video: '段参考视频' }

/** 这个方式收不收这种素材：与服务端按 mode.imageRefs / videoRefs 判的是同一套规则。 */
export function modeTakes(mode: RefMode | null | undefined, kind: RefKind): boolean {
  if (!mode) return false
  return kind === 'video' ? mode.videoRefs > 0 : mode.imageRefs > 0
}

/** 这个方式能放几个这种素材：总上限与按种类的上限取小的那个（多模态参考是 9 图 / 3 视频）。 */
export function modeCapacity(mode: RefMode, kind: RefKind): number {
  const byKind = kind === 'video' ? mode.videoRefs : mode.imageRefs
  return Math.max(0, Math.min(Number(mode.maxRefs) || 0, Number(byKind) || 0))
}

export function planRefAttach(input: {
  modes: RefMode[]
  current: RefMode | null | undefined
  kind: RefKind
  /** 托架里现在有几个参考素材 */
  count: number
  alreadyIn: boolean
}): AttachPlan {
  if (input.alreadyIn) return { ok: false, reason: 'duplicate' }
  const modes = Array.isArray(input.modes) ? input.modes : []
  const target = modeTakes(input.current, input.kind)
    ? (input.current as RefMode)
    : modes.find((mode) => modeTakes(mode, input.kind)) ?? null
  if (!target) return { ok: false, reason: 'no-mode', kind: input.kind }
  const capacity = modeCapacity(target, input.kind)
  if (input.count >= capacity) {
    // 同一模型里还有别的方式放得下：把名字说出来，别让人一个个试下拉
    const alternative =
      modes.find(
        (mode) =>
          mode.id !== target.id &&
          modeTakes(mode, input.kind) &&
          modeCapacity(mode, input.kind) > input.count,
      ) ?? null
    return {
      ok: false,
      reason: 'full',
      kind: input.kind,
      modeLabel: target.label,
      capacity,
      alternative: alternative ? { id: alternative.id, label: alternative.label } : null,
    }
  }
  return {
    ok: true,
    modeId: target.id,
    modeLabel: target.label,
    switched: target.id !== (input.current?.id ?? ''),
  }
}

/** 结论要变成人话：界面直接显示这句，别在组件里另写一套措辞。 */
export function refAttachNote(plan: AttachPlan): string {
  if (plan.ok) return plan.switched ? '已加入参考素材，生成方式切成「' + plan.modeLabel + '」' : '已加入参考素材'
  if (plan.reason === 'duplicate') return '这个素材已经在参考里了'
  if (plan.reason === 'no-mode') {
    return plan.kind === 'video' ? '当前模型没有收参考视频的方式' : '当前模型没有收参考图的方式'
  }
  const base = '「' + plan.modeLabel + '」最多 ' + plan.capacity + ' ' + UNIT[plan.kind]
  return plan.alternative ? base + '：想多放几个，先切到「' + plan.alternative.label + '」' : base + '：先移除一个'
}

/** 一条生成结果当素材时的文件名：带一段提示词（人认得出来）+ 任务号尾巴（不会撞名）。 */
export function taskFileName(task: { id: string; kind: RefKind; prompt: string; file?: { mime: string } | null }, mime = ''): string {
  const guessed = mime || task.file?.mime || (task.kind === 'video' ? 'video/mp4' : 'image/png')
  const ext = guessed.includes('webm')
    ? 'webm'
    : guessed.startsWith('video/')
      ? 'mp4'
      : guessed.includes('jpeg')
        ? 'jpg'
        : guessed.includes('webp')
          ? 'webp'
          : 'png'
  // 提示词里的空格、斜杠、冒号在文件名里一律换成连字符；截断后再把两端剩下的标点削掉，
  // 否则会出现「…暖色，-Sample.png」这种拖着一个逗号的名字。
  const stem =
    String(task.prompt || '')
      .replace(/[\s\\/:*?"<>|]+/g, '-')
      .slice(0, 16)
      .replace(/^[-，。、：；！？·]+|[-，。、：；！？·]+$/g, '') || '生成结果'
  const tail = String(task.id || '').replace(/^mgen_/, '').slice(-6) || 'result'
  return stem + '-' + tail + '.' + ext
}
