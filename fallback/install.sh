#!/usr/bin/env bash
# ai-guard fallback installer (no npm required). Requires python3.
# Chạy từ thư mục dự án: bash /path/to/ai-guard/fallback/install.sh
set -euo pipefail

ROOT="$(pwd)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ai-guard: python3 required but not found. Install Python 3 and re-run. (On Windows use install.ps1)" >&2
  exit 1
fi

# 1) engine + rules artifact
mkdir -p "$ROOT/.ai-guard/logs" "$ROOT/.ai-guard/.bypass" "$ROOT/.ai-guard/bin"
cp "$SRC/engine.py" "$ROOT/.ai-guard/bin/engine.py"
if [ -f "$SRC/rules.json" ]; then
  cp "$SRC/rules.json" "$ROOT/.ai-guard/bin/rules.json"
else
  echo "ai-guard: WARNING — missing $SRC/rules.json (build artifact). Engine will run in warn-only heuristic mode (NO blocking) until dist/rules.json is copied to fallback/rules.json and re-run." >&2
fi

# 2) gitignore idempotent
GI="$ROOT/.gitignore"
add_line() { grep -qxF "$1" "$GI" 2>/dev/null || echo "$1" >> "$GI"; }
add_line "# ai-guard"; add_line ".ai-guard/logs/"; add_line ".ai-guard/.bypass/"

# quote path trong command string — hook chạy qua shell nên quotes resolve đúng (path có space vẫn chạy)
ENG="python3 \"$ROOT/.ai-guard/bin/engine.py\""

# 3) register hooks — claude-code (.claude/settings.json) + codex (.codex/hooks.json) qua python heredoc
#    (merge an toàn: backup .aiguard.bak 1 lần, MARKER check không nhân đôi — mirror logic adapter TS)
REGISTERED=0
if [ -d "$ROOT/.claude" ]; then
  F="$ROOT/.claude/settings.json"
  [ -f "$F" ] || echo '{}' > "$F"
  [ -f "$F.aiguard.bak" ] || cp "$F" "$F.aiguard.bak"
  python3 - "$F" "$ENG" <<'PYEOF'
import json, sys
path, eng = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8-sig"))
except Exception:
    data = {}
hooks = data.setdefault("hooks", {})
def has(entries, part):
    return any("ai-guard" in h.get("command", "") and part in h.get("command", "") for e in entries for h in (e.get("hooks") or []))
ups = hooks.setdefault("UserPromptSubmit", [])
if not has(ups, "check-prompt"):
    ups.append({"hooks": [{"type": "command", "command": eng + " check-prompt --tool claude-code"}]})
ptu = hooks.setdefault("PreToolUse", [])
if not has(ptu, "check-file"):
    ptu.append({"matcher": "Read|Glob|Grep", "hooks": [{"type": "command", "command": eng + " check-file --tool claude-code"}]})
tmp = path + ".aiguard.tmp"
open(tmp, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
import os; os.replace(tmp, path)
PYEOF
  echo "✓ claude-code hooks registered"
  REGISTERED=1
fi

if [ -d "$ROOT/.codex" ]; then
  F="$ROOT/.codex/hooks.json"
  [ -f "$F" ] || echo '{"hooks":{}}' > "$F"
  [ -f "$F.aiguard.bak" ] || cp "$F" "$F.aiguard.bak"
  python3 - "$F" "$ENG" <<'PYEOF'
# giống claude-code nhưng hooks.json nested {"hooks":{...}};
# matcher codex: apply_patch + mcp__* (không có tool read|grep|glob lowercase)
import json, sys
path, eng = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8-sig"))
except Exception:
    data = {}
hooks = data.setdefault("hooks", {})
def has(entries, part):
    return any("ai-guard" in h.get("command", "") and part in h.get("command", "") for e in entries for h in (e.get("hooks") or []))
ups = hooks.setdefault("UserPromptSubmit", [])
if not has(ups, "check-prompt"):
    ups.append({"hooks": [{"type": "command", "command": eng + " check-prompt --tool codex"}]})
ptu = hooks.setdefault("PreToolUse", [])
if not has(ptu, "check-file"):
    ptu.append({"matcher": "Edit|Write|apply_patch|mcp__.*", "hooks": [{"type": "command", "command": eng + " check-file --tool codex"}]})
tmp = path + ".aiguard.tmp"
open(tmp, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
import os; os.replace(tmp, path)
PYEOF
  echo "✓ codex hooks registered"
  REGISTERED=1
fi

# 4) guard: chưa thấy tool nào -> warn nhưng vẫn exit 0 (engine đã copy sẵn)
if [ "$REGISTERED" -eq 0 ]; then
  echo "ai-guard: WARNING — no .claude/.codex found — make sure you are running from the project root? (engine copied to .ai-guard/bin but no hooks registered)" >&2
fi

echo ""
echo "ai-guard fallback installed at $ROOT/.ai-guard/bin"
echo "Fallback mode: claude-code + codex only; for all 7 tools use npm (npx ai-guard init)."
echo "Verify: echo 'clean test' | $ENG check-prompt --root \"$ROOT\""
