// nginx 站点配置的防漂移检查（v0.9.91）。
// 这一轮修的是一个"文档与线上不一致"的坑：照着 README 重跑一次部署脚本，私有图会掉回
// 7 天 public 缓存。所以测试的重点是——把这些规则钉住，并且**证明检查器真能抓到**，
// 不然它就是一个永远绿的摆设（每条规则都配一个反向用例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLACEHOLDERS,
  checkAppBody,
  checkRepo,
  checkScripts,
  renderTemplate,
  sedPlaceholders,
  usedPlaceholders,
} from '../scripts/check-nginx.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = join(REPO, 'deploy', 'production')
const read = (name) => readFileSync(join(DEPLOY, name), 'utf8')

// 在一份临时副本上改一行，再看检查器有没有报出来
function mutated(file, change) {
  const root = mkdtempSync(join(tmpdir(), 'vq-nginx-'))
  const dir = join(root, 'deploy', 'production')
  cpSync(DEPLOY, dir, { recursive: true })
  const path = join(dir, file)
  const before = readFileSync(path, 'utf8')
  const after = change(before)
  assert.notEqual(after, before, '用例本身没改动文件')
  writeFileSync(path, after)
  try {
    return checkRepo(root).issues
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const has = (issues, needle) => issues.some((issue) => issue.includes(needle))
const find = (issues, needle) => {
  const hit = issues.find((issue) => issue.includes(needle))
  assert.ok(hit, '期望有一项包含「' + needle + '」，实际只有：' + (issues.join(' / ') || '（无）'))
  return hit
}

test('仓库里的配置通过：应用段一份 + 两个外壳 + 两个脚本', () => {
  const { issues, files } = checkRepo()
  assert.deepEqual(issues, [])
  assert.ok(files.app.includes('location ^~ /media/uploads/'))
  assert.ok(!files.app.includes('visionqa.wavisionai.cn'), '模板不许写死这台机器的域名')
  assert.ok(!files.app.includes('/opt/visionqa'), '模板不许写死这台机器的目录')
})

test('模板用到的占位符，渲染脚本一个不少地替换', () => {
  const { files } = checkRepo()
  const used = usedPlaceholders([files.app, files.http, files.tls])
  const seded = sedPlaceholders(files.renderer)
  assert.deepEqual([...used].sort(), [...seded].sort())
  assert.deepEqual([...seded].sort(), [...PLACEHOLDERS].sort())
})

test('渲染：占位符全部替换，两份外壳都 include 同一个应用段', () => {
  const { files } = checkRepo()
  const vars = {
    __DOMAIN__: 'example.com',
    __APP_DIR__: '/srv/app',
    __API_PORT__: '9001',
    __ACME_DIR__: '/var/acme',
    __APP_CONF__: '/etc/nginx/conf.d/example.com.app.inc',
    __CERT_DIR__: '/etc/letsencrypt/live/example.com',
    __ACCESS_LOG__: 'off',
    __HTTP_PORT__: '80',
  }
  const http = renderTemplate(files.http, vars)
  const tls = renderTemplate(files.tls, vars)
  for (const text of [http, tls]) {
    assert.ok(text.includes('include /etc/nginx/conf.d/example.com.app.inc;'))
    assert.ok(!/__[A-Z_]+__/.test(text))
  }
  assert.ok(tls.includes('listen 443 ssl;'))
  assert.ok(tls.includes('ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;'))
  assert.ok(!http.includes('ssl_certificate'))
})

test('反向用例：删掉模板帧图的 ^~ 覆盖，检查器必须报「会掉回 7 天 public 缓存」', () => {
  const issues = mutated('nginx-app.conf', (text) =>
    text.replace(/location \^~ \/media\/frames\/ \{[\s\S]*?\n\}\n/, ''),
  )
  const hit = find(issues, '^~ /media/frames/')
  assert.ok(hit.includes('7 天 public 缓存'), '报错要直接说后果：' + hit)
})

test('反向用例：私有图目录自己设 Cache-Control，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) =>
    text.replace('location ^~ /media/uploads/ {\n', 'location ^~ /media/uploads/ {\n    add_header Cache-Control "public, max-age=604800";\n'),
  )
  assert.ok(has(issues, '/media/uploads/ 自己设了 Cache-Control'))
})

test('反向用例：私有图目录丢了 X-Real-IP，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) => {
    const at = text.indexOf('location ^~ /media/uploads/ {')
    const end = text.indexOf('}', at)
    const block = text.slice(at, end).replace(/\n\s*proxy_set_header X-Real-IP \$remote_addr;/, '')
    return text.slice(0, at) + block + text.slice(end)
  })
  assert.ok(has(issues, '没把 X-Real-IP 交给应用'))
})

test('反向用例：顶层少一个安全头，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) =>
    text.replace('add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n', ''),
  )
  assert.ok(has(issues, '顶层（继承的那一层）缺 Referrer-Policy'))
})

test('反向用例：某个 location 自己写了 add_header 却漏一个，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) => {
    const at = text.indexOf('location ^~ /print/ {')
    const end = text.indexOf('}', at)
    const block = text.slice(at, end).replace(/\n\s*add_header Permissions-Policy [^\n]*\n/, '\n')
    return text.slice(0, at) + block + text.slice(end)
  })
  assert.ok(has(issues, 'location ^~ /print/ 自己写了 add_header 却漏了 Permissions-Policy'))
})

test('反向用例：X-Forwarded-For 换回旧写法，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) =>
    text.replace('proxy_set_header X-Forwarded-For $remote_addr;', 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'),
  )
  assert.ok(has(issues, '$proxy_add_x_forwarded_for'))
})

test('反向用例：入口 HTML 改成可缓存，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) =>
    text.replace('add_header Cache-Control "no-store, no-cache, must-revalidate" always;', 'add_header Cache-Control "public, max-age=3600" always;'),
  )
  assert.ok(has(issues, '入口 HTML 的 no-store 丢了'))
})

test('反向用例：私有目录排到 /media/ 后面，检查器必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) => {
    // 把公开的 /media/ 挪到两个私有 ^~ 覆盖前面：nginx 前缀匹配取最长，但顺序写错时
    // 读代码的人会以为私有目录排在前面，检查器要能拦住这种「看起来对」的配置
    const start = text.indexOf('location /media/ {')
    const end = text.indexOf('\n}', start) + 2
    const plain = text.slice(start, end)
    const rest = text.slice(0, start) + text.slice(end)
    return rest.replace('location = /index.html {', plain + '\n\nlocation = /index.html {')
  })
  assert.ok(has(issues, '必须排在 /media/ 之前'))
})

test('反向用例：HTTPS 外壳里再塞一个 location，检查器必须拦', () => {
  const issues = mutated('nginx-tls.conf', (text) =>
    text.replace('    include __APP_CONF__;', '    location /media/ {\n        proxy_pass http://127.0.0.1:__API_PORT__;\n    }\n\n    include __APP_CONF__;'),
  )
  assert.ok(has(issues, '外壳里出现了 location /media/'))
})

test('反向用例：部署脚本又内联 location / 安全头，检查器必须拦', () => {
  const issues = checkScripts({
    'install.sh': read('install.sh') + '\n    location /media/ { proxy_pass http://127.0.0.1:8799; }\n',
    'enable-https.sh': read('enable-https.sh') + '\n    location /print/ { add_header Cache-Control "public"; }\n',
  })
  assert.ok(has(issues, 'install.sh：出现了 location '))
  assert.ok(has(issues, 'enable-https.sh：出现了 add_header'))
  assert.ok(has(issues, 'enable-https.sh：出现了 location '))
})

test('反向用例：模板用了渲染脚本没登记的占位符，checkRepo 必须拦', () => {
  const issues = mutated('nginx-app.conf', (text) => text.replace('client_max_body_size 64m;', 'client_max_body_size 64m;\nserver_name __NEW_THING__;'))
  assert.ok(has(issues, '未登记的占位符 __NEW_THING__'))
})

test('反向用例：渲染脚本少传一个占位符，checkRepo 必须拦', () => {
  const issues = mutated('render-vhost.sh', (text) => text.replace(/\n\s*-e "s\|__HTTP_PORT__\|[^\n]*\n/, '\n'))
  assert.ok(has(issues, '没有替换 __HTTP_PORT__') || has(issues, '两边对不上'))
})

test('安装脚本重跑不许把 HTTPS 站点换回 HTTP', () => {
  const install = read('install.sh')
  assert.ok(install.includes('letsencrypt/live'), '要先看证书在不在')
  assert.ok(install.includes('nginx-tls.conf') && install.includes('nginx-http.conf'))
  assert.ok(install.includes('.bak-'), '覆盖线上配置前要留备份')
  const issues = mutated('install.sh', (text) => text.replace(/if \[ -d "\$CERT_DIR" \]; then[\s\S]*?fi\n/, ''))
  assert.ok(has(issues, '没判断证书是否已存在'))
})

test('应用段片段必须叫 .app.inc：叫 .conf 会被 http 层整段 include', () => {
  // conf.d/*.conf 是在 http 层被 include 的：带 location 的片段放进去，nginx -t 直接失败
  const issues = mutated('install.sh', (text) => text.replace('.app.inc', '.app.conf'))
  assert.ok(has(issues, '不能叫 .app.conf'))
  const clean = mutated('enable-https.sh', (text) => text.replace('.app.inc', '.app.conf'))
  assert.ok(has(clean, '不能叫 .app.conf'))
})

test('应用段里出现 listen 或证书，检查器必须拦（那些归外壳）', () => {
  const issues = checkAppBody(read('nginx-app.conf') + '\nserver {\n    listen 8443;\n}\n')
  assert.ok(has(issues, '应用段里出现了 listen'))
})
