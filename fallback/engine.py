#!/usr/bin/env python3
"""ai-guard fallback engine — python mirror of the node CLI contract (stdlib only).

Used when the environment has no node (hooks can still block). Mirrored contract:
check-prompt / check-file / allow / self-test, exit codes 0/1/2, UTC-dated audit
JSONL, bypass store with hashed paths, English stderr — same as src/cli.ts.
Builtin rules are loaded from rules.json next to this file (or env AI_GUARD_BUILTIN_RULES);
dist/rules.json is a build artifact exported by src/scripts/export-rules.ts
(exactly 5 fields: id, severity, pattern, description, builtin?).
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# module-level regexes (mirror src/engine/mask.ts, scanner.ts, check-file.ts)
# ---------------------------------------------------------------------------

# a placeholder is a short human-chosen token; values longer than 200 chars are treated as real
PLACEHOLDER_RE = re.compile(
    r"^(test|tests|example|examples|sample|samples|dummy|fake|placeholder|"
    r"change[-_]?me|xxx+|\*+|your[-_][a-z0-9_.-]*|"
    r"(?:your|my)[-_]?(?:key|token|pass(?:word)?|secret|api[_-]?key)[a-z0-9_-]*|"
    r"<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\([a-z ]*\))[-_.a-z0-9]*$",
    re.IGNORECASE,
)

# (?<![a-z0-9]) instead of a leading \b: allows a "_" prefix in DB_PASSWORD/MY_API_KEY;
# ["']? after \b: supports the JSON form "password": "value" (quote before the colon)
# re.ASCII: JS \b/\w are ASCII-based — "đAKIA..." must match like JS (parity)
GENERIC_ASSIGN_RE = re.compile(
    r"(?<![a-z0-9])(passwo?rd|passwd|secret|secret[_-]?key|api[_-]?key|apikey|"
    r"auth[_-]?token|access[_-]?token|client[_-]?secret|admin[_-]?pass)\b"
    r"[\"']?\s*[:=]\s*[\"']?([^\s\"']{8,})[\"']?",
    re.IGNORECASE | re.ASCII,
)

# apply_patch (Codex): the path is inside the patch text — "*** Update File: <path>" in each hunk header.
PATCH_FILE_RE = re.compile(r"\*\*\* (?:Update|Add|Delete) File: ([^\n]+)")

TOKEN_CANDIDATE_RE = re.compile(r"[A-Za-z0-9+/_$&!#%-]{20,}")

COMMON_WORD_RE = re.compile(r"^[a-z][a-z\-']{5,}$")

MAX_FINDINGS = 20

SEVERITIES = ("block", "warn")

# ---------------------------------------------------------------------------
# mask / entropy
# ---------------------------------------------------------------------------


def is_placeholder(value: str) -> bool:
    if len(value) > 200:
        return False
    return PLACEHOLDER_RE.fullmatch(value.strip()) is not None


def mask_secret(value: str) -> str:
    s = value.strip()
    if len(s) <= 4:
        return "***"
    if len(s) <= 14:
        return s[:2] + "***"
    return s[:6] + "***" + s[-4:]


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq: dict = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    h = 0.0
    for c in freq.values():
        p = c / len(s)
        h -= p * math.log2(p)
    return h


def is_high_entropy(s: str, min_len: int = 20, min_h: float = 3.5) -> bool:
    if len(s) < min_len:
        return False
    # skip all-lowercase tokens that look like natural words
    if COMMON_WORD_RE.match(s) and shannon_entropy(s) < 4.2:
        return False
    return shannon_entropy(s) >= min_h


# ---------------------------------------------------------------------------
# rules loading (mirror src/engine/loader.ts + dist/rules.json artifact)
# ---------------------------------------------------------------------------


def builtin_rules_path() -> str:
    env = os.environ.get("AI_GUARD_BUILTIN_RULES")
    if env and os.path.exists(env):
        return env
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules.json")


def _read_json_safe(path: str):
    """Read JSON fail-open; strip BOM if present. Returns None when missing/invalid."""
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if content.startswith("﻿"):
            content = content[1:]
        return json.loads(content)
    except (OSError, ValueError):
        return None


def compile_rules(rules: list) -> list:
    """Compile each rule's pattern; an invalid regex is kept as-is (no 're').

    re.ASCII: without the 'u' flag JS regex \\b/\\w/\\d are ASCII-based —
    "đAKIA..." must match like JS (python's unicode mode would skip that \b).
    """
    out = []
    for r in rules:
        c = dict(r)
        pattern = r.get("pattern") or ""
        if pattern:
            try:
                c["re"] = re.compile(pattern, re.ASCII)
            except re.error:
                pass
        out.append(c)
    return out


def load_rules(root: str) -> list:
    """builtin artifact -> project rules.json: remove -> add (replace) -> override."""
    builtin_raw = _read_json_safe(builtin_rules_path())
    rules: list = list(builtin_raw) if isinstance(builtin_raw, list) else []

    raw = _read_json_safe(os.path.join(root, ".ai-guard", "rules.json"))
    if isinstance(raw, dict):
        remove = raw.get("remove")
        if isinstance(remove, list):
            gone = set(remove)
            rules = [r for r in rules if r.get("id") not in gone]
        add = raw.get("add")
        if isinstance(add, list):
            adds = [a for a in add
                    if isinstance(a, dict)
                    and isinstance(a.get("id"), str)
                    and isinstance(a.get("pattern"), str)
                    and a.get("severity") in SEVERITIES
                    and isinstance(a.get("description"), str)]
            for a in adds:
                if any(r.get("id") == a["id"] for r in rules):
                    rules = [a if r.get("id") == a["id"] else r for r in rules]
                else:
                    rules.append(a)
        ov = raw.get("override")
        if isinstance(ov, dict):
            def _apply(r):
                o = ov.get(r.get("id"))
                if isinstance(o, dict) and o.get("severity") in SEVERITIES:
                    return {**r, "severity": o["severity"]}
                return r
            rules = [_apply(r) for r in rules]

    compiled = compile_rules(rules)
    # empty pattern (builtin detector) is kept as-is; an invalid pattern that fails to compile is dropped
    return [r for r in compiled if not r.get("pattern") or "re" in r]


def load_config(root: str) -> dict:
    cfg = _read_json_safe(os.path.join(root, ".ai-guard", "config.json"))
    if not isinstance(cfg, dict):
        cfg = {}
    sp = cfg.get("sensitivePaths")
    generic = cfg.get("genericSecret")
    entropy = cfg.get("highEntropy")
    # NOTE: the config may contain a "jev" block (JEV/OpenJEV decision API) — the fallback DELIBERATELY ignores it:
    # this engine is stdlib-only, no-network, meant for environments without node. JEV is an
    # optional feature, needs HTTP, and only runs in the node CLI (src/engine/jev.ts). Ignoring it here is correct fail-open.
    return {
        "sensitivePaths": sp if isinstance(sp, list) and sp else list(DEFAULT_SENSITIVE_PATHS),
        "genericSecret": generic if isinstance(generic, bool) else True,
        "highEntropy": entropy if isinstance(entropy, bool) else True,
    }


# ---------------------------------------------------------------------------
# paths (mirror src/engine/paths.ts)
# ---------------------------------------------------------------------------

DEFAULT_SENSITIVE_PATHS = [
    ".env", ".env.*", "*.env",
    "*.pem", "*.key", "*.p12", "*.pfx",
    "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
    "credentials*", "*credentials*.json", "*credentials*.yaml", "*credentials*.yml",
    "secrets/**", ".secrets/**",
    ".aws/credentials", ".npmrc", ".netrc", ".pypirc",
    "service-account*.json", "*service-account*.json",
]


def normalize_path(p: str) -> str:
    # strip drive/../ so files OUTSIDE the project root (relative gives ../..) still match
    # patterns by basename — fail-closed
    s = p.replace("\\", "/")
    s = re.sub(r"^[a-z]:", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^(\.\./)+", "", s)
    s = re.sub(r"^\./", "", s)
    s = re.sub(r"^/+", "", s)
    return s.lower()


def glob_to_regex(glob: str):
    n = normalize_path(glob)
    out = []
    i = 0
    while i < len(n):
        c = n[i]
        if c == "*":
            if i + 1 < len(n) and n[i + 1] == "*":
                out.append(".*")
                i += 1
            else:
                out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c in ".+^${}()|[]\\":
            out.append("\\" + c)
        else:
            out.append(c)
        i += 1
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE)


def is_sensitive_path(path: str, patterns: list) -> bool:
    rel = normalize_path(path)
    for pat in patterns:
        rex = glob_to_regex(pat)
        if rex.search(rel):
            return True
        # for patterns without '/': also match when the file is in a subdir
        if "/" not in pat:
            base = rel.split("/")[-1]
            if rex.search(base):
                return True
    return False


# ---------------------------------------------------------------------------
# scanner (mirror src/engine/scanner.ts)
# ---------------------------------------------------------------------------


def scan(text: str, rules: list, generic: bool = True, entropy: bool = True) -> list:
    findings: list = []
    for rule in rules:
        rex = rule.get("re")
        if rex is None:
            continue
        m = rex.search(text)
        if m and m.group(0):
            findings.append({
                "ruleId": rule.get("id"),
                "severity": rule.get("severity"),
                "description": rule.get("description"),
                "preview": mask_secret(m.group(0)),
            })
            if len(findings) >= MAX_FINDINGS:
                return findings
    if generic:
        seen = set()
        for m in GENERIC_ASSIGN_RE.finditer(text):
            value = m.group(2)
            if value in seen:
                continue
            seen.add(value)
            # key context (password=/api_key:) is already a strong signal — only filter out
            # placeholders; NO entropy gate here (would miss lowercase secrets)
            if not is_placeholder(value):
                findings.append({
                    "ruleId": "generic-secret",
                    "severity": "warn",
                    "description": "Secret value assigned in text",
                    "preview": mask_secret(value),
                })
                if len(findings) >= MAX_FINDINGS:
                    return findings
    if entropy:
        seen = set()
        for token in TOKEN_CANDIDATE_RE.findall(text):
            if token in seen:
                continue
            seen.add(token)
            if is_placeholder(token):
                continue
            if is_high_entropy(token):
                findings.append({
                    "ruleId": "high-entropy",
                    "severity": "warn",
                    "description": "High-entropy token",
                    "preview": mask_secret(token),
                })
                if len(findings) >= MAX_FINDINGS:
                    return findings
    return findings


# ---------------------------------------------------------------------------
# audit + root + bypass (mirror src/audit/log.ts, src/root.ts, src/bypass/store.ts)
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def append_audit(root: str, evt: dict) -> None:
    """JSONL per UTC day, fail-open (auditing must not break the hook)."""
    try:
        d = os.path.join(root, ".ai-guard", "logs")
        os.makedirs(d, exist_ok=True)
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with open(os.path.join(d, day + ".jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, separators=(",", ":"), ensure_ascii=False) + "\n")
    except OSError:
        pass


def find_root(start: str):
    env_root = os.environ.get("AI_GUARD_ROOT")
    if env_root:
        p = os.path.abspath(env_root)
        return p if os.path.exists(p) else None
    d = os.path.abspath(start)
    for _ in range(30):  # depth limit of 30 levels
        if os.path.exists(os.path.join(d, ".ai-guard")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def _bypass_dir(root: str) -> str:
    return os.path.join(root, ".ai-guard", ".bypass")


def _path_hash(path: str) -> str:
    return hashlib.sha1(path.replace("\\", "/").lower().encode("utf-8")).hexdigest()[:12]


def _flag_name(scope: str, path=None) -> str:
    return "{}-{}.json".format(scope, _path_hash(path) if path else "all")


def _rm_force(fp: str) -> None:
    try:
        os.remove(fp)
    except OSError:
        pass


def grant_bypass(root: str, scope: str, path, minutes: int) -> None:
    """Write the bypass flag — atomic (tmp + rename) so readers never see a half-written file."""
    d = _bypass_dir(root)
    os.makedirs(d, exist_ok=True)
    now = int(time.time() * 1000)
    flag = {"scope": scope}
    if path:
        flag["pathHash"] = _path_hash(path)
    flag.update({
        "grantedAt": _iso_from_ms(now),
        "expiresAt": now + minutes * 60_000,
        "duration_min": minutes,
    })
    target = os.path.join(d, _flag_name(scope, path))
    tmp = "{}.tmp-{}".format(target, now)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(flag, separators=(",", ":"), ensure_ascii=False))
    os.replace(tmp, target)


def has_valid_bypass(root: str, scope: str, path=None) -> bool:
    """Prune expired/corrupt flags (force-rm), then check the target flag is still valid."""
    d = _bypass_dir(root)
    try:
        if not os.path.isdir(d):
            return False
        now = time.time() * 1000
        for f in os.listdir(d):
            if not f.endswith(".json"):
                continue
            fp = os.path.join(d, f)
            try:
                with open(fp, "r", encoding="utf-8") as fh:
                    flag = json.load(fh)
                exp = flag.get("expiresAt") if isinstance(flag, dict) else None
                if not isinstance(exp, (int, float)) or exp <= now:
                    _rm_force(fp)
            except (OSError, ValueError):
                _rm_force(fp)
        target = os.path.join(d, _flag_name(scope, path))
        if not os.path.exists(target):
            return False
        with open(target, "r", encoding="utf-8") as fh:
            flag = json.load(fh)
        if not isinstance(flag, dict):
            return False
        exp = flag.get("expiresAt")
        return flag.get("scope") == scope and isinstance(exp, (int, float)) and exp > now
    except (OSError, ValueError):
        return False


# ---------------------------------------------------------------------------
# argv helper (mirror src/util/argv.ts)
# ---------------------------------------------------------------------------


def flag_value(argv: list, flag: str):
    try:
        i = argv.index(flag)
    except ValueError:
        return None
    return argv[i + 1] if i + 1 < len(argv) else None


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


def extract_prompt(input_text: str):
    """JSON alias fields (prompt/input/message/text/userPrompt/content) -> else RAW.

    Alias keys follow src/commands/check-prompt.ts but are a SUBSET (TS is a superset:
    Kiro's nested data.prompt|triggerData.prompt exist only in TS since this fallback only
    serves Claude Code/Codex) — userPrompt/content added for Kiro UserPromptSubmit
    (user-verified: prompt text is findable under one of those keys). Valid JSON but
    NO alias field is a string (hook payload uses an unknown field name) -> scan raw:
    the secret still appears verbatim in the JSON text.
    """
    s = input_text.strip()
    if not s:
        return None
    if s.startswith("{"):
        try:
            j = json.loads(s)
        except ValueError:
            j = None
        if isinstance(j, dict):
            for key in ("prompt", "input", "message", "text", "userPrompt", "content"):
                v = j.get(key)
                if isinstance(v, str):
                    return v
    return s


def cmd_check_prompt(args: list, stdin_text: str) -> int:
    root_arg = flag_value(args, "--root")
    root = root_arg if root_arg is not None else os.getcwd()
    tool = flag_value(args, "--tool") or "unknown"
    prompt = extract_prompt(stdin_text)
    if not prompt:
        return 0
    project_root = find_root(root)
    if project_root is None:
        return 0  # not initialized -> fail-open
    cfg = load_config(project_root)
    rules = load_rules(project_root)
    findings = scan(prompt, rules, generic=cfg["genericSecret"], entropy=cfg["highEntropy"])
    if not findings:
        return 0
    blocks = [f for f in findings if f["severity"] == "block"]
    warns = [f for f in findings if f["severity"] == "warn"]
    ts = _now_iso()
    if warns:
        append_audit(project_root, {
            "ts": ts, "tool": tool, "event": "prompt", "action": "warned",
            "rule": warns[0]["ruleId"], "preview": warns[0]["preview"], "count": len(warns),
        })
    if not blocks:
        return 0
    if has_valid_bypass(project_root, "prompt"):
        append_audit(project_root, {
            "ts": ts, "tool": tool, "event": "prompt", "action": "allowed_after_confirm",
            "rule": blocks[0]["ruleId"], "preview": blocks[0]["preview"], "count": len(blocks),
        })
        return 0
    append_audit(project_root, {
        "ts": ts, "tool": tool, "event": "prompt", "action": "blocked",
        "rule": blocks[0]["ruleId"], "preview": blocks[0]["preview"], "count": len(blocks),
    })
    lines = [
        "ai-guard: BLOCKED — credential detected in prompt (not sent to AI).",
    ]
    for f in blocks[:5]:
        lines.append("  • {}: {} [preview: {}]".format(f["ruleId"], f["description"], f["preview"]))
    if len(blocks) > 5:
        lines.append("  • ... and {} more findings".format(len(blocks) - 5))
    lines.append("If you INTENTIONALLY want to send this, run the following then resubmit:")
    lines.append("  python .ai-guard/bin/engine.py allow prompt --5m")
    lines.append("(The next submission within the window will be recorded in the audit log.)")
    sys.stderr.write("\n".join(lines) + "\n")
    return 2


def extract_path_candidates(argv: list, input_text: str) -> list:
    """Collect path candidates in priority order:

    1) argv positional — drop flag values (--flag value), take the last one.
    2) stdin JSON: first direct field (file_path|notebook_path|path|j.path)
       — an explicit path wins, do NOT scan the patch.
    3) if there is no explicit path: EVERY patch header in
       tool_input.input|command|patch (the caller blocks on the FIRST sensitive candidate).
    """
    flag_vals = set()
    for i, a in enumerate(argv):
        if a.startswith("--") and i + 1 < len(argv):
            flag_vals.add(argv[i + 1])
    positional = [a for a in argv if not a.startswith("--") and a not in flag_vals]
    if positional:
        return [positional[-1]]
    s = input_text.strip()
    if not s.startswith("{"):
        return []
    try:
        j = json.loads(s)
    except ValueError:
        return []
    if not isinstance(j, dict):
        return []
    ti = j.get("tool_input")
    ti = ti if isinstance(ti, dict) else {}
    for key in ("file_path", "notebook_path", "path"):
        v = ti.get(key)
        if isinstance(v, str):
            return [v]
    if isinstance(j.get("path"), str):
        return [j["path"]]
    out = []
    for key in ("input", "command", "patch"):
        v = ti.get(key)
        if not isinstance(v, str):
            v = j.get(key)
        if isinstance(v, str):
            for m in PATCH_FILE_RE.finditer(v):
                t = m.group(1).strip()
                if t:
                    out.append(t)
    return out


def cmd_check_file(args: list, stdin_text: str) -> int:
    root_arg = flag_value(args, "--root")
    root = root_arg if root_arg is not None else os.getcwd()
    tool = flag_value(args, "--tool") or "unknown"
    project_root = find_root(root)
    if project_root is None:
        return 0
    candidates = extract_path_candidates(args, stdin_text)
    if not candidates:
        return 0
    cfg = load_config(project_root)
    for raw in candidates:
        abs_p = raw if os.path.isabs(raw) else os.path.join(project_root, raw)
        try:
            rel_raw = os.path.relpath(abs_p, project_root)
        except ValueError:  # different drive on windows
            rel_raw = abs_p
        rel = normalize_path(rel_raw or raw)
        if not is_sensitive_path(rel, cfg["sensitivePaths"]):
            continue
        if has_valid_bypass(project_root, "file", rel):
            append_audit(project_root, {
                "ts": _now_iso(), "tool": tool, "event": "file",
                "action": "allowed_after_confirm", "path": rel,
            })
            return 0
        append_audit(project_root, {
            "ts": _now_iso(), "tool": tool, "event": "file", "action": "blocked", "path": rel,
        })
        sys.stderr.write("\n".join([
            "ai-guard: BLOCKED — sensitive file (AI not allowed to read/write).",
            "  • Path: {}".format(rel),
            "If you INTENTIONALLY want to allow this file, run:",
            "  python .ai-guard/bin/engine.py allow file {} --10m".format(rel),
        ]) + "\n")
        return 2
    return 0


def cmd_allow(args: list) -> int:
    root_val = flag_value(args, "--root")
    root = root_val if root_val is not None else os.getcwd()
    project_root = find_root(root)
    if project_root is None:
        # no-root hint: non-npm machines run the fallback installer (the installer itself creates .ai-guard)
        sys.stderr.write(
            "ai-guard: no .ai-guard found — run install.sh/install.ps1 (fallback) "
            "or `npx ai-guard init` (npm).\n")
        return 1
    scope = args[0] if args else None
    if scope not in ("prompt", "file"):
        sys.stderr.write(
            "ai-guard: use `python engine.py allow prompt --5m` "
            "or `python engine.py allow file <path> --10m`\n")
        return 1
    minutes_flag = next((a for a in args if re.match(r"^--\d+m$", a)), None)
    if minutes_flag is None:
        sys.stderr.write("ai-guard: missing duration, e.g. --5m or --10m\n")
        return 1
    minutes = int(minutes_flag[2:-1])  # "--5m" -> 5 (the regex already guarantees the --\d+m form)
    if not (1 <= minutes <= 1440):
        sys.stderr.write("ai-guard: duration must be between 1 and 1440 minutes (24h)\n")
        return 1
    path = None
    if scope == "file":
        path = next((a for i, a in enumerate(args)
                     if i > 0 and not a.startswith("--")
                     and a != minutes_flag and a != root_val), None)
        if path is None:
            sys.stderr.write("ai-guard: missing path, e.g. `python engine.py allow file .env --10m`\n")
            return 1
    grant_bypass(project_root, scope, path, minutes)
    evt = {
        "ts": _now_iso(), "tool": "user", "event": "bypass", "action": "bypass_granted",
        "scope": scope, "path": path, "duration_min": minutes,
    }
    append_audit(project_root, {k: v for k, v in evt.items() if v is not None})
    sys.stdout.write("ai-guard: allowed {}{} for {} minutes (audit logged).\n".format(
        scope, " " + path if path else "", minutes))
    return 0


JWT_TOKEN_SELF = (
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
)

# mirrors all 9 fixtures of src/selftest-fixtures.ts (the engine uses the builtin
# artifact — when the installer copies the full dist/rules.json, 9/9 pass)
SELF_TEST_FIXTURES = [
    {"name": "aws-key", "input": "AKIAIOSFODNN7EXAMPLE",
     "expectRule": "aws-access-key", "expectBlocked": True},
    {"name": "openai", "input": "sk-projabcdefghijklmnopqrstuvwx",
     "expectRule": "openai-api-key", "expectBlocked": True},
    {"name": "github", "input": "ghp_" + "a1" * 18,
     "expectRule": "github-pat", "expectBlocked": True},
    {"name": "db-url", "input": "postgres://u:pw@host/db",
     "expectRule": "db-url", "expectBlocked": True},
    {"name": "pem", "input": "-----BEGIN PRIVATE KEY-----",
     "expectRule": "private-key", "expectBlocked": True},
    {"name": "slack", "input": "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuv",
     "expectRule": "slack-token", "expectBlocked": True},
    {"name": "jwt-warn", "input": JWT_TOKEN_SELF,
     "expectRule": "jwt", "expectBlocked": False},
    {"name": "login-pair", "input": "ssh to server user name: root , password: 12345",
     "expectRule": "login-credential-pair", "expectBlocked": True},
    {"name": "clean-text", "input": "viết cho tôi hàm quicksort bằng typescript",
     "expectBlocked": False},
]


def self_test():
    """Self-check the engine against built-in fixtures (does NOT load project rules)."""
    builtin_raw = _read_json_safe(builtin_rules_path())
    rules = compile_rules(builtin_raw if isinstance(builtin_raw, list) else [])
    failures = []
    for f in SELF_TEST_FIXTURES:
        findings = scan(f["input"], rules, generic=True, entropy=True)
        blocked = any(x["severity"] == "block" for x in findings)
        rule_ok = (not f.get("expectRule")) or any(x["ruleId"] == f["expectRule"] for x in findings)
        if blocked != f["expectBlocked"] or not rule_ok:
            failures.append("{}: expected rule={} blocked={}, got [{}]".format(
                f["name"], f.get("expectRule", "-"), f["expectBlocked"],
                ",".join(x["ruleId"] or "-" for x in findings)))
    return len(SELF_TEST_FIXTURES), failures


def cmd_self_test(args: list) -> int:
    if not isinstance(_read_json_safe(builtin_rules_path()), list):
        sys.stderr.write(
            "ai-guard: builtin rules artifact not found ({}) — "
            "the installer copies dist/rules.json to fallback/rules.json.\n".format(
                builtin_rules_path()))
    total, failures = self_test()
    for f in failures:
        print("✗ " + f)
    print("self-test: {}/{} pass".format(total - len(failures), total))
    return 1 if failures else 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

COMMANDS = ("check-prompt", "check-file", "allow", "self-test")

# only these commands read stdin; other commands (allow, self-test, ...) must dispatch
# immediately, otherwise they hang on a TTY waiting for EOF
STDIN_COMMANDS = ("check-prompt", "check-file")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="engine.py",
        description="ai-guard fallback engine — python mirror of the node CLI contract",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for name, helptext in [
        ("check-prompt", "scan stdin (prompt) for secrets"),
        ("check-file", "block sensitive paths (argv positional or stdin JSON/patch header)"),
        ("allow", "temporarily allow (bypass) a prompt or file"),
        ("self-test", "run engine self-test with built-in fixtures"),
    ]:
        # the subparser declares no arguments: the rest of argv is returned
        # intact (parse_known_args) so cmd_* parse it themselves per the node contract
        sub.add_parser(name, help=helptext)
    return parser


def _read_stdin() -> str:
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return ""
        return sys.stdin.read()
    except (OSError, ValueError):
        return ""


def _reconfigure_streams() -> None:
    # stdin + stderr — force utf-8 so nothing breaks on a cp1252 console/pipe (prompt
    # input may contain arbitrary utf-8)
    # (windows). Without reconfiguring stdin, reading a utf-8 prompt under cp1252 raises
    # UnicodeDecodeError (subclass of ValueError) -> fail-open swallows the error -> exit 0
    # WITHOUT scanning (silent-skip) — reproducer: PYTHONIOENCODING=cp1252.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


def main(argv=None) -> int:
    _reconfigure_streams()
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = _build_parser()
    command = argv[0] if argv else None
    if command in ("-h", "--help"):
        parser.parse_args(argv)  # print help then exit 0
    if command not in COMMANDS:
        sys.stderr.write(
            "ai-guard: unknown or missing command. "
            "usage: engine.py <check-prompt|check-file|allow|self-test>\n")
        return 1
    ns, extra = parser.parse_known_args(argv)
    if command in STDIN_COMMANDS:
        stdin_text = _read_stdin()
        if command == "check-prompt":
            return cmd_check_prompt(extra, stdin_text)
        return cmd_check_file(extra, stdin_text)
    if command == "allow":
        return cmd_allow(extra)
    return cmd_self_test(extra)


if __name__ == "__main__":
    sys.exit(main())
