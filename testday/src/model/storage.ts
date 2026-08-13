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

export const saveProtocol = (protocol: Protocol): Promise<unknown> =>
  tx(STORE_PROTOCOLS, 'readwrite', (s) => s.put(protocol))

export const deleteProtocol = (id: string): Promise<unknown> =>
  tx(STORE_PROTOCOLS, 'readwrite', (s) => s.delete(id))

export async function listProtocols(): Promise<Protocol[]> {
  const all = await tx<Protocol[]>(STORE_PROTOCOLS, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
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
   * Sensors paired on this machine and which metric each was assigned to.
   * Re-deciding this at the start of every test day is the kind of setup that
   * gets skipped once and then yields a trace from the wrong device.
   */
  sensors?: {
    known?: { id: string; name: string; profileKey: string }[]
    preferred?: Record<string, string>
  }
}

/** Made once per machine, on first use, and then left alone. */
export function ensureParticipantSalt(settings: Settings): Settings {
  if (settings.participantSalt) return settings
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { ...settings, participantSalt: salt }
}

/** Settings are small and needed synchronously at boot, so they live in localStorage. */
export function loadSettings(fallback: Settings): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...fallback,
      ...parsed,
      athlete: { ...fallback.athlete, ...parsed.athlete },
    }
  } catch {
    return fallback
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Private browsing or a full quota; settings simply do not persist.
  }
}
