#!/usr/bin/env python3
"""Validate storage benchmark artifacts and reproduce the Markdown report."""

import argparse
from bisect import bisect_left, bisect_right
from datetime import datetime
import hashlib
from itertools import combinations, product
import json
from math import fsum, isfinite, log
from pathlib import Path
import re
import shlex
from statistics import median
import subprocess
import sys

AB_ORDER = "B1 A1 A2 B2 A3 B3 B4 A4 B5 A5 A6 B6".split()
ABLATION_ORDER = "B1 P1 A1 P2 A2 B2 A3 B3 P3".split()
MIGRATION_CASES = ["migration_v37_to_v38", "migration_v37_to_v38_2x"]
CONFIGS = {"B": "BEFORE", "P": "BEFORE+SETTINGS", "A": "AFTER"}
BINARIES = {"B": "before_bin", "P": "before_settings_bin", "A": "after_bin"}
CONTROLS = ("control_pk_lookup_500", "control_write_50")
TIMINGS = ("p50_ms", "p95_ms", "max_ms", "mean_ms")
LABELINGS = tuple(combinations(range(12), 6))
PAIR_SIGNS = tuple(product((-1, 1), repeat=6))
ALPHA = 0.05
EFFECT = 1.10

# Keep workload identity and timed sample counts independent of the observed logs.
EXPECTED = {name: int(n) for name, n in (line.split() for line in """
startup_open_recovery 15
startup_open_reopen 15
sidebar_sessions 30
sidebar_sessions_and_reconcile 30
agents_dock_snapshot 30
single_session_lookup 25
control_pk_lookup_500 30
control_write_50 20
thread_open_message_page 50
thread_open_subagent_rows 50
prompt_activity_calendar 20
search_tasks_project 20
search_tasks_project_miss 20
workspace_root_lookup 25
workspace_root_lock_hold 25
user_turns_count 25
imported_task_lookup 25
due_limit_resumes 25
schedules_list_session 25
update_link_states_20 30
reorder_sessions_500 20
architect_active_scan/scheduler_query 30
architect_active_scan/watchdog_reconcile 15
architect_active_scan/watchdog_stale_candidates 15
architect_active_scan/is_active_500 30
architect_active_scan/load_active 30
remote_mirror_ops/of 25
remote_mirror_ops/unfinished_cut_lookup 20
remote_mirror_ops/message_page 30
bots_log_and_shared_channels/failover_switches 20
bots_log_and_shared_channels/log 160
bots_log_and_shared_channels/log_interleaved 160
bots_log_and_shared_channels/activity_page 50
bots_log_and_shared_channels/list 50
bots_log_and_shared_channels/detail 50
bots_log_and_shared_channels/delivery_lookups 25
streaming_tool_upserts_50 30
streaming_message_inserts_50 30
turn_end_finish_tools_and_subagents 20
turn_changes_persist 20
turn_changes_persist_solo_history 20
turn_changes_persist_dense_team 10
turn_changes_persist_merged_team 10
remote_mirror_ops/store_page_10 20
remote_mirror_ops/save_subagents_5 30
remote_mirror_ops/save_subagents_5_changing 30
message_queue_ops 30
attachments_link_batch 20
subagent_state_flush 20
conversation_fork_200 20
delete_moodboard_64_images 15
delete_project_cascade 15
architect_team_save 30
architect_team_save_1mb 30
""".strip().splitlines())}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def field(text, name):
    matches = re.findall(rf"^{name}=(.+)$", text, re.M)
    require(len(matches) == 1, f"expected exactly one {name} field")
    return matches[0]


def binary_hashes(directory):
    expected = (directory / "binaries.sha256").read_text().splitlines()
    hashes = {}
    for config, name in BINARIES.items():
        digest = hashlib.sha256()
        with (directory / name).open("rb") as binary:
            for block in iter(lambda: binary.read(1024 * 1024), b""):
                digest.update(block)
        sha = hashes[config] = digest.hexdigest()
        build = (directory / f"{name.removesuffix('_bin')}_build.txt").read_text()
        require(field(build, "EXIT") == "0" and any(
            line.split()[:1] == [sha] and Path(line.split(maxsplit=1)[-1]).name == name
            for line in build.splitlines()
        ), f"{name}: archived binary hash differs from the successful build record")
    require(len(set(hashes.values())) == 3, "expected three distinct binary hashes")
    require(sorted(line.split() for line in expected) == sorted(
        [hashes[config], name] for config, name in BINARIES.items()
    ), "binary hash manifest differs from the archives")
    return hashes


def load_average(raw):
    # macOS sysctl prints braces. Also accept a plain three-number record.
    parts = tuple(map(float, raw.strip("{} ").split()))
    require(len(parts) == 3 and all(isfinite(v) and v >= 0 for v in parts), "invalid load averages")
    return parts


def read_run(path, run_id, phase, slot, config, sha, order=None):
    try:
        text = path.read_text(encoding="utf-8")
        header = dict(item.split("=", 1) for item in text.splitlines()[0].split())
        phase_key = {"A/B": "SIDE", "ablation": "CONFIG", "migration": "ORDER"}[phase]
        expected = {"RUN": run_id, "SLOT": str(slot), phase_key: order or CONFIGS[config]}
        require(header == expected, f"expected header {expected}, got {header}")
        require(field(text, "BIN_SHA256") == sha, "binary hash differs from build")
        command = shlex.split(field(text, "CMD"))
        if order:
            require(command.pop(0) == f"PANDACODE_BENCH_MIGRATION_ORDER={order}", "wrong migration order in command")
        bench = "db_bench_migration" if order else "db_bench_all"
        require(command and Path(command[0]).name == BINARIES[config] and command[1:] == [
            f"storage_bench::{bench}", "--ignored", "--exact", "--nocapture", "--test-threads=1"
        ], "incorrect benchmark invocation")
        exit_code = int(field(text, "EXIT"))
        require(exit_code == 0 or bool(order), f"benchmark exited {exit_code}")
        start, end = [field(text, f"{when}_UTC") for when in ("START", "END")]
        for stamp in (start, end):
            datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
        fixture = re.search(r"fixture: built in ([\d.]+) s.*file ([\d.]+) MiB", text)
        total = re.search(r"storage_bench (?:migration )?total ([\d.]+) s", text)
        printed = re.search(r"^storage_bench migration order: (\S+)$", text, re.M)
        cases = {}
        if exit_code == 0:
            require(fixture and total, "missing fixture or total time")
            if order:
                require(printed and printed[1] == order, "benchmark printed a different migration order")
            for line in text.splitlines():
                if not line.startswith("{"):
                    continue
                row = json.loads(line)
                if row.get("suite") != "storage_bench":
                    continue
                case = row["case"]
                require(case not in cases, f"duplicate case {case}")
                require(isinstance(row["note"], str) and row["note"], f"{case}: missing note")
                require(type(row["n"]) is int and row["n"] > 0, f"{case}: invalid sample count")
                for key in TIMINGS:
                    value = row[key]
                    require(type(value) in (int, float) and isfinite(value) and value > 0
                            and round(value, 6) == value, f"{case}: invalid {key}")
                require(row["p50_ms"] <= row["p95_ms"] <= row["max_ms"]
                        and row["mean_ms"] <= row["max_ms"], f"{case}: inconsistent timing percentiles")
                cases[case] = row
            if order:
                names = MIGRATION_CASES if order == "1x_first" else MIGRATION_CASES[::-1]
                require(list(cases) == names and all(row["n"] == 5 for row in cases.values()),
                        "unexpected migration cases, order or sample counts")
            else:
                require(list(cases) == list(EXPECTED) and all(
                    row["n"] == EXPECTED[name] for name, row in cases.items()
                ), f"unexpected case names, order or sample counts (expected {len(EXPECTED)} cases)")
        return dict(id=run_id, phase=phase, slot=slot, config=config, order=order, exit=exit_code,
                    start=start, end=end, loads=[load_average(field(text, f"{when}_LOAD"))
                                                for when in ("START", "END")],
                    fixture=fixture[1] if fixture else "—", mib=fixture[2] if fixture else "—",
                    total=total[1] if total else "—", cases=cases)
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise ValueError(f"{path.name}: {error}") from error


def read_runs(directory, hashes):
    ab, ablation, migration = [], [], []
    files = set()
    for runs, phase, order, prefix in (
        (ab, "A/B", AB_ORDER, ""),
        (ablation, "ablation", ABLATION_ORDER, "ablation_"),
        (migration, "migration", [f"M{i}" for i in range(1, 7)], ""),
    ):
        for slot, label in enumerate(order, 1):
            config = "A" if phase == "migration" else label[0]
            migration_order = (f"{1 if slot % 2 else 2}x_first" if phase == "migration" else None)
            name = f"{prefix}{label.lower()}.txt"
            files.add(name)
            run_id = f"AB_{label}" if phase == "ablation" else label
            runs.append(read_run(directory / name, run_id, phase, slot, config, hashes[config], migration_order))
    present = {p.name for p in directory.iterdir() if re.fullmatch(r"(?:[abm]\d+|ablation_[bpa]\d+)\.txt", p.name)}
    require(present == files, f"unexpected logs: {', '.join(sorted(present - files))}")
    driver = [line for line in (directory / "run_all.out").read_text().splitlines()
              if "EXIT=" in line and not line.startswith("RUN_ALL")]
    all_runs = ab + ablation + migration
    require(driver == [f"{run['id']} EXIT={run['exit']}" for run in all_runs],
            "runner did not record exactly the expected 27 attempts and exits in order")
    notes = {name: row["note"] for name, row in ab[0]["cases"].items()}
    previous_end = ""
    for run in all_runs:
        require(previous_end <= run["start"] <= run["end"], f"{run['id']}: timestamps are out of sequence")
        previous_end = run["end"]
        if run["phase"] != "migration":
            require(all(row["note"] == notes[name] for name, row in run["cases"].items()),
                    f"{run['id']}: case notes differ")
    return ab, ablation, migration


# Mask comments and literals while retaining offsets and line numbers. Rust test-only
# modules and items then follow the same delimiter rules as normal source items.
RUST_TEXT = re.compile(
    r'//[^\n]*|/\*|\br(?P<hashes>\#*)"[\s\S]*?"(?P=hashes)'
    r'|"(?:\\[\s\S]|[^"\\])*"|\'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^\'\\\n])\''
)
TEST_ATTRIBUTE = re.compile(r"(?m)^[ \t]*#\s*\[\s*(?:cfg\(\s*test\s*\)|test)\s*\]")
DELIMITER = re.compile(r"[{};]")
CALL = ".prepare_cached("


def blank(text):
    return re.sub(r"[^\n]", " ", text)


def source_calls(source):
    parts = []
    end = 0
    while match := RUST_TEXT.search(source, end):
        parts.append(source[end:match.start()])
        end = match.end()
        if match[0] == "/*":
            depth = 1
            for marker in re.finditer(r"/\*|\*/", source[end:]):
                depth += 1 if marker[0] == "/*" else -1
                if not depth:
                    end += marker.end()
                    break
        parts.append(blank(source[match.start():end]))
    parts.append(source[end:])
    code = "".join(parts)
    parts.clear()
    end = 0
    for match in TEST_ATTRIBUTE.finditer(code):
        if match.start() < end:
            continue
        parts.append(code[end:match.start()])
        end = match.end()
        depth = 0
        for marker in DELIMITER.finditer(code, end):
            if marker[0] == ";" and depth == 0:
                end = marker.end()
                break
            depth += (marker[0] == "{") - (marker[0] == "}")
            if marker[0] == "}" and depth == 0:
                end = marker.end()
                break
        parts.append(blank(code[match.start():end]))
    parts.append(code[end:])
    return [number for number, line in enumerate("".join(parts).splitlines(), 1)
            for _ in range(line.count(CALL))]


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, encoding="utf-8")


def same_revision(repo, left, right):
    def resolve(rev):
        return subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "--verify", "--end-of-options", f"{rev}^{{commit}}"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()

    try:
        return resolve(left) == resolve(right)
    except subprocess.CalledProcessError:
        try:
            subprocess.check_output(
                ["git", "-C", str(repo), "rev-parse", "--git-dir"], stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            pass
        else:
            # Git can verify these names, but at least one does not resolve to a commit.
            return False
    except OSError:
        pass

    if left == right:
        return True
    if all(re.fullmatch(r"[0-9a-fA-F]{7,40}", rev) for rev in (left, right)):
        short, long = sorted((left.lower(), right.lower()), key=len)
        return long.startswith(short)
    return False


def before_revision(directory, repo, override):
    def revisions(name):
        build = (directory / name).read_text(encoding="utf-8")
        return [field(build, key) for key in ("BEFORE_REV", "BEFORE_FULL")
                if re.search(rf"^{key}=", build, re.M)]

    baseline = revisions("before_build.txt")
    settings = revisions("before_settings_build.txt")
    require(baseline or override, "before_build.txt must record a baseline revision or supply --before-rev")
    require(settings, "before_settings_build.txt must record a baseline revision")

    recorded = baseline[0] if baseline else override
    if override is not None:
        require(same_revision(repo, recorded, override),
                f"--before-rev {override} does not match build revision {recorded}")
    # Compare all pairs so full OIDs cannot disagree even in an offline replay.
    for left, right in combinations((baseline or [recorded]) + settings, 2):
        require(same_revision(repo, left, right),
                f"baseline revision mismatch between build records: {left} vs {right}")
    return recorded


def archived_inventory(path, repo, before_rev):
    text = path.read_text(encoding="utf-8")
    counts = rf": (\d+) `{re.escape(CALL)}` calls in (\d+) files$"
    before = re.findall(r"^BEFORE (\S+)" + counts, text, re.M)
    after = re.findall(r"^AFTER working tree" + counts, text, re.M)
    require(len(before) == len(after) == 1, f"{path.name}: expected one BEFORE and one AFTER inventory header")
    revision, calls, files = before[0]
    require(same_revision(repo, revision, before_rev),
            f"{path.name}: BEFORE revision {revision} does not match {before_rev}")
    return revision, (int(calls), int(files)), tuple(map(int, after[0]))


def inventory(repo, before_rev, output_path):
    def production(path):
        return path.suffix == ".rs" and not any(
            part in {"test", "tests", "storage_bench"} for part in path.with_suffix("").parts
        ) and not re.search(r"(?:^|_)tests?(?:_|$)", path.stem)

    prefix = Path("src-tauri/src")
    commit = git(repo, "rev-parse", "--verify", "--end-of-options", f"{before_rev}^{{commit}}").strip()
    tracked = [Path(path) for path in git(repo, "ls-tree", "-r", "--name-only", commit, "--",
                                        str(prefix)).splitlines()]
    groups = []
    for label, paths, read in (
        (f"BEFORE {before_rev}", tracked, lambda path: git(repo, "show", f"{commit}:{path}")),
        ("AFTER working tree", (path.relative_to(repo) for path in (repo / prefix).rglob("*.rs")),
         lambda path: (repo / path).read_text(encoding="utf-8")),
    ):
        hits = {}
        for path in sorted(paths):
            if production(path):
                source = read(path)
                if CALL in source:
                    lines = source_calls(source)
                    if lines:
                        hits[path] = lines
        groups.append((label, hits))
    counts = [(sum(map(len, hits.values())), len(hits)) for _, hits in groups]
    if output_path is not None:
        lines = []
        for (label, hits), (calls, files) in zip(groups, counts):
            lines.append(f"{label}: {calls} `{CALL}` calls in {files} files")
            lines.extend(f"  {path}:{line}" for path, matches in hits.items() for line in matches)
        output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return counts


def exact_p(before, after, ranks=False):
    values = before + after
    if ranks:
        # Twice the midranks are integers, including ties.
        ordered = sorted(values)
        values = [bisect_left(ordered, value) + 1 + bisect_right(ordered, value) for value in values]
    else:
        values = list(map(log, values))
    total = fsum(values)
    observed = abs(2 * fsum(values[:6]) - total)
    return sum(abs(2 * fsum(values[i] for i in perm) - total) >= observed - 1e-12
               for perm in LABELINGS) / len(LABELINGS)


def sign_flip_p(log_ratios):
    observed = abs(fsum(log_ratios))
    return sum(abs(fsum(sign * value for sign, value in zip(signs, log_ratios))) >= observed - 1e-12
               for signs in PAIR_SIGNS) / len(PAIR_SIGNS)


def apply_fdr(rows, p_key, q_key):
    running = 1.0
    ordered = sorted(rows, key=lambda row: row[p_key])
    for rank, row in reversed(list(enumerate(ordered, 1))):
        running = min(running, row[p_key] * len(rows) / rank)
        row[q_key] = running


def classify(ratio, q):
    if q > ALPHA or ratio == 1:
        return "neutral"
    if ratio >= EFFECT:
        return "clear win"
    if ratio > 1:
        return "small win"
    return "trade-off" if ratio <= 1 / EFFECT else "small slowdown"


def measurements(runs, config, case, key="p50_ms"):
    return [run["cases"][case][key] for run in runs if run["config"] == config]


def ab_results(runs):
    adjacent = [sorted((left, right), key=lambda run: run["config"], reverse=True)
                for left, right in zip(runs[::2], runs[1::2])]
    rows = {}
    for case in EXPECTED:
        before, after = [measurements(runs, config, case) for config in "BA"]
        pairs = [log(b["cases"][case]["p50_ms"] / a["cases"][case]["p50_ms"]) for b, a in adjacent]
        p95_before, p95_after = [median(measurements(runs, config, case, "p95_ms")) for config in "BA"]
        p95_pairs_slower = sum(b["cases"][case]["p95_ms"] < a["cases"][case]["p95_ms"] for b, a in adjacent)
        rows[case] = dict(batched="(batched ×" in runs[0]["cases"][case]["note"],
                          before=before, after=after, ratio=median(before) / median(after),
                          floor=min(before) / min(after), perm=exact_p(before, after),
                          rank=exact_p(before, after, ranks=True), pair=sign_flip_p(pairs),
                          pairs_slower=sum(value < 0 for value in pairs),
                          p95_before=p95_before, p95_after=p95_after,
                          p95_ratio=p95_before / p95_after, p95_pairs_slower=p95_pairs_slower)
    apply_fdr(rows.values(), "perm", "q")
    apply_fdr(rows.values(), "pair", "pair_q")
    for row in rows.values():
        row["class"] = classify(row["ratio"], row["q"])
    return rows


def ms(value):
    return f"{value:.5f}" if value < 0.1 else f"{value:.3f}"


def times(values):
    return ", ".join(map(ms, values))


def ratio(value):
    if value >= 100:
        return f"{value:.0f}×"
    if value >= 10:
        return f"{value:.1f}×"
    return f"{value:.2f}×"


def names(cases):
    return ", ".join(f"`{case}`" for case in cases) or "none"


def detail(row):
    return (f"BEFORE {ms(median(row['before']))} ms, AFTER {ms(median(row['after']))} ms "
            f"({ratio(row['ratio'])}, FDR q {row['q']:.4f}, {row['class']})")


def load_span(runs):
    values = [loads[0] for run in runs for loads in run["loads"]]
    return f"{min(values):.1f}–{max(values):.1f}"


def primary_report(ab, rows):
    lines = [f"""### 1. Host load and controls

The shared host was under substantial load. The 1-minute load across A/B starts and ends was {load_span(ab)}. Median start load was \
{median([r['loads'][0][0] for r in ab if r['config'] == 'B']):.1f} on BEFORE and \
{median([r['loads'][0][0] for r in ab if r['config'] == 'A']):.1f} on AFTER. The fixed schedule \
balances linear drift by slot index. Its order was chosen without randomization, so the {len(LABELINGS)}-way \
permutation p- and q-values are conditional on exchangeability across the 12 slots. The six-pair \
adjacent sign-flip test checks sensitivity to run order. A formal confirmatory trial would need \
randomized balanced blocks on an isolated, quiet host.

The controls bypass `Store::open` and use fixed settings. `control_pk_lookup_500` makes 500 primary-key \
lookups against each binary's fixture database, so the control still sees the schema. \
`control_write_50` makes 50 autocommit 2 KiB WAL writes to a separate database. \
The analysis uses the observed timings directly.
"""]
    for case in CONTROLS:
        row = rows[case]
        lines.append(f"- `{case}` p50 by run in ms. BEFORE {times(row['before'])}. "
                     f"AFTER {times(row['after'])}. Median ratio {ratio(row['ratio'])}, "
                     f"perm p {row['perm']:.4f}, rank p {row['rank']:.4f}, FDR q {row['q']:.4f}.")
    groups = {kind: [case for case, row in rows.items() if row["class"] == kind]
              for kind in ("clear win", "small win", "trade-off", "small slowdown", "neutral")}
    lost = [case for case, row in rows.items() if row["q"] <= ALPHA < row["pair_q"]]
    gained = [case for case, row in rows.items() if row["pair_q"] <= ALPHA < row["q"]]
    gained_details = ", ".join(
        f"`{case}` ({ratio(rows[case]['ratio'])}, primary q {rows[case]['q']:.4f}, "
        f"pair q {rows[case]['pair_q']:.4f})" for case in gained
    ) or "none"
    marginal = [case for case, row in rows.items() if row["perm"] <= ALPHA < row["q"]]
    wins = groups["clear win"] + groups["small win"]
    slow = groups["trade-off"] + groups["small slowdown"]
    lines.extend(["", "### 2. Summary", "",
                  f"- **Wins** — {len(wins)} ({len(groups['clear win'])} clear, {len(groups['small win'])} small).",
                  f"- **Slowdowns** — {len(slow)} ({len(groups['trade-off'])} trade-offs, "
                  f"{len(groups['small slowdown'])} small). {names(slow)}.",
                  f"- **Neutral** — {len(groups['neutral'])} "
                  f"({len(marginal)} met nominal p ≤ 0.05 with q > 0.05)."
                  + (f" {names(marginal)}." if marginal else "")])
    paired_slowdowns = []
    for case in gained:
        row = rows[case]
        if row["ratio"] < 1:
            paired_slowdowns.append(
                f"`{case}` ({ratio(row['ratio'])} B/A median, {row['pairs_slower']} of 6 pairs slower on AFTER, "
                f"primary q {row['q']:.4f}, pair q {row['pair_q']:.4f})"
            )
    if paired_slowdowns:
        lines.append("- **Order-sensitive trade-offs (adjacent pairs)** — " + ", ".join(paired_slowdowns) + ".")
    lines.extend([
        "",
        f"**Order sensitivity (6 adjacent pairs).** The sign-flip test enumerates all {len(PAIR_SIGNS)} "
        "sign assignments on the six adjacent log ratios and adjusts over the same cases. "
        f"Primary FDR-significant cases with pair q > 0.05 ({len(lost)}) — {names(lost)}. "
        f"Primary non-significant cases with pair q ≤ 0.05 ({len(gained)}) — {gained_details}. "
        "The paired analysis has fewer possible assignments and tests the effect within neighboring runs.", "",
        "At q ≤ 0.05, a ratio ≥ 1.10× is a clear win and a ratio ≤ 1/1.10× is a trade-off. "
        "Significant ratios between those bounds are small wins above 1× and small slowdowns below 1×. "
        "Equal medians or q > 0.05 are neutral.", "",
        f"### 3. Full {len(EXPECTED)}-case paired table", "",
        f"The {len(LABELINGS)}-way permutation p- and q-values assume exchangeability across the 12 slots "
        "of the fixed balanced schedule. The pair p- and q-values come from sign flips within the "
        "six adjacent pairs and show how results change when the comparison is restricted to neighboring runs.", "",
        "| Case | n | B median ms | B min..max ms | A median ms | A min..max ms | "
        "B/A median | B/A min | perm p | FDR q | rank p | pair p | pair q | Class |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ])
    for case, r in rows.items():
        def cells(values):
            return f"{ms(median(values))} | {ms(min(values))}..{ms(max(values))}"
        lines.append(f"| `{case}` | {EXPECTED[case]} | {cells(r['before'])} | {cells(r['after'])} | "
                     f"{ratio(r['ratio'])} | {ratio(r['floor'])} | {r['perm']:.4f} | {r['q']:.4f} | "
                     f"{r['rank']:.4f} | {r['pair']:.4f} | {r['pair_q']:.4f} | {r['class']} |")
    lines.extend(["", "<details>", "<summary>Workload notes</summary>", "",
                  *[f"- `{name}` — {row['note']}" for name, row in ab[0]["cases"].items()],
                  "", "</details>"])
    return lines


def tail_report(rows):
    faster = sum(row["p95_ratio"] > 1 for row in rows.values())
    slower = sum(row["p95_ratio"] < 1 for row in rows.values())
    batched = sum(row["batched"] for row in rows.values())
    lines = ["**Tail latency (descriptive median of per-run p95).** "
             f"AFTER was faster in {faster} cases, slower in {slower} and tied in {len(rows) - faster - slower} "
             f"across all {len(rows)} cases ({len(rows) - batched} single-call and {batched} batch-average). "
             "The table includes each non-control case with an AFTER p95 "
             "at least 10% higher (B/A ≤ 1/1.10×).", ""]
    slowdowns = [(row["p95_ratio"], case, row) for case, row in rows.items()
                 if case not in CONTROLS and row["p95_ratio"] <= 1 / EFFECT]
    if not slowdowns:
        return lines + ["No non-control case met that threshold.", ""]
    lines.extend(["| Case | BEFORE p95 ms | AFTER p95 ms | B/A p95 | Adjacent pairs slower on AFTER |",
                  "|---|---:|---:|---:|---:|"])
    for value, case, row in sorted(slowdowns):
        unit = "batch-average" if row["batched"] else "single-call"
        lines.append(f"| `{case}` ({unit} p95) | {ms(row['p95_before'])} | {ms(row['p95_after'])} | "
                     f"{ratio(value)} | {row['p95_pairs_slower']} of 6 |")
    return lines + [""]


WRITE_COSTS = {
    "delete_project_cascade": "Both paths check the `architect_teams` base table directly and run the full cascade. "
    "AFTER checks strict `json_valid(content)` and active status inside an immediate transaction before deleting. "
    "The cascade also maintains the v38 indexes "
    "and removes tracker rows through foreign keys.",
    "architect_team_save": "AFTER's savepoint sets `skip_sync=1` in `architect_team_meta` before upserting "
    "the team. That fixed work keeps scheduler, watchdog and listing queries off the snapshot JSON.",
    "architect_team_save_1mb": "Serialization and the snapshot write account for more of the total at 1 MiB.",
    "remote_mirror_ops/save_subagents_5": "Each timed sample replays the same five child snapshots. BEFORE "
    "upserts each row through `Store::save_subagent`. AFTER uses one batch transaction with per-row "
    "savepoints and checks the `running_subagents` trigger predicates.",
    "remote_mirror_ops/save_subagents_5_changing": "Each sample advances all five timestamps and changes "
    "tool output, so the upserts write WAL frames. AFTER commits the changing snapshots through the batch "
    "path. BEFORE saves each row individually.",
    "conversation_fork_200": "Forking inserts a session and copies 200 messages. "
    "The v38 writes update the applicable indexes and check the running-tool trigger predicate.",
    "delete_moodboard_64_images": "Both paths look up the targeted board, then delete it. "
    "The cascade removes 64 images and 144 attachments and maintains the two new attachment indexes on AFTER.",
}


def writes_and_locks(ab, rows):
    lines = ["### 4. Trade-offs and write/delete costs", "", *tail_report(rows),
             "The timings include each workload's application-level database work. "
             "Section 3 gives the primary A/B status for each case.", ""]
    for case, description in WRITE_COSTS.items():
        lines.append(f"- `{case}` — {detail(rows[case])}. {description}")
    lines.extend(["", "**Other writes:**", ""])
    writes = (
        "update_link_states_20", "reorder_sessions_500", "bots_log_and_shared_channels/log",
        "bots_log_and_shared_channels/log_interleaved",
        "streaming_tool_upserts_50", "streaming_message_inserts_50", "turn_end_finish_tools_and_subagents",
        "turn_changes_persist", "turn_changes_persist_solo_history", "turn_changes_persist_dense_team",
        "turn_changes_persist_merged_team", "remote_mirror_ops/store_page_10", "message_queue_ops",
        "attachments_link_batch", "subagent_state_flush",
    )
    for case in writes:
        lines.append(f"- `{case}` — {detail(rows[case])}.")
    lines.extend(["", "The 160-insert windows capture consecutive inserts on one bot (`log`) and "
                  "alternating inserts on two bots near their 5,000-row caps (`log_interleaved`).", "",
                  "| Case | Window statistic | BEFORE median ms | AFTER median ms | B/A | Adjacent pairs slower on AFTER |",
                  "|---|---|---:|---:|---:|---:|"])
    for case in ("bots_log_and_shared_channels/log", "bots_log_and_shared_channels/log_interleaved"):
        for key, label in (("mean_ms", "Per-run mean"), ("max_ms", "Per-run maximum")):
            before, after = [measurements(ab, side, case, key) for side in "BA"]
            slower = sum(b < a for b, a in zip(before, after))
            b, a = median(before), median(after)
            lines.append(f"| `{case}` | {label} (`{key}`) | {ms(b)} | {ms(a)} | "
                         f"{ratio(b / a)} | {slower} of 6 |")
    lines.extend(["", "`max_ms` is the unattributed window maximum. The benchmark does not identify "
                  "which calls hit the trim boundary. `bots::log` trims "
                  "once per 128 consecutive single-bot inserts, so activity can briefly exceed the cap. "
                  "With interleaved bots, a quiet bot that logs once per global row-ID block can hit "
                  "a trim boundary on each insert and scan 5,000 index entries on that insert.", "",
                  "Each team case seeds four finished workers with 250 interleaved attributed captures per worker. "
                  "`turn_changes_persist_dense_team` starts with the newest 250 pre-merged. "
                  "`turn_changes_persist_merged_team` starts with all 1,000 pre-merged and zero new sources. "
                  "The fixture stops at 1,000 captures. Above that, a fully merged team still revisits eligible "
                  "worker history in adaptive 32→2,048-row index pages over `turn_changes_session` and "
                  "materializes the parent `teamSources` in linear time under the Store mutex. "
                  "BEFORE's quadratic `NOT EXISTS` repeatedly re-parses the parent's JSON rollups. "
                  "`prune_retained` runs `RETAINED_BYTES_SQL` over only the compact covering partial index "
                  "`turn_changes_retained_bytes WHERE diff_bytes > 0`, whose size is bounded by the "
                  "`RETAINED_BYTES` retention cap.", "", "### 5. Lock hold and watchdog", "",
                  f"- `workspace_root_lock_hold` — {detail(rows['workspace_root_lock_hold'])}. "
                  "Each call measures uncontended `Mutex::lock`, the SQL critical section and guard release. "
                  "AFTER calls `workspace_paths` under the guard and ends the timed call at release. "
                  "In production, the AFTER path performs the disk checks after releasing the guard. "
                  "BEFORE calls `workspace_root` under the guard, so the same section also includes "
                  "`canonicalize`, `is_dir` and the `.git` check.", "",
                  f"- `workspace_root_lookup` — {detail(rows['workspace_root_lookup'])}. "
                  "This case includes SQL and the filesystem checks on both configurations."])
    for case in ("watchdog_reconcile", "watchdog_stale_candidates", "load_active"):
        name = f"architect_active_scan/{case}"
        lines.append(f"- `{name}` — {detail(rows[name])}.")
    lines.extend(["", "The two watchdog cases measure candidate selection. BEFORE uses uncached statement "
                  "preparation and scans team JSON. AFTER uses prepared queries over `architect_team_meta`. "
                  "The separate active-team load case measures loading the two full working snapshots."])
    return lines


def separated(left, right):
    if max(right) < min(left):
        return "faster"
    if min(right) > max(left):
        return "slower"
    return "overlap"


def magnitude(value):
    return max(value, 1 / value)


def ablation_report(runs, primary, before_sites, after_sites):
    before_calls, before_files = before_sites
    after_calls, after_files = after_sites
    values = {case: {c: measurements(runs, c, case) for c in "BPA"} for case in EXPECTED}
    steps = ("BP", "PA", "BA")
    ratios, separation = {}, {}
    lines = ["""### 6. Connection-settings ablation

B is BEFORE, P is BEFORE with only the four v38 connection settings, and A is AFTER. \
The 3×3 Latin square ran B P A / P A B / A B P. Each configuration occupied each block position once \
and its slots sum to 15. Ratios divide left by right, so > 1× is faster on the right. \
Separation means all three timings on one side beat all three on the other. The three runs \
per configuration support descriptive comparisons.

`Store::open` changes `cache_size=-1024` to `-8192`, sets `temp_store=MEMORY` and \
`journal_size_limit=67108864` (64 MiB), and calls `set_prepared_statement_cache_capacity(256)`. \
`Store::open_read_only` uses a 4 MiB page cache and memory-backed temporary storage for the Skills manager \
launch lookup. That lookup uses uncached queries and falls outside this benchmark.
"""]
    lines.extend([
        f"The 1-minute load across ablation starts and ends was {load_span(runs)}. "
        f"BEFORE has {before_calls} non-test `.prepare_cached(` call sites in {before_files} files. "
        f"AFTER has {after_calls} in {after_files} files. `--write-inventory` records each source location.", "",
        "The three-cell ablation measures the four `Store::open` settings on version 37. "
        "A fourth cell with v38 and the old settings would be needed to isolate any interaction "
        f"between the 256-entry statement cache or 8 MiB page cache and v38's {after_calls} cached call sites. "
        "The combined P→A schema and queries step includes those interactions.", "",
        "| Case | B median ms | P median ms | A median ms | Settings B/P | Schema + queries P/A | "
        "Total B/A | B→P | P→A | B→A |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|---|",
    ])
    for case, config in values.items():
        medians = {c: median(numbers) for c, numbers in config.items()}
        ratios[case] = {step: medians[step[0]] / medians[step[1]] for step in steps}
        separation[case] = {step: separated(config[step[0]], config[step[1]]) for step in steps}
        cells = [ms(medians[c]) for c in "BPA"] + [ratio(ratios[case][step]) for step in steps]
        cells.extend(separation[case].values())
        lines.append(f"| `{case}` | " + " | ".join(cells) + " |")

    bands = {step: max(magnitude(ratios[case][step]) for case in CONTROLS) for step in steps[:2]}
    lines.extend(["", f"`ctrl_bp_band` is {bands['BP']:.4f}× and `ctrl_pa_band` is {bands['PA']:.4f}×. "
                  "Each band is the largest of r and 1/r across the two control median ratios for that step. "
                  "A shift in P moves B/P and P/A in opposite directions by the same factor because P sits "
                  "in the denominator of B/P and the numerator of P/A. Report both steps against their own "
                  "control shifts and use the independent 12-run A/B to assess the combined change.", "",
                  "| Control | B min..max ms (max/min) | P min..max ms (max/min) | "
                  "A min..max ms (max/min) | B/P | P/A |", "|---|---:|---:|---:|---:|---:|"])
    for case in CONTROLS:
        cells = [f"{ms(min(v))}..{ms(max(v))} ({max(v) / min(v):.4f}×)" for v in values[case].values()]
        lines.append(f"| `{case}` | " + " | ".join(cells) +
                     f" | {ratios[case]['BP']:.4f}× | {ratios[case]['PA']:.4f}× |")

    cases = [case for case in EXPECTED if case not in CONTROLS]
    lines.extend(["", f"Across all {len(values)} cases, including {len(cases)} non-control cases, "
                  "the following counts describe the non-control cases.", ""])
    for step, label in zip(steps, ("B→P settings", "P→A schema and queries", "B→A total")):
        for direction in ("faster", "slower"):
            matching = [case for case in cases if separation[case][step] == direction]
            if step in bands:
                beyond = [case for case in matching if magnitude(ratios[case][step]) > bands[step]]
                within = [case for case in matching if case not in beyond]
                lines.append(f"- **{label}** separated {direction} for {len(matching)} of {len(cases)}. "
                             f"{len(beyond)} exceeded the control band ({names(beyond)}). "
                             f"{len(within)} fell within the band ({names(within)}).")
            else:
                lines.append(f"- **{label}** separated {direction} for {len(matching)} of {len(cases)}. "
                             + (f"{names(matching)}." if direction == "slower" else
                                f"{sum(separation[c]['PA'] == 'faster' for c in matching)} also separated faster at P→A."))

    middle = [case for case in cases if separation[case]["PA"] == "faster" and separation[case]["BA"] != "faster"]
    discrepancies = []
    for case in cases:
        row = primary[case]
        direction = "overlap" if row["class"] == "neutral" else ("faster" if row["ratio"] > 1 else "slower")
        total = separation[case]["BA"]
        if total != direction:
            discrepancies.append(
                f"`{case}` (B→A {total} at {ratio(ratios[case]['BA'])}, "
                f"A/B {row['class']} at {ratio(row['ratio'])}, FDR q {row['q']:.4f})"
            )

    middle_names = f" ({names(middle)})" if middle else ""
    lines.extend(["", f"**Ablation and A/B discrepancies.** P→A separated faster while B→A "
                  f"overlapped or separated slower for {len(middle)} of {len(cases)} cases{middle_names}. "
                  f"Ablation B→A separation and primary A/B classification disagreed for {len(discrepancies)} "
                  f"of {len(cases)} cases ({', '.join(discrepancies) or 'none'})."])
    return lines


def migration_report(runs, build_overlap):
    complete = [run for run in runs if run["exit"] == 0]
    failed = [f"{run['id']} (`{run['order']}`, exit {run['exit']})" for run in runs if run["exit"] != 0]
    lines = ["### 7. Migration at two scales", "",
             "Six AFTER processes alternated `1x_first` and `2x_first`. Each completed invocation times "
             "five opens per scale after one warm-up, using fresh copies of compacted version 37 files.", "",
             f"Completed {len(complete)} of {len(runs)} invocations. The 1-minute load across all six starts "
             f"and ends was {load_span(runs)}."]
    if build_overlap:
        lines.extend(["", "A Rust build in another checkout overlapped part of the migration phase."])
    if failed:
        lines.extend([f"Failed invocations were {', '.join(failed)}. The raw log lists every attempt. "
                      "Timing summaries use the completed two-case invocations."])
    if not complete:
        return lines + ["", "No invocation produced a complete timing pair."]

    lines.extend(["", "| Case | Version 37 file | Messages | Median p50 (s) | "
                  "Min..max p50 (s) | Median per-run max (s) |", "|---|---:|---:|---:|---:|---:|"])
    p50s = []
    for case in MIGRATION_CASES:
        records = [run["cases"][case] for run in complete]
        notes = {record["note"] for record in records}
        require(len(notes) == 1, f"{case}: migration notes differ")
        size = re.search(r"\(([\d.]+) MiB, (\d+) messages", next(iter(notes)))
        require(size, f"{case}: note lacks file size or message count")
        p50 = [row["p50_ms"] / 1000 for row in records]
        p50s.append(p50)
        lines.append(f"| `{case}` | {size[1]} MiB | {int(size[2]):,} | {median(p50):.3f} | "
                     f"{min(p50):.3f}..{max(p50):.3f} | {median([r['max_ms'] for r in records]) / 1000:.3f} |")
    one, two = p50s
    ratios = [larger / smaller for smaller, larger in zip(one, two)]
    lines.extend(["", "| Run | Order | 1× p50 (s) | 2× p50 (s) | 2×/1× |",
                  "|---|---|---:|---:|---:|"])
    for run, small, large, value in zip(complete, one, two, ratios):
        lines.append(f"| {run['id']} | `{run['order']}` | {small:.3f} | {large:.3f} | {value:.3f}× |")
    lines.extend(["", f"The median within-run ratio was {median(ratios):.3f}× "
                  f"(range {min(ratios):.3f}..{max(ratios):.3f}×).", ""])
    for order in ("1x_first", "2x_first"):
        group = [i for i, run in enumerate(complete) if run["order"] == order]
        if group:
            small, large, value = [median([data[i] for i in group]) for data in (one, two, ratios)]
            lines.append(f"- `{order}` ({len(group)} completed) — median {small:.3f} s at 1×, "
                         f"{large:.3f} s at 2× and {value:.3f}× within runs.")
        else:
            lines.append(f"- `{order}` had no completed invocation.")
    lines.extend(["", "The harness checks that a revert and upgrade restores the exact schema before timing. "
                  "`upgrade_v38` runs synchronously during `Store::open` with a temporary 64 MiB page cache. "
                  "The steady cache returns to 8 MiB after commit. These runs used a `VACUUM`ed layout and "
                  "warm OS caches. `db_bench_migration` uses `std::fs::copy` before each sample. On macOS APFS, "
                  "Rust uses the `clonefile` family (`fclonefileat`) for copy-on-write clones. Timed writes "
                  "to shared blocks allocate new extents. An in-place upgrade can overwrite materialized "
                  "blocks. A cold or fragmented database can take longer."])
    return lines


def raw_report(runs):
    lines = ["### 8. Raw run log", "",
             f"All {len(runs)} attempts appear below in execution order. Binary IDs refer to the hashes "
             "in the results introduction. A dash marks a measurement the process did not print.", "",
             "| Slot | Run | Binary | Workload | Exit | Start (UTC) | End (UTC) | "
             "Start load 1/5/15 | End load 1/5/15 | Bench total (s) | Fixture build (s) | File (MiB) |",
             "|---:|---|---|---|---:|---|---|---|---|---:|---:|---:|"]
    for run in runs:
        loads = [" / ".join(f"{load:.2f}" for load in group) for group in run["loads"]]
        workload = run["phase"] + (f" `{run['order']}`" if run["order"] else "")
        lines.append(f"| {run['slot']} | {run['id']} | {run['config']} | {workload} | {run['exit']} | "
                     f"{run['start']} | {run['end']} | {loads[0]} | {loads[1]} | {run['total']} | "
                     f"{run['fixture']} | {run['mib']} |")
    return lines


def report(directory, repo, inventory_path=None, before_rev=None):
    hashes = binary_hashes(directory)
    ab, ablation, migration = read_runs(directory, hashes)
    before_rev = before_revision(directory, repo, before_rev)
    archive = directory / "prepare_cached_sites.txt"
    if inventory_path is None and archive.exists():
        before_rev, before_sites, after_sites = archived_inventory(archive, repo, before_rev)
    else:
        before_sites, after_sites = inventory(repo, before_rev, inventory_path)
    rows = ab_results(ab)
    introduction = f"""# Database benchmarks

The SQLite fixture models a mature workspace with 20 projects, 665 sessions, about 25,000 messages, \
and teams, subagents, turn changes, bots, schedules, a moodboard and a Connect mirror. \
The [test-only harness](../src-tauri/src/storage_bench.rs) and its \
[seeded fixture](../src-tauri/src/storage_bench/fixture.rs) run against real file-backed databases.

## How to run

Run one benchmark process at a time to avoid overlapping its disk I/O.

```sh
# The {len(EXPECTED)} paired cases.
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_all -- --ignored --exact --nocapture --test-threads=1

# The one-time migration at two scales. Alternate 1x_first and 2x_first across invocations.
PANDACODE_BENCH_MIGRATION_ORDER=1x_first CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_migration -- --ignored --exact --nocapture --test-threads=1
```

Each invocation prints a table and one JSON line per case. JSON timings are in milliseconds rounded \
to six fractional digits. Destructive workloads get a fresh copy per sample. Fast lookup workloads \
batch consecutive calls and report per-call time. Set `PANDACODE_STORAGE_BENCH_EXPORT=<file>` to retain \
the pristine fixture for `sqlite3` inspection.

Rebuild both baselines from the version 38 checkout using the checked-in harness, fixture and patches. \
Set `baseline_dir` to an absolute path for a detached worktree. [Baseline patch](../scripts/db-bench-baseline.patch) · \
[Connection settings patch](../scripts/db-bench-settings.patch)

```sh
git worktree add --detach "$baseline_dir" {before_rev}
mkdir -p "$baseline_dir/src-tauri/src/storage_bench"
cp src-tauri/src/storage_bench.rs "$baseline_dir/src-tauri/src/"
cp src-tauri/src/storage_bench/fixture.rs "$baseline_dir/src-tauri/src/storage_bench/"
git -C "$baseline_dir" apply "$PWD/scripts/db-bench-baseline.patch"

export CARGO_TARGET_DIR="$PWD/src-tauri/target" CARGO_INCREMENTAL=0
(cd "$baseline_dir" && cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib --no-run --message-format=json)
```

Copy the `pandacode_lib` test executable named in Cargo's JSON output to the artifact directory as `before_bin`. \
Apply the settings patch with `git -C "$baseline_dir" apply "$PWD/scripts/db-bench-settings.patch"` and repeat the \
build in the detached worktree. Archive that executable as `before_settings_bin`. Build from the version 38 \
checkout last and archive its executable as `after_bin`. Run `db_bench_all` from the archived executables in the \
schedules below and `db_bench_migration` from AFTER in alternating order.

To replay the comparison to stdout without writing files, run the analysis script:

```sh
python3 scripts/db-bench-compare.py <artifact-dir>
```

Replay reads the pinned `BEFORE_REV` from `before_build.txt`. Use `--before-rev` to supply a missing revision or verify the recorded one. \
`prepare_cached_sites.txt` supplies the call-site counts when present, so replay produces the same \
stdout without a Git checkout even after `HEAD` advances.

Use `--write-doc docs/db-benchmarks.md` to save Markdown, `--write-inventory <path>` to save \
the call-site inventory, and `--repo <path>` to select the source checkout for the inventory. \
The [analysis script](../scripts/db-bench-compare.py) \
expects the three archived `*_bin` files, their `*_build.txt` records, `binaries.sha256`, `run_all.out` \
and the 27 run logs with their metadata headers and exit footers. Runs are named `b1.txt` through \
`b6.txt` and `a1.txt` through `a6.txt` for A/B, `ablation_b1.txt` through `ablation_b3.txt` \
(and the corresponding `p` and `a` files) for ablation, and `m1.txt` through `m6.txt` for migration.
Optional `benchmark_build_overlap.log` and `migration_build_overlap.log` files record observed overlap \
with a build from another checkout.

The first line of each log records `RUN`, `SLOT` and one of `SIDE`, `CONFIG` or `ORDER`. Additional \
lines record `BIN_SHA256`, `CMD`, `START_UTC`, `START_LOAD`, `EXIT`, `END_UTC` and `END_LOAD`. \
Use timestamps in `YYYY-MM-DDTHH:MM:SSZ` format and 1/5/15-minute load averages. The runner transcript \
records each run ID and `EXIT` in sequence.

## How the numbers were made

- B (BEFORE) uses commit `{before_rev}` and its version 37 storage. The detached harness exposes the equivalent \
entry points and shares AFTER's fixture, case order, notes, batching, warm-ups and sample counts.
- P (BEFORE with v38 settings) changes only the four settings in `Store::open` described in section 6.
- A (AFTER) uses the version 38 working tree. All three test binaries use `fast-release` \
with `CARGO_INCREMENTAL=0`. The 27 invocations ran sequentially on one shared host.

## Results

| Binary | SHA-256 |
|---|---|
| B | `{hashes['B']}` |
| P | `{hashes['P']}` |
| A | `{hashes['A']}` |

The A/B order was {' '.join(AB_ORDER)}. The six BEFORE slots and six AFTER slots each sum to 39. \
The unit of analysis is each process's p50 for the case. Ratios use BEFORE/AFTER, so > 1× means faster \
on AFTER. The ratio of minima shows the timing floor.

- `perm p` is the two-sided exact mean-log difference test over all {len(LABELINGS)} assignments. \
`FDR q` applies Benjamini–Hochberg to the {len(EXPECTED)} permutation p-values.
- `rank p` is the two-sided exact Mann–Whitney rank-sum test over those same assignments, using \
midranks for ties. The classification uses the primary FDR q.
- All {len(ab)} A/B and {len(ablation)} ablation processes exited 0 with identical case names, notes, \
order and n. All {len(ab + ablation + migration)} recorded hashes match the three distinct binaries. \
Sections 7 and 8 record the migration outcomes.
"""
    if (directory / "benchmark_build_overlap.log").is_file():
        introduction += "\nA Rust build in another checkout overlapped part of the A/B or ablation phase.\n"
    sections = [
        primary_report(ab, rows),
        writes_and_locks(ab, rows),
        ablation_report(ablation, rows, before_sites, after_sites),
        migration_report(migration, (directory / "migration_build_overlap.log").is_file()),
        raw_report(ab + ablation + migration),
    ]
    return "\n\n".join([introduction.rstrip(), *["\n".join(section) for section in sections]]) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_dir", type=Path)
    parser.add_argument("--write-doc", type=Path, help="write Markdown to a file instead of stdout")
    parser.add_argument("--write-inventory", type=Path, help="write the call-site inventory to this file")
    parser.add_argument("--before-rev", help="supply or verify the BEFORE revision")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        markdown = report(args.artifact_dir, args.repo.resolve(), args.write_inventory, args.before_rev)
        if args.write_doc:
            args.write_doc.write_bytes(markdown.encode("utf-8"))
        else:
            sys.stdout.buffer.write(markdown.encode("utf-8"))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")


if __name__ == "__main__":
    main()
