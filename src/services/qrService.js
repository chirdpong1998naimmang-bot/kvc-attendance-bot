// ============================================================
// QR Service - สร้างและตรวจสอบ QR Token
// ============================================================

const { pool } = require('../config/database');

const QR_EXPIRE_MINUTES = parseInt(process.env.QR_EXPIRE_MINUTES || '30');

// ตัวอักษรที่ใช้สร้าง Token (ตัด 0,O,1,I,L ที่อ่านสับสน)
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateToken(length = 8) {
  let token = '';
  for (let i = 0; i < length; i++) {
    token += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  }
  return token;
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

  const expiresAt = new Date(Date.now() + QR_EXPIRE_MINUTES * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO qr_sessions 
      (schedule_id, subject_id, teacher_id, line_group_id, token, qr_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [scheduleId, subjectId, teacherId, lineGroupId, token, qrType, expiresAt]
  );

  console.log(`✅ QR created: ${token} (${qrType}) expires ${expiresAt.toLocaleTimeString('th-TH')}`);
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
    // อัปเดตสถานะเป็น expired
    await pool.query(
      "UPDATE qr_sessions SET status = 'expired' WHERE id = $1",
      [session.id]
    );
    return { valid: false, error: 'QR Code หมดอายุแล้ว' };
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
