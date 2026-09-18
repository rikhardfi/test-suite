/**
 * Sample times for the flow meter, from sample indices rather than arrival.
 *
 * The meter samples on its own clock, exactly one row per `dt`, but the rows
 * reach the computer in bursts: TCP and the meter's own buffering deliver them
 * tens of milliseconds late, and by a varying amount. The network itself costs
 * about 1 ms (measured by ping), so nearly all of that lateness is queueing.
 *
 * A row can arrive late but never early. So for each 30 s segment the earliest
 * possible start is `min(arrival_i − i·dt)` over its rows: the lower envelope.
 * The row that achieved it is the one that waited least, and every other row's
 * time follows from its index. What remains is the ~1 ms transport time and
 * the meter's averaging window (a row is the mean of the `dt` before its time
 * stamp), both far below anything a breath or a test stage resolves.
 *
 * Re-anchoring every segment also absorbs any drift between the meter's clock
 * and the computer's, which is why the drift estimate is recorded as a check
 * rather than applied.
 */
export class SegmentClock {
  readonly dtMs: number
  private anchor = Infinity
  private n = 0
  private firstArrival = NaN
  private lastArrival = NaN

  constructor(dtMs: number) {
    this.dtMs = dtMs
  }

  /** Records the arrival of row `n` and returns its index. */
  add(arrivalMs: number): number {
    const i = this.n
    const candidate = arrivalMs - i * this.dtMs
    if (candidate < this.anchor) this.anchor = candidate
    if (i === 0) this.firstArrival = arrivalMs
    this.lastArrival = arrivalMs
    this.n += 1
    return i
  }

  get count(): number {
    return this.n
  }

  /** Best estimate so far of when row 0 was sampled (wall clock, ms). */
  get anchorMs(): number {
    return this.anchor
  }

  /** Estimated sample time of row `i`. */
  timeOf(i: number): number {
    return this.anchor + i * this.dtMs
  }

  /** When the last row of this segment was sampled. */
  get endMs(): number {
    return this.anchor + (this.n - 1) * this.dtMs
  }

  /**
   * The meter's sample interval as the computer's clock saw it, from first and
   * last arrival. Noisy by the burst lag divided by the segment length, so it
   * is a drift check, not a correction.
   */
  get observedDtMs(): number | null {
    if (this.n < 2) return null
    return (this.lastArrival - this.firstArrival) / (this.n - 1)
  }
}

/**
 * Rows missing between two segments: time from the last row of one to the
 * first of the next, less the one interval that separates adjacent rows.
 */
export function gapSamples(previousEndMs: number, nextAnchorMs: number, dtMs: number): number {
  return Math.max(0, Math.round((nextAnchorMs - previousEndMs) / dtMs) - 1)
}

/**
 * Volume that passed during a gap, from the meter's totalizer, which keeps
 * integrating while no rows are sent. The first row of the next segment
 * already includes its own interval, which is taken back out. Null when the
 * totalizer was reset in between, because the difference then means nothing.
 */
export function gapVolumeL(
  lastTotalL: number,
  firstTotalL: number,
  firstFlowLMin: number,
  dtMs: number,
  resetBetween: boolean,
): number | null {
  if (resetBetween) return null
  const firstInterval = (firstFlowLMin * dtMs) / 60_000
  return Math.max(0, firstTotalL - lastTotalL - firstInterval)
}

/** Wall-clock milliseconds with sub-millisecond resolution that never step backwards. */
export const preciseNow = (): number => performance.timeOrigin + performance.now()
