import { createFileRecorder } from './recorder.file'
import { createIdbRecorder } from './recorder.idb'
import type { Recorder } from './recorder'

/** True when running inside the desktop shell, where recordings become files. */
export const isDesktop = (): boolean => typeof window !== 'undefined' && !!window.testday

/**
 * One recorder per app. Feature detection rather than a build flag, so the same
 * bundle runs in the desktop shell and in a browser.
 */
export function createRecorder(): Recorder {
  const bridge = typeof window === 'undefined' ? undefined : window.testday
  return bridge ? createFileRecorder(bridge) : createIdbRecorder()
}
