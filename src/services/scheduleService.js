// ============================================================
// Schedule Service - Cron Job ส่ง QR Code อัตโนมัติ
// ============================================================

const cron = require('node-cron');
const { pool } = require('../config/database');
const { createQRSession, expirePreviousSessions } = require('./qrService');
const { sendQRToGroup } = require('./lineService');

const DEFAULT_SEND_MINUTES_BEFORE = 15;
const LEGACY_SEND_MINUTES_BEFORE = 5; // ค่า default เก่าใน schema

async function ensureScheduleTimeColumns() {
  await pool.query(`
    ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS custom_start_time TIME,
      ADD COLUMN IF NOT EXISTS custom_end_time TIME
  `);
}

// ============================================================
// ตรวจสอบตารางสอนทุกนาที แล้วส่ง QR ตามเวลาที่กำหนด (เวลาไทย)
// ============================================================
function startScheduler() {
  // ทุกนาที ทุกวัน — รองรับคาบเย็นและวันเสาร์-อาทิตย์
  cron.schedule('* * * * *', async () => {
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

  console.log('✅ Scheduler started - checking every minute (Asia/Bangkok, all days)');

  // ตรวจทันทีเมื่อ server ตื่น (Render free tier มักหลับ — กันพลาดนาที trigger)
  checkAndSendQR().catch((err) => console.error('Scheduler startup check error:', err));
}

async function getBangkokNow() {
  const result = await pool.query(`
    SELECT
      TO_CHAR(NOW() AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS current_time,
      TO_CHAR(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS today,
      EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Asia/Bangkok'))::int AS day_of_week
  `);
  return result.rows[0];
}

function normalizeTimeStr(timeVal) {
  if (!timeVal) return null;
  const s = String(timeVal);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

function timeToMinutes(timeVal) {
  const normalized = normalizeTimeStr(timeVal);
  if (!normalized) return null;
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function resolveSendMinutesBefore(value) {
  if (value == null || value <= 0) return DEFAULT_SEND_MINUTES_BEFORE;
  // ค่า 5 มาจาก schema default เก่า — ใช้ 15 ตามที่ระบบกำหนด
  if (Number(value) === LEGACY_SEND_MINUTES_BEFORE) return DEFAULT_SEND_MINUTES_BEFORE;
  return Number(value);
}

/** อยู่ในช่วงส่ง QR แล้วหรือยัง (รองรับ server ตื่นช้า ไม่ต้องตรงนาทีเป๊ะ) */
function isWithinSendWindow(currentTime, sendTime, classStart) {
  const now = timeToMinutes(currentTime);
  const send = timeToMinutes(sendTime);
  const start = timeToMinutes(classStart);
  if (now == null || send == null || start == null) return false;
  if (send <= start) return now >= send && now < start;
  // กรณีข้ามเที่ยงคืน (หายาก)
  return now >= send || now < start;
}

async function checkAndSendQR() {
  await ensureScheduleTimeColumns();

  const { current_time: currentTime, today, day_of_week: dayOfWeek } = await getBangkokNow();

  const schedulesResult = await pool.query(
    `SELECT s.*,
            sub.subject_name, sub.subject_code,
            c.room_name, c.latitude, c.longitude,
            lg.line_group_id AS line_gid,
            TO_CHAR(s.custom_start_time, 'HH24:MI') AS custom_start,
            TO_CHAR(s.custom_end_time, 'HH24:MI') AS custom_end,
            TO_CHAR(pt_start.start_time, 'HH24:MI') AS period_start,
            TO_CHAR(pt_end.end_time, 'HH24:MI') AS period_end
     FROM schedules s
     JOIN subjects sub ON s.subject_id = sub.id
     JOIN classrooms c ON s.classroom_id = c.id
     LEFT JOIN line_groups lg ON s.line_group_id = lg.id
     LEFT JOIN period_times pt_start ON s.start_period = pt_start.period_number
     LEFT JOIN period_times pt_end ON s.end_period = pt_end.period_number
     WHERE s.day_of_week = $1
       AND s.auto_send = TRUE
       AND s.is_active = TRUE`,
    [dayOfWeek]
  );

  for (const schedule of schedulesResult.rows) {
    if (!schedule.line_group_id || !schedule.line_gid) {
      console.warn(
        `⚠️ ข้ามส่ง QR อัตโนมัติ: "${schedule.subject_name}" ยังไม่ได้เลือกกลุ่ม LINE ในตารางสอน (schedule_id=${schedule.id})`
      );
      continue;
    }

    const classStart = normalizeTimeStr(
      schedule.custom_start || schedule.period_start
    );
    const classEnd = normalizeTimeStr(
      schedule.custom_end || schedule.period_end
    );

    if (!classStart || !classEnd) {
      console.warn(
        `⚠️ ข้ามส่ง QR อัตโนมัติ: "${schedule.subject_name}" ไม่มีเวลาเริ่ม/สิ้นสุดคาบ (schedule_id=${schedule.id})`
      );
      continue;
    }

    const sendBefore = resolveSendMinutesBefore(schedule.send_minutes_before);
    const checkInSendTime = subtractMinutes(classStart, sendBefore);
    const checkOutSendTime = subtractMinutes(classEnd, 5);

    const shouldSendCheckIn = isWithinSendWindow(currentTime, checkInSendTime, classStart);
    const shouldSendCheckOut = isWithinSendWindow(currentTime, checkOutSendTime, classEnd);

    if (shouldSendCheckIn || shouldSendCheckOut) {
      console.log(
        `[Scheduler] ${schedule.subject_name} | now=${currentTime} start=${classStart} send=${checkInSendTime} before=${sendBefore}m | checkIn=${shouldSendCheckIn}`
      );
    }

    if (shouldSendCheckIn) {
      const alreadySent = await hasQRBeenSent(schedule.id, 'check_in', today);
      if (!alreadySent) {
        try {
          await sendScheduledQR(schedule, 'check_in', today);
        } catch (err) {
          console.error(`❌ Auto-send check_in failed (schedule_id=${schedule.id}):`, err.message);
        }
      }
    }

    if (shouldSendCheckOut) {
      const alreadySent = await hasQRBeenSent(schedule.id, 'check_out', today);
      if (!alreadySent) {
        try {
          await sendScheduledQR(schedule, 'check_out', today);
        } catch (err) {
          console.error(`❌ Auto-send check_out failed (schedule_id=${schedule.id}):`, err.message);
        }
      }
    }
  }
}

// ส่ง QR ตาม schedule
async function sendScheduledQR(schedule, qrType, today) {
  if (!schedule.line_group_id || !schedule.line_gid) {
    throw new Error('กรุณาเลือกกลุ่ม LINE ในตารางสอนก่อนส่ง QR');
  }

  console.log(`🔄 Auto-sending ${qrType} QR for: ${schedule.subject_name} → group ${schedule.line_gid}`);

  await expirePreviousSessions(schedule.id, qrType, today);

  const qrSession = await createQRSession({
    scheduleId: schedule.id,
    subjectId: schedule.subject_id,
    teacherId: schedule.teacher_id,
    lineGroupId: schedule.line_group_id,
    qrType,
    sessionDate: today
  });

  const sentAt = new Date().toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok',
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

async function hasQRBeenSent(scheduleId, qrType, date) {
  const result = await pool.query(
    `SELECT id FROM qr_sessions
     WHERE schedule_id = $1 AND qr_type = $2 AND session_date = $3
       AND status = 'active'`,
    [scheduleId, qrType, date]
  );
  return result.rows.length > 0;
}

function subtractMinutes(timeStr, minutes) {
  const normalized = normalizeTimeStr(timeStr);
  const [h, m] = normalized.split(':').map(Number);
  let totalMinutes = h * 60 + m - minutes;
  if (totalMinutes < 0) totalMinutes += 24 * 60;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

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
