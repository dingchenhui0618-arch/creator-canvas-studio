// 作品分享的公开视图。
//
// 分享链接发给没有账号的人（甲方、剪辑），所以这里只做一件事：逐字段挑出可以公开的内容，
// 不做「整条对象去掉几个 key」——以后给作品加内部字段（积分、画布、模板 id、账号）
// 不会自动漏到公开链接上。
import path from 'node:path'
import { config } from './config.mjs'
import { deliveredCurrent } from './project-status.mjs'

// 分镜最多展示 12 镜：再多读者不会看，页面也会变成一条无限长的清单
const MAX_STORYBOARD = 12

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}
const text = (value, max) => String(value ?? '').slice(0, max)

function beatView(beat, index) {
  const row = {
    beat: text(beat?.beat || '第 ' + (index + 1) + ' 段', 40),
    startSec: num(beat?.startSec),
    endSec: num(beat?.endSec),
    voiceover: text(beat?.voiceover, 400),
    onScreen: text(beat?.onScreen, 200),
    purpose: text(beat?.purpose, 120),
  }
  if (num(beat?.expectedSec)) row.expectedSec = num(beat.expectedSec)
  if (beat?.fit) row.fit = String(beat.fit)
  return row
}

function timingView(timing) {
  if (!timing) return null
  return {
    estimatedSec: num(timing.estimatedSec),
    actualSec: num(timing.actualSec),
    durationSec: num(timing.durationSec),
    fit: String(timing.fit || ''),
    pace: String(timing.pace || ''),
    overSec: num(timing.overSec),
    tight: num(timing.tight),
    loose: num(timing.loose),
  }
}

function shotView(shot, token, framesByIndex) {
  const frameIndex = Math.round(num(shot?.frameIndex))
  const hasFrame = frameIndex > 0 && framesByIndex.has(frameIndex)
  return {
    shotNo: Math.round(num(shot?.shotNo)),
    startSec: num(shot?.startSec),
    endSec: num(shot?.endSec),
    visual: text(shot?.visual, 300),
    camera: text(shot?.camera, 80),
    caption: text(shot?.caption, 160),
    audio: text(shot?.audio, 160),
    frameUrl: hasFrame ? '/api/share/project/' + encodeURIComponent(token) + '/frame/' + frameIndex : '',
  }
}

/**
 * 评审评的那张帧图，在分享页的帧图接口里是第几帧。
 * 只认模板自己记下的帧记录（文件基线名要比得上），绝不按文件名拼地址：
 * 分享页的 /frame/<n> 是按帧序号取图，拼错一个数就是别人的画面。
 */
export function shareFrameIndex(template, image) {
  if (!template?.id || !image || image.templateId !== template.id) return 0
  const frames = Array.isArray(template.frames) ? template.frames : []
  const frame = frames.find((entry) => path.basename(String(entry?.url || '')) === image.file)
  const index = Math.round(Number(frame?.index) || 0)
  return index > 0 ? index : 0
}

/** 分镜帧图落在 framesDir/<模板 id>/<文件名>：路径只从画布帧记录里取，不接受外部拼路径。 */
export function frameFileOf(template, frameIndex) {
  const frames = Array.isArray(template?.frames) ? template.frames : []
  const frame = frames.find((entry) => String(entry.index) === String(frameIndex))
  if (!frame || !template?.id) return ''
  const name = path.basename(String(frame.url || ''))
  if (!name) return ''
  return path.join(config.framesDir, String(template.id), name)
}

export function publicProjectView({ project, template, script, reviews, runs, token }) {
  const framesByIndex = new Map()
  for (const frame of Array.isArray(template?.frames) ? template.frames : []) {
    framesByIndex.set(Math.round(num(frame?.index)), frame)
  }
  const storyboard = (Array.isArray(template?.storyboard) ? template.storyboard : [])
    .slice(0, MAX_STORYBOARD)
    .map((shot) => shotView(shot, token, framesByIndex))
  const beats = Array.isArray(script?.structure) ? script.structure.map(beatView) : []
  const shots = Array.isArray(template?.storyboard) ? template.storyboard.length : 0
  const counter = reviews || { count: 0, lastVerdict: '', lastAt: '' }
  return {
    project: {
      title: text(project.title, 80),
      // 交付看的是「这一版交没交」：交过 v2 又开了 v3，分享页不能写已交付
      status: deliveredCurrent(project) ? 'done' : 'active',
      version: Math.max(0, Math.round(num(project.version))),
      createdAt: String(project.createdAt || ''),
      updatedAt: String(project.updatedAt || ''),
    },
    template: template
      ? {
          title: text(template.title, 80),
          platformLabel: text(template.platformLabel, 20),
          contentType: text(template.contentType, 40),
          durationSec: num(template.durationSec),
          beats: Array.isArray(template.structure) ? template.structure.length : 0,
          shots,
        }
      : null,
    script: script
      ? {
          hook: text(script.hook, 200),
          structure: beats,
          // 脚本是作品自己的版本，还是仍然跟随模板
          source: script.source === 'project' ? 'project' : 'template',
          timing: timingView(script.timing),
        }
      : null,
    storyboard,
    stats: {
      beats: beats.length,
      shots,
      reviews: Math.max(0, Math.round(num(counter.count))),
      lastVerdict: String(counter.lastVerdict || ''),
      lastAt: String(counter.lastAt || ''),
      runs: Math.max(0, Math.round(num(runs))),
    },
    sharedAt: String(project.share?.createdAt || ''),
  }
}
