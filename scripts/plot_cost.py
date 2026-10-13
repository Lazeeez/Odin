import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLISHED = ROOT / "docs" / "data" / "published_cost_accuracy.json"
CASCADE = ROOT / "results" / "perf" / "cascade_2026-10-13.json"
BATCHING = ROOT / "results" / "perf" / "bench_batching_2026-10-13.json"
PROTOCOL = ROOT / "results" / "comparison" / "locagent-lite_2026-10-13.json"
OUT = ROOT / "docs" / "img" / "cost-accuracy.svg"

WIDTH, HEIGHT = 860, 500
LEFT, RIGHT, TOP, BOTTOM = 64, 24, 64, 56
X_RANGE = (0.001, 2.0)
Y_RANGE = (60.0, 92.0)
X_TICKS = (0.001, 0.01, 0.1, 1.0)
Y_TICKS = (60, 70, 80, 90)
SURFACE, INK, SECONDARY, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e7e6e2"
SERIES = {"published": "#2a78d6", "odin": "#eb6834"}
LEGEND = {"published": "Published systems, as reported", "odin": "Odin, measured on a laptop GPU"}


def odin_costs() -> dict:
    published = json.loads(PUBLISHED.read_text(encoding="utf-8"))
    dollars_per_second = published["gpu_price"]["dollars_per_hour"] / 3600
    cascade = json.loads(CASCADE.read_text(encoding="utf-8"))
    seconds = cascade["summary"]["total"]["mean_ms"] / 1000
    throughput = next(
        float(line.split()[-2])
        for line in json.loads(BATCHING.read_text(encoding="utf-8"))["output"]
        if line.startswith("token budget 4096")
    )
    embed_seconds = cascade["mean_units_in_snapshot"] / throughput
    stages = json.loads(PROTOCOL.read_text(encoding="utf-8"))["stages"]
    accuracy = 100 * stages["ltr-ce-notests"]["acc"]["function"]["acc@10"]
    return {
        "seconds_per_issue": seconds,
        "embed_seconds_per_repository": embed_seconds,
        "dollars_per_issue": seconds * dollars_per_second,
        "dollars_first_issue": (seconds + embed_seconds) * dollars_per_second,
        "function_acc_at_10": accuracy,
    }


def x_of(cost: float) -> float:
    lo, hi = (math.log10(v) for v in X_RANGE)
    return LEFT + (math.log10(cost) - lo) / (hi - lo) * (WIDTH - LEFT - RIGHT)


def y_of(accuracy: float) -> float:
    lo, hi = Y_RANGE
    return HEIGHT - BOTTOM - (accuracy - lo) / (hi - lo) * (HEIGHT - TOP - BOTTOM)


def text(x, y, body, size=12, fill=SECONDARY, anchor="start", weight="400") -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" '
        f'text-anchor="{anchor}" font-weight="{weight}">{body}</text>'
    )


def point(series: str, cost: float, accuracy: float, label: str, side: str, shift: int) -> str:
    x, y = x_of(cost), y_of(accuracy)
    offset = 10 if side == "right" else -10
    anchor = "start" if side == "right" else "end"
    ours = series == "odin"
    caption = text(
        x + offset,
        y + 4 + shift,
        label,
        fill=INK if ours else SECONDARY,
        anchor=anchor,
        weight="600" if ours else "400",
    )
    mark = (
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{SERIES[series]}" '
        f'stroke="{SURFACE}" stroke-width="2"/>'
    )
    hint = f"<title>{label}: ${cost:.2g} per issue, {accuracy:.1f}%</title>"
    return f"<g>{hint}{mark}{caption}</g>"


def render() -> str:
    published = json.loads(PUBLISHED.read_text(encoding="utf-8"))
    odin = odin_costs()
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" '
        f'aria-label="Function-level accuracy against cost per issue on SWE-bench Lite">',
        f'<rect width="{WIDTH}" height="{HEIGHT}" fill="{SURFACE}"/>',
        text(LEFT, 26, "Accuracy against cost per issue, SWE-bench Lite", 16, INK, weight="600"),
        text(LEFT, 46, "Function Acc@10 under the LocAgent protocol (274 issues)", 12),
    ]
    for tick in Y_TICKS:
        y = y_of(tick)
        parts.append(
            f'<line x1="{LEFT}" x2="{WIDTH - RIGHT}" y1="{y:.1f}" y2="{y:.1f}" stroke="{GRID}"/>'
        )
        parts.append(text(LEFT - 8, y + 4, f"{tick}%", 11, MUTED, "end"))
    for tick in X_TICKS:
        parts.append(text(x_of(tick), HEIGHT - BOTTOM + 18, f"${tick:g}", 11, MUTED, "middle"))
    parts.append(
        text(
            (LEFT + WIDTH - RIGHT) / 2,
            HEIGHT - 12,
            "Cost per issue in US dollars, log scale",
            11,
            MUTED,
            "middle",
        )
    )
    legend_x = WIDTH - RIGHT - 250
    for row, (series, label) in enumerate(LEGEND.items()):
        y = 22 + 20 * row
        parts.append(f'<circle cx="{legend_x}" cy="{y}" r="5" fill="{SERIES[series]}"/>')
        parts.append(text(legend_x + 12, y + 4, label, 12))
    for system in published["systems"]:
        parts.append(
            point(
                "published",
                system["dollars_per_issue"],
                system["function_acc_at_10"],
                system["label"],
                system["label_side"],
                system.get("label_shift", 0),
            )
        )
    x0, x1 = x_of(odin["dollars_per_issue"]), x_of(odin["dollars_first_issue"])
    y = y_of(odin["function_acc_at_10"])
    parts.append(
        f'<line x1="{x0:.1f}" x2="{x1:.1f}" y1="{y:.1f}" y2="{y:.1f}" '
        f'stroke="{SERIES["odin"]}" stroke-width="2"/>'
    )
    parts.append(
        point("odin", odin["dollars_per_issue"], odin["function_acc_at_10"], "Odin", "left", 0)
    )
    parts.append(
        point(
            "odin",
            odin["dollars_first_issue"],
            odin["function_acc_at_10"],
            "Odin, first issue on a repository",
            "right",
            16,
        )
    )
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def main() -> int:
    if "--numbers" in sys.argv:
        print(json.dumps(odin_costs(), indent=1))
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
