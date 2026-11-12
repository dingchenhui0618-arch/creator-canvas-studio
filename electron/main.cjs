// VisionQA 桌面外壳：只套壳，不改网页本体。
// 唯一多出来的东西是「本地工作区」——agent loop、工具、会话记忆都跑在这台机器上，
// 模型补全仍然走 VisionQA 服务端（平台 Key 不下发到客户端）。
//
// 主进程用 CJS：Electron 的 ESM 主进程在部分版本里拿不到 'electron' 的导出，
// 用 require 最稳；agent 那几个模块是 ESM，运行时用动态 import 载入。
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')

const LOCAL_URL =
  process.env.VQ_DESKTOP_URL ||
  (process.argv.includes('--local') ? 'http://127.0.0.1:5191' : 'https://visionqa.wavisionai.cn')

let ThreadStore = null
let MemoryStore = null
let createTools = null
let runTurn = null
let DEFAULT_LIMITS = { maxSteps: 8, maxToolOutput: 8000 }
let COMPACTION = null
let MEMORY_LIMITS = { maxEntries: 40, maxEntryChars: 300, injectEntries: 8, injectChars: 1600 }
let writeFileAtomic = null

async function loadAgent() {
  ;({ ThreadStore } = await import('./agent/store.mjs'))
  ;({ MemoryStore, MEMORY_LIMITS } = await import('./agent/memory.mjs'))
  ;({ createTools } = await import('./agent/tools.mjs'))
  ;({ runTurn, DEFAULT_LIMITS } = await import('./agent/loop.mjs'))
  ;({ COMPACTION } = await import('./agent/compaction.mjs'))
  ;({ writeFileAtomic } = await import('./agent/atomic.mjs'))
}

const DEFAULT_WORKSPACE = path.join(app.getPath('documents'), 'VisionQA 工作区')

let win = null
let store = null
let memory = null
let settingsFile = ''
let stateFile = ''
const approvalQueue = new Map()
let activeRun = null

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2))
}

async function settings() {
  const current = await readJson(settingsFile, {})
  if (!current.workspace) {
    current.workspace = DEFAULT_WORKSPACE
    await writeJson(settingsFile, current)
  }
  return current
}

async function ensureWorkspace() {
  const current = await settings()
  await fsp.mkdir(current.workspace, { recursive: true })
  return current.workspace
}

function emitEvent(threadId, event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { threadId, event })
}

// 模型这一步的补全：请求打到当前页面所在的 VisionQA 服务，带上浏览器自己的会话 Cookie。
// 这样桌面端和网页版用的是同一个账号、同一套积分与降级链。
async function makeComplete(threadId) {
  const origin = new URL(win.webContents.getURL()).origin
  const cookies = await session.defaultSession.cookies.get({ url: origin })
  const cookieHeader = cookies.map((item) => item.name + '=' + item.value).join('; ')
  const turnId = 't_' + threadId.slice(-8) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  return async (messages, options = {}) => {
    const response = await fetch(origin + '/api/local-agent/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      body: JSON.stringify({ turnId, messages, maxTokens: options.maxTokens || 1600 }),
      signal: options.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload.error || '模型补全失败（HTTP ' + response.status + '）')
      error.code = payload.code
      throw error
    }
    return String(payload.text || '')
  }
}

function askApproval(threadId, request) {
  return new Promise((resolve) => {
    const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    approvalQueue.set(id, resolve)
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { threadId, event: { type: 'approval', id, ...request } })
      if (win.isMinimized()) win.restore()
      win.flashFrame(true)
    } else {
      approvalQueue.delete(id)
      resolve(false)
    }
  })
}

async function handleSend({ threadId, text }) {
  if (activeRun) return { ok: false, error: '上一轮还在跑，先停下来' }
  const message = String(text || '').trim()
  if (!message) return { ok: false, error: '先输入要做的事' }
  const thread = await store.get(threadId)
  const renamed = !thread.title || thread.title === '新的本地会话'
  thread.messages.push({ role: 'user', content: message })
  if (renamed) thread.title = message.slice(0, 24)
  await store.save(thread)
  emitEvent(thread.id, { type: 'user', text: message })
  // 长一轮里会话栏不该一直写着「新的本地会话 / 0 条」：改名与条数在事件里就带上
  if (renamed) emitEvent(thread.id, { type: 'title', text: thread.title })

  const workspace = await ensureWorkspace()

  // 「记住：…」直接写进长期记忆，不调模型、不扣积分：记一句话不该花一次补全。
  const rememberMatch = memory ? message.match(/^(?:\/记住|\/remember|记住[：:])\s*([\s\S]+)$/i) : null
  if (rememberMatch) {
    const outcome = await memory.add(workspace, { text: rememberMatch[1], source: 'user' })
    const reply = outcome.ok
      ? (outcome.action === 'updated' ? '这条以前记过，已更新原文：' : '已记住，这个工作区以后的会话都能看到：') + outcome.entry.text
      : '没记下来：' + outcome.output
    thread.messages.push({ role: 'assistant', content: reply })
    await store.save(thread)
    emitEvent(thread.id, { type: 'assistant', text: reply })
    emitEvent(thread.id, { type: 'memory', phase: 'changed', total: outcome.total || 0 })
    emitEvent(thread.id, { type: 'turn-end' })
    return { ok: outcome.ok, remembered: outcome.ok }
  }

  thread.turns = (thread.turns || 0) + 1
  await store.save(thread)
  const controller = new AbortController()
  activeRun = { threadId, controller }
  try {
    const result = await runTurn({
      thread,
      workspace,
      tools: createTools({ root: workspace, maxOutput: DEFAULT_LIMITS.maxToolOutput, memory, workspace }),
      complete: await makeComplete(thread.id),
      memory,
      signal: controller.signal,
      emit: (event) => {
        emitEvent(thread.id, event)
        // 智能体自己记了一条：面板上的条数得跟着变，否则用户会以为没记上
        if (event.type === 'tool' && event.tool === 'remember' && event.phase === 'done' && event.ok) {
          emitEvent(thread.id, { type: 'memory', phase: 'changed' })
        }
      },
      approve: (request) => askApproval(thread.id, request),
    })
    await store.save(thread)
    // 存盘之后再通知界面刷新会话列表：先发的话列表里的「N 条」还是旧值
    emitEvent(thread.id, { type: 'turn-end' })
    return { ok: true, ...result }
  } finally {
    activeRun = null
    for (const [id, resolve] of approvalQueue) {
      approvalQueue.delete(id)
      resolve(false)
    }
  }
}

async function createWindow() {
  const bounds = await readJson(stateFile, { width: 1440, height: 940 })
  win = new BrowserWindow({
    width: Math.max(1024, bounds.width || 1440),
    height: Math.max(700, bounds.height || 940),
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 700,
    title: 'VisionQA',
    backgroundColor: '#f4f4f4',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 预加载用 ESM（.mjs），沙箱化的 preload 不支持 ESM；隔离仍然开着，
      // 页面拿不到 Node，只能通过 contextBridge 暴露的这几个方法说话。
      sandbox: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('close', saveBounds)
  // 页面刷新/重载时，主进程里等着的审批请求再也无人可答：直接中止这一轮。
  win.webContents.on('did-finish-load', () => {
    if (activeRun) {
      activeRun.controller.abort()
      for (const [id, resolve] of approvalQueue) {
        approvalQueue.delete(id)
        resolve(false)
      }
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    const allowed = new URL(LOCAL_URL)
    if (target.origin !== allowed.origin) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })
  await win.loadURL(LOCAL_URL)
  return win
}

async function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
  const [width, height] = win.getSize()
  const [x, y] = win.getPosition()
  await writeJson(stateFile, { width, height, x, y }).catch(() => {})
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '重新载入', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新页面' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '最大化' },
        ],
      },
      {
        label: '帮助',
        submenu: [
          { label: '打开网页版', click: () => shell.openExternal('https://visionqa.wavisionai.cn') },
          { label: '本地工作区在哪', click: () => ensureWorkspace().then((dir) => shell.showItemInFolder(dir)) },
          {
            label: '关于 VisionQA',
            click: () =>
              dialog.showMessageBox({
                message: 'VisionQA 桌面端 ' + app.getVersion(),
                detail: '网页外壳 + 本地工作区：agent loop 在本机运行，模型补全走 VisionQA 账号。',
              }),
          },
        ],
      },
    ]),
  )
}

function registerIpc() {
  ipcMain.handle('desktop:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    mode: process.argv.includes('--local') ? 'local' : 'remote',
    url: LOCAL_URL,
    workspace: await ensureWorkspace(),
    // 界面上显示的「每轮几步 / 上下文多大 / 何时压缩 / 记忆多少条」直接来自这里在用的值，不另写一份文案
    loop: DEFAULT_LIMITS,
    compaction: COMPACTION,
    memory: MEMORY_LIMITS,
  }))
  ipcMain.handle('memory:list', async () => memory.list(await ensureWorkspace()))
  ipcMain.handle('memory:remove', async (_event, id) => memory.remove(await ensureWorkspace(), String(id || '')))
  ipcMain.handle('memory:clear', async () => memory.clear(await ensureWorkspace()))
  ipcMain.handle('workspace:get', () => ensureWorkspace())
  ipcMain.handle('workspace:choose', async () => {
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择本地工作区目录',
    })
    if (picked.canceled || !picked.filePaths[0]) return ensureWorkspace()
    const current = await settings()
    current.workspace = picked.filePaths[0]
    await writeJson(settingsFile, current)
    await fsp.mkdir(current.workspace, { recursive: true })
    return current.workspace
  })
  ipcMain.handle('agent:threads:list', () => store.list())
  ipcMain.handle('agent:threads:create', () => store.create())
  ipcMain.handle('agent:threads:get', (_event, id) => store.get(String(id || '')))
  ipcMain.handle('agent:threads:delete', (_event, id) => store.remove(String(id || '')))
  ipcMain.handle('agent:send', (_event, payload) => handleSend(payload || {}))
  ipcMain.handle('agent:abort', () => {
    if (activeRun) activeRun.controller.abort()
    for (const [id, resolve] of approvalQueue) {
      approvalQueue.delete(id)
      resolve(false)
    }
    return { ok: true }
  })
  ipcMain.handle('agent:approve', (_event, payload) => {
    const id = String((payload && payload.id) || '')
    const resolve = approvalQueue.get(id)
    if (!resolve) return { ok: false, error: '这个请求已经失效' }
    approvalQueue.delete(id)
    resolve(Boolean(payload && payload.allow))
    if (win) win.flashFrame(false)
    return { ok: true }
  })
}

async function start() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  stateFile = path.join(app.getPath('userData'), 'window-state.json')
  await loadAgent()
  store = await new ThreadStore(path.join(app.getPath('userData'), 'local-agent')).ready()
  // 长期记忆与会话文件放在同一个应用目录下，但按工作区分文件：换个目录就换一份记忆
  memory = await new MemoryStore(path.join(app.getPath('userData'), 'local-agent')).ready()
  await ensureWorkspace()
  registerIpc()
  buildMenu()
  await createWindow()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.setAppUserModelId('cn.wavisionai.visionqa')
  app.whenReady().then(start)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}