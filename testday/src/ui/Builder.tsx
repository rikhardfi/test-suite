import { useState } from 'react'
import { DurationCell, NumberCell, DurationField, NumberField } from './inputs'
import { formatClock } from '../model/metrics'
import {
  DEFAULT_RECOVERY,
  buildIntervals,
  buildRamp,
  buildRunStepTest,
  buildStepTest,
  makeProtocol,
  newId,
  numberRepeats,
  protocolDurationS,
  recoveryLabel,
  recoveryWatts,
  stepInclinePct,
  stepLabel,
  targetKphAt,
  type Athlete,
  type Protocol,
  type RecoveryTarget,
  type Step,
} from '../model/protocol'
import { computeVo2 } from '../model/vo2'
import { Modal } from './Modal'

interface Props {
  protocols: Protocol[]
  selectedId: string | null
  athlete: Athlete
  onSelect: (protocol: Protocol) => void
  onSave: (protocol: Protocol) => void
  onDelete: (id: string) => void
  onRun: (protocol: Protocol) => void
}

export function Builder({ protocols, selectedId, athlete, onSelect, onSave, onDelete, onRun }: Props) {
  const [editing, setEditing] = useState<Protocol | null>(null)
  const [generator, setGenerator] = useState(false)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Protocols</h1>
        <div className="row">
          <button onClick={() => setGenerator(true)}>New from template</button>
          <button
            onClick={() =>
              setEditing(
                makeProtocol('Untitled protocol', 'bike', [
                  { id: newId('step'), name: 'Step 1', durationS: 300, target: { mode: 'watts', watts: 200 } },
                ]),
              )
            }
          >
            Blank
          </button>
        </div>
      </div>

      <div className="protocol-grid">
        {protocols.map((protocol) => (
          <article
            key={protocol.id}
            className={`card ${protocol.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(protocol)}
          >
            <header>
              <h2>{protocol.name}</h2>
              <span className="tag">{protocol.sport}</span>
            </header>
            <p className="muted small">{protocol.description}</p>
            <dl>
              <div>
                <dt>Steps</dt>
                <dd>{protocol.steps.length}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatClock(protocolDurationS(protocol))}</dd>
              </div>
              <div>
                <dt>Lactate</dt>
                <dd>{protocol.steps.filter((s) => s.lactateSample).length}</dd>
              </div>
            </dl>
            <footer className="row">
              <button
                className="primary"
                onClick={(e) => {
                  e.stopPropagation()
                  onRun(protocol)
                }}
              >
                Run
              </button>
              <button
                className="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  // Built-ins are templates: editing one produces a copy.
                  setEditing(
                    protocol.builtIn
                      ? { ...protocol, id: newId('proto'), name: `${protocol.name} (copy)`, builtIn: false }
                      : protocol,
                  )
                }}
              >
                {protocol.builtIn ? 'Duplicate' : 'Edit'}
              </button>
              {!protocol.builtIn && (
                <button
                  className="ghost danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(protocol.id)
                  }}
                >
                  Delete
                </button>
              )}
            </footer>
          </article>
        ))}
      </div>

      {generator && (
        <GeneratorDialog
          athlete={athlete}
          onClose={() => setGenerator(false)}
          onCreate={(protocol) => {
            setGenerator(false)
            setEditing(protocol)
          }}
        />
      )}

      {editing && (
        <StepEditor
          protocol={editing}
          athlete={athlete}
          onClose={() => setEditing(null)}
          onSave={(protocol) => {
            onSave(protocol)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

type Template = 'bikeStep' | 'ramp' | 'runStep' | 'intervals'

function GeneratorDialog({
  athlete,
  onCreate,
  onClose,
}: {
  athlete: Athlete
  onCreate: (protocol: Protocol) => void
  onClose: () => void
}) {
  const [template, setTemplate] = useState<Template>('bikeStep')
  const [values, setValues] = useState({
    startWatts: Math.round(athlete.ftpWatts * 0.5),
    stepWatts: 20,
    stepDurationS: 240,
    stepCount: 8,
    sampleBreakS: 30,
    warmupDurationS: 600,
    wattsPerMinute: 25,
    rampDurationS: 1200,
    startKph: 10,
    stepKph: 1,
    inclinePct: 1,
    reps: 4,
    onDurationS: 240,
    onPctFtp: 105,
    offDurationS: 120,
    offPctFtp: 45,
    sets: 1,
    setRecoveryS: 300,
  })


  const create = () => {
    let steps: Step[]
    let name: string
    let sport: Protocol['sport'] = 'bike'

    if (template === 'bikeStep') {
      steps = buildStepTest({
        startWatts: values.startWatts,
        stepWatts: values.stepWatts,
        stepDurationS: values.stepDurationS,
        stepCount: values.stepCount,
        sampleBreakS: values.sampleBreakS || undefined,
        warmupDurationS: values.warmupDurationS || undefined,
      })
      name = `Step test ${formatClock(values.stepDurationS)} / ${values.stepWatts} W`
    } else if (template === 'intervals') {
      steps = buildIntervals({
        reps: values.reps,
        onDurationS: values.onDurationS,
        onTarget: { mode: 'ftp', pctFtp: values.onPctFtp },
        offDurationS: values.offDurationS,
        offTarget: { mode: 'ftp', pctFtp: values.offPctFtp },
        sets: values.sets,
        setRecoveryS: values.setRecoveryS || undefined,
      })
      name =
        values.sets > 1
          ? `${values.sets} × ${values.reps} × ${formatClock(values.onDurationS)}`
          : `${values.reps} × ${formatClock(values.onDurationS)}`
    } else if (template === 'ramp') {
      steps = buildRamp({
        startWatts: values.startWatts,
        wattsPerMinute: values.wattsPerMinute,
        durationS: values.rampDurationS,
      })
      name = `Ramp ${values.wattsPerMinute} W/min`
    } else {
      sport = 'run'
      steps = buildRunStepTest({
        startKph: values.startKph,
        stepKph: values.stepKph,
        stepDurationS: values.stepDurationS,
        stepCount: values.stepCount,
        inclinePct: values.inclinePct,
        sampleBreakS: values.sampleBreakS || undefined,
      })
      name = `Treadmill step test ${formatClock(values.stepDurationS)} / ${values.stepKph} km/h`
    }
    onCreate(makeProtocol(name, sport, steps))
  }

  return (
    <Modal onClose={onClose} className="narrow">
        <h2>New protocol</h2>
        <div className="segmented">
          {(
            [
              ['bikeStep', 'Bike steps'],
              ['intervals', 'Intervals'],
              ['ramp', 'Ramp'],
              ['runStep', 'Treadmill steps'],
            ] as [Template, string][]
          ).map(([key, label]) => (
            <button key={key} className={template === key ? 'on' : ''} onClick={() => setTemplate(key)}>
              {label}
            </button>
          ))}
        </div>

        <div className="field-grid">
          {template === 'intervals' && (
            <>
              <NumberField label="Reps per set" value={values.reps} onChange={(v) => setValues((c) => ({ ...c, reps: v }))} />
              <DurationField
                label="Work"
                seconds={values.onDurationS}
                onChange={(v) => setValues((c) => ({ ...c, onDurationS: v }))}
              />
              <NumberField label="Work (% FTP)" value={values.onPctFtp} onChange={(v) => setValues((c) => ({ ...c, onPctFtp: v }))} />
              <DurationField
                label="Rest"
                seconds={values.offDurationS}
                onChange={(v) => setValues((c) => ({ ...c, offDurationS: v }))}
              />
              <NumberField label="Rest (% FTP)" value={values.offPctFtp} onChange={(v) => setValues((c) => ({ ...c, offPctFtp: v }))} />
              <NumberField label="Sets" value={values.sets} onChange={(v) => setValues((c) => ({ ...c, sets: v }))} />
              <DurationField label="Recovery between sets" seconds={values.setRecoveryS} onChange={(v) => setValues((c) => ({ ...c, setRecoveryS: v }))} />
            </>
          )}
          {template === 'intervals' ? null : template === 'runStep' ? (
            <>
              <NumberField label="Start speed (km/h)" value={values.startKph} onChange={(v) => setValues((c) => ({ ...c, startKph: v }))} step={0.5} />
              <NumberField label="Increment (km/h)" value={values.stepKph} onChange={(v) => setValues((c) => ({ ...c, stepKph: v }))} step={0.5} />
              <NumberField label="Gradient (%)" value={values.inclinePct} onChange={(v) => setValues((c) => ({ ...c, inclinePct: v }))} step={0.5} />
            </>
          ) : (
            <NumberField label="Start power (W)" value={values.startWatts} onChange={(v) => setValues((c) => ({ ...c, startWatts: v }))} />
          )}

          {template === 'ramp' ? (
            <>
              <NumberField label="Ramp rate (W/min)" value={values.wattsPerMinute} onChange={(v) => setValues((c) => ({ ...c, wattsPerMinute: v }))} />
              <DurationField label="Ramp duration" seconds={values.rampDurationS} onChange={(v) => setValues((c) => ({ ...c, rampDurationS: v }))} />
            </>
          ) : (
            <>
              {template === 'bikeStep' && (
                <NumberField label="Increment (W)" value={values.stepWatts} onChange={(v) => setValues((c) => ({ ...c, stepWatts: v }))} />
              )}
              <DurationField label="Step duration" seconds={values.stepDurationS} onChange={(v) => setValues((c) => ({ ...c, stepDurationS: v }))} />
              <NumberField label="Number of steps" value={values.stepCount} onChange={(v) => setValues((c) => ({ ...c, stepCount: v }))} />
              <DurationField label="Sample break" seconds={values.sampleBreakS} onChange={(v) => setValues((c) => ({ ...c, sampleBreakS: v }))} />
            </>
          )}
          {template === 'bikeStep' && (
            <DurationField label="Warm-up" seconds={values.warmupDurationS} onChange={(v) => setValues((c) => ({ ...c, warmupDurationS: v }))} />
          )}
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={create}>
            Create
          </button>
        </div>
    </Modal>
  )
}

function StepEditor({
  protocol,
  athlete,
  onSave,
  onClose,
}: {
  protocol: Protocol
  athlete: Athlete
  onSave: (protocol: Protocol) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Protocol>({ ...protocol, steps: protocol.steps.map((s) => ({ ...s })) })
  const [repeat, setRepeat] = useState({ from: 1, to: 1, times: 4 })
  const economy = athlete.economyPct ?? 100
  const isRun = draft.sport === 'run'

  const update = (index: number, patch: Partial<Step>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }))

  const setWatts = (index: number, watts: number) =>
    update(index, { target: { mode: 'watts', watts } })

  const setKph = (index: number, kph: number) => {
    update(index, { target: { mode: 'speed', kph, inclinePct: stepInclinePct(draft.steps[index]) ?? undefined } })
  }

  const setVo2 = (index: number, vo2: number) => {
    update(index, { target: { mode: 'vo2', vo2, inclinePct: stepInclinePct(draft.steps[index]) ?? undefined } })
  }

  const setIncline = (index: number, inclinePct: number) => {
    const target = draft.steps[index].target
    if (target.mode === 'speed') update(index, { target: { ...target, inclinePct } })
    else if (target.mode === 'vo2') update(index, { target: { ...target, inclinePct } })
  }

  const setRunMode = (index: number, mode: 'speed' | 'vo2') => {
    const step = draft.steps[index]
    if (mode === step.target.mode) return
    // Carry the effort across rather than resetting it: the speed the athlete
    // was going to run is converted to its oxygen cost and back.
    const incline = stepInclinePct(step) ?? 0
    if (mode === 'vo2') {
      const kph = step.target.mode === 'speed' ? step.target.kph : 0
      const vo2 = kph > 0 ? computeVo2(kph, incline, economy).vo2 : 45
      update(index, { target: { mode: 'vo2', vo2: Number(vo2.toFixed(1)), inclinePct: incline } })
    } else {
      const kph = targetKphAt(step, 0, economy) ?? 10
      update(index, { target: { mode: 'speed', kph: Number(kph.toFixed(2)), inclinePct: incline } })
    }
  }

  const recovery = draft.recovery ?? DEFAULT_RECOVERY
  const setRecovery = (next: RecoveryTarget) => setDraft((d) => ({ ...d, recovery: next }))

  /** Appends `times` more copies of a block of steps, numbered as repetitions. */
  const insertRepeats = (fromIndex: number, toIndex: number, times: number) => {
    const from = Math.max(0, Math.min(fromIndex, toIndex))
    const to = Math.min(draft.steps.length - 1, Math.max(fromIndex, toIndex))
    if (times < 2 || from > to) return
    setDraft((d) => {
      const block = d.steps.slice(from, to + 1)
      // The block itself is renumbered too, so the first repetition reads 1/N
      // rather than being the only one without a number.
      const expanded = numberRepeats(block, times)
      return { ...d, steps: [...d.steps.slice(0, from), ...expanded, ...d.steps.slice(to + 1)] }
    })
  }

  return (
    <Modal onClose={onClose} className="wide">
        <h2>Edit protocol</h2>
        <div className="field-grid">
          <label>
            Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Sport
            <select
              value={draft.sport}
              onChange={(e) => setDraft({ ...draft, sport: e.target.value as Protocol['sport'] })}
            >
              <option value="bike">Bike</option>
              <option value="run">Run</option>
            </select>
          </label>
          <label>
            Recovery during breaks
            <div className="row nowrap">
              <select
                value={recovery.mode}
                onChange={(e) =>
                  setRecovery(
                    e.target.value === 'watts'
                      ? { mode: 'watts', watts: recoveryWatts({ id: '', durationS: 0, target: { mode: 'free' } }, draft, athlete.ftpWatts) }
                      : { mode: 'ftp', pctFtp: 30 },
                  )
                }
              >
                <option value="ftp">% of FTP</option>
                <option value="watts">watts</option>
              </select>
              <NumberCell
                value={recovery.mode === 'watts' ? recovery.watts : recovery.pctFtp}
                onChange={(v) =>
                  setRecovery(
                    recovery.mode === 'watts' ? { mode: 'watts', watts: v } : { mode: 'ftp', pctFtp: v },
                  )
                }
              />
              <span className="muted small nowrap">= {recoveryLabel(recovery, athlete.ftpWatts)}</span>
            </div>
          </label>
          <label className="span-2">
            Description
            <input
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
        </div>

        <div className="table-scroll tall">
          <table className="steps">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Duration (s)</th>
                {isRun && <th>Mode</th>}
                <th>{isRun ? 'Target' : 'Target (W)'}</th>
                {isRun && <th>Grade (%)</th>}
                <th>Break (s)</th>
                <th>Recovery (W)</th>
                <th>Lactate</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.steps.map((step, index) => (
                <tr key={step.id}>
                  <td className="muted">{index + 1}</td>
                  <td>
                    <input value={step.name ?? ''} onChange={(e) => update(index, { name: e.target.value })} />
                  </td>
                  <td>
                    <DurationCell
                      seconds={step.durationS}
                      onChange={(v) => update(index, { durationS: v })}
                    />
                  </td>
                  {isRun && (
                    <td>
                      <select
                        value={step.target.mode === 'vo2' ? 'vo2' : 'speed'}
                        onChange={(e) => setRunMode(index, e.target.value as 'speed' | 'vo2')}
                      >
                        <option value="speed">km/h</option>
                        <option value="vo2">VO₂</option>
                      </select>
                    </td>
                  )}
                  <td>
                    {isRun ? (
                      step.target.mode === 'vo2' ? (
                        <div className="row nowrap">
                          <NumberCell
                            step={0.5}
                            value={step.target.vo2}
                            onChange={(v) => setVo2(index, v)}
                          />
                          {/* The solved speed is what the treadmill is sent. */}
                          <span className="muted small nowrap">
                            {(targetKphAt(step, 0, economy) ?? 0).toFixed(1)} km/h
                          </span>
                        </div>
                      ) : (
                        <NumberCell
                          step={0.1}
                          value={step.target.mode === 'speed' ? step.target.kph : 0}
                          onChange={(v) => setKph(index, v)}
                        />
                      )
                    ) : (
                      <NumberCell
                        value={
                          step.target.mode === 'watts'
                            ? step.target.watts
                            : step.target.mode === 'ftp'
                              ? Math.round((step.target.pctFtp / 100) * athlete.ftpWatts)
                              : 0
                        }
                        onChange={(v) => setWatts(index, v)}
                      />
                    )}
                  </td>
                  {isRun && (
                    <td>
                      <NumberCell
                        step={0.5}
                        value={stepInclinePct(step) ?? 0}
                        onChange={(v) => setIncline(index, v)}
                      />
                    </td>
                  )}
                  <td>
                    <DurationCell
                      seconds={step.recoveryS ?? 0}
                      onChange={(v) => update(index, { recoveryS: v || undefined })}
                    />
                  </td>
                  <td>
                    {/* Blank means "inherit the protocol's recovery". */}
                    <input
                      type="number"
                      placeholder={String(recoveryWatts({ ...step, recoveryTarget: undefined }, draft, athlete.ftpWatts))}
                      value={step.recoveryTarget?.mode === 'watts' ? step.recoveryTarget.watts : ''}
                      onChange={(e) =>
                        update(index, {
                          recoveryTarget: e.target.value
                            ? { mode: 'watts', watts: 0 }
                            : undefined,
                        })
                      }
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={!!step.lactateSample}
                      onChange={(e) => update(index, { lactateSample: e.target.checked })}
                    />
                  </td>
                  <td className="row">
                    <button
                      className="ghost"
                      title="Duplicate"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          steps: [
                            ...d.steps.slice(0, index + 1),
                            { ...step, id: newId('step') },
                            ...d.steps.slice(index + 1),
                          ],
                        }))
                      }
                    >
                      ⧉
                    </button>
                    <button
                      className="ghost danger"
                      title="Remove"
                      onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row repeat-bar">
          <span className="muted small">Repeat steps</span>
          <NumberCell
            className="inline"
            min={1}
            max={draft.steps.length}
            value={repeat.from}
            onChange={(v) => setRepeat((r) => ({ ...r, from: v }))}
          />
          <span className="muted small">to</span>
          <NumberCell
            className="inline"
            min={1}
            max={draft.steps.length}
            value={repeat.to}
            onChange={(v) => setRepeat((r) => ({ ...r, to: v }))}
          />
          <span className="muted small">×</span>
          <NumberCell
            className="inline"
            min={2}
            value={repeat.times}
            onChange={(v) => setRepeat((r) => ({ ...r, times: v }))}
          />
          <button
            disabled={repeat.times < 2 || repeat.from < 1 || repeat.to > draft.steps.length}
            onClick={() => insertRepeats(repeat.from - 1, repeat.to - 1, repeat.times)}
          >
            Expand
          </button>
          <span className="muted small">
            {/* Said plainly, because expansion rewrites the step list in place. */}
            Writes the block out {repeat.times} times. Editing one copy afterwards does not change
            the others.
          </span>
        </div>

        <div className="row">
          <button
            onClick={() =>
              setDraft((d) => {
                const last = d.steps[d.steps.length - 1]
                return {
                  ...d,
                  steps: [
                    ...d.steps,
                    last
                      ? { ...last, id: newId('step'), name: `Step ${d.steps.length + 1}` }
                      : {
                          id: newId('step'),
                          name: 'Step 1',
                          durationS: 300,
                          target: { mode: 'watts' as const, watts: 200 },
                        },
                  ],
                }
              })
            }
          >
            + Add step
          </button>
          <span className="muted small">
            Total {formatClock(protocolDurationS(draft))} ·{' '}
            {draft.steps[0] ? stepLabel(draft.steps[0], athlete.ftpWatts) : ''} to{' '}
            {draft.steps.length ? stepLabel(draft.steps[draft.steps.length - 1], athlete.ftpWatts) : ''}
          </span>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => onSave({ ...draft, builtIn: false, updatedAt: Date.now() })}
          >
            Save protocol
          </button>
        </div>
    </Modal>
  )
}

