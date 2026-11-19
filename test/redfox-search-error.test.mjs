import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 检索失败的话术（r269）：临时实例里把 RedFox 指向一个没人监听的端口，
// 两个平台同时失败时以前界面上写着「fetch failed；fetch failed」——英文两遍，不是给用户看的话。
// 这里盯三条：不给用户看英文原文、说清是连不上、两个平台重复的同一句只念一遍。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-redfox-error-'))
process.env.DATA_DIR = dir
process.env.REDFOX_API_KEY = 'fixture-not-a-real-key'
process.env.REDFOX_BASE_URL = 'http://127.0.0.1:9'

const { searchMedia } = await import('../server/redfox.mjs')

test('检索上游连不上：翻成一句人话，两个平台的同一句只念一遍', async () => {
  await assert.rejects(
    () => searchMedia({ platform: 'all', keyword: '春季通勤穿搭' }),
    (error) => {
      assert.equal(error.code, 'REDFOX_ERROR')
      assert.equal(
        /fetch failed|ECONNREFUSED|ECONNRESET/i.test(error.message),
        false,
        '不许把 fetch failed 这类原文甩给用户看',
      )
      assert.match(error.message, /连不上检索服务/)
      assert.equal(
        error.message,
        '连不上检索服务（网络或上游暂时不可用）',
        '抖音与小红书都是这一句：去重之后只说一遍',
      )
      return true
    },
  )
})
