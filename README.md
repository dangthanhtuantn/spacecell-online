# SpaceCell Online — Hướng dẫn deploy

## Cấu trúc
```
spacecell-online/
├── server.js          ← Game server (Node.js + Socket.io)
├── package.json
├── README.md
└── public/
    └── index.html     ← Client game
```

---

## BƯỚC 1 — Chạy local để test

```bash
cd spacecell-online
npm install
npm start
```

Mở: http://localhost:3000

Bạn bè cùng mạng LAN vào: http://[IP-của-bạn]:3000
Xem IP: `ipconfig` (Windows) hoặc `ifconfig` (Mac/Linux)

---

## BƯỚC 2 — Deploy lên Railway (miễn phí, dễ nhất)

### 2.1 Tạo tài khoản Railway
- Vào https://railway.app
- Đăng nhập bằng GitHub

### 2.2 Đẩy code lên GitHub
```bash
cd spacecell-online
git init
git add .
git commit -m "SpaceCell Online v1"
```
- Tạo repo mới trên https://github.com/new
- Copy lệnh push và chạy:
```bash
git remote add origin https://github.com/USERNAME/spacecell-online.git
git push -u origin main
```

### 2.3 Deploy trên Railway
1. Vào https://railway.app/new
2. Chọn "Deploy from GitHub repo"
3. Chọn repo `spacecell-online`
4. Railway tự detect Node.js và deploy
5. Sau 1-2 phút → Settings → Networking → Generate Domain
6. Copy link dạng: `https://spacecell-online-xxx.railway.app`
7. Chia sẻ link này cho bạn bè!

---

## BƯỚC 3 — Deploy lên Render (miễn phí thay thế)

1. Vào https://render.com → New → Web Service
2. Kết nối GitHub repo
3. Cài đặt:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
4. Click Deploy
5. Sau ~3 phút có link public

---

## Lưu ý

- Railway miễn phí cho $5/tháng usage (đủ dùng cho game nhỏ)
- Render miễn phí nhưng sleep sau 15 phút không có traffic (hơi chậm lần đầu)
- Nếu muốn server luôn online 24/7 có thể dùng gói trả phí ~$5/tháng
- Có thể dùng custom domain nếu có

---

## Điều khiển

| Phím | Chức năng |
|------|-----------|
| Di chuột | Điều hướng |
| Q | DASH — trượt 200px về phía con trỏ |
| W | SHIELD — khiên bảo vệ 3s |
| E (giữ) | SHOOT — bắn đạn liên tục |
| R | STEALTH — tàng hình 3s |
| B | BOMB — ném bom về phía con trỏ |
| F | MAGNET — hút thức ăn 300px |
