import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SensorManager } from '../ble/manager'
import type { SensorDevice, MetricUpdate } from '../ble/types'
import type { RunnerSnapshot, TestRunner } from '../model/session'

export function useSensorDevices(manager: SensorManager): SensorDevice[] {
  return useSyncExternalStore(
    (fn) => manager.subscribe(fn),
    () => manager.devices,
    () => manager.devices,
  )
}

/** Live values, polled rather than pushed so a chatty sensor cannot flood React. */
export function useLiveMetrics(manager: SensorManager, hz = 4): MetricUpdate {
  const [metrics, setMetrics] = useState<MetricUpdate>({})
  useEffect(() => {
    const id = setInterval(() => setMetrics(manager.read()), 1000 / hz)
    return () => clearInterval(id)
  }, [manager, hz])
  return metrics
}

export function useRunnerSnapshot(runner: TestRunner): RunnerSnapshot {
  return useSyncExternalStore(
    (fn) => runner.subscribe(fn),
    () => runner.snapshot(),
    () => runner.snapshot(),
  )
}

/**
 * Canvas sized to its container in device pixels, so charts stay sharp on
 * retina displays and re-render when the layout changes.
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  deps: unknown[],
): React.RefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width: Math.floor(width), height: Math.floor(height) })
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0 || size.height === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    drawRef.current(ctx, size.width, size.height)
    // `deps` is the caller's own dependency list, forwarded verbatim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height, ...deps])

  return ref
}

/** Keyboard shortcuts for the operator running the test. */
export function useHotkeys(handlers: Record<string, () => void>): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const handler = ref.current[event.key]
      if (handler) {
        event.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Full screen for this window, and whether it is on.
 *
 * Two things happen: the navigation bar goes, and the window is asked to take
 * the whole display. The first is ours and always works. The second is the
 * browser's to grant, and it may refuse; the button still has to do something
 * and still has to undo it. Esc leaves full screen without asking us, so the
 * flag follows the document out.
 */
export function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(() => document.fullscreenElement != null)
  useEffect(() => {
    const sync = () => {
      if (document.fullscreenElement == null) setOn(false)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('fullscreen', on)
    return () => document.documentElement.classList.remove('fullscreen')
  }, [on])
  const toggle = () => {
    setOn(!on)
    if (on) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    } else {
      void document.documentElement.requestFullscreen().catch(() => {})
    }
  }
  return [on, toggle]
}
