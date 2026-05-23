// ============================================================
// RMS API — สำหรับ n8n ดึงข้อมูลเช็คชื่อ + ส่งเข้า RMS
// ตำแหน่ง: src/api/rmsApi.js
// ============================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// ============================================================
// 1) GET /api/rms/attendance
//    n8n เรียกเพื่อดึงข้อมูลเช็คชื่อพร้อม mapping RMS
//    Query: date (YYYY-MM-DD, required), schedule_id (optional)
//    Response: จัดกลุ่มตาม section พร้อม RMS form data
// ============================================================
router.get('/attendance', async (req, res) => {
  try {
    const { date, schedule_id } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'กรุณาระบุ date (YYYY-MM-DD)' });
    }

    let query = `
      SELECT 
        ar.id AS attendance_id,
        ar.status,
        ar.checked_at,
        ar.checked_out_at,
        ar.check_type,
        s.id AS student_id,
        s.student_code,
        s.name AS student_name,
        s.group_name,
        sch.id AS schedule_id,
        sch.section,
        sch.semester,
        sch.academic_year,
        sub.id AS subject_id,
        sub.subject_code,
        sub.subject_name,
        t.id AS teacher_id,
        t.name AS teacher_name,
        -- RMS mapping fields
        rsm.rms_student_code,
        rsubm.rms_subject_id,
        rsubm.rms_group_id,
        rsubm.rms_timetable_id,
        rtm.rms_teacher_id
      FROM attendance_records ar
      JOIN students s ON s.id = ar.student_id
      LEFT JOIN qr_sessions qs ON qs.id = ar.qr_session_id
      LEFT JOIN schedules sch ON sch.id = COALESCE(ar.schedule_id, qs.schedule_id)
      LEFT JOIN subjects sub ON sub.id = COALESCE(sch.subject_id, qs.subject_id)
      LEFT JOIN teachers t ON t.id = sch.teacher_id
      LEFT JOIN rms_student_mappings rsm ON rsm.student_id = s.id
      LEFT JOIN rms_subject_mappings rsubm ON rsubm.subject_id = sub.id 
        AND rsubm.section = sch.section
      LEFT JOIN rms_teacher_mappings rtm ON rtm.teacher_id = t.id
      WHERE DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') = $1
    `;

    const params = [date];

    if (schedule_id) {
      query += ` AND COALESCE(ar.schedule_id, qs.schedule_id) = $2`;
      params.push(schedule_id);
    }

    query += ` ORDER BY sch.section, s.student_code`;

    const result = await pool.query(query, params);

    // จัดกลุ่มตาม section สำหรับ n8n
    const grouped = {};
    for (const row of result.rows) {
      const key = row.schedule_id || 'no_schedule';
      if (!grouped[key]) {
        grouped[key] = {
          schedule_id: row.schedule_id,
          section: row.section,
          subject_code: row.subject_code,
          subject_name: row.subject_name,
          teacher_name: row.teacher_name,
          semester: row.semester,
          academic_year: row.academic_year,
          rms_subject_id: row.rms_subject_id,
          rms_group_id: row.rms_group_id,
          rms_timetable_id: row.rms_timetable_id,
          rms_teacher_id: row.rms_teacher_id,
          students: []
        };
      }
      grouped[key].students.push({
        student_code: row.student_code,
        student_name: row.student_name,
        group_name: row.group_name,
        status: row.status,
        checked_at: row.checked_at,
        checked_out_at: row.checked_out_at,
        rms_student_code: row.rms_student_code
      });
    }

    res.json({
      date,
      total_records: result.rows.length,
      sections: Object.values(grouped)
    });

  } catch (err) {
    console.error('❌ RMS attendance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2) GET /api/rms/attendance/rms-form
//    n8n เรียกเพื่อรับ form data พร้อม POST ไป RMS เลย
//    Query: date (YYYY-MM-DD), schedule_id (required)
//    Response: RMS form fields ตาม format ที่ RMS ต้องการ
// ============================================================
router.get('/attendance/rms-form', async (req, res) => {
  try {
    const { date, schedule_id } = req.query;

    if (!date || !schedule_id) {
      return res.status(400).json({ 
        error: 'กรุณาระบุ date (YYYY-MM-DD) และ schedule_id' 
      });
    }

    const result = await pool.query(`
      SELECT 
        ar.status,
        s.student_code,
        sch.section,
        sch.semester,
        sch.academic_year,
        rsm.rms_student_code,
        rsubm.rms_subject_id,
        rsubm.rms_group_id,
        rsubm.rms_timetable_id,
        rtm.rms_teacher_id
      FROM attendance_records ar
      JOIN students s ON s.id = ar.student_id
      LEFT JOIN qr_sessions qs ON qs.id = ar.qr_session_id
      LEFT JOIN schedules sch ON sch.id = COALESCE(ar.schedule_id, qs.schedule_id)
      LEFT JOIN subjects sub ON sub.id = COALESCE(sch.subject_id, qs.subject_id)
      LEFT JOIN teachers t ON t.id = sch.teacher_id
      LEFT JOIN rms_student_mappings rsm ON rsm.student_id = s.id
      LEFT JOIN rms_subject_mappings rsubm ON rsubm.subject_id = sub.id 
        AND rsubm.section = sch.section
      LEFT JOIN rms_teacher_mappings rtm ON rtm.teacher_id = t.id
      WHERE DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') = $1
        AND COALESCE(ar.schedule_id, qs.schedule_id) = $2
      ORDER BY s.student_code
    `, [date, schedule_id]);

    if (result.rows.length === 0) {
      return res.json({ error: 'ไม่พบข้อมูลเช็คชื่อ', form_data: null });
    }

    const first = result.rows[0];

    // ตรวจสอบว่ามี mapping ครบหรือไม่
    const missingMappings = [];
    if (!first.rms_subject_id) missingMappings.push('rms_subject_id');
    if (!first.rms_group_id) missingMappings.push('rms_group_id');
    if (!first.rms_timetable_id) missingMappings.push('rms_timetable_id');
    if (!first.rms_teacher_id) missingMappings.push('rms_teacher_id');

    const studentsMissingMapping = result.rows
      .filter(r => !r.rms_student_code)
      .map(r => r.student_code);

    if (missingMappings.length > 0 || studentsMissingMapping.length > 0) {
      return res.json({
        error: 'ข้อมูล mapping ไม่ครบ',
        missing_schedule_mappings: missingMappings,
        students_missing_rms_code: studentsMissingMapping,
        form_data: null
      });
    }

    // สร้าง semester format: "2/2568"
    const semesStr = `${first.semester}/${first.academic_year}`;

    // คำนวณ weekno
    const dateObj = new Date(date + 'T00:00:00+07:00');
    const startOfYear = new Date(`${first.academic_year}-05-15T00:00:00+07:00`);
    const weekno = Math.max(1, Math.ceil((dateObj - startOfYear) / (7 * 24 * 60 * 60 * 1000)));

    // Status mapping: KVC Bot → RMS
    const statusMap = {
      'present': '0',
      'absent': '1',
      'personal_leave': '2',
      'sick_leave': '3',
      'late': '4'
    };

    // สร้าง form data ตาม RMS format
    const formData = {};
    result.rows.forEach((row, idx) => {
      const n = idx + 1;
      formData[`I${n}`] = row.rms_student_code;
      formData[`S${n}`] = statusMap[row.status] || '0';
      formData[`T${n}`] = '';
      formData[`CHcid${n}`] = '1';
      formData[`CHcm${n}`] = '';
      formData[`BB${n}`] = String(n);
    });

    // form data ท้ายฟอร์ม
    formData['subject_id'] = first.rms_subject_id;
    formData['student_group_id'] = first.rms_group_id;
    formData['semes'] = semesStr;
    formData['date_check'] = date;
    formData['teacher_id'] = first.rms_teacher_id;
    formData['timeTableID'] = first.rms_timetable_id;
    formData['weekno'] = String(weekno);
    formData['countno'] = String(result.rows.length);
    formData['max_std_howto'] = '7';
    formData['Submit'] = 'oy';

    res.json({
      date,
      schedule_id,
      section: first.section,
      student_count: result.rows.length,
      rms_post_url: 'http://rms.kanvc.ac.th/index.php?p=chk_home&sp=edit&xsp=save',
      form_data: formData
    });

  } catch (err) {
    console.error('❌ RMS form error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3) GET /api/rms/schedules
//    n8n เรียกเพื่อดูว่าวันนี้มี schedule ไหนบ้าง
//    Query: date (YYYY-MM-DD)
// ============================================================
router.get('/schedules', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'กรุณาระบุ date (YYYY-MM-DD)' });
    }

    const dateObj = new Date(date + 'T00:00:00+07:00');
    const dayOfWeek = dateObj.getDay();

    const result = await pool.query(`
      SELECT 
        sch.id AS schedule_id,
        sch.section,
        sch.day_of_week,
        sch.custom_start_time,
        sch.custom_end_time,
        sub.subject_code,
        sub.subject_name,
        t.name AS teacher_name,
        rsubm.rms_subject_id,
        rsubm.rms_group_id,
        rsubm.rms_timetable_id
      FROM schedules sch
      LEFT JOIN subjects sub ON sub.id = sch.subject_id
      LEFT JOIN teachers t ON t.id = sch.teacher_id
      LEFT JOIN rms_subject_mappings rsubm ON rsubm.subject_id = sub.id 
        AND rsubm.section = sch.section
      WHERE sch.day_of_week = $1
      ORDER BY sch.custom_start_time, sch.section
    `, [dayOfWeek]);

    res.json({
      date,
      day_of_week: dayOfWeek,
      total_schedules: result.rows.length,
      schedules: result.rows
    });

  } catch (err) {
    console.error('❌ RMS schedules error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4) GET /api/rms/mapping-status
//    ตรวจสอบว่า mapping ครบหรือยัง
// ============================================================
router.get('/mapping-status', async (req, res) => {
  try {
    const students = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(rsm.id) AS mapped
      FROM students s
      LEFT JOIN rms_student_mappings rsm ON rsm.student_id = s.id
    `);

    const subjects = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(rsubm.id) AS mapped
      FROM subjects sub
      LEFT JOIN rms_subject_mappings rsubm ON rsubm.subject_id = sub.id
    `);

    const teachers = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(rtm.id) AS mapped
      FROM teachers t
      LEFT JOIN rms_teacher_mappings rtm ON rtm.teacher_id = t.id
    `);

    res.json({
      students: {
        total: parseInt(students.rows[0].total),
        mapped: parseInt(students.rows[0].mapped),
        unmapped: parseInt(students.rows[0].total) - parseInt(students.rows[0].mapped)
      },
      subjects: {
        total: parseInt(subjects.rows[0].total),
        mapped: parseInt(subjects.rows[0].mapped),
        unmapped: parseInt(subjects.rows[0].total) - parseInt(subjects.rows[0].mapped)
      },
      teachers: {
        total: parseInt(teachers.rows[0].total),
        mapped: parseInt(teachers.rows[0].mapped),
        unmapped: parseInt(teachers.rows[0].total) - parseInt(teachers.rows[0].mapped)
      }
    });

  } catch (err) {
    console.error('❌ Mapping status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 5) POST /api/rms/mapping/students — bulk import mapping นักเรียน
//    Body: { mappings: [{ student_code, rms_student_code }, ...] }
// ============================================================
router.post('/mapping/students', async (req, res) => {
  try {
    const { mappings } = req.body;
    if (!mappings || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'กรุณาส่ง mappings เป็น array' });
    }

    let inserted = 0;
    const errors = [];

    for (const m of mappings) {
      try {
        await pool.query(`
          INSERT INTO rms_student_mappings (student_id, rms_student_code)
          SELECT id, $2 FROM students WHERE student_code = $1
          ON CONFLICT (student_id) DO UPDATE SET rms_student_code = $2
        `, [m.student_code, m.rms_student_code]);
        inserted++;
      } catch (err) {
        errors.push({ student_code: m.student_code, error: err.message });
      }
    }

    res.json({ inserted, errors });
  } catch (err) {
    console.error('❌ Student mapping error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 6) POST /api/rms/mapping/subjects — bulk import mapping วิชา
//    Body: { mappings: [{ subject_code, section, rms_subject_id, rms_group_id, rms_timetable_id }, ...] }
// ============================================================
router.post('/mapping/subjects', async (req, res) => {
  try {
    const { mappings } = req.body;
    if (!mappings || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'กรุณาส่ง mappings เป็น array' });
    }

    let inserted = 0;
    const errors = [];

    for (const m of mappings) {
      try {
        await pool.query(`
          INSERT INTO rms_subject_mappings (subject_id, section, rms_subject_id, rms_group_id, rms_timetable_id)
          SELECT id, $2, $3, $4, $5 FROM subjects WHERE subject_code = $1
          ON CONFLICT (subject_id, section) DO UPDATE SET 
            rms_subject_id = $3, rms_group_id = $4, rms_timetable_id = $5
        `, [m.subject_code, m.section, m.rms_subject_id, m.rms_group_id, m.rms_timetable_id]);
        inserted++;
      } catch (err) {
        errors.push({ subject_code: m.subject_code, error: err.message });
      }
    }

    res.json({ inserted, errors });
  } catch (err) {
    console.error('❌ Subject mapping error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 7) POST /api/rms/mapping/teachers — bulk import mapping ครู
//    Body: { mappings: [{ teacher_name, rms_teacher_id }, ...] }
// ============================================================
router.post('/mapping/teachers', async (req, res) => {
  try {
    const { mappings } = req.body;
    if (!mappings || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'กรุณาส่ง mappings เป็น array' });
    }

    let inserted = 0;
    const errors = [];

    for (const m of mappings) {
      try {
        await pool.query(`
          INSERT INTO rms_teacher_mappings (teacher_id, rms_teacher_id)
          SELECT id, $2 FROM teachers WHERE name = $1
          ON CONFLICT (teacher_id) DO UPDATE SET rms_teacher_id = $2
        `, [m.teacher_name, m.rms_teacher_id]);
        inserted++;
      } catch (err) {
        errors.push({ teacher_name: m.teacher_name, error: err.message });
      }
    }

    res.json({ inserted, errors });
  } catch (err) {
    console.error('❌ Teacher mapping error:', err);
    res.status(500).json({ error: err.message });
  }
});

const rmsApiRouter = router;
module.exports = { rmsApiRouter };
