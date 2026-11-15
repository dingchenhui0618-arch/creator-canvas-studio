// 这一条是给谁的（v0.9.152）。
//
// r145–r151 一路在判断「他收到没有」——打开过几次、催过几次、换过几条地址——可这些判断都默认
// 「我心里有数是发给谁的」。真的同时交出去两三份时，工作台那几行只剩版次与天数，分不出哪一条
// 给王老师、哪一条给甲方；r150 让人「换个收件人」，也没有地方写换成谁。
//
// 边界：
//  - 只记发件人自己写的称呼：不猜人名，也不拿作品标题当收件人；
//  - 空串 = 没写（老记录都是这样），界面就不说这一段，不写成「收件人未知」；
//  - 只在发件人这一侧：不进包、不进回执页，拿到链接的人看不到发件人怎么称呼别人；
//  - 复制出去的那几段话用这个称呼开头，但不替发件人保证「点开的就是他本人」——转发也算。

export const RECIPIENT_LIMIT = 24

/** 写进来、读回来都过这一遍：去控制字符、空白压成一个、按字截到上限（按码点算，不劈开生僻字） */
export function normalizeRecipient(raw: string | null | undefined): string {
  // 控制字符一律换成空格：粘进来的换行、制表符不该在行上撑出一段空白。
  // 不用正则的字符类（lint 会当面指出这一类写法），按码点过一个：C0 与 DEL 都算控制字符。
  const flat = Array.from(String(raw ?? ''))
    .map((ch) => {
      const code = ch.codePointAt(0) || 0
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
  const text = flat.replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, RECIPIENT_LIMIT).join('')
}

/** 接口读回来的那一项：只认字符串，坏值当成没写——不把 undefined 写进界面 */
export function recipientOf(value: unknown): string {
  return typeof value === 'string' ? normalizeRecipient(value) : ''
}

/** 行上与档案里那一段：「给王老师」；没写就是空串，调用方自己决定说不说 */
export function recipientText(recipient?: string | null): string {
  const name = normalizeRecipient(recipient)
  return name ? '给' + name : ''
}

/** 行上那一段的提示：说清只有自己看得到，包里没有 */
export function recipientTitle(recipient?: string | null): string {
  const name = normalizeRecipient(recipient)
  return name ? '这一条发给' + name + '（只有你看得到：包里没有，拿到链接的人也看不到）' : ''
}

/** 编辑框下面那一句：说清这个称呼会出现在哪、不会出现在哪 */
export function recipientHint(): string {
  return '只写给你自己看：工作台那一行与复制出去的话会用它开头。不进包，也不给收包人看。'
}

/** 复制出去的那段话开头：「王老师，」；没写就没有这一句，也不写「你好，」这类空话 */
export function recipientGreeting(recipient?: string | null): string {
  const name = normalizeRecipient(recipient)
  return name ? name + '，' : ''
}

/** 存下之后的说法：写的是「记下了」，不是「发出去了」 */
export function recipientSavedText(recipient: string): string {
  const name = normalizeRecipient(recipient)
  return name ? '已记下：这一条是给' + name + '的' : recipientClearedText()
}

/** 清掉：这一条回到「没写收件人」，不是「收件人删掉了」 */
export function recipientClearedText(): string {
  return '已清掉收件人：这一条回到「没写」'
}

/** 编辑器空着时的样子：不写「未知」，只说还没写 */
export function recipientEmptyText(): string {
  return '还没写收件人'
}

/** 输入框的示例，只当占位符用，不预填任何名字 */
export function recipientPlaceholder(): string {
  return '王老师 · 内容组'
}
