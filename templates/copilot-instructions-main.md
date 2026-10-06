<!-- ai-guard:start -->
## Bảo mật credential (ai-guard)

- KHÔNG yêu cầu hoặc đọc credential thật: `.env`, `*.pem`, `id_rsa`, `credentials*`, API key, password, private key, connection string.
- Cần biến môi trường? Dùng `.env.example` hoặc giá trị giả (dummy) — không mở file thật.
- KHÔNG lặp lại secret mà user đã dán vào prompt — nhắc họ thu hồi (revoke) và xoá khỏi lịch sử.
- Prompt trong Copilot chat KHÔNG chặn được bằng hook (giới hạn nền tảng) — instructions này là rào chắn chính phía prompt.
<!-- ai-guard:end -->
