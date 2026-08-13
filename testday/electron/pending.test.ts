import { describe, expect, it } from 'vitest'
import { PendingAppends } from './pending'
import type { JournalRecord } from '../src/model/journal'

const sample = (t: number): JournalRecord => ({
  type: 'sample',
  t,
  stepIndex: 0,
  phase: 'work',
  power: 200 + t,
})

/** An appender that fails for the first `failures` calls, then works. */
function flakyWriter(failures: number) {
  const written: JournalRecord[] = []
  let remaining = failures
  return {
    written,
    append(record: JournalRecord) {
      if (remaining > 0) {
        remaining -= 1
        throw new Error('disk full')
      }
      written.push(record)
    },
  }
}

describe('PendingAppends', () => {
  it('holds a failed record and writes it on the next drain', () => {
    const pending = new PendingAppends()
    const writer = flakyWriter(0)
    pending.hold(sample(1))
    expect(pending.drain(writer.append)).toBe(1)
    expect(writer.written).toEqual([sample(1)])
    expect(pending.size).toBe(0)
  })

  /**
   * The property that matters most: a journal is read back in file order, so
   * records must land in the order they happened even across a failure.
   */
  it('preserves order across a partial drain', () => {
    const pending = new PendingAppends()
    pending.hold(sample(1))
    pending.hold(sample(2))
    pending.hold(sample(3))

    // Fails on the second, so the first lands and the rest stay queued in order.
    const written: JournalRecord[] = []
    let calls = 0
    expect(
      pending.drain((record) => {
        calls += 1
        if (calls === 2) throw new Error('still full')
        written.push(record)
      }),
    ).toBe(1)

    expect(written).toEqual([sample(1)])
    expect(pending.size).toBe(2)

    const rest = flakyWriter(0)
    expect(pending.drain(rest.append)).toBe(2)
    expect(rest.written).toEqual([sample(2), sample(3)])
  })

  it('reports nothing wrong when it is empty', () => {
    expect(new PendingAppends().message()).toBeNull()
  })

  it('says how many records are waiting', () => {
    const pending = new PendingAppends()
    pending.hold(sample(1))
    pending.hold(sample(2))
    expect(pending.message()).toContain('2 record(s) not yet on disk')
  })

  /**
   * Past the limit records are dropped rather than growing the buffer until the
   * process dies. The drop is counted and reported: a loss the operator is not
   * told about is worse than the loss itself.
   */
  it('stops growing at its limit and counts what it lost', () => {
    const pending = new PendingAppends(2)
    expect(pending.hold(sample(1))).toBe(true)
    expect(pending.hold(sample(2))).toBe(true)
    expect(pending.hold(sample(3))).toBe(false)
    expect(pending.hold(sample(4))).toBe(false)

    expect(pending.size).toBe(2)
    expect(pending.lostCount).toBe(2)
    expect(pending.message()).toContain('2 record(s) lost')
  })

  /** A loss stays reported even after the backlog clears, because it is permanent. */
  it('keeps reporting a loss after the queue drains', () => {
    const pending = new PendingAppends(1)
    pending.hold(sample(1))
    pending.hold(sample(2))
    pending.drain(flakyWriter(0).append)
    expect(pending.size).toBe(0)
    expect(pending.message()).toContain('lost')
  })

  it('forgets everything when a new session resets it', () => {
    const pending = new PendingAppends(1)
    pending.hold(sample(1))
    pending.hold(sample(2))
    pending.reset()
    expect(pending.size).toBe(0)
    expect(pending.lostCount).toBe(0)
    expect(pending.message()).toBeNull()
  })
})
