// ============================================================
// LIFF API - REST endpoints สำหรับ LIFF App (หน้าเช็คชื่อนักเรียน)
// ============================================================

const express = require('express');
const { pool } = require('../config/database');
const { validateQRToken } = require('../services/qrService');
const { sendCheckInConfirmation, notifyTeacher } = require('../services/lineService');
const { isWithinRadius } = require('../utils/gps');

const router = express.Router();

// ============================================================
// POST /api/liff/register - ลงทะเบียนนักเรียน (ผูก LINE User ID)
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const { lineUserId, studentCode } = req.body;

    if (!lineUserId || !studentCode) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสนักศึกษา' });
    }

    // ค้นหานักเรียนจากรหัส
    const student = await pool.query(
      'SELECT id, name, group_name FROM students WHERE student_code = $1',
      [studentCode]
    );

    if (student.rows.length === 0) {
      return res.status(404).json({ error: `ไม่พบรหัส ${studentCode} ในระบบ กรุณาติดต่อครูเพื่อเพิ่มรหัสก่อน` });
    }

    // ลบ line_user_id เก่าจากนักเรียนคนอื่น (ถ้ามี)
    await pool.query(
      'UPDATE students SET line_user_id = NULL WHERE line_user_id = $1 AND student_code != $2',
      [lineUserId, studentCode]
    );

    // อัปเดต LINE User ID
    await pool.query(
      'UPDATE students SET line_user_id = $1, updated_at = NOW() WHERE student_code = $2',
      [lineUserId, studentCode]
    );

    res.json({
      success: true,
      student: {
        id: student.rows[0].id,
        name: student.rows[0].name,
        group: student.rows[0].group_name,
        studentCode
      }
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'ลงทะเบียนไม่สำเร็จ: ' + err.message });
  }
});

// ============================================================
// GET /api/liff/profile/:lineUserId - ดึงข้อมูลนักเรียน
// ============================================================
router.get('/profile/:lineUserId', async (req, res) => {
  try {
    const { lineUserId } = req.params;

    const student = await pool.query(
      `SELECT id, student_code, name, group_name, education_level
       FROM students WHERE line_user_id = $1 AND is_active = TRUE`,
      [lineUserId]
    );

    if (student.rows.length === 0) {
      return res.status(404).json({ registered: false });
    }

    // ตรวจว่าลงทะเบียนใบหน้าแล้วหรือยัง
    const faceCheck = await pool.query(
      'SELECT id FROM face_embeddings WHERE student_id = $1 AND is_active = TRUE LIMIT 1',
      [student.rows[0].id]
    );

    res.json({
      registered: true,
      student: student.rows[0],
      faceRegistered: faceCheck.rows.length > 0
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ============================================================
// POST /api/liff/validate-qr - ตรวจสอบ QR Token
// ============================================================
router.post('/validate-qr', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ valid: false, error: 'ไม่มี token' });
    }

    const result = await validateQRToken(token);

    // ถ้า valid → ดึงพิกัดห้องเรียนจาก schedule เพิ่มให้ LIFF ใช้ตรวจ GPS
    if (result.valid && result.session?.schedule_id) {
      const crResult = await pool.query(
        `SELECT c.latitude, c.longitude, c.allowed_radius_m
         FROM schedules s
         JOIN classrooms c ON s.classroom_id = c.id
         WHERE s.id = $1`,
        [result.session.schedule_id]
      );
      if (crResult.rows.length > 0) {
        result.session.classroom = {
          latitude: parseFloat(crResult.rows[0].latitude),
          longitude: parseFloat(crResult.rows[0].longitude),
          allowed_radius_m: parseFloat(crResult.rows[0].allowed_radius_m) || 100
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Validate QR error:', err);
    res.status(500).json({ valid: false, error: 'เกิดข้อผิดพลาด' });
  }
});

// ============================================================
// POST /api/liff/check-in - บันทึกการเช็คชื่อ
// ============================================================
router.post('/check-in', async (req, res) => {
  try {
    const {
      lineUserId,
      token,
      studentLat,
      studentLng,
      faceVerified,
      faceConfidence
    } = req.body;

    // ---- 1. ตรวจสอบนักเรียน ----
    const studentResult = await pool.query(
      'SELECT id, name, student_code FROM students WHERE line_user_id = $1',
      [lineUserId]
    );
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลนักเรียน กรุณาลงทะเบียนก่อน' });
    }
    const student = studentResult.rows[0];

    // ---- 2. ตรวจสอบ QR Token ----
    const qrResult = await validateQRToken(token);
    if (!qrResult.valid) {
      return res.status(400).json({ success: false, error: qrResult.error });
    }
    const session = qrResult.session;

    // ---- 3. ตรวจสอบว่าเช็คชื่อซ้ำหรือไม่ ----
    const duplicate = await pool.query(
      'SELECT id FROM attendance_records WHERE student_id = $1 AND qr_session_id = $2',
      [student.id, session.id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'คุณเช็คชื่อไปแล้ว' });
    }

    // ---- 3.5 Check-out: หา record check-in ของวันนี้แล้ว UPDATE ----
    let isCheckOut = false;
    let existingRecord = null;
    if (session.qr_type === 'check_out') {
      // หา attendance record ที่เช็คชื่อเข้าเรียนของวิชานี้ วันนี้
      const todayRecords = await pool.query(
        `SELECT ar.id, ar.checked_out_at
         FROM attendance_records ar
         JOIN qr_sessions qs ON ar.qr_session_id = qs.id
         WHERE ar.student_id = $1
           AND qs.subject_id = $2
           AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
           AND ar.check_type = 'check_in'
         ORDER BY ar.checked_at DESC
         LIMIT 1`,
        [student.id, session.subject_id]
      );

      if (todayRecords.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'ไม่พบข้อมูลเช็คชื่อเข้าเรียนของวิชานี้วันนี้ กรุณาเช็คชื่อเข้าเรียนก่อน' });
      }

      if (todayRecords.rows[0].checked_out_at) {
        return res.status(409).json({ success: false, error: 'คุณเช็คชื่อออกเรียนไปแล้ว' });
      }

      isCheckOut = true;
      existingRecord = todayRecords.rows[0];
    }

    // ---- 4. ตรวจสอบ Face Verification ----
    if (!faceVerified) {
      return res.status(400).json({ success: false, error: 'กรุณายืนยันตัวตนด้วยใบหน้า' });
    }

    // ---- 5. ตรวจสอบพิกัด GPS ----
    // ดึงพิกัดห้องเรียนจาก schedule
    const classroomResult = await pool.query(
      `SELECT c.latitude, c.longitude, c.allowed_radius_m
       FROM schedules s
       JOIN classrooms c ON s.classroom_id = c.id
       WHERE s.id = $1`,
      [session.schedule_id]
    );

    let distanceMeters = null;
    let gpsStatus = 'unknown';

    if (classroomResult.rows.length > 0 && studentLat && studentLng) {
      const classroom = classroomResult.rows[0];
      const gpsCheck = isWithinRadius(
        studentLat, studentLng,
        classroom.latitude, classroom.longitude,
        classroom.allowed_radius_m
      );
      distanceMeters = gpsCheck.distance;

      if (!gpsCheck.withinRadius) {
        return res.status(400).json({
          success: false,
          error: `คุณอยู่ห่างจากห้องเรียน ${Math.round(distanceMeters)} เมตร (เกิน ${classroom.allowed_radius_m} เมตร)`
        });
      }
      gpsStatus = 'pass';
    }

    // ---- 6. กำหนดสถานะ (มา / สาย) ----
    let status = 'present';
    if (session.schedule_id) {
      const periodResult = await pool.query(
        `SELECT pt.start_time
         FROM schedules s
         JOIN period_times pt ON s.start_period = pt.period_number
         WHERE s.id = $1`,
        [session.schedule_id]
      );
      if (periodResult.rows.length > 0 && session.qr_type === 'check_in') {
        const startTime = periodResult.rows[0].start_time;
        const now = new Date();
        const [h, m] = startTime.split(':').map(Number);
        const classStart = new Date(now);
        classStart.setHours(h, m + 15, 0); // สายหลัง 15 นาที
        if (now > classStart) {
          status = 'late';
        }
      }
    }

    // ---- 7. บันทึกการเช็คชื่อ ----
    const checkedAt = new Date();
    let record;
    let attendanceSummary = null; // สรุปชั่วโมงเรียน (เฉพาะ check-out)

    if (isCheckOut && existingRecord) {
      // === CHECK-OUT: UPDATE record เดิม ===
      record = await pool.query(
        `UPDATE attendance_records 
         SET checked_out_at = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [checkedAt, existingRecord.id]
      );

      // === คำนวณชั่วโมงเรียนจริง vs ตามตาราง ===
      try {
        // ดึงเวลาตามตาราง
        const schedResult = await pool.query(
          `SELECT s.custom_start_time, s.custom_end_time,
                  pt_start.start_time AS period_start,
                  pt_end.end_time AS period_end
           FROM schedules s
           LEFT JOIN period_times pt_start ON s.start_period = pt_start.period_number
           LEFT JOIN period_times pt_end ON s.end_period = pt_end.period_number
           WHERE s.id = $1`,
          [session.schedule_id]
        );

        if (schedResult.rows.length > 0) {
          const sched = schedResult.rows[0];
          const schedStart = sched.custom_start_time || sched.period_start;
          const schedEnd = sched.custom_end_time || sched.period_end;

          if (schedStart && schedEnd) {
            // เวลาตามตาราง (นาที)
            const [sh, sm] = schedStart.split(':').map(Number);
            const [eh, em] = schedEnd.split(':').map(Number);
            const scheduledMinutes = (eh * 60 + em) - (sh * 60 + sm);

            // เวลาจริงจาก check-in ถึง check-out (นาที)
            const checkInTime = new Date(record.rows[0].checked_at);
            const checkOutTime = checkedAt;
            const actualMinutes = Math.round((checkOutTime - checkInTime) / 60000);

            // คำนวณเปอร์เซ็นต์
            const percent = Math.min(100, Math.round((actualMinutes / scheduledMinutes) * 100));
            const passed = percent >= 80;

            // แปลงเป็นชั่วโมง:นาที
            const schedHours = Math.floor(scheduledMinutes / 60);
            const schedMins = scheduledMinutes % 60;
            const actualHours = Math.floor(actualMinutes / 60);
            const actualMins = actualMinutes % 60;

            attendanceSummary = {
              scheduledTime: `${schedHours} ชม.${schedMins > 0 ? ` ${schedMins} น.` : ''}`,
              scheduledMinutes,
              actualTime: `${actualHours} ชม.${actualMins > 0 ? ` ${actualMins} น.` : ''}`,
              actualMinutes,
              percent,
              passed,
              checkInAt: checkInTime.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
              checkOutAt: checkOutTime.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
            };
          }
        }
      } catch (calcErr) {
        console.warn('Attendance duration calc error:', calcErr.message);
      }

    } else {
      // === CHECK-IN: INSERT record ใหม่ (เหมือนเดิม) ===
      record = await pool.query(
        `INSERT INTO attendance_records 
          (student_id, qr_session_id, check_type, student_lat, student_lng, 
           distance_meters, face_verified, face_confidence, status, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          student.id, session.id, session.qr_type,
          studentLat, studentLng, distanceMeters,
          faceVerified, faceConfidence || null,
          status, checkedAt
        ]
      );
    }

    // ---- 8. ส่งข้อความยืนยัน ----
    const checkedAtStr = checkedAt.toLocaleTimeString('th-TH', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // ส่งยืนยันให้นักเรียน
    await sendCheckInConfirmation(lineUserId, {
      studentName: student.name,
      subjectName: session.subject_name,
      checkType: session.qr_type,
      checkedAt: checkedAtStr,
      attendanceSummary  // ส่งสรุปชั่วโมงเรียนด้วย (ถ้า check-out)
    });

    // แจ้งครูผู้สอน
    const teacherResult = await pool.query(
      'SELECT line_user_id FROM teachers WHERE id = $1',
      [session.teacher_id]
    );
    if (teacherResult.rows.length > 0 && teacherResult.rows[0].line_user_id) {
      await notifyTeacher(teacherResult.rows[0].line_user_id, {
        studentName: student.name,
        subjectName: session.subject_name,
        checkType: session.qr_type,
        status,
        attendanceSummary
      });
    }

    // ---- 9. บันทึก Log ----
    await pool.query(
      `INSERT INTO system_logs (event_type, event_data, student_id)
       VALUES ($1, $2, $3)`,
      [
        isCheckOut ? 'checkout_success' : 'checkin_success',
        JSON.stringify({
          check_type: session.qr_type,
          subject: session.subject_name,
          token: session.token,
          status,
          distance_m: distanceMeters,
          face_confidence: faceConfidence,
          ...(attendanceSummary ? { attendance: attendanceSummary } : {})
        }),
        student.id
      ]
    );

    // ---- 10. ส่งผลลัพธ์ ----
    res.json({
      success: true,
      record: {
        id: record.rows[0].id,
        checkType: session.qr_type,
        status,
        subjectName: session.subject_name,
        checkedAt: checkedAtStr,
        distanceMeters: distanceMeters ? Math.round(distanceMeters) : null,
        faceConfidence,
        attendanceSummary  // ส่งให้ LIFF แสดงผล
      }
    });

  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  }
});

// ============================================================
// GET /api/liff/today-status/:lineUserId - สถานะวันนี้ของนักเรียน
// ============================================================
router.get('/today-status/:lineUserId', async (req, res) => {
  try {
    const { lineUserId } = req.params;

    const student = await pool.query(
      'SELECT id FROM students WHERE line_user_id = $1',
      [lineUserId]
    );
    if (student.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบนักเรียน' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const records = await pool.query(
      `SELECT ar.check_type, ar.status, ar.checked_at, ar.distance_meters,
              ar.face_confidence, s.subject_name, s.subject_code
       FROM attendance_records ar
       JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       JOIN subjects s ON qs.subject_id = s.id
       WHERE ar.student_id = $1 AND DATE(ar.checked_at) = $2
       ORDER BY ar.checked_at`,
      [student.rows[0].id, today]
    );

    res.json({ records: records.rows });
  } catch (err) {
    console.error('Today status error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ============================================================
// Teacher API endpoints
// ============================================================

// GET /api/liff/teacher/schedules/:lineUserId - ดึงตารางสอนของครู
router.get('/teacher/schedules/:lineUserId', async (req, res) => {
  try {
    const teacher = await pool.query(
      'SELECT id FROM teachers WHERE line_user_id = $1',
      [req.params.lineUserId]
    );
    if (teacher.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบครูผู้สอน' });
    }

    const schedules = await pool.query(
      `SELECT s.*, sub.subject_name, sub.subject_code,
              c.room_name, lg.group_name AS line_group_name,
              pt_start.start_time, pt_end.end_time
       FROM schedules s
       JOIN subjects sub ON s.subject_id = sub.id
       JOIN classrooms c ON s.classroom_id = c.id
       LEFT JOIN line_groups lg ON s.line_group_id = lg.id
       JOIN period_times pt_start ON s.start_period = pt_start.period_number
       JOIN period_times pt_end ON s.end_period = pt_end.period_number
       WHERE s.teacher_id = $1 AND s.is_active = TRUE
       ORDER BY s.day_of_week, s.start_period`,
      [teacher.rows[0].id]
    );

    res.json({ schedules: schedules.rows });
  } catch (err) {
    console.error('Teacher schedules error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/liff/teacher/attendance/:subjectId?date=YYYY-MM-DD
router.get('/teacher/attendance/:subjectId', async (req, res) => {
  try {
    const { subjectId } = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const records = await pool.query(
      `SELECT st.student_code, st.name, st.group_name,
              ar.check_type, ar.status, ar.checked_at,
              ar.distance_meters, ar.face_confidence
       FROM attendance_records ar
       JOIN students st ON ar.student_id = st.id
       JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       WHERE qs.subject_id = $1 AND DATE(ar.checked_at) = $2
       ORDER BY st.student_code, ar.check_type`,
      [subjectId, date]
    );

    res.json({ date, records: records.rows });
  } catch (err) {
    console.error('Teacher attendance error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/liff/teacher/manual-qr - ครูส่ง QR ด้วยมือ
router.post('/teacher/manual-qr', async (req, res) => {
  try {
    const { lineUserId, scheduleId, qrType } = req.body;

    const teacher = await pool.query(
      'SELECT id FROM teachers WHERE line_user_id = $1',
      [lineUserId]
    );
    if (teacher.rows.length === 0) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
    }

    const schedule = await pool.query(
      `SELECT s.*, sub.subject_name, c.room_name, lg.line_group_id AS line_gid
       FROM schedules s
       JOIN subjects sub ON s.subject_id = sub.id
       JOIN classrooms c ON s.classroom_id = c.id
       LEFT JOIN line_groups lg ON s.line_group_id = lg.id
       WHERE s.id = $1 AND s.teacher_id = $2`,
      [scheduleId, teacher.rows[0].id]
    );

    if (schedule.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบตารางสอน' });
    }

    const sch = schedule.rows[0];
    if (!sch.line_gid) {
      return res.status(400).json({ error: 'ยังไม่ได้ผูกไลน์กลุ่ม' });
    }

    const { createQRSession, expirePreviousSessions } = require('../services/qrService');
    const { sendQRToGroup } = require('../services/lineService');
    const today = new Date().toISOString().slice(0, 10);

    await expirePreviousSessions(scheduleId, qrType, today);

    const qrSession = await createQRSession({
      scheduleId: sch.id,
      subjectId: sch.subject_id,
      teacherId: teacher.rows[0].id,
      lineGroupId: sch.line_group_id,
      qrType
    });

    const sentAt = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    await sendQRToGroup(sch.line_gid, {
      token: qrSession.token,
      qrType,
      subjectName: sch.subject_name,
      room: sch.room_name,
      sentAt
    });

    res.json({ success: true, token: qrSession.token, sentAt });
  } catch (err) {
    console.error('Manual QR error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ============================================================
// POST /api/liff/leave-request - แจ้งลาป่วย/ลากิจ ผ่าน LIFF
// ============================================================
router.post('/leave-request', async (req, res) => {
  try {
    const { lineUserId, token, leaveType, leaveImage, remark } = req.body;

    // ---- 1. Validate input ----
    if (!lineUserId || !token || !leaveType) {
      return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบ' });
    }

    const validLeaveTypes = ['sick_leave', 'personal_leave'];
    if (!validLeaveTypes.includes(leaveType)) {
      return res.status(400).json({ success: false, error: 'ประเภทการลาไม่ถูกต้อง' });
    }

    if (!leaveImage) {
      return res.status(400).json({
        success: false,
        error: leaveType === 'sick_leave'
          ? 'กรุณาแนบรูปแชตแจ้งครูที่ปรึกษา'
          : 'กรุณาแนบรูปใบลากิจ'
      });
    }

    // ---- 2. ตรวจสอบนักเรียน ----
    const studentResult = await pool.query(
      'SELECT id, name, student_code FROM students WHERE line_user_id = $1',
      [lineUserId]
    );
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลนักเรียน กรุณาลงทะเบียนก่อน' });
    }
    const student = studentResult.rows[0];

    // ---- 3. ตรวจสอบ QR Token ----
    const qrResult = await validateQRToken(token);
    if (!qrResult.valid) {
      return res.status(400).json({ success: false, error: qrResult.error });
    }
    const session = qrResult.session;

    // ---- 4. ตรวจสอบว่าแจ้งลาซ้ำหรือไม่ ----
    const duplicate = await pool.query(
      'SELECT id FROM attendance_records WHERE student_id = $1 AND qr_session_id = $2',
      [student.id, session.id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'คุณเช็คชื่อ/แจ้งลาไปแล้ว' });
    }

    // ---- 5. บันทึกการลา ----
    const leaveLabel = leaveType === 'sick_leave' ? 'ลาป่วย' : 'ลากิจ';
    const checkedAt = new Date();
    const checkedAtStr = checkedAt.toLocaleTimeString('th-TH', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const record = await pool.query(
      `INSERT INTO attendance_records
        (student_id, qr_session_id, check_type, status, remark, leave_image, is_manual, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
       RETURNING id`,
      [
        student.id, session.id, session.qr_type,
        leaveType,
        remark || leaveLabel,
        leaveImage,  // เก็บ base64 image ใน DB (หรือจะเปลี่ยนเป็น upload file storage ทีหลัง)
        checkedAt
      ]
    );

    // ---- 6. แจ้งครูผู้สอน ----
    const teacherResult = await pool.query(
      'SELECT line_user_id FROM teachers WHERE id = $1',
      [session.teacher_id]
    );
    if (teacherResult.rows.length > 0 && teacherResult.rows[0].line_user_id) {
      try {
        await notifyTeacher(teacherResult.rows[0].line_user_id, {
          studentName: student.name,
          subjectName: session.subject_name,
          checkType: 'leave',
          status: leaveType,
          remark: remark || ''
        });
      } catch (notifyErr) {
        console.warn('Notify teacher failed:', notifyErr.message);
      }
    }

    // ---- 7. บันทึก Log ----
    await pool.query(
      `INSERT INTO system_logs (event_type, event_data, student_id)
       VALUES ('leave_request', $1, $2)`,
      [
        JSON.stringify({
          leave_type: leaveType,
          subject: session.subject_name,
          token: session.token,
          remark: remark || '',
          has_image: !!leaveImage
        }),
        student.id
      ]
    );

    // ---- 8. ส่งผลลัพธ์ ----
    res.json({
      success: true,
      record: {
        id: record.rows[0].id,
        checkType: session.qr_type,
        status: leaveType,
        subjectName: session.subject_name,
        checkedAt: checkedAtStr,
        leaveType,
        leaveLabel
      }
    });

  } catch (err) {
    console.error('Leave request error:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  }
});

// ============================================================
// POST /api/liff/face/register - ลงทะเบียนใบหน้า (เก็บ embedding)
// ============================================================
router.post('/face/register', async (req, res) => {
  try {
    const { lineUserId, embedding, photo } = req.body;

    if (!lineUserId || !embedding) {
      return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบ' });
    }

    // หานักเรียน
    const student = await pool.query(
      'SELECT id, name FROM students WHERE line_user_id = $1',
      [lineUserId]
    );
    if (student.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลนักเรียน' });
    }
    const studentId = student.rows[0].id;

    // ลบ embedding เก่า (ถ้ามี) แล้วใส่ใหม่
    await pool.query(
      'UPDATE face_embeddings SET is_active = FALSE WHERE student_id = $1',
      [studentId]
    );

    // บันทึก embedding ใหม่
    await pool.query(
      `INSERT INTO face_embeddings (student_id, embedding_data, photo_url, is_active, created_at)
       VALUES ($1, $2, $3, TRUE, NOW())`,
      [studentId, JSON.stringify(embedding), photo || null]
    );

    // บันทึก log
    await pool.query(
      `INSERT INTO system_logs (event_type, event_data, student_id)
       VALUES ('face_registered', $1, $2)`,
      [JSON.stringify({ student_name: student.rows[0].name }), studentId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Face register error:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  }
});

// ============================================================
// GET /api/liff/face/embedding/:lineUserId - ดึง embedding สำหรับเปรียบเทียบ
// ============================================================
router.get('/face/embedding/:lineUserId', async (req, res) => {
  try {
    const { lineUserId } = req.params;

    const student = await pool.query(
      'SELECT id FROM students WHERE line_user_id = $1',
      [lineUserId]
    );
    if (student.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบนักเรียน' });
    }

    const face = await pool.query(
      'SELECT embedding_data FROM face_embeddings WHERE student_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
      [student.rows[0].id]
    );

    if (face.rows.length === 0) {
      return res.status(404).json({ error: 'ยังไม่ได้ลงทะเบียนใบหน้า', registered: false });
    }

    // embedding_data เก็บเป็น JSON string → parse กลับ
    const embedding = typeof face.rows[0].embedding_data === 'string'
      ? JSON.parse(face.rows[0].embedding_data)
      : face.rows[0].embedding_data;

    res.json({ embedding, registered: true });
  } catch (err) {
    console.error('Face embedding error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ============================================================
// GET /api/liff/seed-students - เพิ่มนักเรียนจาก RMS (รันครั้งเดียว)
// ============================================================
router.get('/seed-students', async (req, res) => {
  try {
    await pool.query("DELETE FROM students WHERE student_code IN ('6701','6702','6703','6704','6705')");

    const students = [
      ['67202010001', 'นางสาวจันทกานต์ นุรักษ์'],
      ['67202010002', 'นางสาวฉัตรชนก ติดใจดี'],
      ['67202010003', 'นางสาวนวภรรษ ศรีวงษ์'],
      ['67202010004', 'นางสาวนันทิพร บุญมี'],
      ['67202010005', 'นางสาวพิมพ์ประไพ แซ่ตัน'],
      ['67202010006', 'นางสาววริศรา ยิ้มศรีแพร'],
      ['67202010007', 'นางสาวศิรินทร์ทิพย์ จิ๋วคล้าย'],
      ['67202010008', 'นางสาวสาธิกา -'],
      ['67202010009', 'นางสาวสุภาภรณ์ เสืองาม'],
      ['67202010010', 'นายสาโท -'],
      ['67202010011', 'นางสาวกนกพร คงถาวร'],
      ['67202010012', 'นางสาวจารุวรรณ วัฒนบท'],
      ['67202010013', 'นายเฒ่าทำภร ภูสำราญวงษ์'],
      ['67202010015', 'นางสาวธัญพร พันธ์ยุโดด'],
      ['67202010017', 'นางสาวน้ำอ้อย สิทธิกมลพร'],
      ['67202010018', 'นางสาวผกามาศ บุญมาก'],
      ['67202010022', 'นางสาวอิงฟ้า พงษ์สะพัง'],
      ['67202010023', 'นางสาวอิศริยา มั่นคง'],
      ['67202010024', 'นายโชติวิทย์ มีเย็น'],
      ['67202010026', 'นางสาวแพรวา ยี่รัญศิริ'],
      ['67202010027', 'นางสาวปิยธิดา วงษ์บุญเพ็ง'],
      ['67202010030', 'นางสาวชาลิสา งามขำ'],
      ['67202010031', 'นางสาวกมลชนก รูปคมสัน'],
      ['67202010033', 'นางสาววาณิชชา ไชยฮ้อย'],
      ['67202010034', 'นางสาวฤทัยกานต์ หงษ์โต'],
      ['67202010037', 'นายปภาวรินท์ สืบปั่น'],
      ['67202010038', 'นางสาวอาคิรา จิตจินดา'],
    ];

    let added = 0;
    for (const [code, name] of students) {
      const result = await pool.query(
        "INSERT INTO students (student_code, name, group_name, education_level) VALUES ($1, $2, 'ปวช.2/1', 'ปวช.') ON CONFLICT (student_code) DO NOTHING RETURNING id",
        [code, name]
      );
      if (result.rows.length > 0) added++;
    }

    const total = await pool.query('SELECT COUNT(*) FROM students');
    res.json({ success: true, added, total: total.rows[0].count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/liff/seed-schedule - สร้างตารางสอน (รันครั้งเดียว)
// ============================================================
router.get('/seed-schedule', async (req, res) => {
  try {
    const teacher = await pool.query("SELECT id FROM teachers WHERE name = 'เชิดพงษ์'");
    if (teacher.rows.length === 0) return res.status(404).json({ error: 'ไม่พบครู' });
    const teacherId = teacher.rows[0].id;

    const classroom = await pool.query("SELECT id FROM classrooms WHERE room_name = 'ห้อง 301'");
    const classroomId = classroom.rows[0].id;

    const lineGroup = await pool.query("SELECT id FROM line_groups WHERE line_group_id = 'Cbb6438455ecfa7f4d51bd27ce55e6b72'");
    const lineGroupId = lineGroup.rows.length > 0 ? lineGroup.rows[0].id : null;

    // เพิ่มวิชาใหม่ถ้ายังไม่มี
    await pool.query(
      "INSERT INTO subjects (subject_code, subject_name, credits, education_level, teacher_id) VALUES ($1, $2, 3, 'ปวช.', $3) ON CONFLICT (subject_code) DO NOTHING",
      ['30201-2104', 'การบัญชีปฏิบัติการภาษาอังกฤษ', teacherId]
    );

    const subj1 = await pool.query("SELECT id FROM subjects WHERE subject_code = '30201-2102'");
    const subj2 = await pool.query("SELECT id FROM subjects WHERE subject_code = '30201-2104'");

    // ลบตารางเก่า
    await pool.query("DELETE FROM schedules WHERE teacher_id = $1", [teacherId]);

    // จันทร์ คาบ 7-8 วิชาการประยุกต์ใช้โปรแกรมตารางงาน
    await pool.query(
      "INSERT INTO schedules (subject_id, teacher_id, classroom_id, line_group_id, day_of_week, start_period, end_period, auto_send, send_minutes_before) VALUES ($1,$2,$3,$4,1,7,8,true,5)",
      [subj1.rows[0].id, teacherId, classroomId, lineGroupId]
    );

    // อังคาร คาบ 1-2 วิชาการบัญชีปฏิบัติการภาษาอังกฤษ
    await pool.query(
      "INSERT INTO schedules (subject_id, teacher_id, classroom_id, line_group_id, day_of_week, start_period, end_period, auto_send, send_minutes_before) VALUES ($1,$2,$3,$4,2,1,2,true,5)",
      [subj2.rows[0].id, teacherId, classroomId, lineGroupId]
    );

    // พุธ คาบ 1-2 วิชาการบัญชีปฏิบัติการภาษาอังกฤษ
    await pool.query(
      "INSERT INTO schedules (subject_id, teacher_id, classroom_id, line_group_id, day_of_week, start_period, end_period, auto_send, send_minutes_before) VALUES ($1,$2,$3,$4,3,1,2,true,5)",
      [subj2.rows[0].id, teacherId, classroomId, lineGroupId]
    );

    // พุธ คาบ 6-8 วิชาการประยุกต์ใช้โปรแกรมตารางงาน
    await pool.query(
      "INSERT INTO schedules (subject_id, teacher_id, classroom_id, line_group_id, day_of_week, start_period, end_period, auto_send, send_minutes_before) VALUES ($1,$2,$3,$4,3,6,8,true,5)",
      [subj1.rows[0].id, teacherId, classroomId, lineGroupId]
    );

    const schedules = await pool.query(
      "SELECT s.day_of_week, s.start_period, s.end_period, sub.subject_name FROM schedules s JOIN subjects sub ON s.subject_id = sub.id WHERE s.teacher_id = $1 ORDER BY s.day_of_week, s.start_period",
      [teacherId]
    );

    const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
    const result = schedules.rows.map(r => ({
      day: days[r.day_of_week],
      period: r.start_period + '-' + r.end_period,
      subject: r.subject_name
    }));

    res.json({ success: true, schedules: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/liff/test-qr - ทดสอบส่ง QR เข้ากลุ่ม (ลบหลังทดสอบ)
// ============================================================
router.get('/test-qr', async (req, res) => {
  try {
    const { createQRSession } = require('../services/qrService');
    const { sendQRToGroup } = require('../services/lineService');

    const schedule = await pool.query(
      "SELECT s.id, s.subject_id, s.teacher_id, s.line_group_id, sub.subject_name, lg.line_group_id AS line_gid FROM schedules s JOIN subjects sub ON s.subject_id = sub.id JOIN line_groups lg ON s.line_group_id = lg.id WHERE s.is_active = TRUE ORDER BY s.day_of_week LIMIT 1"
    );

    if (schedule.rows.length === 0) return res.json({ error: 'ไม่มีตารางสอน' });

    const sch = schedule.rows[0];

    const qrSession = await createQRSession({
      scheduleId: sch.id,
      subjectId: sch.subject_id,
      teacherId: sch.teacher_id,
      lineGroupId: sch.line_group_id,
      qrType: 'check_in'
    });

    const sentAt = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    await sendQRToGroup(sch.line_gid, {
      token: qrSession.token,
      qrType: 'check_in',
      subjectName: sch.subject_name,
      room: 'ห้อง 301',
      sentAt
    });

    res.json({ success: true, token: qrSession.token, subject: sch.subject_name, sentAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { liffApiRouter: router };
