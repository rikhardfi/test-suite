import type { Protocol, Athlete } from './protocol'
import type { SessionRecord } from './session'

const DB_NAME = 'testday'
const DB_VERSION = 1
const STORE_SESSIONS = 'sessions'
const STORE_PROTOCOLS = 'protocols'
const SETTINGS_KEY = 'testday.settings.v1'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' }).createIndex(
          'startedAt',
          'startedAt',
        )
      }
      if (!db.objectStoreNames.contains(STORE_PROTOCOLS)) {
        db.createObjectStore(STORE_PROTOCOLS, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open database'))
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const request = fn(transaction.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Storage request failed'))
      }),
  )
}

export const saveSession = (session: SessionRecord): Promise<unknown> =>
  tx(STORE_SESSIONS, 'readwrite', (s) => s.put(session))

export const loadSession = (id: string): Promise<SessionRecord | undefined> =>
  tx<SessionRecord | undefined>(STORE_SESSIONS, 'readonly', (s) => s.get(id))

export const deleteSession = (id: string): Promise<unknown> =>
  tx(STORE_SESSIONS, 'readwrite', (s) => s.delete(id))

export async function listSessions(): Promise<SessionRecord[]> {
  const all = await tx<SessionRecord[]>(STORE_SESSIONS, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Protocols.
 *
 * In the desktop app they are files, held by the recording process. In a
 * browser there is nowhere else to put them, so IndexedDB it is — with the
 * caveat that IndexedDB belongs to the page's origin, and a protocol written
 * there is only ever one cleared cache away from gone.
 */
const desktop = (): NonNullable<Window['testday']> | null =>
  typeof window === 'undefined' ? null : (window.testday ?? null)

/** The desktop store is a whole-file read and write, so the list is held here. */
let protocolCache: Protocol[] | null = null

async function currentProtocols(): Promise<Protocol[]> {
  const bridge = desktop()
  if (!bridge) return tx<Protocol[]>(STORE_PROTOCOLS, 'readonly', (s) => s.getAll())
  protocolCache ??= (await bridge.library()).protocols
  return protocolCache
}

async function writeProtocols(protocols: Protocol[]): Promise<void> {
  const bridge = desktop()
  if (!bridge) return
  protocolCache = protocols
  await bridge.saveProtocols(protocols)
}

export async function saveProtocol(protocol: Protocol): Promise<unknown> {
  const bridge = desktop()
  if (!bridge) return tx(STORE_PROTOCOLS, 'readwrite', (s) => s.put(protocol))
  const rest = (await currentProtocols()).filter((p) => p.id !== protocol.id)
  await writeProtocols([...rest, protocol])
  return undefined
}

export async function deleteProtocol(id: string): Promise<unknown> {
  const bridge = desktop()
  if (!bridge) return tx(STORE_PROTOCOLS, 'readwrite', (s) => s.delete(id))
  await writeProtocols((await currentProtocols()).filter((p) => p.id !== id))
  return undefined
}

export async function listProtocols(): Promise<Protocol[]> {
  const all = await currentProtocols()
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Moves protocols written before this machine kept them as files, once.
 *
 * Called for a given origin exactly once, because it is a merge and not a sync:
 * running it again would resurrect anything deleted since. Anything already
 * held by id is left alone, so a protocol edited in the desktop app is never
 * overwritten by the older copy the browser store still has.
 */
export async function importLegacyProtocols(): Promise<number> {
  const bridge = desktop()
  if (!bridge) return 0
  let legacy: Protocol[]
  try {
    legacy = await tx<Protocol[]>(STORE_PROTOCOLS, 'readonly', (s) => s.getAll())
  } catch {
    return 0
  }
  const held = await currentProtocols()
  const missing = legacy.filter((p) => p.id && !held.some((existing) => existing.id === p.id))
  if (missing.length === 0) return 0
  await writeProtocols([...held, ...missing])
  return missing.length
}

export interface Settings {
  athlete: Athlete
  wheelCircumferenceM: number
  lastProtocolId?: string
  /**
   * Salt for the participant code in a research export. Generated once on this
   * machine and never exported, which is what stops the same athlete's code
   * being derivable by anyone holding the exported files.
   */
  participantSalt?: string
  /**
   * Front-face dashboard tiles per sport, in display order. Empty or missing
   * means the defaults for that sport.
   */
  dashboardTiles?: { bike?: string[]; run?: string[] }
  /**
   * Where the dashboard's two dividers sit, per sport. A step test is read off
   * the lap table and a ramp off the tiles, so the same split does not suit
   * both, and neither is worth setting again every test day.
   */
  dashboardLayout?: {
    bike?: { colsPct: number; rowsPct: number }
    run?: { colsPct: number; rowsPct: number }
  }
  /**
   * Sensors paired on this machine and which metric each was assigned to.
   * Re-deciding this at the start of every test day is the kind of setup that
   * gets skipped once and then yields a trace from the wrong device.
   */
  sensors?: {
    known?: { id: string; name: string; profileKey: string }[]
    preferred?: Record<string, string>
  }
  /**
   * Whether the trainer is commanded the raw protocol target or a figure
   * corrected so the reference power meter reads it.
   *
   * Off by default, and deliberately so: with one power source there is nothing
   * to correct against, and a correction driven by a meter nobody has checked
   * imposes that meter's error on the athlete. Turning it on is a statement
   * that the reference is worth believing.
   */
  powerMatch?: { enabled: boolean }
}

/** Made once per machine, on first use, and then left alone. */
export function ensureParticipantSalt(settings: Settings): Settings {
  if (settings.participantSalt) return settings
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { ...settings, participantSalt: salt }
}

const merge = (fallback: Settings, parsed: Partial<Settings>): Settings => ({
  ...fallback,
  ...parsed,
  athlete: { ...fallback.athlete, ...parsed.athlete },
})

/**
 * Settings are needed synchronously at boot, so localStorage is read first and
 * the desktop copy is merged in a moment later by `loadStoredSettings`. The
 * localStorage copy is per-origin and therefore not to be trusted as the only
 * one: it is a cache, and the file is the record.
 */
export function loadSettings(fallback: Settings): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    return merge(fallback, JSON.parse(raw) as Partial<Settings>)
  } catch {
    return fallback
  }
}

/**
 * The desktop copy, or null when there is none. Returned as it was stored
 * rather than merged with a fallback, so that a setting the file does not
 * mention leaves whatever booted alone instead of reverting to a default.
 */
export async function loadStoredSettings(): Promise<Partial<Settings> | null> {
  const bridge = desktop()
  if (!bridge) return null
  try {
    const { preferences } = await bridge.library()
    return (preferences as Partial<Settings> | null) ?? null
  } catch {
    return null
  }
}

/** Layers a stored copy over what is in hand, athlete fields included. */
export const applySettings = (current: Settings, stored: Partial<Settings>): Settings =>
  merge(current, stored)

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Private browsing or a full quota; settings simply do not persist.
  }
  // Fire and forget: nothing in the interface waits on it, and a failure to
  // write preferences must never be allowed to interrupt a test.
  void desktop()?.savePreferences(settings as unknown as Record<string, unknown>)
}
