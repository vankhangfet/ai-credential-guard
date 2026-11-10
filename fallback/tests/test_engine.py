"""Contract-level tests for fallback/engine.py — python mirror of the node CLI.

The CLI part runs via subprocess (exit codes, stderr, audit JSONL, bypass store);
the unit part (is_placeholder/mask) imports the module directly from its file path.
Builtin rules are NOT taken from dist (build artifact) — the test builds a small artifact
and points env AI_GUARD_BUILTIN_RULES at it (installer Task 25 will copy dist/rules.json).
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ENGINE_PATH = Path(__file__).resolve().parents[1] / "engine.py"

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
JWT_TOKEN = (
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
)
CLEAN_PROMPT = "viết cho tôi hàm quicksort bằng typescript"

# self-built test artifact — patterns copied verbatim from dist/rules.json; enough rules
# for the 9 self-test fixtures + 2 builtin detectors (empty pattern)
RULES_ARTIFACT = [
    {"id": "aws-access-key", "severity": "block",
     "pattern": r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", "description": "AWS Access Key ID"},
    {"id": "openai-api-key", "severity": "block",
     "pattern": r"\bsk-(?!ant-|admin|or-v1-)(?![a-f0-9]{32}\b)[A-Za-z0-9_-]{20,}\b",
     "description": "OpenAI API key"},
    {"id": "github-pat", "severity": "block",
     "pattern": r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{22,}\b",
     "description": "GitHub personal access token"},
    {"id": "db-url", "severity": "block",
     # non-raw string: a raw string r"...\"..." would keep the backslash in the class, drifting from
     # src verbatim — username class [^\s:@/"'], password class [^\s@/"']
     "pattern": "\\b(?:mysql|postgres|postgresql|mongodb(?:\\+srv)?|redis|rediss|mssql|amqps?|ibmdb)://[^\\s:@/\"']+:[^\\s@/\"']+@",
     "description": "DB connection string with password"},
    {"id": "slack-token", "severity": "block",
     "pattern": r"\bxox[bapr]-[A-Za-z0-9-]{10,}\b",
     "description": "Slack token"},
    {"id": "private-key", "severity": "block",
     "pattern": r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----",
     "description": "Private key PEM block"},
    {"id": "jwt", "severity": "warn",
     "pattern": r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b",
     "description": "JWT token"},
    {"id": "generic-secret", "severity": "warn", "pattern": "",
     "description": "Secret value assigned to password/secret/api_key", "builtin": "generic-secret"},
    {"id": "high-entropy", "severity": "warn", "pattern": "",
     "description": "High-entropy token likely a secret", "builtin": "high-entropy"},
    # triple-quoted raw: the pattern contains both ' and " — kept verbatim like dist/rules.json
    {"id": "login-credential-pair", "severity": "block",
     "pattern": r'''(?<![a-z0-9])(?:[Uu]ser(?:[ _-]?[Nn]ame)?|[Ll]ogin)\s*[:=@]\s*[^\s,;'"&]{1,64}[^.]{0,120}?(?<![a-z0-9])(?:[Pp]asswo?rd|[Pp]asswd)\s*[:=@]\s*[^\s,;'"&]{1,64}|(?<![a-z0-9])(?:[Pp]asswo?rd|[Pp]asswd)\s*[:=@]\s*[^\s,;'"&]{1,64}[^.]{0,120}?(?<![a-z0-9])(?:[Uu]ser(?:[ _-]?[Nn]ame)?|[Ll]ogin)\s*[:=@]\s*[^\s,;'"&]{1,64}''',
     "description": "Username + password credential pair (login context)"},
]

PATCH_STDIN = json.dumps({
    "tool_input": {
        "input": (
            "*** Begin Patch\n"
            "*** Update File: src/app.ts\n"
            "+console.log('hi')\n"
            "*** Add File: .env\n"
            "+DB_PASSWORD=real-secret-value-123\n"
            "*** End Patch"
        )
    }
})


def load_engine_module():
    spec = importlib.util.spec_from_file_location("ai_guard_fallback_engine", ENGINE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EngineCliTests(unittest.TestCase):
    """Contract-level via subprocess — exit codes, English stderr, audit, bypass."""

    @classmethod
    def setUpClass(cls):
        cls.base = Path(tempfile.mkdtemp(prefix="ai-guard-engine-tests-"))
        cls.builtin_artifact = cls.base / "builtin-rules.json"
        cls.builtin_artifact.write_text(json.dumps(RULES_ARTIFACT, indent=2), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.proj = Path(tempfile.mkdtemp(prefix="ai-guard-proj-", dir=self.base))
        (self.proj / ".ai-guard").mkdir()
        self.addCleanup(shutil.rmtree, self.proj, ignore_errors=True)
        self.env = dict(
            os.environ,
            AI_GUARD_BUILTIN_RULES=str(self.builtin_artifact),
            PYTHONIOENCODING="utf-8",
            PYTHONUTF8="1",
        )

    # -- helpers ---------------------------------------------------------

    def run_engine(self, args, stdin_text=""):
        return subprocess.run(
            [sys.executable, str(ENGINE_PATH)] + list(args),
            input=stdin_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=self.env,
            cwd=str(self.proj),
        )

    def check_prompt(self, stdin_text):
        return self.run_engine(["check-prompt", "--root", str(self.proj)], stdin_text)

    def audit_events(self):
        logs_dir = self.proj / ".ai-guard" / "logs"
        events = []
        if logs_dir.is_dir():
            for f in sorted(logs_dir.glob("*.jsonl")):
                for line in f.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line:
                        events.append(json.loads(line))
        return events

    def audit_raw_text(self):
        logs_dir = self.proj / ".ai-guard" / "logs"
        chunks = []
        if logs_dir.is_dir():
            for f in sorted(logs_dir.glob("*.jsonl")):
                chunks.append(f.read_text(encoding="utf-8"))
        return "\n".join(chunks)

    # -- 1. clean prompt --------------------------------------------------

    def test_clean_prompt_exits_0(self):
        r = self.check_prompt(CLEAN_PROMPT)
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertEqual([e for e in self.audit_events() if e.get("event") == "prompt"], [])

    # -- 2. AWS key blocked ------------------------------------------------

    def test_aws_key_prompt_blocks(self):
        r = self.check_prompt(f"dùng key này giúp tôi: {AWS_KEY}")
        self.assertEqual(r.returncode, 2, msg=r.stdout + r.stderr)
        self.assertIn("ai-guard", r.stderr)
        blocked = [e for e in self.audit_events()
                   if e.get("event") == "prompt" and e.get("action") == "blocked"]
        self.assertTrue(blocked, msg="missing audit blocked")
        self.assertEqual(blocked[0].get("rule"), "aws-access-key")
        self.assertNotEqual(blocked[0].get("preview"), AWS_KEY)
        self.assertNotIn(AWS_KEY, self.audit_raw_text())

    # -- 2b. kiro UserPromptSubmit payload: prompt lives under key "userPrompt" --

    def test_userprompt_alias_key_blocks(self):
        # Kiro UserPromptSubmit (user-verified): the stdin payload has the prompt text under
        # key "userPrompt" — extract_prompt must pick the right field and then block (rc 2).
        r = self.check_prompt(json.dumps({"userPrompt": AWS_KEY}))
        self.assertEqual(r.returncode, 2, msg=r.stdout + r.stderr)
        self.assertIn("BLOCKED", r.stderr)
        blocked = [e for e in self.audit_events()
                   if e.get("event") == "prompt" and e.get("action") == "blocked"]
        self.assertEqual(blocked[0].get("rule"), "aws-access-key")

    # -- 3. jwt-only warns, exit 0 -----------------------------------------

    def test_jwt_only_prompt_warns_but_exits_0(self):
        r = self.check_prompt(f"token hiện tại: {JWT_TOKEN}")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        warned = [e for e in self.audit_events()
                  if e.get("event") == "prompt" and e.get("action") == "warned"]
        self.assertTrue(warned, msg="missing audit warned")
        self.assertEqual(warned[0].get("rule"), "jwt")

    # -- 4. allow prompt bypass ---------------------------------------------

    def test_allow_prompt_bypass(self):
        r = self.run_engine(["allow", "prompt", "--5m", "--root", str(self.proj)])
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("5 minutes", r.stdout)

        r2 = self.check_prompt(f"key: {AWS_KEY}")
        self.assertEqual(r2.returncode, 0, msg=r2.stderr)
        allowed = [e for e in self.audit_events()
                   if e.get("event") == "prompt" and e.get("action") == "allowed_after_confirm"]
        self.assertTrue(allowed, msg="missing audit allowed_after_confirm")

    # -- 5. invalid duration -------------------------------------------------

    def test_allow_prompt_zero_minutes_rejected(self):
        r = self.run_engine(["allow", "prompt", "--0m", "--root", str(self.proj)])
        self.assertEqual(r.returncode, 1, msg=r.stdout)
        self.assertIn("ai-guard", r.stderr)

    # -- 6. check-file argv + file-scoped bypass ------------------------------

    def test_check_file_argv_path_and_bypass(self):
        r = self.run_engine(["check-file", ".env", "--root", str(self.proj)])
        self.assertEqual(r.returncode, 2, msg=r.stdout)
        self.assertIn("ai-guard", r.stderr)
        blocked = [e for e in self.audit_events()
                   if e.get("event") == "file" and e.get("action") == "blocked"]
        self.assertEqual(blocked[0].get("path"), ".env")

        # a bypass for a DIFFERENT file does not unlock .env
        r_other = self.run_engine(["allow", "file", "secrets/prod.key", "--10m", "--root", str(self.proj)])
        self.assertEqual(r_other.returncode, 0, msg=r_other.stderr)
        r_still = self.run_engine(["check-file", ".env", "--root", str(self.proj)])
        self.assertEqual(r_still.returncode, 2, msg=r_still.stdout + r_still.stderr)

        # bypass for the right file -> unlocks
        r_grant = self.run_engine(["allow", "file", ".env", "--10m", "--root", str(self.proj)])
        self.assertEqual(r_grant.returncode, 0, msg=r_grant.stderr)
        r_ok = self.run_engine(["check-file", ".env", "--root", str(self.proj)])
        self.assertEqual(r_ok.returncode, 0, msg=r_ok.stderr)
        allowed = [e for e in self.audit_events()
                   if e.get("event") == "file" and e.get("action") == "allowed_after_confirm"]
        self.assertTrue(allowed, msg="missing audit allowed_after_confirm for file")

    # -- 7. check-file stdin: explicit field + patch headers -------------------

    def test_check_file_stdin_tool_input_file_path(self):
        stdin_text = json.dumps({"tool_input": {"file_path": ".env", "content": "x"}})
        r = self.run_engine(["check-file", "--root", str(self.proj)], stdin_text)
        self.assertEqual(r.returncode, 2, msg=r.stdout)
        blocked = [e for e in self.audit_events()
                   if e.get("event") == "file" and e.get("action") == "blocked"]
        self.assertEqual(blocked[0].get("path"), ".env")

    def test_check_file_stdin_patch_headers_collect_all(self):
        r = self.run_engine(["check-file", "--root", str(self.proj)], PATCH_STDIN)
        self.assertEqual(r.returncode, 2, msg=r.stdout)
        blocked = [e for e in self.audit_events()
                   if e.get("event") == "file" and e.get("action") == "blocked"]
        # .env is NOT the last file in the patch — it must still be caught (collect ALL headers)
        self.assertEqual(blocked[0].get("path"), ".env")

    # -- 8. self-test (all 9 fixtures like src/selftest-fixtures.ts) -------------

    def test_self_test_exits_0(self):
        r = self.run_engine(["self-test"])
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("self-test:", r.stdout)
        self.assertIn("9/9 pass", r.stdout)

    # -- 9. regression: cp1252 stdin must not be silently skipped ---------------------

    def test_cp1252_stdin_prompt_still_blocks(self):
        # PYTHONIOENCODING=cp1252, NO PYTHONUTF8: the engine must reconfigure stdin
        # to utf-8 — before the fix, reading a utf-8 prompt raised UnicodeDecodeError (subclass of
        # ValueError), swallowed by fail-open -> exit 0 without scanning (silent-skip).
        env = dict(os.environ,
                   AI_GUARD_BUILTIN_RULES=str(self.builtin_artifact),
                   PYTHONIOENCODING="cp1252")
        env.pop("PYTHONUTF8", None)
        r = subprocess.run(
            [sys.executable, str(ENGINE_PATH), "check-prompt", "--root", str(self.proj)],
            input="Đây là key AKIAIOSFODNN7EXAMPLE giữ giùm tôi",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=str(self.proj),
        )
        self.assertEqual(r.returncode, 2, msg=r.stdout + r.stderr)
        self.assertIn("BLOCKED", r.stderr)


class EngineUnitTests(unittest.TestCase):
    """Quick unit asserts for mask/placeholder (module imported directly)."""

    @classmethod
    def setUpClass(cls):
        cls.engine = load_engine_module()

    def test_is_placeholder_forms(self):
        ip = self.engine.is_placeholder
        for v in ("test", "changeme", "change_me", "your_api_key", "your-token",
                  "my_password", "YOUR_API_KEY", "<your-token>", "xxx"):
            self.assertTrue(ip(v), msg=v)
        for v in ("realpassword123", "AKIAIOSFODNN7EXAMPLE", "hunter2secure"):
            self.assertFalse(ip(v), msg=v)

    def test_is_placeholder_length_guard(self):
        # a >200-char string counts as a real value even if it looks like a placeholder
        self.assertFalse(self.engine.is_placeholder("your_api_key" + "x" * 200))
        self.assertTrue(self.engine.is_placeholder("your_api_key" + "x" * 100))

    def test_mask_secret_thresholds(self):
        m = self.engine.mask_secret
        self.assertEqual(m("ab"), "***")
        self.assertEqual(m("abcd"), "***")
        self.assertEqual(m("abcde"), "ab***")
        self.assertEqual(m("abcdefghijklmno"), "abcdef***lmno")  # 15 chars
        self.assertEqual(m("  abcdefghijklmno  "), "abcdef***lmno")  # trim before masking

    def test_shannon_entropy_basics(self):
        self.assertEqual(self.engine.shannon_entropy(""), 0.0)
        self.assertAlmostEqual(self.engine.shannon_entropy("aaaa"), 0.0)
        self.assertGreater(self.engine.shannon_entropy("ab"), 0.9)

    def test_regex_ascii_parity_with_js(self):
        # JS \b is ASCII-based: "đAKIA..." must match like JS;
        # python unicode-mode \b would treat "đA" as word-word -> no boundary.
        rules = self.engine.compile_rules([
            {"id": "aws-access-key", "severity": "block",
             "pattern": r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
             "description": "AWS Access Key ID"},
        ])
        self.assertIsNotNone(rules[0]["re"].search("đAKIAIOSFODNN7EXAMPLE"))

    def test_db_url_pattern_verbatim_from_dist(self):
        # lock verbatim-ness: the pattern in the test artifact must be IDENTICAL to the string
        # (not merely regex-equivalent) read from dist/rules.json
        dist_rules = Path(__file__).resolve().parents[2] / "dist" / "rules.json"
        if not dist_rules.exists():
            self.skipTest("dist/rules.json not built yet")
        dist_pattern = [r["pattern"] for r in json.loads(dist_rules.read_text(encoding="utf-8"))
                        if r["id"] == "db-url"][0]
        artifact_pattern = [r["pattern"] for r in RULES_ARTIFACT if r["id"] == "db-url"][0]
        self.assertEqual(artifact_pattern, dist_pattern)


class LoadRulesUnitTests(unittest.TestCase):
    """Mirror the semantics of tests/loader.test.ts: remove -> add (replace) -> override."""

    @classmethod
    def setUpClass(cls):
        cls.engine = load_engine_module()
        cls.base = Path(tempfile.mkdtemp(prefix="ai-guard-loader-"))
        cls.artifact = cls.base / "builtin-rules.json"
        cls.artifact.write_text(json.dumps(RULES_ARTIFACT), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.proj = Path(tempfile.mkdtemp(prefix="ai-guard-proj-", dir=self.base))
        (self.proj / ".ai-guard").mkdir()
        self.addCleanup(shutil.rmtree, self.proj, ignore_errors=True)
        patcher = mock.patch.dict(os.environ,
                                  {"AI_GUARD_BUILTIN_RULES": str(self.artifact)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_rules(self, content):
        p = self.proj / ".ai-guard" / "rules.json"
        if isinstance(content, str):
            p.write_text(content, encoding="utf-8")
        else:
            p.write_text(json.dumps(content), encoding="utf-8")

    def rule_ids(self, rules):
        return [r["id"] for r in rules]

    def test_add_same_id_replaces_builtin(self):
        self.write_rules({"add": [
            {"id": "jwt", "severity": "block", "pattern": "REPLACED-[A-Z]+",
             "description": "replaced"},
        ]})
        rules = self.engine.load_rules(str(self.proj))
        jwt = [r for r in rules if r["id"] == "jwt"]
        self.assertEqual(len(jwt), 1)  # REPLACED, not duplicated
        self.assertEqual(jwt[0]["severity"], "block")  # block instead of warn
        self.assertIsNotNone(jwt[0]["re"].search("REPLACED-ABC"))

    def test_remove_rule(self):
        self.write_rules({"remove": ["jwt"]})
        self.assertNotIn("jwt", self.rule_ids(self.engine.load_rules(str(self.proj))))

    def test_override_severity(self):
        self.write_rules({"override": {"aws-access-key": {"severity": "warn"}}})
        rules = self.engine.load_rules(str(self.proj))
        aws = [r for r in rules if r["id"] == "aws-access-key"][0]
        self.assertEqual(aws["severity"], "warn")

    def test_invalid_add_dropped_builtin_intact(self):
        self.write_rules({"add": [
            {"id": "bad", "severity": "blok", "pattern": "X", "description": "x"},
        ]})
        rules = self.engine.load_rules(str(self.proj))
        self.assertNotIn("bad", self.rule_ids(rules))
        self.assertIn("aws-access-key", self.rule_ids(rules))

    def test_invalid_override_ignored(self):
        self.write_rules({"override": {"jwt": {"severity": "blok"}}})
        rules = self.engine.load_rules(str(self.proj))
        jwt = [r for r in rules if r["id"] == "jwt"][0]
        self.assertEqual(jwt["severity"], "warn")  # keeps the original severity

    def test_corrupt_rules_json_fail_open(self):
        self.write_rules("{invalid json")
        rules = self.engine.load_rules(str(self.proj))  # does not throw
        self.assertIn("aws-access-key", self.rule_ids(rules))

    def test_bom_rules_json_still_parsed(self):
        self.write_rules("﻿" + json.dumps({"remove": ["jwt"]}))
        self.assertNotIn("jwt", self.rule_ids(self.engine.load_rules(str(self.proj))))


class JevFallbackTests(unittest.TestCase):
    """JEV/OpenJEV support in the fallback, against a local mock decision server."""

    @classmethod
    def setUpClass(cls):
        import http.server
        import threading

        cls.engine = load_engine_module()
        cls.base = Path(tempfile.mkdtemp(prefix="ai-guard-jev-"))
        cls.artifact = cls.base / "builtin-rules.json"
        cls.artifact.write_text(json.dumps(RULES_ARTIFACT), encoding="utf-8")
        cls.responses = {"payload": {}, "status": 200}
        cls.requests = []
        outer = cls

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", 0))
                outer.requests.append({
                    "auth": self.headers.get("authorization"),
                    "body": json.loads(self.rfile.read(length).decode("utf-8")),
                })
                data = json.dumps(outer.responses["payload"]).encode("utf-8")
                self.send_response(outer.responses["status"])
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        cls.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        cls.endpoint = "http://127.0.0.1:{}/v1/systemone".format(cls.server.server_address[1])
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.proj = Path(tempfile.mkdtemp(prefix="ai-guard-proj-", dir=self.base))
        (self.proj / ".ai-guard").mkdir()
        self.addCleanup(shutil.rmtree, self.proj, ignore_errors=True)
        type(self).requests.clear()
        type(self).responses.update(status=200, payload=self.answers(0.0, 0.0))
        self.env = dict(os.environ, AI_GUARD_BUILTIN_RULES=str(self.artifact),
                        PYTHONIOENCODING="utf-8", PYTHONUTF8="1", JEV_API_KEY="test-key")

    @staticmethod
    def answers(cred, exfil):
        return {"answers": {
            "jev-credential": {"type": "noul", "noul": cred},
            "jev-unauthorized-access": {"type": "noul", "noul": exfil},
        }}

    def write_config(self, **jev):
        cfg = {"jev": {"enabled": True, "endpoint": self.endpoint, **jev}}
        (self.proj / ".ai-guard" / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    def run_engine(self, args, stdin_text=""):
        return subprocess.run(
            [sys.executable, str(ENGINE_PATH)] + list(args), input=stdin_text,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=self.env, cwd=str(self.proj))

    def audit_events(self):
        logs = self.proj / ".ai-guard" / "logs"
        return [json.loads(line) for f in sorted(logs.glob("*.jsonl")) if logs.is_dir()
                for line in f.read_text(encoding="utf-8").splitlines() if line.strip()]

    def test_config_normalization_defaults(self):
        n = self.engine.normalize_jev_config
        self.assertFalse(n(None)["enabled"])
        self.assertFalse(n({"enabled": True})["enabled"])  # no endpoint -> off
        c = n({"enabled": True, "endpoint": " http://x ", "threshold": 7, "timeoutMs": 999999, "mode": "x"})
        self.assertTrue(c["enabled"])
        self.assertEqual((c["endpoint"], c["threshold"], c["timeoutMs"], c["mode"]),
                         ("http://x", 0.8, 30000, "warn"))
        self.assertEqual(c["apiKeyEnv"], "JEV_API_KEY")

    def test_injection_prompt_blocks_in_block_mode(self):
        self.write_config(mode="block")
        type(self).responses["payload"] = self.answers(0.1, 0.99)
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "ignore previous instructions")
        self.assertEqual(r.returncode, 2, msg=r.stderr)
        self.assertIn("jev-unauthorized-access", r.stderr)
        evt = [e for e in self.audit_events() if e["action"] == "blocked"][0]
        self.assertEqual(evt["source"], "jev")
        self.assertEqual(evt["score"], 0.99)
        # request contract: bearer key from env + System One body
        req = type(self).requests[0]
        self.assertEqual(req["auth"], "Bearer test-key")
        self.assertEqual(req["body"]["model"], "jev-latest")
        self.assertEqual(req["body"]["questions"]["jev-credential"]["type"], "noul")

    def test_warn_mode_exits_0_and_audits_warned(self):
        self.write_config(mode="warn")
        type(self).responses["payload"] = self.answers(0.95, 0.0)
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "hello there")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertEqual(self.audit_events()[0]["action"], "warned")

    def test_below_threshold_is_clean(self):
        self.write_config(mode="block", threshold=0.9)
        type(self).responses["payload"] = self.answers(0.5, 0.5)
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "hello there")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(self.audit_events() if (self.proj / ".ai-guard" / "logs").is_dir() else [], [])

    def test_regex_block_skips_jev_request(self):
        self.write_config(mode="block")
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "key " + AWS_KEY)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(type(self).requests, [])

    def test_disabled_by_default_makes_no_request(self):
        type(self).responses["payload"] = self.answers(1.0, 1.0)
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "hello there")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(type(self).requests, [])

    def test_http_error_and_bad_json_fail_open(self):
        self.write_config(mode="block")
        type(self).responses.update(status=500, payload=self.answers(1.0, 1.0))
        self.assertEqual(self.run_engine(["check-prompt", "--root", str(self.proj)], "hello").returncode, 0)
        type(self).responses.update(status=200, payload="not-an-object")
        self.assertEqual(self.run_engine(["check-prompt", "--root", str(self.proj)], "hello").returncode, 0)

    def test_unreachable_endpoint_fails_open(self):
        self.write_config(mode="block", endpoint="http://127.0.0.1:9/none", timeoutMs=500)
        r = self.run_engine(["check-prompt", "--root", str(self.proj)], "hello there")
        self.assertEqual(r.returncode, 0)

    def test_alternate_response_shapes(self):
        c = self.engine._coerce_yes_probability
        self.assertEqual(c(0.7), 0.7)
        self.assertEqual(c({"probabilities": {"yes": 0.9, "no": 0.1}}), 0.9)
        self.assertAlmostEqual(c({"probabilities": {"no": 0.25}}), 0.75)
        self.assertAlmostEqual(c({"choice": "no", "probability": 0.9}), 0.1)
        self.assertEqual(c({"answer": True}), 1.0)
        self.assertIsNone(c({"foo": 1}))

    def test_file_content_blocks_in_block_mode(self):
        self.write_config(mode="block")
        (self.proj / "config.ts").write_text("export const k = 'abc';", encoding="utf-8")
        type(self).responses["payload"] = self.answers(0.97, 0.0)
        r = self.run_engine(["check-file", "--root", str(self.proj), "config.ts"])
        self.assertEqual(r.returncode, 2, msg=r.stderr)
        self.assertIn("JEV flagged", r.stderr)
        self.assertEqual(self.audit_events()[0]["source"], "jev")

    def test_file_content_bypass_and_warn(self):
        (self.proj / "config.ts").write_text("export const k = 'abc';", encoding="utf-8")
        type(self).responses["payload"] = self.answers(0.97, 0.0)
        self.write_config(mode="warn")
        self.assertEqual(self.run_engine(["check-file", "--root", str(self.proj), "config.ts"]).returncode, 0)
        self.assertEqual(self.audit_events()[-1]["action"], "warned")
        self.write_config(mode="block")
        self.run_engine(["allow", "file", "config.ts", "--5m", "--root", str(self.proj)])
        self.assertEqual(self.run_engine(["check-file", "--root", str(self.proj), "config.ts"]).returncode, 0)
        self.assertEqual(self.audit_events()[-1]["action"], "allowed_after_confirm")

    def test_missing_or_empty_file_skipped(self):
        self.write_config(mode="block")
        type(self).responses["payload"] = self.answers(1.0, 1.0)
        (self.proj / "empty.ts").write_text("", encoding="utf-8")
        for name in ("nope.ts", "empty.ts"):
            self.assertEqual(self.run_engine(["check-file", "--root", str(self.proj), name]).returncode, 0)
        self.assertEqual(type(self).requests, [])


if __name__ == "__main__":
    unittest.main()
