const { app, BrowserWindow, Tray, Menu, session, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const dev = !app.isPackaged
const root = app.getAppPath()
const backendDir = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(root, 'backend')
// Keep the packaged app on its own port so it cannot silently reuse an older
// development backend that happens to be running on port 8000.
const backendPort = dev ? 8000 : 8001
const hiddenAtLaunch = process.argv.includes('--hidden')
const appIconPath = path.join(root, dev ? 'public' : 'dist', 'arisa-icon.png')
let windowRef
let tray
let listener
let listenerAttempts = 0
let backend
let vite
let listenerEnabled = true
let backendReady = false
let quitting = false

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function pythonPath() {
  const venv = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  return fs.existsSync(venv) ? venv : 'python'
}

function requestOk(port, route) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 700 }, res => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 400)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitFor(port, route, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await requestOk(port, route)) return true
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}

async function startBackend() {
  if (await requestOk(backendPort, '/api/health')) {
    backendReady = true
    return true
  }
  const userData = app.getPath('userData')
  const envFile = dev ? path.join(backendDir, '.env') : path.join(userData, 'backend.env')
  const dbFile = dev ? path.join(backendDir, 'lizz.db') : path.join(userData, 'arisa.db')
  if (!dev && !fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(backendDir, '.env.example'), envFile)
  }
  backend = spawn(pythonPath(), ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(backendPort)], {
    cwd: backendDir, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ARISA_ENV_FILE: envFile, DATABASE_PATH: dbFile },
  })
  backend.on('error', () => tray?.displayBalloon({ title: 'Arisa AI', content: 'Could not start the API. Check Python and backend dependencies.' }))
  const ready = await waitFor(backendPort, '/api/health')
  backendReady = ready
  if (!ready) tray?.displayBalloon({ title: 'Arisa AI', content: 'The API did not start. Check Python, backend/.env, and backend dependencies.' })
  return ready
}

async function startVite() {
  if (vite) return
  if (!dev) {
    const dist = path.join(root, 'dist')
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        const proxy = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: req.headers }, upstream => {
          res.writeHead(upstream.statusCode || 502, upstream.headers)
          upstream.pipe(res)
        })
        proxy.on('error', () => { res.writeHead(502).end('API unavailable') })
        req.pipe(proxy)
        return
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
      const requested = path.resolve(dist, `.${pathname}`)
      const safe = requested.startsWith(path.resolve(dist) + path.sep) ? requested : path.join(dist, 'index.html')
      const file = fs.existsSync(safe) && fs.statSync(safe).isFile() ? safe : path.join(dist, 'index.html')
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(5173, '127.0.0.1', resolve)
    })
    return
  }
  if (await requestOk(5173, '/')) return
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  vite = spawn(command, ['run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: root, windowsHide: true, stdio: 'ignore', shell: process.platform === 'win32',
  })
  if (!await waitFor(5173, '/', 10000)) {
    tray?.displayBalloon({ title: 'Arisa AI', content: 'The interface did not start. Check the app installation.' })
  }
}

function startWakeListener() {
  if (!backendReady || !listenerEnabled || listener || windowRef?.isVisible()) return
  listenerAttempts += 1
  const script = path.join(backendDir, 'wake_listener.py')
  listener = spawn(pythonPath(), [script], {
    cwd: path.dirname(script), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ARISA_WAKE_MODEL_DIR: path.join(app.getPath('userData'), 'wake-model') },
  })
  listener.on('error', () => {
    tray?.displayBalloon({ title: 'Arisa wake word unavailable', content: 'Install backend requirements to enable local wake listening.' })
    listener = null
  })
  listener.on('exit', code => {
    listener = null
    if (listenerEnabled && !quitting && code !== 0) {
      if (listenerAttempts < 3) setTimeout(startWakeListener, 5000)
      else tray?.displayBalloon({ title: 'Arisa wake word stopped', content: 'Check microphone access and install the backend requirements.' })
    }
  })
}

function sendWake() {
  if (!windowRef || windowRef.isDestroyed()) return
  showWindow()
  if (windowRef.webContents.isLoading()) windowRef.webContents.once('did-finish-load', () => windowRef?.webContents.send('wake-detected'))
  else windowRef.webContents.send('wake-detected')
}

function startWakeBridge() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/wake') {
      res.writeHead(404).end()
      return
    }
    sendWake()
    res.writeHead(204).end()
  })
  server.listen(8765, '127.0.0.1')
  app.on('before-quit', () => server.close())
}

function createTray() {
  const icon = nativeImage.createFromPath(appIconPath)
  tray = new Tray(icon)
  tray.setToolTip('Arisa AI is listening for “Arisa” on this PC')
  tray.on('double-click', () => showWindow())
  refreshTrayMenu()
}

function showWindow() {
  if (windowRef && !windowRef.isDestroyed()) {
    listener?.kill()
    listener = null
    windowRef.show()
    windowRef.focus()
  }
}

function refreshTrayMenu() {
  if (!tray) return
  const startup = app.getLoginItemSettings().openAtLogin
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Arisa AI', click: showWindow },
    { label: 'Listen for “Arisa”', type: 'checkbox', checked: listenerEnabled, click: item => {
      listenerEnabled = item.checked
      if (listenerEnabled) startWakeListener()
      else { listener?.kill(); listener = null }
      refreshTrayMenu()
    } },
    { label: 'Run listener when Windows starts', type: 'checkbox', checked: startup, click: item => {
      setStartup(item.checked)
      refreshTrayMenu()
    } },
    { type: 'separator' },
    { label: 'Quit Arisa AI', click: () => { quitting = true; app.quit() } },
  ]))
}

function setStartup(enabled) {
  const args = dev ? [root, '--hidden'] : ['--hidden']
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args })
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 880, height: 720, minWidth: 400, minHeight: 520,
    show: !hiddenAtLaunch,
    backgroundColor: '#09090d',
    icon: appIconPath,
    title: 'Arisa AI',
    webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  windowRef.loadURL('http://127.0.0.1:5173/?desktop=voice')
  windowRef.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      windowRef.webContents.send('window-hidden')
      windowRef.hide()
      startWakeListener()
    }
  })
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications')
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media' || permission === 'notifications')
  createTray()
  startWakeBridge()
  if (!hiddenAtLaunch) setStartup(true)
  refreshTrayMenu()
  await startVite()
  const backendStartup = startBackend()
  createWindow()
  backendStartup.then(() => {
    if (hiddenAtLaunch || !windowRef?.isVisible()) startWakeListener()
  }).catch(() => {
    tray?.displayBalloon({ title: 'Arisa AI', content: 'The API could not start. Check Python and backend dependencies.' })
  })
})

app.on('window-all-closed', event => event.preventDefault())
app.on('before-quit', () => {
  quitting = true
  listener?.kill()
  backend?.kill()
  vite?.kill()
})
