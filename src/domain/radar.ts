export type Platform = 'douyin' | 'xiaohongshu'

export type MediaItem = {
  id: string
  platform: Platform
  platformLabel: string
  title: string
  author: string
  authorId?: string
  cover: string
  url: string
  publishedAt: string
  durationSec: number | null
  stats: { likes: number; comments: number; shares: number; collects: number }
  mock?: boolean
}

export type QuotaNotice = {
  code: string
  message: string
  rechargeUrl?: string
  goodsName?: string
}

export type SearchResult = {
  mode: 'live' | 'mock'
  items: MediaItem[]
  total: number
  note?: string
  quota?: QuotaNotice
}

export type ScriptBeat = {
  beat: string
  startSec: number
  endSec: number
  voiceover: string
  onScreen: string
  purpose: string
}

export type StoryboardShot = {
  shotNo: number
  startSec: number
  endSec: number
  frameIndex: number
  frameUrl?: string
  visual: string
  camera: string
  caption: string
  audio: string
  purpose: string
}

export type TemplateAnalysis = {
  pacing: string
  viralPoints: string[]
  reusableRules: string[]
  targetAudience: string
}

export type ReplicaTemplate = {
  thumb?: string
  id: string
  title: string
  contentType: string
  tags: string[]
  platform: Platform
  platformLabel: string
  sourceUrl: string
  sourceId: string
  author: string
  publishedAt: string
  stats: MediaItem['stats']
  durationSec: number
  hook: string
  hookType: string
  structure: ScriptBeat[]
  storyboard: StoryboardShot[]
  analysis: TemplateAnalysis
  frames: { index: number; t: number; url: string }[]
  cover: string
  video: { width: number; height: number; fps: number; duration: number }
  origin: 'ai' | 'manual'
  reuseCount: number
  createdAt: string
}

export type JobLog = { at: string; text: string }

export type ReplicateJob = {
  id: string
  status: 'running' | 'done' | 'error'
  step: string
  progress: number
  logs: JobLog[]
  error: string | null
  templateId: string | null
  createdAt: string
}

export type TemplateList = { items: ReplicaTemplate[]; total: number; byType: Record<string, number> }
