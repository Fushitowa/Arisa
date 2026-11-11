const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('arisaDesktop', {
  getComputerSettings() {
    return ipcRenderer.invoke('computer:get-settings')
  },
  setComputerSettings(update) {
    return ipcRenderer.invoke('computer:set-settings', update)
  },
  getWakeStatus() {
    return ipcRenderer.invoke('wake:get-status')
  },
  setWakeEnabled(enabled) {
    return ipcRenderer.invoke('wake:set-enabled', enabled)
  },
  setWakeStartup(enabled) {
    return ipcRenderer.invoke('wake:set-startup', enabled)
  },
  retryWakeListener() {
    return ipcRenderer.invoke('wake:retry')
  },
  clearWakeDiagnostics() {
    return ipcRenderer.invoke('wake:clear-diagnostics')
  },
  reportWakeDiagnostic(stage, details) {
    ipcRenderer.send('wake:diagnostic', stage, details || {})
  },
  onWakeStatus(callback) {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('wake-status', handler)
    return () => ipcRenderer.removeListener('wake-status', handler)
  },
  setVoiceState(state) {
    ipcRenderer.send('voice-state', state)
  },
  onWake(callback) {
    const handler = (_event, request) => {
      if (request?.request_id) ipcRenderer.send('wake:renderer-ack', request.request_id)
      callback(request || {})
    }
    ipcRenderer.on('wake-detected', handler)
    ipcRenderer.send('wake:renderer-ready')
    return () => ipcRenderer.removeListener('wake-detected', handler)
  },
  onHidden(callback) {
    const handler = () => callback()
    ipcRenderer.on('window-hidden', handler)
    return () => ipcRenderer.removeListener('window-hidden', handler)
  },
})
