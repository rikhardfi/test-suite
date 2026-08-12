import {
  buildRamp,
  buildRunStepTest,
  buildStepTest,
  makeProtocol,
  newId,
  type Protocol,
  type Step,
} from './protocol'

const preset = (p: Protocol): Protocol => ({ ...p, builtIn: true })

/**
 * Protocols are expressed in absolute watts where a physiologist would set
 * absolute watts, and in %FTP where the session is prescribed relative to
 * threshold. Both resolve against the athlete profile at run time.
 */
export function builtInProtocols(ftpWatts: number): Protocol[] {
  return [
    preset(
      makeProtocol(
        'Lactate step test — 4 min / 20 W',
        'bike',
        buildStepTest({
          warmupWatts: Math.round(ftpWatts * 0.45),
          warmupDurationS: 600,
          startWatts: Math.round(ftpWatts * 0.5),
          stepWatts: 20,
          stepDurationS: 240,
          stepCount: 10,
          sampleBreakS: 30,
        }),
        'Submaximal incremental test with a 30 s break after each step for a blood draw. The standard input for LT1/LT2 curve fitting.',
      ),
    ),

    preset(
      makeProtocol(
        'Lactate step test — 8 min / 15 W',
        'bike',
        buildStepTest({
          warmupWatts: Math.round(ftpWatts * 0.45),
          warmupDurationS: 600,
          startWatts: Math.round(ftpWatts * 0.55),
          stepWatts: 15,
          stepDurationS: 480,
          stepCount: 6,
          sampleBreakS: 45,
        }),
        'Long steps for true steady-state lactate and a cleaner MLSS estimate. Slower, but far less inflated at the top end.',
      ),
    ),

    preset(
      makeProtocol(
        'Ramp test — 25 W/min',
        'bike',
        [
          {
            id: newId('step'),
            name: 'Warm-up',
            durationS: 480,
            target: { mode: 'ftp', pctFtp: 45 },
          },
          ...buildRamp({ startWatts: Math.round(ftpWatts * 0.5), wattsPerMinute: 25, durationS: 1500 }),
        ],
        'Maximal ramp to exhaustion for VO2max and MAP. Stop when cadence falls away; the last completed minute is the result.',
      ),
    ),

    preset(
      makeProtocol(
        'Norwegian double threshold — AM',
        'bike',
        norwegianAm(),
        'Five × 6 min at LT2 with short floats, lactate clamped at 2.5–3.5 mmol/L. The morning half of a double-threshold day.',
      ),
    ),

    preset(
      makeProtocol(
        '30/15 VO2max',
        'bike',
        thirtyFifteen(),
        'Three sets of 30 s hard / 15 s easy. Long time at high VO2 without the pacing collapse of continuous work.',
      ),
    ),

    preset(
      makeProtocol(
        'FTP — 20 min',
        'bike',
        [
          { id: newId('step'), name: 'Warm-up', durationS: 900, target: { mode: 'ftp', pctFtp: 50 } },
          { id: newId('step'), name: 'Opener', durationS: 300, target: { mode: 'ftp', pctFtp: 100 } },
          { id: newId('step'), name: 'Easy', durationS: 300, target: { mode: 'ftp', pctFtp: 45 } },
          { id: newId('step'), name: '20 min test', durationS: 1200, target: { mode: 'free' } },
          { id: newId('step'), name: 'Cool-down', durationS: 600, target: { mode: 'ftp', pctFtp: 40 } },
        ],
        'Self-paced 20 minute maximal effort. The test block is uncontrolled on purpose — pace it yourself.',
      ),
    ),

    preset(
      makeProtocol(
        'Treadmill lactate step test',
        'run',
        buildRunStepTest({
          startKph: 10,
          stepKph: 1,
          stepDurationS: 240,
          stepCount: 8,
          inclinePct: 1,
          sampleBreakS: 30,
        }),
        '4 min stages at 1% gradient, 1 km/h increments, blood drawn in a 30 s break after each stage.',
      ),
    ),
  ]
}

function norwegianAm(): Step[] {
  const steps: Step[] = [
    { id: newId('step'), name: 'Warm-up', durationS: 900, target: { mode: 'ftp', pctFtp: 55 } },
  ]
  for (let i = 0; i < 5; i++) {
    steps.push({
      id: newId('step'),
      name: `Threshold ${i + 1}`,
      durationS: 360,
      target: { mode: 'ftp', pctFtp: 95 },
      lactateSample: true,
      recoveryS: 60,
    })
  }
  steps.push({ id: newId('step'), name: 'Cool-down', durationS: 600, target: { mode: 'ftp', pctFtp: 45 } })
  return steps
}

function thirtyFifteen(): Step[] {
  const steps: Step[] = [
    { id: newId('step'), name: 'Warm-up', durationS: 900, target: { mode: 'ftp', pctFtp: 55 } },
  ]
  for (let set = 0; set < 3; set++) {
    for (let rep = 0; rep < 13; rep++) {
      steps.push({
        id: newId('step'),
        name: `Set ${set + 1} on ${rep + 1}`,
        durationS: 30,
        target: { mode: 'ftp', pctFtp: 130 },
      })
      steps.push({
        id: newId('step'),
        name: `Set ${set + 1} off ${rep + 1}`,
        durationS: 15,
        target: { mode: 'ftp', pctFtp: 50 },
      })
    }
    if (set < 2) {
      steps.push({
        id: newId('step'),
        name: `Recovery ${set + 1}`,
        durationS: 300,
        target: { mode: 'ftp', pctFtp: 45 },
      })
    }
  }
  steps.push({ id: newId('step'), name: 'Cool-down', durationS: 600, target: { mode: 'ftp', pctFtp: 40 } })
  return steps
}
