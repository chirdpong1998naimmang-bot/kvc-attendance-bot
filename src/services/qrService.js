// ============================================================
// QR Service - สร้างและตรวจสอบ QR Token
// ============================================================
const { pool } = require('../config/database');

// ★ QR ส่งก่อน 15 นาที + หมดอายุหลัง 15 นาที = อายุรวม 30 นาที
// check_in:  ส่ง startTime-15, หมดอายุ startTime+15
// check_out: ส่ง endTime-15,   หมดอายุ endTime+15
const QR_BUFFER_MINUTES = 15;

// ตัวอักษรที่ใช้สร้าง Token (ตัด 0,O,1,I,L ที่อ่านสับสน)
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateToken(length = 8) {
  let token = '';
  for (let i = 0; i < length; i++) {
    token += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  }
  return token;
}

// คำนวณ expiresAt จากเวลาตามตาราง
async function calcExpiresAt(scheduleId, qrType) {
  try {
    const result = await pool.query(
      `SELECT s.custom_start_time, s.custom_end_time,
              pt_start.start_time AS period_start,
              pt_end.end_time AS period_end
       FROM schedules s
       LEFT JOIN period_times pt_start ON s.start_period = pt_start.period_number
       LEFT JOIN period_times pt_end ON s.end_period = pt_end.period_number
       WHERE s.id = $1`,
      [scheduleId]
    );

    if (result.rows.length > 0) {
      const sched = result.rows[0];
      // เลือกเวลาอ้างอิง: check_in ใช้เวลาเริ่ม, check_out ใช้เวลาสิ้นสุด
      const refTime = qrType === 'check_out'
        ? (sched.custom_end_time || sched.period_end)
        : (sched.custom_start_time || sched.period_start);

      if (refTime) {
        const [h, m] = refTime.split(':').map(Number);
        const now = new Date();
        const expiry = new Date(now);
        expiry.setHours(h, m + QR_BUFFER_MINUTES, 0, 0); // เวลาอ้างอิง + 15 นาที
        return expiry;
      }
    }
  } catch (err) {
    console.warn('calcExpiresAt error:', err.message);
  }

  // Fallback: ถ้าหาเวลาไม่ได้ ใช้ 30 นาทีจากตอนนี้
  return new Date(Date.now() + 30 * 60 * 1000);
}

// สร้าง QR Session ใหม่
async function createQRSession({ scheduleId, subjectId, teacherId, lineGroupId, qrType }) {
  // สร้าง token ที่ไม่ซ้ำ
  let token;
  let attempts = 0;
  while (attempts < 10) {
    token = generateToken();
    const existing = await pool.query('SELECT id FROM qr_sessions WHERE token = $1', [token]);
    if (existing.rows.length === 0) break;
    attempts++;
  }

  // คำนวณเวลาหมดอายุจากตาราง
  const expiresAt = await calcExpiresAt(scheduleId, qrType);

  const result = await pool.query(
    `INSERT INTO qr_sessions 
      (schedule_id, subject_id, teacher_id, line_group_id, token, qr_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [scheduleId, subjectId, teacherId, lineGroupId, token, qrType, expiresAt]
  );

  console.log(`✅ QR created: ${token} (${qrType}) expires → ${expiresAt.toLocaleTimeString('th-TH')}`);
  return result.rows[0];
}

// ตรวจสอบ QR Token
async function validateQRToken(token) {
  const result = await pool.query(
    `SELECT qs.*, s.subject_name, s.subject_code,
            t.name AS teacher_name
     FROM qr_sessions qs
     JOIN subjects s ON qs.subject_id = s.id
     JOIN teachers t ON qs.teacher_id = t.id
     WHERE qs.token = $1`,
    [token.toUpperCase()]
  );

  if (result.rows.length === 0) {
    return { valid: false, error: 'ไม่พบ QR Code นี้ในระบบ' };
  }

  const session = result.rows[0];

  if (session.status !== 'active') {
    return { valid: false, error: 'QR Code นี้ถูกยกเลิกแล้ว' };
  }

  if (new Date() > new Date(session.expires_at)) {
    await pool.query(
      "UPDATE qr_sessions SET status = 'expired' WHERE id = $1",
      [session.id]
    );
    const expTimeStr = new Date(session.expires_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    return { valid: false, error: `QR Code หมดอายุแล้ว (หมดเวลา ${expTimeStr} น.)` };
  }

  return { valid: true, session };
}

// ยกเลิก QR Sessions เก่าของ schedule เดียวกัน
async function expirePreviousSessions(scheduleId, qrType, sessionDate) {
  await pool.query(
    `UPDATE qr_sessions 
     SET status = 'expired' 
     WHERE schedule_id = $1 AND qr_type = $2 AND session_date = $3 AND status = 'active'`,
    [scheduleId, qrType, sessionDate]
  );
}

module.exports = { createQRSession, validateQRToken, expirePreviousSessions, generateToken };
