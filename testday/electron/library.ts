import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Protocol } from '../src/model/protocol'

/**
 * Protocols and interface preferences, as files next to the recordings.
 *
 * They used to live in the renderer's IndexedDB and localStorage. Both are
 * scoped to the origin of the page, and the origin is not the same in every
 * build: a development window is http://localhost:5173 and the built app is
 * file://. Switching between them silently swapped in a different, empty store,
 * which is indistinguishable from every protocol having been deleted — and that
 * is exactly what it looked like when it happened.
 *
 * Owned by this process instead, they have one location, survive a rebuild and
 * a reinstall, sit in Finder next to the sessions, and can be copied to another
 * machine. A protocol somebody spent a test day designing should be at least as
 * durable as the recording it produced.
 */

export const PROTOCOLS_FILE = 'protocols.json'
export const PREFERENCES_FILE = 'preferences.json'

/** Whatever the renderer keeps in its settings object. Opaque to this process. */
export type Preferences = Record<string, unknown>

export class Library {
  readonly root: string
  private readonly protocolsPath: string
  private readonly preferencesPath: string

  constructor(root: string) {
    this.root = root
    this.protocolsPath = join(root, PROTOCOLS_FILE)
    this.preferencesPath = join(root, PREFERENCES_FILE)
  }

  /**
   * Preferences are saved on every change, including ones the operator never
   * made deliberately, such as which protocol was last opened. Writing only
   * what differs keeps that off the disk during a recording and leaves the
   * backup a generation that is actually worth going back to.
   */
  private unchanged(path: string, value: unknown): boolean {
    try {
      return readFileSync(path, 'utf8') === serialise(value)
    } catch {
      return false
    }
  }

  readProtocols(): Protocol[] {
    const parsed = readJson(this.protocolsPath)
    if (!Array.isArray(parsed)) return []
    // Anything without an id cannot be addressed later, so it is not a protocol.
    return parsed.filter(
      (item): item is Protocol =>
        !!item && typeof item === 'object' && typeof (item as Protocol).id === 'string',
    )
  }

  writeProtocols(protocols: Protocol[]): void {
    if (this.unchanged(this.protocolsPath, protocols)) return
    // The previous file is kept as .bak. A protocol list is small, written
    // rarely, and irreplaceable by hand; one generation back costs nothing and
    // covers the case of a bad write reaching disk intact.
    this.backup(this.protocolsPath)
    writeJson(this.protocolsPath, protocols)
  }

  readPreferences(): Preferences | null {
    const parsed = readJson(this.preferencesPath)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null
  }

  writePreferences(preferences: Preferences): void {
    if (this.unchanged(this.preferencesPath, preferences)) return
    this.backup(this.preferencesPath)
    writeJson(this.preferencesPath, preferences)
  }

  private backup(path: string): void {
    try {
      if (existsSync(path)) copyFileSync(path, `${path}.bak`)
    } catch {
      // A backup we cannot write is not a reason to refuse the write itself.
    }
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    // Missing, or damaged past the point of being useful. Either way there is
    // nothing to restore, and the caller gets an empty library rather than a
    // crash on a morning when somebody needs to run a test.
    return null
  }
}

const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Written to a temporary name, fsynced, then renamed into place. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.tmp`
  const data = Buffer.from(serialise(value))
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}
