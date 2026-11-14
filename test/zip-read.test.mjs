import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

// 包里那份（v0.9.129）：封存包里的目录与单条内容要能读回来，而且读的就是包里那一份。
// 这组测纯解析（不碰磁盘、不起服务）：
//   1) 我们自己打的包，目录、内容、CRC 都对得上；
//   2) 包里某一条坏了，能判出来，不把坏内容当内容；
//   3) 截断的、不是 zip 的、ZIP64 的、奇怪压缩方式的，一律读不出来，而不是给一份猜出来的清单；
//   4) 按名字取只认目录里真有的那一条，不顺着 .. 往上走。

const zipStore = await import('../server/zip-store.mjs')
const reader = await import('../server/zip-read.mjs')
const { buildZip, crc32 } = zipStore
const {
  readZipDirectory,
  readZipDirectoryAt,
  readZipEntry,
  readZipEntryAt,
  findZipEntry,
  entryKind,
  entryMime,
  compareManifest,
  verifyZipEntries,
  verifyZipAt,
} = reader

const entries = [
  { name: '交付稿.md', data: Buffer.from('# 交付稿\n这一版改了开场。\n', 'utf8') },
  { name: '现场页.html', data: Buffer.from('<html><body>现场页</body></html>', 'utf8') },
  { name: 'frames/shot-01.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) },
]

test('自己打的包：目录读得回来，名字、字节数、CRC32 都对', () => {
  const zip = buildZip(entries)
  const dir = readZipDirectory(zip)
  assert.ok(dir)
  assert.equal(dir.total, 3)
  assert.deepEqual(dir.entries.map((entry) => entry.name), entries.map((entry) => entry.name))
  for (const [index, entry] of dir.entries.entries()) {
    assert.equal(entry.bytes, entries[index].data.length)
    assert.equal(entry.crc, crc32(entries[index].data))
    assert.equal(entry.method, 0)
    assert.equal(entry.encrypted, false)
  }
})

test('按目录取一条：内容和原始一致，CRC 自己就能验过', () => {
  const zip = buildZip(entries)
  const dir = readZipDirectory(zip)
  const target = findZipEntry(dir.entries, 'frames/shot-01.jpg')
  assert.ok(target)
  const read = readZipEntry(zip, target)
  assert.ok(read)
  assert.equal(read.crcOk, true)
  assert.deepEqual(Buffer.from(read.data), entries[2].data)
})

test('包里某一条被改了一个字节：内容仍取得到，但 crcOk 为 false，界面不该当成内容展示', () => {
  const zip = buildZip(entries)
  const dir = readZipDirectory(zip)
  const target = findZipEntry(dir.entries, '现场页.html')
  // 本地头 30 字节 + 名字，紧跟着就是这一条的数据
  const nameBytes = Buffer.byteLength('现场页.html', 'utf8')
  zip[target.offset + 30 + nameBytes + 2] ^= 0xff
  const read = readZipEntry(zip, target)
  assert.ok(read)
  assert.equal(read.crcOk, false)
})

test('包被截断：目录读不出来，不猜一张清单', () => {
  const zip = buildZip(entries)
  assert.equal(readZipDirectory(zip.subarray(0, zip.length - 40)), null)
  assert.equal(readZipDirectory(zip.subarray(0, 10)), null)
})

test('不是 zip：读不出来', () => {
  assert.equal(readZipDirectory(Buffer.from('这不是一个包\n'.repeat(40), 'utf8')), null)
  assert.equal(readZipDirectory(null), null)
  assert.equal(readZipEntry(null, { offset: 0 }), null)
})

test('deflate（压缩方式 8）的包也读得回来：别人重新打过一份也不装着看不见', () => {
  const data = Buffer.from('压缩过的这一条\n'.repeat(20), 'utf8')
  const zip = deflatedZip('说明.txt', data)
  const dir = readZipDirectory(zip)
  assert.ok(dir)
  assert.equal(dir.entries[0].method, 8)
  const read = readZipEntry(zip, dir.entries[0])
  assert.ok(read)
  assert.equal(read.crcOk, true)
  assert.deepEqual(Buffer.from(read.data), data)
})

test('认不出的压缩方式：取不出来，而不是给一段乱码', () => {
  const zip = buildZip([{ name: 'a.bin', data: Buffer.from('abc') }])
  const dir = readZipDirectory(zip)
  const broken = { ...dir.entries[0], method: 99 }
  assert.equal(readZipEntry(zip, broken), null)
})

test('按名字取：只认目录里真有的那一条，带 .. 或空段的一律不认', () => {
  const zip = buildZip(entries)
  const { entries: list } = readZipDirectory(zip)
  assert.equal(findZipEntry(list, '交付稿.md').name, '交付稿.md')
  assert.equal(findZipEntry(list, 'frames/shot-01.jpg').name, 'frames/shot-01.jpg')
  assert.equal(findZipEntry(list, '/现场页.html').name, '现场页.html')
  assert.equal(findZipEntry(list, '../说明.txt'), null)
  assert.equal(findZipEntry(list, 'frames/../../说明.txt'), null)
  assert.equal(findZipEntry(list, ''), null)
  assert.equal(findZipEntry(list, 'x'.repeat(201)), null)
  assert.equal(findZipEntry(list, '不存在的.html'), null)
})

test('条目分类与 Content-Type：图片看图、页面进沙箱、文字读文本、其余不给预览', () => {
  assert.equal(entryKind('frames/shot-01.jpg'), 'image')
  assert.equal(entryKind('现场页.HTML'), 'html')
  assert.equal(entryKind('说明.txt'), 'text')
  assert.equal(entryKind('交付稿.md'), 'text')
  assert.equal(entryKind('素材.mov'), 'other')
  assert.equal(entryMime('a.jpeg'), 'image/jpeg')
  assert.equal(entryMime('现场页.html'), 'text/html; charset=utf-8')
  assert.equal(entryMime('说明.txt'), 'text/plain; charset=utf-8')
  assert.equal(entryMime('素材.mov'), 'application/octet-stream')
})

test('档案清单 vs 包内目录：少一个、多一个都说得出；老包没记清单就不比较', () => {
  const zip = buildZip(entries)
  const { entries: list } = readZipDirectory(zip)
  const files = [
    { name: '交付稿.md', bytes: 10 },
    { name: '现场页.html', bytes: 10 },
    { name: '两版对照页.html', bytes: 10 },
  ]
  const compared = compareManifest(list, files)
  assert.equal(compared.recorded, 3)
  assert.equal(compared.archived, 3)
  assert.deepEqual(compared.missing, ['两版对照页.html'])
  assert.deepEqual(compared.extra, ['frames/shot-01.jpg'])
  const legacy = compareManifest(list, [])
  assert.equal(legacy.recorded, 0)
  assert.deepEqual(legacy.missing, [])
  assert.deepEqual(legacy.extra, [])
})

test('盘上的那份按句柄读：目录与内存里那份逐条一致，取一条也对得上', () => {
  const zip = buildZip(entries)
  const temp = tempZip(zip)
  try {
    const at = readZipDirectoryAt(temp.fd, temp.size)
    assert.ok(at)
    const memory = readZipDirectory(zip)
    assert.deepEqual(
      at.entries.map((entry) => ({ ...entry })),
      memory.entries.map((entry) => ({ ...entry })),
    )
    const target = findZipEntry(at.entries, '交付稿.md')
    const read = readZipEntryAt(temp.fd, temp.size, target)
    assert.ok(read)
    assert.equal(read.crcOk, true)
    assert.deepEqual(Buffer.from(read.data), entries[0].data)
    // 名字不在目录里：找不到，不瞎猜
    assert.equal(findZipEntry(at.entries, '没这条.txt'), null)
    assert.equal(readZipEntryAt(temp.fd, temp.size, findZipEntry(at.entries, '没这条.txt')), null)
  } finally {
    temp.close()
  }
})

test('整包体检：每一条都解开重算 CRC，全部对得上；读的字节数不超过包大小', () => {
  const zip = buildZip(entries)
  const temp = tempZip(zip)
  try {
    const { entries: list } = readZipDirectoryAt(temp.fd, temp.size)
    const audit = verifyZipAt(temp.fd, temp.size, list)
    assert.equal(audit.total, 3)
    assert.equal(audit.passed, 3)
    assert.equal(audit.skipped, 0)
    assert.deepEqual(audit.failed, [])
    assert.ok(audit.readBytes > 0)
    assert.ok(audit.readBytes <= zip.length)
  } finally {
    temp.close()
  }
})

test('整包体检：盘上某一条坏了一个字节，就点名那一条，其余照样通过', () => {
  const zip = buildZip(entries)
  const { entries: list } = readZipDirectory(zip)
  const target = findZipEntry(list, '现场页.html')
  const nameBytes = Buffer.byteLength('现场页.html', 'utf8')
  zip[target.offset + 30 + nameBytes + 2] ^= 0xff
  const temp = tempZip(zip)
  try {
    const at = readZipDirectoryAt(temp.fd, temp.size)
    assert.ok(at)
    const audit = verifyZipAt(temp.fd, temp.size, at.entries)
    assert.equal(audit.total, 3)
    assert.equal(audit.passed, 2)
    assert.equal(audit.failed.length, 1)
    assert.equal(audit.failed[0].name, '现场页.html')
    assert.equal(audit.failed[0].reason, 'crc')
  } finally {
    temp.close()
  }
})

test('整包体检：包被截断就是目录都读不出来，不给一份猜的清单', () => {
  const zip = buildZip(entries)
  const temp = tempZip(zip)
  try {
    truncateSync(temp.file, zip.length - 40)
    assert.equal(readZipDirectoryAt(temp.fd, zip.length - 40), null)
  } finally {
    temp.close()
  }
})

test('整包体检：解开的总字节有预算，超了就记 skipped，不装作都对得上', () => {
  const zip = buildZip(entries)
  const temp = tempZip(zip)
  try {
    const { entries: list } = readZipDirectoryAt(temp.fd, temp.size)
    const audit = verifyZipAt(temp.fd, temp.size, list, { budgetBytes: 1 })
    assert.equal(audit.total, 3)
    assert.equal(audit.passed, 0)
    assert.equal(audit.skipped, 3)
    assert.deepEqual(audit.failed, [])
  } finally {
    temp.close()
  }
})

test('体检会说清坏在哪一种：加密的、认不出的压缩方式，不混成一句「坏了」', () => {
  const zip = buildZip(entries)
  const source = { size: zip.length, read: (offset, length) => zip.subarray(offset, offset + length) }
  const { entries: list } = readZipDirectory(zip)
  const encrypted = verifyZipEntries(source, [{ ...list[0], encrypted: true }])
  assert.equal(encrypted.failed.length, 1)
  assert.equal(encrypted.failed[0].reason, 'encrypted')
  const oddMethod = verifyZipEntries(source, [{ ...list[0], method: 99 }])
  assert.equal(oddMethod.failed[0].reason, 'method')
})

/** 把一份包落到临时文件，返回只读句柄；用完 close，临时目录顺手删掉。 */
function tempZip(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'vq-zip-'))
  const file = join(dir, 'pkg.zip')
  writeFileSync(file, buffer)
  const fd = openSync(file, 'r')
  return {
    fd,
    file,
    size: buffer.length,
    close: () => {
      closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 手工拼一个 method 8（deflate）的单条目 zip：我们的包是 store，但别人重打过的也要读得出来。 */
function deflatedZip(name, data) {
  const packed = deflateRawSync(data)
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(packed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(packed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBytes.length, 12)
  end.writeUInt32LE(local.length + nameBytes.length + packed.length, 16)
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end])
}
