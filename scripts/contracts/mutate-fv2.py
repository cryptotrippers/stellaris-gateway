#!/usr/bin/env python3
"""Mutation pass over fraction_vault v2 (SPEC-v2.md §8).

Each mutant breaks one guard; the tests nearest the mutation run first and
the run stops at the first failing test (mutant killed). A mutant that
survives every group is reported for review (equivalent mutant or test gap).

Usage (from the repo root; needs aiken on PATH or in ~/.local/bin):
  python3 scripts/contracts/mutate-fv2.py contracts/fraction-vault mutants.json [--workers N] [--list]

Re-running with the same out.json resumes where it stopped.
"""
import json, os, re, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

AIKEN = shutil.which("aiken") or os.path.expanduser("~/.local/bin/aiken")
FILES = ["validators/offering_v2.ak", "validators/pledge.ak", "validators/fraction_v2.ak", "lib/stellaris/fv2.ak"]

S = "fv2_scenarios.{%s}"
GROUPS = {
    "open": [S % "open_"],
    "pledge": [S % p for p in ["pledge_accepts", "pledge_with", "pledge_overpaying", "pledge_after", "pledge_must", "pledge_once", "pledge_against", "pledge_for", "pledge_cannot", "pledge_owner", "pledge_of"]],
    "settle": [S % p for p in ["settle_one", "settle_a_batch", "settle_by", "settle_needs", "settle_beyond", "settle_up", "settle_after", "settle_inside", "settle_once", "settle_paying", "settle_minting", "settle_record", "settle_of", "settle_double", "settle_keeping", "settle_without", "settle_burning", "settle_with", "settle_pledge"]],
    "raise": [S % p for p in ["close_", "fail_raise", "cancel_raise"]],
    "refund": [S % p for p in ["refund_", "one_payout", "two_pledges", "cancel_pledge"]],
    "ops": [S % p for p in ["release_", "commit_period", "set_fees", "claim_fee", "rotate_"]],
    "wind": [S % p for p in ["begin_wind", "redeem_", "claim_fee_after"]],
    "inv": [S % p for p in ["inv", "f6_", "commit_fixture"]],
    "alone": [S % "alone_"],
    "lib": ["stellaris/fv2.{%s}" % p for p in ["bps_is", "fee_cap", "pro_rata", "threshold_counts", "committee_must", "units_in"]],
}
ALL = ["inv", "alone", "settle", "refund", "ops", "wind", "raise", "pledge", "open", "lib"]

OFFERING_BRANCHES = {
    "Settle": "settle", "CloseRaise": "raise", "FailRaise": "raise", "CancelRaise": "raise",
    "RefundFraction": "refund", "Release": "ops", "CommitPeriod": "ops", "SetFees": "ops",
    "ClaimFee": "ops", "Rotate": "ops", "BeginWindDown": "wind", "Redeem": "wind",
}
PLEDGE_BRANCHES = {"MintPledge": "pledge", "BurnPledges": "settle", "SettlePledge": "settle",
                   "CancelPledge": "refund", "RefundPledge": "refund"}


def region(path, lines, i):
    """First test group to try for a mutation at line i."""
    if path.endswith("fv2.ak"):
        return "lib"
    if path.endswith("fraction_v2.ak"):
        return "settle"
    table = OFFERING_BRANCHES if "offering_v2" in path else PLEDGE_BRANCHES
    for j in range(i, -1, -1):
        m = re.match(r"\s*(\w+)\s*(\{[^}]*\})?\s*->", lines[j])
        if m and m.group(1) in table:
            return table[m.group(1)]
        if re.match(r"\s*(mint|spend)\(", lines[j]):
            if "offering_v2" in path and lines[j].strip().startswith("mint("):
                return "open"
            if "pledge" in path and lines[j].strip().startswith("spend("):
                return "refund"
            break
        if re.match(r"(pub )?fn (\w+)", lines[j]):
            name = re.match(r"(pub )?fn (\w+)", lines[j]).group(2)
            return {"settle_walk": "settle", "eligible": "settle", "fractions_move": "settle",
                    "paid_to": "ops", "state_value_ok": "inv", "ends_by": "settle",
                    "starts_after": "raise", "returned": "refund", "burns": "refund",
                    "state_in": "pledge", "holds_marker": "settle"}.get(name, "inv")
    return "inv"


def code_lines(path, lines):
    """Indexes of mutable code lines (not comments, imports or tests)."""
    out, in_tests = [], False
    for i, l in enumerate(lines):
        s = l.strip()
        if path.endswith("fv2.ak") and s.startswith("// Tests"):
            in_tests = True
        if in_tests or s.startswith("//") or s.startswith("use ") or s.startswith("test "):
            continue
        out.append(i)
    return out


REL = [(r"(?<![=!<>|-])==(?!=)", "!="), (r"!=", "=="), (r"<=", "<"), (r">=", ">"),
       (r"(?<![<-])<(?![=>-])", "<="), (r"(?<![=>|-])>(?![=>])", ">=")]


def mutants_for(path, text):
    lines = text.split("\n")
    code = set(code_lines(path, lines))
    res = []
    # 1. conjunct deletion inside `and { ... }`
    for i, l in enumerate(lines):
        if i in code and re.search(r"\band \{\s*$", l):
            # children start at the indentation of the next code line; the
            # block ends at the first line indented less than the children
            j = i + 1
            while lines[j].strip() == "" or lines[j].strip().startswith("//"):
                j += 1
            child_ind = len(lines[j]) - len(lines[j].lstrip())
            starts = []
            while j < len(lines):
                lj = lines[j]
                cur = len(lj) - len(lj.lstrip())
                if lj.strip() == "":
                    j += 1
                    continue
                if cur < child_ind:
                    break
                if cur == child_ind and not lj.strip().startswith(("//", "}", ")", "]")):
                    starts.append(j)
                j += 1
            end = j
            for k, s0 in enumerate(starts):
                e0 = starts[k + 1] if k + 1 < len(starts) else end
                new = lines[:s0] + [" " * child_ind + "True,"] + lines[e0:]
                res.append(("drop conjunct", s0, "\n".join(new), lines[s0].strip()[:80]))
    # 2. operator swaps
    for i in sorted(code):
        l = lines[i]
        body = l.split("//")[0]
        # type signatures (`List<Input>`, `Option<PolicyId>`) are not comparisons
        rel = [] if re.search(r"\w<\w", body) else REL
        for pat, rep in rel + [(r"&&", "||"), (r"\|\|", "&&"), (r" \+ ", " - "), (r" - ", " + ")]:
            for m in re.finditer(pat, body):
                nl = l[:m.start()] + (rep if not rep.startswith(" ") else rep) + l[m.end():]
                new = lines[:i] + [nl] + lines[i + 1:]
                res.append((f"{m.group(0).strip()} -> {rep.strip()}", i, "\n".join(new), l.strip()[:80]))
        for m in re.finditer(r"\bTrue\b|\bFalse\b", body):
            rep = "False" if m.group(0) == "True" else "True"
            nl = l[:m.start()] + rep + l[m.end():]
            res.append((f"{m.group(0)} -> {rep}", i, "\n".join(lines[:i] + [nl] + lines[i + 1:]), l.strip()[:80]))
        for m in re.finditer(r"!(?=[a-z(])", body):
            nl = l[:m.start()] + l[m.end():]
            res.append(("drop !", i, "\n".join(lines[:i] + [nl] + lines[i + 1:]), l.strip()[:80]))
    return [(path, kind, i, new, src, region(path, lines, i)) for (kind, i, new, src) in res]


def run_group(d, group):
    args = [AIKEN, "check", "-f", "user-defined"]
    for p in GROUPS[group]:
        args += ["-m", p]
    r = subprocess.run(args, cwd=d, capture_output=True, text=True)
    if r.stdout.strip() == "":
        return "compile_error", None
    rep = json.loads(r.stdout)
    for m in rep.get("modules", []):
        for t in m.get("tests", []):
            if t.get("status") != "pass":
                return "killed", t["title"]
    return "survived", None


def main():
    proj, out = sys.argv[1], sys.argv[2]
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 2
    muts = []
    for f in FILES:
        muts += mutants_for(f, open(os.path.join(proj, f)).read())
    print(len(muts), "mutants", flush=True)
    if "--list" in sys.argv:
        for m in muts:
            print(m[0], m[2] + 1, m[1], "|", m[4], "|", m[5])
        return
    tmp = tempfile.mkdtemp(prefix="fv2mut-")
    dirs = []
    for w in range(workers):
        d = os.path.join(tmp, f"w{w}")
        shutil.copytree(proj, d, ignore=shutil.ignore_patterns("plutus.json"))
        dirs.append(d)
    results = json.load(open(out)) if os.path.exists(out) else []
    done = {(r["file"], r["line"], r["mutation"], r["source"]) for r in results}

    def work(w):
        d = dirs[w]
        for idx in range(w, len(muts), workers):
            path, kind, line, new, src, first = muts[idx]
            if (path, line + 1, kind, src) in done:
                continue
            orig = open(os.path.join(d, path)).read()
            open(os.path.join(d, path), "w").write(new)
            outcome, by = "survived", None
            for g in [first] + [g for g in ALL if g != first]:
                outcome, by = run_group(d, g)
                if outcome != "survived":
                    break
            open(os.path.join(d, path), "w").write(orig)
            rec = {"file": path, "line": line + 1, "mutation": kind, "source": src,
                   "outcome": outcome, "killed_by": by}
            results.append(rec)
            print(json.dumps(rec), flush=True)
            json.dump(results, open(out, "w"), indent=1)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(work, range(workers)))
    json.dump(results, open(out, "w"), indent=1)
    s = {}
    for r in results:
        s[r["outcome"]] = s.get(r["outcome"], 0) + 1
    print("SUMMARY", s, flush=True)


if __name__ == "__main__":
    main()
