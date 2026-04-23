# ระบบเช็คชื่อผู้เรียน — วิทยาลัยอาชีวศึกษากาญจนบุรี

LINE Bot + LIFF App สำหรับเช็คชื่อเข้าเรียนและหลังเรียน
ด้วย QR Code + Face Recognition + GPS

## Deploy บน Render.com

1. Fork หรือ Push repo นี้ขึ้น GitHub
2. เข้า [render.com](https://render.com) → New → Blueprint
3. เชื่อมต่อ GitHub repo → Render จะอ่าน `render.yaml` แล้วสร้าง service + database อัตโนมัติ
4. กรอก Environment Variables ที่ต้องใส่เอง (LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN)
5. รอ deploy เสร็จ → ได้ URL เช่น `https://kvc-attendance-bot.onrender.com`
6. ตั้ง Webhook URL ใน LINE Developers Console: `https://kvc-attendance-bot.onrender.com/webhook/line`

## สร้างตาราง Database

หลัง deploy เสร็จ ให้รัน:
```
node db-init.js
```

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **LINE SDK**: @line/bot-sdk
- **Scheduler**: node-cron
- **Frontend**: LIFF App (deploy แยกบน Netlify)
