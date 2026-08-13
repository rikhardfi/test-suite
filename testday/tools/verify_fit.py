#!/usr/bin/env python3
"""
Decodes a FIT file written by this app using an independent decoder and the
official Garmin profile, and checks that every field means what the encoder
thought it meant.

Why this exists as a separate tool rather than another vitest case:

`fit.test.ts` decodes the output with a reader that shares none of the
encoder's tables, which catches a definition message that disagrees with the
data behind it. What it structurally cannot catch is a *wrong field number*,
because the encoder and that reader would be wrong together and agree with each
other perfectly.

Only a decoder carrying Garmin's own profile can catch that class of mistake,
and it has caught two already:

  * `developer_data_id` had manufacturer_id and developer_data_index one field
    apart, so the index was registered under the manufacturer's value, every
    field_description referred to an index that was never declared, and a
    strict decoder rejected the whole file. Every lactate and VO2 value would
    have been unreadable in any real tool.
  * Scaled fields applied their offset after the scale rather than before. FIT
    reads a field back as stored/scale - offset, so an altitude of 0 m was
    stored as 500 and read back as -400 m: wrong, and plausible enough to
    survive into an analysis unnoticed.

Both have regression tests now. This exists so the *next* one is caught too.

Run it through `npm run verify:fit`, which builds the fixture first. It reads a
file and a JSON file of expectations, so the fixture and the expectations are
both defined in TypeScript beside the encoder rather than duplicated here.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict

try:
    import fitdecode
except ImportError:
    print(
        "fitdecode is not installed.\n"
        "  python3 -m pip install -r tools/requirements.txt\n"
        "It is a development dependency only: the app itself has no Python in it "
        "and makes no network requests.",
        file=sys.stderr,
    )
    raise SystemExit(2)


class Failures:
    """Collects every disagreement rather than stopping at the first."""

    def __init__(self) -> None:
        self.items: list[str] = []

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.items.append(message)

    def equal(self, actual, expected, what: str, tolerance: float | None = None) -> None:
        if tolerance is not None and isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
            ok = abs(actual - expected) <= tolerance
        else:
            ok = actual == expected
        if not ok:
            self.items.append(f"{what}: expected {expected!r}, decoded {actual!r}")


def fields_of(frame) -> dict:
    return {field.name: field.value for field in frame.fields}


def units_of(frame) -> dict:
    return {field.name: field.units for field in frame.fields}


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: verify_fit.py <file.fit> <expected.json>", file=sys.stderr)
        return 2

    fit_path, expected_path = sys.argv[1], sys.argv[2]
    with open(expected_path, encoding="utf-8") as handle:
        expected = json.load(handle)

    messages: dict[str, list] = defaultdict(list)
    counts: Counter = Counter()

    # A parse error here is itself the finding, and the most serious one
    # available: a file a real decoder refuses is a file no tool will open,
    # whatever this app's own reader thinks of it. Reported as a finding rather
    # than as a traceback, because a traceback reads as a broken checker.
    try:
        with fitdecode.FitReader(fit_path) as reader:
            for frame in reader:
                if frame.frame_type == fitdecode.FIT_FRAME_DATA:
                    messages[frame.name].append(frame)
                    counts[frame.name] += 1
    except fitdecode.FitError as error:
        print(
            f"FIT verification FAILED: the file is not readable at all.\n\n"
            f"  {type(error).__name__}: {error}\n\n"
            "This is worse than a wrong value. A file a conforming decoder refuses "
            "will not open in TrainingPeaks, Garmin Connect or anything else, "
            "however well the in-repo reader handles it.",
            file=sys.stderr,
        )
        return 1

    f = Failures()

    # --- structure ---
    for name, count in expected["counts"].items():
        f.equal(counts.get(name, 0), count, f"count of {name} messages")

    # --- file identity ---
    file_id = fields_of(messages["file_id"][0])
    f.equal(file_id.get("type"), "activity", "file_id.type")
    f.equal(file_id.get("manufacturer"), "development", "file_id.manufacturer")
    f.equal(file_id.get("product_name"), expected["appName"], "file_id.product_name")
    f.check(file_id.get("time_created") is not None, "file_id.time_created is missing")

    # --- sport ---
    sport = fields_of(messages["sport"][0])
    f.equal(sport.get("sport"), expected["sport"], "sport.sport")
    f.equal(sport.get("sub_sport"), expected["subSport"], "sport.sub_sport")

    # --- records ---
    records = [fields_of(frame) for frame in messages["record"]]
    first, last = records[0], records[-1]

    for key, want in expected["firstRecord"].items():
        f.equal(first.get(key), want, f"first record.{key}", tolerance=0.01)
    for key, want in expected["lastRecord"].items():
        f.equal(last.get(key), want, f"last record.{key}", tolerance=0.01)

    # Units come from the profile, so this checks the field number resolved to
    # the field we meant and not merely to something of the right size.
    record_units = units_of(messages["record"][0])
    for key, unit in expected["recordUnits"].items():
        f.equal(record_units.get(key), unit, f"record.{key} units")

    # Timestamps must be strictly increasing, or the file is unreadable as a
    # time series however well each individual record decodes.
    stamps = [r.get("timestamp") for r in records]
    f.check(all(b > a for a, b in zip(stamps, stamps[1:])), "record timestamps are not increasing")

    # --- developer fields ---
    declared = {fields_of(frame)["field_name"]: fields_of(frame) for frame in messages["field_description"]}
    for name, spec in expected["developerFields"].items():
        f.check(name in declared, f"developer field {name!r} was never declared")
        if name in declared:
            f.equal(declared[name].get("units"), spec["units"], f"developer field {name} units")

    for key, want in expected["firstRecordDev"].items():
        f.equal(first.get(key), want, f"first record dev.{key}", tolerance=0.01)

    # --- laps ---
    laps = [fields_of(frame) for frame in messages["lap"]]
    for index, want in enumerate(expected["laps"]):
        for key, value in want.items():
            f.equal(laps[index].get(key), value, f"lap[{index}].{key}", tolerance=0.51)

    # A lap per protocol step, cut where the step changed, in order.
    starts = [lap.get("start_time") for lap in laps]
    f.check(all(b > a for a, b in zip(starts, starts[1:])), "lap start times are not increasing")

    # --- session ---
    session = fields_of(messages["session"][0])
    for key, want in expected["session"].items():
        f.equal(session.get(key), want, f"session.{key}", tolerance=0.51)

    # --- events bracket the records ---
    events = [fields_of(frame) for frame in messages["event"]]
    f.equal(events[0].get("event_type"), "start", "first event is a timer start")
    f.equal(events[-1].get("event_type"), "stop_all", "last event is a timer stop")

    # --- report ---
    if f.items:
        print(f"FIT verification FAILED against fitdecode {fitdecode.__version__}\n", file=sys.stderr)
        for item in f.items:
            print(f"  - {item}", file=sys.stderr)
        print(
            "\nA disagreement here usually means a field number in src/model/fit.ts "
            "does not mean what the profile says it means.",
            file=sys.stderr,
        )
        return 1

    print(f"FIT verified against fitdecode {fitdecode.__version__} and the Garmin profile.")
    for name, count in sorted(counts.items()):
        print(f"  {count:>5}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
