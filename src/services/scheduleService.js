// ============================================================
// Schedule Service - Cron Job ส่ง QR Code อัตโนมัติ
// ============================================================

const cron = require('node-cron');
const { pool } = require('../config/database');
const { createQRSession, expirePreviousSessions } = require('./qrService');
const { sendQRToGroup } = require('./lineService');

// ============================================================
// ตรวจสอบตารางสอนทุกนาที แล้วส่ง QR ตามเวลาที่กำหนด
// ============================================================
function startScheduler() {
  // ทำงานทุกนาที (วันจันทร์ - ศุกร์, 07:00 - 17:00)
  cron.schedule('* 7-17 * * 1-5', async () => {
    try {
      await checkAndSendQR();
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  // ทำให้ QR ที่หมดอายุเปลี่ยนสถานะ ทุก 5 นาที
  cron.schedule('*/5 * * * *', async () => {
    try {
      await expireOldSessions();
    } catch (err) {
      console.error('Expire sessions error:', err);
    }
  });

  console.log('✅ Scheduler started - checking every minute (Mon-Fri 07:00-17:00)');
}

async function checkAndSendQR() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=อาทิตย์, 1=จันทร์, ...
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"
  const today = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // ดึงตารางสอนวันนี้ที่เปิด auto_send
  const schedulesResult = await pool.query(
    `SELECT s.*, 
            sub.subject_name, sub.subject_code,
            c.room_name, c.latitude, c.longitude,
            lg.line_group_id AS line_gid,
            pt_start.start_time, pt_end.end_time
     FROM schedules s
     JOIN subjects sub ON s.subject_id = sub.id
     JOIN classrooms c ON s.classroom_id = c.id
     LEFT JOIN line_groups lg ON s.line_group_id = lg.id
     JOIN period_times pt_start ON s.start_period = pt_start.period_number
     JOIN period_times pt_end ON s.end_period = pt_end.period_number
     WHERE s.day_of_week = $1 
       AND s.auto_send = TRUE 
       AND s.is_active = TRUE`,
    [dayOfWeek]
  );

  for (const schedule of schedulesResult.rows) {
    if (!schedule.line_gid) continue; // ยังไม่มีกลุ่มไลน์ ข้ามไป

    // คำนวณเวลาส่ง QR เข้าเรียน (ก่อนเริ่มคาบ X นาที)
    const checkInSendTime = subtractMinutes(
      schedule.start_time,
      schedule.send_minutes_before
    );

    // คำนวณเวลาส่ง QR หลังเรียน (ก่อนสิ้นสุดคาบ 5 นาที)
    const checkOutSendTime = subtractMinutes(schedule.end_time, 5);

    // ---- ส่ง QR เข้าเรียน ----
    if (currentTime === checkInSendTime) {
      const alreadySent = await hasQRBeenSent(schedule.id, 'check_in', today);
      if (!alreadySent) {
        await sendScheduledQR(schedule, 'check_in', today);
      }
    }

    // ---- ส่ง QR หลังเรียน ----
    if (currentTime === checkOutSendTime) {
      const alreadySent = await hasQRBeenSent(schedule.id, 'check_out', today);
      if (!alreadySent) {
        await sendScheduledQR(schedule, 'check_out', today);
      }
    }
  }
}

// ส่ง QR ตาม schedule
async function sendScheduledQR(schedule, qrType, today) {
  console.log(`🔄 Auto-sending ${qrType} QR for: ${schedule.subject_name}`);

  // ยกเลิก QR เก่าของ schedule เดียวกัน (ถ้ามี)
  await expirePreviousSessions(schedule.id, qrType, today);

  // สร้าง QR Session ใหม่
  const qrSession = await createQRSession({
    scheduleId: schedule.id,
    subjectId: schedule.subject_id,
    teacherId: schedule.teacher_id,
    lineGroupId: schedule.line_group_id,
    qrType
  });

  // ส่ง Flex Message เข้ากลุ่มไลน์
  const sentAt = new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit'
  });

  await sendQRToGroup(schedule.line_gid, {
    token: qrSession.token,
    qrType,
    subjectName: schedule.subject_name,
    room: schedule.room_name,
    sentAt
  });

  // บันทึก Log
  await pool.query(
    `INSERT INTO system_logs (event_type, event_data, teacher_id)
     VALUES ('qr_auto_sent', $1, $2)`,
    [
      JSON.stringify({
        token: qrSession.token,
        qr_type: qrType,
        subject: schedule.subject_name,
        group: schedule.line_gid,
        schedule_id: schedule.id
      }),
      schedule.teacher_id
    ]
  );

  console.log(`✅ Auto-sent ${qrType} QR: ${qrSession.token} → ${schedule.subject_name}`);
}

// ตรวจสอบว่าวันนี้ส่ง QR ไปแล้วหรือยัง
async function hasQRBeenSent(scheduleId, qrType, date) {
  const result = await pool.query(
    `SELECT id FROM qr_sessions 
     WHERE schedule_id = $1 AND qr_type = $2 AND session_date = $3 
       AND status = 'active'`,
    [scheduleId, qrType, date]
  );
  return result.rows.length > 0;
}

// ลบเวลาออก X นาที ("08:30" - 5 = "08:25")
function subtractMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m - minutes;
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// ทำให้ QR Sessions ที่หมดอายุเปลี่ยนสถานะ
async function expireOldSessions() {
  const result = await pool.query(
    `UPDATE qr_sessions 
     SET status = 'expired' 
     WHERE status = 'active' AND expires_at < NOW()`
  );
  if (result.rowCount > 0) {
    console.log(`🔄 Expired ${result.rowCount} QR session(s)`);
  }
}

module.exports = { startScheduler };
