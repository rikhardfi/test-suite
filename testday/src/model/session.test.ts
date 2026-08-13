import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestRunner, lapsFromSamples } from './session'
import { DEFAULT_ATHLETE, buildStepTest, makeProtocol, type Protocol } from './protocol'
import type { MachineControl, MetricUpdate } from '../ble/types'

/** Records every target the runner pushes, so ERG behaviour is observable. */
function recordingMachine() {
  const powerCommands: number[] = []
  const speedCommands: number[] = []
  const control: MachineControl = {
    canSetPower: true,
    canSetSpeed: true,
    canSetIncline: true,
    requestControl: () => Promise.resolve(),
    setTargetPower: (w) => {
      powerCommands.push(w)
      return Promise.resolve()
    },
    setTargetSpeedKph: (k) => {
      speedCommands.push(k)
      return Promise.resolve()
    },
    setTargetInclinePct: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  }
  return { control, powerCommands, speedCommands }
}

const stepProtocol = (): Protocol =>
  makeProtocol(
    'Test',
    'bike',
    buildStepTest({
      startWatts: 200,
      stepWatts: 20,
      stepDurationS: 60,
      stepCount: 3,
      sampleBreakS: 30,
    }),
  )

/** Advances both the fake clock and the fake timers together. */
async function advance(seconds: number): Promise<void> {
  for (let i = 0; i < seconds * 5; i++) {
    await vi.advanceTimersByTimeAsync(200)
  }
}

describe('TestRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const build = (protocol = stepProtocol(), metrics: () => MetricUpdate = () => ({ power: 210, heartRate: 150 })) => {
    const machine = recordingMachine()
    const runner = new TestRunner({
      protocol,
      athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
      readMetrics: metrics,
      machine: () => machine.control,
      now: () => Date.now(),
    })
    return { runner, machine, protocol }
  }

  it('starts idle and reports the first step target', () => {
    const { runner } = build()
    expect(runner.snapshot().state).toBe('idle')
    expect(runner.snapshot().targetPower).toBe(200)
  })

  it('counts down the work phase and then enters the sampling break', async () => {
    const { runner } = build()
    runner.start()

    await advance(30)
    let snapshot = runner.snapshot()
    expect(snapshot.phase).toBe('work')
    expect(snapshot.phaseRemainingS).toBeGreaterThan(28)
    expect(snapshot.phaseRemainingS).toBeLessThan(32)

    await advance(35)
    snapshot = runner.snapshot()
    expect(snapshot.phase).toBe('break')
    expect(snapshot.stepIndex).toBe(0)
    // The break drops to an easy spin rather than holding the step target.
    expect(snapshot.targetPower).toBe(90)

    runner.finish()
  })

  it('advances to the next step after the break', async () => {
    const { runner } = build()
    runner.start()
    await advance(95)
    expect(runner.snapshot().stepIndex).toBe(1)
    expect(runner.snapshot().targetPower).toBe(220)
    runner.finish()
  })

  it('finishes after the last step', async () => {
    const { runner } = build()
    runner.start()
    await advance(3 * 90 + 2)
    expect(runner.snapshot().state).toBe('finished')
  })

  it('records one sample per second', async () => {
    const { runner } = build()
    runner.start()
    await advance(10)
    runner.finish()
    expect(runner.recordedSamples.length).toBeGreaterThanOrEqual(9)
    expect(runner.recordedSamples.length).toBeLessThanOrEqual(11)
    expect(runner.recordedSamples[0]).toMatchObject({ power: 210, heartRate: 150, stepIndex: 0 })
  })

  it('holds the clock while paused', async () => {
    const { runner } = build()
    runner.start()
    await advance(10)
    runner.pause()
    const frozen = runner.snapshot().elapsedS
    await advance(10)
    expect(runner.snapshot().elapsedS).toBeCloseTo(frozen, 5)
    runner.start()
    await advance(5)
    expect(runner.snapshot().elapsedS).toBeGreaterThan(frozen + 4)
    runner.finish()
  })

  it('pushes each new target to the machine exactly once', async () => {
    const { runner, machine } = build()
    runner.start()
    await advance(95)
    runner.finish()
    // 200 W step, 90 W break, then the 220 W step — no repeats in between.
    expect(machine.powerCommands.slice(0, 3)).toEqual([200, 90, 220])
  })

  it('rescales targets when intensity is trimmed', async () => {
    const { runner, machine } = build()
    runner.start()
    await advance(2)
    runner.setIntensity(95)
    await advance(2)
    expect(runner.snapshot().intensityPct).toBe(95)
    expect(machine.powerCommands).toContain(190)
    runner.finish()
  })

  it('skips forward and backward between steps', async () => {
    const { runner } = build()
    runner.start()
    await advance(5)
    runner.nextStep()
    expect(runner.snapshot().stepIndex).toBe(1)
    // The first press of "previous" restarts the current step.
    await advance(10)
    runner.prevStep()
    expect(runner.snapshot().stepIndex).toBe(1)
    runner.prevStep()
    expect(runner.snapshot().stepIndex).toBe(0)
    runner.finish()
  })

  it('catches up across whole steps after a long stall', async () => {
    const { runner } = build()
    runner.start()
    // One 200 s jump spans two complete 90 s steps.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(runner.snapshot().stepIndex).toBe(2)
    runner.finish()
  })

  it('stores at most one lactate value per step', () => {
    const { runner } = build()
    runner.recordLactate({ stepIndex: 0, mmol: 1.8 })
    runner.recordLactate({ stepIndex: 0, mmol: 2.1 })
    runner.recordLactate({ stepIndex: 1, mmol: 3.0 })
    expect(runner.lactateEntries).toHaveLength(2)
    expect(runner.lactateEntries.find((l) => l.stepIndex === 0)?.mmol).toBe(2.1)
  })

  it('drives speed targets for a treadmill protocol', async () => {
    const protocol = makeProtocol('Run', 'run', [
      { id: 's1', durationS: 60, target: { mode: 'speed', kph: 12, inclinePct: 1 } },
      { id: 's2', durationS: 60, target: { mode: 'speed', kph: 13, inclinePct: 1 } },
    ])
    const { runner, machine } = build(protocol)
    runner.start()
    await advance(65)
    expect(machine.speedCommands[0]).toBe(12)
    expect(machine.speedCommands).toContain(13)
    runner.finish()
  })
})

describe('lapsFromSamples', () => {
  it('summarises work-phase samples per step and ignores break samples', () => {
    const protocol = stepProtocol()
    const athlete = { ...DEFAULT_ATHLETE, ftpWatts: 300 }
    const samples = [
      { t: 0, stepIndex: 0, phase: 'work' as const, power: 200, heartRate: 140, cadence: 90 },
      { t: 1, stepIndex: 0, phase: 'work' as const, power: 220, heartRate: 150, cadence: 92 },
      { t: 2, stepIndex: 0, phase: 'break' as const, power: 20, heartRate: 120, cadence: 60 },
      { t: 3, stepIndex: 1, phase: 'work' as const, power: 240, heartRate: 160, cadence: 88 },
    ]
    const laps = lapsFromSamples(samples, protocol, athlete, [{ stepIndex: 0, mmol: 1.9, at: 0 }])

    expect(laps).toHaveLength(3)
    expect(laps[0].avgPower).toBe(210)
    expect(laps[0].maxPower).toBe(220)
    expect(laps[0].avgHeartRate).toBe(145)
    expect(laps[0].lactate).toBe(1.9)
    expect(laps[1].avgPower).toBe(240)
    // A step with no samples reports nulls rather than zeros.
    expect(laps[2].avgPower).toBeNull()
  })
})

/**
 * Resuming has to put the clock back exactly where the recording stopped. Get
 * this wrong and the second half of a test is filed against the wrong steps.
 */
describe('TestRunner resume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const protocol = () =>
    makeProtocol(
      'Step test',
      'bike',
      buildStepTest({
        startWatts: 200,
        stepWatts: 20,
        stepDurationS: 60,
        stepCount: 3,
        sampleBreakS: 30,
      }),
    )

  const runnerFor = (p = protocol(), onSample?: (s: unknown) => void) =>
    new TestRunner({
      protocol: p,
      athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
      readMetrics: () => ({ power: 210, heartRate: 150 }),
      onSample: onSample as never,
    })

  it('restores samples, lactate and the step position, and comes back paused', () => {
    const p = protocol()
    const first = runnerFor(p)
    first.start()
    // Two whole steps are 90 s each with the sampling break, so 200 s lands
    // inside the third step.
    for (let i = 0; i < 200 * 5; i++) vi.advanceTimersByTime(200)
    first.recordLactate({ stepIndex: 0, mmol: 2.4 })
    const record = first.toRecord('session_1')
    first.dispose()

    const second = runnerFor(p)
    second.resumeFrom(record)
    const snapshot = second.snapshot()

    expect(second.recordedSamples).toHaveLength(record.samples.length)
    expect(second.lactateEntries).toHaveLength(1)
    expect(snapshot.state).toBe('paused')
    expect(snapshot.stepIndex).toBe(2)
    expect(Math.round(snapshot.elapsedS)).toBe(record.samples.at(-1)!.t)
  })

  it('does not replay restored samples to the recorder', () => {
    const p = protocol()
    const first = runnerFor(p)
    first.start()
    for (let i = 0; i < 30 * 5; i++) vi.advanceTimersByTime(200)
    const record = first.toRecord('session_1')
    first.dispose()

    const emitted: unknown[] = []
    const second = runnerFor(p, (s) => emitted.push(s))
    second.resumeFrom(record)

    // They are already in the journal; re-emitting would duplicate every one.
    expect(emitted).toHaveLength(0)
  })

  it('continues the sample stream from where it stopped', () => {
    const p = protocol()
    const first = runnerFor(p)
    first.start()
    for (let i = 0; i < 30 * 5; i++) vi.advanceTimersByTime(200)
    const record = first.toRecord('session_1')
    const lastT = record.samples.at(-1)!.t
    first.dispose()

    const emitted: { t: number }[] = []
    const second = runnerFor(p, (s) => emitted.push(s as { t: number }))
    second.resumeFrom(record)
    second.start()
    for (let i = 0; i < 5 * 5; i++) vi.advanceTimersByTime(200)

    expect(emitted[0]!.t).toBeGreaterThan(lastT)
    expect(second.recordedSamples.at(-1)!.t).toBeGreaterThan(lastT)
  })
})
