// 一页配齐（r258）：Key 池、统一路由、出图出视频通道、联网搜索都在「模型与上游」同一页；
// 搜索默认跟平台对话共用一把 Key，后台不再存第二把。
// 只读源码断言——不联网、不花一分钱。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n')

test('「模型与上游」一页装下 Key 池、路由、通道、当前接入与联网搜索', () => {
  const page = read('src/pages/admin/ModelCatalogSection.tsx')
  for (const block of ['<SearchCard />', '<ModelKeyPool />', '<ModelRoutePanel />', '<GatewaySection />', '<ProviderStatusCard />', '<UpstreamBalanceCard />']) {
    assert.ok(page.includes(block), '模型与上游缺了 ' + block)
  }
  assert.match(page, /Key、统一路由、出图出视频通道、联网搜索、上游余额都只在这一页配/)
})

test('后台导航不再有第二个「模型 Key」入口；旧地址 #/admin/keys 落到同一页', () => {
  assert.ok(!read('src/editions.ts').includes("section: 'keys'"), '导航里不该再出现「模型 Key」')
  const console_ = read('src/pages/admin/AdminConsolePage.tsx')
  assert.match(console_, /section === 'models' \? <ModelCatalogSection \/>/)
  // 旧收藏的 #/admin/keys 落点：路由里显式改成 models，不落到总览
  assert.match(read('src/router.ts'), /if \(value === 'keys'\) return 'models'/)
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'src/pages/admin/KeysSection.tsx')), 'KeysSection 已并进模型与上游，不该再单独存在')
})

test('联网搜索只在「模型与上游」：系统页不再有搜索卡片与接口', () => {
  const system = read('src/pages/admin/SystemSection.tsx')
  assert.ok(!system.includes('SearchChannelCard'), '系统页不该再渲染搜索卡片')
  assert.ok(!system.includes('/api/admin/search'), '系统页不该再直接调搜索接口')
  assert.ok(read('src/pages/admin/ModelCatalogSection.tsx').includes("import SearchCard from './SearchCard'"))
})

test('搜索卡片写清「跟平台对话共用一把 Key」，并且共用时不再让填第二把', () => {
  const card = read('src/pages/admin/SearchCard.tsx')
  assert.match(card, /跟平台对话共用同一把 Key/)
  assert.match(card, /platformKey\?\.available/)
  assert.match(card, /const usesPlatformKey = provider === 'deepseek'/)
  assert.ok(card.includes('开通联网搜索'))
  // 共用通道时不渲染独立 Key 输入框：只在非共用的分支里出现
  const shared = card.indexOf('usesPlatformKey ? (')
  const keyInput = card.indexOf('placeholder={saved.hasKey && saved.provider === provider')
  assert.ok(shared > 0 && keyInput > shared, 'Key 输入框必须落在「不是共用通道」的分支里')
})
