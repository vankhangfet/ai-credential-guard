#!/usr/bin/env bash
# ai-guard fallback installer (no npm required). Requires python3.
# Chạy từ thư mục dự án: bash /path/to/ai-guard/fallback/install.sh
set -euo pipefail

ROOT="$(pwd)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ai-guard: cần python3 (không tìm thấy). Cài Python 3 rồi chạy lại." >&2
  exit 1
fi

# 1) engine + rules artifact
mkdir -p "$ROOT/.ai-guard/logs" "$ROOT/.ai-guard/.bypass" "$ROOT/.ai-guard/bin"
cp "$SRC/engine.py" "$ROOT/.ai-guard/bin/engine.py"
if [ -f "$SRC/rules.json" ]; then
  cp "$SRC/rules.json" "$ROOT/.ai-guard/bin/rules.json"
else
  echo "ai-guard: CẢNH BÁO — thiếu $SRC/rules.json (build artifact). Engine sẽ dùng built-in tối thiểu." >&2
fi

# 2) gitignore idempotent
GI="$ROOT/.gitignore"
add_line() { grep -qxF "$1" "$GI" 2>/dev/null || echo "$1" >> "$GI"; }
add_line "# ai-guard"; add_line ".ai-guard/logs/"; add_line ".ai-guard/.bypass/"

ENG="python3 $ROOT/.ai-guard/bin/engine.py"

# 3) register hooks — claude-code (.claude/settings.json) + codex (.codex/hooks.json) qua python heredoc
#    (merge an toàn: backup .aiguard.bak 1 lần, MARKER check không nhân đôi — mirror logic adapter TS)
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
fi

echo ""
echo "ai-guard fallback installed tại $ROOT/.ai-guard/bin"
echo "Chế độ fallback: claude-code + codex; đầy đủ 7 tool: dùng npm (npx ai-guard init)."
echo "Kiểm tra: echo 'test sạch' | $ENG check-prompt --root \"$ROOT\""
