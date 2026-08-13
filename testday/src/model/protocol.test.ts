import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ATHLETE,
  buildIntervals,
  buildStepTest,
  makeProtocol,
  newId,
  numberRepeats,
  planPowerSeries,
  planSpeedSeries,
  recoveryLabel,
  recoveryWatts,
  repeatBlock,
  stepInclinePct,
  stepLabel,
  targetKphAt,
  targetVo2At,
  type Step,
} from './protocol'
import { computeVo2 } from './vo2'

const step = (over: Partial<Step> = {}): Step => ({
  id: newId('step'),
  durationS: 60,
  target: { mode: 'watts', watts: 200 },
  ...over,
})

describe('recovery power', () => {
  it('falls back to 30% of threshold, which is what the runner used to hardcode', () => {
    const protocol = makeProtocol('P', 'bike', [step()])
    expect(recoveryWatts(protocol.steps[0], protocol, 300)).toBe(90)
  })

  it('uses the protocol setting when there is one', () => {
    const protocol = makeProtocol('P', 'bike', [step()], undefined, { mode: 'ftp', pctFtp: 45 })
    expect(recoveryWatts(protocol.steps[0], protocol, 300)).toBe(135)
  })

  it('lets a single step override the protocol', () => {
    const protocol = makeProtocol(
      'P',
      'bike',
      [step(), step({ recoveryTarget: { mode: 'watts', watts: 100 } })],
      undefined,
      { mode: 'ftp', pctFtp: 45 },
    )
    expect(recoveryWatts(protocol.steps[0], protocol, 300)).toBe(135)
    expect(recoveryWatts(protocol.steps[1], protocol, 300)).toBe(100)
  })

  it('never returns a negative target', () => {
    const protocol = makeProtocol('P', 'bike', [step()], undefined, { mode: 'watts', watts: -50 })
    expect(recoveryWatts(protocol.steps[0], protocol, 300)).toBe(0)
  })

  it('labels a target both ways', () => {
    expect(recoveryLabel({ mode: 'watts', watts: 120 }, 300)).toBe('120 W')
    expect(recoveryLabel({ mode: 'ftp', pctFtp: 45 }, 300)).toBe('135 W (45%)')
  })

  it('holds the recovery target through a sampling break in the plan trace', () => {
    const protocol = makeProtocol(
      'P',
      'bike',
      [step({ durationS: 3, recoveryS: 2 })],
      undefined,
      { mode: 'watts', watts: 110 },
    )
    expect(planPowerSeries(protocol, 300)).toEqual([200, 200, 200, 110, 110])
  })

  it('leaves an uncontrolled step at zero during its break', () => {
    const protocol = makeProtocol('P', 'bike', [
      step({ durationS: 2, recoveryS: 2, target: { mode: 'free' } }),
    ])
    expect(planPowerSeries(protocol, 300)).toEqual([0, 0, 0, 0])
  })
})

describe('repeating a block', () => {
  const block = [step({ name: 'Work', durationS: 240 }), step({ name: 'Rest', durationS: 120 })]

  it('copies the block the requested number of times', () => {
    expect(repeatBlock(block, 3)).toHaveLength(6)
  })

  it('gives every copy a fresh id', () => {
    const out = repeatBlock(block, 4)
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length)
  })

  it('does not let copies share a target object', () => {
    const out = repeatBlock(block, 2)
    expect(out[0].target).not.toBe(out[2].target)
    expect(out[0].target).toEqual(out[2].target)
  })

  it('treats a count below one as one', () => {
    expect(repeatBlock(block, 0)).toHaveLength(2)
    expect(repeatBlock(block, -3)).toHaveLength(2)
  })

  it('numbers repeats so the lap table can be read', () => {
    const out = numberRepeats([step({ name: '4 min' })], 3)
    expect(out.map((s) => s.name)).toEqual(['4 min 1/3', '4 min 2/3', '4 min 3/3'])
  })

  it('leaves a single repetition unnumbered', () => {
    expect(numberRepeats([step({ name: '4 min' })], 1)[0].name).toBe('4 min')
  })
})

describe('interval builder', () => {
  const options = {
    reps: 4,
    onDurationS: 240,
    onTarget: { mode: 'ftp' as const, pctFtp: 105 },
    offDurationS: 120,
    offTarget: { mode: 'ftp' as const, pctFtp: 45 },
  }

  it('writes reps and rests, but never a trailing rest', () => {
    const steps = buildIntervals(options)
    // 4 reps and 3 rests: the session ends on work, not on an easy spin.
    expect(steps).toHaveLength(7)
    expect(steps.at(-1)?.name).toBe('Interval 4/4')
  })

  it('omits rests entirely when the rest is zero', () => {
    expect(buildIntervals({ ...options, offDurationS: 0 })).toHaveLength(4)
  })

  it('expands sets and puts a recovery between them', () => {
    const steps = buildIntervals({ ...options, reps: 2, sets: 3, setRecoveryS: 300 })
    // Per set: 2 reps + 1 rest = 3; plus 2 set recoveries; the final rest of the
    // final set is dropped.
    expect(steps.filter((s) => s.name?.startsWith('Set recovery'))).toHaveLength(2)
    expect(steps.at(-1)?.name).toBe('Interval 3.2')
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length)
  })

  it('labels reps by set when there is more than one set', () => {
    const steps = buildIntervals({ ...options, reps: 2, sets: 2 })
    expect(steps[0].name).toBe('Interval 1.1')
    expect(steps.map((s) => s.name)).toContain('Interval 2.1')
  })
})

describe('VO2 targets', () => {
  const vo2Step = step({
    name: 'VT2',
    durationS: 300,
    target: { mode: 'vo2', vo2: 52, inclinePct: 1 },
  })

  it('solves the treadmill speed from the target', () => {
    const kph = targetKphAt(vo2Step, 0)
    expect(kph).not.toBeNull()
    // Round-trips back through the equation to the prescribed cost.
    expect(computeVo2(kph!, 1).vo2).toBeCloseTo(52, 1)
  })

  it('gives a more economical runner a higher speed for the same VO2', () => {
    const typical = targetKphAt(vo2Step, 0, 100)!
    const economical = targetKphAt(vo2Step, 0, 90)!
    expect(economical).toBeGreaterThan(typical)
  })

  it('interpolates a VO2 ramp across the step', () => {
    const ramp = step({ durationS: 100, target: { mode: 'vo2', vo2: 40, toVo2: 60 } })
    expect(targetVo2At(ramp, 0)).toBeCloseTo(40, 6)
    expect(targetVo2At(ramp, 50)).toBeCloseTo(50, 6)
    expect(targetVo2At(ramp, 100)).toBeCloseTo(60, 6)
  })

  it('reports no VO2 target for a speed step', () => {
    expect(targetVo2At(step({ target: { mode: 'speed', kph: 12 } }), 0)).toBeNull()
  })

  it('exposes the gradient for both treadmill modes', () => {
    expect(stepInclinePct(vo2Step)).toBe(1)
    expect(stepInclinePct(step({ target: { mode: 'speed', kph: 12, inclinePct: 2 } }))).toBe(2)
    expect(stepInclinePct(step())).toBeNull()
  })

  it('shows the solved speed in the label, because that is what the machine gets', () => {
    expect(stepLabel(vo2Step, 300)).toMatch(/^VO₂ 52 \(1[0-9]\.[0-9] km\/h\)$/)
  })

  it('drives the plan speed series', () => {
    const protocol = makeProtocol('Run', 'run', [
      step({ durationS: 3, target: { mode: 'vo2', vo2: 45, inclinePct: 0 } }),
    ])
    const series = planSpeedSeries(protocol)
    expect(series).toHaveLength(3)
    expect(series[0]).toBeGreaterThan(0)
  })
})

describe('existing builders still hold', () => {
  it('builds a step test with breaks intact', () => {
    const steps = buildStepTest({
      startWatts: 200,
      stepWatts: 20,
      stepDurationS: 480,
      stepCount: 5,
      sampleBreakS: 30,
    })
    expect(steps).toHaveLength(5)
    expect(steps.every((s) => s.recoveryS === 30 && s.lactateSample)).toBe(true)
    expect(stepLabel(steps[4], DEFAULT_ATHLETE.ftpWatts)).toBe('280 W')
  })
})
