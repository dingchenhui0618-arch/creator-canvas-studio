// 生成 Windows 图标：品牌 mark 叠在圆角深色底上，按需要的尺寸各渲一张，再封成 ICO。
// 运行：npx electron .tmp-qa/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const HTML = "<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;background:transparent}</style>\n<canvas id=\"c\" width=\"256\" height=\"256\"></canvas>\n<script>\nconst svg = \"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 256 256\\\" width=\\\"256\\\" height=\\\"256\\\">\\n  <rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"256\\\" height=\\\"256\\\" rx=\\\"58\\\" fill=\\\"#0c0c0d\\\"/>\\n  <g transform=\\\"translate(27 27) scale(0.79)\\\">\\n    <circle cx=\\\"136\\\" cy=\\\"116\\\" r=\\\"49\\\" fill=\\\"none\\\" stroke=\\\"#9c9c9a\\\" stroke-width=\\\"20\\\"/>\\n    <path d=\\\"M38 78V38h40v16H54v24Z\\\" fill=\\\"#f5f5f3\\\"/>\\n    <path d=\\\"M178 178h24v-24h16v40h-40Z\\\" fill=\\\"#f5f5f3\\\"/>\\n    <path d=\\\"M48 82h27l37 59 37-59h27l-52 90h-24Z\\\" fill=\\\"#f5f5f3\\\"/>\\n    <path d=\\\"M151 149l39 39-15 15-39-39Z\\\" fill=\\\"#f5f5f3\\\"/>\\n  </g>\\n</svg>\";\nwindow.render = (size) => new Promise((resolve, reject) => {\n  const img = new Image();\n  img.onload = () => {\n    const c = document.getElementById('c');\n    c.width = size; c.height = size;\n    const ctx = c.getContext('2d');\n    ctx.clearRect(0, 0, size, size);\n    ctx.imageSmoothingQuality = 'high';\n    ctx.drawImage(img, 0, 0, size, size);\n    resolve(c.toDataURL('image/png'));\n  };\n  img.onerror = reject;\n  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));\n});\n</script>"
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const OUT = path.join(process.cwd(), 'build')
const LOG = path.join(OUT, 'icon.log')
fs.mkdirSync(OUT, { recursive: true })
const log = (...parts) => fs.appendFileSync(LOG, parts.join(' ') + '\n')

function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

setTimeout(() => { log('hard timeout'); app.exit(3) }, 25000)

app.whenReady().then(async () => {
  log('ready')
  const win = new BrowserWindow({ show: false, width: 320, height: 320 })
  win.webContents.on('console-message', (_e, _level, message) => log('page:', message))
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  log('loaded')
  fs.mkdirSync(OUT, { recursive: true })
  const pngs = []
  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript('window.render(' + size + ')')
    const data = Buffer.from(String(dataUrl).split(',')[1], 'base64')
    pngs.push({ size, data })
    if (size === 256) fs.writeFileSync(path.join(OUT, 'icon.png'), data)
    log('icon', size, data.length)
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs))
  log('wrote build/icon.ico', fs.statSync(path.join(OUT, 'icon.ico')).size)
  app.exit(0)
}).catch((error) => { log('failed', error && error.stack ? error.stack : String(error)); app.exit(1) })