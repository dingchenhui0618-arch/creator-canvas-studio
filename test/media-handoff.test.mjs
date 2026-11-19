// 作品流 → 快捷创作的一次交接（r229 / v0.9.213）。
//
// 作品流里的成品以前只能「看大图 / 打开运行」：想接着改或当首帧出视频，
// 得先下载、再回快捷创作传一遍。这一轮在作品卡上给了「用作参考」，
// 它只做两件事——把文件取回传成参考素材，把素材号交给快捷创作去挂。
// 规则落在两处：domain/media-handoff（一次性的交接记录）与 WorksWall（入口）。
// 这里锁住：坏数据不认、读一次就消费掉、界面不自己发明接口或上游调用。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  REF_HANDOFF_KEY,
  peekRefHandoff,
  takeRefHandoff,
  writeRefHandoff,
} from '../src/domain/media-handoff.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const wall = fs.readFileSync(path.join(ROOT, 'src', 'components', 'WorksWall.tsx'), 'utf8')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

/** 内存版 sessionStorage：只实现用到的四个方法。 */
function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    clear: () => map.clear(),
  }
}

const HANDOFF = { assetId: 'asset_AbC123', kind: 'image', name: '橘猫-123456.png', from: '快捷创作' }

test('交接：写进去、读得到，读一次就消费掉', () => {
  const storage = memoryStorage()
  assert.equal(writeRefHandoff(storage, HANDOFF), true)
  assert.equal(storage.getItem(REF_HANDOFF_KEY) !== null, true)
  // 页面挂载时先看一眼决定落哪个页签：这时不能删，用户还没真用上
  assert.deepEqual(peekRefHandoff(storage), HANDOFF)
  assert.deepEqual(peekRefHandoff(storage), HANDOFF)
  assert.deepEqual(takeRefHandoff(storage), HANDOFF)
  // 用掉之后不能留到下次进来又挂一遍
  assert.equal(takeRefHandoff(storage), null)
  assert.equal(storage.getItem(REF_HANDOFF_KEY), null)
})

test('交接：坏数据一律不认（不是 JSON / 不是对象 / 素材号带非法字符 / 种类不认识）', () => {
  const storage = memoryStorage()
  for (const raw of ['', '{', 'null', '123', '"asset_1"', '{"assetId":"","kind":"image"}', '{"assetId":"has space","kind":"image"}', '{"assetId":"../../etc/passwd","kind":"image"}', '{"assetId":"asset_1","kind":"audio"}', '{"assetId":"asset_1"}']) {
    storage.setItem(REF_HANDOFF_KEY, raw)
    assert.equal(peekRefHandoff(storage), null, raw + ' 不该被认成一次交接')
  }
})

test('交接：名字与来源裁到合理长度，素材号原样保留', () => {
  const storage = memoryStorage()
  writeRefHandoff(storage, { assetId: 'asset_AbC123', kind: 'video', name: '名'.repeat(400), from: '无限画布'.repeat(40) })
  const found = peekRefHandoff(storage)
  assert.equal(found.assetId, 'asset_AbC123')
  assert.equal(found.kind, 'video')
  assert.equal(found.name.length, 120)
  assert.equal(found.from.length, 24)
})

test('交接：比例跟着作品走，认不出的比例当没带', () => {
  const storage = memoryStorage()
  writeRefHandoff(storage, { ...HANDOFF, ratio: '9:16' })
  assert.equal(peekRefHandoff(storage).ratio, '9:16')
  writeRefHandoff(storage, { ...HANDOFF, ratio: '21:9' })
  assert.equal(peekRefHandoff(storage).ratio, undefined)
  writeRefHandoff(storage, { ...HANDOFF })
  assert.equal(peekRefHandoff(storage).ratio, undefined)
})

test('交接：存储不可用（隐私模式 / 读就抛 / 配额满）时不崩，只是挂不上', () => {
  assert.equal(peekRefHandoff(null), null)
  assert.equal(takeRefHandoff(undefined), null)
  assert.equal(writeRefHandoff(null, HANDOFF), false)
  const broken = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('QuotaExceededError')
    },
    removeItem() {
      throw new Error('SecurityError')
    },
  }
  assert.equal(writeRefHandoff(broken, HANDOFF), false)
  assert.equal(peekRefHandoff(broken), null)
  assert.equal(takeRefHandoff(broken), null)
})

test('作品卡：成品能「用作参考」和「下载」，两处入口（卡片与看大图）都在', () => {
  // 入口来自同一个动作函数：卡片上渲染一次，看大图浮层里再渲染一次（r262 起浮层是共用的 MediaLightbox）
  assert.ok(wall.includes('const reuseWork = async (item: WorkItem) =>'))
  assert.ok(wall.includes('const saveWork = async (item: WorkItem) =>'))
  assert.ok(wall.includes('用作参考'))
  assert.ok(wall.includes('{busyRef ? \'加入中…\' : \'用作参考\'}'))
  assert.ok(wall.includes('{busySave ? \'下载中…\' : \'下载\'}'))
  assert.ok(wall.includes('actions(item)'))
  // 浮层那一次：同一套动作交给共用的看大图浮层
  assert.ok(wall.includes('actions={actions(preview)}'), '看大图浮层里没有「用作参考 / 下载」')
})

test('作品卡：三种来源都能取回文件，而且只走自己的接口', () => {
  // 画布节点与工作流封面都在自己名下：一个走代理地址，一个走运行产物地址
  assert.ok(wall.includes("return item.previewUrl || item.thumbUrl || ''"))
  assert.ok(wall.includes("fetch(url, { credentials: 'same-origin' })"))
  // 不发明新接口、不在前端扣积分、不打上游
  assert.equal(wall.includes('/api/media/generate'), false)
  assert.equal(wall.includes('/api/works/reuse'), false)
  assert.ok(wall.includes('await uploadMediaAsset({ file, ...meta })'))
})

test('交接之后：快捷创作按种类落到对应页签，挂上才算用掉', () => {
  assert.ok(page.includes("import { peekRefHandoff, takeRefHandoff } from '../domain/media-handoff'"))
  assert.ok(page.includes("pendingRef ? (pendingRef.kind === 'video' ? 'video' : 'image') : 'chat'"))
  assert.ok(page.includes('if (!handoffId || !libraryLoaded || !model) return'))
  // 模型表没回来时不能挂：那一刻判不出这个方式收不收
  assert.ok(page.includes('handoff={pendingRef && pendingRef.kind === mode ? pendingRef : null}'))
  assert.ok(page.includes('takeRefHandoff(window.sessionStorage)'))
})

test('交接之后：比例跟着作品走，不默认落回 1:1', () => {
  // 作品卡把 aspect 带过去，快捷创作在模型允许的档位里照它设比例
  assert.ok(wall.includes('ratio: item.aspect'))
  assert.ok(page.includes("const handoffRatio = handoff?.ratio ?? ''"))
  assert.ok(page.includes('model.ratios.includes(handoffRatio)'))
  assert.ok(page.includes('setSelected((current) => ({ ...current, ratio: handoffRatio }))'))
})
