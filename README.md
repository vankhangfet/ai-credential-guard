# ai-guard

Ngăn credential (API key, password, private key, connection string...) rò rỉ lên AI provider khi làm việc với AI coding tools. Hook vào **prompt** và **file-read** của 7 tool: Claude Code, Codex CLI, OpenCode, Pi, Cline, Kiro, GitHub Copilot (VS Code). Chặn trước khi gửi; bypass có xác nhận kèm audit log.

## Cài đặt (1 lệnh, cần Node ≥20)

```bash
npm i -D ai-guard      # hook chạy local, không cần mạng (khuyến nghị)
npx ai-guard init      # tự phát hiện tool trong dự án và đăng ký hook
npx ai-guard doctor    # kiểm tra hooks + engine
```

Sau đó **commit các file config hook** (`.claude/settings.json`, `.codex/hooks.json`, `.opencode/`, `.pi/`, `.clinerules/hooks/`, `.kiro/`, `.github/hooks/`) — thành viên mới clone repo đã có sẵn bảo vệ, chỉ cần `npm i`.

Không có npm? Xem [Fallback (Python)](#fallback-python-không-cần-npm).

## Cách hoạt động

```
Prompt/file → hook tool → ai-guard check-* → sạch → cho qua
                                        → phát hiện (severity block) → CHẶN + hướng dẫn bypass
Bypass có chủ đích:  npx ai-guard allow prompt --5m      (hoặc: allow file .env --10m)
                     → cho qua trong N phút (1..1440) + ghi audit log
```

- **Audit log**: `.ai-guard/logs/YYYY-MM-DD.jsonl` — secret luôn bị che (`sk-ant***k3Jg`); log không bao giờ chứa secret nguyên bản
- **Rule mở rộng**: `.ai-guard/rules.json` — `add` (rule mới, trùng id thì THAY THẾ), `override` (đổi severity), `remove` — thêm format nội bộ không cần code. Lưu ý: rule demo `example-internal` (CORP-*) đang bật — sửa/xoá theo nhu cầu
- **Sensitive paths**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets/**`... — cấu hình thêm được trong `.ai-guard/config.json`
- **Fail-open**: engine lỗi không chặn workflow của bạn (in cảnh báo stderr)

## Bảng hỗ trợ tool

| Tool | Chặn prompt | Chặn file | Ghi chú |
|------|:---:|:---:|---------|
| Claude Code | ✅ | ✅ | UserPromptSubmit + PreToolUse (Read/Glob/Grep) |
| Codex CLI | ✅ | ✅ | PreToolUse: Edit/Write/apply_patch/MCP |
| OpenCode | ✅ | ✅ | plugin shim `.opencode/plugins/ai-guard.ts` |
| Pi | ⚠️ best-effort | ✅ | tool_call chặn thật (`{block}`); prompt-side best-effort |
| Cline | ✅ | ✅ | script hooks `.clinerules/hooks/` (macOS/Linux; bật Features > Hooks) |
| Kiro | ⚠️ | ⚠️ | best-effort (payload thiếu tool_input — Kiro#7500) + steering |
| Copilot (VS Code) | ❌ | ✅ | `.github/hooks/*.json` (chat.useHooks); prompt không chặn được (giới hạn nền tảng) |

## Fallback (Python, không cần npm)

Cho máy không có Node — chế độ này chỉ đăng ký hook cho **claude-code + codex** (đầy đủ 7 tool cần npm):

```bash
git clone <repo> && cd ai-guard
npm run build && cp dist/rules.json fallback/rules.json   # cần 1 lần để build rule artifact
cd <thư-mục-dự-án-của-bạn>
bash /path/to/ai-guard/fallback/install.sh        # macOS/Linux
# Windows: powershell -File install.ps1
```

- Engine Python tại `.ai-guard/bin/engine.py`; block-flow hint trỏ đúng path đó
- **KHÔNG có dist/rules.json → engine chỉ còn heuristic warn (KHÔNG chặn)** — installer sẽ cảnh báo
- **Gỡ fallback**: không có uninstall script — khôi phục `.aiguard.bak` (backup đầu tiên) cho `.claude/settings.json` + `.codex/hooks.json`, hoặc xoá tay các entry chứa "ai-guard"; xóa `.ai-guard/` nếu muốn sạch hoàn toàn

## Hiệu năng & lưu ý

- Hook là process ngắn: local install (`npm i -D`) ≈ 0.3-0.5s/lần gọi; **không có local install, npx fallback có thể ~6s trên Windows** — luôn khuyến nghị `npm i -D ai-guard`
- `uninstall --purge` **xóa vĩnh viễn audit log** — không hỏi lại

## Lệnh

`init` · `check-prompt` · `check-file` · `allow` · `doctor` · `self-test` · `uninstall [--purge]` · `version`

## Phát triển

```bash
npm install && npm test && npm run build
python -m unittest discover -s fallback/tests -t .   # engine python (23 tests)
```

CI: 3 OS × Node 20/22 + Python + installer smoke (bash + PowerShell). Phát hành npm: `npm publish` (prepare tự build); fallback zip: `fallback/{engine.py,install.sh,install.ps1,rules.json}` (rules.json copy từ dist sau build).

## License

[MIT](LICENSE)
