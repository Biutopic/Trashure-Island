"""Export Trashure Island research runs from the server's "runs" room.

Pages through ?action=runs_export, regroups the ~15 s chunks by run id
and writes one JSON file per run (chunks merged in order) plus a summary.

    set TI_ADMIN_TOKEN=...            (the Worker's ADMIN_TOKEN secret)
    python scripts/export_runs.py --out runs_export
    python scripts/export_runs.py --base http://127.0.0.1:8787/parties/main/runs --out runs_local

Exports stay out of git (.gitignore: runs_export*/). Format: docs/RUNS_SCHEMA.md.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict

DEFAULT_BASE = "https://trashure-island.elven-6eb.workers.dev/parties/main/runs"


def fetch_all(base, token, page_size):
    after = ""
    while True:
        q = {"action": "runs_export", "token": token, "limit": page_size}
        if after:
            q["after"] = after
        with urllib.request.urlopen(base + "?" + urllib.parse.urlencode(q), timeout=60) as r:
            page = json.load(r)
        if not page.get("ok"):
            sys.exit("export failed: %s" % page.get("err"))
        yield from page["rows"]
        after = page.get("next")
        if not after:
            return


def strip_score(chunk):
    """Schema v1 recorded the score, which leads back to the public leaderboard."""
    if chunk["v"] >= 2:
        return
    chunk["f"] = [row[:7] + [None] + row[8:] for row in chunk["f"]]
    if chunk.get("end"):
        chunk["end"].pop("score", None)


def merge(chunks):
    chunks.sort(key=lambda c: c["seq"])
    for c in chunks:
        strip_score(c)
    run = {"rid": chunks[0]["rid"], "v": chunks[0]["v"], "hdr": None, "end": None,
           "chunks": len(chunks), "seqs": [c["seq"] for c in chunks],
           "f": [], "o": [], "e": []}
    for c in chunks:
        run["hdr"] = run["hdr"] or c.get("hdr")
        run["end"] = c.get("end") or run["end"]
        run["f"] += c["f"]
        run["o"] += c["o"]
        run["e"] += c["e"]
    # A run is complete only if it ended normally and no chunk is missing.
    run["complete"] = bool(run["end"] and run["end"].get("reason") == "complete"
                           and run["seqs"] == list(range(len(chunks))))
    return run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--out", default="runs_export")
    ap.add_argument("--page", type=int, default=50)
    args = ap.parse_args()
    token = os.environ.get("TI_ADMIN_TOKEN")
    if not token:
        sys.exit("set TI_ADMIN_TOKEN")

    by_rid = defaultdict(list)
    for row in fetch_all(args.base, token, args.page):
        by_rid[row["rid"]].append(row)

    os.makedirs(args.out, exist_ok=True)
    summary = defaultdict(int)
    for rid, chunks in by_rid.items():
        run = merge(chunks)
        with open(os.path.join(args.out, rid + ".json"), "w", encoding="utf-8") as fh:
            json.dump(run, fh, separators=(",", ":"))
        hdr = run["hdr"] or {}
        summary["runs"] += 1
        summary["complete" if run["complete"] else "partial"] += 1
        summary["mode:" + str(hdr.get("mode"))] += 1
        summary["device:" + str(hdr.get("device"))] += 1
        summary["event:" + (hdr.get("event") or "-")] += 1
    for k in sorted(summary):
        print("%-28s %d" % (k, summary[k]))


if __name__ == "__main__":
    main()
