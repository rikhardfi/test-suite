import { useEffect, useRef, useState } from 'react'
import type { MetricUpdate } from '../ble/types'
import type { CriticalPowerResult } from '../model/analysis'
import type { Athlete, Protocol } from '../model/protocol'
import type { Environment, RunnerSnapshot, Sample } from '../model/session'

/**
 * The athlete's screen: a second window that only displays.
 *
 * The test runs in one window. The runner, the sensors and the recording all
 * live there, and a second controller would be a second thing that could stop a
 * treadmill. So the athlete window holds no runner and sends no commands: the
 * operator window tells it what to draw, over a BroadcastChannel, and the only
 * thing it ever says back is that it has just opened and needs the whole
 * record.
 *
 * Samples go across as they are recorded rather than as the whole array every
 * tick, because an hour's test is 3600 of them and the feed runs four times a
 * second.
 */

const CHANNEL = 'testday-athlete'
export const ATHLETE_HASH = '#athlete'

export const isAthleteWindow = (): boolean => window.location.hash === ATHLETE_HASH

/** Opens the athlete window, or brings the one already open to the front. */
export function openAthleteWindow(): void {
  const url = `${window.location.href.split('#')[0]}${ATHLETE_HASH}`
  window.open(url, 'testday-athlete', 'popup,width=1280,height=800')?.focus()
}

/** Everything the athlete window draws from, except the samples. */
export interface AthleteView {
  protocol: Protocol
  athlete: Athlete
  snapshot: RunnerSnapshot
  metrics: MetricUpdate
  /** The operator's front-face tiles, so both screens show the same numbers. */
  tiles: string[]
  fitY: boolean
  cp: CriticalPowerResult | null
  rr: readonly number[]
  conditions?: Environment | null
}

interface Frame extends AthleteView {
  kind: 'frame'
  /** Index of the first sample carried here. Zero means: replace what you hold. */
  from: number
  samples: Sample[]
}

type Message = Frame | { kind: 'hello' }

/**
 * Where a frame lands in the record the athlete window already holds. Exported
 * for the test: this is the whole protocol, and a gap that was papered over
 * would be a graph with a minute missing and nothing to show it.
 */
export function applyFrame(held: readonly Sample[], from: number, incoming: readonly Sample[]): Sample[] | null {
  if (from === 0) return [...incoming]
  if (from === held.length) return incoming.length ? [...held, ...incoming] : (held as Sample[])
  return null
}

/** Operator side. Call on every render of the dashboard; it posts when something changed. */
export function useAthleteFeed(view: AthleteView, samples: readonly Sample[]): void {
  const channel = useRef<BroadcastChannel | null>(null)
  const sent = useRef(0)

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const bc = new BroadcastChannel(CHANNEL)
    channel.current = bc
    bc.onmessage = (event: MessageEvent<Message>) => {
      // A window that has just opened holds nothing: start it from the top.
      if (event.data.kind === 'hello') sent.current = 0
    }
    return () => {
      bc.close()
      channel.current = null
    }
  }, [])

  useEffect(() => {
    // A new test starts a new record, shorter than what was already sent.
    if (sent.current > samples.length) sent.current = 0
    const frame: Frame = { kind: 'frame', ...view, from: sent.current, samples: samples.slice(sent.current) }
    channel.current?.postMessage(frame)
    sent.current = samples.length
    // Driven by the same ticks that redraw the operator's own tiles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.metrics, view.snapshot, samples.length, view.tiles, view.fitY, view.protocol])
}

/** Athlete side. Null until the operator window has spoken. */
export function useAthleteFrames(): { view: AthleteView; samples: readonly Sample[] } | null {
  const [state, setState] = useState<{ view: AthleteView; samples: readonly Sample[] } | null>(null)
  const held = useRef<readonly Sample[]>([])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const bc = new BroadcastChannel(CHANNEL)
    const hello = () => bc.postMessage({ kind: 'hello' } satisfies Message)
    bc.onmessage = (event: MessageEvent<Message>) => {
      if (event.data.kind !== 'frame') return
      const { kind: _kind, from, samples, ...view } = event.data
      const next = applyFrame(held.current, from, samples)
      if (next === null) return hello()
      held.current = next
      setState({ view, samples: next })
    }
    hello()
    return () => bc.close()
  }, [])

  return state
}
