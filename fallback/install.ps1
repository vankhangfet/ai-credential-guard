# ai-guard fallback installer for Windows (no npm required). Requires python/py.
# Chạy từ thư mục dự án: powershell -ExecutionPolicy Bypass -File \path\to\ai-guard\fallback\install.ps1
$ErrorActionPreference = "Stop"

# output UTF-8 để tiếng Việt không vỡ khi capture (PS 5.1 mặc định OEM codepage)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = (Get-Location).Path
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path

# 0) python detection: py launcher TRƯỚC (python có thể là WindowsApps stub);
#    probe --version exit-code trước khi dùng — stub thoát 9009 và viết ra stderr
function Test-PyExe([string]$Exe) {
  try { & $Exe --version 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) }
  catch { return $false }
}
$Candidates = @()
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) { $Candidates += $pyLauncher.Source }
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) { $Candidates += $pythonCmd.Source }
$PyCmd = $null
foreach ($c in $Candidates) {
  if (Test-PyExe $c) { $PyCmd = $c; break }
}
if (-not $PyCmd) {
  if ($Candidates.Count -gt 0) {
    Write-Error "ai-guard: không tìm thấy Python thật (WindowsApps stub) — cài từ python.org rồi chạy lại."
  } else {
    Write-Error "ai-guard: cần python (py/python) — không tìm thấy. Cài Python 3 rồi chạy lại."
  }
  exit 1
}

# 1) engine + rules artifact
New-Item -ItemType Directory -Force -Path "$Root\.ai-guard\logs", "$Root\.ai-guard\.bypass", "$Root\.ai-guard\bin" | Out-Null
Copy-Item -Path "$Src\engine.py" -Destination "$Root\.ai-guard\bin\engine.py" -Force
if (Test-Path "$Src\rules.json") {
  Copy-Item -Path "$Src\rules.json" -Destination "$Root\.ai-guard\bin\rules.json" -Force
} else {
  Write-Warning "ai-guard: CẢNH BÁO — thiếu $Src\rules.json (build artifact). Engine chỉ còn heuristic warn (KHÔNG chặn) cho tới khi copy dist/rules.json vào fallback/rules.json rồi chạy lại."
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
q = chr(34)  # quote cả interpreter (có thể nằm trong dir có space) lẫn script path
eng = q + py + q + ' ' + q + script + q
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
# fail-fast guard: double-quote trong $regCode sẽ bị PS 5.1 chặt đứt khi qua native arg
# (python -c nhận code truncate -> exit 0 mà không làm gì) — chặn sớm thay vì im lặng.
if ($regCode -match '"') { throw "ai-guard: regCode chứa double-quote — PS 5.1 hỏng native arg passing" }

function Register-AiGuardHooks([string]$File, [string]$DefaultContent, [string]$Tool, [string]$Matcher) {
  if (-not (Test-Path $File)) { Set-Content -Path $File -Value $DefaultContent -Encoding Ascii }
  if (-not (Test-Path "$($File).aiguard.bak")) { Copy-Item -Path $File -Destination "$($File).aiguard.bak" }
  & $PyCmd -c $regCode $File $PyCmd "$Root\.ai-guard\bin\engine.py" $Tool $Matcher
  if ($LASTEXITCODE -ne 0) { throw "ai-guard: đăng ký hook thất bại cho $File" }
}

$Registered = $false
if (Test-Path "$Root\.claude") {
  Register-AiGuardHooks "$Root\.claude\settings.json" "{}" "claude-code" "Read|Glob|Grep"
  Write-Host "✓ claude-code hooks registered"
  $Registered = $true
}

if (Test-Path "$Root\.codex") {
  Register-AiGuardHooks "$Root\.codex\hooks.json" '{"hooks":{}}' "codex" "Edit|Write|apply_patch|mcp__.*"
  Write-Host "✓ codex hooks registered"
  $Registered = $true
}

# 4) guard: chưa thấy tool nào -> warn nhưng vẫn exit 0 (engine đã copy sẵn)
if (-not $Registered) {
  Write-Warning "ai-guard: không tìm thấy .claude/.codex — chắc chắn chạy từ thư mục dự án? (engine đã copy vào .ai-guard\bin nhưng chưa đăng ký hook nào)"
}

Write-Host ""
Write-Host "ai-guard fallback installed tại $Root\.ai-guard\bin"
Write-Host "Chế độ fallback: claude-code + codex; đầy đủ 7 tool: dùng npm (npx ai-guard init)."
Write-Host "Kiểm tra: echo 'test sạch' | $PyCmd `"$Root\.ai-guard\bin\engine.py`" check-prompt --root `"$Root`""
