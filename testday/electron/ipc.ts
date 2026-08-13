import type {
  JournalEvent,
  JournalHeader,
  JournalRaw,
  JournalRr,
  SessionSummary,
} from '../src/model/journal'
import type { LactateEntry, Sample, SessionRecord } from '../src/model/session'

/**
 * The contract between the recording process and the interface. Both sides
 * import these types, so a channel cannot be renamed on one side only.
 */
export const IPC = {
  paths: 'testday:paths',
  chooseMirror: 'testday:choose-mirror',
  setMirror: 'testday:set-mirror',
  setConfirmQuit: 'testday:set-confirm-quit',
  revealLog: 'testday:reveal-log',
  begin: 'testday:begin',
  appendSample: 'testday:append-sample',
  appendLactate: 'testday:append-lactate',
  appendEvent: 'testday:append-event',
  appendRaw: 'testday:append-raw',
  appendRr: 'testday:append-rr',
  close: 'testday:close',
  list: 'testday:list',
  read: 'testday:read',
  discard: 'testday:discard',
  unclosed: 'testday:unclosed',
  resume: 'testday:resume',
  amendLactate: 'testday:amend-lactate',
  importSessions: 'testday:import-sessions',
  reveal: 'testday:reveal',
  // Pushed from the recorder to the interface.
  writeStatus: 'testday:write-status',
  bluetoothDevices: 'testday:bluetooth-devices',
  selectBluetooth: 'testday:select-bluetooth',
} as const

export interface StoragePaths {
  root: string
  sessionsDir: string
  mirrorDir: string | null
  /** The diagnostics log, so the interface can offer to reveal it. */
  logFile: string
  /** Confirming a quit mid-recording is not configurable; this covers the rest. */
  confirmQuitWhenIdle: boolean
}

export interface BeginResult {
  id: string
  dir: string
}

export interface ResumeResult {
  session: SessionRecord
  /** Time of the last sample on disk, where the runner should pick up. */
  resumeFromS: number | null
}

export interface CloseResult {
  summary: SessionSummary | null
  bytes: number
  mirror: {
    ok: boolean
    target: string
    bytes: number
    sha256: string
    error?: string
  } | null
  /** How many verified copies exist, the number the operator actually needs. */
  copies: number
}

/**
 * Pushed after every append. `error` set means the last write did not reach the
 * disk, which the interface must show immediately and loudly.
 */
export interface WriteStatus {
  sessionId: string | null
  sampleCount: number
  lastDurableAt: number | null
  bytes: number
  error: string | null
}

export interface BluetoothDeviceInfo {
  deviceId: string
  deviceName: string
}

/** What `window.testday` exposes to the renderer. Absent in a plain browser. */
export interface TestdayBridge {
  readonly platform: 'desktop'
  paths(): Promise<StoragePaths>
  chooseMirrorFolder(): Promise<StoragePaths>
  setMirrorFolder(path: string | null): Promise<StoragePaths>
  setConfirmQuitWhenIdle(on: boolean): Promise<StoragePaths>
  revealLog(): Promise<void>

  begin(header: JournalHeader): Promise<BeginResult>
  appendSample(sample: Sample): void
  appendLactate(entry: LactateEntry): void
  appendEvent(event: Omit<JournalEvent, 'type'>): void
  appendRaw(raw: Omit<JournalRaw, 'type'>): void
  appendRr(rr: Omit<JournalRr, 'type'>): void
  close(endedAt: number): Promise<CloseResult>

  list(): Promise<SessionSummary[]>
  read(id: string): Promise<SessionRecord | null>
  discard(id: string): Promise<boolean>
  unclosed(): Promise<SessionSummary[]>
  resume(id: string): Promise<ResumeResult | null>
  amendLactate(sessionId: string, entry: LactateEntry): Promise<SessionRecord | null>
  importSessions(sessions: SessionRecord[]): Promise<number>
  reveal(id: string | null): Promise<void>

  onWriteStatus(listener: (status: WriteStatus) => void): () => void
  onBluetoothDevices(listener: (devices: BluetoothDeviceInfo[]) => void): () => void
  selectBluetoothDevice(deviceId: string): void
}

declare global {
  interface Window {
    testday?: TestdayBridge
  }
}
