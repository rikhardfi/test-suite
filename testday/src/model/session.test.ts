import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestRunner, lapsFromSamples } from './session'
import { DEFAULT_ATHLETE, buildStepTest, makeProtocol, type Protocol } from './protocol'
import { computeVo2 } from './vo2'
import { PowerMatch } from './powermatch'
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

  /**
   * The correction under the runner, rather than on its own.
   *
   * These assert the division of labour that makes a corrected session
   * readable: the machine is commanded the corrected figure, and the record
   * keeps the protocol's own number.
   */
  describe('with a power correction', () => {
    const correcting = (options: { referenceRatio: number; multiplier: number }) => {
      const machine = recordingMachine()
      const match = new PowerMatch()
      match.calibrate(options.multiplier, 0)
      const protocol = makeProtocol('Test', 'bike', [
        { id: 's1', durationS: 600, target: { mode: 'watts', watts: 200 } },
      ])
      const runner = new TestRunner({
        protocol,
        athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
        // The trainer holds its own reading at whatever it was told; the meter
        // on the pedals reads that much higher.
        readMetrics: () => {
          const commanded = machine.powerCommands[machine.powerCommands.length - 1] ?? 0
          return { power: commanded * options.referenceRatio, powerSecondaryW: commanded }
        },
        machine: () => machine.control,
        powerMatch: match,
        now: () => Date.now(),
      })
      return { runner, machine, match }
    }

    it('commands the corrected figure and records the protocol target', async () => {
      const { runner, machine } = correcting({ referenceRatio: 1.049, multiplier: 1 / 1.049 })
      runner.start()
      await advance(5)

      // 200 W asked for at the pedals, 191 W commanded to the trainer.
      expect(machine.powerCommands[0]).toBe(191)
      const sample = runner.recordedSamples[runner.recordedSamples.length - 1]
      expect(sample.targetPower).toBe(200)
      expect(sample.commandedPower).toBe(191)
      expect(sample.powerMatchFactor).toBeCloseTo(0.9533, 3)
      // Which is the point of the whole exercise: the athlete is at 200 W.
      expect(sample.power).toBeCloseTo(200, 0)
    })

    it('records both power traces without blending them', async () => {
      const { runner } = correcting({ referenceRatio: 1.05, multiplier: 1 })
      runner.start()
      await advance(5)
      const sample = runner.recordedSamples[runner.recordedSamples.length - 1]
      expect(sample.power).toBeCloseTo(210, 0)
      expect(sample.powerSecondaryW).toBe(200)
    })

    it('puts every move the loop makes into the journal', async () => {
      const machine = recordingMachine()
      const match = new PowerMatch()
      const events: { kind: string; data?: Record<string, unknown> }[] = []
      const protocol = makeProtocol('Test', 'bike', [
        { id: 's1', durationS: 600, target: { mode: 'watts', watts: 200 } },
      ])
      const runner = new TestRunner({
        protocol,
        athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
        // Ten percent under target, and staying there.
        readMetrics: () => ({ power: 180, powerSecondaryW: 200 }),
        machine: () => machine.control,
        powerMatch: match,
        onEvent: (kind, data) => events.push({ kind, data }),
        now: () => Date.now(),
      })

      runner.start()
      await advance(40)
      const trims = events.filter((e) => e.kind === 'powerMatchTrim')
      expect(trims).toHaveLength(1)
      expect(trims[0].data?.referenceMeanW).toBe(180)
      expect(trims[0].data?.targetW).toBe(200)
      expect(machine.powerCommands[machine.powerCommands.length - 1]).toBe(204)
    })

    it('holds the correction and flags the samples when the meter drops out', async () => {
      const machine = recordingMachine()
      const match = new PowerMatch()
      match.calibrate(0.95, 0)
      let meterAlive = true
      const protocol = makeProtocol('Test', 'bike', [
        { id: 's1', durationS: 600, target: { mode: 'watts', watts: 200 } },
      ])
      const runner = new TestRunner({
        protocol,
        athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
        readMetrics: () => (meterAlive ? { power: 200, powerSecondaryW: 190 } : { powerSecondaryW: 190 }),
        machine: () => machine.control,
        powerMatch: match,
        now: () => Date.now(),
      })

      runner.start()
      await advance(5)
      meterAlive = false
      await advance(20)

      const sample = runner.recordedSamples[runner.recordedSamples.length - 1]
      expect(sample.powerMatchHeld).toBe(true)
      // Held, not reverted: the commanded figure has not moved.
      expect(sample.commandedPower).toBe(190)
      expect(new Set(machine.powerCommands)).toEqual(new Set([190]))
    })
  })

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

  it('comes back paused even when the protocol already ran to the end', () => {
    const p = protocol()
    const first = runnerFor(p)
    first.start()
    // 3 steps of 90 s each: 400 s is past the end of the protocol.
    for (let i = 0; i < 400 * 5; i++) vi.advanceTimersByTime(200)
    const record = first.toRecord('session_1')
    first.dispose()

    const second = runnerFor(p)
    second.resumeFrom(record)
    const snapshot = second.snapshot()

    // Finished would be unreopenable: `toggle()` refuses to start a finished
    // runner, so the dashboard's start button would do nothing.
    expect(snapshot.state).toBe('paused')
    expect(snapshot.stepIndex).toBe(p.steps.length - 1)
    second.toggle()
    expect(second.snapshot().state).toBe('running')
  })

  it('comes back paused when there is nothing recorded yet', () => {
    const p = protocol()
    const runner = runnerFor(p)
    runner.resumeFrom({
      id: 'session_empty',
      protocolId: p.id,
      protocolName: p.name,
      sport: p.sport,
      athlete: DEFAULT_ATHLETE,
      startedAt: 1,
      samples: [],
      lactate: [],
    })
    expect(runner.snapshot().state).toBe('paused')
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

describe('what the runner records beyond the obvious', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A treadmill whose readings change from one sample to the next. */
  const runMoving = async (readMetrics: () => MetricUpdate, seconds = 5) => {
    const protocol = makeProtocol('Run', 'run', [
      { id: 'step_1', durationS: 60, target: { mode: 'speed', kph: 12 } },
    ])
    const runner = new TestRunner({
      protocol,
      athlete: DEFAULT_ATHLETE,
      readMetrics,
      now: () => Date.now(),
    })
    runner.start()
    await advance(seconds)
    return [...runner.recordedSamples]
  }

  const runTreadmill = async (metrics: MetricUpdate, inclinePct = 2) => {
    const protocol = makeProtocol('Run', 'run', [
      {
        id: 'step_1',
        name: 'Step 1',
        durationS: 60,
        target: { mode: 'speed', kph: 12, inclinePct },
      },
    ])
    const runner = new TestRunner({
      protocol,
      athlete: { ...DEFAULT_ATHLETE, massKg: 70, economyPct: 100 },
      readMetrics: () => metrics,
      now: () => Date.now(),
    })
    runner.start()
    await advance(3)
    return runner.recordedSamples
  }

  it('prefers the gradient the treadmill reports', async () => {
    const samples = await runTreadmill({ speedMs: 3.33, inclinePct: 1.5 })
    expect(samples[0].inclinePct).toBeCloseTo(1.5, 3)
    expect(samples[0].inclineFromTarget).toBeUndefined()
  })

  /**
   * The case that produced an export with no gradient at all: a machine that
   * sends none. The commanded value is recorded instead, and flagged, so the
   * difference between a measurement and an assumption stays visible.
   */
  it('falls back to the commanded gradient and says so', async () => {
    const samples = await runTreadmill({ speedMs: 3.33 })
    expect(samples[0].inclinePct).toBe(2)
    expect(samples[0].inclineFromTarget).toBe(true)
    expect(samples[0].targetInclinePct).toBe(2)
  })

  it('prefers the machine odometer over integrating speed', async () => {
    const samples = await runTreadmill({ speedMs: 3, distanceM: 500 })
    expect(samples[0].distanceIntegrated).toBeUndefined()
  })

  /**
   * The belt is nearly always already rolling when a test starts, so the
   * treadmill's odometer arrives with a warm-up on it. Reported as it stands it
   * put 0.1 km on the dashboard at 0:00, and 0.1 km into the exported FIT.
   */
  it('starts the distance at zero however far the machine has already run', async () => {
    let odometer = 92
    const samples = await runMoving(() => ({ speedMs: 3, distanceM: (odometer += 3) }))
    expect(samples[0].distanceM).toBe(0)
    expect(samples[1].distanceM).toBeCloseTo(3, 1)
    expect(samples[2].distanceM).toBeCloseTo(6, 1)
  })

  /**
   * Zeroing the machine mid-test must not take the session's distance with it.
   * The odometer is a difference from where it was, and the difference simply
   * re-anchors.
   */
  it('carries the distance on when the machine odometer is zeroed mid-test', async () => {
    let odometer = 500
    const samples = await runMoving(() => {
      // Zeroed on the third reading, then counting up again from nothing.
      odometer = odometer >= 506 ? 0 : odometer + 3
      return { speedMs: 3, distanceM: odometer }
    })
    const distances = samples.map((s) => s.distanceM!)
    expect(distances[0]).toBe(0)
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1])
    }
  })

  it('integrates distance when the machine reports none, and flags it', async () => {
    const samples = await runTreadmill({ speedMs: 3 })
    expect(samples[0].distanceIntegrated).toBe(true)
    // One sample per second at 3 m/s, starting from the first recorded second.
    expect(samples[1].distanceM).toBeCloseTo(samples[0].distanceM! + 3, 1)
  })

  it('stamps a running VO₂ estimate with the equation that produced it', async () => {
    const samples = await runTreadmill({ speedMs: 12 / 3.6, inclinePct: 2 })
    expect(samples[0].vo2Method).toBe('acsmRun')
    expect(samples[0].vo2Est).toBeCloseTo(computeVo2(12, 2).vo2, 1)
  })

  it('stamps a cycling VO₂ estimate from power', async () => {
    const { runner } = (() => {
      const protocol = stepProtocol()
      const r = new TestRunner({
        protocol,
        athlete: { ...DEFAULT_ATHLETE, massKg: 75 },
        readMetrics: () => ({ power: 200 }),
        now: () => Date.now(),
      })
      return { runner: r }
    })()
    runner.start()
    await advance(2)
    expect(runner.recordedSamples[0].vo2Method).toBe('acsmBike')
    expect(runner.recordedSamples[0].vo2Est).toBeCloseTo(35.8, 1)
  })

  /** No speed and no power is a missing sensor, not a resting athlete. */
  it('records no VO₂ estimate when there is nothing to estimate from', async () => {
    const samples = await runTreadmill({ heartRate: 140 })
    expect(samples[0].vo2Est).toBeUndefined()
    expect(samples[0].vo2Method).toBeUndefined()
  })

  it('picks the odometer back up where a resumed session left it', async () => {
    // Copied, because `recordedSamples` hands back the runner's live array and
    // that runner is still ticking under the fake clock.
    const samples = [...(await runTreadmill({ speedMs: 3 }))]
    const protocol = makeProtocol('Run', 'run', [
      { id: 'step_1', durationS: 60, target: { mode: 'speed', kph: 12 } },
    ])
    const resumed = new TestRunner({
      protocol,
      athlete: DEFAULT_ATHLETE,
      readMetrics: () => ({ speedMs: 3 }),
      now: () => Date.now(),
    })
    resumed.resumeFrom({
      id: 's',
      protocolId: protocol.id,
      protocolName: 'Run',
      sport: 'run',
      athlete: DEFAULT_ATHLETE,
      startedAt: Date.now(),
      samples: [...samples],
      lactate: [],
    })
    resumed.start()
    await advance(2)
    const next = resumed.recordedSamples[samples.length]
    expect(next.distanceM).toBeGreaterThan(samples[samples.length - 1].distanceM!)
  })
})

describe('the protocol as executed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const withEvents = () => {
    const events: { kind: string; data?: Record<string, number | string | boolean> }[] = []
    const runner = new TestRunner({
      protocol: stepProtocol(),
      athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
      readMetrics: () => ({ power: 210 }),
      now: () => Date.now(),
      onEvent: (kind, data) => events.push({ kind, data }),
    })
    return { runner, events }
  }

  it('distinguishes the first start from a resume', async () => {
    const { runner, events } = withEvents()
    runner.start()
    await advance(2)
    runner.pause()
    runner.start()
    expect(events.map((e) => e.kind)).toEqual(['start', 'pause', 'resume'])
  })

  /**
   * Without this the watchdog cannot tell a deliberately paused test from a
   * recording that has silently stopped producing samples.
   */
  it('reports a pause with where it happened', async () => {
    const { runner, events } = withEvents()
    runner.start()
    await advance(5)
    runner.pause()
    const pause = events.find((e) => e.kind === 'pause')
    expect(pause?.data?.elapsedS).toBeGreaterThanOrEqual(4)
  })

  it('records a step jump and the intensity trim', async () => {
    const { runner, events } = withEvents()
    runner.start()
    runner.jumpTo(2)
    runner.adjustIntensity(-3)
    expect(events.find((e) => e.kind === 'jump')?.data?.stepIndex).toBe(2)
    expect(events.find((e) => e.kind === 'intensity')?.data?.pct).toBe(97)
  })

  /** A trim that changes nothing is not a thing that happened. */
  it('says nothing when the intensity is set to what it already is', () => {
    const { runner, events } = withEvents()
    runner.setIntensity(100)
    expect(events.filter((e) => e.kind === 'intensity')).toHaveLength(0)
  })

  it('reports the stop when a running test is finished', async () => {
    const { runner, events } = withEvents()
    runner.start()
    await advance(2)
    runner.finish()
    expect(events.filter((e) => e.kind === 'pause')).toHaveLength(1)
  })
})
