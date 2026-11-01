import { describe, expect, it } from 'vitest'
import { sessionFilename } from './export'
import { fitFilename } from './fit'
import type { SessionRecord } from './session'

describe('sessionFilename', () => {
  it('names the export by the local start time, as the session folders are', () => {
    // Built from local fields, so the expectation holds in any time zone.
    const startedAt = new Date(2026, 9, 31, 10, 58, 22).getTime()
    const session = { startedAt, protocolName: 'TSI 3 h' } as SessionRecord
    expect(sessionFilename(session, 'research.csv')).toBe('2026-10-31-10-58_tsi-3-h.research.csv')
  })

  it('names the FIT file the same way, not in UTC', () => {
    const startedAt = new Date(2026, 10, 1, 12, 8, 37).getTime()
    const session = { startedAt, protocolName: 'TSI RH response' } as SessionRecord
    expect(fitFilename(session)).toBe('2026-11-01-12-08_tsi-rh-response.fit')
  })
})
