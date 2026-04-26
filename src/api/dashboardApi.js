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

// ─── [BUG FIX #1] สถานะเช็คชื่อ 5 แบบ ───
const VALID_STATUSES = ['present', 'late', 'absent', 'sick_leave', 'personal_leave'];
const STATUS_LABELS = {
  present: 'มา', late: 'สาย', absent: 'ขาด',
  sick_leave: 'ลาป่วย', personal_leave: 'ลากิจ'
};

// ═══════════════════════════════════════════════
// SCHEDULES
// ═══════════════════════════════════════════════

router.get('/schedules', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.day_of_week, s.start_period, s.end_period, s.auto_send,
              s.custom_start_time, s.custom_end_time, s.semester, s.academic_year,
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
      start_time: r.custom_start_time || PERIOD_TIMES[r.start_period]?.s || '',
      end_time: r.custom_end_time || PERIOD_TIMES[r.end_period]?.e || '',
      room: r.room_name,
      teacher_name: r.teacher_name || '',
      autoSend: r.auto_send,
      lineGroup: r.group_name,
      semester: r.semester || '',
      academic_year: r.academic_year || ''
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules', async (req, res) => {
  try {
    const { subject_id, classroom_id, line_group_id, teacher_id, day_of_week, start_time, end_time, auto_send, subject_code, subject_name, section, room, teacher_name, semester, academic_year } = req.body;
    const dayIndex = typeof day_of_week === 'number' ? day_of_week : DAYS_TH.indexOf(day_of_week);

    const startP = Object.entries(PERIOD_TIMES).find(([,v]) => v.s === start_time)?.[0] || 1;
    const endP = Object.entries(PERIOD_TIMES).find(([,v]) => v.e === end_time)?.[0] || 2;

    if (dayIndex < 0) {
      return res.status(400).json({ error: 'วันไม่ถูกต้อง' });
    }

    // หา subject_id จาก subject_code (ถ้าไม่ได้ส่ง subject_id มา)
    let subId = subject_id;
    if (!subId && subject_code) {
      const subResult = await pool.query('SELECT id FROM subjects WHERE subject_code = $1', [subject_code]);
      if (subResult.rows.length > 0) {
        subId = subResult.rows[0].id;
      } else if (subject_name) {
        // สร้างวิชาใหม่
        const newSub = await pool.query(
          'INSERT INTO subjects (subject_code, subject_name) VALUES ($1, $2) RETURNING id',
          [subject_code, subject_name]
        );
        subId = newSub.rows[0].id;
      }
    }
    if (!subId) return res.status(400).json({ error: 'ไม่พบรหัสวิชา กรุณาตรวจสอบ' });

    // หา classroom_id จาก room_name (ถ้าไม่ได้ส่ง classroom_id มา)
    let classId = classroom_id;
    if (!classId && room) {
      const classResult = await pool.query('SELECT id FROM classrooms WHERE room_name = $1 AND is_active = TRUE', [room]);
      if (classResult.rows.length > 0) classId = classResult.rows[0].id;
    }
    if (!classId) return res.status(400).json({ error: 'ไม่พบห้องเรียน กรุณาเพิ่มห้องในแท็บพิกัดห้องก่อน' });

    // หา teacher_id จาก teacher_name หรือใช้คนแรก
    let teachId = teacher_id;
    if (!teachId) {
      if (teacher_name) {
        const tResult = await pool.query('SELECT id FROM teachers WHERE name ILIKE $1', [`%${teacher_name}%`]);
        if (tResult.rows.length > 0) teachId = tResult.rows[0].id;
      }
      if (!teachId) {
        const tFirst = await pool.query('SELECT id FROM teachers LIMIT 1');
        if (tFirst.rows.length > 0) teachId = tFirst.rows[0].id;
      }
    }

    // หา line_group_id (ใช้กลุ่มแรกที่มี)
    let lgId = line_group_id;
    if (!lgId) {
      const lgResult = await pool.query('SELECT id FROM line_groups LIMIT 1');
      if (lgResult.rows.length > 0) lgId = lgResult.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO schedules (teacher_id, subject_id, classroom_id, line_group_id, day_of_week, start_period, end_period, custom_start_time, custom_end_time, semester, academic_year, auto_send)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [teachId, subId, classId, lgId, dayIndex, startP, endP, start_time || null, end_time || null, semester || null, academic_year || null, auto_send !== false]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/schedules/:id', async (req, res) => {
  try {
    const { subject_name, subject_code, day_of_week, start_time, end_time, room, section, semester, academic_year } = req.body;
    const dayIndex = DAYS_TH.indexOf(day_of_week);

    // อัปเดตวัน
    if (dayIndex >= 0) {
      await pool.query("UPDATE schedules SET day_of_week = $1 WHERE id = $2", [dayIndex, req.params.id]);
    }

    // อัปเดตเวลา — เก็บตรงๆ ใน custom_start_time / custom_end_time
    if (start_time) {
      const startP = Object.entries(PERIOD_TIMES).find(([,v]) => v.s === start_time)?.[0];
      await pool.query(
        "UPDATE schedules SET custom_start_time = $1, start_period = COALESCE($2, start_period) WHERE id = $3",
        [start_time, startP ? parseInt(startP) : null, req.params.id]
      );
    }
    if (end_time) {
      const endP = Object.entries(PERIOD_TIMES).find(([,v]) => v.e === end_time)?.[0];
      await pool.query(
        "UPDATE schedules SET custom_end_time = $1, end_period = COALESCE($2, end_period) WHERE id = $3",
        [end_time, endP ? parseInt(endP) : null, req.params.id]
      );
    }

    // อัปเดตภาคเรียน / ปีการศึกษา
    if (semester !== undefined || academic_year !== undefined) {
      await pool.query(
        "UPDATE schedules SET semester = COALESCE($1, semester), academic_year = COALESCE($2, academic_year) WHERE id = $3",
        [semester || null, academic_year || null, req.params.id]
      );
    }

    await pool.query("UPDATE schedules SET updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:id', async (req, res) => {
  try {
    await pool.query("UPDATE schedules SET is_active = FALSE WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// STUDENTS
// ═══════════════════════════════════════════════

router.get('/students', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, student_code, name, group_name, education_level, line_user_id FROM students WHERE is_active = TRUE ORDER BY student_code");
    res.json(result.rows.map(r => {
      const fullName = r.name || '';
      let title = '', firstName = '', lastName = '';
      const prefixes = ['นางสาว','นาย','นาง'];
      for (const p of prefixes) {
        if (fullName.startsWith(p)) { title = p; break; }
      }
      const nameOnly = title ? fullName.slice(title.length) : fullName;
      const parts = nameOnly.trim().split(' ');
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '-';
      const grp = r.group_name || 'ปวช.2/1';
      return {
        id: r.id, student_id: r.student_code, title, first_name: firstName, last_name: lastName,
        level: r.education_level || 'ปวช.', year: '2', section: grp, department: 'การบัญชี',
        line_user_id: r.line_user_id || ''
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/students', async (req, res) => {
  try {
    const { student_id, studentId, title, first_name, last_name, name, section, level, year, department } = req.body;
    const code = student_id || studentId;
    const fullName = name || ((title || '') + (first_name || '') + ' ' + (last_name || '')).trim();
    if (!code || !fullName) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อ' });
    const groupName = section ? (level || 'ปวช.') + year + '/' + section : 'ปวช.2/1';

    // ตรวจว่ามีอยู่แล้วหรือไม่ (รวม soft-deleted)
    const existing = await pool.query(
      "SELECT id, is_active FROM students WHERE student_code = $1",
      [code]
    );

    if (existing.rows.length > 0) {
      if (!existing.rows[0].is_active) {
        // เคยถูกลบ → reactivate + อัปเดตข้อมูลใหม่
        await pool.query(
          "UPDATE students SET name = $1, group_name = $2, education_level = $3, is_active = TRUE, updated_at = NOW() WHERE student_code = $4",
          [fullName, groupName, level || 'ปวช.', code]
        );
        return res.json({ success: true, id: existing.rows[0].id, reactivated: true });
      }
      return res.status(409).json({ error: 'รหัสนักเรียนซ้ำ' });
    }

    const result = await pool.query(
      "INSERT INTO students (student_code, name, group_name, education_level) VALUES ($1, $2, $3, $4) RETURNING id",
      [code, fullName, groupName, level || 'ปวช.']
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/students/:id', async (req, res) => {
  try {
    const { title, first_name, last_name, name, section, level } = req.body;
    const fullName = name || ((title || '') + (first_name || '') + ' ' + (last_name || '')).trim();
    await pool.query(
      "UPDATE students SET name = COALESCE($1, name), group_name = COALESCE($2, group_name), education_level = COALESCE($3, education_level), updated_at = NOW() WHERE id = $4",
      [fullName, section, level, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/students/:id', async (req, res) => {
  try {
    await pool.query("UPDATE students SET is_active = FALSE WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// ATTENDANCE  [BUG FIX #1: 5 สถานะ + PUT + Manual]
// ═══════════════════════════════════════════════

// ดึง status labels สำหรับ Dashboard dropdown
router.get('/attendance/statuses', (req, res) => {
  res.json({ statuses: VALID_STATUSES, labels: STATUS_LABELS });
});

router.get('/attendance', async (req, res) => {
  try {
    // ใช้เวลาไทยเป็นหลัก
    const thaiNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const date = req.query.date || thaiNow.toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT ar.id, st.student_code, st.name, st.group_name,
              ar.check_type, ar.status,
              ar.checked_at AT TIME ZONE 'Asia/Bangkok' AS checked_at_th,
              ar.face_confidence,
              ar.remark, ar.is_manual,
              COALESCE(sub1.subject_name, sub2.subject_name) AS subject_name
       FROM attendance_records ar
       JOIN students st ON ar.student_id = st.id
       LEFT JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       LEFT JOIN subjects sub1 ON qs.subject_id = sub1.id
       LEFT JOIN schedules sch ON ar.schedule_id = sch.id
       LEFT JOIN subjects sub2 ON sch.subject_id = sub2.id
       WHERE DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') = $1
       ORDER BY ar.checked_at DESC`, [date]
    );
    res.json(result.rows.map(r => {
      const checkedAt = r.checked_at_th || r.checked_at;
      const timeStr = checkedAt
        ? new Date(checkedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })
        : '-';
      return {
        id: r.id,
        studentId: r.student_code,
        name: r.name,
        section: r.group_name,
        department: 'การบัญชี',
        subject: r.subject_name || '-',
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] || r.status,
        time: timeStr,
        note: r.remark || (r.face_confidence ? `Face: ${Math.round(r.face_confidence)}%` : ''),
        isManual: r.is_manual || false
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] แก้สถานะเช็คชื่อ (ครูแก้ทีหลัง)
router.put('/attendance/:id', async (req, res) => {
  try {
    const { status, remark } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `สถานะไม่ถูกต้อง ต้องเป็น: ${Object.values(STATUS_LABELS).join(', ')}`,
        valid_statuses: VALID_STATUSES,
        labels: STATUS_LABELS
      });
    }

    const result = await pool.query(
      `UPDATE attendance_records
       SET status = $1, remark = COALESCE($2, remark), updated_at = NOW()
       WHERE id = $3 RETURNING id, status`,
      [status, remark || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลเช็คชื่อ' });
    }
    res.json({ success: true, id: result.rows[0].id, status, statusLabel: STATUS_LABELS[status] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] ลบข้อมูลเช็คชื่อ
router.delete('/attendance/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM attendance_records WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลเช็คชื่อ' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] ครูบันทึกมือ (ลาป่วย/ลากิจ โดยไม่ต้องมี QR)
router.post('/attendance/manual', async (req, res) => {
  try {
    const { student_id, schedule_id, status, remark, date } = req.body;

    if (!student_id || !status) {
      return res.status(400).json({ error: 'ต้องระบุ student_id และ status' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `สถานะไม่ถูกต้อง ต้องเป็น: ${Object.values(STATUS_LABELS).join(', ')}`,
        valid_statuses: VALID_STATUSES
      });
    }

    const checkDate = date || new Date().toISOString().slice(0, 10);

    const result = await pool.query(
      `INSERT INTO attendance_records (student_id, schedule_id, status, check_type, remark, checked_at, is_manual)
       VALUES ($1, $2, $3, 'manual', $4, ($5::date + LOCALTIME), TRUE)
       RETURNING id`,
      [student_id, schedule_id || null, status, remark || STATUS_LABELS[status], checkDate]
    );

    res.json({ success: true, id: result.rows[0].id, status, statusLabel: STATUS_LABELS[status] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// SEND QR
// ═══════════════════════════════════════════════

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

// ═══════════════════════════════════════════════
// CLASSROOMS (พิกัด GPS)  [BUG FIX #2: floor INSERT]
// ═══════════════════════════════════════════════

router.get('/classrooms', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, room_name, building, floor, latitude, longitude, allowed_radius_m FROM classrooms WHERE is_active = TRUE ORDER BY room_name");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [BUG FIX #2] เพิ่ม floor ใน INSERT (เดิมไม่มี)
router.post('/classrooms', async (req, res) => {
  try {
    const { room_name, building, floor, latitude, longitude, allowed_radius_m } = req.body;
    const result = await pool.query(
      "INSERT INTO classrooms (room_name, building, floor, latitude, longitude, allowed_radius_m) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [room_name, building || '', floor || null, latitude, longitude, allowed_radius_m || 100]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/classrooms/:id', async (req, res) => {
  try {
    const { room_name, building, floor, latitude, longitude, allowed_radius_m } = req.body;
    await pool.query(
      "UPDATE classrooms SET room_name = COALESCE($1, room_name), building = COALESCE($2, building), floor = $3, latitude = COALESCE($4, latitude), longitude = COALESCE($5, longitude), allowed_radius_m = COALESCE($6, allowed_radius_m) WHERE id = $7",
      [room_name, building, floor, latitude, longitude, allowed_radius_m, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// FACE REGISTRATIONS (ดูสถานะ + ลงทะเบียนโดยครู + ลบ)
// ═══════════════════════════════════════════════

// GET /api/face-registrations — ดึงข้อมูลใบหน้าทั้งหมด
router.get('/face-registrations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fe.student_id, fe.photo_url, fe.created_at
       FROM face_embeddings fe
       WHERE fe.is_active = TRUE
       ORDER BY fe.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/face-register — ครูลงทะเบียนใบหน้าให้นักเรียน (ส่ง photo base64)
router.post('/face-register', async (req, res) => {
  try {
    const { student_id, photo } = req.body;
    if (!student_id || !photo) {
      return res.status(400).json({ error: 'กรุณาเลือกนักเรียนและถ่ายรูป' });
    }

    // ลบ embedding เก่า
    await pool.query(
      'UPDATE face_embeddings SET is_active = FALSE WHERE student_id = $1',
      [student_id]
    );

    // บันทึกใหม่ (ไม่มี embedding เพราะครูถ่ายให้ — นักเรียนจะสร้าง embedding ตอนเปิด LIFF)
    await pool.query(
      `INSERT INTO face_embeddings (student_id, photo_url, is_active, created_at)
       VALUES ($1, $2, TRUE, NOW())`,
      [student_id, photo]
    );

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/face-registrations/:studentId — ลบข้อมูลใบหน้า
router.delete('/face-registrations/:studentId', async (req, res) => {
  try {
    await pool.query(
      'UPDATE face_embeddings SET is_active = FALSE WHERE student_id = $1',
      [req.params.studentId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { dashboardApiRouter: router };
