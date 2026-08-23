# testday

A performance test-day suite. Build a step or ramp protocol, drive a smart trainer or treadmill over
Bluetooth, watch the athlete's numbers live, and get lactate thresholds, critical power and a
mean-maximal curve out the other end.

It runs as a **desktop app**, which is what lets a recording be written to a file as it happens rather
than held in a browser tab that can be closed. Nothing leaves the machine: no account, no server, no
upload, and no network requests at all. The same code still runs in a browser for demos and rehearsals,
with the weaker storage that implies.

## What it does

**Protocols.** Built-in templates for the usual lab tests (4 min and 8 min lactate step tests, a
25 W/min ramp, a Norwegian-style double-threshold session, 30/15s, a 20 min FTP test, a treadmill step
test) plus a generator and a step-by-step editor for your own. Targets are either absolute watts,
a percentage of threshold power, or treadmill speed with a gradient.

**Live control.** The runner advances steps on a wall-clock timer, computes the target for the current
second (interpolating through ramps), and pushes it to the machine over FTMS. Steps can carry a
sampling break — an easy spin at the end of the stage during which the dashboard prompts for a blood
lactate value. Global intensity trim (±1%), step skip, pause, and a lap table you can double-click to
jump around in.

**Two power sources, and a trainer that is told what to do about them.** Pair a power meter as well
as the trainer and both traces are recorded side by side, never blended, with the bias and drift
between them live on the dashboard. Optionally the trainer is then commanded a corrected figure so
that the *meter* reads the protocol's target: a multiplier measured by a thirty-second probe in the
warm-up, plus a slow trim inside long steps. See [Which watts](#which-watts).

**Capture.** One sample per second of power, heart rate, cadence, speed and the commanded target,
tagged with the step and phase it belongs to. In the desktop app every sample is appended to a file
and flushed to disk as it happens, so a crash costs nothing and an interrupted session is offered
back for resume on the next launch. See [Recordings](#recordings).

**Analysis.** A third-order fit through the lactate points with six threshold methods reported side by
side (baseline + 1.0 mmol/L, log-log breakpoint, Dmax, modified Dmax, OBLA 2.0 and OBLA 4.0), heart
rate interpolated at each, and a leave-one-out band on every one of them so the estimate is read to
the precision it actually has. A longitudinal view overlays an athlete's test days against each
other, and a metabolic cart export can be imported to place VT1 and VT2 beside the lactate
thresholds. Plus the mean-maximal power curve, two-parameter critical power with W′,
and normalised power. Export as sample CSV, lap CSV, FIT or raw JSON, plus a research export that
pairs a pseudonymised 1 Hz CSV with a sidecar describing every column, every equation used, and the
protocol as actually executed.

## Bluetooth support

Connects over Web Bluetooth using standard Bluetooth SIG fitness profiles — no vendor SDKs, so
anything that follows the spec works.

| Profile | UUID | Used for |
| --- | --- | --- |
| Heart Rate | `0x180D` | Heart rate, RR intervals |
| Cycling Power | `0x1818` | Power, cadence, wheel speed |
| Cycling Speed and Cadence | `0x1816` | Speed, cadence |
| Running Speed and Cadence | `0x1814` | Pace, cadence, distance |
| Fitness Machine (FTMS) | `0x1826` | Indoor bike and treadmill data, **plus ERG and pace control** |
| Battery | `0x180F` | Battery level |

FTMS control point commands used: request control, set target power (ERG), set target speed, set
target inclination, start, stop. Commands are serialised one at a time and matched against their
indication, because trainers drop overlapping writes.

When two devices report the same metric — a power meter and a trainer both sending watts, say — the
more authoritative source wins by default (dedicated sensor over machine estimate). You can override
the choice per metric in the sensor panel.

Dropped connections reconnect automatically with backoff. A metric older than five seconds stops being
displayed rather than showing a stale number.

### Browser requirements

Web Bluetooth is implemented in **Chrome, Edge and Opera** on desktop (macOS, Windows, Linux, ChromeOS)
and on Android. **Safari and Firefox do not implement it at all**, so on iOS and iPadOS no browser can
do this — that is a platform limitation, not something this app can work around.

The page must be served over HTTPS or from `localhost`.

### No hardware? Use the simulator

The sensor panel has a **Simulator** button: a synthetic trainer and athlete that answers ERG targets
with a realistic first-order lag, produces pedalling noise, and drives a heart rate that lags power and
drifts upward above threshold. Works in any browser, including ones without Web Bluetooth. Use it to
rehearse a protocol before the athlete is on the bike.

**Simulator + power meter** adds a second power source that disagrees with the trainer and drifts
against it, reproducing a measured session rather than an invented one. It is the way to watch the
power correction below do its job with no hardware in the room.

## Recordings

The desktop app records to an **append-only journal**: one JSON object per line, `fsync`ed before the
write returns. Nothing is ever rewritten, so the worst a crash can do is cut the final line.

```
~/Documents/testday/sessions/2026-08-12_07-31_session_xyz/
  journal.ndjson   one line per sample, appended live
  meta.json        cached summary for the session list, rewritten on close
```

- **A journal with no `closed` record is an interrupted session.** That is the only signal needed, so
  there is no lock file to go stale. The app offers it back for resume on the next launch and picks
  the clock up at the last sample on disk.
- **A truncated final line is discarded on read** and everything before it survives. This is the
  normal state of a journal whose process was killed mid-write.
- **The second copy is made only after the session closes.** A file that is held open and continuously
  appended is exactly what a sync client handles badly, so OneDrive never sees a live journal. The
  copy is verified by size and SHA-256, re-read from the destination, before the app claims two copies
  exist.
- **Nothing is deleted.** Removing a session from the list moves it to `~/Documents/testday/discarded/`.
- **Protocols and settings are files too**, `protocols.json` and `preferences.json` in the same folder,
  each keeping one generation as `.bak`. They used to live in the renderer's IndexedDB and
  localStorage, which are scoped to the origin of the page: a development window is
  `http://localhost:5173` and the built app is `file://`, so running the app the other way silently
  swapped in an empty store and looked exactly like every protocol having been deleted. Whatever is
  still in a browser store is collected into the files once, per origin, on first launch.
- **A failed write turns the dashboard pill red immediately.** A silent write failure is worse than a
  crash, because the operator carries on testing into nothing.
- **A machine left running with nothing recording raises an alarm** across the top of the dashboard,
  with a button that stops it. A belt still moving after Finish & save, or before anyone has pressed
  start, is the one genuinely dangerous state this app can be in, and a paused dashboard looks calm.
- **Distance is measured from the start of the session, not from the machine's odometer.** A treadmill
  is usually already rolling when the athlete steps on, so its odometer arrives with a warm-up on it.

### What this does and does not survive

| Failure | Outcome |
| --- | --- |
| App crash, `kill -9`, forced quit | Everything up to the last completed sample. Resume offered. |
| Renderer crash or reload | Same. The journal lives in the main process. |
| OS panic or reboot | Same, because each append is fsynced. |
| **Sudden power loss** | **The last few seconds may be lost.** |
| Disk failure | The OneDrive copy of every *closed* session. An open one is gone. |

The power-loss caveat is real and worth stating plainly: on macOS `fsync` does not flush the drive's
own write cache, and Node does not expose `F_FULLFSYNC`. Run test days on mains power, and close a
session before unplugging anything.

The browser build has none of this. A browser cannot append to a file, so it falls back to rewriting
the whole session into IndexedDB every 15 seconds. It is there for demos and for rehearsing a protocol
with the simulator. Anything with an athlete on it belongs on the desktop app.

## Running it

```bash
npm install
npm run electron:dev    # the desktop app, with hot reload
```

```bash
npm run electron:build  # typecheck, bundle renderer and main process
npm run electron:start  # run the built app
npm run dist            # package a local .app into release/
npm test                # unit tests
```

The browser version still builds from the same source:

```bash
npm run dev             # http://localhost:5173
npm run build           # static bundle into dist/
npm run preview
```

`dist/` can be dropped on any HTTPS host. Set `BASE_PATH` when serving from a subdirectory:

```bash
BASE_PATH=/testday/ npm run build
```

The desktop app makes **no network requests at all** — non-local requests are blocked outright and
there is no updater. Nothing about it can hang on a conference-centre network on the morning of a test.

## Layout

```
electron/
  main.ts        window, IPC, sleep blocker, close guard, Bluetooth chooser relay
  preload.ts     the window.testday bridge, the renderer's only reach into the recorder
  ipc.ts         channel names and payload types, shared by both sides
  journal.ts     the file half of the journal: open, append, fsync
  sessions.ts    session directories, listing, resume, mirror and verification
src/
  ble/
    uuids.ts       Assigned numbers and FTMS op codes
    parse.ts       Characteristic decoders + revolution-counter maths
    ftms.ts        Fitness machine control point client
    manager.ts     Connection lifecycle, reconnection, metric arbitration
    simulator.ts   Synthetic trainer and athlete
  model/
    protocol.ts    Protocol/step types, target resolution, builders
    presets.ts     Built-in test protocols
    session.ts     The runner: clock, step advance, ERG push, recording
    journal.ts     The on-disk record format: encode, decode, reconstruct
    recorder.ts    Where a recording goes; file backend on desktop, IndexedDB in a browser
    metrics.ts     Rolling averages, MMP tracker, normalised power
    analysis.ts    Polynomial fitting, threshold methods, critical power, W-prime, decoupling
    ventilatory.ts Cart import, V-slope VT1 and VE/VCO2 VT2
    longitudinal.ts One athlete across test days, with the bands carried through
    storage.ts     Protocols and settings: files on desktop, IndexedDB in a browser
    export.ts      CSV and JSON writers
    fit.ts         FIT encoder, including the developer fields TCX had nowhere for
    research.ts    Frozen CSV column contract, metadata sidecar, participant codes
  ui/              React components and canvas charts
```

Tests cover the parts where being wrong is silent: characteristic parsing (including the inverted
"more data" flag in FTMS and 16-bit counter wraparound), the runner's timing and ERG behaviour, the
MMP tracker against a brute-force search, every threshold method against a synthetic step test, and
the journal.

The journal tests are the ones that matter most, because a recording bug is not visible until the
recording is needed. They cover encoding round-trips, a truncated final line, a corrupt line in the
middle, resume positioning, and mirror verification. One test spawns a real child process, kills it
with `SIGKILL` mid-recording, and checks that every sample the recorder acknowledged is on disk with
no gaps: truncating a file by hand only tests the reader, not the durability claim.

```
npm test    # 297 tests
```

### Verifying the FIT output

`fit.test.ts` decodes what the encoder wrote with a reader that shares none of its tables, which
catches a definition message that disagrees with its data. What it structurally *cannot* catch is a
wrong field number, because the encoder and that reader would be wrong together and agree perfectly.

Only a decoder carrying Garmin's own profile can catch that, and it has already caught two bugs the
unit tests passed clean: a `developer_data_id` whose field numbers were one apart, which made a
strict decoder reject the entire file and every lactate value in it unreadable, and an offset
applied after its scale rather than before, which turned an altitude of 0 m into -400 m.

So it runs as part of `npm test`, and fails loudly rather than skipping when the toolchain is
missing. A check that silently does not run is worse than no check, because it also tells you
everything is fine.

```bash
python3 -m pip install -r tools/requirements.txt   # or: npm run setup:tools
npm run verify:fit                                  # just this check
SKIP_FIT_VERIFY=1 npm test                          # opt out, visibly
```

Python is a development dependency only. The app itself has no Python in it, no runtime
dependencies beyond React, and still makes no network requests.

**Re-run this whenever a message or field number in `src/model/fit.ts` changes.** The unit tests
will not catch that class of mistake.

## Which watts

A trainer in ERG mode holds *its own* measurement at the commanded number. That is not the same
quantity as the power going through the pedals, and the gap between them is neither small nor
constant. In a 50 minute session recorded here at a commanded 200 W, a reference meter read 4.9%
high at the start and 0.7% low at the end: about 12 W of real load left the test while every label
in the file still said 200 W. A drivetrain loss of one and a half to three percent is physics and
stays put. The rest was the trainer's own estimate climbing as the unit warmed, which in ERG means
quietly giving the athlete less work to do.

A step test's premise is a known work rate, so this is a measurement failure rather than a display
problem. Pairing a second power source is what makes it visible; one trace cannot show its own
error. Turning on the correction is what acts on it, and it works in two parts:

- A **feed-forward multiplier**, measured against the reference meter by the *Probe ERG* button
  during the warm-up. Applied to every commanded target from its first second, so a 60 second ramp
  step is right immediately. It cannot oscillate.
- A **slow trim** inside steps longer than two minutes, to catch drift. Rate-limited to 2% per
  adjustment, no more than one every 30 seconds, with a 1% dead band and a hard 15% clamp. The
  trainer is already running a control loop of its own, and two loops that fight replace a steady
  offset with a hunting one, which is worse for a test than the offset was.

Three things to know before switching it on. The loop cannot tell a drifting trainer from a drifting
meter, so it will faithfully impose the reference meter's own error on the athlete: zero the meter
first, and do not use a single-sided one, which reports a constant 50/50 balance and is doubling one
leg. The dead band means the loop settles to within about 1% of target rather than exactly on it, on
purpose. And **pedal power is not hub power**: a 200 W crank test and a 200 W hub test are different
tests, so the reported figure names which meter produced it. Published ergometry is overwhelmingly
crank-based, which is the argument for closing the loop on the pedals rather than the flywheel.

Everything the loop does is recorded: the protocol's target and the commanded value in separate
columns, the factor in force, both power traces, and a journal entry for the probe, every trim,
every time the clamp bit, and every stretch spent holding a factor because the meter stopped
answering. `target_power_w` remains what the protocol asked the athlete for; `commanded_power_w` is
what the trainer was told to do.

## Notes on the numbers

Threshold methods disagree with each other by design, which is why all six are shown rather than one
"answer". On a well-formed step test the log-log and baseline methods bracket LT1, and modified Dmax
and OBLA 4.0 bracket LT2. Dmax lands between them and is sensitive to where the test started, so a long
easy warm-up stage will drag it down.

Critical power is fitted as the linear work–time model over efforts between 2 and 20 minutes. It needs
maximal efforts in that range to mean anything — running it on a submaximal step test will produce a
number, and that number will be meaningless.

Blood lactate is entered by hand. There is no consumer BLE lactate meter to read from; the meters used
in labs are not Bluetooth devices with a public profile.

## Licence

MIT.
