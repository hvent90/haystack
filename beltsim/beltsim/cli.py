"""beltsim CLI: simulate / bake / plots / all.

  uv run beltsim simulate presets/default.json [--shards N]
  uv run beltsim plots runs/default
  uv run beltsim bake runs/default
  uv run beltsim all presets/default.json
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="beltsim", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sim = sub.add_parser("simulate", help="run the N-body sim for a preset")
    p_sim.add_argument("preset")
    p_sim.add_argument("--shards", type=int, default=None)

    p_plots = sub.add_parser("plots", help="render diagnostic plots for a run dir")
    p_plots.add_argument("run_dir")

    p_bake = sub.add_parser("bake", help="bake a run into runtime artifacts")
    p_bake.add_argument("run_dir")

    p_val = sub.add_parser("validate", help="statistical checks (gaps, power law, clustering)")
    p_val.add_argument("run_dir")

    p_all = sub.add_parser("all", help="simulate + plots + bake end to end")
    p_all.add_argument("preset")
    p_all.add_argument("--shards", type=int, default=None)

    args = parser.parse_args()

    if args.cmd == "simulate":
        from .simulate import run

        out = run(args.preset, n_shards=args.shards)
        print(f"run dir: {out}")
    elif args.cmd == "plots":
        from .plots import render

        for p in render(args.run_dir):
            print(p)
    elif args.cmd == "bake":
        from .bake import bake

        for p in bake(args.run_dir):
            print(p)
    elif args.cmd == "validate":
        from .validate import validate

        validate(args.run_dir)
    elif args.cmd == "all":
        from .simulate import run

        out = run(args.preset, n_shards=args.shards)
        from .plots import render

        for p in render(out):
            print(p)
        from .bake import bake

        for p in bake(out):
            print(p)


if __name__ == "__main__":
    main()
