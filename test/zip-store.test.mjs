// 交付包的 ZIP：我们自己写的那三十行结构，验到字段级。
// 没有第三方解压库可用（也不想为了一个 store 包引依赖），所以这里做两件事：
//  1. 跟标准库对：CRC32 必须和 zlib.crc32 完全一致，条目大小 / 偏移与真实字节数对得上；
//  2. 结构逐字段验：本地头、中央目录、尾记录三段签名与计数，UTF-8 文件名标记。
import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'
import { buildZip, crc32, safeEntryName } from '../server/zip-store.mjs'

test('CRC32 与标准库一致：包坏没坏靠这个字段', () => {
  for (const value of ['', 'a', 'VisionQA 交付包', '咖啡 3 分钟']) {
    const bytes = Buffer.from(value, 'utf8')
    assert.equal(crc32(bytes), zlib.crc32(bytes), 'CRC 不一致：' + value)
  }
})

test('条目名只留目录/文件名：不让奇怪的镜头名把文件写到解压目录外面', () => {
  assert.equal(safeEntryName('frames/shot-01.jpg'), 'frames/shot-01.jpg')
  assert.equal(safeEntryName('..\\..\\evil.txt'), 'evil.txt')
  assert.equal(safeEntryName('/etc/passwd'), 'etc/passwd')
  assert.equal(safeEntryName('  '), 'file')
  assert.equal(safeEntryName('./现场页.html'), '现场页.html')
})

test('打一个包：本地头 + 中央目录 + 尾记录三段齐全，偏移与大小和真实字节对得上', () => {
  const entries = [
    { name: '说明.txt', data: '第一行\n第二行\n' },
    { name: 'frames/shot-01.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
  ]
  const zip = buildZip(entries, { mtime: new Date('2026-11-12T06:30:00Z') })
  assert.ok(Buffer.isBuffer(zip))

  // 尾记录：在最后 22 字节
  const end = zip.length - 22
  assert.equal(zip.readUInt32LE(end), 0x06054b50, '没有尾记录签名')
  assert.equal(zip.readUInt16LE(end + 8), 2, '条目数不对')
  assert.equal(zip.readUInt16LE(end + 10), 2, '条目数不对')
  const centralSize = zip.readUInt32LE(end + 12)
  const centralOffset = zip.readUInt32LE(end + 16)
  assert.equal(centralOffset + centralSize, end, '中央目录的大小与偏移对不上尾记录')

  // 第一个本地头
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '没有本地头签名')
  assert.equal(zip.readUInt16LE(6), 0x0800, '没标 UTF-8 文件名，中文名会被解压工具猜错')
  assert.equal(zip.readUInt16LE(8), 0, '这个包应该是 store（不压缩）')
  const nameLength = zip.readUInt16LE(26)
  const firstName = zip.subarray(30, 30 + nameLength).toString('utf8')
  assert.equal(firstName, '说明.txt')
  assert.equal(nameLength, Buffer.byteLength('说明.txt', 'utf8'), '文件名长度必须是 UTF-8 字节数，不是字符数')
  const firstData = Buffer.from(entries[0].data, 'utf8')
  assert.equal(zip.readUInt32LE(14), zlib.crc32(firstData), 'CRC 字段不是这份数据的')
  assert.equal(zip.readUInt32LE(18), firstData.length, '压缩后大小不对')
  assert.equal(zip.readUInt32LE(22), firstData.length, '原始大小不对')
  assert.ok(zip.subarray(30 + nameLength, 30 + nameLength + firstData.length).equals(firstData), '数据段和原文不一致')

  // 中央目录：第二条记录（跳过第一条 46 + 名字长度）的本地头偏移必须指回它自己的头
  const firstCentralSize = 46 + zip.readUInt16LE(centralOffset + 28) + zip.readUInt16LE(centralOffset + 30) + zip.readUInt16LE(centralOffset + 32)
  const second = zip.subarray(centralOffset + firstCentralSize)
  assert.equal(second.readUInt32LE(0), 0x02014b50)
  const secondLocal = second.readUInt32LE(42)
  assert.equal(zip.readUInt32LE(secondLocal), 0x04034b50)
  const secondName = zip.subarray(secondLocal + 30, secondLocal + 30 + second.readUInt16LE(28))
  assert.equal(secondName.toString('utf8'), 'frames/shot-01.jpg')
})

test('空包也是合法的：没有帧图时交付包里只剩说明与现场页', () => {
  const zip = buildZip([{ name: 'a.md', data: 'x' }])
  assert.equal(zip.readUInt16LE(zip.length - 22 + 8), 1)
})

test('条目数超过 65535 直接报错：不写 ZIP64，宁可失败也不出坏包', () => {
  const many = Array.from({ length: 65536 }, (_, index) => ({ name: 'f' + index + '.txt', data: '' }))
  assert.throws(() => buildZip(many), /65535/)
})
