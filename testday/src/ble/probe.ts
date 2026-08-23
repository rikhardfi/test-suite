import type { MachineControl } from './types'

/**
 * Thirty seconds in the warm-up that answer two questions.
 *
 * **Is the trainer actually listening?** The ERG failure that costs a test is
 * the silent one: the app writes a target, the machine acknowledges it, and the
 * power arrives late, arrives low, or never arrives at all. From the app's side
 * the command succeeded, so nothing reports an error and the first sign of
 * trouble is a flat trace at step four with an athlete already committed.
 * Commanding two known set-points and watching what happens is the only way to
 * know, and it costs thirty seconds against a whole test.
 *
 * **By how much does it lie?** Where a separate reference meter is paired, the
 * same two set-points measure the ratio between what the athlete produces and
 * what the machine believes it is absorbing. That ratio is the feed-forward
 * multiplier `model/powermatch.ts` applies for the rest of the session, and
 * measuring it here rather than chasing it later is what lets a sixty-second
 * ramp step be correct from its first second.
 *
 * Nothing here interprets a missing reading as a zero. A set-point the machine
 * never reached reports a null time-to-target and fails the probe, which is a
 * different statement from having reached it slowly.
 */

export interface ProbeSetpoint {
  targetW: number
  /** Time to first reach 90% of target. Null when it never did. */
  timeTo90PctS: number | null
  /** Machine's own reading over the steady window. */
  steadyMachineW: number | null
  /** Reference meter over the same window, when one is paired. */
  steadyReferenceW: number | null
  /** Machine reading against what it was told to do. */
  machineErrorPct: number | null
  /** Reference over machine: drivetrain loss plus whatever the two disagree by. */
  ratio: number | null
}

export interface TrainerResponse {
  /** Wall clock, so the result can be compared across test days. */
  at: number
  setpoints: ProbeSetpoint[]
  /**
   * What to multiply a commanded target by so the reference meter reads the
   * protocol's number. Null when no separate reference was paired, which is not
   * a failure: it means the question could not be asked.
   */
  multiplier: number | null
  /** True when a second device supplied power throughout. */
  hasReference: boolean
  /** False when any set-point was not reached, or was reached badly. */
  ok: boolean
  /** Why it failed, in one sentence fit to show an operator. */
  failure?: string
}

export interface ProbeOptions {
  control: MachineControl
  /**
   * Live power, split by role. `machineW` is the controllable device's own
   * reading; `referenceW` is the meter being trusted. Equal when only one
   * device is paired, which the caller reports by leaving `machineW` undefined.
   */
  read: () => { referenceW?: number; machineW?: number }
  /** Two by default: one easy, one near the bottom of a test's range. */
  setpointsW?: number[]
  /** How long to wait for each set-point before giving up on it. */
  holdS?: number
  /** Window at the end of each hold that the steady figures come from. */
  steadyS?: number
  /** Worst machine-versus-commanded error that still counts as responding. */
  tolerancePct?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onProgress?: (message: string) => void
}

const DEFAULT_SETPOINTS = [100, 180]
const POLL_MS = 250

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runErgProbe(options: ProbeOptions): Promise<TrainerResponse> {
  const {
    control,
    read,
    setpointsW = DEFAULT_SETPOINTS,
    holdS = 15,
    steadyS = 5,
    tolerancePct = 10,
    sleep = defaultSleep,
    now = () => Date.now(),
    onProgress,
  } = options

  const at = now()
  const results: ProbeSetpoint[] = []
  let sawReference = false
  let failure: string | undefined

  if (!control.canSetPower) {
    return {
      at,
      setpoints: [],
      multiplier: null,
      hasReference: false,
      ok: false,
      failure: 'This machine does not accept power targets, so ERG cannot be probed.',
    }
  }

  try {
    await control.requestControl()
  } catch (error) {
    return {
      at,
      setpoints: [],
      multiplier: null,
      hasReference: false,
      ok: false,
      failure: `The machine refused control: ${message(error)}`,
    }
  }

  for (const targetW of setpointsW) {
    onProgress?.(`Holding ${targetW} W`)
    try {
      await control.setTargetPower(targetW)
    } catch (error) {
      failure ??= `The machine rejected ${targetW} W: ${message(error)}`
      results.push(empty(targetW))
      continue
    }

    const started = now()
    const steadyFrom = holdS - steadyS
    let reached: number | null = null
    const machine: number[] = []
    const reference: number[] = []

    for (;;) {
      await sleep(POLL_MS)
      const elapsedS = (now() - started) / 1000
      if (elapsedS >= holdS) break

      const { referenceW, machineW } = read()
      // Where only one device reports power it is the machine's own figure that
      // is missing, not the athlete's: a lone power meter still answers "did
      // the power arrive", it just cannot answer "does the machine agree".
      const observed = machineW ?? referenceW
      if (observed != null && reached === null && observed >= targetW * 0.9) {
        reached = Number(elapsedS.toFixed(1))
      }
      if (elapsedS >= steadyFrom) {
        if (machineW != null) machine.push(machineW)
        if (referenceW != null) reference.push(referenceW)
      }
      if (referenceW != null && machineW != null) sawReference = true
    }

    const steadyMachineW = machine.length ? round1(mean(machine)) : null
    const steadyReferenceW = reference.length ? round1(mean(reference)) : null
    const machineErrorPct =
      steadyMachineW == null ? null : round2(((steadyMachineW - targetW) / targetW) * 100)
    const ratio =
      steadyMachineW != null && steadyReferenceW != null && steadyMachineW > 0
        ? Number((steadyReferenceW / steadyMachineW).toFixed(4))
        : null

    results.push({
      targetW,
      timeTo90PctS: reached,
      steadyMachineW,
      steadyReferenceW,
      machineErrorPct,
      ratio,
    })

    if (reached === null) {
      failure ??= `Commanded ${targetW} W and the power never got within 10% of it. Check that nothing else is holding the trainer, and that the athlete is pedalling.`
    } else if (machineErrorPct != null && Math.abs(machineErrorPct) > tolerancePct) {
      failure ??= `Commanded ${targetW} W and the machine settled at ${steadyMachineW} W, which is ${machineErrorPct.toFixed(1)}% out.`
    }
  }

  const ratios = results.map((r) => r.ratio).filter((r): r is number => r != null)
  // The multiplier is the inverse of the ratio: the reference reads high, so
  // the machine is told to ask for less. Averaged across the set-points, which
  // also means a wildly non-linear pair shows up as a multiplier that suits
  // neither rather than one that silently suits the last one measured.
  const multiplier = ratios.length
    ? Number((1 / (ratios.reduce((s, r) => s + r, 0) / ratios.length)).toFixed(4))
    : null

  return {
    at,
    setpoints: results,
    multiplier,
    hasReference: sawReference,
    ok: !failure,
    failure,
  }
}

/** A one-line summary fit for the sensor panel and the session record. */
export function describeProbe(probe: TrainerResponse): string {
  if (!probe.ok) return probe.failure ?? 'ERG probe failed.'
  const times = probe.setpoints
    .map((s) => (s.timeTo90PctS == null ? '?' : `${s.timeTo90PctS.toFixed(1)} s`))
    .join(', ')
  if (probe.multiplier == null) {
    return `Trainer responded (${times}). No second power source, so no correction was measured.`
  }
  const pct = (probe.multiplier - 1) * 100
  return `Trainer responded (${times}). Reference meter reads ${Math.abs(pct).toFixed(1)}% ${
    pct < 0 ? 'above' : 'below'
  } the machine, so targets will be commanded ${pct < 0 ? 'lower' : 'higher'} by that much.`
}

const empty = (targetW: number): ProbeSetpoint => ({
  targetW,
  timeTo90PctS: null,
  steadyMachineW: null,
  steadyReferenceW: null,
  machineErrorPct: null,
  ratio: null,
})

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
const round1 = (n: number): number => Number(n.toFixed(1))
const round2 = (n: number): number => Number(n.toFixed(2))
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
