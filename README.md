# KVC Attendance Bot — ชุดรวม 18 พ.ค. 2569

โฟลเดอร์นี้รวม **Backend + Frontend** ที่แก้ไขล่าสุด (ฟีเจอร์นักเรียนลงทะเบียนเอง → ครูยืนยัน)

## โครงสร้างไฟล์

```
18-5-69/
├── server.js                 # Backend หลัก (push ขึ้น GitHub/Render)
├── package.json
├── render.yaml
├── attendance-schema.sql
├── db-init.js
├── .gitignore
│
├── src/
│   ├── api/
│   │   ├── liffApi.js        # API นักเรียน (LIFF) + รอครูยืนยัน
│   │   ├── dashboardApi.js   # API ครู + ยืนยัน/ปฏิเสธนักเรียน
│   │   ├── reportApi.js      # รายงาน + Export Excel
│   │   └── rmsApi.js         # เตรียมเชื่อม RMS (ถ้าใช้)
│   ├── config/
│   │   ├── database.js
│   │   └── autoInit.js
│   ├── webhook/lineWebhook.js
│   ├── services/             # LINE, QR, Cron
│   └── utils/gps.js
│
├── LiffIndex/
│   └── index.html            # หน้า LIFF นักเรียน → อัปโหลด Netlify
│
└── Dashbord/
    └── index.html            # หน้า Dashboard ครู → อัปโหลด Netlify
```

## Deploy สั้นๆ

### 1) Backend → GitHub → Render

ใช้ **ทั้งโฟลเดอร์นี้เป็น root ของ repo** (ยกเว้น `LiffIndex`, `Dashbord` ก็ push ไปด้วยได้ ไม่กระทบ server)

```bash
cd "d:\สำรองเครื่อง\โปรแกรมเช็คชื่อ\18-5-69"
git init
git add .
git commit -m "Add student approval workflow"
git remote add origin https://github.com/chirdpong1998naimmang-bot/kvc-attendance-bot.git
git push -u origin main
```

### 2) Frontend → Netlify

| ไฟล์ | อัปโหลดเป็น |
|------|-------------|
| `Dashbord/index.html` | `index.html` (หน้าแรก) |
| `LiffIndex/index.html` | `liff/index.html` |

### 3) LINE

- Webhook: `https://kvc-attendance-bot.onrender.com/webhook/line`
- LIFF Endpoint: `https://YOUR-NETLIFY-SITE.netlify.app/liff/index.html`

## ฟีเจอร์ล่าสุด (18-5-69)

- นักเรียนลงทะเบียนเอง → สถานะ `pending`
- ครูยืนยัน/ปฏิเสธ ใน Dashboard แท็บนักเรียน
- ยังเช็คชื่อไม่ได้จนกว่าครูจะกดยืนยัน

## ไฟล์เก่า (ไม่ต้องใช้ deploy)

- `indexliffเดิม.html` — สำรองก่อนแก้
- `liffApi_fixed/` — รวมเข้า `src/api/liffApi.js` แล้ว
