const express = require('express');
const { pool } = require('../config/database');
const { createQRSession } = require('../services/qrService');
const { sendQRToGroup } = require('../services/lineService');

const router = express.Router();

const DAYS_TH = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const PERIOD_TIMES = {
  1:{s:'08:30',e:'09:20'},2:{s:'09:20',e:'10:10'},3:{s:'10:20',e:'11:10'},4:{s:'11:10',e:'12:00'},
  5:{s:'13:00',e:'13:50'},6:{s:'13:50',e:'14:40'},7:{s:'14:50',e:'15:40'},8:{s:'15:40',e:'16:30'}
};

router.get('/schedules', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.day_of_week, s.start_period, s.end_period, s.auto_send,
              sub.subject_name, sub.subject_code,
              c.room_name, lg.group_name, t.name AS teacher_name
       FROM schedules s
       JOIN subjects sub ON s.subject_id = sub.id
       JOIN classrooms c ON s.classroom_id = c.id
       LEFT JOIN line_groups lg ON s.line_group_id = lg.id
       LEFT JOIN teachers t ON s.teacher_id = t.id
       WHERE s.is_active = TRUE
       ORDER BY s.day_of_week, s.start_period`
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      subject_code: r.subject_code,
      subject_name: r.subject_name,
      section: 'ปวช.2/1',
      day_of_week: DAYS_TH[r.day_of_week],
      start_time: PERIOD_TIMES[r.start_period]?.s || '',
      end_time: PERIOD_TIMES[r.end_period]?.e || '',
      room: r.room_name,
      teacher_name: r.teacher_name || '',
      autoSend: r.auto_send,
      lineGroup: r.group_name
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/students', async (req, res) => {
  try {
    const { student_id, studentId, title, first_name, last_name, name, section, level, year, department } = req.body;
    const code = student_id || studentId;
    const fullName = name || ((title || '') + (first_name || '') + ' ' + (last_name || '')).trim();
    if (!code || !fullName) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อ' });
    const groupName = section ? (level || 'ปวช.') + year + '/' + section : 'ปวช.2/1';
    const result = await pool.query(
      "INSERT INTO students (student_code, name, group_name, education_level) VALUES ($1, $2, $3, $4) ON CONFLICT (student_code) DO NOTHING RETURNING id",
      [code, fullName, groupName, level || 'ปวช.']
    );
    if (result.rows.length === 0) return res.status(409).json({ error: 'รหัสนักเรียนซ้ำ' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:id', async (req, res) => {
  try {
    await pool.query("UPDATE schedules SET is_active = FALSE WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/students', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, student_code, name, group_name, education_level, line_user_id FROM students WHERE is_active = TRUE ORDER BY student_code");
    res.json(result.rows.map(r => {
      const nameParts = (r.name || '').split(' ');
      const title = nameParts[0] && (nameParts[0].startsWith('นาย') || nameParts[0].startsWith('นาง')) ? nameParts[0] : '';
      const firstName = title ? nameParts.slice(1, -1).join(' ') || nameParts[1] || '' : nameParts[0] || '';
      const lastName = nameParts[nameParts.length - 1] || '';
      return {
        id: r.id,
        student_id: r.student_code,
        studentId: r.student_code,
        name: r.name,
        title: title,
        first_name: firstName,
        last_name: lastName,
        level: r.education_level || 'ปวช.',
        year: '2',
        section: r.group_name,
        department: 'การบัญชี',
        line_user_id: r.line_user_id || '',
        lineUserId: r.line_user_id || ''
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/students', async (req, res) => {
  try {
    const { studentId, name, section } = req.body;
    if (!studentId || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อ' });
    const result = await pool.query("INSERT INTO students (student_code, name, group_name, education_level) VALUES ($1, $2, $3, 'ปวช.') ON CONFLICT (student_code) DO NOTHING RETURNING id", [studentId, name, section || 'ปวช.2/1']);
    if (result.rows.length === 0) return res.status(409).json({ error: 'รหัสซ้ำ' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/students/:id', async (req, res) => {
  try {
    await pool.query("UPDATE students SET is_active = FALSE WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/attendance', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT ar.id, st.student_code, st.name, st.group_name, ar.check_type, ar.status, ar.checked_at, ar.face_confidence, sub.subject_name
       FROM attendance_records ar JOIN students st ON ar.student_id = st.id
       JOIN qr_sessions qs ON ar.qr_session_id = qs.id JOIN subjects sub ON qs.subject_id = sub.id
       WHERE DATE(ar.checked_at) = $1 ORDER BY ar.checked_at DESC`, [date]
    );
    res.json(result.rows.map(r => ({
      id: r.id, studentId: r.student_code, name: r.name, section: r.group_name, department: 'การบัญชี',
      subject: r.subject_name, status: r.status,
      time: new Date(r.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
      note: r.face_confidence ? `Face: ${Math.round(r.face_confidence)}%` : ''
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send-qr', async (req, res) => {
  try {
    const qrType = req.body.qrType || 'check_in';
    const schedule = await pool.query(
      `SELECT s.id, s.subject_id, s.teacher_id, s.line_group_id, sub.subject_name, c.room_name, lg.line_group_id AS line_gid
       FROM schedules s JOIN subjects sub ON s.subject_id = sub.id JOIN classrooms c ON s.classroom_id = c.id
       LEFT JOIN line_groups lg ON s.line_group_id = lg.id WHERE s.is_active = TRUE LIMIT 1`
    );
    if (schedule.rows.length === 0) return res.status(404).json({ error: 'ไม่มีตารางสอน' });
    const sch = schedule.rows[0];
    if (!sch.line_gid) return res.status(400).json({ error: 'ยังไม่ผูกกลุ่ม' });
    const qr = await createQRSession({ scheduleId: sch.id, subjectId: sch.subject_id, teacherId: sch.teacher_id, lineGroupId: sch.line_group_id, qrType });
    const sentAt = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    await sendQRToGroup(sch.line_gid, { token: qr.token, qrType, subjectName: sch.subject_name, room: sch.room_name, sentAt });
    res.json({ success: true, token: qr.token, sentAt, qrType });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CLASSROOMS (พิกัด GPS) ───

router.get('/classrooms', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, room_name, building, latitude, longitude, allowed_radius_m FROM classrooms WHERE is_active = TRUE ORDER BY room_name");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/classrooms/:id', async (req, res) => {
  try {
    const { room_name, latitude, longitude, allowed_radius_m } = req.body;
    await pool.query(
      "UPDATE classrooms SET room_name = COALESCE($1, room_name), latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude), allowed_radius_m = COALESCE($4, allowed_radius_m) WHERE id = $5",
      [room_name, latitude, longitude, allowed_radius_m, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/classrooms', async (req, res) => {
  try {
    const { room_name, building, latitude, longitude, allowed_radius_m } = req.body;
    const result = await pool.query(
      "INSERT INTO classrooms (room_name, building, latitude, longitude, allowed_radius_m) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [room_name, building || '', latitude, longitude, allowed_radius_m || 100]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { dashboardApiRouter: router };
