import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type TestdayBridge } from './ipc'

/**
 * The only surface the interface has on the recorder. Everything crosses as
 * plain data; no Node handles and no file descriptors reach the renderer.
 *
 * Sample and lactate appends are `send` rather than `invoke`, so a slow disk
 * can never stall the 1 Hz recording loop. Failures come back on the
 * write-status channel instead, which is what the red pill in the dashboard
 * listens to.
 */
const bridge: TestdayBridge = {
  platform: 'desktop',

  paths: () => ipcRenderer.invoke(IPC.paths),
  chooseMirrorFolder: () => ipcRenderer.invoke(IPC.chooseMirror),
  setMirrorFolder: (path) => ipcRenderer.invoke(IPC.setMirror, path),
  setConfirmQuitWhenIdle: (on) => ipcRenderer.invoke(IPC.setConfirmQuit, on),
  revealLog: () => ipcRenderer.invoke(IPC.revealLog),

  begin: (header) => ipcRenderer.invoke(IPC.begin, header),
  appendSample: (sample) => ipcRenderer.send(IPC.appendSample, sample),
  appendLactate: (entry) => ipcRenderer.send(IPC.appendLactate, entry),
  appendEvent: (event) => ipcRenderer.send(IPC.appendEvent, event),
  appendRaw: (raw) => ipcRenderer.send(IPC.appendRaw, raw),
  appendRr: (rr) => ipcRenderer.send(IPC.appendRr, rr),
  appendEnvironment: (reading) => ipcRenderer.send(IPC.appendEnvironment, reading),
  close: (endedAt) => ipcRenderer.invoke(IPC.close, endedAt),

  list: () => ipcRenderer.invoke(IPC.list),
  read: (id) => ipcRenderer.invoke(IPC.read, id),
  discard: (id) => ipcRenderer.invoke(IPC.discard, id),
  unclosed: () => ipcRenderer.invoke(IPC.unclosed),
  resume: (id) => ipcRenderer.invoke(IPC.resume, id),
  amendLactate: (sessionId, entry) => ipcRenderer.invoke(IPC.amendLactate, sessionId, entry),
  importSessions: (sessions) => ipcRenderer.invoke(IPC.importSessions, sessions),
  reveal: (id) => ipcRenderer.invoke(IPC.reveal, id),

  library: () => ipcRenderer.invoke(IPC.library),
  saveProtocols: (protocols) => ipcRenderer.invoke(IPC.saveProtocols, protocols),
  savePreferences: (preferences) => ipcRenderer.invoke(IPC.savePreferences, preferences),

  onWriteStatus: (listener) => {
    const handler = (_event: unknown, status: Parameters<typeof listener>[0]) => listener(status)
    ipcRenderer.on(IPC.writeStatus, handler)
    return () => {
      ipcRenderer.off(IPC.writeStatus, handler)
    }
  },

  onBluetoothDevices: (listener) => {
    const handler = (_event: unknown, devices: Parameters<typeof listener>[0]) => listener(devices)
    ipcRenderer.on(IPC.bluetoothDevices, handler)
    return () => {
      ipcRenderer.off(IPC.bluetoothDevices, handler)
    }
  },

  selectBluetoothDevice: (deviceId) => ipcRenderer.send(IPC.selectBluetooth, deviceId),
}

contextBridge.exposeInMainWorld('testday', bridge)
