import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionToFit } from './fit'
import { fixtureExpectations, fixtureLaps, fixtureProtocol, fixtureSession } from './fit.fixture'

/**
 * Checks a written FIT file against an independent decoder carrying Garmin's
 * own profile.
 *
 * `fit.test.ts` decodes the same bytes with a reader written in this repo. That
 * reader shares none of the encoder's tables, so it catches a definition
 * message that disagrees with the data behind it. What it structurally cannot
 * catch is a *wrong field number*: the encoder and that reader would be wrong
 * together and agree perfectly.
 *
 * That gap is not hypothetical. Checking against `fitdecode` found two bugs the
 * unit tests had passed clean: a `developer_data_id` whose field numbers were
 * one apart, which made a strict decoder reject the entire file and every
 * lactate value in it unreadable, and an offset applied after its scale rather
 * than before, which turned an altitude of 0 m into -400 m.
 *
 * So this runs by default and fails loudly when the toolchain is missing,
 * rather than skipping quietly. A check that silently does not run is worse
 * than no check, because it also tells you it is fine.
 *
 * `SKIP_FIT_VERIFY=1 npm test` opts out, visibly, for a machine without Python.
 */

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools')
const SKIP = process.env.SKIP_FIT_VERIFY === '1'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'testday-fit-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Reports what is missing, and how to get it, rather than just failing. */
function pythonProblem(): string | null {
  const python = spawnSync('python3', ['-c', 'import fitdecode'], { encoding: 'utf8' })
  if (python.error) {
    return 'python3 was not found on PATH. FIT verification needs it. See tools/requirements.txt.'
  }
  if (python.status !== 0) {
    return (
      'fitdecode is not installed. Run:\n' +
      '  python3 -m pip install -r tools/requirements.txt\n' +
      'It is a development dependency only; the app itself contains no Python.'
    )
  }
  return null
}

describe('FIT output, against an independent decoder', () => {
  it.skipIf(SKIP)('decodes to exactly what the encoder meant to write', () => {
    const problem = pythonProblem()
    // Not a skip. The whole reason this test exists is that the in-repo reader
    // cannot see this class of bug, so its absence has to be noisy.
    expect(problem, problem ?? '').toBeNull()

    const session = fixtureSession()
    const bytes = sessionToFit(session, {
      appName: fixtureExpectations.appName,
      appVersion: fixtureExpectations.appVersion,
      laps: fixtureLaps(),
      protocol: fixtureProtocol(),
    })

    const fitPath = join(dir, 'fixture.fit')
    const expectedPath = join(dir, 'expected.json')
    writeFileSync(fitPath, bytes)
    writeFileSync(expectedPath, JSON.stringify(fixtureExpectations, null, 2))

    const result = spawnSync('python3', [join(TOOLS, 'verify_fit.py'), fitPath, expectedPath], {
      encoding: 'utf8',
    })

    if (result.status !== 0) {
      throw new Error(
        `FIT verification failed.\n\n${result.stderr || result.stdout}\n` +
          `The file is kept at ${fitPath} for inspection.`,
      )
    }
    expect(result.status).toBe(0)
  })

  it.runIf(SKIP)('is being skipped on purpose', () => {
    // Present so the opt-out shows up in the run rather than the test simply
    // vanishing from the list.
    expect(SKIP).toBe(true)
  })
})
