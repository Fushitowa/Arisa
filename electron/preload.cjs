const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('arisaDesktop', {
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
