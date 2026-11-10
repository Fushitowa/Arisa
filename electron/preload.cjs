const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('arisaDesktop', {
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
  onWakeStatus(callback) {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('wake-status', handler)
    return () => ipcRenderer.removeListener('wake-status', handler)
  },
  setVoiceState(state) {
    ipcRenderer.send('voice-state', state)
  },
  onWake(callback) {
    const handler = () => callback()
    ipcRenderer.on('wake-detected', handler)
    return () => ipcRenderer.removeListener('wake-detected', handler)
  },
  onHidden(callback) {
    const handler = () => callback()
    ipcRenderer.on('window-hidden', handler)
    return () => ipcRenderer.removeListener('window-hidden', handler)
  },
})
