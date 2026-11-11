const { app, BrowserWindow, Tray, Menu, session, nativeImage, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')

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
let listenerRestartAttempts = 0
let listenerReady = false
let listenerError = ''
let listenerOutput = ''
let listenerStdoutBuffer = ''
let startupError = ''
const wakeDiagnostics = []
let backend
let vite
let listenerEnabled = true
let backendReady = false
let quitting = false
let voiceUiState = 'idle'
let lastWakeAt = 0
let wakeRendererReady = false
let pendingWake = null
const computerSessionToken = crypto.randomBytes(32).toString('hex')
const expectedListenerStops = new WeakMap()

const WAKE_DIAGNOSTIC_PREFIX = 'ARISA_WAKE_DIAGNOSTIC '
const RENDERER_DIAGNOSTIC_STAGES = new Set([
  'wake_renderer_received', 'wake_renderer_busy', 'voice_start_waiting_for_api',
  'voice_api_unconfigured', 'voice_microphone_acquired', 'voice_listening_started',
  'voice_start_failed',
])

const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

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
    env: { ...process.env, ARISA_ENV_FILE: envFile, DATABASE_PATH: dbFile, ARISA_SETTINGS_FILE: wakeSettingsPath(), ARISA_COMPUTER_SESSION_TOKEN: computerSessionToken },
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

function shouldListenForWake() {
  return backendReady && listenerEnabled && !quitting
    && (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible() || voiceUiState === 'idle')
}

function startupOptions() {
  return { path: process.execPath, args: dev ? [root, '--hidden'] : ['--hidden'] }
}

function getStartupSettings() {
  // Windows identifies an app login item by its executable and arguments.
  // Query using the same tuple passed to setLoginItemSettings.
  return app.getLoginItemSettings(startupOptions())
}

function recordWakeDiagnostic(stage, details = {}) {
  const diagnostic = { at: new Date().toISOString(), stage: String(stage).slice(0, 60) }
  const stringFields = [
    'transcript', 'normalized', 'reason', 'device_name', 'error', 'message', 'request_id',
  ]
  const numberFields = [
    'required_confidence', 'observed_min_confidence', 'sample_rate', 'channels', 'status_code', 'attempt',
  ]
  for (const key of stringFields) {
    if (typeof details[key] === 'string') diagnostic[key] = details[key].slice(0, 180)
  }
  for (const key of numberFields) {
    if (Number.isFinite(details[key])) diagnostic[key] = details[key]
  }
  for (const key of ['accepted', 'visible']) {
    if (typeof details[key] === 'boolean') diagnostic[key] = details[key]
  }
  wakeDiagnostics.push(diagnostic)
  if (wakeDiagnostics.length > 50) wakeDiagnostics.splice(0, wakeDiagnostics.length - 50)
  publishWakeStatus()
  return diagnostic
}

function getWakeStatus() {
  let state = 'stopped'
  if (!listenerEnabled) state = 'disabled'
  else if (!backendReady) state = 'starting'
  else if (listenerReady) state = 'listening'
  else if (listener) state = 'starting'
  else if (listenerError) state = listenerRestartAttempts < 3 ? 'retrying' : 'error'
  else if (!shouldListenForWake()) state = 'paused'
  else state = 'starting'

  return {
    enabled: listenerEnabled,
    runAtLogin: app.isReady() && getStartupSettings().openAtLogin,
    state,
    error: listenerError,
    startupError,
    diagnostics: wakeDiagnostics.slice(-50),
  }
}

function publishWakeStatus() {
  if (windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) {
    windowRef.webContents.send('wake-status', getWakeStatus())
  }
}

function stopWakeListener() {
  if (!listener) return
  const current = listener
  listener = null
  listenerReady = false
  expectedListenerStops.set(current, listenerEnabled ? 'paused while Arisa uses the conversation microphone' : 'voice activation disabled')
  current.kill()
  publishWakeStatus()
}

function reconcileWakeListener() {
  if (shouldListenForWake()) startWakeListener()
  else stopWakeListener()
}

function handleWakeListenerLine(line, child) {
  if (listener !== child) return
  if (line.startsWith(WAKE_DIAGNOSTIC_PREFIX)) {
    try {
      const event = JSON.parse(line.slice(WAKE_DIAGNOSTIC_PREFIX.length))
      if (!event || typeof event.stage !== 'string') return
      if (event.stage === 'listener_ready' && listener === child) {
        listenerReady = true
        listenerError = ''
        listenerRestartAttempts = 0
      }
      recordWakeDiagnostic(event.stage, event)
    } catch {
      recordWakeDiagnostic('listener_diagnostic_parse_error', { message: 'A listener diagnostic line could not be decoded.' })
    }
    return
  }

  if (line.includes('Wake listener active') && listener === child) {
    listenerReady = true
    listenerError = ''
    listenerRestartAttempts = 0
    publishWakeStatus()
  }
}

function startWakeListener() {
  if (!shouldListenForWake() || listener) return
  const script = path.join(backendDir, 'wake_listener.py')
  const startedAt = Date.now()
  listenerReady = false
  listenerError = ''
  listenerOutput = ''
  listenerStdoutBuffer = ''
  const child = spawn(pythonPath(), [script], {
    cwd: path.dirname(script), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARISA_WAKE_MODEL_DIR: path.join(app.getPath('userData'), 'wake-model') },
  })
  listener = child
  recordWakeDiagnostic('listener_process_started')
  publishWakeStatus()

  child.stdout.on('data', chunk => {
    const output = chunk.toString()
    listenerOutput = `${listenerOutput}${output}`.slice(-4000)
    listenerStdoutBuffer += output
    const lines = listenerStdoutBuffer.split(/\r?\n/)
    listenerStdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (line) handleWakeListenerLine(line, child)
    }
  })
  child.stderr.on('data', chunk => {
    if (listener !== child) return
    const output = chunk.toString()
    listenerOutput = `${listenerOutput}${output}`.slice(-4000)
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      recordWakeDiagnostic('listener_stderr', { message: line })
    }
    const failure = output.match(/Wake listener (?:failed|dependencies are missing):[^\r\n]*/i)
    if (failure) {
      listenerError = failure[0]
      publishWakeStatus()
    }
  })
  child.on('error', error => {
    if (listener !== child) return
    listenerError = `Could not start the wake listener: ${error.message}`
    if (listener === child) listener = null
    listenerReady = false
    publishWakeStatus()
  })
  child.on('exit', code => {
    if (listenerStdoutBuffer) handleWakeListenerLine(listenerStdoutBuffer, child)
    listenerStdoutBuffer = ''
    const intentionalStop = expectedListenerStops.get(child)
    if (listener === child) listener = null
    listenerReady = false
    recordWakeDiagnostic(
      intentionalStop ? 'listener_paused' : 'listener_process_exited',
      { message: intentionalStop || `Wake listener exited with code ${code}.` },
    )
    if (!intentionalStop && shouldListenForWake() && code !== 0) {
      if (!listenerError) {
        listenerError = listenerOutput.split(/\r?\n/).filter(Boolean).slice(-1)[0]
          || `The wake listener exited with code ${code}.`
      }
      if (Date.now() - startedAt >= 30000) listenerRestartAttempts = 0
      if (listenerRestartAttempts < 3) {
        listenerRestartAttempts += 1
        setTimeout(startWakeListener, 5000)
      }
      else tray?.displayBalloon({
        title: 'Arisa wake word stopped',
        content: `${listenerError} Check Windows microphone access and the backend setup.`.slice(0, 240),
      })
    } else if (intentionalStop || code === 0 || Date.now() - startedAt >= 30000) {
      listenerRestartAttempts = 0
    }
    publishWakeStatus()
  })
}

function dispatchPendingWake() {
  const request = pendingWake
  if (!request || !wakeRendererReady || !windowRef || windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) return
  request.attempts += 1
  request.sentAt = Date.now()
  try {
    windowRef.webContents.send('wake-detected', {
      request_id: request.request_id,
      transcript: request.transcript,
    })
  } catch (error) {
    recordWakeDiagnostic('renderer_send_failed', {
      request_id: request.request_id,
      error: error.message,
    })
    return
  }
  recordWakeDiagnostic('renderer_notified', {
    request_id: request.request_id,
    transcript: request.transcript,
    attempt: request.attempts,
  })
  clearTimeout(request.ackTimer)
  request.ackTimer = setTimeout(() => {
    if (pendingWake !== request) return
    if (request.attempts < 3 && wakeRendererReady) {
      recordWakeDiagnostic('renderer_ack_retry', { request_id: request.request_id, attempt: request.attempts + 1 })
      dispatchPendingWake()
    } else {
      recordWakeDiagnostic('renderer_ack_timeout', {
        request_id: request.request_id,
        message: 'The voice window did not acknowledge the wake event.',
      })
      pendingWake = null
    }
  }, 1200)
}

function sendWake(payload = {}) {
  const requestId = typeof payload.request_id === 'string' ? payload.request_id.slice(0, 80) : ''
  const transcript = typeof payload.transcript === 'string' ? payload.transcript.slice(0, 180) : ''
  recordWakeDiagnostic('wake_bridge_received', { request_id: requestId, transcript })
  if (!windowRef || windowRef.isDestroyed()) {
    recordWakeDiagnostic('wake_window_unavailable', {
      request_id: requestId,
      message: 'Electron received the wake request but has no usable window.',
    })
    return { status: 503, accepted: false }
  }
  if (Date.now() - lastWakeAt < 2500) {
    recordWakeDiagnostic('wake_duplicate_suppressed', { request_id: requestId, transcript })
    return { status: 429, accepted: false }
  }

  lastWakeAt = Date.now()
  voiceUiState = 'starting'
  pendingWake = {
    request_id: requestId || `wake-${lastWakeAt}`,
    transcript,
    attempts: 0,
    ackTimer: null,
  }
  showWindow()
  recordWakeDiagnostic('wake_window_show_requested', {
    request_id: pendingWake.request_id,
    transcript,
    visible: windowRef.isVisible(),
  })
  dispatchPendingWake()
  return { status: 202, accepted: true }
}

function startWakeBridge() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/wake') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    let oversized = false
    req.on('data', chunk => {
      if (oversized) return
      body += chunk.toString()
      if (body.length > 2048) {
        oversized = true
        res.writeHead(413).end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (oversized) return
      let payload = {}
      try { payload = body ? JSON.parse(body) : {} }
      catch {
        recordWakeDiagnostic('wake_bridge_invalid_payload', { message: 'The local wake request was not valid JSON.' })
        res.writeHead(400).end(JSON.stringify({ accepted: false }))
        return
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        recordWakeDiagnostic('wake_bridge_invalid_payload', { message: 'The local wake request must be a JSON object.' })
        res.writeHead(400).end(JSON.stringify({ accepted: false }))
        return
      }
      const result = sendWake(payload)
      res.writeHead(result.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ accepted: result.accepted }))
    })
  })
  server.on('error', error => recordWakeDiagnostic('wake_bridge_error', { error: error.message }))
  server.listen(8765, '127.0.0.1', () => recordWakeDiagnostic('wake_bridge_listening'))
  app.on('before-quit', () => server.close())
}

function wakeSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(wakeSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveSettings(update) {
  const file = wakeSettingsPath()
  const temporary = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify({ ...readSettings(), ...update }, null, 2))
  fs.renameSync(temporary, file)
}

function createTray() {
  const icon = nativeImage.createFromPath(appIconPath)
  tray = new Tray(icon)
  tray.setToolTip('Arisa AI voice activation is enabled; listening locally for its wake phrases')
  tray.on('double-click', () => showWindow())
  refreshTrayMenu()
}

function showWindow() {
  if (windowRef && !windowRef.isDestroyed()) {
    if (windowRef.isMinimized()) windowRef.restore()
    windowRef.show()
    windowRef.focus()
    reconcileWakeListener()
  }
}

function refreshTrayMenu() {
  if (!tray) return
  const startup = getStartupSettings().openAtLogin
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Arisa AI', click: showWindow },
    { label: 'Voice activation (Wake up Arisa / Arisa open / I need you Arisa)', type: 'checkbox', checked: listenerEnabled, click: item => {
      setVoiceActivation(item.checked)
    } },
    { label: 'Run listener when Windows starts', type: 'checkbox', checked: startup, click: item => {
      const status = setWindowsStartup(item.checked)
      if (status.startupError) tray?.displayBalloon({ title: 'Arisa startup setting failed', content: status.startupError })
    } },
    { type: 'separator' },
    { label: 'Quit Arisa AI', click: () => { quitting = true; app.quit() } },
  ]))
}

function setStartup(enabled) {
  app.setLoginItemSettings({ ...startupOptions(), openAtLogin: enabled })
}

function setVoiceActivation(enabled) {
  listenerEnabled = enabled === true
  saveSettings({ voiceActivationEnabled: listenerEnabled })
  listenerRestartAttempts = 0
  listenerError = ''
  reconcileWakeListener()
  refreshTrayMenu()
  tray?.setToolTip(listenerEnabled
    ? 'Arisa AI voice activation is enabled; listening locally for its wake phrases'
    : 'Arisa AI voice activation is disabled')
  publishWakeStatus()
  return getWakeStatus()
}

function setWindowsStartup(enabled) {
  setStartup(enabled === true)
  const registered = getStartupSettings().openAtLogin
  saveSettings({ runAtLoginEnabled: registered })
  startupError = registered === (enabled === true)
    ? ''
    : 'Windows did not save the startup setting. Try enabling it again.'
  refreshTrayMenu()
  publishWakeStatus()
  return getWakeStatus()
}

function retryWakeListener() {
  listenerRestartAttempts = 0
  listenerError = ''
  if (listener) stopWakeListener()
  reconcileWakeListener()
  publishWakeStatus()
  return getWakeStatus()
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
  wakeRendererReady = false
  windowRef.webContents.on('did-start-loading', () => { wakeRendererReady = false })
  windowRef.webContents.on('destroyed', () => { wakeRendererReady = false })
  windowRef.loadURL('http://127.0.0.1:5173/?desktop=voice')
  windowRef.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      windowRef.webContents.send('window-hidden')
      voiceUiState = 'idle'
      windowRef.hide()
      reconcileWakeListener()
    }
  })
  windowRef.on('minimize', () => {
    windowRef.webContents.send('window-hidden')
    voiceUiState = 'idle'
    reconcileWakeListener()
  })
}

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return
  const settings = readSettings()
  listenerEnabled = settings.voiceActivationEnabled !== false
  ipcMain.on('voice-state', (_event, state) => {
    if (!['idle', 'session-idle', 'starting', 'listening', 'thinking', 'speaking'].includes(state)) return
    voiceUiState = state
    reconcileWakeListener()
    publishWakeStatus()
  })
  ipcMain.on('wake:renderer-ready', event => {
    if (event.sender !== windowRef?.webContents) return
    wakeRendererReady = true
    recordWakeDiagnostic('wake_renderer_ready')
    dispatchPendingWake()
  })
  ipcMain.on('wake:renderer-ack', (event, requestId) => {
    if (event.sender !== windowRef?.webContents || !pendingWake || requestId !== pendingWake.request_id) return
    clearTimeout(pendingWake.ackTimer)
    recordWakeDiagnostic('wake_renderer_acknowledged', {
      request_id: pendingWake.request_id,
      transcript: pendingWake.transcript,
    })
    pendingWake = null
  })
  ipcMain.on('wake:diagnostic', (event, stage, details) => {
    if (event.sender !== windowRef?.webContents || !RENDERER_DIAGNOSTIC_STAGES.has(stage)) return
    recordWakeDiagnostic(stage, details && typeof details === 'object' ? details : {})
  })
  ipcMain.handle('wake:get-status', () => getWakeStatus())
  ipcMain.handle('computer:get-settings', () => ({
    enabled: readSettings().computerUseEnabled === true,
    screenVision: readSettings().screenVisionEnabled === true,
    sessionToken: computerSessionToken,
  }))
  ipcMain.handle('computer:set-settings', (_event, update) => {
    const settings = {
      computerUseEnabled: update?.enabled === true,
      screenVisionEnabled: update?.enabled === true && update?.screenVision === true,
    }
    saveSettings(settings)
    return {
      enabled: settings.computerUseEnabled,
      screenVision: settings.screenVisionEnabled,
      sessionToken: computerSessionToken,
    }
  })
  ipcMain.handle('wake:set-enabled', (_event, enabled) => setVoiceActivation(enabled))
  ipcMain.handle('wake:set-startup', (_event, enabled) => setWindowsStartup(enabled))
  ipcMain.handle('wake:retry', () => retryWakeListener())
  ipcMain.handle('wake:clear-diagnostics', () => {
    wakeDiagnostics.length = 0
    listenerOutput = ''
    listenerStdoutBuffer = ''
    publishWakeStatus()
    return getWakeStatus()
  })
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications')
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media' || permission === 'notifications')
  createTray()
  startWakeBridge()
  // Older builds could leave startupConfigured=true after the Windows Run
  // entry was removed. Treat an unset preference as enabled, then persist the
  // actual OS registration so voice activation starts after future sign-ins.
  const runAtLoginEnabled = settings.runAtLoginEnabled !== false
  setStartup(runAtLoginEnabled)
  const startupRegistered = getStartupSettings().openAtLogin
  saveSettings({ runAtLoginEnabled: startupRegistered })
  startupError = runAtLoginEnabled && !startupRegistered
    ? 'Windows did not register Arisa to start at sign-in.'
    : ''
  if (runAtLoginEnabled && !startupRegistered) {
    tray?.displayBalloon({ title: 'Arisa startup setting failed', content: 'Windows did not register Arisa to start at sign-in. Enable it from the tray menu.' })
  }
  refreshTrayMenu()
  await startVite()
  const backendStartup = startBackend()
  createWindow()
  backendStartup.then(() => {
    reconcileWakeListener()
    publishWakeStatus()
  }).catch(() => {
    tray?.displayBalloon({ title: 'Arisa AI', content: 'The API could not start. Check Python and backend dependencies.' })
  })
})

app.on('window-all-closed', event => event.preventDefault())
app.on('before-quit', () => {
  quitting = true
  stopWakeListener()
  backend?.kill()
  vite?.kill()
})
