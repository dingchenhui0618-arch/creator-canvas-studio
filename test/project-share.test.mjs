import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品级只读分享：链接本身就是凭证（random token），公开视图只走白名单字段。
// 这一组盯住三件事：开/停真的生效、旧 token 立即失效、公开数据里没有账号与画布。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-share-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T09:00:00.000Z'
fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      {
        id: 'prj_share',
        ownerId: 'u_a',
        title: '毛衣叠放',
        templateId: 'tpl_a',
        flowId: 'flow_now',
        version: 3,
        versions: [{ n: 1, flowId: 'flow_v1', name: '第一版', archivedAt: now }],
        script: {
          hook: '毛衣别再乱塞',
          structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '毛衣别再乱塞', onScreen: '', purpose: '' }],
          updatedAt: now,
        },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'prj_plain',
        ownerId: 'u_b',
        title: '别人的作品',
        templateId: 'tpl_b',
        flowId: '',
        version: 0,
        versions: [],
        script: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ],
    null,
    2,
  ),
  'utf8',
)

const p = await import('../server/projects.mjs')
const { publicProjectView, frameFileOf, shareFrameIndex } = await import('../server/project-share.mjs')

test('分享链接能开能停，停止后旧 token 立即失效，重新开启换一条', async () => {
  const first = await p.enableProjectShare('prj_share', { id: 'u_a' })
  assert.ok(first.token.length >= 16, 'token 不能太短')
  const found = await p.getProjectByShareToken(first.token)
  assert.equal(found.id, 'prj_share')
  assert.ok(found.share.createdAt, '作品上记下分享时间')
  // 只有归属账号能开：别人的作品连 token 都拿不到
  assert.equal(await p.enableProjectShare('prj_share', { id: 'u_b' }), null)
  // 停止分享：旧地址失效，再开换一条新地址
  assert.equal(await p.disableProjectShare('prj_share', { id: 'u_a' }), true)
  assert.equal(await p.getProjectByShareToken(first.token), null)
  const again = await p.enableProjectShare('prj_share', { id: 'u_a' })
  assert.notEqual(again.token, first.token)
  // 明显不合法的 token 不查盘、不命中
  assert.equal(await p.getProjectByShareToken('short'), null)
  assert.equal(await p.disableProjectShare('prj_share', { id: 'u_b' }), null, '别人的作品停不了')
  await p.disableProjectShare('prj_share', { id: 'u_a' })
})

test('公开视图只给白名单字段：没有账号、画布、模板 id 与版本历史', () => {
  const project = {
    id: 'prj_share',
    ownerId: 'u_a',
    title: '毛衣叠放',
    status: 'done',
    version: 3,
    flowId: 'flow_now',
    versions: [{ n: 1, flowId: 'flow_v1', name: '第一版' }],
    share: { token: 'tok_secret', createdAt: now },
    createdAt: now,
    updatedAt: now,
  }
  const template = {
    id: 'tpl_a',
    title: '收纳模板',
    platformLabel: '抖音',
    durationSec: 30,
    structure: [{ beat: '开场' }, { beat: '中段' }],
    storyboard: Array.from({ length: 13 }, (_, index) => ({
      shotNo: index + 1,
      startSec: index,
      endSec: index + 1,
      frameIndex: index + 1,
      visual: '画面 ' + (index + 1),
      camera: '',
      caption: '',
      audio: '',
    })),
    frames: [{ index: 1, url: '/media/frames/tpl_a/f1.jpg' }],
    analysis: { pacing: '快', viralPoints: ['内部判断'] },
  }
  const script = {
    hook: '毛衣别再乱塞',
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '毛衣别再乱塞', onScreen: '叠衣', purpose: '' }],
    source: 'project',
    timing: { estimatedSec: 3, actualSec: 30, durationSec: 30, fit: 'loose', pace: 'normal', overSec: 0, tight: 0, loose: 0 },
  }
  const view = publicProjectView({
    project,
    template,
    script,
    reviews: { count: 2, lastVerdict: 'pass', lastAt: now },
    runs: 4,
    token: 'tok_secret',
  })

  assert.deepEqual(Object.keys(view).sort(), ['project', 'script', 'sharedAt', 'stats', 'storyboard', 'template'])
  assert.ok(!('ownerId' in view.project) && !('id' in view.project), '公开视图不带账号与作品 id')
  assert.equal(view.project.title, '毛衣叠放')
  assert.equal(view.project.status, 'done')
  assert.ok(!('id' in view.template), '模板 id 是内部引用，不给')
  assert.equal(view.template.title, '收纳模板')
  assert.equal(view.template.beats, 2)
  assert.equal(view.template.shots, 13)
  // 分镜最多 12 镜；帧图走带 token 的地址，只有真的存在那一帧才给
  assert.equal(view.storyboard.length, 12)
  assert.equal(view.storyboard[0].frameUrl, '/api/share/project/tok_secret/frame/1')
  assert.equal(view.storyboard[1].frameUrl, '')
  assert.equal(view.stats.beats, 1)
  assert.equal(view.stats.reviews, 2)
  assert.equal(view.stats.lastVerdict, 'pass')
  assert.equal(view.stats.runs, 4)
  assert.equal(view.script.source, 'project')
  assert.equal(view.script.timing.pace, 'normal')
  assert.equal(view.sharedAt, now)
  // 内部判断（爆点等）不跟着分享出去
  assert.ok(!JSON.stringify(view).includes('内部判断'))
})

test('模板被删掉时分享页仍能看作品自己的脚本，分镜与帧图退回空', () => {
  const project = {
    title: '只剩脚本',
    status: 'active',
    version: 0,
    createdAt: now,
    updatedAt: now,
    share: { token: 'tok_x', createdAt: now },
  }
  const view = publicProjectView({ project, template: null, script: null, reviews: null, runs: 0, token: 'tok_x' })
  assert.equal(view.template, null)
  assert.equal(view.script, null)
  assert.deepEqual(view.storyboard, [])
  assert.equal(view.stats.reviews, 0)
  assert.equal(view.stats.runs, 0)
  assert.equal(view.project.status, 'active')
})

test('评审评的那一帧：只在模板自己的帧记录里找序号，找不到就不给图', () => {
  const template = {
    id: 'tpl_a',
    frames: [
      { index: 3, url: '/media/frames/tpl_a/frame-03.jpg' },
      { index: 5, url: '/media/frames/tpl_a/frame-05.jpg' },
    ],
  }
  assert.equal(shareFrameIndex(template, { templateId: 'tpl_a', file: 'frame-05.jpg' }), 5)
  assert.equal(shareFrameIndex(template, { templateId: 'tpl_a', file: 'frame-01.jpg' }), 0, '记录里没有这一帧就不猜')
  assert.equal(shareFrameIndex(template, { templateId: 'tpl_b', file: 'frame-05.jpg' }), 0, '别的模板的帧不给')
  assert.equal(shareFrameIndex(null, { templateId: 'tpl_a', file: 'frame-05.jpg' }), 0)
  assert.equal(shareFrameIndex(template, null), 0)
})

test('帧图路径只从模板的帧记录里取，不认外部拼的路径', () => {
  const template = { id: 'tpl_a', frames: [{ index: 2, url: '/media/frames/tpl_a/002.jpg' }] }
  assert.ok(frameFileOf(template, 2).endsWith(path.join('tpl_a', '002.jpg')))
  assert.equal(frameFileOf(template, 3), '', '没有这一帧就不给路径')
  const escaped = frameFileOf({ id: 'tpl_a', frames: [{ index: 1, url: '../../secret' }] }, 1)
  assert.ok(escaped.endsWith(path.join('tpl_a', 'secret')), '路径段被 basename 削平，拼不出上级目录')
  assert.ok(!escaped.includes('..'), '不会把 ../ 带进文件路径')
})
