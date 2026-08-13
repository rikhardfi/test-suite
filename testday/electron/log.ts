import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A diagnostics log that outlives the process.
 *
 * When a test day goes wrong the console has already gone with the window, and
 * the operator is left with nothing to look at. This is the thing to look at.
 *
 * It deliberately holds no participant data: device names, error messages,
 * lifecycle events and counts, never an athlete's name and never a measurement.
 * The log gets copied around and pasted into messages, and a recording that is
 * careful about identifiers everywhere else must not leak them here.
 */

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_ROTATIONS = 3

export type LogLevel = 'info' | 'warn' | 'error'

export class DiagnosticsLog {
  private readonly file: string
  private failed = false

  constructor(private readonly dir: string) {
    this.file = join(dir, 'testday.log')
  }

  info(message: string, detail?: Record<string, unknown>): void {
    this.write('info', message, detail)
  }

  warn(message: string, detail?: Record<string, unknown>): void {
    this.write('warn', message, detail)
  }

  error(message: string, detail?: Record<string, unknown>): void {
    this.write('error', message, detail)
  }

  /** The path, so the interface can offer to reveal it. */
  get path(): string {
    return this.file
  }

  private write(level: LogLevel, message: string, detail?: Record<string, unknown>): void {
    // A log that throws would be worse than no log: this is called from crash
    // handlers, where a second failure loses the first one's message.
    if (this.failed) return
    try {
      mkdirSync(this.dir, { recursive: true })
      this.rotateIfLarge()
      const line = JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...(detail ? { detail } : {}),
      })
      appendFileSync(this.file, `${line}\n`)
    } catch {
      // One failure is enough to stop trying. Whatever is wrong with the disk
      // is already being reported through the recording status.
      this.failed = true
    }
  }

  private rotateIfLarge(): void {
    if (!existsSync(this.file)) return
    if (statSync(this.file).size < MAX_BYTES) return
    const oldest = `${this.file}.${KEEP_ROTATIONS}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`)
    }
    renameSync(this.file, `${this.file}.1`)
  }
}

/** Flattens an unknown throw into something worth writing down. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}
