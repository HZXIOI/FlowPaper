import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme } from 'electron'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import http from 'http'
import { spawnSync } from 'child_process'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const SERVER_PORT = 9876
const SERVER_HOST = '127.0.0.1'

// Trae 入口文件（solo-lite.html）相对安装根目录的路径
const SOLO_LITE_RELATIVE = ['resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'solo', 'solo-lite.html']

// Local server state
let currentVideoPath = ''
let currentOpacity = 20
let wss: WebSocketServer | null = null
let clients = new Set<WebSocket>()

const MARKER_START = '<!-- TRAE-WALLPAPER-PLAYER-START -->'
const MARKER_END = '<!-- TRAE-WALLPAPER-PLAYER-END -->'

// ============================================================
// Trae 安装路径自动查找
// 优先级：上次手动选择的配置 → 注册表 InstallLocation → 常见安装目录 → 手动选择
// ============================================================

interface FlowPaperConfig {
  traeRoot?: string
}

// 查找成功后缓存，避免每次应用壁纸都重复扫描
let cachedTraeRoot: string | null = null

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig(): FlowPaperConfig {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) return {}
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    console.error('读取配置文件失败:', err)
    return {}
  }
}

function saveConfig(config: FlowPaperConfig) {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('写入配置文件失败:', err)
  }
}

function saveTraeRoot(root: string) {
  const config = loadConfig()
  config.traeRoot = root
  saveConfig(config)
}

// 拼接 Trae 入口文件（solo-lite.html）的完整路径
function getSoloLitePath(traeRoot: string): string {
  return path.join(traeRoot, ...SOLO_LITE_RELATIVE)
}

// 校验目录是否为有效的 Trae 安装根目录（存在 solo-lite.html）
function isValidTraeRoot(root: string | undefined | null): root is string {
  if (!root) return false
  try {
    return fs.existsSync(getSoloLitePath(root))
  } catch {
    return false
  }
}

// 常见安装目录候选列表
function getCommonTraeRoots(): string[] {
  const candidates: string[] = []
  const add = (base: string | undefined, ...segments: string[]) => {
    if (base) candidates.push(path.join(base, ...segments))
  }
  add(process.env.LOCALAPPDATA, 'Programs', 'Trae')
  add(process.env.LOCALAPPDATA, 'Programs', 'Trae CN')
  add(process.env.ProgramFiles, 'TraeIDE')
  add(process.env.ProgramFiles, 'Trae CN')
  add(process.env['ProgramFiles(x86)'], 'Trae')
  add(process.env['ProgramFiles(x86)'], 'Trae CN')
  // 用户原有的自定义安装路径
  candidates.push('D:\\TRAE Word')
  return candidates
}

// 读取某一注册表卸载项根键下的所有条目
function queryUninstallEntries(root: string): Array<{ displayName: string; installLocation: string }> {
  const entries: Array<{ displayName: string; installLocation: string }> = []
  const result = spawnSync('reg', ['query', root, '/s'], { encoding: 'utf-8', windowsHide: true, timeout: 10000 })
  if (result.status !== 0 || !result.stdout) return entries

  let current: { displayName: string; installLocation: string } | null = null
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // 子键行（以 HKEY_ 开头）标志着一个新条目开始
    if (/^HKEY_/i.test(line)) {
      if (current) entries.push(current)
      current = { displayName: '', installLocation: '' }
      continue
    }
    if (!current) continue
    const match = line.match(/^(DisplayName|InstallLocation)\s+REG_SZ\s+(.+)$/i)
    if (!match) continue
    if (/^DisplayName$/i.test(match[1])) current.displayName = match[2].trim()
    else current.installLocation = match[2].trim()
  }
  if (current) entries.push(current)
  return entries
}

// 从注册表卸载信息中查找 Trae 的 InstallLocation
function findTraeRootFromRegistry(): string | null {
  if (process.platform !== 'win32') return null
  const uninstallRoots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ]
  for (const root of uninstallRoots) {
    try {
      for (const entry of queryUninstallEntries(root)) {
        if (!/trae/i.test(entry.displayName)) continue
        if (isValidTraeRoot(entry.installLocation)) return entry.installLocation
      }
    } catch (err) {
      // 注册表项可能因权限不足无法访问，忽略并继续尝试其它来源
      console.error(`查询注册表 ${root} 失败:`, err)
    }
  }
  return null
}

// 自动查找 Trae 安装根目录（不含手动选择）
async function resolveTraeRoot(): Promise<string | null> {
  if (isValidTraeRoot(cachedTraeRoot)) return cachedTraeRoot

  // a. 上次手动选择并持久化的路径
  const configured = loadConfig().traeRoot
  if (isValidTraeRoot(configured)) {
    cachedTraeRoot = configured
    return configured
  }

  // b. 注册表卸载信息中的 InstallLocation
  const fromRegistry = findTraeRootFromRegistry()
  if (isValidTraeRoot(fromRegistry)) {
    cachedTraeRoot = fromRegistry
    saveTraeRoot(fromRegistry)
    return fromRegistry
  }

  // c. 常见安装目录
  for (const candidate of getCommonTraeRoots()) {
    if (isValidTraeRoot(candidate)) {
      cachedTraeRoot = candidate
      saveTraeRoot(candidate)
      return candidate
    }
  }

  return null
}

// 自动查找失败时，弹出目录选择对话框让用户手动指定 Trae 安装根目录
async function promptForTraeRoot(): Promise<string | null> {
  const openOptions: Electron.OpenDialogOptions = {
    properties: ['openDirectory'],
    title: '请选择 Trae 安装根目录（包含 resources 文件夹）'
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, openOptions)
    : await dialog.showOpenDialog(openOptions)
  if (result.canceled || result.filePaths.length === 0) return null

  const selected = result.filePaths[0]
  if (!isValidTraeRoot(selected)) {
    const messageOptions: Electron.MessageBoxOptions = {
      type: 'error',
      title: '路径无效',
      message: '所选目录下未找到 solo-lite.html',
      detail: `请确认选择的是 Trae 安装根目录：\n${getSoloLitePath(selected)}`
    }
    if (mainWindow) await dialog.showMessageBox(mainWindow, messageOptions)
    else await dialog.showMessageBox(messageOptions)
    return null
  }

  cachedTraeRoot = selected
  saveTraeRoot(selected)
  return selected
}

// 统一入口：先自动查找，全部失败则弹窗手动选择
async function ensureTraeRoot(): Promise<string | null> {
  return (await resolveTraeRoot()) ?? (await promptForTraeRoot())
}

function createWindow(silent = false) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: !silent
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  // 关闭窗口时隐藏到托盘，而不是真正退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  // 优先使用 assets 里的图标（打包后位于 resources/assets），否则回退到相对路径
  let iconPath = path.join(process.resourcesPath, 'assets', 'icon.png')
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, '../../../assets/icon.png')
  }
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('FlowPaper')

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开播放器', click: () => showMainWindow() },
    { label: '应用到 Trae', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => showMainWindow())
}

function showMainWindow() {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

function startLocalServer() {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0]

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // === API 路由（供 Trae 内置面板调用） ===
    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hasWallpaper: !!currentVideoPath && fs.existsSync(currentVideoPath),
        opacity: currentOpacity,
        currentVideo: currentVideoPath || '',
        timestamp: Date.now()
      }))
      return
    }

    if (url === '/api/folder') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ folder: getDefaultFolderCore() }))
      return
    }

    if (url === '/api/videos') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listVideosCore(getDefaultFolderCore())))
      return
    }

    if (url === '/api/apply' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf-8'))
        const result = await applyWallpaperCore(body.videoPath, body.opacity)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: `应用失败: ${err}` }))
      }
      return
    }

    if (url === '/api/restore' && req.method === 'POST') {
      try {
        const result = await restoreCore()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: `恢复失败: ${err}` }))
      }
      return
    }

    if (url === '/api/upload' && req.method === 'POST') {
      try {
        const rawUrl = req.url || ''
        const qs = rawUrl.split('?')[1] || ''
        const params = new URLSearchParams(qs)
        const name = params.get('name') || `wallpaper-${Date.now()}.mp4`
        const buf = await readBody(req)
        const item = uploadVideoCore(buf, name)
        if (item) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, item }))
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '上传保存失败' }))
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: `上传失败: ${err}` }))
      }
      return
    }

    if (url === '/wallpaper' || url.startsWith('/wallpaper')) {
      if (!currentVideoPath || !fs.existsSync(currentVideoPath)) {
        res.writeHead(404)
        res.end('No wallpaper set')
        return
      }

      const stat = fs.statSync(currentVideoPath)
      const ext = path.extname(currentVideoPath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo'
      }

      // Support range requests for seeking
      const range = req.headers.range
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
        const chunkSize = end - start + 1
        const fileStream = fs.createReadStream(currentVideoPath, { start, end })
        res.writeHead(206, {
          'Content-Type': mimeTypes[ext] || 'video/mp4',
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        })
        fileStream.pipe(res)
        fileStream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('Stream error')
          }
        })
        return
      }

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'video/mp4',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      })

      const stream = fs.createReadStream(currentVideoPath)
      stream.pipe(res)
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500)
          res.end('Stream error')
        }
      })
      return
    }

    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hasWallpaper: !!currentVideoPath && fs.existsSync(currentVideoPath),
        opacity: currentOpacity,
        timestamp: Date.now()
      }))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    clients.add(ws)

    // Push current state to newly connected clients
    if (currentVideoPath) {
      ws.send(JSON.stringify({
        type: 'reload',
        opacity: currentOpacity,
        timestamp: Date.now()
      }))
    }

    ws.on('close', () => clients.delete(ws))
  })

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`Trae Wallpaper Server running at http://${SERVER_HOST}:${SERVER_PORT}`)
  })
}

function broadcastReload(opacity?: number) {
  const message = JSON.stringify({
    type: 'reload',
    opacity: opacity !== undefined ? opacity : currentOpacity,
    timestamp: Date.now()
  })

  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  })
}

function broadcastRestore() {
  const message = JSON.stringify({
    type: 'restore',
    timestamp: Date.now()
  })

  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  })
}

function ensureAutoStart() {
  // Electron 的 setLoginItemSettings 在 Windows 上不会正确写入 args，
  // 改用 PowerShell 直接写注册表，键值带 --autostart 参数实现静默启动
  const exe = process.execPath
  const script = [
    `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'`,
    `Remove-ItemProperty $k 'electron.app.Electron' -ErrorAction SilentlyContinue`,
    `Remove-ItemProperty $k 'trae-wallpaper-player' -ErrorAction SilentlyContinue`,
    `Remove-ItemProperty $k 'electron.app.trae-wallpaper-player' -ErrorAction SilentlyContinue`,
    `Remove-ItemProperty $k 'Trae Wallpaper Player' -ErrorAction SilentlyContinue`,
    `Set-ItemProperty $k 'FlowPaper' ('"' + '${exe}' + '" --autostart')`
  ].join(';')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf-8' })
  if (r.status !== 0) {
    console.error('设置开机自启失败:', r.stderr)
  }
}

app.whenReady().then(() => {
  // 移除顶部 File/Edit/View/Window/Help 英文菜单
  Menu.setApplicationMenu(null)
  // 强制浅色主题，让 Windows 标题栏保持白色，与界面主体统一
  nativeTheme.themeSource = 'light'

  const isAutoStart = process.argv.includes('--autostart')
  createWindow(isAutoStart)
  startLocalServer()
  createTray()

  ensureAutoStart()
})

app.on('window-all-closed', () => {
  // 有托盘常驻，不退出（后台继续提供视频流）
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    title: '选择壁纸视频'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('select-wallpaper-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择壁纸文件夹'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('get-default-folder', async () => {
  return getDefaultFolderCore()
})

ipcMain.handle('ensure-folder', async (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }
    return { success: true, folderPath }
  } catch (err) {
    return { success: false, message: `创建文件夹失败: ${err}` }
  }
})

ipcMain.handle('get-videos-from-folder', async (_event, folderPath: string) => {
  return listVideosCore(folderPath)
})

ipcMain.handle('generate-thumbnails', async (_event, folderPath: string) => {
  // 为壁纸库里缺失封面的视频批量生成封面，返回更新后的列表
  const items = listVideosCore(folderPath)
  for (const item of items) {
    if (!item.thumbnail) {
      generateThumbnail(item.path)
    }
  }
  return listVideosCore(folderPath)
})

ipcMain.handle('import-video', async (_event, options: { sourcePath: string; folderPath?: string }) => {
  try {
    const { sourcePath } = options
    if (!fs.existsSync(sourcePath)) {
      return { success: false, message: '源视频文件不存在' }
    }

    const destFolder = options.folderPath || getDefaultFolderCore()
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true })
    }

    const ext = path.extname(sourcePath)
    const base = path.basename(sourcePath, ext)
    let destName = `${base}${ext}`
    let destPath = path.join(destFolder, destName)
    let counter = 1

    while (fs.existsSync(destPath)) {
      destName = `${base} (${counter})${ext}`
      destPath = path.join(destFolder, destName)
      counter++
    }

    fs.copyFileSync(sourcePath, destPath)
    const stat = fs.statSync(destPath)
    const thumbnail = generateThumbnail(destPath)
    return {
      success: true,
      item: {
        name: destName,
        path: destPath,
        size: stat.size,
        modified: stat.mtimeMs,
        thumbnail
      }
    }
  } catch (err) {
    return { success: false, message: `导入失败: ${err}` }
  }
})

ipcMain.handle('apply-wallpaper', async (_event, options: { videoPath: string; opacity: number; traPath?: string }) => {
  return applyWallpaperCore(options.videoPath, options.opacity, options.traPath)
})

ipcMain.handle('restore-default', async (_event, traPath?: string) => {
  return restoreCore(traPath)
})

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  await shell.openPath(folderPath)
})

function getCleanOriginalContent(soloLitePath: string): string {
  const bakPath = `${soloLitePath}.bak`
  if (fs.existsSync(bakPath)) {
    return fs.readFileSync(bakPath, 'utf-8')
  }

  const backupPath = `${soloLitePath}.backup`
  if (fs.existsSync(backupPath)) {
    return cleanInjection(fs.readFileSync(backupPath, 'utf-8'))
  }

  return cleanInjection(fs.readFileSync(soloLitePath, 'utf-8'))
}

function cleanInjection(content: string): string {
  // Remove marker blocks
  const markerRegex = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}\\s*`, 'g')
  content = content.replace(markerRegex, '')

  // Remove legacy injections for compatibility
  content = content.replace(/<link[^>]*trae-skin\.css[^>]*>\s*/gi, '')
  content = content.replace(/<video id="trae-skin-bg"[\s\S]*?<\/video>\s*/gi, '')
  content = content.replace(/<style id="trae-skin-style">[\s\S]*?<\/style>\s*/gi, '')
  // Remove any scripts that reference the injected video element
  content = content.replace(/<script[^>]*>[\s\S]*?trae-skin-bg[\s\S]*?<\/script>\s*/gi, '')

  return content
}

function injectIntoSoloLite(soloLitePath: string, videoHTML: string) {
  let content = fs.readFileSync(soloLitePath, 'utf-8')
  content = cleanInjection(content)

  const cssLink = `${MARKER_START}\n<link rel="stylesheet" href="../../../workbench/browser/media/trae-skin.css" id="trae-skin-link">\n${MARKER_END}`
  const bodyBlock = `${MARKER_START}\n${videoHTML}\n${generatePanelHTML()}\n${MARKER_END}`

  content = content.replace('</head>', `${cssLink}\n</head>`)
  content = content.replace('</body>', `${bodyBlock}\n</body>`)

  fs.writeFileSync(soloLitePath, content, 'utf-8')
}

function generateCSS(opacity: number): string {
  return `/* Trae Wallpaper Player - Auto generated */
#trae-skin-bg {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  object-fit: cover !important;
  z-index: 99999 !important;
  opacity: ${opacity / 100} !important;
  pointer-events: none !important;
}`
}

function getVideoMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/mp4',
    '.avi': 'video/x-msvideo'
  }
  return mimeTypes[ext] || 'video/mp4'
}

function generateVideoHTML(): string {
  const sourceType = currentVideoPath ? getVideoMimeType(currentVideoPath) : 'video/mp4'
  return `<video id="trae-skin-bg" autoplay muted loop playsinline>
  <source src="http://${SERVER_HOST}:${SERVER_PORT}/wallpaper" type="${sourceType}">
  <source src="../../../workbench/browser/media/trae-wallpaper.mp4" type="video/mp4">
  <source src="../../../workbench/browser/media/trae-wallpaper.webm" type="video/webm">
</video>
<script>
(function() {
  const video = document.getElementById('trae-skin-bg');
  const source = video.querySelector('source');
  let reconnectTimer = null;
  let ws = null;

  function setOpacity(opacity) {
    if (typeof opacity === 'number') {
      video.style.setProperty('opacity', (opacity / 100).toString(), 'important');
    }
  }

  function connect() {
    ws = new WebSocket('ws://${SERVER_HOST}:${SERVER_PORT}');
    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'reload') {
          source.src = 'http://${SERVER_HOST}:${SERVER_PORT}/wallpaper?t=' + data.timestamp;
          video.load();
          video.play();
          if (data.opacity !== undefined) {
            setOpacity(data.opacity);
          }
        } else if (data.type === 'restore') {
          video.remove();
          const link = document.getElementById('trae-skin-link');
          if (link) link.remove();
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (ws) ws.close();
        }
      } catch (e) {}
    };
    ws.onclose = function() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
  }
  connect();
})();
</script>`
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getFfmpegPath(): string {
  // 优先使用打包后内置的 ffmpeg，开发时回退到项目 assets 目录
  const bundled = path.join(process.resourcesPath, 'assets', 'ffmpeg', 'ffmpeg.exe')
  if (fs.existsSync(bundled)) return bundled
  const local = path.join(__dirname, '../../assets/ffmpeg/ffmpeg.exe')
  if (fs.existsSync(local)) return local
  return ''
}

function generateThumbnail(videoPath: string): string {
  try {
    const ffmpeg = getFfmpegPath()
    if (!ffmpeg || !fs.existsSync(videoPath)) return ''

    const outputPath = videoPath + '.jpg'
    // 已有封面直接复用，避免重复截帧
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return outputPath

    const args = ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '3', '-update', '1', outputPath]
    const r = spawnSync(ffmpeg, args, { timeout: 20000, windowsHide: true })
    if (r.status === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath
    }
    // 失败则清理可能残留的损坏文件
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath) } catch {}
    }
    return ''
  } catch (err) {
    console.error('generateThumbnail error:', err)
    return ''
  }
}

function getDefaultFolderCore(): string {
  // 壁纸库放在用户文档目录，避免 Trae 更新时替换 resources/app 导致视频丢失
  return path.join(app.getPath('documents'), 'TraeWallpaper')
}

function listVideosCore(folderPath: string) {
  try {
    if (!fs.existsSync(folderPath)) return []
    const files = fs.readdirSync(folderPath)
    const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi']
    return files
      .filter(f => videoExts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const full = path.join(folderPath, f)
        if (!fs.existsSync(full)) return null
        try {
          const stat = fs.statSync(full)
          if (!stat.isFile()) return null
          const thumb = full + '.jpg'
          return { name: f, path: full, size: stat.size, modified: stat.mtimeMs, thumbnail: fs.existsSync(thumb) ? thumb : '' }
        } catch {
          return null
        }
      })
      .filter((x): x is { name: string; path: string; size: number; modified: number; thumbnail: string } => x !== null)
      .sort((a, b) => b.modified - a.modified)
  } catch (err) {
    return []
  }
}

function uploadVideoCore(buf: Buffer, name: string) {
  try {
    const folder = getDefaultFolderCore()
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })
    const safeName = path.basename(name)
    const ext = path.extname(safeName)
    const base = path.basename(safeName, ext)
    let destPath = path.join(folder, safeName)
    let counter = 1
    while (fs.existsSync(destPath)) {
      destPath = path.join(folder, `${base} (${counter})${ext}`)
      counter++
    }
    fs.writeFileSync(destPath, buf)
    const stat = fs.statSync(destPath)
    const thumbnail = generateThumbnail(destPath)
    return { name: path.basename(destPath), path: destPath, size: stat.size, modified: stat.mtimeMs, thumbnail }
  } catch (err) {
    console.error('uploadVideoCore error:', err)
    return null
  }
}

async function applyWallpaperCore(videoPath: string, opacity: number, traPath?: string) {
  try {
    // 优先使用调用方传入的路径，否则动态查找 Trae 安装根目录
    const traeRoot = isValidTraeRoot(traPath) ? traPath : await ensureTraeRoot()
    if (!traeRoot) {
      return { success: false, message: '未找到 Trae 安装目录，请手动选择后重试' }
    }
    const resourcesPath = path.join(traeRoot, 'resources', 'app', 'out', 'vs')
    const soloLitePath = getSoloLitePath(traeRoot)
    const mediaPath = path.join(resourcesPath, 'workbench', 'browser', 'media')
    const cssPath = path.join(mediaPath, 'trae-skin.css')

    if (!fs.existsSync(soloLitePath)) {
      return { success: false, message: `找不到 Trae 入口文件: ${soloLitePath}` }
    }
    if (!fs.existsSync(videoPath)) {
      return { success: false, message: `视频文件不存在: ${videoPath}` }
    }

    // 首次备份原文件
    const bakPath = `${soloLitePath}.bak`
    if (!fs.existsSync(bakPath)) {
      const clean = cleanInjection(fs.readFileSync(soloLitePath, 'utf-8'))
      fs.writeFileSync(bakPath, clean, 'utf-8')
    }

    // 注入（首次或升级时）
    const htmlContent = fs.readFileSync(soloLitePath, 'utf-8')
    const alreadyInjected = htmlContent.includes(MARKER_START) && htmlContent.includes('trae-wallpaper.mp4') && htmlContent.includes('trae-wallpaper-panel')
    if (!alreadyInjected) {
      injectIntoSoloLite(soloLitePath, generateVideoHTML())
    }

    currentVideoPath = videoPath
    currentOpacity = opacity

    // 复制兜底文件，供播放器未运行时 Trae 启动加载
    try {
      const ext = path.extname(videoPath).toLowerCase()
      const mp4Fallback = path.join(mediaPath, 'trae-wallpaper.mp4')
      const webmFallback = path.join(mediaPath, 'trae-wallpaper.webm')
      if (ext === '.webm') {
        fs.copyFileSync(videoPath, webmFallback)
        if (fs.existsSync(mp4Fallback)) fs.unlinkSync(mp4Fallback)
      } else {
        fs.copyFileSync(videoPath, mp4Fallback)
        if (fs.existsSync(webmFallback)) fs.unlinkSync(webmFallback)
      }
    } catch (err) {
      console.error('复制兜底文件失败（不影响在线切换）:', err)
    }

    fs.writeFileSync(cssPath, generateCSS(opacity), 'utf-8')
    broadcastReload(opacity)

    return { success: true, message: '壁纸已应用，Trae 背景已刷新' }
  } catch (err) {
    return { success: false, message: `应用失败: ${err}` }
  }
}

async function restoreCore(traPath?: string) {
  try {
    // 优先使用调用方传入的路径，否则动态查找 Trae 安装根目录
    const traeRoot = isValidTraeRoot(traPath) ? traPath : await ensureTraeRoot()
    if (!traeRoot) {
      return { success: false, message: '未找到 Trae 安装目录，请手动选择后重试' }
    }
    const soloLitePath = getSoloLitePath(traeRoot)
    const cssPath = path.join(traeRoot, 'resources', 'app', 'out', 'vs', 'workbench', 'browser', 'media', 'trae-skin.css')

    const cleanContent = getCleanOriginalContent(soloLitePath)
    fs.writeFileSync(soloLitePath, cleanContent, 'utf-8')

    if (fs.existsSync(cssPath)) fs.unlinkSync(cssPath)

    currentVideoPath = ''
    broadcastRestore()

    return { success: true, message: '已恢复默认，无需重启 Trae' }
  } catch (err) {
    return { success: false, message: `恢复失败: ${err}` }
  }
}

function generatePanelHTML(): string {
  return `<div id="trae-wallpaper-panel-root">
  <button id="trae-wallpaper-toggle" title="壁纸">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v20M2 12h20"></path>
      <circle cx="12" cy="12" r="9"></circle>
      <circle cx="12" cy="12" r="4"></circle>
    </svg>
  </button>
  <div id="trae-wallpaper-panel">
    <div id="trae-wallpaper-panel-header">
      <span>壁纸</span>
      <button id="trae-wallpaper-close">×</button>
    </div>
    <div id="trae-wallpaper-list"></div>
    <div id="trae-wallpaper-controls">
      <div id="trae-wallpaper-opacity-row">
        <span>透明度</span>
        <span id="trae-wallpaper-opacity-value">20%</span>
      </div>
      <input id="trae-wallpaper-opacity" type="range" min="5" max="60" value="20">
      <div id="trae-wallpaper-buttons">
        <button id="trae-wallpaper-import">导入</button>
        <button id="trae-wallpaper-apply">应用</button>
        <button id="trae-wallpaper-restore">恢复</button>
      </div>
      <div id="trae-wallpaper-msg"></div>
    </div>
    <input id="trae-wallpaper-file" type="file" accept="video/*" style="display:none">
  </div>
</div>
<style id="trae-wallpaper-panel-style">
#trae-wallpaper-panel-root {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
#trae-wallpaper-toggle {
  width: 46px; height: 46px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(30,30,40,0.7);
  color: #fff;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: transform .15s ease, background .15s ease;
}
#trae-wallpaper-toggle:hover { transform: scale(1.08); background: rgba(60,60,80,0.8); }
#trae-wallpaper-panel {
  position: absolute;
  right: 0; bottom: 56px;
  width: 300px;
  max-height: 70vh;
  display: none;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(24,24,34,0.82);
  color: #e8e8ee;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  backdrop-filter: blur(24px) saturate(1.3);
  -webkit-backdrop-filter: blur(24px) saturate(1.3);
  overflow: hidden;
}
#trae-wallpaper-panel.open { display: flex; }
#trae-wallpaper-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px;
  font-size: 14px; font-weight: 600;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
#trae-wallpaper-close {
  border: none; background: none; color: #999;
  font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px;
}
#trae-wallpaper-close:hover { color: #fff; }
#trae-wallpaper-list {
  flex: 1; overflow-y: auto; padding: 8px;
  max-height: 40vh;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.18) transparent;
}
#trae-wallpaper-list::-webkit-scrollbar {
  width: 10px;
}
#trae-wallpaper-list::-webkit-scrollbar-track {
  background: transparent;
}
#trae-wallpaper-list::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.18);
  border-radius: 5px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
#trae-wallpaper-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.3);
  border: 3px solid transparent;
  background-clip: padding-box;
}
.trae-wp-item {
  padding: 9px 11px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-bottom: 4px;
  transition: background .12s ease;
}
.trae-wp-item:hover { background: rgba(255,255,255,0.08); }
.trae-wp-item.active { background: rgba(99,130,255,0.28); }
.trae-wp-empty { color: #888; font-size: 12px; text-align: center; padding: 16px 0; }
#trae-wallpaper-controls { padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
#trae-wallpaper-opacity-row {
  display: flex; justify-content: space-between;
  font-size: 12px; color: #bbb; margin-bottom: 6px;
}
#trae-wallpaper-opacity { width: 100%; accent-color: #6382ff; }
#trae-wallpaper-buttons { display: flex; gap: 8px; margin-top: 12px; }
#trae-wallpaper-buttons button {
  flex: 1; padding: 8px 0;
  border: none; border-radius: 9px;
  font-size: 13px; cursor: pointer;
  background: rgba(255,255,255,0.1); color: #e8e8ee;
  transition: background .12s ease;
}
#trae-wallpaper-buttons button:hover { background: rgba(255,255,255,0.18); }
#trae-wallpaper-apply { background: #6382ff !important; }
#trae-wallpaper-apply:hover { background: #7b93ff !important; }
#trae-wallpaper-restore { background: rgba(255,100,100,0.35) !important; }
#trae-wallpaper-msg { font-size: 12px; color: #8fdc8f; margin-top: 8px; min-height: 14px; }
#trae-wallpaper-msg.error { color: #ff9090; }
</style>
<script id="trae-wallpaper-panel-script">
(function() {
  var API = 'http://${SERVER_HOST}:${SERVER_PORT}';
  var videos = [];
  var selectedPath = '';
  var opacity = 20;

  var root = document.getElementById('trae-wallpaper-panel-root');
  var toggle = document.getElementById('trae-wallpaper-toggle');
  var panel = document.getElementById('trae-wallpaper-panel');
  var closeBtn = document.getElementById('trae-wallpaper-close');
  var list = document.getElementById('trae-wallpaper-list');
  var opacityInput = document.getElementById('trae-wallpaper-opacity');
  var opacityValue = document.getElementById('trae-wallpaper-opacity-value');
  var importBtn = document.getElementById('trae-wallpaper-import');
  var applyBtn = document.getElementById('trae-wallpaper-apply');
  var restoreBtn = document.getElementById('trae-wallpaper-restore');
  var fileInput = document.getElementById('trae-wallpaper-file');
  var msg = document.getElementById('trae-wallpaper-msg');

  function setMsg(text, isError) {
    msg.textContent = text || '';
    msg.className = isError ? 'error' : '';
    if (text) setTimeout(function() { if (msg.textContent === text) msg.textContent = ''; }, 2500);
  }

  function renderList() {
    list.innerHTML = '';
    if (!videos.length) {
      var empty = document.createElement('div');
      empty.className = 'trae-wp-empty';
      empty.textContent = '暂无视频，点「导入」添加';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < videos.length; i++) {
      (function(v) {
        var item = document.createElement('div');
        item.className = 'trae-wp-item' + (v.path === selectedPath ? ' active' : '');
        item.textContent = v.name;
        item.addEventListener('click', function() {
          selectedPath = v.path;
          renderList();
        });
        list.appendChild(item);
      })(videos[i]);
    }
  }

  async function loadVideos() {
    try {
      var res = await fetch(API + '/api/videos');
      videos = await res.json();
      renderList();
    } catch (e) {
      list.innerHTML = '<div class="trae-wp-empty">后台服务未启动</div>';
    }
  }

  async function loadStatus() {
    try {
      var res = await fetch(API + '/api/status');
      var s = await res.json();
      opacity = s.opacity || 20;
      selectedPath = s.currentVideo || '';
      opacityInput.value = opacity;
      opacityValue.textContent = opacity + '%';
    } catch (e) {}
  }

  async function applyWallpaper() {
    if (!selectedPath) { setMsg('请先选择一个视频', true); return; }
    try {
      var res = await fetch(API + '/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: selectedPath, opacity: opacity })
      });
      var r = await res.json();
      setMsg(r.message || '已应用', !r.success);
    } catch (e) { setMsg('应用失败：后台未启动', true); }
  }

  async function restoreDefault() {
    try {
      var res = await fetch(API + '/api/restore', { method: 'POST' });
      var r = await res.json();
      selectedPath = '';
      renderList();
      setMsg(r.message || '已恢复', !r.success);
    } catch (e) { setMsg('恢复失败：后台未启动', true); }
  }

  async function uploadFile(file) {
    try {
      var buf = await file.arrayBuffer();
      var res = await fetch(API + '/api/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        body: buf
      });
      var r = await res.json();
      if (r.success) {
        selectedPath = r.item.path;
        setMsg('已导入');
        await loadVideos();
      } else {
        setMsg(r.message || '导入失败', true);
      }
    } catch (e) { setMsg('导入失败：后台未启动', true); }
  }

  toggle.addEventListener('click', function() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) { loadVideos(); loadStatus(); }
  });
  closeBtn.addEventListener('click', function() { panel.classList.remove('open'); });
  opacityInput.addEventListener('input', function() {
    opacity = parseInt(opacityInput.value, 10);
    opacityValue.textContent = opacity + '%';
  });
  applyBtn.addEventListener('click', applyWallpaper);
  restoreBtn.addEventListener('click', restoreDefault);
  importBtn.addEventListener('click', function() { fileInput.click(); });
  fileInput.addEventListener('change', function() {
    if (fileInput.files && fileInput.files[0]) { uploadFile(fileInput.files[0]); }
    fileInput.value = '';
  });

  loadVideos();
  loadStatus();
})();
</script>`
}
