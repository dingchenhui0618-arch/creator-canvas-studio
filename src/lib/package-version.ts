// 从 package.json 的原文里取版本号。
//
// 为什么不能直接 JSON.parse：
// 2026-11-26 发版踩过——PowerShell 的 `Set-Content -Encoding utf8` 会写上 BOM，
// 构建时 `?raw` 把带 BOM 的原文原样塞进 bundle，模块顶层 `JSON.parse` 直接抛
// 「Unexpected token（BOM 那个不可见字符）」，整个首屏白屏（服务端 /api/version 却是好的，因为读的是文件）。
//
// 所以这里两件事都要做：抹掉 BOM 再解析；解析失败返回空串，绝不把首屏一起带走。
export function readPackageVersion(raw: string): string {
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}
