import test from 'node:test'
import assert from 'node:assert/strict'

// 自备链接（r291）：用户把一条链接粘进来，平台要能自己判出这是什么、能不能拆。
// 这一组盯住两件事：
//   1) 判定规则对——抖音 / 小红书 / 直链 / 认不出，各自走对分支；
//   2) 前后端两份规则不许漂移——前端说「可以」而后端说「不行」，用户会白扣一次积分。
import { classifyVideoLink as serverClassify, extractFirstUrl as serverExtract } from '../server/video-link.mjs'
import {
  checkVideoLink as clientClassify,
  extractFirstUrl as clientExtract,
  manualMediaItem,
} from '../src/domain/video-link.ts'

// 一份样本喂两边：任何一边改了规则，这里就会分叉
const SAMPLES = [
  { input: 'https://v.douyin.com/iRxAbCd/', kind: 'douyin', label: '抖音链接' },
  { input: '  https://www.douyin.com/video/7123456789  ', kind: 'douyin', label: '抖音链接' },
  { input: 'https://www.iesdouyin.com/share/video/7123456789', kind: 'douyin', label: '抖音链接' },
  { input: 'https://www.xiaohongshu.com/discovery/item/64f0', kind: 'xiaohongshu', label: '小红书链接' },
  { input: 'http://xhslink.com/a/BcDeF', kind: 'xiaohongshu', label: '小红书链接' },
  { input: 'https://cdn.example.com/videos/a.mp4', kind: 'direct', label: '视频直链' },
  { input: 'https://cdn.example.com/videos/a.MOV?token=1', kind: 'direct', label: '视频直链' },
  { input: 'https://cdn.example.com/a.webm#t=1', kind: 'direct', label: '视频直链' },
  // 抖音的分享文案：整段中文夹一条链接是最常见的粘法
  {
    input: '7.94 复制打开抖音，看看【某某的作品】 https://v.douyin.com/iRxAbCd/ 复制此链接，打开Dou音搜索',
    kind: 'douyin',
    label: '抖音链接',
    url: 'https://v.douyin.com/iRxAbCd/',
  },
  // 漏了 https:// 的裸域名也接住
  { input: 'v.douyin.com/iRxAbCd/', kind: 'douyin', label: '抖音链接' },
  // 认不出的：给原因，不给一句「失败」
  { input: 'https://example.com/article/1', reject: true, reason: '认不出这条链接：给抖音 / 小红书的内容页链接，或者 .mp4 / .mov / .webm 直链' },
  { input: 'ftp://example.com/a.mp4', reject: true, reason: '只支持 http / https 链接' },
  { input: 'https://user:pass@cdn.example.com/a.mp4', reject: true, reason: '链接里不能带账号口令' },
  { input: '', reject: true, reason: '先把链接粘进来：抖音 / 小红书的内容页链接，或 .mp4 直链' },
  { input: '   ', reject: true, reason: '先把链接粘进来：抖音 / 小红书的内容页链接，或 .mp4 直链' },
]

test('每条样本两边判定一致，并且落在该走的分支上', () => {
  for (const sample of SAMPLES) {
    const server = serverClassify(sample.input)
    const client = clientClassify(sample.input)
    assert.equal(server.ok, !sample.reject, '服务端判定不对：' + JSON.stringify(sample.input))
    assert.equal(client.ok, !sample.reject, '前端判定不对：' + JSON.stringify(sample.input))
    assert.equal(client.ok, server.ok, '前后端 ok 分叉：' + JSON.stringify(sample.input))
    if (sample.reject) {
      assert.equal(server.reason, sample.reason)
      assert.equal(client.reason, sample.reason, '前后端原因文案必须一致：' + JSON.stringify(sample.input))
    } else {
      assert.equal(server.kind, sample.kind)
      assert.equal(client.kind, sample.kind)
      assert.equal(server.label, sample.label)
      assert.equal(client.label, sample.label)
      assert.equal(client.platform, sample.kind === 'direct' ? 'link' : sample.kind)
      if (sample.url) {
        assert.equal(server.url, sample.url)
        assert.equal(client.url, sample.url)
      }
    }
  }
})

test('从整段分享文案里只捞第一条链接，尾巴上的标点不算', () => {
  const cases = [
    ['看看这条 https://v.douyin.com/abc/，真的很像', 'https://v.douyin.com/abc/'],
    ['链接：https://cdn.example.com/a.mp4。', 'https://cdn.example.com/a.mp4'],
    ['《https://v.douyin.com/abc/》', 'https://v.douyin.com/abc/'],
    ['没有链接', ''],
  ]
  for (const [input, expected] of cases) {
    assert.equal(serverExtract(input), expected, '服务端：' + input)
    assert.equal(clientExtract(input), expected, '前端：' + input)
  }
})

test('自备链接包成的卡片：平台跟着链接走，不冒充平台内容', () => {
  const direct = manualMediaItem('https://cdn.example.com/a.mp4')
  assert.equal(direct.platform, 'link')
  assert.equal(direct.platformLabel, '视频直链')
  assert.equal(direct.url, 'https://cdn.example.com/a.mp4')
  assert.equal(direct.id, '', '自备链接没有平台条目 id，不能拿去顶替库里的一条')
  assert.equal(direct.durationSec, null)
  assert.deepEqual(direct.stats, { likes: 0, comments: 0, shares: 0, collects: 0 })

  const douyin = manualMediaItem('https://v.douyin.com/iRxAbCd/')
  assert.equal(douyin.platform, 'douyin')
  assert.equal(douyin.platformLabel, '抖音链接')

  const xhs = manualMediaItem('https://www.xiaohongshu.com/discovery/item/1')
  assert.equal(xhs.platform, 'xiaohongshu')

  // 还没粘东西时是一张空卡片：界面据此把「开始拆解」按灰
  const empty = manualMediaItem('')
  assert.equal(empty.url, '')
  assert.equal(empty.platformLabel, '自备链接')
})
