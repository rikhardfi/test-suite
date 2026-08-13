import type { JournalRecord } from '../src/model/journal'

/**
 * Records whose append failed, held for another try.
 *
 * A write can fail transiently: a disk that fills and is then freed, a volume
 * that blinks, a permissions change. Reporting the failure once and moving on
 * leaves a hole in the middle of the recording that nothing will ever fill,
 * which is exactly the silent loss the journal exists to prevent.
 *
 * Two properties matter here:
 *
 * 1. **Order is preserved.** A journal is read back in file order, so a record
 *    that failed and one that succeeded after it must still land in the order
 *    they happened. Once anything is queued, everything queues behind it.
 * 2. **The buffer is bounded.** An unbounded buffer against a permanently dead
 *    disk is a slower way to lose the session, and it takes the process with
 *    it. Past the limit records are dropped and counted, and the count is what
 *    the interface reports, because a loss the operator is not told about is
 *    the worst outcome available.
 */
export class PendingAppends {
  private queue: JournalRecord[] = []
  private lost = 0

  constructor(private readonly limit = 5000) {}

  get size(): number {
    return this.queue.length
  }

  get lostCount(): number {
    return this.lost
  }

  /** False when the buffer was full and the record had to be given up on. */
  hold(record: JournalRecord): boolean {
    if (this.queue.length >= this.limit) {
      this.lost += 1
      return false
    }
    this.queue.push(record)
    return true
  }

  /**
   * Retries everything held, oldest first, and stops at the first failure so
   * the remainder keeps its order for the next attempt.
   *
   * Returns how many reached the disk.
   */
  drain(append: (record: JournalRecord) => void): number {
    const queued = this.queue
    this.queue = []
    for (let i = 0; i < queued.length; i++) {
      try {
        append(queued[i])
      } catch {
        this.queue = queued.slice(i)
        return i
      }
    }
    return queued.length
  }

  /** What the operator needs told, or null when there is nothing wrong. */
  message(): string | null {
    if (this.lost > 0) {
      return `${this.lost} record(s) lost: the disk stopped accepting writes for too long.`
    }
    if (this.queue.length > 0) {
      return `${this.queue.length} record(s) not yet on disk, retrying.`
    }
    return null
  }

  reset(): void {
    this.queue = []
    this.lost = 0
  }
}
