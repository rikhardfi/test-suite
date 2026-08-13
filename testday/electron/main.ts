import { BrowserWindow, app, dialog, ipcMain, powerSaveBlocker, session, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter } from './journal'
import { SessionStore, isClosed, type OpenSession } from './sessions'
import { IPC, type CloseResult, type StoragePaths, type WriteStatus } from './ipc'
import type { JournalEvent, JournalHeader } from '../src/model/journal'
import type { LactateEntry, Sample, SessionRecord } from '../src/model/session'

const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'

/** Visible in Finder on purpose: a recording you cannot see is one you cannot check. */
const ROOT = join(app.getPath('documents'), 'testday')
const SETTINGS_FILE = join(ROOT, 'settings.json')
const DEFAULT_MIRROR = join(homedir(), 'Library', 'CloudStorage', 'OneDrive-TUNI.fi', 'testday-sessions')

interface MainSettings {
  mirrorDir: string | null
}

let store: SessionStore
let settings: MainSettings = { mirrorDir: null }
let win: BrowserWindow | null = null

/** The session currently being recorded, if any. At most one at a time. */
let active: OpenSession | null = null
let sleepBlockerId: number | null = null

/** Held while the renderer is choosing a Bluetooth device. Called exactly once. */
let bluetoothCallback: ((deviceId: string) => void) | null = null

// --- settings ---------------------------------------------------------------

function loadSettings(): MainSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<MainSettings>
    return { mirrorDir: typeof parsed.mirrorDir === 'string' ? parsed.mirrorDir : null }
  } catch {
    // No settings yet. Offer the OneDrive folder only if OneDrive is actually
    // set up on this machine, rather than inventing a path that will fail at
    // the worst possible moment.
    const parent = join(homedir(), 'Library', 'CloudStorage', 'OneDrive-TUNI.fi')
    return { mirrorDir: existsSync(parent) ? DEFAULT_MIRROR : null }
  }
}

function saveSettings(): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
  } catch {
    // A settings file we cannot write is not worth interrupting a test for.
  }
}

const paths = (): StoragePaths => ({
  root: store.root,
  sessionsDir: store.sessionsDir,
  mirrorDir: settings.mirrorDir,
})

// --- recording --------------------------------------------------------------

function pushStatus(error: string | null): void {
  const status: WriteStatus = {
    sessionId: active?.id ?? null,
    sampleCount: active?.sampleCount ?? 0,
    lastDurableAt: active?.writer.lastDurableAt ?? null,
    bytes: active ? store.bytesOnDisk(active.id) : 0,
    error,
  }
  win?.webContents.send(IPC.writeStatus, status)
}

/** Any failed append is reported, never swallowed. */
function guardedAppend(fn: () => void): void {
  if (!active) return
  try {
    fn()
    pushStatus(null)
  } catch (error) {
    pushStatus(error instanceof Error ? error.message : String(error))
  }
}

function holdSleep(): void {
  if (sleepBlockerId !== null) return
  // Display sleep drops Bluetooth connections, which ends a test in progress.
  sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep')
}

function releaseSleep(): void {
  if (sleepBlockerId === null) return
  powerSaveBlocker.stop(sleepBlockerId)
  sleepBlockerId = null
}

/** Closes the journal without a close record, leaving the session resumable. */
function detachActive(): void {
  active?.writer.close()
  active = null
  releaseSleep()
}

// --- window -----------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#07090d',
    title: 'testday',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const contents = win.webContents

  // Electron ships no Bluetooth chooser. Without preventDefault here the first
  // device found is picked silently; without a callback at all, requestDevice
  // never settles and the sensor panel hangs with no error.
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    bluetoothCallback = callback
    contents.send(
      IPC.bluetoothDevices,
      devices.map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName || 'Unnamed device',
      })),
    )
  })

  win.on('close', (event) => {
    if (!active) return
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Keep recording', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A session is still recording.',
      detail:
        'Everything recorded so far is already on disk and the session can be resumed, ' +
        'but quitting now stops the recording.',
    })
    if (choice === 0) {
      event.preventDefault()
      return
    }
    detachActive()
  })

  win.on('closed', () => {
    win = null
  })

  if (isDev) {
    void contents.loadURL(DEV_URL)
  } else {
    void win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }
}

/**
 * The app is entirely local and must stay that way on a test day: no update
 * check, no telemetry, nothing that can hang on a hotel network.
 */
function blockNetwork(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const local =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      (isDev && /^(https?|ws):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url))
    callback({ cancel: !local })
  })
}

// --- IPC --------------------------------------------------------------------

function registerHandlers(): void {
  ipcMain.handle(IPC.paths, () => paths())

  ipcMain.handle(IPC.chooseMirror, async () => {
    if (!win) return paths()
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose where the second copy is written',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.mirrorDir ?? homedir(),
    })
    if (!result.canceled && result.filePaths[0]) {
      settings.mirrorDir = result.filePaths[0]
      saveSettings()
    }
    return paths()
  })

  ipcMain.handle(IPC.setMirror, (_event, path: string | null) => {
    settings.mirrorDir = path && path.trim() ? path.trim() : null
    saveSettings()
    return paths()
  })

  ipcMain.handle(IPC.begin, (_event, header: JournalHeader) => {
    if (active) detachActive()
    active = store.begin(header)
    holdSleep()
    pushStatus(null)
    return { id: active.id, dir: active.dir }
  })

  ipcMain.on(IPC.appendSample, (_event, sample: Sample) => {
    guardedAppend(() => {
      active!.writer.append({ type: 'sample', ...sample })
      active!.sampleCount += 1
    })
  })

  ipcMain.on(IPC.appendLactate, (_event, entry: LactateEntry) => {
    guardedAppend(() => active!.writer.append({ type: 'lactate', ...entry }))
  })

  ipcMain.on(IPC.appendEvent, (_event, event: Omit<JournalEvent, 'type'>) => {
    guardedAppend(() => active!.writer.append({ type: 'event', ...event }))
  })

  ipcMain.handle(IPC.close, (_event, endedAt: number): CloseResult => {
    if (!active) return { summary: null, bytes: 0, mirror: null, copies: 0 }

    const { id, dir } = active
    let error: string | null = null
    try {
      active.writer.append({ type: 'closed', endedAt, sampleCount: active.sampleCount })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    active.writer.close()
    active = null
    releaseSleep()

    const summary = store.refreshMeta(dir)
    const bytes = store.bytesOnDisk(id)
    const mirror = settings.mirrorDir ? store.mirror(id, settings.mirrorDir) : null

    pushStatus(error)
    return {
      summary,
      bytes,
      mirror,
      copies: (bytes > 0 ? 1 : 0) + (mirror?.ok ? 1 : 0),
    }
  })

  ipcMain.handle(IPC.list, () => store.list())
  ipcMain.handle(IPC.read, (_event, id: string) => store.read(id))
  ipcMain.handle(IPC.discard, (_event, id: string) => store.discard(id))
  ipcMain.handle(IPC.unclosed, () => store.unclosed())

  ipcMain.handle(IPC.resume, (_event, id: string) => {
    if (active) detachActive()
    const reopened = store.reopen(id)
    if (!reopened) return null
    active = reopened.open
    holdSleep()
    // A finished session gets an explicit reopen record, so the close record
    // that is already in the file stops describing the session's current state.
    // Nothing is rewritten; the later record simply wins on read.
    if (isClosed(reopened.records)) {
      guardedAppend(() => active!.writer.append({ type: 'reopened', at: Date.now() }))
    }
    guardedAppend(() =>
      active!.writer.append({ type: 'event', kind: 'resumedFromDisk', at: Date.now() }),
    )
    const session = store.read(id)
    if (!session) return null
    return { session, resumeFromS: store.resumePoint(id) }
  })

  // Appends a correction rather than rewriting the value, so the original entry
  // stays in the journal and the later one wins on read.
  ipcMain.handle(IPC.amendLactate, (_event, id: string, entry: LactateEntry) => {
    if (active?.id === id) {
      guardedAppend(() => active!.writer.append({ type: 'lactate', ...entry }))
      return store.read(id)
    }
    const dir = store.dirFor(id)
    if (!dir) return null
    const writer = new JournalWriter(store.journalPath(dir))
    try {
      writer.append({ type: 'lactate', ...entry })
    } finally {
      writer.close()
    }
    store.refreshMeta(dir)
    return store.read(id)
  })

  ipcMain.handle(IPC.importSessions, (_event, sessions: SessionRecord[]) => {
    let imported = 0
    for (const record of sessions) {
      try {
        if (store.importSession(record)) imported += 1
      } catch {
        // One unreadable record must not stop the rest being rescued.
      }
    }
    return imported
  })

  ipcMain.handle(IPC.reveal, async (_event, id: string | null) => {
    const dir = id ? store.dirFor(id) : store.sessionsDir
    if (dir) await shell.openPath(dir)
  })

  ipcMain.on(IPC.selectBluetooth, (_event, deviceId: string) => {
    const callback = bluetoothCallback
    bluetoothCallback = null
    // An empty string is how Electron is told the user cancelled.
    callback?.(deviceId)
  })
}

// --- lifecycle --------------------------------------------------------------

// A second instance would fight the first for the same journal.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(() => {
    settings = loadSettings()
    store = new SessionStore(ROOT)
    saveSettings()
    blockNetwork()
    registerHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    detachActive()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
