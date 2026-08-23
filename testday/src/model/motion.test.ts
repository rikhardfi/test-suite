import { describe, expect, it } from 'vitest'
import {
  CLEAR_AFTER_MS,
  NO_MOTION,
  RAISE_AFTER_MS,
  machineIsMoving,
  watchMotion,
  type MotionWatch,
} from './motion'

/** Feeds a sequence of (moving, recording) ticks a second apart. */
function run(steps: { moving: boolean; recording?: boolean; afterMs?: number }[]): MotionWatch {
  let state = NO_MOTION
  let nowMs = 0
  for (const step of steps) {
    nowMs += step.afterMs ?? 1000
    state = watchMotion(state, { moving: step.moving, recording: step.recording ?? false, nowMs })
  }
  return state
}

describe('machineIsMoving', () => {
  it('watches the belt on a treadmill and the watts on a bike', () => {
    expect(machineIsMoving('run', { speedMs: 2 })).toBe(true)
    expect(machineIsMoving('run', { speedMs: 0 })).toBe(false)
    expect(machineIsMoving('bike', { power: 120 })).toBe(true)
    expect(machineIsMoving('bike', { power: 0 })).toBe(false)
  })

  it('does not call a spinning-down flywheel a moving bike', () => {
    expect(machineIsMoving('bike', { speedMs: 8, power: 0 })).toBe(false)
  })

  it('does not alarm on a treadmill creeping or a rider resting on the pedals', () => {
    expect(machineIsMoving('run', { speedMs: 0.1 })).toBe(false)
    expect(machineIsMoving('bike', { power: 4 })).toBe(false)
  })

  it('says nothing when there is no reading at all', () => {
    expect(machineIsMoving('run', {})).toBe(false)
    expect(machineIsMoving('bike', {})).toBe(false)
  })
})

describe('watchMotion', () => {
  it('stays quiet while the test is running', () => {
    expect(run([{ moving: true, recording: true }, { moving: true, recording: true }]).alarming).toBe(
      false,
    )
  })

  it('does not flash on a single stray reading', () => {
    expect(run([{ moving: true }, { moving: false }]).alarming).toBe(false)
  })

  it('raises once the machine has been moving for a couple of seconds', () => {
    const state = run([{ moving: true }, { moving: true }, { moving: true }])
    expect(state.alarming).toBe(true)
    expect(RAISE_AFTER_MS).toBeLessThanOrEqual(3000)
  })

  it('clears as soon as the machine actually stops', () => {
    const raised = run([{ moving: true }, { moving: true }, { moving: true }])
    expect(raised.alarming).toBe(true)
    const stopping = watchMotion(raised, { moving: false, recording: false, nowMs: 3000 })
    const cleared = watchMotion(stopping, {
      moving: false,
      recording: false,
      nowMs: 3000 + CLEAR_AFTER_MS,
    })
    expect(cleared.alarming).toBe(false)
  })

  it('keeps alarming through a dropped reading rather than blinking off', () => {
    const raised = run([{ moving: true }, { moving: true }, { moving: true }])
    const blip = watchMotion(raised, { moving: false, recording: false, nowMs: 3100 })
    expect(blip.alarming).toBe(true)
  })

  it('goes quiet the moment the test is started', () => {
    const raised = run([{ moving: true }, { moving: true }, { moving: true }])
    expect(watchMotion(raised, { moving: true, recording: true, nowMs: 4000 }).alarming).toBe(false)
  })

  it('raises again after a test is finished with the machine still running', () => {
    let state = run([{ moving: true, recording: true }, { moving: true, recording: true }])
    for (const nowMs of [3000, 4000, 5000, 6000]) {
      state = watchMotion(state, { moving: true, recording: false, nowMs })
    }
    expect(state.alarming).toBe(true)
  })
})
