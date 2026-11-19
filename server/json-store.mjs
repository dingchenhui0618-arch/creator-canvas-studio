// 数据文件的读法（r265）：在「文件不存在」和「文件坏了」之间划一条线。
//
// 这些存储都是整文件读改写：读出来一份列表、改一条、整份写回去。以前读失败一律当成空数组，
// 于是文件只要有一次读不出来（JSON 写坏、权限不对、盘上留了半个文件），页面就显示「一条都没有」，
// 用户随手新建一条，整份内容就被这一条覆盖掉了 —— 数据是静默丢的，没有任何提示。
// 现在只有「文件还不存在」（ENOENT）算空库；别的失败一律抛出去，让读写都停下来。
import fsp from 'node:fs/promises'

/** 存储读不出来：不是「空」，调用方不许继续，更不许写回。 */
export function storeUnreadable(label, cause) {
  const error = new Error(label + '数据读不出来（文件可能损坏）：这一次没有改动任何内容，请联系管理员')
  error.code = 'STORE_UNREADABLE'
  error.storeLabel = label
  error.cause = cause
  return error
}

/**
 * 读一个「JSON 数组」存储。
 * - 文件不存在 → 空数组（第一次部署就是这样起步的）
 * - 读失败 / 不是合法 JSON / 顶层不是数组 → 抛 storeUnreadable
 */
export async function readStoreArray(file, label) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw storeUnreadable(label, error)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw storeUnreadable(label, error)
  }
  if (!Array.isArray(parsed)) throw storeUnreadable(label, new Error('顶层不是数组'))
  return parsed
}
