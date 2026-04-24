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
              sub.subject_name AS subject, c.room_name AS room, lg.group_name AS line_group
       FROM schedules s JOIN subjects sub ON s.subject_id = sub.id
       JOIN classrooms c ON s.classroom_id = c.id LEFT JOIN line_groups lg ON s.line_group_id = lg.id
       WHERE s.is_active = TRUE ORDER BY s.day_of_week, s.start_period`
    );
    res.json(result.rows.map(r => ({
      id: r.id, subject: r.subject, section: 'ปวช.2/1', day: DAYS_TH[r.day_of_week],
      timeStart: PERIOD_TIMES[r.start_period]?.s || '', timeEnd: PERIOD_TIMES[r.end_period]?.e || '',
      room: r.room, autoSend: r.auto_send, lineGroup: r.line_group
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules', async (req, res) => {
  try {
    const { subject, day, timeStart, timeEnd, room } = req.body;
    const dayIndex = DAYS_TH.indexOf(day);
    const startP = Object.entries(PERIOD_TIMES).find(([,v]) => v.s === timeStart)?.[0] || 1;
    const endP = Object.entries(PERIOD_TIMES).find(([,v]) => v.e === timeEnd)?.[0] || startP;
    const teacher = await pool.query("SELECT id FROM teachers LIMIT 1");
    const classroom = await pool.query("SELECT id FROM classrooms LIMIT 1");
    const lineGroup = await pool.query("SELECT id FROM line_groups WHERE is_active = TRUE LIMIT 1");
    let subj = await pool.query("SELECT id FROM subjects WHERE subject_name = $1", [subject]);
    if (subj.rows.length === 0) {
      subj = await pool.query("INSERT INTO subjects (subject_code, subject_name, teacher_id) VALUES ($1, $2, $3) RETURNING id",
        ['NEW-' + Date.now(), subject, teacher.rows[0]?.id]);
    }
    const result = await pool.query(
      "INSERT INTO schedules (subject_id, teacher_id, classroom_id, line_group_id, day_of_week, start_period, end_period, auto_send, send_minutes_before) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,5) RETURNING id",
      [subj.rows[0].id, teacher.rows[0]?.id, classroom.rows[0]?.id, lineGroup.rows[0]?.id, dayIndex, startP, endP]
    );
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
    const result = await pool.query("SELECT id, student_code, name, group_name, line_user_id FROM students WHERE is_active = TRUE ORDER BY student_code");
    res.json(result.rows.map(r => ({ id: r.id, studentId: r.student_code, name: r.name, section: r.group_name, department: 'การบัญชี', lineUserId: r.line_user_id || '' })));
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
