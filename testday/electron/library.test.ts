import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Library, PREFERENCES_FILE, PROTOCOLS_FILE } from './library'
import type { Protocol } from '../src/model/protocol'

const protocol = (id: string, name = id): Protocol => ({
  id,
  name,
  sport: 'bike',
  steps: [{ id: 'step_1', durationS: 480, target: { mode: 'ftp', pctFtp: 75 } }],
  createdAt: 1,
  updatedAt: 2,
})

describe('Library', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'testday-library-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads back what it wrote', () => {
    const library = new Library(root)
    library.writeProtocols([protocol('p1', 'Kläbo special'), protocol('p2', 'Cruise control')])

    expect(new Library(root).readProtocols().map((p) => p.name)).toEqual([
      'Kläbo special',
      'Cruise control',
    ])
  })

  it('starts empty rather than throwing when there is no file yet', () => {
    expect(new Library(root).readProtocols()).toEqual([])
    expect(new Library(root).readPreferences()).toBeNull()
  })

  it('starts empty rather than throwing on a damaged file', () => {
    writeFileSync(join(root, PROTOCOLS_FILE), '{ not json')
    writeFileSync(join(root, PREFERENCES_FILE), '{ not json')

    expect(new Library(root).readProtocols()).toEqual([])
    expect(new Library(root).readPreferences()).toBeNull()
  })

  it('drops entries that are not protocols rather than handing them to the interface', () => {
    writeFileSync(
      join(root, PROTOCOLS_FILE),
      JSON.stringify([protocol('p1'), null, 'nonsense', { name: 'no id' }]),
    )

    expect(new Library(root).readProtocols().map((p) => p.id)).toEqual(['p1'])
  })

  it('keeps the previous list as a backup when protocols are rewritten', () => {
    const library = new Library(root)
    library.writeProtocols([protocol('p1', 'Kläbo special')])
    library.writeProtocols([])

    expect(library.readProtocols()).toEqual([])
    const backup = JSON.parse(readFileSync(join(root, `${PROTOCOLS_FILE}.bak`), 'utf8')) as Protocol[]
    expect(backup.map((p) => p.name)).toEqual(['Kläbo special'])
  })

  it('does not rewrite a file whose contents have not changed', () => {
    const library = new Library(root)
    library.writePreferences({ athlete: { name: 'Athlete' } })
    library.writePreferences({ athlete: { name: 'Athlete' } })

    // A rewrite would have moved the first copy aside as a backup.
    expect(existsSync(join(root, `${PREFERENCES_FILE}.bak`))).toBe(false)
  })

  it('leaves no temporary file behind', () => {
    const library = new Library(root)
    library.writeProtocols([protocol('p1')])
    library.writePreferences({ athlete: { name: 'Athlete' } })

    expect(existsSync(join(root, `${PROTOCOLS_FILE}.tmp`))).toBe(false)
    expect(existsSync(join(root, `${PREFERENCES_FILE}.tmp`))).toBe(false)
  })

  it('round-trips preferences', () => {
    new Library(root).writePreferences({ wheelCircumferenceM: 2.096, dashboardTiles: { bike: ['power'] } })

    expect(new Library(root).readPreferences()).toEqual({
      wheelCircumferenceM: 2.096,
      dashboardTiles: { bike: ['power'] },
    })
  })
})
