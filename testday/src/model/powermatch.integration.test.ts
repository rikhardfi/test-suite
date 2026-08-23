import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SensorManager } from '../ble/manager'
import { Simulator } from '../ble/simulator'
import { TestRunner } from './session'
import { PowerMatch, agreementFromSamples } from './powermatch'
import { DEFAULT_ATHLETE, makeProtocol } from './protocol'

/**
 * The whole path, end to end, with no test doubles in it.
 *
 * A real `SensorManager` arbitrating two devices, the simulator standing in for
 * a trainer whose own estimate warms upward, and the runner commanding through
 * the same code a real session uses. What is asserted is the thing the feature
 * exists for: that the power the athlete produces ends up at the number the
 * protocol asked for, and stays there for the length of a test.
 */
describe('holding a constant load for fifty minutes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const build = (options: { correct: boolean }) => {
    const manager = new SensorManager()
    const simulator = new Simulator(manager, { ftpWatts: 300, noise: 0, referenceMeter: {} })
    manager.addVirtual(simulator)
    simulator.attachReferenceMeter()
    void simulator.start()

    const protocol = makeProtocol('Cruise', 'bike', [
      { id: 's1', durationS: 3000, target: { mode: 'watts', watts: 200 } },
    ])
    const runner = new TestRunner({
      protocol,
      athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
      readMetrics: () => manager.read(),
      machine: () => manager.machine?.control ?? null,
      powerMatch: options.correct ? new PowerMatch() : undefined,
    })
    return { runner, manager, simulator }
  }

  const advance = async (seconds: number) => {
    for (let i = 0; i < seconds * 5; i++) await vi.advanceTimersByTimeAsync(200)
  }

  it('drifts about six percent when the trainer is trusted, as it did on 14 August', async () => {
    const { runner, simulator } = build({ correct: false })
    runner.start()
    await advance(3000)
    runner.finish()
    void simulator.stop()

    const samples = runner.recordedSamples
    const early = window(samples, 60, 560)
    const late = window(samples, 2400, 2900)

    // The trainer is holding its own number at 200 W throughout, so nothing on
    // screen or in the target column moves.
    expect(mean(late.map((s) => s.powerSecondaryW!))).toBeCloseTo(200, 0)
    expect(new Set(samples.map((s) => s.targetPower))).toEqual(new Set([200]))

    // The athlete's actual power is what falls out from under it.
    expect(mean(early.map((s) => s.power!))).toBeGreaterThan(206)
    expect(mean(late.map((s) => s.power!))).toBeLessThan(200)
    const lost = mean(early.map((s) => s.power!)) - mean(late.map((s) => s.power!))
    expect(lost).toBeGreaterThan(8)

    // And the agreement figures say so, which is the point of recording both.
    const agreement = agreementFromSamples(samples)!
    expect(agreement.driftPctPerHour!).toBeLessThan(-5)
  })

  it('holds the athlete at the target when the loop is closed on the meter', async () => {
    const { runner, simulator } = build({ correct: true })
    runner.start()
    // No probe here on purpose: this is the trim finding the offset on its own,
    // which is the harder case. A probe would have it right from second one.
    await advance(3000)
    runner.finish()
    void simulator.stop()

    const samples = runner.recordedSamples
    const late = window(samples, 2400, 2900)

    // What the athlete produced, which is what the test is measuring.
    //
    // Inside the dead band rather than exactly on it, and deliberately: the
    // loop stops correcting once it is within 1%, because chasing the last
    // watt means adjusting the load continuously and a hunting load is worse
    // for a step test than a small steady offset. At 200 W that is 2 W of
    // permitted residual, against the 12 W the uncorrected case loses.
    const produced = mean(late.map((s) => s.power!))
    expect(Math.abs(produced - 200)).toBeLessThanOrEqual(2)
    // Held there by a command that moved the whole way across the session.
    // Early on the meter reads high and the trainer is told to ask for less;
    // by the end the trainer's own estimate has climbed past the drivetrain
    // loss, the two agree, and almost no correction is called for. The loop
    // followed that, and the protocol's own number never moved.
    const earlyCommand = mean(window(samples, 200, 700).map((s) => s.commandedPower ?? 200))
    const lateCommand = mean(late.map((s) => s.commandedPower ?? 200))
    expect(earlyCommand).toBeLessThan(195)
    expect(lateCommand - earlyCommand).toBeGreaterThan(5)
    expect(mean(late.map((s) => s.targetPower!))).toBe(200)

    // And the athlete never felt any of it: the same load throughout, which is
    // the entire claim being made.
    const producedEarly = mean(window(samples, 200, 700).map((s) => s.power!))
    expect(Math.abs(producedEarly - produced)).toBeLessThan(2)
  })

  it('leaves the record able to explain what it did', async () => {
    const events: string[] = []
    const manager = new SensorManager()
    const simulator = new Simulator(manager, { ftpWatts: 300, noise: 0, referenceMeter: {} })
    manager.addVirtual(simulator)
    simulator.attachReferenceMeter()
    void simulator.start()

    const runner = new TestRunner({
      protocol: makeProtocol('Cruise', 'bike', [
        { id: 's1', durationS: 900, target: { mode: 'watts', watts: 200 } },
      ]),
      athlete: { ...DEFAULT_ATHLETE, ftpWatts: 300 },
      readMetrics: () => manager.read(),
      machine: () => manager.machine?.control ?? null,
      powerMatch: new PowerMatch(),
      onEvent: (kind) => events.push(kind),
    })

    runner.start()
    await advance(300)
    runner.finish()
    void simulator.stop()

    // Two 2% steps take the 4.9% initial bias inside the dead band, and then
    // the loop stops. A trim every interval regardless would be a loop with
    // nothing to do still moving the athlete's load around.
    expect(events.filter((k) => k === 'powerMatchTrim').length).toBe(2)
    for (const sample of runner.recordedSamples.slice(-10)) {
      expect(sample.powerMatchFactor).toBeDefined()
      expect(sample.powerSecondaryW).toBeDefined()
    }
  })
})

const window = <T extends { t: number }>(samples: readonly T[], from: number, to: number): T[] =>
  samples.filter((s) => s.t >= from && s.t < to)

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
