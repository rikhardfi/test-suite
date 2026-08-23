# test-suite

A performance test-day suite for a physiology lab: build a protocol, drive a smart trainer or
treadmill over Bluetooth, record every sensor to disk as it happens, and get thresholds, critical
power and a mean-maximal curve out the other end.

The application lives in [`testday/`](testday/) and has its own detailed
[README](testday/README.md) covering the Bluetooth profiles, the recording format and the analysis
methods. This file covers the repository: what is here, how to run it, and the few things that are
easy to get wrong.

```
testday.command   double-clickable launcher, see below
testday/          the application (Electron + React + TypeScript)
docs/             design notes and the reviewed improvement document
tasks/            scratch notes, not tracked
```

## Quick start

Double-click **`testday.command`** in Finder, or from a terminal:

```bash
./testday.command            # build and run the app
./testday.command --dev      # hot reload, for working on it
./testday.command --check    # typecheck and tests, launch nothing
```

It installs npm dependencies on first run and needs the network once for that
and never again. It builds before launching rather than hot-reloading, so the
app is the same every time it starts and a typecheck failure stops it there
rather than surfacing as a blank window with an athlete already warming up.
Anything it cannot do, it says in a sentence you can act on.

Working on the code directly instead:

```bash
cd testday
npm install
python3 -m pip install -r tools/requirements.txt   # dev-only, see "Verifying FIT output"
npm run electron:dev
```

No hardware to hand? The sensor panel has a **Simulator**: a synthetic trainer and athlete that
answers ERG targets with a realistic first-order lag and drives a heart rate that lags power and
drifts upward above threshold. It works in any browser, and it is the right way to rehearse a
protocol before an athlete is on the bike.

## Commands

The launcher covers the common cases. These run from `testday/` when you want one directly.

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Desktop app with hot reload |
| `npm run electron:start` | Build, then run the built desktop app |
| `npm run dist` | Package a local `.app` into `release/` |
| `npm test` | The full suite, including the FIT verification below |
| `npm run verify:fit` | Just the FIT check against Garmin's profile |
| `npm run typecheck` | Renderer and main process, both tsconfigs |
| `npm run dev` | Browser build, `localhost:5173`, weaker storage |
| `npm run build` | Static bundle into `dist/` |

## Why it is a desktop app

Because a browser cannot append to a file. The desktop build writes every sample to an append-only
journal and `fsync`s it before the write returns, so a crash costs nothing and an interrupted
session is offered back for resume on the next launch. The browser build falls back to rewriting the
whole session into IndexedDB every 15 seconds; it exists for demos and for rehearsing with the
simulator. **Anything with an athlete on it belongs on the desktop app.**

The app makes **no network requests at all** — non-local requests are blocked outright and there is
no updater. Nothing about it can hang on a conference-centre network on the morning of a test.

## Verifying FIT output

`npm test` includes a check that decodes the app's own FIT export using
[`fitdecode`](https://pypi.org/project/fitdecode/) and Garmin's official profile.

This exists because the FIT round-trip test inside the repo shares none of the encoder's tables,
which catches a definition message that disagrees with its data, but structurally **cannot** catch a
wrong field number: the encoder and that reader address fields by the same constants, so they would
be wrong together and agree perfectly.

That gap is not hypothetical. Checking against a real decoder found two bugs the unit tests passed
clean:

- a `developer_data_id` whose field numbers were one apart, which made a strict decoder reject the
  entire file and every blood lactate and VO₂ value in it unreadable in any real tool;
- a scale offset applied in the wrong order, which turned an altitude of 0 m into −400 m: wrong, and
  plausible enough to survive into an analysis unnoticed.

So it runs by default and **fails loudly when the toolchain is missing** rather than skipping
quietly. A check that silently does not run is worse than no check, because it also tells you
everything is fine.

```bash
python3 -m pip install -r tools/requirements.txt   # or: npm run setup:tools
SKIP_FIT_VERIFY=1 npm test                          # opt out, visibly
```

Python is a **development dependency only**. The app itself contains no Python, has no runtime
dependencies beyond React, and still makes no network requests.

> **Re-run this whenever a message or field number in `src/model/fit.ts` changes.** The unit tests
> will not catch that class of mistake.

## Where recordings go

```
~/Documents/testday/
  sessions/<date>_<id>/journal.ndjson   one line per record, appended live and fsynced
  sessions/<date>_<id>/meta.json        cached summary, rewritten on close
  discarded/                            "removed" sessions; nothing is ever deleted
  logs/testday.log                      diagnostics, no participant data in it
  settings.json                         mirror folder, quit confirmation
```

A journal with no `closed` record is an interrupted session, which is the only signal the resume
flow needs. A second copy is written to a configurable folder **after** a session closes, verified by
size and SHA-256 before the app claims two copies exist: a file held open and continuously appended
is exactly what a sync client handles badly, so OneDrive never sees a live journal.

## Exports

| Format | For |
| --- | --- |
| **FIT** | Activity file with a lap per protocol step, and lactate, RPE, commanded targets, core temperature and the VO₂ estimate as developer data fields |
| **Samples CSV** | The 1 Hz series, one row per second, frozen column contract |
| **Research export** | Pseudonymised CSV plus a sidecar describing every column, every equation with its validated range, and the protocol both as written and as executed |
| **Laps CSV** | Step-level summary, which is what goes into a test report |
| **JSON** | The raw session record |

There is deliberately **no TCX**. It has nowhere to put blood lactate, RPE, a commanded target or an
oxygen estimate, so all of them used to stop at the CSV; it has no gradient field; and the exports it
produced were schema-invalid for want of a required `Calories` element. FIT carries all of it.

## A note on how this code is written

Two conventions run through the whole codebase and are worth knowing before changing anything:

**A missing value is not a zero.** A sensor that reported nothing records nothing, not `0`. A
resting athlete and a dead strap must not look alike in an analysis a year later.

**A number that cannot stand behind itself says so.** The gradient records whether it was measured
or assumed from what the machine was commanded. The VO₂ estimate carries the equation that produced
it and changes state outside that equation's validated range. HRV computed at 176 bpm is marked not
meaningful, because at that intensity the signal is mechanical and respiratory artefact rather than
autonomic tone. Percentage of maximum heart rate hides itself when no maximum has been recorded
rather than guessing 220 minus age, which would be a fact about the population wearing this
athlete's name. Thresholds carry leave-one-out bands, and where two tests' bands overlap the verdict
is that the test cannot tell them apart.

Tests exist for the parts where being wrong is silent: characteristic parsing, the runner's timing
and ERG behaviour, every threshold method against a synthetic step test, and above all the journal.
One test spawns a real child process, kills it with `SIGKILL` mid-recording, and checks that every
sample the recorder acknowledged is on disk with no gaps. Truncating a file by hand only tests the
reader.

## Repository notes

**`node_modules` must stay outside OneDrive.** This repository lives at `~/test-suite` rather than in
the synced folder for exactly that reason: `npm install` inside a synced directory makes the macOS
File Provider stall on every content read, and `tsc` and `vitest` hang.

**The website is not here.** `hengitystutkimus.fi` lives in its own repository,
[`rikhardfi/hengitystutkimus-fi`](https://github.com/rikhardfi/hengitystutkimus-fi), which is what
Cloudflare Pages deploys. This repository began as a copy of it, so an Astro site, a WordPress-era
redirect table and a Hugo migration handover sat here for a while, deploying nothing. They were
removed once confirmed identical to the live repository at the same commit, and stripped from this
repository's history before it was made public.

## Outstanding, waiting on hardware

- **Tymewear.** Ventilation and breathing rate exist as first-class metrics and the capture tooling
  is built, but the parser has to be reversed from a trace: there is no published profile. Sensor
  panel → *Capture an unknown device*, then *Save trace*.
- **Aranet4.** The parser and interval polling are written. Whether recent firmware will hand a
  reading to Web Bluetooth at all depends on whether it demands bonding, which Web Bluetooth cannot
  drive. The manual conditions form works either way, which is why nothing is gated on it.
- **The unverified hardware checks** in `tasks/todo.md`: a real CORE sensor against the parser, a
  VO₂-targeted run step actually driving a treadmill, and one `kill -9` resume rehearsal on the
  machine that will be used on the day.

## Licence

MIT.
