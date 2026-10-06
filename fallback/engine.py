#!/usr/bin/env python3
"""ai-guard fallback engine — python mirror của node CLI contract (stdlib only).

Dùng khi môi trường không có node (hook vẫn chặn được). Contract mirror:
check-prompt / check-file / allow / self-test, exit codes 0/1/2, audit JSONL
ngày UTC, bypass store có hash path, stderr tiếng Việt — giống src/cli.ts.
Builtin rules load từ rules.json cạnh file này (hoặc env AI_GUARD_BUILTIN_RULES);
dist/rules.json là build artifact do src/scripts/export-rules.ts xuất
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

# placeholder là token ngắn do con người đặt; giá trị dài >200 ký tự coi như thật
PLACEHOLDER_RE = re.compile(
    r"^(test|tests|example|examples|sample|samples|dummy|fake|placeholder|"
    r"change[-_]?me|xxx+|\*+|your[-_][a-z0-9_.-]*|"
    r"(?:your|my)[-_]?(?:key|token|pass(?:word)?|secret|api[_-]?key)[a-z0-9_-]*|"
    r"<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\([a-z ]*\))[-_.a-z0-9]*$",
    re.IGNORECASE,
)

# (?<![a-z0-9]) thay cho \b đầu: cho phép tiền tố "_" trong DB_PASSWORD/MY_API_KEY;
# ["']? sau \b: hỗ trợ dạng JSON "password": "value" (quote đứng trước dấu hai chấm)
GENERIC_ASSIGN_RE = re.compile(
    r"(?<![a-z0-9])(passwo?rd|passwd|secret|secret[_-]?key|api[_-]?key|apikey|"
    r"auth[_-]?token|access[_-]?token|client[_-]?secret|admin[_-]?pass)\b"
    r"[\"']?\s*[:=]\s*[\"']?([^\s\"']{8,})[\"']?",
    re.IGNORECASE,
)

# apply_patch (Codex): path nằm trong patch text — "*** Update File: <path>" ở header mỗi hunk.
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
    # bỏ token thuần chữ thường giống từ tự nhiên
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
    """Đọc JSON fail-open; strip BOM nếu có. Trả None khi không tồn tại/lỗi."""
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
    """Compile pattern của từng rule; regex hỏng giữ nguyên (không có 're')."""
    out = []
    for r in rules:
        c = dict(r)
        pattern = r.get("pattern") or ""
        if pattern:
            try:
                c["re"] = re.compile(pattern)
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
    # pattern rỗng (builtin detector) giữ nguyên; pattern hỏng compile thì bỏ
    return [r for r in compiled if not r.get("pattern") or "re" in r]


def load_config(root: str) -> dict:
    cfg = _read_json_safe(os.path.join(root, ".ai-guard", "config.json"))
    if not isinstance(cfg, dict):
        cfg = {}
    sp = cfg.get("sensitivePaths")
    generic = cfg.get("genericSecret")
    entropy = cfg.get("highEntropy")
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
    # strip drive/../ để file NGOÀI project root (relative trả ../..) vẫn match
    # pattern theo basename — fail-closed
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
        # cho pattern không có '/': khớp cả khi file nằm trong subdir
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
            # ngữ cảnh key (password=/api_key:) đã là tín hiệu mạnh — chỉ chặn
            # placeholder; KHÔNG entropy gate ở đây (bỏ sót secret lowercase)
            if not is_placeholder(value):
                findings.append({
                    "ruleId": "generic-secret",
                    "severity": "warn",
                    "description": "Gán giá trị secret trong text",
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
                    "description": "Token entropy cao",
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
    """JSONL theo ngày UTC, fail-open (audit không được làm hỏng hook)."""
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
    for _ in range(30):  # giới hạn độ sâu 30 cấp
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
    """Ghi flag bypass — atomic (tmp + rename) để reader không thấy file nửa vời."""
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
    """Prune flag hết hạn/corrupt (force-rm) rồi check flag đích còn hiệu lực."""
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
    """JSON alias fields (prompt/input/message/text) -> else fallthrough quét RAW.

    JSON hợp lệ nhưng KHÔNG alias field nào là string (hook payload dùng field
    name lạ) -> quét raw: secret vẫn nằm nguyên văn trong JSON text.
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
            for key in ("prompt", "input", "message", "text"):
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
        return 0  # chưa init -> fail-open
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
        "ai-guard: ĐÃ CHẶN — phát hiện credential trong prompt (không gửi tới AI).",
    ]
    for f in blocks[:5]:
        lines.append("  • {}: {} [preview: {}]".format(f["ruleId"], f["description"], f["preview"]))
    if len(blocks) > 5:
        lines.append("  • ... và {} findings khác".format(len(blocks) - 5))
    lines.append("Nếu bạn CỐ Ý muốn gửi nội dung này, chạy lệnh sau rồi gửi lại prompt:")
    lines.append("  python engine.py allow prompt --5m")
    lines.append("(Lần gửi kế tiếp trong thời gian cho phép sẽ được ghi vào audit log.)")
    sys.stderr.write("\n".join(lines) + "\n")
    return 2


def extract_path_candidates(argv: list, input_text: str) -> list:
    """Thu thập path candidates theo thứ tự ưu tiên:

    1) argv positional — loại giá trị của flag (--flag value), lấy cái cuối.
    2) stdin JSON: direct field đầu tiên (file_path|notebook_path|path|j.path)
       — explicit path wins, KHÔNG scan patch.
    3) nếu không có path tường minh nào: MỌI patch header trong
       tool_input.input|command|patch (caller chặn candidate sensitive ĐẦU TIÊN).
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
        except ValueError:  # khác ổ đĩa trên windows
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
            "ai-guard: ĐÃ CHẶN — file nhạy cảm (chưa cho AI đọc/ghi).",
            "  • Path: {}".format(rel),
            "Nếu bạn CỐ Ý muốn cho phép file này, chạy:",
            "  python engine.py allow file {} --10m".format(rel),
        ]) + "\n")
        return 2
    return 0


def cmd_allow(args: list) -> int:
    root_val = flag_value(args, "--root")
    root = root_val if root_val is not None else os.getcwd()
    project_root = find_root(root)
    if project_root is None:
        sys.stderr.write("ai-guard: không tìm thấy .ai-guard — chạy `npx ai-guard init` trước.\n")
        return 1
    scope = args[0] if args else None
    if scope not in ("prompt", "file"):
        sys.stderr.write(
            "ai-guard: dùng `python engine.py allow prompt --5m` "
            "hoặc `python engine.py allow file <path> --10m`\n")
        return 1
    minutes_flag = next((a for a in args if re.match(r"^--\d+m$", a)), None)
    if minutes_flag is None:
        sys.stderr.write("ai-guard: thiếu thời gian cho phép, vd --5m hoặc --10m\n")
        return 1
    minutes = int(minutes_flag[2:-1])  # "--5m" -> 5 (regex đã đảm bảo dạng --\d+m)
    if not (1 <= minutes <= 1440):
        sys.stderr.write("ai-guard: thời gian cho phép phải từ 1 đến 1440 phút (24h)\n")
        return 1
    path = None
    if scope == "file":
        path = next((a for i, a in enumerate(args)
                     if i > 0 and not a.startswith("--")
                     and a != minutes_flag and a != root_val), None)
        if path is None:
            sys.stderr.write("ai-guard: thiếu path, vd `python engine.py allow file .env --10m`\n")
            return 1
    grant_bypass(project_root, scope, path, minutes)
    evt = {
        "ts": _now_iso(), "tool": "user", "event": "bypass", "action": "bypass_granted",
        "scope": scope, "path": path, "duration_min": minutes,
    }
    append_audit(project_root, {k: v for k, v in evt.items() if v is not None})
    sys.stdout.write("ai-guard: đã cho phép {}{} trong {} phút (đã ghi audit log).\n".format(
        scope, " " + path if path else "", minutes))
    return 0


JWT_TOKEN_SELF = (
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
)

SELF_TEST_FIXTURES = [
    {"name": "aws-key", "input": "AKIAIOSFODNN7EXAMPLE",
     "expectRule": "aws-access-key", "expectBlocked": True},
    {"name": "jwt-warn", "input": JWT_TOKEN_SELF,
     "expectRule": "jwt", "expectBlocked": False},
    {"name": "clean-text", "input": "viết cho tôi hàm quicksort bằng typescript",
     "expectBlocked": False},
]


def self_test():
    """Tự kiểm tra engine với fixture built-in (KHÔNG load project rules)."""
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
            "ai-guard: không tìm thấy builtin rules artifact ({}) — "
            "fallback/rules.json do installer copy từ dist/rules.json.\n".format(
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

# chỉ các lệnh này đọc stdin; các lệnh khác (allow, self-test, ...) phải dispatch
# ngay nếu không sẽ treo ở TTY chờ EOF
STDIN_COMMANDS = ("check-prompt", "check-file")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="engine.py",
        description="ai-guard fallback engine — python mirror của node CLI contract",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for name, helptext in [
        ("check-prompt", "quét stdin (prompt) tìm secret"),
        ("check-file", "chặn path nhạy cảm (argv positional hoặc stdin JSON/patch header)"),
        ("allow", "cho phép tạm thời (bypass) prompt hoặc file"),
        ("self-test", "tự kiểm tra engine với fixture built-in"),
    ]:
        # subparser không khai báo argument: phần còn lại của argv được trả về
        # nguyên vẹn (parse_known_args) để cmd_* tự parse theo contract node
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
    # stderr tiếng Việt — ép utf-8 để không vỡ trên console/pipe cp1252 (windows)
    for stream in (sys.stdout, sys.stderr):
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
        parser.parse_args(argv)  # in help rồi exit 0
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
