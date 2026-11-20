// 原子写（r284）：写 .tmp 再 rename，撞到「目标文件正被读」时重试。
//
// 为什么值得单测：这个 rename 失败一次，用户看到的是「任务一直进行中、积分没了」——
// 2026-11-20 全量测试里真的撞到了（EPERM rename mgen_x.json.tmp -> mgen_x.json）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isTransientRenameError, renameWithRetry, writeFileAtomic } from '../server/atomic-write.mjs'

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

async function tempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'vq-atomic-'))
}

test('写进去的是原文，临时文件不留', async () => {
  const dir = await tempDir()
  try {
    const target = path.join(dir, 'task.json')
    const result = await writeFileAtomic(target, '{"a":1}')
    assert.equal(result.ok, true)
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}')
    assert.deepEqual(fs.readdirSync(dir), ['task.json'])
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('目标已经存在时覆盖，覆盖后没有残余的半份文件', async () => {
  const dir = await tempDir()
  try {
    const target = path.join(dir, 'task.json')
    fs.writeFileSync(target, 'old')
    await writeFileAtomic(target, '新内容')
    assert.equal(fs.readFileSync(target, 'utf8'), '新内容')
    assert.deepEqual(fs.readdirSync(dir), ['task.json'])
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('前两次 EPERM、第三次成功：重试到成功，并把次数说出来', async () => {
  const dir = await tempDir()
  try {
    let calls = 0
    const flaky = async (from, to) => {
      calls += 1
      if (calls < 3) throw eperm()
      await fs.promises.rename(from, to)
    }
    const target = path.join(dir, 'task.json')
    const result = await writeFileAtomic(target, 'ok', { rename: flaky, delayMs: 1 })
    assert.equal(result.attempts, 3)
    assert.equal(fs.readFileSync(target, 'utf8'), 'ok')
    assert.deepEqual(fs.readdirSync(dir), ['task.json'])
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('一直 EPERM：用完次数就抛，临时文件删掉，不装成写成功', async () => {
  const dir = await tempDir()
  try {
    const target = path.join(dir, 'task.json')
    await assert.rejects(
      () => writeFileAtomic(target, 'x', { attempts: 3, delayMs: 1, rename: async () => { throw eperm() } }),
      (error) => error.code === 'EPERM' && error.renameTo === target,
    )
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('不是暂时性错误（例如参数不对）就一次都不重试，立刻抛', async () => {
  const dir = await tempDir()
  try {
    let calls = 0
    const broken = async () => {
      calls += 1
      throw Object.assign(new Error('EINVAL: invalid argument'), { code: 'EINVAL' })
    }
    await assert.rejects(() => renameWithRetry('a', 'b', { rename: broken, delayMs: 1 }))
    assert.equal(calls, 1, '不在白名单里的错误码不该重试')
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('只有 EPERM / EBUSY / EACCES / EAGAIN 算「等一会儿就行」', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']) assert.equal(isTransientRenameError({ code }), true, code)
  for (const code of ['ENOENT', 'EINVAL', 'ENOSPC', '', undefined]) assert.equal(isTransientRenameError({ code }), false, String(code))
})

test('接线：写任务元数据走带重试的原子写，不再自己 rename', async () => {
  const fsMod = await import('node:fs')
  const route = fsMod.readFileSync(new URL('../server/routes/media-gen.mjs', import.meta.url), 'utf8')
  assert.match(route, /import \{ writeFileAtomic \} from '..\/atomic-write.mjs'/)
  assert.match(route, /await writeFileAtomic\(taskMetaFile\(task.id\), JSON\.stringify\(task, null, 2\)\)/)
  assert.match(route, /async function writeTask\(task\) \{[\s\S]{0,320}?writeFileAtomic/)
})
