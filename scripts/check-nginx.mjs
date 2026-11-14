// nginx 站点配置的「防漂移」检查（v0.9.91）。
//
// 背景：2026-11-14 复查发现 deploy/production 里的 vhost 和线上那份早就不是一回事——
// 线上手加过私有图 ^~ 覆盖、/print/、安全头。也就是说，谁照着文档重跑一次部署脚本，
// 自己上传的图和模板帧图就会重新掉回「7 天 public 缓存」，打印页也会掉回 SPA 的 index.html。
//
// 现在的结构：nginx-app.conf 是唯一写着 location 的文件；nginx-http.conf / nginx-tls.conf
// 只是薄外壳，用 include 把应用段拉进来。这个脚本检查结构本身是否还成立，
// 所以「以后加一个私有目录、只改了线上」这类漂移会在 npm test 里红掉，而不是等下次出事。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// 模板里允许出现的占位符，和 deploy/production/render-vhost.sh 的 sed 清单必须一致
export const PLACEHOLDERS = [
  '__DOMAIN__',
  '__APP_DIR__',
  '__API_PORT__',
  '__ACME_DIR__',
  '__APP_CONF__',
  '__CERT_DIR__',
  '__ACCESS_LOG__',
  '__HTTP_PORT__',
]

const SECURITY_HEADERS = [
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'X-Frame-Options',
  'Permissions-Policy',
]

// 必须存在的 location，以及缺了它会出什么事（报错直接说后果，不然半年后没人记得为什么）
const REQUIRED_LOCATIONS = [
  ['= /index.html', '入口 HTML 会被浏览器缓存，发版后还在用旧 bundle'],
  ['/assets/', '带 hash 的产物没有 immutable 长缓存，每次都回源'],
  ['/api/', '接口没被反代'],
  ['^~ /media/uploads/', '自己上传的图会掉回 /media/ 的 7 天 public 缓存（私有图被公开缓存）'],
  ['^~ /media/frames/', '模板帧图会掉回 /media/ 的 7 天 public 缓存（私有画面被公开缓存）'],
  ['/media/', '帧图缩略图没有长缓存'],
  ['^~ /print/', '打印页会被 try_files 兜成 SPA 的 index.html'],
  ['/', '没有静态产物 fallback'],
]

// 私有目录：缓存头必须由应用给（private + ETag），nginx 不许插手
const PRIVATE_LOCATIONS = ['^~ /media/uploads/', '^~ /media/frames/']

export function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('#')
      // nginx 的注释从 # 到行尾
      return at >= 0 ? line.slice(0, at) : line
    })
    .join('\n')
}

// 按大括号取出块（够用即可：vhost 里不会出现正则大括号）。
// 片段式的应用段（没有 server 外壳）里，顶层指令收在 preamble 里，不然会被丢掉。
export function parseConfig(text) {
  const lines = stripComments(text).split('\n')
  const preamble = []
  const blocks = []
  const stack = []
  let current = null
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.endsWith('{')) {
      const block = { head: trimmed.slice(0, -1).trim(), body: [], line: index + 1, children: [] }
      if (current) current.children.push(block)
      else blocks.push(block)
      stack.push(block)
      current = block
      return
    }
    if (trimmed === '}') {
      stack.pop()
      current = stack.length ? stack[stack.length - 1] : null
      return
    }
    if (current) current.body.push(trimmed)
    else preamble.push(trimmed)
  })
  return { preamble, blocks }
}

export function parseBlocks(text) {
  return parseConfig(text).blocks
}

export function allBlocks(text) {
  const flat = []
  const walk = (list) => {
    for (const block of list) {
      flat.push(block)
      walk(block.children || [])
    }
  }
  walk(parseBlocks(text))
  return flat
}

const headText = (block) =>
  block.head.startsWith('location ') ? block.head.slice('location '.length).trim() : block.head

const directive = (name) =>
  new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^;]+);')

function findDirective(body, name) {
  const re = directive(name)
  for (const line of body) {
    const match = re.exec(line)
    if (match) return match[1].trim()
  }
  return null
}

function headerNames(body) {
  return body
    .map((line) => /^add_header\s+([A-Za-z0-9-]+)\s+/i.exec(line))
    .filter(Boolean)
    .map((match) => match[1])
}

// ---- 应用段 ----

export function checkAppBody(text, { rendered = false } = {}) {
  const issues = []
  const where = rendered ? '渲染后的应用段' : 'nginx-app.conf'
  const { preamble, blocks: top } = parseConfig(text)
  const serverLevel = top.find((block) => block.head === 'server')
  const outer = serverLevel ? serverLevel.body : preamble

  for (const line of outer) {
    if (/^listen\s/.test(line)) issues.push(where + '：应用段里出现了 listen，端口归外壳管（否则两份外壳各说一套）')
    if (/^ssl_certificate/.test(line)) issues.push(where + '：应用段里出现了 ssl_certificate，证书归外壳管')
  }

  const locations = allBlocks(text).filter((block) => block.head.startsWith('location '))
  const heads = locations.map(headText)

  for (const [head, consequence] of REQUIRED_LOCATIONS) {
    if (!heads.includes(head)) issues.push(where + '：缺少 location ' + head + ' —— ' + consequence)
  }

  const bodyOf = (head) => {
    const block = locations.find((item) => headText(item) === head)
    return block ? block.body : null
  }

  for (const head of PRIVATE_LOCATIONS) {
    const body = bodyOf(head)
    if (!body) continue
    if (body.some((line) => /cache-control/i.test(line))) {
      issues.push(
        where + '：' + head + ' 自己设了 Cache-Control —— 私有图的缓存头必须由应用给（private + ETag），nginx 一插手就变成公共缓存',
      )
    }
    if (findDirective(body, 'proxy_pass') === null) issues.push(where + '：' + head + ' 没有 proxy_pass，请求没人接')
    if (findDirective(body, 'proxy_set_header X-Real-IP') === null) {
      issues.push(where + '：' + head + ' 没把 X-Real-IP 交给应用，日志和按 IP 的限流会拿到反代地址')
    }
  }

  const plainMedia = bodyOf('/media/')
  if (plainMedia) {
    const cache = findDirective(plainMedia, 'add_header Cache-Control')
    if (!cache || !/max-age=604800/.test(cache)) issues.push(where + '：/media/ 的公开长缓存丢了（7 天）')
  }
  if (heads.includes('^~ /media/uploads/') && heads.includes('^~ /media/frames/') && heads.includes('/media/')) {
    const ordered =
      heads.indexOf('^~ /media/uploads/') < heads.indexOf('/media/') &&
      heads.indexOf('^~ /media/frames/') < heads.indexOf('/media/')
    if (!ordered) issues.push(where + '：私有目录的 ^~ 块必须排在 /media/ 之前，否则私有图会先被 /media/ 接走')
  }

  const api = bodyOf('/api/')
  if (api) {
    if (headerNames(api).length) {
      issues.push(where + '：/api/ 里写了 add_header，会丢掉继承来的整套安全头（接口响应就没有 nosniff 了）')
    }
    const forward = findDirective(api, 'proxy_set_header X-Forwarded-For')
    if (forward !== '$remote_addr') {
      issues.push(where + '：/api/ 的 X-Forwarded-For 不是 $remote_addr（客户端自带的 XFF 会被拼进来）')
    }
    if (findDirective(api, 'proxy_read_timeout') === null) {
      issues.push(where + '：/api/ 没有 proxy_read_timeout，长任务会被 nginx 先掐断')
    }
  }

  const index = bodyOf('= /index.html')
  if (index) {
    const cache = findDirective(index, 'add_header Cache-Control')
    if (!cache || !/no-store/.test(cache)) issues.push(where + '：入口 HTML 的 no-store 丢了，发版后浏览器会用旧 bundle')
  }
  const assets = bodyOf('/assets/')
  if (assets) {
    const cache = findDirective(assets, 'add_header Cache-Control')
    if (!cache || !/immutable/.test(cache)) issues.push(where + '：/assets/ 的 immutable 长缓存丢了')
  }
  const root = bodyOf('/')
  if (root && findDirective(root, 'try_files') === null) issues.push(where + '：location / 没有 try_files，刷新深链接会 404')

  // 安全头：server 段必须整套；任何自己写了 add_header 的 location 也必须整套（nginx 不会合并）
  const baseHeaders = new Set(headerNames(outer))
  for (const header of SECURITY_HEADERS) if (!baseHeaders.has(header)) issues.push(where + '：顶层（继承的那一层）缺 ' + header)
  for (const block of locations) {
    const own = headerNames(block.body)
    if (!own.length) continue // 没写就继承，正确
    for (const header of SECURITY_HEADERS) {
      if (!own.includes(header)) {
        issues.push(
          where + '：location ' + headText(block) + ' 自己写了 add_header 却漏了 ' + header + '（nginx 不会和 server 段合并，这个 location 就没有它了）',
        )
      }
    }
  }

  if (stripComments(text).includes('$proxy_add_x_forwarded_for')) {
    issues.push(where + '：还在用 $proxy_add_x_forwarded_for，应改 $remote_addr')
  }

  if (!rendered) {
    const used = new Set(text.match(/__[A-Z_]+__/g) || [])
    for (const placeholder of used) {
      if (!PLACEHOLDERS.includes(placeholder)) issues.push(where + '：用了未登记的占位符 ' + placeholder)
    }
    for (const need of ['__APP_DIR__', '__API_PORT__', '__ACCESS_LOG__']) {
      if (!used.has(need)) issues.push(where + '：没用到 ' + need + '（模板被写死了，换台机器就废）')
    }
    if (/visionqa\.wavisionai\.cn|\/opt\/visionqa/.test(text)) issues.push(where + '：模板里写死了这台机器的域名或目录')
  } else {
    const leftover = text.match(/__[A-Z_]+__/g)
    if (leftover) issues.push(where + '：渲染后仍留着占位符 ' + [...new Set(leftover)].join(' '))
  }

  return issues
}

// ---- 外壳 ----

export function checkWrapper(text, kind, { rendered = false } = {}) {
  const issues = []
  const where = kind === 'tls' ? 'nginx-tls.conf' : 'nginx-http.conf'
  const heads = allBlocks(text)
    .filter((block) => block.head.startsWith('location '))
    .map(headText)
  const allowed = kind === 'tls' ? ['/.well-known/acme-challenge/', '/'] : ['/.well-known/acme-challenge/']
  for (const head of heads) {
    if (!allowed.includes(head)) {
      issues.push(where + '：外壳里出现了 location ' + head + ' —— 应用段必须留在 nginx-app.conf 里，一份就够')
    }
  }
  if (rendered) {
    if (!/include .+\.app\.inc;/.test(text)) issues.push(where + '：渲染后没有 include *.app.inc，应用段根本没接上来')
    if (!/server_name +\S+;/.test(text)) issues.push(where + '：渲染后没有 server_name')
    const leftover = text.match(/__[A-Z_]+__/g)
    if (leftover) issues.push(where + '：渲染后仍留着占位符 ' + [...new Set(leftover)].join(' '))
  } else {
    if (!text.includes('include __APP_CONF__;')) issues.push(where + '：没有 include __APP_CONF__，应用段根本没接上来')
    if (!text.includes('__DOMAIN__') || !text.includes('__ACME_DIR__')) issues.push(where + '：缺 __DOMAIN__ 或 __ACME_DIR__')
  }
  if (text.includes('add_header')) issues.push(where + '：外壳里写了 add_header，安全头应该只在 nginx-app.conf 里出现一次')
  if (text.includes('proxy_pass')) issues.push(where + '：外壳里写了 proxy_pass，反代属于应用段')

  if (kind === 'tls') {
    if (!/listen 443 ssl;/.test(text)) issues.push(where + '：没有 443 ssl')
    if (!/ssl_certificate +\S+\/fullchain\.pem;/.test(text)) issues.push(where + '：证书路径不对')
    if (!text.includes('return 301 https://$host$request_uri;')) issues.push(where + '：80 没有跳转到 https')
    if (!text.includes('options-ssl-nginx.conf') || !text.includes('ssl_dhparam')) {
      issues.push(where + '：缺 certbot 的两段 include（证书链与 DH 参数）')
    }
  } else if (/listen 443|ssl_certificate/.test(text)) {
    issues.push(where + '：HTTP 阶段不该出现 TLS 指令')
  }
  if (kind === 'tls' && !rendered && !text.includes('__CERT_DIR__')) {
    issues.push(where + '：证书路径没走 __CERT_DIR__')
  }
  return issues
}

// ---- 部署脚本 ----

const SCRIPT_RULES = [
  ['proxy_set_header', '反代指令应该留在 nginx-app.conf，脚本里内联就是下一份会漂移的配置'],
  ['add_header', '安全头应该只在 nginx-app.conf 里出现'],
  ['location ', '脚本里内联 location 就是又一份会和模板漂移的 vhost'],
  ['$proxy_add_x_forwarded_for', '旧写法'],
]

// 只看会执行的命令行：注释里提到 location / add_header 是在解释为什么不能那么写，不算违规
const codeLines = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

export function checkScripts(files) {
  const issues = []
  for (const [name, text] of Object.entries(files)) {
    const code = codeLines(text)
    for (const [needle, why] of SCRIPT_RULES) {
      if (code.includes(needle)) issues.push(name + '：出现了 ' + needle.trim() + ' —— ' + why)
    }
    for (const need of ['render-vhost.sh', 'nginx-app.conf', 'nginx-tls.conf']) {
      if (!text.includes(need)) issues.push(name + '：没有引用 ' + need)
    }
    if (name === 'install.sh' && !text.includes('nginx-http.conf')) {
      issues.push(name + '：没有引用 nginx-http.conf（没有证书时要用它）')
    }
    if (name === 'install.sh' && !text.includes('[ -d "$CERT_DIR" ]')) {
      issues.push(name + '：没判断证书是否已存在，重跑一次会把 HTTPS 站点换成 HTTP')
    }
    // 片段必须是 .inc：conf.d/*.conf 在 http 层被 include，带 location 的片段放进去 nginx -t 直接失败
    if (!text.includes('.app.inc')) issues.push(name + '：应用段片段没落在 *.app.inc 上（conf.d/*.conf 会被 http 层整段 include）')
    if (text.includes('.app.conf')) issues.push(name + '：应用段片段不能叫 .app.conf —— conf.d/*.conf 在 http 层被 include，nginx -t 会报 location 不许在这里')
  }
  return issues
}

// ---- 占位符与渲染 ----

export function usedPlaceholders(texts) {
  const used = new Set()
  for (const text of texts) for (const item of text.match(/__[A-Z_]+__/g) || []) used.add(item)
  return used
}

export function sedPlaceholders(script) {
  return new Set((script.match(/s\|(__[A-Z_]+__)\|/g) || []).map((item) => item.slice(2, -1)))
}

export function renderTemplate(text, vars) {
  let out = text
  for (const placeholder of PLACEHOLDERS) {
    const value = vars[placeholder]
    if (value === undefined) throw new Error('渲染时缺 ' + placeholder)
    out = out.split(placeholder).join(String(value))
  }
  return out
}

export function renderAll(files, vars) {
  return {
    app: renderTemplate(files.app, vars),
    http: renderTemplate(files.http, vars),
    tls: renderTemplate(files.tls, vars),
  }
}

// ---- 入口 ----

export function checkRepo(root = REPO) {
  const deploy = join(root, 'deploy', 'production')
  const read = (name) => readFileSync(join(deploy, name), 'utf8')
  const files = {
    app: read('nginx-app.conf'),
    http: read('nginx-http.conf'),
    tls: read('nginx-tls.conf'),
    renderer: read('render-vhost.sh'),
    scripts: {
      'install.sh': read('install.sh'),
      'enable-https.sh': read('enable-https.sh'),
    },
  }
  const issues = [
    ...checkAppBody(files.app),
    ...checkWrapper(files.http, 'http'),
    ...checkWrapper(files.tls, 'tls'),
    ...checkScripts(files.scripts),
  ]
  const used = usedPlaceholders([files.app, files.http, files.tls])
  const seded = sedPlaceholders(files.renderer)
  for (const placeholder of used) {
    if (!seded.has(placeholder)) {
      issues.push('render-vhost.sh：没有替换 ' + placeholder + '（模板用了但脚本没传，nginx -t 会报错）')
    }
  }
  for (const placeholder of seded) {
    if (!PLACEHOLDERS.includes(placeholder)) issues.push('render-vhost.sh：替换了未登记的 ' + placeholder)
  }
  if (seded.size !== PLACEHOLDERS.length) {
    issues.push('render-vhost.sh：sed 清单有 ' + seded.size + ' 个占位符，登记表有 ' + PLACEHOLDERS.length + ' 个，两边对不上')
  }
  return { issues, files }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { issues, files } = checkRepo()
  const rendered = renderAll(files, {
    __DOMAIN__: 'example.com',
    __APP_DIR__: '/opt/visionqa',
    __API_PORT__: '8799',
    __ACME_DIR__: '/var/www/acme',
    __APP_CONF__: '/etc/nginx/conf.d/example.com.app.inc',
    __CERT_DIR__: '/etc/letsencrypt/live/example.com',
    __ACCESS_LOG__: 'off',
    __HTTP_PORT__: '80',
  })
  // 冒烟：渲染一遍再按「渲染结果」的规则检查一遍（域名用 example.com，不碰生产）
  issues.push(
    ...checkAppBody(rendered.app, { rendered: true }),
    ...checkWrapper(rendered.tls, 'tls', { rendered: true }),
    ...checkWrapper(rendered.http, 'http', { rendered: true }),
  )
  if (issues.length) {
    console.error('nginx 配置检查未通过（' + issues.length + ' 项）：')
    for (const issue of issues) console.error(' - ' + issue)
    process.exit(1)
  }
  console.log('nginx 配置检查通过：应用段 ' + rendered.app.split('\n').length + ' 行、两份外壳、渲染无残留占位符')
}
