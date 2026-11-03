import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const dataDir = process.env.DATA_DIR || path.join(root, 'data')

function readLocalToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))
    return auth?.tokens?.access_token ?? ''
  } catch {
    return ''
  }
}

export const config = {
  port: Number(process.env.API_PORT || 8787),
  dataDir,
  framesDir: path.join(dataDir, 'frames'),
  videosDir: path.join(dataDir, 'videos'),
  templatesFile: path.join(dataDir, 'templates.json'),
  redfox: {
    key: (process.env.REDFOX_API_KEY || '').trim(),
    baseUrl: process.env.REDFOX_BASE_URL || 'https://redfox.hk',
    source: 'paperplane-radar/0.1',
  },
  vision: {
    baseUrl: process.env.VISION_BASE_URL || 'http://127.0.0.1:10100/v1',
    model: process.env.VISION_MODEL || 'gpt-6.1-sol',
    fallbacks: (process.env.VISION_FALLBACKS || 'gpt-6-luna,tokenrouter-agent/grok-4.6,gpt-6.1-terra,gpt-6-sol').split(',').map((item) => item.trim()).filter(Boolean),
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS || 300000),
    apiKey: (process.env.VISION_API_KEY || '').trim() || readLocalToken(),
  },
  limits: {
    maxVideoMb: Number(process.env.MAX_VIDEO_MB || 160),
    maxFrames: Number(process.env.MAX_FRAMES || 18),
  },
}

export const redfoxEnabled = () => Boolean(config.redfox.key)
export const visionEnabled = () => Boolean(config.vision.apiKey)
