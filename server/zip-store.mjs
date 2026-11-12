// 交付包（.zip）：把「交付稿 + 现场页 + 原片帧图」打成一个文件，收件人不用登录也能看。
//
// 为什么自己写而不是装 archiver / jszip：
//  1. 包里的东西只有一份几百行的 HTML、一份 Markdown 和十来个**已经压过**的 JPEG。
//     用 store（不压缩）体积几乎一样，却省掉一个十几 MB 的依赖和它的传递依赖。
//  2. ZIP 的最小可读结构就四段：本地头 + 数据 + 中央目录 + 尾记录。写死在这里，
//     测试能逐字段验（CRC32、偏移、大小、UTF-8 文件名标记），出问题一眼看得出是哪段。
//  3. 解压一侧全是系统自带的（Windows 资源管理器 / macOS 归档工具 / unzip），不用我们写。
//
// 边界：单文件与整包都 < 4 GB、条目数 < 65535 —— 不写 ZIP64，超了直接报错而不是出坏包。

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const U32_MAX = 0xffffffff
const COUNT_MAX = 0xffff

/** ZIP 里每个条目都带 CRC32（和 zlib.crc32 同值）：解压工具靠它发现包坏了。 */
export function crc32(buffer) {
  const bytes = buffer || Buffer.alloc(0)
  let crc = -1
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** ZIP 的日期字段是 DOS 时间：1980 年起，秒只有 2 秒精度。 */
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * 条目名只留「目录/文件名」这一种形状：反斜杠换成正斜杠，去掉开头的 / 和 ..，
 * 免得打包时因为一个奇怪的镜头名把文件写到解压目录外面。
 */
export function safeEntryName(name) {
  const parts = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
  return parts.join('/') || 'file'
}

/**
 * 拼一个 ZIP（store，不压缩）。
 * entries: [{ name, data: Buffer | string }]，name 里用 / 分目录；mtime 决定包里的时间戳。
 */
export function buildZip(entries, { mtime = new Date() } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.name)
    .map((entry) => ({
      name: safeEntryName(entry.name),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8'),
    }))
  if (list.length > COUNT_MAX) throw new Error('ZIP 条目超过 65535 个：这个交付包太大了，先把帧图减一半')

  const { time, date } = dosStamp(mtime)
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of list) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    if (entry.data.length > U32_MAX || offset > U32_MAX) throw new Error('ZIP 超过 4 GB：需要 ZIP64，这里不写')

    // 本地头：解开一个文件只读这一段（名字后面直接跟数据）
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // 解压需要 2.0
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名是 UTF-8（中文名不靠本地代码页猜）
    local.writeUInt16LE(0, 8) // 0 = store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // 没有 extra 字段
    chunks.push(local, name, entry.data)

    // 中央目录：列目录 / 解压前先读这一段
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4) // 打包工具版本
    record.writeUInt16LE(20, 6) // 解压需要 2.0
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30) // extra
    record.writeUInt16LE(0, 32) // 注释
    record.writeUInt16LE(0, 34) // 起始磁盘
    record.writeUInt16LE(0, 36) // 内部属性
    record.writeUInt32LE(0, 38) // 外部属性（不关心 Unix 权限：解压成普通文件就行）
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += local.length + name.length + entry.data.length
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(list.length, 8)
  end.writeUInt16LE(list.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, ...central, end])
}
