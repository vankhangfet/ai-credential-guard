# ai-guard fallback installer for Windows (no npm required). Requires python/py.
# Chạy từ thư mục dự án: powershell -ExecutionPolicy Bypass -File \path\to\ai-guard\fallback\install.ps1
$ErrorActionPreference = "Stop"

# output UTF-8 để tiếng Việt không vỡ khi capture (PS 5.1 mặc định OEM codepage)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = (Get-Location).Path
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path

# 0) python detection: python -> py launcher
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Error "ai-guard: cần python (python/py) — không tìm thấy. Cài Python 3 rồi chạy lại."
  exit 1
}
$PyCmd = $py.Source

# 1) engine + rules artifact
New-Item -ItemType Directory -Force -Path "$Root\.ai-guard\logs", "$Root\.ai-guard\.bypass", "$Root\.ai-guard\bin" | Out-Null
Copy-Item -Path "$Src\engine.py" -Destination "$Root\.ai-guard\bin\engine.py" -Force
if (Test-Path "$Src\rules.json") {
  Copy-Item -Path "$Src\rules.json" -Destination "$Root\.ai-guard\bin\rules.json" -Force
} else {
  Write-Warning "ai-guard: CẢNH BÁO — thiếu $Src\rules.json (build artifact). Engine sẽ dùng built-in tối thiểu."
}

# 2) gitignore idempotent
$gi = "$Root\.gitignore"
foreach ($line in @("# ai-guard", ".ai-guard/logs/", ".ai-guard/.bypass/")) {
  $found = $false
  if (Test-Path $gi) {
    $found = [bool](Select-String -Path $gi -Pattern ('^' + [regex]::Escape($line) + '$') -Quiet)
  }
  if (-not $found) { Add-Content -Path $gi -Value $line -Encoding Ascii }
}

# 3) register hooks — claude-code (.claude\settings.json) + codex (.codex\hooks.json) qua python -c
#    (merge an toàn: backup .aiguard.bak 1 lần, MARKER check không nhân đôi — mirror install.sh + adapter TS)
#    Lưu ý: code python chỉ dùng nháy đơn + chr(34) — tránh double-quote trong argument native command.
$regCode = @'
import json, os, sys
path, py, script, tool, matcher = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
q = chr(34)  # quote nhúng path (có thể chứa khoảng trắng) vào command string
eng = py + ' ' + q + script + q
try:
    data = json.load(open(path, encoding='utf-8-sig'))
except Exception:
    data = {}
hooks = data.setdefault('hooks', {})
def has(entries, part):
    return any('ai-guard' in h.get('command', '') and part in h.get('command', '') for e in entries for h in (e.get('hooks') or []))
ups = hooks.setdefault('UserPromptSubmit', [])
if not has(ups, 'check-prompt'):
    ups.append({'hooks': [{'type': 'command', 'command': eng + ' check-prompt --tool ' + tool}]})
ptu = hooks.setdefault('PreToolUse', [])
if not has(ptu, 'check-file'):
    ptu.append({'matcher': matcher, 'hooks': [{'type': 'command', 'command': eng + ' check-file --tool ' + tool}]})
tmp = path + '.aiguard.tmp'
open(tmp, 'w', encoding='utf-8').write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
os.replace(tmp, path)
'@

function Register-AiGuardHooks([string]$File, [string]$DefaultContent, [string]$Tool, [string]$Matcher) {
  if (-not (Test-Path $File)) { Set-Content -Path $File -Value $DefaultContent -Encoding Ascii }
  if (-not (Test-Path "$($File).aiguard.bak")) { Copy-Item -Path $File -Destination "$($File).aiguard.bak" }
  & $PyCmd -c $regCode $File $PyCmd "$Root\.ai-guard\bin\engine.py" $Tool $Matcher
  if ($LASTEXITCODE -ne 0) { throw "ai-guard: đăng ký hook thất bại cho $File" }
}

if (Test-Path "$Root\.claude") {
  Register-AiGuardHooks "$Root\.claude\settings.json" "{}" "claude-code" "Read|Glob|Grep"
  Write-Host "✓ claude-code hooks registered"
}

if (Test-Path "$Root\.codex") {
  Register-AiGuardHooks "$Root\.codex\hooks.json" '{"hooks":{}}' "codex" "Edit|Write|apply_patch|mcp__.*"
  Write-Host "✓ codex hooks registered"
}

Write-Host ""
Write-Host "ai-guard fallback installed tại $Root\.ai-guard\bin"
Write-Host "Chế độ fallback: claude-code + codex; đầy đủ 7 tool: dùng npm (npx ai-guard init)."
Write-Host "Kiểm tra: echo 'test sạch' | $PyCmd `"$Root\.ai-guard\bin\engine.py`" check-prompt --root `"$Root`""
