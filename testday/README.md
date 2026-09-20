# testday

A performance test-day suite. Build a step or ramp protocol, drive a smart trainer or treadmill over
Bluetooth, watch the athlete's numbers live, and get lactate thresholds, critical power and a
mean-maximal curve out the other end.

It runs as a **desktop app**, which is what lets a recording be written to a file as it happens rather
than held in a browser tab that can be closed. Nothing leaves the machine: no account, no server, no
upload, and no internet requests at all (the one wired device, the TSI flow meter, is a USB cable that
shows up as a private link to the meter). The same code still runs in a browser for demos and rehearsals,
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

**Free ride.** On a bike, the *Free ride* button sets the protocol's target aside and keeps the trainer
in ERG at watts the rider chooses (−25, −5, +5, +25), starting from the load already on the pedals.
The clock, the steps and the recording carry on, so switching it off drops back into the step that is
due. Every switch and every change of watts goes into the journal as a `freeRide` event, because for
that stretch the load was the rider's and not the protocol's.

**Two screens.** *Athlete screen* in the dashboard head opens a second window with the operator's
tiles, large, and the workout graph, and nothing that can be pressed except full screen. Drag it to
the athlete's monitor. It holds no runner, no sensors and no recorder: the operator window feeds it
over a `BroadcastChannel`, samples as they are recorded, and a window opened mid-test asks for the
whole record once. The desktop app allows exactly this one window and refuses any other. *Full
screen* hides the navigation bar and takes the display; Esc leaves it.

**Rolling averages.** Three tiles in the picker, *Power avg*, *HR avg* and *Pace avg*: the last 30 s
large, 60 s and 5 min beneath. A window shows nothing until it is full, and pace is averaged as speed
first. **Y from 0 / Y fitted** on each dashboard chart switches all three between an axis that starts
at zero and one that starts just under the lowest step.

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

**Dropouts, and the crank power meter in particular.** A crank-mounted meter — a Quarq, a Power2Max,
a set of pedals — drops its link far more often than a chest strap does, and it starts doing it the
moment the athlete starts working: its antenna spends part of every revolution behind a leg, and the
rider's body is between it and the laptop for half of each one. This is normal radio behaviour and not
a fault in the meter, so the app is built to ride it out rather than to avoid it:

- **One reconnection at a time per device.** Repeated drops used to start a reconnect loop each, and
  several of them would then call `connect()` on the same radio at once; the browser settles that by
  failing all but one, so the more often a meter dropped the less likely it was to come back. Extra
  drops now join the attempt already running.
- **A three-second ceiling on the backoff while recording**, against fifteen when idle. The meter is
  usually advertising again within a second, and every second spent waiting is a second of the power
  trace coming from the trainer's estimate instead.
- **A half-open link is thrown away rather than reused.** A link that comes back connected but whose
  service discovery fails would otherwise be retried down for the rest of the test.
- **Re-subscribing cannot double up.** Each session's notification handlers are dropped when it ends,
  so a device that reconnects ten times still reports each packet once.
- **The device row shows the dropout count**, and **Retry now** works while it is reconnecting rather
  than being greyed out until it has given up.

A meter that is dropping every few seconds is still worth investigating — a low coin cell and a loose
battery cover are the usual causes, in that order — and the count in the sensor panel is what tells
you that is what is happening. Power falling back to the trainer's own estimate is recorded as a
source change either way, so a trace never silently changes what it is measuring.

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

## TSI flow meter (wired)

A TSI 5300-series gas flow meter (tested on a 5330) on the one-way **expiratory** limb records exhaled
flow, gas temperature, relative humidity, absolute and circuit pressure, and the meter's running
volume. Desktop app only. Sensors → **TSI flow meter** → Connect.

**How it connects.** The meter's USB-C port is a network adapter: macOS gives the Mac a link-local
address on a /30 and the meter listens on TCP 3607 for TSI's documented ASCII command set
(P/N 6011697). No TSI software and no driver. The address is found automatically; type one only if
two meters are plugged in. An address that was typed is the only one tried.

**What is recorded.** Every row, at the chosen interval (1 to 100 ms, default 10 ms), goes straight
from the recording process to `flow.ndjson` in the session folder, in one-second blocks. The rows
never cross to the interface, which gets a summary four times a second for the tiles. The journal
gets an event for the meter's identity and for each command sent to it.

**Time.** Rows reach the computer in bursts, tens of milliseconds late and by a varying amount, so
arrival time is not when a row was measured. The meter samples on a fixed interval, so each 30 s
segment is anchored at the earliest time consistent with every arrival in it (`min(arrival − i·dt)`),
and row *i* is at `anchor + i·dt`. What remains is the ~1 ms network transport and the meter's own
averaging window. Re-anchoring every segment absorbs drift between the meter's clock and the Mac's.

**Gaps.** One stream command on the meter lasts exactly 30 s. The next is queued before the current
one ends, but the meter still needs about 0.1 s to restart. Those rows do not exist. Each `segment`
record says how many samples and milliseconds were lost and, from the meter's totalizer (which keeps
counting while nothing is sent), how much volume passed meanwhile. Zeroing or resetting stops the
stream for about half a second, recorded the same way.

**Controls.** *Zero pressure* zeroes the circuit-pressure sensor: no flow, ports open to the room.
*Reset volume* restarts the totalizer. The sample rate cannot change while a session is recording.

**Known limits of the meter, stated where they apply.**
- Direction sensing is off: reverse flow reads positive. Correct for a one-way limb, wrong for anything else.
- Flow is Std L/min of dry gas (21.11 °C, 101.3 kPa, humidity-compensated), not BTPS.
- The humidity sensor responds over seconds. It gives the trend across breaths, never within one.
- At 100 % RH water is condensing, and the reading means nothing. The panel says so and the tile blanks it.
- TSI states these meters are not medical devices and are not intended for human respiration measurements.

```
flow.ndjson   {"type":"meter", …}      identity and settings
              {"type":"block", "seg", "i0", "at0", "dt", "f", "tc", "p", "rh", "lp", "tot"}
              {"type":"segment", "seg", "anchorAt", "n", "dt", "start", "gapBefore": {samples, ms, volumeL}}
              {"type":"command", "command", "ok", …}
```

**Hardware check without the app.** `python3 tools/tsi5330.py info` prints the meter's identity and
settings over the same link; `record --rate 10 --duration 30` streams to a CSV. Python standard library only.

`at0` in a block is provisional; re-time rows from their segment's `anchorAt`. The research export
already does this.

**Analysis** lives in the ventilation project (`ventilation_code`, Data > TSI breaths, `R/tsi.R`):
import a research export there for breath detection, per-breath energy and water, and the check of
whether the sensors reached room air.

**Exports.** *Research export* writes one pseudonymised CSV on a **uniform time grid at the rate of
the fastest device** in the session (100 Hz with the TSI at 10 ms; 1 Hz when nothing is faster),
starting at the session start, plus its sidecar. Every measurement sits in the one row nearest the
moment it was taken and nowhere else: a 1 Hz heart rate appears once a second with blank rows
between, because those rows were not measured. Protocol state (step, phase, targets) is carried on
every row. Nothing is held or interpolated. Native-rate notifications are the source where the
journal has them, from the device that owned the metric at the time; otherwise the 1 Hz snapshot is
placed at its own second. The sidecar's `sampling` section gives the rate, every source with its
native interval, where each column came from, and what fell outside the grid; its `flowMeter`
section gives the meter, units, timing method, gaps and caveats. Format version 4. The plain
*Samples CSV* stays at 1 Hz and gains `exp_flow_l_min`, `exp_gas_temp_c`, `exp_rh_pct` and
`exp_flow_coverage`.

## Conditions (the room)

Cold, dry or CO₂-loaded air is a load the airway carries, so the room is part of the measurement and
not context around it. Every reading is kept with the time it was measured and where it came from
(`sensor`, `manual`, `mixed`, `import`), on its own slow clock and never resampled up to 1 Hz.

**Three ways in, one record.**
- **By hand.** *Conditions* on the dashboard. It can be filled in before Start, while the athlete is
  still warming up: the reading is held and goes in at the head of the recording when it opens. The
  form reopens on the last values, and anything a connected monitor knows is filled in for you.
- **From an Aranet4's own log, afterwards.** Analysis → *Conditions* → import the `.xlsx` or `.csv`
  the Aranet Home app exports. The monitor logs to its own memory whether or not anything is
  connected, so this needs nothing to work on the day. The readings that belong to the session are
  attached, plus one logging interval either side; importing the same file twice adds nothing. The
  date order is taken from the file's own header (`Time(DD/MM/YYYY H:mm:ss)`) and never guessed, and
  the times are the monitor's local clock read in this computer's time zone, which the record says.
  Set the monitor to a 1 minute interval on test days: at the default 5 minutes a twenty minute test
  gets four readings.
- **Live over Bluetooth.** *Room sensor (standard)* is any sensor with the Bluetooth Environmental
  Sensing service (temperature, humidity, pressure), read once a minute as one observation. The
  *Aranet4* profile is there too, but recent firmware wants a pairing the desktop app cannot drive,
  so whether it connects depends on the monitor in front of you. The file import does not.

**Inspired water.** The *Inspired water* tile and the `waterMgL` field in the research sidecar give
the water in each litre of room air, in mg/L, from temperature and humidity together (50% is about
10 mg/L at 23 °C and about 1 mg/L at −10 °C). Buck's saturation pressure and the ideal gas law for
the vapour, per litre of the air as it is: not BTPS, not dry gas, and barometric pressure does not
enter. It is the same arithmetic, constant for constant, as `tsi_water_content_mg_l()` in the
ventilation project, which also reads room air straight from the sidecar's `environment` array.

## Recordings

The desktop app records to an **append-only journal**: one JSON object per line, `fsync`ed before the
write returns. Nothing is ever rewritten, so the worst a crash can do is cut the final line.

```
~/Documents/testday/sessions/2026-08-12_07-31_session_xyz/
  journal.ndjson   one line per sample, appended live
  flow.ndjson      the TSI flow meter's rows, when one is connected (see above)
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

The desktop app makes **no internet requests at all**: non-local web requests are blocked outright and
there is no updater. The only socket it opens is to the TSI flow meter, over the meter's own USB link. Nothing about it can hang on a conference-centre network on the morning of a test.

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
the journal, and the TSI flow meter against a TCP emulator of the meter (bursty delivery, queued
commands, restart gaps, dropped links), with timing checked against each row's true sample time.

The journal tests are the ones that matter most, because a recording bug is not visible until the
recording is needed. They cover encoding round-trips, a truncated final line, a corrupt line in the
middle, resume positioning, and mirror verification. One test spawns a real child process, kills it
with `SIGKILL` mid-recording, and checks that every sample the recorder acknowledged is on disk with
no gaps: truncating a file by hand only tests the reader, not the durability claim.

```
npm test    # 446 tests
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
