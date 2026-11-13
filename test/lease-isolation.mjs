// 测试隔离：跨进程重活租约默认落在系统临时目录的共享目录里，
// 而 node --test 是并行跑多个测试文件的——不隔离的话，
// 一个文件里正在跑的评审会把另一个文件的整机名额占掉，测出来的拒绝是假的。
// 每个测试文件自己在自己的目录里数名额，同时保证「接进 admit 之后」的路径被测到。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

export function isolateLeaseDir(prefix = 'vq-lease-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.VQ_HEAVY_LEASE_DIR = dir
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上偶尔会被刚退出的子进程拖住：留个临时目录不影响结论
    }
  })
  return dir
}
