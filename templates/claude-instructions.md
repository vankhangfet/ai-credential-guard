<!-- ai-guard:start -->
## Bảo mật credential (ai-guard)

- Không yêu cầu người dùng cung cấp API key, password, private key hay connection string thật.
- Nếu cần biến môi trường, đọc tên biến từ `.env.example` — không đọc `.env`.
- Không mở các file: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets/**`.
- Khi user dán secret vào prompt, nhắc họ thu hồi và xoá secret đó khỏi lịch sử.
<!-- ai-guard:end -->
