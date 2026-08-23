import type { Sport } from './protocol'
import type { MetricUpdate } from '../ble/types'

/**
 * Whether the machine is live while nothing is being recorded.
 *
 * A treadmill left running with the test paused, or still running after Finish
 * & save, is the one genuinely dangerous state this app can be in: somebody
 * steps onto a moving belt, or reaches across it. It is also easy to miss,
 * because a paused dashboard looks calm. So it is watched for, and said loudly.
 *
 * Raising is deliberate and clearing is quick: a couple of seconds of motion
 * before the alarm appears, so a single stray reading cannot flash it, but the
 * moment the machine actually stops the alarm goes.
 */

/** Belt speed below this is a treadmill at rest rather than one creeping. */
export const MOVING_MS = 0.2
/** Power below this is drivetrain noise, or a rider resting on the pedals. */
export const WORKING_WATTS = 10

export const RAISE_AFTER_MS = 2000
export const CLEAR_AFTER_MS = 500

export function machineIsMoving(sport: Sport, metrics: MetricUpdate): boolean {
  // Per sport, because the thing to watch differs: a belt moves whether or not
  // anyone is on it, while a trainer's flywheel spinning down is not a hazard.
  return sport === 'run'
    ? (metrics.speedMs ?? 0) > MOVING_MS
    : (metrics.power ?? 0) > WORKING_WATTS
}

export interface MotionWatch {
  /** When the machine was first seen moving with nothing being recorded. */
  movingSinceMs: number | null
  /** When it was first seen still again. */
  stillSinceMs: number | null
  alarming: boolean
}

export const NO_MOTION: MotionWatch = {
  movingSinceMs: null,
  stillSinceMs: null,
  alarming: false,
}

export function watchMotion(
  previous: MotionWatch,
  input: { moving: boolean; recording: boolean; nowMs: number },
): MotionWatch {
  // A machine moving while the test runs is the machine doing its job.
  if (input.recording) return NO_MOTION

  if (input.moving) {
    const movingSinceMs = previous.movingSinceMs ?? input.nowMs
    return {
      movingSinceMs,
      stillSinceMs: null,
      alarming: previous.alarming || input.nowMs - movingSinceMs >= RAISE_AFTER_MS,
    }
  }

  const stillSinceMs = previous.stillSinceMs ?? input.nowMs
  return {
    movingSinceMs: null,
    stillSinceMs,
    alarming: previous.alarming && input.nowMs - stillSinceMs < CLEAR_AFTER_MS,
  }
}
