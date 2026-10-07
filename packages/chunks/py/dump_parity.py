"""Dump chunkgen.py outputs for the TypeScript parity test.

    python3 -I packages/chunks/py/dump_parity.py > packages/chunks/src/__fixtures__/chunkgen-parity.json

Reads the audit prototype (audit-prototypes/generators/chunkgen.py) next to
the pewter-ghost checkout. Each record: params, ASCII rows (# solid), coins,
slimes, desc, and reachpy's verdicts (faithful and arc_min) for reference.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "audit-prototypes", "generators"))
sys.path.insert(0, GEN)
from chunkgen import gen  # noqa: E402
from reachpy import exit_reachable  # noqa: E402

out = []
cases = []
for diff in range(1, 6):
    for theme in ("mixed", "timing", "reward", "breather"):
        for seed in (0, 1, 2, 7, 42, 1234):
            cases.append(dict(W=24, H=12, difficulty=diff, theme=theme, seed=seed, ground=8))
# Other sizes and grounds.
for seed in range(6):
    cases.append(dict(W=16, H=12, difficulty=3, theme="mixed", seed=seed, ground=6))
    cases.append(dict(W=40, H=20, difficulty=4, theme="timing", seed=seed, ground=15))
for c in cases:
    W, H = c["W"], c["H"]
    r = gen(W, H, difficulty=c["difficulty"], theme=c["theme"], seed=c["seed"], ground=c["ground"])
    rows = ["".join("#" if v else "." for v in row) for row in r["grid"]]
    out.append({
        **c,
        "rows": rows,
        "coins": [list(p) for p in r["coins"]],
        "slimes": [list(p) for p in r["slimes"]],
        "desc": r["desc"],
        "exit": exit_reachable(r["grid"], (0, c["ground"] - 1)),
        "exitArcMin": exit_reachable(r["grid"], (0, c["ground"] - 1), arc_min=True),
    })
json.dump(out, sys.stdout, separators=(",", ":"))
