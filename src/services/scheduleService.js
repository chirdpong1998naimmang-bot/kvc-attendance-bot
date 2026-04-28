// ============================================================
// Schedule Service - Cron Job ส่ง QR Code อัตโนมัติ
// ============================================================

const cron = require('node-cron');
const { pool } = require('../config/database');
const { createQRSession, expirePreviousSessions } = require('./qrService');
const { sendQRToGroup } = require('./lineService');

// ─── Timezone Helper ───
function getThaiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
}

// ============================================================
// ตรวจสอบตารางสอนทุกนาที แล้วส่ง QR ตามเวลาที่กำหนด
// ============================================================
function startScheduler() {
  // ทำงานทุกนาที — เช็คเวลาไทยเอง (เพราะ Render ใช้ UTC)
  cron.schedule('* * * * *', async () => {
    try {
      const now = getThaiNow();
      const day = now.getDay();
      const hour = now.getHours();

      // เฉพาะ จ.-ศ. (1-5) เวลา 07:00-17:00
      if (day >= 1 && day <= 5 && hour >= 7 && hour <= 17) {
        await checkAndSendQR();
      }
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

  console.log('✅ Scheduler started - checking every minute (Mon-Fri 07:00-17:00 Bangkok time)');
}

async function checkAndSendQR() {
  const now = getThaiNow();
  const dayOfWeek = now.getDay();
  const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  // ดึงตารางสอนวันนี้ที่เปิด auto_send (ใช้ custom time ถ้ามี)
  const schedulesResult = await pool.query(
    `SELECT s.*,
            s.custom_start_time, s.custom_end_time,
            sub.subject_name, sub.subject_code,
            c.room_name, c.latitude, c.longitude,
            lg.line_group_id AS line_gid
     FROM schedules s
     JOIN subjects sub ON s.subject_id = sub.id
     JOIN classrooms c ON s.classroom_id = c.id
     LEFT JOIN line_groups lg ON s.line_group_id = lg.id
     WHERE s.day_of_week = $1
       AND s.auto_send = TRUE
       AND s.is_active = TRUE`,
    [dayOfWeek]
  );

  for (const schedule of schedulesResult.rows) {
    if (!schedule.line_gid) continue;

    // ใช้ custom time ก่อน ถ้าไม่มีค่อย fallback ไป period_times
    const startTime = schedule.custom_start_time || getDefaultPeriodTime(schedule.start_period, 'start');
    const endTime = schedule.custom_end_time || getDefaultPeriodTime(schedule.end_period, 'end');

    if (!startTime || !endTime) continue;

    // คำนวณเวลาส่ง QR เข้าเรียน (ก่อนเริ่มคาบ 15 นาที)
    const checkInSendTime = subtractMinutes(startTime, 15);

    // คำนวณเวลาส่ง QR หลังเรียน (ก่อนสิ้นสุดคาบ 15 นาที)
    const checkOutSendTime = subtractMinutes(endTime, 15);

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

  try {
    // ยกเลิก QR เก่าของ schedule เดียวกัน
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
    const now = getThaiNow();
    const sentAt = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

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
          schedule_id: schedule.id,
          sent_at_thai: sentAt
        }),
        schedule.teacher_id
      ]
    );

    console.log(`✅ Auto-sent ${qrType} QR: ${qrSession.token} → ${schedule.subject_name} (${sentAt})`);
  } catch (err) {
    console.error(`❌ Failed to send ${qrType} QR for ${schedule.subject_name}: ${err.message}`);
  }
}

// ตรวจสอบว่าวันนี้ส่ง QR ไปแล้วหรือยัง
async function hasQRBeenSent(scheduleId, qrType, date) {
  try {
    const result = await pool.query(
      `SELECT id FROM qr_sessions
       WHERE schedule_id = $1 AND qr_type = $2
         AND DATE(created_at AT TIME ZONE 'Asia/Bangkok') = $3::date
         AND status IN ('active', 'used')`,
      [scheduleId, qrType, date]
    );
    return result.rows.length > 0;
  } catch (err) {
    // fallback: ถ้า query ไม่ได้ ให้ถือว่าส่งแล้ว (ป้องกันส่งซ้ำ)
    try {
      const result = await pool.query(
        `SELECT id FROM qr_sessions
         WHERE schedule_id = $1 AND qr_type = $2
           AND created_at >= $3::date
           AND created_at < ($3::date + interval '1 day')`,
        [scheduleId, qrType, date]
      );
      return result.rows.length > 0;
    } catch (err2) {
      console.error('hasQRBeenSent error:', err2.message);
      return true; // error → ถือว่าส่งแล้ว ป้องกันส่งซ้ำ
    }
  }
}

// ดึงเวลาจาก period number (fallback)
function getDefaultPeriodTime(period, type) {
  const PERIOD_TIMES = {
    1:{s:'08:30',e:'09:20'},2:{s:'09:20',e:'10:10'},3:{s:'10:20',e:'11:10'},4:{s:'11:10',e:'12:00'},
    5:{s:'13:00',e:'13:50'},6:{s:'13:50',e:'14:40'},7:{s:'14:50',e:'15:40'},8:{s:'15:40',e:'16:30'}
  };
  const p = PERIOD_TIMES[period];
  if (!p) return null;
  return type === 'start' ? p.s : p.e;
}

// ลบเวลาออก X นาที ("08:30" - 5 = "08:25")
function subtractMinutes(timeStr, minutes) {
  if (!timeStr || !minutes) return timeStr;
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
