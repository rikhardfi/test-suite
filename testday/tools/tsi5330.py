#!/usr/bin/env python3
"""Check a TSI 5300-series flow meter (tested on a 5330) from the command line.

A hardware check, not the recorder: testday records the meter (Sensors > TSI
flow meter). Use this to confirm the USB link and the stream before a test day,
without starting the app.

On macOS the meter's USB-C port appears as a USB network adapter with a
link-local address; the meter listens for TSI's documented ASCII command set
(P/N 6011697) on TCP port 3607. Python standard library only.

    python3 tsi5330.py info
    python3 tsi5330.py record --rate 10 --duration 120 --out test.csv
    python3 tsi5330.py record --rate 1            # until Ctrl-C

Every record writes a CSV plus a <name>.json with the meter's identity,
settings and every gap between streaming segments.
"""

import argparse
import csv
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime

PORT = 3607
SEGMENT_S = 30            # DmFTPHLI0000 streams exactly 30 s, then stops
COLUMNS = ["time_s", "host_time_s", "segment",
           "flow_L_min", "temperature_C", "pressure_kPa",
           "humidity_pct_RH", "low_pressure_cmH2O", "totalizer_L"]


def find_meter():
    """Find the meter on a link-local /30 USB interface by probing port 3607."""
    out = subprocess.run(["ifconfig"], capture_output=True, text=True).stdout
    for c, d in re.findall(r"inet 169\.254\.(\d+)\.(\d+) netmask 0xfffffffc", out):
        base = int(d) & ~3
        for host in (base + 1, base + 2):
            if host == int(d):
                continue
            ip = f"169.254.{c}.{host}"
            try:
                socket.create_connection((ip, PORT), timeout=1).close()
                return ip
            except OSError:
                pass
    sys.exit("No TSI meter found. Is it on and connected by USB-C? (or pass --host)")


class Meter:
    def __init__(self, host):
        self.sock = socket.create_connection((host, PORT), timeout=5)
        self.buf = b""
        self.stop_stream()

    def _recv(self, timeout):
        self.sock.settimeout(timeout)
        data = self.sock.recv(65536)
        if not data:
            raise ConnectionError("meter closed the connection")
        self.buf += data

    def readline(self, timeout=2.0):
        """One line without CR/LF, or None if nothing complete arrives in time."""
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buf:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                self._recv(remaining)
            except (socket.timeout, TimeoutError):
                return None
        line, self.buf = self.buf.split(b"\n", 1)
        return line.strip().decode("ascii", "replace")

    def send(self, cmd):
        self.sock.sendall(cmd.encode("ascii") + b"\r")

    def stop_stream(self):
        """BREAK, then discard whatever is still in flight.

        A stream keeps running after its connection closes and is delivered
        to the next connection, so every session starts and ends with this.
        """
        self.send("BREAK")
        while True:
            try:
                self._recv(0.5)
            except (socket.timeout, TimeoutError):
                break
        self.buf = b""

    def set(self, cmd):
        self.send(cmd)
        ack = self.readline()
        if ack != "OK":
            raise RuntimeError(f"{cmd} -> {ack!r}")

    def query(self, cmd):
        """Send a read command; return the value line that follows OK."""
        self.set(cmd)
        return self.readline() or ""

    def close(self):
        self.sock.close()


def read_info(m):
    keys = {"model": "MN", "serial": "SN", "firmware": "REV", "hardware": "HREV",
            "calibration_date": "DATE", "sample_rate_ms": "RSR", "gas": "RG",
            "flow_units": "RU", "humidity_compensation": "RCH",
            "direction_sensor": "RCD", "half_inch_end_correction": "RCE",
            "user_std_temperature_C": "RST", "user_std_pressure_kPa": "RSP"}
    return {k: m.query(c) for k, c in keys.items()}


def cmd_info(args):
    m = Meter(args.host)
    try:
        for k, v in read_info(m).items():
            print(f"{k:28s} {v}")
    finally:
        m.close()


def cmd_record(args):
    out = args.out or datetime.now().strftime("tsi_%Y%m%d_%H%M%S.csv")
    meta_path = re.sub(r"\.csv$", "", out) + ".json"
    m = Meter(args.host)
    info = read_info(m)
    original_rate = info["sample_rate_ms"]
    dt = args.rate / 1000
    per_segment = SEGMENT_S * 1000 // args.rate
    m.set(f"SSR{args.rate:04d}")
    if args.units:
        m.set(f"SU{args.units}")
    info["sample_rate_ms"] = str(args.rate)
    info["flow_units"] = m.query("RU")
    if args.direction_on:
        m.set("SCD1")
        info["direction_sensor"] = m.query("RCD")
    if info["direction_sensor"] == "0":
        print("Note: flow direction sensor is OFF on the meter; reverse flow reads positive "
              "(enable with --direction-on).", file=sys.stderr)

    meta = {"started": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "meter": info, "columns": COLUMNS, "segments": [],
            "notes": ["time_s = segment start (arrival of its first sample) + index * sample rate",
                      "host_time_s = arrival time on the computer (network-jittered)",
                      "serial units of humidity, low pressure and totalizer are not stated in the "
                      "command set; labels assume the meter's factory display units"]}
    t0 = time.monotonic()
    n_total = 0
    stop_at = t0 + args.duration if args.duration else None
    last_print = t0
    print(f"Recording to {out} at {args.rate} ms; Ctrl-C to stop.", file=sys.stderr)
    f = open(out, "w", newline="")
    w = csv.writer(f)
    w.writerow(COLUMNS)
    try:
        seg = 0
        while stop_at is None or time.monotonic() < stop_at:
            m.send("DCFTPHLI0000")
            if m.readline(timeout=2.0) != "OK":      # command lost at a segment boundary
                m.stop_stream()
                continue
            seg_start = None
            i = 0
            while i < per_segment:
                line = m.readline(timeout=max(2.0, 20 * dt))
                if line is None:
                    break
                now = time.monotonic() - t0
                parts = line.split(",")
                if len(parts) != 6:
                    continue
                if seg_start is None:
                    seg_start = now
                w.writerow([f"{seg_start + i * dt:.4f}", f"{now:.4f}", seg] + parts)
                i += 1
                if stop_at is not None and time.monotonic() >= stop_at:
                    break
                if time.monotonic() - last_print >= 1:
                    last_print = time.monotonic()
                    print(f"\r{now:8.1f} s  flow {parts[0]:>8} L/min  T {parts[1]} °C  "
                          f"RH {parts[3]} %", end="", file=sys.stderr)
            if seg_start is not None:
                meta["segments"].append({"segment": seg, "start_s": round(seg_start, 4),
                                         "samples": i,
                                         "last_arrival_s": round(time.monotonic() - t0, 4)})
                n_total += i
                seg += 1
            if i < per_segment:
                if stop_at is None or time.monotonic() < stop_at:
                    print("\nStream ended early; restarting.", file=sys.stderr)
                m.stop_stream()
            else:
                time.sleep(0.02)                     # let the meter settle before the next command
    except KeyboardInterrupt:
        pass
    finally:
        f.close()
        try:
            m.stop_stream()
            m.set(f"SSR{int(original_rate):04d}")
        except Exception:
            pass
        m.close()
        segs = meta["segments"]
        gaps = [round(b["start_s"] - (a["start_s"] + a["samples"] * dt), 4)
                for a, b in zip(segs, segs[1:])]
        meta["gaps_between_segments_s"] = gaps
        meta["samples"] = n_total
        with open(meta_path, "w") as jf:
            json.dump(meta, jf, indent=2)
        gap_txt = f", gaps between segments {min(gaps)*1000:.0f}-{max(gaps)*1000:.0f} ms" if gaps else ""
        print(f"\nSaved {n_total} samples to {out} ({len(segs)} segment(s){gap_txt}); "
              f"metadata in {meta_path}", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", help="meter IP (default: auto-detect on the USB link)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="print meter identity and settings")
    r = sub.add_parser("record", help="stream all channels to CSV")
    r.add_argument("--rate", type=int, default=10, help="ms per sample, 1-1000 (default 10)")
    r.add_argument("--duration", type=float, help="seconds (default: until Ctrl-C)")
    r.add_argument("--out", help="CSV path (default: tsi_YYYYmmdd_HHMMSS.csv)")
    r.add_argument("--units", choices=["S", "V"], help="flow units: S standard, V volumetric")
    r.add_argument("--direction-on", action="store_true", help="enable the bi-directional sensor")
    args = p.parse_args()
    if args.cmd == "record" and not 1 <= args.rate <= 1000:
        p.error("--rate must be 1-1000 ms")
    args.host = args.host or find_meter()
    {"info": cmd_info, "record": cmd_record}[args.cmd](args)


if __name__ == "__main__":
    main()
