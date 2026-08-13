import type { TestdayBridge } from '../../electron/ipc'
import type { JournalEventKind, JournalHeader } from './journal'
import type { LactateEntry, Sample } from './session'
import type { FinishResult, Recorder, RecorderStatus } from './recorder'

/**
 * Desktop recording. Each sample crosses to the main process and is appended to
 * an append-only journal and fsynced before that call returns on the far side,
 * so what is on disk is never more than one sample behind what happened.
 */
export function createFileRecorder(bridge: TestdayBridge): Recorder {
  const listeners = new Set<(status: RecorderStatus) => void>()
  let recording = false

  /**
   * The runner takes its first sample a fraction of a second after start, which
   * can be before the journal has finished opening. Anything that arrives in
   * that window is held here and replayed in order, so the recording never
   * begins one sample short.
   */
  let opening: Promise<void> | null = null
  const pending: Array<() => void> = []

  const queue = (write: () => void) => {
    if (opening) pending.push(write)
    else write()
  }

  const fail = (message: string) => {
    for (const listener of listeners) {
      listener({ recording: false, sampleCount: 0, lastDurableAt: null, bytes: 0, error: message })
    }
  }

  bridge.onWriteStatus((status) => {
    const next: RecorderStatus = {
      recording: recording && status.sessionId !== null,
      sampleCount: status.sampleCount,
      lastDurableAt: status.lastDurableAt,
      bytes: status.bytes,
      error: status.error,
    }
    for (const listener of listeners) listener(next)
  })

  return {
    kind: 'file',
    durability: 'Every sample is written to disk as it happens.',

    async begin(header: JournalHeader) {
      pending.length = 0
      opening = bridge
        .begin(header)
        .then(() => {
          recording = true
          opening = null
          for (const write of pending) write()
          pending.length = 0
        })
        .catch((error: unknown) => {
          opening = null
          pending.length = 0
          fail(error instanceof Error ? error.message : String(error))
          throw error
        })
      await opening
    },

    sample(sample: Sample) {
      queue(() => bridge.appendSample(sample))
    },

    lactate(entry: LactateEntry) {
      queue(() => bridge.appendLactate(entry))
    },

    event(kind: JournalEventKind, data) {
      const at = Date.now()
      queue(() => bridge.appendEvent({ kind, at, data }))
    },

    async finish(endedAt: number): Promise<FinishResult> {
      const result = await bridge.close(endedAt)
      recording = false

      const local = result.bytes > 0 ? `${formatBytes(result.bytes)} on this machine` : 'nothing on disk'
      if (!result.mirror) {
        return {
          copies: result.copies,
          bytes: result.bytes,
          detail: `${local}. No second copy is configured.`,
        }
      }
      if (result.mirror.ok) {
        return {
          copies: result.copies,
          bytes: result.bytes,
          detail: `${local}, copied and verified to ${result.mirror.target}.`,
        }
      }
      return {
        copies: result.copies,
        bytes: result.bytes,
        detail: `${local}. The second copy failed.`,
        error: result.mirror.error,
      }
    },

    list: () => bridge.list(),
    read: (id) => bridge.read(id),
    discard: (id) => bridge.discard(id),
    unclosed: () => bridge.unclosed(),

    async resume(id: string) {
      const state = await bridge.resume(id)
      if (state) recording = true
      return state
    },

    amendLactate: (sessionId, entry) => bridge.amendLactate(sessionId, entry),

    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
