# คู่มือ Deploy — โฟลเดอร์ 18-5-69

## ไฟล์ที่แก้วันนี้ (รวมอยู่ในโฟลเดอร์นี้แล้ว)

| ไฟล์ | หน้าที่ |
|------|--------|
| `src/api/liffApi.js` | นักเรียนสมัครเอง, รอครูยืนยัน, บล็อกเช็คชื่อจน approved |
| `src/api/dashboardApi.js` | `/students/pending`, `/approve`, `/reject` |
| `LiffIndex/index.html` | หน้ารอครูยืนยัน + ส่งคำขอลงทะเบียน |
| `Dashbord/index.html` | ตารางรอยืนยัน + ปุ่มยืนยัน/ปฏิเสธ |

---

## 1. GitHub + Render (Backend)

**เข้า:** แก้บนเครื่องที่โฟลเดอร์ `18-5-69` แล้ว push

```powershell
cd "d:\สำรองเครื่อง\โปรแกรมเช็คชื่อ\18-5-69"

git add .
git commit -m "Add student approval workflow"
git push
```

**หมายเหตุ:** ถ้า repo เดิมอยู่ที่อื่น ให้ copy ไฟล์ทั้งหมดใน `18-5-69` ไปทับ repo นั้น หรือตั้ง repo ใหม่ให้ root = โฟลเดอร์นี้

**Render:** https://dashboard.render.com → รอ deploy อัตโนมัติ → ทดสอบ  
https://kvc-attendance-bot.onrender.com/health

---

## 2. Netlify (Frontend)

**เข้า:** https://app.netlify.com

| จากโฟลเดอร์นี้ | อัปโหลดเป็น |
|----------------|-------------|
| `Dashbord/index.html` | `index.html` |
| `LiffIndex/index.html` | `liff/index.html` |

---

## 3. LINE Developers

**เข้า:** https://developers.line.biz/console/

- Webhook: `https://kvc-attendance-bot.onrender.com/webhook/line`
- LIFF Endpoint URL: `https://YOUR-SITE.netlify.app/liff/index.html`
