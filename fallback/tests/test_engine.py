"""Contract-level tests cho fallback/engine.py — python mirror của node CLI.

Phần CLI chạy qua subprocess (exit codes, stderr, audit JSONL, bypass store);
phần unit (is_placeholder/mask) import module trực tiếp từ file path.
Builtin rules KHÔNG lấy từ dist (build artifact) — test tự tạo artifact nhỏ
và trỏ env AI_GUARD_BUILTIN_RULES vào nó (installer Task 25 sẽ copy dist/rules.json).
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

# artifact test tự tạo — patterns copy nguyên vẹn từ dist/rules.json; đủ rule
# cho 8 fixture self-test + 2 builtin detector (pattern rỗng)
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
     "pattern": r"\b(?:mysql|postgres|postgresql|mongodb(?:\+srv)?|redis|rediss|mssql|amqps?|ibmdb)://[^\s:@/\"']+:[^\s:@/\"']+@",
     "description": "DB connection string có password"},
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
     "description": "Gán giá trị cho password/secret/api_key", "builtin": "generic-secret"},
    {"id": "high-entropy", "severity": "warn", "pattern": "",
     "description": "Token entropy cao khả năng là secret", "builtin": "high-entropy"},
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
    """Contract-level qua subprocess — exit codes, stderr tiếng Việt, audit, bypass."""

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
        self.assertTrue(blocked, msg="thiếu audit blocked")
        self.assertEqual(blocked[0].get("rule"), "aws-access-key")
        self.assertNotEqual(blocked[0].get("preview"), AWS_KEY)
        self.assertNotIn(AWS_KEY, self.audit_raw_text())

    # -- 3. jwt-only warns, exit 0 -----------------------------------------

    def test_jwt_only_prompt_warns_but_exits_0(self):
        r = self.check_prompt(f"token hiện tại: {JWT_TOKEN}")
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        warned = [e for e in self.audit_events()
                  if e.get("event") == "prompt" and e.get("action") == "warned"]
        self.assertTrue(warned, msg="thiếu audit warned")
        self.assertEqual(warned[0].get("rule"), "jwt")

    # -- 4. allow prompt bypass ---------------------------------------------

    def test_allow_prompt_bypass(self):
        r = self.run_engine(["allow", "prompt", "--5m", "--root", str(self.proj)])
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("5 phút", r.stdout)

        r2 = self.check_prompt(f"key: {AWS_KEY}")
        self.assertEqual(r2.returncode, 0, msg=r2.stderr)
        allowed = [e for e in self.audit_events()
                   if e.get("event") == "prompt" and e.get("action") == "allowed_after_confirm"]
        self.assertTrue(allowed, msg="thiếu audit allowed_after_confirm")

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

        # bypass cho file KHÁC không mở khóa .env
        r_other = self.run_engine(["allow", "file", "secrets/prod.key", "--10m", "--root", str(self.proj)])
        self.assertEqual(r_other.returncode, 0, msg=r_other.stderr)
        r_still = self.run_engine(["check-file", ".env", "--root", str(self.proj)])
        self.assertEqual(r_still.returncode, 2, msg=r_still.stdout + r_still.stderr)

        # bypass đúng file -> mở khóa
        r_grant = self.run_engine(["allow", "file", ".env", "--10m", "--root", str(self.proj)])
        self.assertEqual(r_grant.returncode, 0, msg=r_grant.stderr)
        r_ok = self.run_engine(["check-file", ".env", "--root", str(self.proj)])
        self.assertEqual(r_ok.returncode, 0, msg=r_ok.stderr)
        allowed = [e for e in self.audit_events()
                   if e.get("event") == "file" and e.get("action") == "allowed_after_confirm"]
        self.assertTrue(allowed, msg="thiếu audit allowed_after_confirm cho file")

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
        # .env KHÔNG phải file cuối trong patch — vẫn phải bị bắt (collect TẤT CẢ headers)
        self.assertEqual(blocked[0].get("path"), ".env")

    # -- 8. self-test (đủ 8 fixtures như src/selftest-fixtures.ts) -------------

    def test_self_test_exits_0(self):
        r = self.run_engine(["self-test"])
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("self-test:", r.stdout)
        self.assertIn("8/8 pass", r.stdout)

    # -- 9. regression: stdin cp1252 không được silent-skip ---------------------

    def test_cp1252_stdin_prompt_still_blocks(self):
        # PYTHONIOENCODING=cp1252, KHÔNG PYTHONUTF8: engine phải reconfigure stdin
        # sang utf-8 — trước fix, đọc prompt utf-8 ném UnicodeDecodeError (subclass
        # ValueError) bị fail-open nuốt -> exit 0 mà không quét (silent-skip).
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
        self.assertIn("ĐÃ CHẶN", r.stderr)


class EngineUnitTests(unittest.TestCase):
    """Unit asserts nhanh cho mask/placeholder (import trực tiếp module)."""

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
        # chuỗi >200 ký tự coi như giá trị thật dù trông như placeholder
        self.assertFalse(self.engine.is_placeholder("your_api_key" + "x" * 200))
        self.assertTrue(self.engine.is_placeholder("your_api_key" + "x" * 100))

    def test_mask_secret_thresholds(self):
        m = self.engine.mask_secret
        self.assertEqual(m("ab"), "***")
        self.assertEqual(m("abcd"), "***")
        self.assertEqual(m("abcde"), "ab***")
        self.assertEqual(m("abcdefghijklmno"), "abcdef***lmno")  # 15 ký tự
        self.assertEqual(m("  abcdefghijklmno  "), "abcdef***lmno")  # trim trước khi mask

    def test_shannon_entropy_basics(self):
        self.assertEqual(self.engine.shannon_entropy(""), 0.0)
        self.assertAlmostEqual(self.engine.shannon_entropy("aaaa"), 0.0)
        self.assertGreater(self.engine.shannon_entropy("ab"), 0.9)

    def test_regex_ascii_parity_with_js(self):
        # JS \b là ASCII-based: "đAKIA..." phải match như JS;
        # python unicode-mode \b sẽ xem "đA" là word-word -> không boundary.
        rules = self.engine.compile_rules([
            {"id": "aws-access-key", "severity": "block",
             "pattern": r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
             "description": "AWS Access Key ID"},
        ])
        self.assertIsNotNone(rules[0]["re"].search("đAKIAIOSFODNN7EXAMPLE"))


class LoadRulesUnitTests(unittest.TestCase):
    """Mirror semantics của tests/loader.test.ts: remove -> add (replace) -> override."""

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
        self.assertEqual(len(jwt), 1)  # THAY THẾ, không nhân đôi
        self.assertEqual(jwt[0]["severity"], "block")  # block thay cho warn
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
        self.assertEqual(jwt["severity"], "warn")  # giữ severity gốc

    def test_corrupt_rules_json_fail_open(self):
        self.write_rules("{invalid json")
        rules = self.engine.load_rules(str(self.proj))  # không throw
        self.assertIn("aws-access-key", self.rule_ids(rules))

    def test_bom_rules_json_still_parsed(self):
        self.write_rules("﻿" + json.dumps({"remove": ["jwt"]}))
        self.assertNotIn("jwt", self.rule_ids(self.engine.load_rules(str(self.proj))))


if __name__ == "__main__":
    unittest.main()
