# ai-guard — Thiết kế hệ thống phòng chống rò rỉ credential khi làm việc với AI coding tools

- **Ngày**: 2026-10-04
- **Trạng thái**: Đã duyệt qua brainstorming (phạm vi B, phương án A cải tiến, engine A, phân phối B)
- **Dự án**: `prevent-crendential-leaked`

## 1. Mục tiêu

Ngăn developer **vô tình** gửi credential (API key, password, database password, private key, connection string...) lên AI provider khi làm việc với các AI coding tool. Hệ thống:

- Chặn prompt chứa credential **trước khi** gửi tới model
- Chặn AI đọc file nhạy cảm (`.env`, private key, credentials...)
- Khi dev cố ý xác nhận tiếp tục → cho qua nhưng **ghi audit log kèm timestamp**
- Cài đặt **1 lệnh** cho dự án, dùng chung cho cả team
- Không phá workflow: nhanh, fail-open, không đụng config cũ của tool

## 2. Phạm vi

**Phạm vi B** — hai điểm chặn:

1. **Prompt-side**: prompt người dùng gõ (hook `UserPromptSubmit` hoặc tương đương)
2. **File-side**: file AI định đọc qua tool (`Read`, `tool.execute.before`...)

**Ngoài phạm vi (v1)**: output lệnh AI chạy (phạm vi C), redact tự động, scan repo khi commit (đã có gitleaks làm việc đó).

## 3. Tool được hỗ trợ & năng lực hook (khảo sát 2026-10-04)

| Tool | Chặn prompt | Chặn file | Cơ chế đăng ký | Ghi chú |
|------|:---:|:---:|--------|---------|
| Claude Code | ✅ | ✅ | `.claude/settings.json` → hooks | `UserPromptSubmit` exit 2 chặn; `PreToolUse` chặn tool |
| Codex CLI | ✅ | ✅ | `.codex/hooks.json` hoặc `[hooks]` trong `config.toml` | Có hooks từ bản GA; 5 event types |
| OpenCode | ✅ | ✅ | `.opencode/plugins/ai-guard.ts` (shim TS) | `tool.execute.before` — throw để chặn |
| Pi (badlogic/pi-mono) | ✅ | ✅ | extension TS trong `.pi/` | pre-`tool_call`, intercept được mọi thứ |
| Cline | ⚠️ | ✅ | hooks config của Cline | PreToolUse-style, thay thế `.clineignore` |
| Kiro | ⚠️ | ⚠️ | `.kiro/hooks/` | Agent Hooks có nhưng payload thiếu `tool_input` (issue kirodotdev/Kiro#7500) → best-effort |
| GitHub Copilot | ❌ | ⚠️ | VS Code agent hooks (preview) | Chặn tool-call của agent mode được; **prompt không chặn được** |

Giới hạn của Kiro/Copilot được bù bằng **education layer** (mục 10).

## 4. Kiến trúc — Engine chung + adapter từng tool

```
┌─────────────────────────────────────────────┐
│  ai-guard CLI (npm, zero-dep, <150ms/lần)   │
│  engine: regex catalog + entropy + loader   │
└──────────────┬──────────────────────────────┘
               │ stdin JSON / argv (chuẩn chung)
   ┌───────┬───┴────┬─────────┬─────────┬───────┐
   ▼       ▼        ▼         ▼         ▼       ▼
 claude   codex  opencode    pi      cline   kiro/copilot
 adapter  adapter adapter  adapter  adapter   adapter
```

- **Một engine duy nhất** — mọi tool dùng chung logic phát hiện và rule catalog
- Adapter = lớp mỏng: đăng ký hook đúng chỗ của tool + convert payload về JSON chuẩn
- Tool có plugin hệ TS (OpenCode/Pi) nhận shim tự sinh, shim spawn CLI engine
- Fallback không-npm: `install.sh` / `install.ps1` + engine Python 1 file mirror

## 5. Cấu trúc package

```
ai-guard/
├── package.json              # bin: ai-guard, ZERO runtime deps (chỉ Node stdlib)
├── src/
│   ├── cli.ts                # init | check-prompt | check-file | allow | doctor | uninstall | self-test
│   ├── engine/
│   │   ├── scanner.ts        # scan(text, rules) → Finding[]
│   │   ├── entropy.ts        # Shannon entropy heuristic
│   │   ├── rules/            # catalog built-in: aws.ts, saas.ts, db.ts, keys.ts, jwt.ts...
│   │   └── loader.ts         # merge built-in + .ai-guard/rules.json (project)
│   ├── adapters/
│   │   ├── types.ts          # interface AdapterBase
│   │   ├── claude-code.ts    # merge vào .claude/settings.json
│   │   ├── codex.ts          # .codex/hooks.json
│   │   ├── opencode.ts       # .opencode/plugins/ai-guard.ts (shim spawn CLI)
│   │   ├── pi.ts             # extension shim
│   │   ├── cline.ts          # hooks config của Cline
│   │   ├── kiro.ts           # .kiro/hooks/
│   │   └── copilot.ts        # VS Code agent hooks
│   ├── bypass.ts             # time-window bypass flags
│   ├── audit.ts              # JSONL writer (masked)
│   └── util/                 # path helpers Windows/macOS/Linux
├── fallback/
│   ├── install.sh
│   ├── install.ps1
│   └── engine.py             # engine mirror 1 file, cùng rules JSON, cùng CLI contract
├── templates/                # template cho shim/config
└── tests/
    ├── rules.test.ts         # fixtures key GIẢ theo format thật
    ├── scanner.test.ts
    └── integration/          # golden payload JSON từng tool → assert exit codes
```

Dev dependencies: TypeScript, vitest. Không runtime dependency.

## 6. Giao thức nội bộ

Mọi hook mọi tool normalize về 2 lệnh:

| Lệnh | Input (stdin) | Khi phát hiện | Khi sạch |
|------|--------------|---------------|----------|
| `ai-guard check-prompt` | `{tool, prompt, cwd, session}` | exit 2, stderr = thông báo + hướng dẫn bypass | exit 0, im lặng |
| `ai-guard check-file <path>` | `{tool, path, op: read\|write}` | exit 2 nếu path khớp sensitive-list (áp dụng cho cả `read` lẫn `write`) | exit 0 |

- Thông báo stderr có tiền tố `ai-guard:` thống nhất
- Exit code khác (crash) → fail-open (mục 12)

## 7. Engine phát hiện

### 7.1 Rule catalog built-in (~10 nhóm, ~80 rules)

| Nhóm | Ví dụ |
|------|-------|
| Cloud | AWS `AKIA[0-9A-Z]{16}`, Google `AIza[0-9A-Za-z\-_]{35}`, Azure, Stripe `sk_live_` |
| AI provider | OpenAI `sk-[A-Za-z0-9]{20,}`, Anthropic `sk-ant-`, Gemini, HuggingFace `hf_` |
| VCS/CI | GitHub `ghp_`/`gho_`, GitLab `glpat-`, Slack `xox[bpa]-`, `npm_`, PyPI, Docker `dckr_pat_` |
| DB connection | `(mongodb\|postgres\|mysql\|redis\|amqp\|mssql)://user:pass@`, `jdbc:`, `ConnectionString=` |
| Config pattern | `password=`, `secret:`, `api_key:` trong ngữ cảnh config/yaml/json |
| Private key | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |
| JWT | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` |
| Generic secret | assignment `Password/Secret/Token` với giá trị entropy cao → mức `warn` |

Mỗi rule: `{ id, severity: "block"|"warn", pattern, description }`.

**Ý nghĩa severity**: `block` → exit 2 (chặn như mục 8); `warn` → exit 0 (cho qua) + ghi log `action: "warned"`. Rule `warn` dành cho detection không chắc chắn (entropy, generic pattern).

### 7.2 Mở rộng rule (yêu cầu bắt buộc)

File `.ai-guard/rules.json` của project — team tự thêm format nội bộ không cần sửa code:

```json
{
  "add": [
    { "id": "internal-token", "severity": "block", "pattern": "CORP-[A-Z0-9]{32}", "description": "Internal corp token" }
  ],
  "override": { "jwt": { "severity": "warn" } },
  "remove": ["slack-token"]
}
```

Loader merge theo thứ tự: built-in → `add` → `override` → `remove`.

### 7.3 Chống false-positive

- Word-boundary quanh pattern
- Bỏ qua placeholder rõ ràng: `test_`, `example`, `xxxxx`, `${...}`, `<your-key>`, `***`, `changeme`, `dummy`
- Generic/entropy rules mặc định `warn` (không block) — chỉ rule format chuyên dụng mới block

### 7.4 Sensitive path list (mặc định, config được)

`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `credentials*`, `secrets/**`, `.aws/credentials`, `.npmrc`, `.netrc`, `*.p12`, `*.pfx`, `service-account*.json`. Override qua `.ai-guard/config.json`.

## 8. Luồng chặn → xác nhận → audit (phương án A cải tiến)

```
Dev gõ prompt chứa key
   → hook → ai-guard check-prompt → Finding
   → exit 2, tool hiển thị:
     "ai-guard: ĐÃ CHẶN — phát hiện credential
      • Rule: anthropic-api-key • Preview: sk-ant-***k3Jg
      Nếu CỐ Ý muốn gửi: npx ai-guard allow prompt --5m rồi gửi lại"
   → audit log: action "blocked"

Nhánh 1: dev sửa bỏ key → exit 0 (không log thêm)
Nhánh 2: dev chạy allow --5m → bypass flag (5 phút) + log "bypass_granted"
         → gửi lại → exit 0 + log "allowed_after_confirm"
```

- Bypass là lệnh tách rời → giống hệt trên 7 tool, luôn audit được
- File: `npx ai-guard allow file .env --10m` — scope đúng 1 file
- Bypass flags ghi tại `.ai-guard/.bypass/` kèm expiry, tự dọn hết hạn

## 9. Audit log

`.ai-guard/logs/YYYY-MM-DD.jsonl` — 1 dòng/event:

```json
{"ts":"2026-10-04T21:30:05+07:00","tool":"claude-code","event":"prompt","rule":"anthropic-api-key","preview":"sk-ant-***k3Jg","action":"blocked"}
{"ts":"2026-10-04T21:31:12+07:00","tool":"claude-code","event":"bypass","scope":"prompt","duration_min":5,"action":"bypass_granted"}
{"ts":"2026-10-04T21:31:40+07:00","tool":"claude-code","event":"prompt","rule":"anthropic-api-key","preview":"sk-ant-***k3Jg","action":"allowed_after_confirm"}
```

- **Không bao giờ ghi secret nguyên bản** — preview = 6 ký tự đầu + `***` + 4 ký tự cuối
- `init` tự thêm `.ai-guard/logs/` vào `.gitignore`
- `event` ∈ `prompt | file | bypass`; `action` ∈ `blocked | warned | bypass_granted | allowed_after_confirm`

## 10. Cài đặt & trải nghiệm team

### 10.1 `npx ai-guard init`

1. Phát hiện tool (scan `.claude/`, `.codex/`, `.opencode/`, `.pi/`, `.kiro/`, `.cline/`, `.vscode/`; hỏi tương tác nếu không chắc)
2. Merge an toàn hook vào config từng tool — **backup `.bak`**, không đè key nào khác, mọi gì ai-guard ghi đều nằm trong namespace riêng / có marker
3. Tạo `.ai-guard/` (config.json, rules.json, logs/, .bypass/)
4. Update `.gitignore`
5. Ghi education layer (optional, tắt bằng `--no-instructions`): vài dòng vào `AGENTS.md`/`CLAUDE.md` + `.kiro/steering/security.md` + `.github/copilot-instructions.md` dặn AI không yêu cầu/đọc credential
6. In summary

Hook config nằm trong project file commit được (`.claude/settings.json`, `.codex/config.toml`, `.opencode/`...) → member clone repo **đã có sẵn hook**.

### 10.2 Lệnh phụ

- `npx ai-guard doctor` — verify hook đăng ký + engine chạy + `self-test` fixtures nội bộ
- `npx ai-guard uninstall` — gỡ hook theo marker, giữ `.ai-guard/`, hỏi trước khi xóa log
- `npx ai-guard self-test` — chạy fixtures nội bộ, in kết quả

### 10.3 Fallback không-npm

`install.sh` (bash) / `install.ps1` (PowerShell): tải `engine.py` + rules JSON về `.ai-guard/bin/`, đăng ký hook trỏ vào `python3`/`py`. Thiếu Python → báo điều kiện cần rõ ràng, không cài dở dang.

## 11. Adapter chi tiết theo tool

| Adapter | Đăng ký | Chuyển đổi |
|---------|---------|-----------|
| claude-code | `hooks.UserPromptSubmit`, `hooks.PreToolUse` (matcher Read/Glob/Grep) | stdin JSON → lấy `prompt` / `tool_input.file_path` |
| codex | `.codex/hooks.json` — `UserPromptSubmit`, `PreToolUse` | payload JSON chuẩn của Codex → map về internal |
| opencode | shim `.opencode/plugins/ai-guard.ts` | `tool.execute.before` throw; chat event → spawn CLI |
| pi | extension shim trong `.pi/` | pre-`tool_call` → spawn CLI |
| cline | hooks config của Cline (PreToolUse-style) | payload của Cline → internal |
| kiro | `.kiro/hooks/` best-effort | payload thiếu input → chỉ chặn được theo path nếu có; doctor cảnh báo |
| copilot | VS Code agent hooks (tool-call) + instructions file | giáo dục là chính |

Hook command dùng **đường dẫn tuyệt đối** tới engine (tránh vấn đề PATH, đặc biệt Windows).

## 12. Xử lý lỗi & hiệu năng

- **Fail-open có chủ đích**: engine crash/lỗi → prompt vẫn đi, không phá workflow; lỗi ghi `.ai-guard/logs/error.log`; docs ghi rõ đánh đổi này
- Hiệu năng mục tiêu: **<150ms/lần gọi** (Node startup ~80ms + regex ~80 rules đã compile)
- Windows: xử lý path, `py` launcher, shell cmd/PowerShell; CI test đủ 3 OS

## 13. Testing

- **Unit**: mỗi rule ≥3 fixture dương tính (key giả, format thật) + âm tính (placeholder/từ điển); entropy có test riêng
- **Golden integration**: payload JSON hook thật từng tool (từ docs chính thức) → assert exit code + stderr
- **Loader**: merge add/override/remove có test đúng thứ tự ưu tiên
- **Bypass/audit**: flag expiry, masking preview, JSONL format
- **CI**: GitHub Actions matrix (win/mac/linux) × Node 20/22
- **self-test**: bộ fixtures nội bộ chạy không cần framework — dev verify ngay sau cài

## 14. Out of scope / hướng tương lai

- Tích hợp gitleaks làm chế độ quét sâu (engine lai — phương án C đã thảo luận)
- Dùng dialog "ask" native của tool (Claude Code `permissionDecision: ask`, OpenCode permission ask) thay dòng lệnh bypass
- Phạm vi C (output lệnh AI chạy)
- Binary Go standalone cho máy không Node/Python
- Redact tự động (phương án B đã loại ở giai đoạn brainstorming)
