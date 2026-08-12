import { useState } from 'react'
import { formatClock } from '../model/metrics'
import {
  buildRamp,
  buildRunStepTest,
  buildStepTest,
  makeProtocol,
  newId,
  protocolDurationS,
  stepLabel,
  type Athlete,
  type Protocol,
  type Step,
} from '../model/protocol'

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

type Template = 'bikeStep' | 'ramp' | 'runStep'

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
  })

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: Number(event.target.value) }))

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h2>New protocol</h2>
        <div className="segmented">
          {(
            [
              ['bikeStep', 'Bike steps'],
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
          {template === 'runStep' ? (
            <>
              <Field label="Start speed (km/h)" value={values.startKph} onChange={set('startKph')} step={0.5} />
              <Field label="Increment (km/h)" value={values.stepKph} onChange={set('stepKph')} step={0.5} />
              <Field label="Gradient (%)" value={values.inclinePct} onChange={set('inclinePct')} step={0.5} />
            </>
          ) : (
            <Field label="Start power (W)" value={values.startWatts} onChange={set('startWatts')} />
          )}

          {template === 'ramp' ? (
            <>
              <Field label="Ramp rate (W/min)" value={values.wattsPerMinute} onChange={set('wattsPerMinute')} />
              <Field label="Ramp duration (s)" value={values.rampDurationS} onChange={set('rampDurationS')} />
            </>
          ) : (
            <>
              {template === 'bikeStep' && (
                <Field label="Increment (W)" value={values.stepWatts} onChange={set('stepWatts')} />
              )}
              <Field label="Step duration (s)" value={values.stepDurationS} onChange={set('stepDurationS')} />
              <Field label="Number of steps" value={values.stepCount} onChange={set('stepCount')} />
              <Field label="Sample break (s, 0 = none)" value={values.sampleBreakS} onChange={set('sampleBreakS')} />
            </>
          )}
          {template === 'bikeStep' && (
            <Field label="Warm-up (s, 0 = none)" value={values.warmupDurationS} onChange={set('warmupDurationS')} />
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
      </div>
    </div>
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

  const update = (index: number, patch: Partial<Step>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }))

  const setWatts = (index: number, watts: number) =>
    update(index, { target: { mode: 'watts', watts } })

  const setKph = (index: number, kph: number) => {
    const existing = draft.steps[index].target
    update(index, {
      target: { mode: 'speed', kph, inclinePct: existing.mode === 'speed' ? existing.inclinePct : undefined },
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
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
                <th>{draft.sport === 'run' ? 'Speed (km/h)' : 'Target (W)'}</th>
                <th>Break (s)</th>
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
                    <input
                      type="number"
                      value={step.durationS}
                      onChange={(e) => update(index, { durationS: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    {draft.sport === 'run' ? (
                      <input
                        type="number"
                        step={0.1}
                        value={step.target.mode === 'speed' ? step.target.kph : 0}
                        onChange={(e) => setKph(index, Number(e.target.value))}
                      />
                    ) : (
                      <input
                        type="number"
                        value={
                          step.target.mode === 'watts'
                            ? step.target.watts
                            : step.target.mode === 'ftp'
                              ? Math.round((step.target.pctFtp / 100) * athlete.ftpWatts)
                              : 0
                        }
                        onChange={(e) => setWatts(index, Number(e.target.value))}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      value={step.recoveryS ?? 0}
                      onChange={(e) => update(index, { recoveryS: Number(e.target.value) || undefined })}
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
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  step,
}: {
  label: string
  value: number
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  step?: number
}) {
  return (
    <label>
      {label}
      <input type="number" value={value} step={step ?? 1} onChange={onChange} />
    </label>
  )
}
