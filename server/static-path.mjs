// 托管 dist 时的路径解析（v0.9.88）：只认根目录以内的文件。
//
// 原来的写法是 path.join(distDir, pathname)。pathname 已经过 decodeURIComponent，
// 于是 /%2e%2e%2fpackage.json 会被还原成 /../package.json，拼完就是项目根上的
// package.json（本地实测 200，1.8 KB；换成 %2e%2e%2f.env 同样是 200）。
// 线上 nginx 会先回 400 挡住这一类 URI，但应用自己不该靠外面那一层：
// 直连端口（127.0.0.1:8799 上的 socket）、内网机器、以后换反代，任何一条都会漏。
//
// 解析完再判断一次「还在根里」：Windows 上 \ 也是分隔符，/..\package.json 与
// /../package.json 等价，所以先把 \ 统一成 /，再用 path.resolve 归一化，最后比前缀。
import path from 'node:path'

/** 把请求路径解析成根目录以内的绝对路径；越界（或解析不出）返回空串。 */
export function distFileFor(rootDir, pathname) {
  const root = path.resolve(rootDir)
  const raw = String(pathname || '').replace(/\\/g, '/')
  const candidate = path.resolve(root, '.' + raw)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return ''
  return candidate
}
