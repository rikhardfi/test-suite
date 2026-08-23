import { describe, expect, it } from 'vitest'
import {
  POWER_MATCH_DEFAULTS,
  PowerAgreementTracker,
  PowerMatch,
  ReferenceWatch,
} from './powermatch'

/** Feeds a steady reference reading for `seconds`, one observation per second. */
function run(
  match: PowerMatch,
  options: {
    from: number
    seconds: number
    targetW: number | null
    referenceW: (t: number) => number | undefined
    stepDurationS?: number
    stepIndex?: number
    onBreak?: boolean
  },
): number {
  let t = options.from
  for (let i = 0; i < options.seconds; i++, t++) {
    match.observe({
      t,
      targetW: options.targetW,
      referenceW: options.referenceW(t),
      stepIndex: options.stepIndex ?? 0,
      stepDurationS: options.stepDurationS ?? 600,
      onBreak: options.onBreak ?? false,
    })
  }
  return t
}

describe('PowerMatch feed-forward', () => {
  it('commands less when the reference meter reads above the machine', () => {
    const match = new PowerMatch()
    // The 14 August session: reference read 4.9% above a commanded 200 W, so
    // the ratio is 1.049 and the multiplier its inverse.
    match.calibrate(1 / 1.049, 0)
    expect(match.command(200)).toBeCloseTo(190.7, 1)
    expect(match.isCalibrated).toBe(true)
    expect(match.currentState).toBe('feedforward')
  })

  it('commands the raw target until it has been calibrated', () => {
    const match = new PowerMatch()
    expect(match.command(200)).toBe(200)
    expect(match.currentState).toBe('uncalibrated')
  })

  it('refuses a multiplier that is not a number, rather than commanding NaN', () => {
    const match = new PowerMatch()
    match.calibrate(Number.NaN, 0)
    match.calibrate(0, 0)
    match.calibrate(-1, 0)
    expect(match.command(200)).toBe(200)
    expect(match.isCalibrated).toBe(false)
  })

  it('clamps a probe result that asks for more than the loop is allowed', () => {
    const match = new PowerMatch()
    match.calibrate(1.5, 0)
    expect(match.factor).toBeCloseTo(1.15, 4)
    const [event] = match.drain()
    expect(event.kind).toBe('calibrated')
    expect(event.data?.clamped).toBe(true)
  })
})

describe('PowerMatch trim', () => {
  it('raises the command when the athlete is producing under target', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    match.drain()
    // Reference sits 5% low for long enough to clear settling and reach the
    // first trim, and no longer: the second would land at t=50.
    run(match, { from: 0, seconds: 40, targetW: 200, referenceW: () => 190 })
    const events = match.drain()
    const trim = events.find((e) => e.kind === 'trim')
    expect(trim).toBeDefined()
    // The 5% error is deliberately not applied in one go.
    expect(trim!.data?.appliedPct).toBeCloseTo(2, 1)
    expect(match.factor).toBeCloseTo(1.02, 3)
  })

  it('lowers the command when the athlete is producing over target', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    run(match, { from: 0, seconds: 40, targetW: 200, referenceW: () => 210 })
    expect(match.factor).toBeLessThan(1)
    expect(match.factor).toBeCloseTo(0.98, 3)
  })

  it('does nothing inside the dead band', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    match.drain()
    run(match, { from: 0, seconds: 120, targetW: 200, referenceW: () => 200.8 })
    expect(match.drain().filter((e) => e.kind === 'trim')).toHaveLength(0)
    expect(match.factor).toBe(1)
  })

  it('never trims faster than the interval', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    match.drain()
    // Five minutes at a steady 5% error: ten intervals, not three hundred.
    run(match, { from: 0, seconds: 300, targetW: 200, referenceW: () => 190 })
    const trims = match.drain().filter((e) => e.kind === 'trim')
    expect(trims.length).toBeLessThanOrEqual(300 / POWER_MATCH_DEFAULTS.trimIntervalS)
    expect(trims.length).toBeGreaterThan(3)
  })

  it('converges on the target instead of oscillating around it', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    // A machine whose delivered power is 5% under whatever it is commanded.
    // The loop should walk the factor to 1/0.95 and stay there.
    let factor = 1
    let t = 0
    for (let i = 0; i < 600; i++, t++) {
      match.observe({
        t,
        targetW: 200,
        referenceW: 200 * factor * 0.95,
        stepIndex: 0,
        stepDurationS: 900,
        onBreak: false,
      })
      factor = match.factor
    }
    expect(200 * factor * 0.95).toBeCloseTo(200, 0)
    expect(factor).toBeLessThan(1.09)
  })

  it('will not exceed the hard clamp however wrong the reference is', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    run(match, { from: 0, seconds: 3000, targetW: 200, referenceW: () => 100 })
    expect(match.factor).toBeCloseTo(1.15, 4)
    const clamped = match.drain().filter((e) => e.kind === 'clamped')
    expect(clamped.length).toBeGreaterThan(0)
    expect(clamped[0].data?.limitPct).toBe(15)
  })

  it('feeds a short step forward but never trims it', () => {
    const match = new PowerMatch()
    match.calibrate(0.95, 0)
    match.drain()
    run(match, { from: 0, seconds: 60, targetW: 200, referenceW: () => 190, stepDurationS: 60 })
    expect(match.drain().filter((e) => e.kind === 'trim')).toHaveLength(0)
    expect(match.currentState).toBe('feedforward')
    expect(match.factor).toBeCloseTo(0.95, 4)
  })

  it('ignores the transient after a target change', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    match.drain()
    // Fifteen seconds of a badly-off reading, then the target changes again.
    run(match, { from: 0, seconds: 15, targetW: 200, referenceW: () => 100 })
    run(match, { from: 15, seconds: 15, targetW: 250, referenceW: () => 100, stepIndex: 1 })
    expect(match.drain().filter((e) => e.kind === 'trim')).toHaveLength(0)
    expect(match.factor).toBe(1)
  })

  it('does not trim during a sampling break', () => {
    const match = new PowerMatch()
    match.calibrate(1, 0)
    match.drain()
    run(match, { from: 0, seconds: 120, targetW: 100, referenceW: () => 60, onBreak: true })
    expect(match.drain().filter((e) => e.kind === 'trim')).toHaveLength(0)
  })
})

describe('PowerMatch when the reference meter goes away', () => {
  it('holds the last factor and says so, rather than reverting', () => {
    const match = new PowerMatch()
    match.calibrate(0.95, 0)
    let t = run(match, { from: 0, seconds: 10, targetW: 200, referenceW: () => 200 })
    match.drain()

    t = run(match, { from: t, seconds: 20, targetW: 200, referenceW: () => undefined })
    expect(match.isHolding).toBe(true)
    expect(match.currentState).toBe('holding')
    // The correction is unchanged: reverting would step the athlete's real load
    // at the exact moment the record can no longer explain it.
    expect(match.command(200)).toBeCloseTo(190, 4)
    const hold = match.drain().find((e) => e.kind === 'hold')
    expect(hold).toBeDefined()
    expect(hold!.factor).toBeCloseTo(0.95, 4)
  })

  it('reports the hold once, not once per second', () => {
    const match = new PowerMatch()
    match.calibrate(0.95, 0)
    let t = run(match, { from: 0, seconds: 10, targetW: 200, referenceW: () => 200 })
    t = run(match, { from: t, seconds: 120, targetW: 200, referenceW: () => undefined })
    expect(match.drain().filter((e) => e.kind === 'hold')).toHaveLength(1)
  })

  it('resumes when the meter comes back', () => {
    const match = new PowerMatch()
    match.calibrate(0.95, 0)
    let t = run(match, { from: 0, seconds: 10, targetW: 200, referenceW: () => 200 })
    t = run(match, { from: t, seconds: 30, targetW: 200, referenceW: () => undefined })
    match.drain()
    run(match, { from: t, seconds: 5, targetW: 200, referenceW: () => 200 })
    expect(match.isHolding).toBe(false)
    expect(match.drain().some((e) => e.kind === 'resume')).toBe(true)
  })

  it('does not hold before the meter has ever reported', () => {
    const match = new PowerMatch()
    run(match, { from: 0, seconds: 60, targetW: 200, referenceW: () => undefined })
    expect(match.isHolding).toBe(false)
  })
})

describe('PowerAgreementTracker', () => {
  it('reports the bias between two sources without averaging them together', () => {
    const tracker = new PowerAgreementTracker()
    for (let t = 0; t < 600; t++) tracker.add(t, 205, 200)
    const agreement = tracker.read()!
    expect(agreement.meanReferenceW).toBeCloseTo(205, 1)
    expect(agreement.meanMachineW).toBeCloseTo(200, 1)
    expect(agreement.biasW).toBeCloseTo(5, 1)
    expect(agreement.biasPct).toBeCloseTo(2.5, 1)
  })

  it('catches a trainer whose reading drifts while the athlete does not', () => {
    // The 14 August pattern: reference falls from +5% to -1% over 50 minutes
    // while the machine holds its own number at the commanded 200 W.
    const tracker = new PowerAgreementTracker()
    for (let t = 0; t < 3000; t++) {
      const pct = 4.9 - (5.6 * t) / 3000
      tracker.add(t, 200 * (1 + pct / 100), 200)
    }
    const agreement = tracker.read()!
    expect(agreement.driftPctPerHour).not.toBeNull()
    // 5.6 points lost over 50 minutes is about 6.7 points per hour.
    expect(agreement.driftPctPerHour!).toBeCloseTo(-6.7, 0)
  })

  it('says nothing rather than guessing from one source', () => {
    const tracker = new PowerAgreementTracker()
    for (let t = 0; t < 600; t++) tracker.add(t, 205, undefined)
    expect(tracker.read()).toBeNull()
  })

  it('ignores coasting, where any two devices agree perfectly', () => {
    const tracker = new PowerAgreementTracker()
    for (let t = 0; t < 300; t++) tracker.add(t, 0, 0)
    expect(tracker.read()).toBeNull()
  })

  it('has no drift figure from a single minute', () => {
    const tracker = new PowerAgreementTracker()
    for (let t = 0; t < 40; t++) tracker.add(t, 205, 200)
    expect(tracker.read()!.driftPctPerHour).toBeNull()
  })
})

describe('ReferenceWatch', () => {
  it('calls a constant 50/50 balance what it is', () => {
    const watch = new ReferenceWatch()
    for (let i = 0; i < 60; i++) watch.observe(50)
    expect(watch.sidedness).toBe('single')
    const { warnings } = watch.verdict({ hasSeparateReference: true, hasZeroOffset: true })
    expect(warnings.join(' ')).toContain('single-sided')
  })

  it('accepts a meter whose balance actually moves', () => {
    const watch = new ReferenceWatch()
    for (let i = 0; i < 60; i++) watch.observe(48 + (i % 5))
    expect(watch.sidedness).toBe('dual')
    expect(watch.verdict({ hasSeparateReference: true, hasZeroOffset: true }).warnings).toEqual([])
  })

  it('says it cannot tell when no balance is reported at all', () => {
    const watch = new ReferenceWatch()
    expect(watch.sidedness).toBe('unknown')
    const { warnings } = watch.verdict({ hasSeparateReference: true, hasZeroOffset: true })
    expect(warnings.join(' ')).toContain('unknown')
  })

  it('warns that a trainer compared with itself proves nothing', () => {
    const watch = new ReferenceWatch()
    const { warnings } = watch.verdict({ hasSeparateReference: false, hasZeroOffset: false })
    expect(warnings.join(' ')).toContain('No second power source')
    expect(warnings.join(' ')).toContain('zero offset')
  })
})
