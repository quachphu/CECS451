"""Step 13: final evaluation summary.

    python3 ml/evaluate.py

Reads the results each step wrote (eval/results/*.json and the run manifest)
and writes eval/results/summary.md. Computes nothing new; a missing input is
reported as "not run yet".
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.common import RunManifest, eval_dir, read_json, read_jsonl, write_atomic  # noqa: E402


def load(name: str):
    path = eval_dir("results", name)
    return read_json(path) if path.exists() else None


def f(v, digits: int = 3) -> str:
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def ci(m: dict, key: str) -> str:
    c = (m.get("ci95") or {}).get(key)
    return f"{f(m.get(key))} [{f(c[0])}, {f(c[1])}]" if c else f(m.get(key))


def table(header: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" if i == 0 else "---:" for i in range(len(header))) + " |"]
    out += ["| " + " | ".join(f(c) if not isinstance(c, str) else c for c in r) + " |" for r in rows]
    return "\n".join(out)


def section_funnel(lines: list[str]) -> None:
    lines.append("## 1. Data funnel\n")
    funnel = load("data_funnel.json")
    if not funnel:
        lines.append("Not run yet (scripts/data/08_build_tables.ts).\n")
        return
    cities = list(funnel["funnel"].keys())
    steps = list(funnel["funnel"]["all"].keys())
    lines.append(table(["Step", *cities], [[s.replace("_", " "), *[funnel["funnel"][c][s] for c in cities]] for s in steps]))
    lines.append("")
    ex = funnel.get("exclusions", {})
    lines.append(f"Exclusions: confidence {ex.get('confidence', {})}; discovery {ex.get('discovery', {})}.\n")


def section_teacher(lines: list[str]) -> None:
    lines.append("## 2. Teacher quality (gold venues)\n")
    q = load("teacher_quality.json")
    if not q:
        lines.append("Not run yet (scripts/data/07_ingest_review.ts).\n")
        return
    if q.get("gate", {}).get("basis") == "attestation":
        lines.append(q.get("attestation", q["gate"].get("statement", "")))
        lines.append("")
        lines.append("The gate passed on this attestation. Per-item human accuracy and Cohen's kappa are not reported.")
        lines.append("")
        agreement = q.get("teacher_teacher_agreement")
        if agreement:
            lines.append(
                table(
                    ["Teacher-teacher agreement", "Value"],
                    [
                        ["Venues compared", agreement["venues"]],
                        ["hosts_private_events", agreement["hosts_private_events_agreement"]],
                        ["status", agreement["status_agreement"]],
                        ["Sonnet figures within 10% of an Opus figure", agreement["sonnet_figures_within_10pct_of_an_opus_figure"]],
                        ["Opus figures within 10% of a Sonnet figure", agreement["opus_figures_within_10pct_of_a_sonnet_figure"]],
                    ],
                )
            )
            lines.append("")
        return
    d = q["double_review"]
    lines.append(
        table(
            ["Metric", "Value"],
            [
                ["Venue accuracy (hosts private events)", q["venue_accuracy_hosts_private_events"]],
                ["Room precision", q["room_precision"]],
                ["Room recall", q["room_recall"]],
                ["Double-reviewed venues", d["venues"]],
                ["Cohen's kappa (hosts private events)", d["kappa_hosts_private_events"]],
                ["Double-review rooms agreeing within 10%", d["rooms_capacity_agree_within_10pct"]],
                ["Unclear venues judged justified", q["unclear_justified_rate"]],
                ["Gate (precision and accuracy >= 0.90)", "passed" if q["gate"]["passed"] else "FAILED"],
            ],
        )
    )
    lines.append("")


def section_extraction(lines: list[str]) -> None:
    lines.append("## 3. Extraction on gold\n")
    e = load("extraction_eval.json")
    if not e:
        lines.append("Not run yet (scripts/data/09_eval_extraction.ts).\n")
        return
    names = {
        "v0_regex_max": "v0 regex max",
        "regex_candidates": "Regex candidates",
        "grok_single_read": "Grok, single read",
        "grok_grounded_sc": "Grok + grounding + self-consistency",
    }
    for key, title in (("test_gold", "All gold"), ("test_la_gold", "LA gold")):
        lines.append(f"**{title}**\n")
        lines.append(
            table(
                ["Method", "Precision", "Recall", "F1", "Within 10%", "Invented-number rate", "Predicted"],
                [
                    [n, s["precision"], s["recall"], s["f1"], s["accuracy_within_10pct"], s["invented_rate"], s["predicted"]]
                    for m, n in names.items()
                    for s in [e[key][m]]
                ],
            )
        )
        lines.append("")
    lines.append(f"{e['note']} Estimates left out: {e['v0_estimates_left_out']}.\n")


def metric_rows(entries: dict, set_name: str) -> list[list]:
    rows = []
    for name, sets in entries.items():
        m = sets.get(set_name, {})
        if not m.get("n"):
            continue
        rows.append([name, m["n"], ci(m, "log_loss"), ci(m, "brier"), ci(m, "auc"), ci(m, "ece_width"), f(m.get("ece_mass")), f(m.get("accuracy"))])
    return rows


HEAD = ["Model", "n", "Log loss [95% CI]", "Brier", "AUC", "ECE (width)", "ECE (mass)", "Accuracy"]


def section_confidence(lines: list[str]) -> dict | None:
    lines.append("## 4. Confidence model vs. baselines\n")
    c = load("confidence_model.json")
    if not c:
        lines.append("Not run yet (ml/train_confidence.py).\n")
        return None
    lines.append(f"{c.get('decision', '')}\n")
    for note in ("feature_note", "imbalance_note"):
        if c.get(note):
            lines.append(c[note] + "\n")
    entries = {}
    if "versions" in c:
        entries[f"Logistic ({c['shipped_version']}, C={c['selection']['C']})"] = c["versions"][c["shipped_version"]]
    entries.update(c.get("baselines", {}))
    for set_name, title in (("oof", "Out of fold (train)"), ("test_gold", "Test (gold)"), ("test_la_gold", "Test (LA gold)"), ("test_la_teacher", "Test (LA teacher-labeled)")):
        rows = metric_rows(entries, set_name)
        if rows:
            lines.append(f"**{title}**\n")
            lines.append(table(HEAD, rows))
            lines.append("")
    if c.get("coefficients"):
        lines.append("**Coefficients**\n")
        lines.append(table(["Feature", "Coefficient", "Odds ratio", "Per", "Reading"], [[x["feature"], x["coef"], x["odds_ratio"], x["per"], x["sentence"]] for x in c["coefficients"]]))
        lines.append("")
    if c.get("sensitivity"):
        lines.append("**Labeling-threshold sensitivity** (refit with y defined at 5% and 20%)\n")
        rows = []
        for k, s in c["sensitivity"].items():
            g = s.get("test_gold", {})
            rows.append([k, s.get("C"), s.get("train_positive_rate"), f(s.get("oof", {}).get("log_loss")), f(g.get("log_loss")), f(g.get("auc")), f(g.get("ece_width"))])
        lines.append(table(["Threshold", "C", "Train positive rate", "OOF log loss", "Gold log loss", "Gold AUC", "Gold ECE"], rows))
        lines.append("")
    if eval_dir("results", "confidence_reliability.png").exists():
        lines.append("![Confidence reliability diagram](confidence_reliability.png)\n")
    return c


def section_discovery(lines: list[str]) -> None:
    lines.append("## 5. Discovery prior vs. v0 order\n")
    d = load("discovery_model.json")
    if not d:
        lines.append("Not run yet (ml/train_discovery.py).\n")
        return
    if d.get("decision"):
        lines.append(d["decision"] + "\n")
    entries = {f"{k} (C={v['C']})": v["metrics"] for k, v in d.get("variants", {}).items()}
    entries["v0 hand-set prior"] = d["baseline_v0_prior"]
    for set_name, title in (("oof", "Out of fold (train)"), ("test_gold", "Test (gold)"), ("test_la_gold", "Test (LA gold)"), ("test_la_teacher", "Test (LA teacher-labeled)")):
        rows = metric_rows(entries, set_name)
        if rows:
            lines.append(f"**{title}**\n")
            lines.append(table(HEAD, rows))
            lines.append("")
    rows = []
    for k, v in d.get("variants", {}).items():
        r = v["ranking"].get("test_all", {})
        for kk in ("yield@10", "yield@25"):
            if kk in r:
                rows.append([f"{k}, {kk} (top {r[kk]['k_used']})", r[kk]["model"], r[kk]["v0_prior"], r[kk]["random"]])
    if rows:
        lines.append("**Yield on all test venues** (share of top-K that host private events)\n")
        lines.append(table(["Ranking", "Model", "v0 prior", "Random"], rows))
        lines.append("")


def section_fit(lines: list[str]) -> None:
    lines.append("## 6. Fit prior\n")
    p = load("fit_prior.json")
    if not p:
        lines.append("Not run yet (ml/build_fit_prior.py).\n")
        return
    lines.append(p["table_md"] + "\n")
    lines.append(f"alpha = {p['alpha']}. {p['note']}\n")
    if p.get("test_check"):
        lines.append(table(["Headcount", "Brier (bucket q)", "Brier (global q)"], [[h, v["brier_bucket"], v["brier_global"]] for h, v in p["test_check"].items()]))
        lines.append("")


def section_la(lines: list[str]) -> None:
    lines.append("## 7. LA (new-city generalization)\n")
    lines.append("LA rows are shown in their own tables above: \"Test (LA gold)\" is the strictest test (human labels, a city never trained on); \"Test (LA teacher-labeled)\" covers the rest of LA with teacher labels.\n")


def section_cost(lines: list[str]) -> None:
    lines.append("## 8. Cost and time\n")
    runs = read_jsonl(eval_dir("run_manifest.jsonl"))
    if not runs:
        lines.append("No run manifest yet.\n")
        return
    rows = []
    for r in runs:
        try:
            secs = (datetime.fromisoformat(r["ended_at"].replace("Z", "+00:00")) - datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))).total_seconds()
        except Exception:
            secs = None
        spend = ", ".join(f"{k} {v:.4g}" for k, v in (r.get("spend") or {}).items()) or "–"
        rows.append([r["script"], r.get("status", ""), spend, f(secs, 1) if secs is not None else "–", ", ".join(f"{k}={v}" for k, v in (r.get("models") or {}).items()) or "–"])
    lines.append(table(["Script", "Status", "Spend", "Seconds", "Models"], rows))
    lines.append("")
    for service in ("google_text_search", "firecrawl", "firecrawl_pdf", "xai", "anthropic"):
        ledger = eval_dir(".spend", f"{service}.json")
        if ledger.exists():
            led = read_json(ledger)
            lines.append(f"- {service}: {led['spent']:.4g} of {led['cap']} {led['unit']} ({led['calls']} calls)")
    lines.append("")


def main() -> int:
    manifest = RunManifest("ml/evaluate.py")
    lines = ["# Training pipeline results", "", f"Data folder: `{eval_dir()}`.", ""]
    section_funnel(lines)
    section_teacher(lines)
    section_extraction(lines)
    section_confidence(lines)
    section_discovery(lines)
    section_fit(lines)
    section_la(lines)
    section_cost(lines)
    out = eval_dir("results", "summary.md")
    write_atomic(out, "\n".join(lines) + "\n")
    manifest.outputs.append(out)
    manifest.write()
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
