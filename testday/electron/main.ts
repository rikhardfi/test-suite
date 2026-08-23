import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  powerSaveBlocker,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter } from './journal'
import { DiagnosticsLog, describeError } from './log'
import { PendingAppends } from './pending'
import { SessionStore, isClosed, type OpenSession } from './sessions'
import { Library } from './library'
import { IPC, type CloseResult, type StoragePaths, type WriteStatus } from './ipc'
import type {
  JournalEvent,
  JournalEnvironment,
  JournalHeader,
  JournalRaw,
  JournalRecord,
  JournalRr,
} from '../src/model/journal'
import type { LactateEntry, Sample, SessionRecord } from '../src/model/session'
import type { Protocol } from '../src/model/protocol'

/**
 * Dev mode is the presence of a running Vite server, not the absence of a
 * packaged app: `testday.command` builds into dist/ and then starts an
 * unpackaged Electron, which must load that build from disk rather than sit
 * waiting on a dev server nobody started.
 */
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? null
const isDev = !app.isPackaged && DEV_URL !== null

/** Visible in Finder on purpose: a recording you cannot see is one you cannot check. */
const ROOT = join(app.getPath('documents'), 'testday')
const SETTINGS_FILE = join(ROOT, 'settings.json')
const LOG_DIR = join(ROOT, 'logs')
const DEFAULT_MIRROR = join(homedir(), 'Library', 'CloudStorage', 'OneDrive-TUNI.fi', 'testday-sessions')

interface MainSettings {
  mirrorDir: string | null
  /**
   * Whether to confirm quitting when nothing is recording. A recording session
   * always confirms and that is not configurable.
   */
  confirmQuitWhenIdle: boolean
  /**
   * Interface scale. Remembered per machine, because it is a property of the
   * screen it is being read on: a laptop on a treadmill's cup holder and a
   * monitor across the lab want different answers.
   */
  zoomFactor: number
}

const MIN_ZOOM = 0.6
const MAX_ZOOM = 2.5

const log = new DiagnosticsLog(LOG_DIR)
let store: SessionStore
/** Protocols and interface preferences, which outlive any single recording. */
let library: Library
let settings: MainSettings = { mirrorDir: null, confirmQuitWhenIdle: true, zoomFactor: 1 }
let win: BrowserWindow | null = null

/** The session currently being recorded, if any. At most one at a time. */
let active: OpenSession | null = null
let sleepBlockerId: number | null = null

/** Held while the renderer is choosing a Bluetooth device. Called exactly once. */
let bluetoothCallback: ((deviceId: string) => void) | null = null

// --- settings ---------------------------------------------------------------

const clampZoom = (factor: unknown): number =>
  typeof factor === 'number' && Number.isFinite(factor)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor))
    : 1

/**
 * Scales the whole interface, and remembers it.
 *
 * The dashboard is read from wherever the operator is standing, which is often
 * not in front of the laptop, and the numbers are the point of the screen. This
 * is the one control that makes them bigger without anything having to be
 * hidden to make room.
 */
function applyZoom(factor: number): void {
  settings.zoomFactor = clampZoom(factor)
  win?.webContents.setZoomFactor(settings.zoomFactor)
  saveSettings()
}

function loadSettings(): MainSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<MainSettings>
    return {
      mirrorDir: typeof parsed.mirrorDir === 'string' ? parsed.mirrorDir : null,
      confirmQuitWhenIdle: parsed.confirmQuitWhenIdle !== false,
      zoomFactor: clampZoom(parsed.zoomFactor),
    }
  } catch {
    // No settings yet. Offer the OneDrive folder only if OneDrive is actually
    // set up on this machine, rather than inventing a path that will fail at
    // the worst possible moment.
    const parent = join(homedir(), 'Library', 'CloudStorage', 'OneDrive-TUNI.fi')
    return {
      mirrorDir: existsSync(parent) ? DEFAULT_MIRROR : null,
      confirmQuitWhenIdle: true,
      zoomFactor: 1,
    }
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
  logFile: log.path,
  confirmQuitWhenIdle: settings.confirmQuitWhenIdle,
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

/**
 * Retry buffer for failed appends. See `pending.ts` for why it exists and why
 * it is bounded.
 */
const RETRY_MS = 2000
const pending = new PendingAppends()
let retryTimer: ReturnType<typeof setInterval> | null = null

function queueForRetry(record: JournalRecord): boolean {
  const kept = pending.hold(record)
  if (!retryTimer) retryTimer = setInterval(drainPending, RETRY_MS)
  return kept
}

function drainPending(): void {
  if (pending.size === 0) {
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = null
    }
    return
  }
  if (!active) return
  const writer = active.writer
  const written = pending.drain((record) => writer.append(record))
  if (written > 0) log.info('drained pending journal records', { count: written })
  pushStatus(pending.message())
}

function resetPending(): void {
  pending.reset()
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

/**
 * Any failed append is reported, never swallowed, and retried. Returns false
 * only when the record could not even be held for a retry.
 */
function guardedAppend(record: JournalRecord): boolean {
  if (!active) return false
  try {
    active.writer.append(record)
    pushStatus(pending.message())
    return true
  } catch (error) {
    log.error('journal append failed', describeError(error))
    const kept = queueForRetry(record)
    pushStatus(error instanceof Error ? error.message : String(error))
    return kept
  }
}

/**
 * The same, for the native-rate stream. A status push per append would send
 * several IPC messages a second back to the renderer for records nothing in the
 * interface displays, so success is silent here and only failure speaks. The
 * 1 Hz sample append keeps the pill honest either way.
 */
function guardedAppendQuiet(record: JournalRecord): void {
  if (!active) return
  try {
    active.writer.append(record)
  } catch (error) {
    queueForRetry(record)
    pushStatus(error instanceof Error ? error.message : String(error))
  }
}

// --- watchdog ---------------------------------------------------------------

/**
 * Watches the sample stream itself, not the disk.
 *
 * The recording pill already goes stale when a write stops reaching the disk.
 * It says nothing about the case where writes are perfectly healthy and no
 * samples are arriving to write, because the runner stopped, the renderer
 * wedged, or a timer was throttled. From the operator's side that looks exactly
 * like a working recording, which is the worst way to lose a test.
 *
 * Paused is not stalled, so the runner's own pause and resume events are
 * tracked and the watchdog holds its tongue while the test is deliberately
 * stopped.
 */
const STALL_MS = 5000
let lastSampleAt = 0
let runnerPaused = false
let stallTimer: ReturnType<typeof setInterval> | null = null
let stallReported = false

function noteSampleArrived(): void {
  lastSampleAt = Date.now()
  if (stallReported) {
    stallReported = false
    log.info('sample stream recovered')
    pushStatus(pending.message())
  }
}

function noteRunnerEvent(kind: JournalEvent['kind']): void {
  if (kind === 'pause') runnerPaused = true
  else if (kind === 'start' || kind === 'resume' || kind === 'resumedFromDisk') {
    runnerPaused = false
    lastSampleAt = Date.now()
  }
}

function startWatchdog(): void {
  lastSampleAt = Date.now()
  runnerPaused = false
  stallReported = false
  if (stallTimer) return
  stallTimer = setInterval(() => {
    if (!active || runnerPaused || stallReported) return
    const since = Date.now() - lastSampleAt
    if (since < STALL_MS) return
    stallReported = true
    log.warn('sample stream stalled', { sinceMs: since, samples: active.sampleCount })
    pushStatus(`No samples for ${Math.round(since / 1000)} s. The recording may have stopped.`)
  }, 1000)
}

function stopWatchdog(): void {
  if (!stallTimer) return
  clearInterval(stallTimer)
  stallTimer = null
  stallReported = false
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
  if (active) log.info('detaching active session', { id: active.id, samples: active.sampleCount })
  active?.writer.close()
  active = null
  releaseSleep()
  stopWatchdog()
  resetPending()
}

// --- leaving ----------------------------------------------------------------

/**
 * Set once a quit has been confirmed, so the two events a single Cmd+Q raises
 * (`before-quit`, then the window's `close`) ask exactly once between them.
 */
let quitting = false

/**
 * Confirms leaving, which is never silent while a session is recording.
 *
 * Quitting mid-test does not lose anything already on disk, but it does stop
 * the recording, and an operator who did not mean to do that has to be told
 * they are about to. `before-quit` fires before any window close, so the
 * confirmation has to live here rather than only on the window, or Cmd+Q walks
 * straight past it.
 */
function confirmLeaving(source: 'quit' | 'close'): boolean {
  const recording = active !== null

  if (!recording && !settings.confirmQuitWhenIdle) return true

  const options = recording
    ? {
        type: 'warning' as const,
        buttons: ['Keep recording', 'Stop recording and quit'],
        message: 'A session is still recording.',
        detail:
          'Everything recorded so far is already on disk and the session can be resumed, ' +
          'but leaving now stops the recording.',
      }
    : {
        type: 'question' as const,
        buttons: ['Cancel', 'Quit'],
        message: 'Quit testday?',
        detail: 'No session is recording. Nothing is lost either way.',
      }

  const choice = win
    ? dialog.showMessageBoxSync(win, { ...options, defaultId: 0, cancelId: 0 })
    : dialog.showMessageBoxSync({ ...options, defaultId: 0, cancelId: 0 })

  const confirmed = choice === 1
  log.info(confirmed ? 'leaving confirmed' : 'leaving cancelled', { source, recording })
  return confirmed
}

// --- window -----------------------------------------------------------------

/**
 * The application menu.
 *
 * Built rather than left to Electron's default for one reason: the zoom items
 * have to persist what they set, and the default ones do not. Reload is
 * deliberately absent — a reload mid-test throws away the dashboard's state,
 * and there is nothing on this screen worth the risk of a mistyped ⌘R. The
 * journal survives regardless, and a restart resumes from it.
 */
function buildMenu(): void {
  const zoomBy = (delta: number) => () => applyZoom(settings.zoomFactor + delta)
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Bigger', accelerator: 'CommandOrControl+Plus', click: zoomBy(0.1) },
        // The same key without shift, which is what fingers actually press.
        { label: 'Bigger', accelerator: 'CommandOrControl+=', click: zoomBy(0.1), visible: false },
        { label: 'Smaller', accelerator: 'CommandOrControl+-', click: zoomBy(-0.1) },
        { label: 'Actual size', accelerator: 'CommandOrControl+0', click: () => applyZoom(1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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

  // The scale the operator left it at, applied before anything is painted.
  contents.on('did-finish-load', () => contents.setZoomFactor(settings.zoomFactor))
  // Pinch and ctrl-scroll go through the same setting, so the menu and the
  // trackpad cannot end up disagreeing about how big the interface is.
  contents.on('zoom-changed', (_event, direction) => {
    applyZoom(settings.zoomFactor + (direction === 'in' ? 0.1 : -0.1))
  })

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

  // A renderer crash must not end the test. Recording lives in this process and
  // carries on regardless, so the window is simply brought back and the session
  // it was showing is still open underneath it.
  contents.on('render-process-gone', (_event, details) => {
    log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode })
    if (details.reason === 'clean-exit') return
    win?.webContents.reload()
  })

  contents.on('unresponsive', () => log.warn('renderer unresponsive'))
  contents.on('responsive', () => log.info('renderer responsive again'))

  win.on('close', (event) => {
    // A quit already confirmed at `before-quit` must not ask a second time on
    // the way out through the window.
    if (quitting) {
      detachActive()
      return
    }
    if (!confirmLeaving('close')) {
      event.preventDefault()
      return
    }
    detachActive()
  })

  win.on('closed', () => {
    win = null
  })

  if (isDev && DEV_URL) {
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

  ipcMain.handle(IPC.setConfirmQuit, (_event, on: boolean) => {
    settings.confirmQuitWhenIdle = on !== false
    saveSettings()
    return paths()
  })

  ipcMain.handle(IPC.revealLog, async () => {
    await shell.showItemInFolder(log.path)
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
    startWatchdog()
    log.info('session begun', { id: active.id })
    pushStatus(null)
    return { id: active.id, dir: active.dir }
  })

  ipcMain.on(IPC.appendSample, (_event, sample: Sample) => {
    if (guardedAppend({ type: 'sample', ...sample })) active!.sampleCount += 1
    noteSampleArrived()
  })

  ipcMain.on(IPC.appendLactate, (_event, entry: LactateEntry) => {
    guardedAppend({ type: 'lactate', ...entry })
  })

  ipcMain.on(IPC.appendEvent, (_event, event: Omit<JournalEvent, 'type'>) => {
    guardedAppend({ type: 'event', ...event })
    noteRunnerEvent(event.kind)
  })

  ipcMain.on(IPC.appendRaw, (_event, raw: Omit<JournalRaw, 'type'>) => {
    guardedAppendQuiet({ type: 'raw', ...raw })
  })

  ipcMain.on(IPC.appendRr, (_event, rr: Omit<JournalRr, 'type'>) => {
    guardedAppendQuiet({ type: 'rr', ...rr })
  })

  ipcMain.on(IPC.appendEnvironment, (_event, reading: Omit<JournalEnvironment, 'type'>) => {
    // Not quiet: there are only a handful of these in a session and every one
    // of them matters to how the result is read afterwards.
    guardedAppend({ type: 'environment', ...reading })
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
    stopWatchdog()
    resetPending()
    log.info('session closed', { id, error })

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
    startWatchdog()
    // A finished session gets an explicit reopen record, so the close record
    // that is already in the file stops describing the session's current state.
    // Nothing is rewritten; the later record simply wins on read.
    if (isClosed(reopened.records)) {
      guardedAppend({ type: 'reopened', at: Date.now() })
    }
    guardedAppend({ type: 'event', kind: 'resumedFromDisk', at: Date.now() })
    const session = store.read(id)
    if (!session) return null
    return { session, resumeFromS: store.resumePoint(id) }
  })

  // Appends a correction rather than rewriting the value, so the original entry
  // stays in the journal and the later one wins on read.
  ipcMain.handle(IPC.amendLactate, (_event, id: string, entry: LactateEntry) => {
    if (active?.id === id) {
      guardedAppend({ type: 'lactate', ...entry })
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

  ipcMain.handle(IPC.library, () => ({
    protocols: library.readProtocols(),
    preferences: library.readPreferences(),
  }))

  ipcMain.handle(IPC.saveProtocols, (_event, protocols: Protocol[]) => {
    library.writeProtocols(protocols)
    log.info('protocols saved', { count: protocols.length })
  })

  ipcMain.handle(IPC.savePreferences, (_event, preferences: Record<string, unknown>) => {
    library.writePreferences(preferences)
  })

  ipcMain.on(IPC.selectBluetooth, (_event, deviceId: string) => {
    const callback = bluetoothCallback
    bluetoothCallback = null
    // An empty string is how Electron is told the user cancelled.
    callback?.(deviceId)
  })
}

// --- lifecycle --------------------------------------------------------------

/**
 * Last rites for the recording process.
 *
 * This process holds the only open journal. An unhandled throw here would take
 * a live recording down with it, and the default behaviour is to die without a
 * word. So: write down what happened, close the journal properly so the session
 * is left resumable rather than merely abandoned, then go.
 *
 * The journal is append-only and fsynced, so nothing already written is at
 * risk. What this buys is the close and the note saying why.
 */
function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception in the main process', describeError(error))
    try {
      detachActive()
    } finally {
      // Not `app.quit()`: a quit runs `before-quit`, which would try to open a
      // dialog from an already-broken process.
      app.exit(1)
    }
  })

  process.on('unhandledRejection', (reason) => {
    // A rejected promise has not necessarily broken anything, so this is noted
    // and the app keeps running. Killing a test day over it would be worse.
    log.warn('unhandled rejection in the main process', describeError(reason))
  })

  app.on('child-process-gone', (_event, details) => {
    log.error('child process gone', { type: details.type, reason: details.reason })
  })
}

// A second instance would fight the first for the same journal.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  installCrashHandlers()

  void app.whenReady().then(() => {
    settings = loadSettings()
    store = new SessionStore(ROOT)
    library = new Library(ROOT)
    saveSettings()
    buildMenu()
    log.info('app started', { version: app.getVersion(), platform: process.platform })
    blockNetwork()
    registerHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', (event) => {
    // Fires before any window close, which is why the guard has to be here as
    // well as on the window: without it Cmd+Q ends a recording without a word.
    if (quitting) return
    if (!confirmLeaving('quit')) {
      event.preventDefault()
      return
    }
    quitting = true
    detachActive()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
