# Tích hợp Cursor

Tích hợp tokenhop với Cursor IDE để định tuyến request AI qua hệ thống routing thông minh của tokenhop.

## Yêu cầu

- Cursor IDE đã cài đặt
- Tài khoản Cursor Pro (cần thiết cho custom API endpoint)
- tokenhop truy cập được qua HTTPS công khai (xem [Expose tokenhop cho Cursor](#expose-tokenhop-cho-cursor))
- API key từ tokenhop dashboard

## ⚠️ Lưu ý Quan trọng

> **Yêu cầu URL công khai**: Cursor gửi request từ server của chính nó nên không thể truy cập `localhost`. Hãy cấp cho nó một URL HTTPS công khai trỏ tới tokenhop instance của chính bạn, ví dụ URL Cloudflare tunnel hoặc Tailscale Funnel từ trang **Endpoint** trong dashboard, hoặc triển khai trên VPS. tokenhop không có hosted gateway.

> **Yêu cầu Cursor Pro**: Tính năng này yêu cầu tài khoản Cursor Pro để dùng custom API endpoint.

## Setup

### 1. Mở Cursor Settings

1. Mở Cursor IDE
2. Đi đến **Settings** (Cmd/Ctrl + ,)
3. Đi đến phần **Models**

### 2. Bật OpenAI API

1. Tìm option **OpenAI API key**
2. Bật toggle để kích hoạt cấu hình custom API

### 3. Cấu hình Base URL

Đặt base URL tới URL công khai của tokenhop instance, kèm `/v1` ở cuối:

```
https://<your-tokenhop-host>/v1
```

**Các bước:**

1. Trong cài đặt Models, tìm field **Base URL**
2. Nhập: `https://<your-tokenhop-host>/v1`
3. Click **Save**

### 4. Thêm API Key

1. Trong field **API Key**, nhập API key tokenhop
2. Bạn có thể tìm API key trong tokenhop dashboard tại **Settings → API Keys**
3. Click **Save**

### 5. Thêm Custom Model

1. Click nút **View All Models**
2. Click **Add Custom Model**
3. Nhập tên model từ cấu hình tokenhop (ví dụ: `gpt-4`, `claude-opus-4-5`, v.v.)
4. Click **Add**

### 6. Chọn Model

1. Trong giao diện chat Cursor, click dropdown chọn model
2. Chọn custom model từ danh sách
3. Bắt đầu dùng tokenhop với Cursor!

## Ví dụ Cấu hình

Cursor settings của bạn nên trông như sau:

```
OpenAI API: ✓ Enabled
Base URL: https://<your-tokenhop-host>/v1
API Key: sk-xxxxxxxxxxxxxxxx
Custom Models: gpt-4, claude-opus-4-5, gemini-2.0-flash
```

## Model có sẵn

Bạn có thể dùng bất kỳ model nào đã cấu hình trong tokenhop dashboard. Ví dụ phổ biến:

| Tên Model           | Provider  | Mô tả             |
| ------------------- | --------- | ----------------- |
| `gpt-4`             | OpenAI    | GPT-4 Turbo       |
| `gpt-4o`            | OpenAI    | GPT-4 Optimized   |
| `claude-opus-4-5`   | Anthropic | Claude Opus 4.5   |
| `claude-sonnet-4-5` | Anthropic | Claude Sonnet 4.5 |
| `gemini-2.0-flash`  | Google    | Gemini 2.0 Flash  |

## Sử dụng

### Giao diện Chat

1. Mở Cursor chat (Cmd/Ctrl + L)
2. Chọn model từ dropdown
3. Bắt đầu chat với AI qua tokenhop

### Tạo Code Inline

1. Chọn code trong editor
2. Nhấn Cmd/Ctrl + K
3. Nhập prompt
4. Cursor sẽ dùng tokenhop để tạo code

### Giải thích Code

1. Chọn code trong editor
2. Nhấn Cmd/Ctrl + L
3. Hỏi "Explain this code"
4. Nhận giải thích AI qua tokenhop

## Troubleshooting

### Lỗi "Invalid API Key"

1. Xác minh API key trong tokenhop dashboard
2. Đảm bảo bạn sao chép đầy đủ key bao gồm prefix `sk-`
3. Kiểm tra API key chưa hết hạn
4. Thử tạo API key mới

### Lỗi "Model Not Found"

1. Xác minh tên model khớp chính xác với cấu hình tokenhop
2. Kiểm tra kết nối provider đang hoạt động trong tokenhop dashboard
3. Đảm bảo model có sẵn trong các provider đã kết nối
4. Thử dùng tên model đầy đủ (ví dụ: `openai/gpt-4` thay vì `gpt-4`)

### Lỗi Connection

1. Xác minh Base URL là URL công khai của tokenhop, kèm `/v1` ở cuối (ví dụ `https://<your-tokenhop-host>/v1`)
2. Mở `/v1/models` của URL đó trong trình duyệt hoặc bằng `curl` để xác nhận nó truy cập được từ internet
3. Đảm bảo tunnel (Cloudflare hoặc Tailscale Funnel) hoặc server vẫn đang chạy
4. Thử tắt VPN hoặc proxy nếu đang bật

### Localhost không hoạt động

> **Nhớ**: Cursor không hỗ trợ endpoint localhost. Hãy expose tokenhop instance cục bộ như hướng dẫn bên dưới và dùng URL công khai đó.

## Expose tokenhop cho Cursor

Nếu bạn chạy tokenhop cục bộ và muốn dùng với Cursor:

1. Mở tokenhop dashboard → **Endpoint**
2. Bật **Cloudflare tunnel** (URL dạng `*.trycloudflare.com`) hoặc **Tailscale Funnel** (cần cài và đăng nhập Tailscale)
3. Copy URL công khai và dùng nó, kèm `/v1`, làm Base URL trong Cursor
4. Bật **Require API key** để chỉ API key của bạn mới dùng được URL công khai

Ngoài ra, chạy tokenhop trên server với domain công khai và HTTPS (xem [Cloud (VPS/Docker)](/vi/deployment/cloud)), hoặc đặt sau reverse proxy / tunnel của riêng bạn.

## Best Practices

1. **Dùng Model Aliases**: Tạo alias ngắn cho model thường dùng trong tokenhop
2. **Theo dõi Usage**: Kiểm tra tokenhop dashboard để xem thống kê và chi phí
3. **Xoay API Key**: Định kỳ xoay API key để bảo mật
4. **Test Model**: Thử các model khác nhau để tìm model tốt nhất cho use case
