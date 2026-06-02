const express = require('express');
const { pool } = require('../config/database');
const ExcelJS = require('exceljs');

const router = express.Router();

const DAYS_TH = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const PERIOD_TIMES = {
  1:{s:'08:30',e:'09:20'},2:{s:'09:20',e:'10:10'},3:{s:'10:20',e:'11:10'},4:{s:'11:10',e:'12:00'},
  5:{s:'13:00',e:'13:50'},6:{s:'13:50',e:'14:40'},7:{s:'14:50',e:'15:40'},8:{s:'15:40',e:'16:30'}
};

const STATUS_SYMBOLS = {
  present: '/',
  late: 'ส.',
  absent: 'ข.',
  sick_leave: 'ป.',
  personal_leave: 'ก.'
};

// แปลงเวลา period เป็น HH.MM
function periodToTime(p) {
  const t = PERIOD_TIMES[p];
  return t ? t.s.replace(':', '.') : '';
}
function periodToEndTime(p) {
  const t = PERIOD_TIMES[p];
  return t ? t.e.replace(':', '.') : '';
}

// แปลงวันที่เป็นรูปแบบไทย เช่น "14 ต.ค. 2568"
function formatThaiDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+07:00');
  const day = d.getDate();
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const month = months[d.getMonth()];
  const year = d.getFullYear() + 543;
  return `${String(day).padStart(2, '0')} ${month} ${year}`;
}

function formatThaiDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+07:00');
  const day = d.getDate();
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const month = months[d.getMonth()];
  const year = d.getFullYear() + 543;
  return `${day} ${month} ${year}`;
}

const NAME_PREFIXES = ['นางสาว', 'นาย', 'นาง'];

/** แยกชื่อ-สกุลสำหรับรายงาน: ใช้ prefix/first_name/last_name ก่อน ไม่ parse จาก name ถ้ามี field แยก */
function splitStudentNameForReport(student) {
  const first = (student.first_name || '').trim();
  const last = (student.last_name || '').trim();

  if (first || last) {
    return {
      firstName: first || '-',
      lastName: last || '-'
    };
  }

  const fullName = (student.name || '').trim();
  if (!fullName) return { firstName: '-', lastName: '-' };

  let title = '';
  for (const p of NAME_PREFIXES) {
    if (fullName.startsWith(p)) {
      title = p;
      break;
    }
  }
  const nameOnly = title ? fullName.slice(title.length).trim() : fullName;
  const parts = nameOnly.split(/\s+/).filter(Boolean);
  const firstName = title + (parts[0] || '');
  const lastName = parts.slice(1).join(' ') || '-';
  return { firstName: firstName || '-', lastName };
}

// ── GET /api/report/filters ──
router.get('/filters', async (req, res) => {
  try {
    const subjects = await pool.query(
      `SELECT DISTINCT sub.id, sub.subject_code, sub.subject_name
       FROM schedules s JOIN subjects sub ON s.subject_id = sub.id
       WHERE s.is_active = TRUE ORDER BY sub.subject_code`
    );
    // ดึง section จาก schedules
    const sections = await pool.query(
      `SELECT DISTINCT COALESCE(s.section, 'ปวช.2/1') AS section
       FROM schedules s WHERE s.is_active = TRUE ORDER BY section`
    );
    const teachers = await pool.query(
      `SELECT DISTINCT t.id, t.name FROM teachers t
       JOIN schedules s ON s.teacher_id = t.id
       WHERE s.is_active = TRUE ORDER BY t.name`
    );
    const semesters = await pool.query(
      `SELECT DISTINCT semester, academic_year FROM schedules
       WHERE is_active = TRUE AND semester IS NOT NULL
       ORDER BY academic_year DESC, semester DESC`
    );
    res.json({
      subjects: subjects.rows,
      sections: sections.rows.map(r => r.section),
      teachers: teachers.rows,
      semesters: semesters.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ฟังก์ชันกลาง: ดึงข้อมูลรายงานเช็คชื่อ ──
async function fetchReportData({ subject_id, section, date_from, date_to, semester, academic_year }) {
  // section จาก frontend อาจเป็น "ปวช.2/1 - การบัญชี" (จาก schedules) หรือ "ปวช.2/1" (จาก students)
  // ต้อง match ทั้ง 2 ตาราง
  const schedResult = await pool.query(
    `SELECT s.id, s.day_of_week, s.start_period, s.end_period,
            s.custom_start_time, s.custom_end_time,
            s.semester, s.academic_year, s.section,
            sub.subject_code, sub.subject_name,
            t.name AS teacher_name
     FROM schedules s
     JOIN subjects sub ON s.subject_id = sub.id
     LEFT JOIN teachers t ON s.teacher_id = t.id
     WHERE s.subject_id = $1 AND s.is_active = TRUE
     ${section ? "AND s.section = $2" : ""}
     ORDER BY s.day_of_week, s.start_period`,
    section ? [subject_id, section] : [subject_id]
  );
  if (schedResult.rows.length === 0) throw new Error('ไม่พบตารางสอนของวิชานี้');

  const schedules = schedResult.rows;
  const subjectCode = schedules[0].subject_code;
  const subjectName = schedules[0].subject_name;
  const teacherName = schedules[0].teacher_name || '';
  const sem = semester || schedules[0].semester || '';
  const acadYear = academic_year || schedules[0].academic_year || '';
  const scheduleIds = schedules.map(s => s.id);
  const schedSection = schedules[0].section || '';

  // ดึง section สั้นจาก schedule section (เช่น "ปวช.2/1 - การบัญชี" → "ปวช.2/1")
  const shortSection = schedSection.split(' - ')[0].trim() || schedSection;

  const dayScheduleMap = {};
  schedules.forEach(s => {
    if (!dayScheduleMap[s.day_of_week]) dayScheduleMap[s.day_of_week] = [];
    dayScheduleMap[s.day_of_week].push({
      id: s.id,
      startTime: s.custom_start_time || periodToTime(s.start_period),
      endTime: s.custom_end_time || periodToEndTime(s.end_period),
      startPeriod: s.start_period,
      endPeriod: s.end_period
    });
  });

  // ดึงนักเรียน — match group_name กับ section (ทั้งแบบยาวและสั้น)
  const studentsResult = await pool.query(
    `SELECT id, student_code, name, prefix, first_name, last_name, group_name
     FROM students
     WHERE is_active = TRUE
       AND (group_name = $1 OR group_name = $2)
     ORDER BY student_code`,
    [schedSection, shortSection]
  );
  const students = studentsResult.rows;

  let dateCondition = '';
  const params = [scheduleIds, subject_id];
  let pi = 3;
  if (date_from) { dateCondition += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') >= $${pi}`; params.push(date_from); pi++; }
  if (date_to) { dateCondition += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') <= $${pi}`; params.push(date_to); pi++; }

  const attResult = await pool.query(
    `SELECT ar.student_id, ar.schedule_id, ar.status,
            TO_CHAR(ar.checked_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS attend_date,
            TO_CHAR(ar.checked_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in_time,
            TO_CHAR(ar.checked_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out_time
     FROM attendance_records ar
     LEFT JOIN qr_sessions qs ON ar.qr_session_id = qs.id
     WHERE (ar.schedule_id = ANY($1) OR qs.subject_id = $2)
     ${dateCondition}
     ORDER BY ar.checked_at`,
    params
  );

  const attMap = {};
  const dateSet = new Set();
  const defaultScheduleId = scheduleIds[0];
  attResult.rows.forEach(r => {
    // แปลงวันที่ให้ถูกต้อง — attend_date จาก PostgreSQL DATE อาจเลื่อนวันเมื่อแปลง timezone
    let dateStr;
    if (r.attend_date instanceof Date) {
      const y = r.attend_date.getFullYear();
      const m = String(r.attend_date.getMonth() + 1).padStart(2, '0');
      const d = String(r.attend_date.getDate()).padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    } else {
      dateStr = String(r.attend_date).slice(0, 10);
    }
    dateSet.add(dateStr);
    // ใช้ schedule_id จาก record หรือ fallback เป็น schedule แรก
    const sid = r.schedule_id || defaultScheduleId;
    attMap[`${r.student_id}|${dateStr}|${sid}`] = {
      status: r.status,
      checkIn: r.check_in_time || null,
      checkOut: r.check_out_time || null
    };
  });

  const sortedDates = [...dateSet].sort();
  const columns = [];
  sortedDates.forEach(dateStr => {
    const d = new Date(dateStr + 'T12:00:00+07:00');
    const dayOfWeek = d.getDay();
    const dayScheds = dayScheduleMap[dayOfWeek] || [];
    if (dayScheds.length === 0) {
      columns.push({ date: dateStr, scheduleId: scheduleIds[0], header: formatThaiDate(dateStr) });
    } else {
      dayScheds.forEach(ds => {
        columns.push({
          date: dateStr, scheduleId: ds.id,
          header: `${formatThaiDate(dateStr)} ${ds.startTime.replace(':','.')} - ${ds.endTime.replace(':','.')}`
        });
      });
    }
  });

  // สร้างตาราง matrix: นักเรียน × คอลัมน์วัน
  const matrix = students.map((st, idx) => {
    const { firstName, lastName } = splitStudentNameForReport(st);

    const statuses = columns.map(col => {
      const record = attMap[`${st.id}|${col.date}|${col.scheduleId}`];
      const status = record ? record.status : null;
      return {
        status: status || null,
        symbol: status ? (STATUS_SYMBOLS[status] || '/') : '',
        checkIn: record ? record.checkIn : null,
        checkOut: record ? record.checkOut : null
      };
    });

    return {
      no: idx + 1,
      studentCode: st.student_code,
      firstName,
      lastName,
      statuses
    };
  });

  return {
    subjectCode, subjectName, teacherName, sem, acadYear,
    section: schedSection, columns, students: matrix,
    dayScheduleMap, scheduleIds
  };
}

// ── GET /api/report/preview ──
// ดึงข้อมูลแบบ JSON สำหรับแสดงบน Dashboard
router.get('/preview', async (req, res) => {
  try {
    const { subject_id, section, date_from, date_to, semester, academic_year } = req.query;
    if (!subject_id) return res.status(400).json({ error: 'กรุณาเลือกวิชา' });
    const data = await fetchReportData({ subject_id, section, date_from, date_to, semester, academic_year });
    res.json(data);
  } catch (err) {
    console.error('Report preview error:', err);
    res.status(err.message.includes('ไม่พบ') ? 404 : 500).json({ error: err.message });
  }
});

// ── GET /api/report/export-excel ──
// สร้างไฟล์ Excel ตามรูปแบบ RMS — ส่งกลับเป็น .xlsx
router.get('/export-excel', async (req, res) => {
  try {
    const { subject_id, section, date_from, date_to, semester, academic_year } = req.query;
    if (!subject_id) return res.status(400).json({ error: 'กรุณาเลือกวิชา' });

    const data = await fetchReportData({ subject_id, section, date_from, date_to, semester, academic_year });
    const { subjectCode, subjectName, teacherName, sem, acadYear, columns, students } = data;
    const sectionFilter = data.section;

    // ── 5. สร้าง Excel ──
    const wb = new ExcelJS.Workbook();
    const sheetName = `${acadYear}-${subjectCode}-${sectionFilter}`.replace(/[\/\\?*\[\]]/g, '-').slice(0, 31);
    const ws = wb.addWorksheet(sheetName);

    // Font styles
    const fontHeader = { name: 'Angsana New', size: 14, bold: true };
    const fontColHead = { name: 'Angsana New', size: 7.7, bold: true };
    const fontData = { name: 'Angsana New', size: 12 };
    const fontDataBold = { name: 'Angsana New', size: 12, bold: true };
    const fontStatus = { name: 'AngsanaUPC', size: 12 };
    const centerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const leftAlign = { horizontal: 'left', vertical: 'middle' };

    const totalCols = 4 + columns.length; // A-D + date columns
    const lastCol = totalCols;

    // ── แถว 1: หัวเรื่อง ──
    ws.mergeCells(1, 1, 1, lastCol);
    const r1 = ws.getCell('A1');
    r1.value = 'รายงานผลเวลาเรียน';
    r1.font = fontHeader;
    r1.alignment = { horizontal: 'center', vertical: 'middle' };

    // ── แถว 2: ภาคเรียน ──
    ws.mergeCells(2, 1, 2, lastCol);
    const r2 = ws.getCell('A2');
    r2.value = `ภาคเรียนที่ ${sem}/${acadYear ? parseInt(acadYear) + 543 : ''}`;
    r2.font = fontHeader;
    r2.alignment = { horizontal: 'center', vertical: 'middle' };

    // ── แถว 3: ข้อมูลกลุ่มเรียน ──
    ws.mergeCells(3, 1, 3, 4);
    ws.getCell('A3').value = `${sectionFilter}`;
    ws.getCell('A3').font = fontHeader;
    if (lastCol > 4) {
      ws.mergeCells(3, 5, 3, lastCol);
    }

    // ── แถว 4: รหัสวิชา + ชื่อวิชา + ครูผู้สอน ──
    ws.mergeCells(4, 1, 4, lastCol);
    ws.getCell('A4').value = `รหัสวิชา ${subjectCode} รายวิชา ${subjectName}   ครูผู้สอน ${teacherName}`;
    ws.getCell('A4').font = fontHeader;

    // ── แถว 5: Header คอลัมน์ ──
    const headerRow = 5;
    ws.getCell(headerRow, 1).value = 'ลำดับ';
    ws.getCell(headerRow, 1).font = fontData;
    ws.getCell(headerRow, 1).alignment = centerAlign;
    ws.getCell(headerRow, 2).value = 'รหัสนักเรียน';
    ws.getCell(headerRow, 2).font = fontDataBold;
    ws.getCell(headerRow, 2).alignment = centerAlign;
    ws.getCell(headerRow, 3).value = 'ชื่อ';
    ws.getCell(headerRow, 3).font = fontDataBold;
    ws.getCell(headerRow, 4).value = 'สกุล';
    ws.getCell(headerRow, 4).font = fontDataBold;

    columns.forEach((col, ci) => {
      const cell = ws.getCell(headerRow, 5 + ci);
      cell.value = col.header;
      cell.font = fontColHead;
      cell.alignment = centerAlign;
    });

    // กำหนดความกว้างคอลัมน์
    ws.getColumn(1).width = 6;   // ลำดับ
    ws.getColumn(2).width = 14;  // รหัส
    ws.getColumn(3).width = 18;  // ชื่อ
    ws.getColumn(4).width = 14;  // สกุล
    for (let i = 0; i < columns.length; i++) {
      ws.getColumn(5 + i).width = 5;
    }

    // ── แถว 6+: ข้อมูลนักเรียน ──
    students.forEach((st, si) => {
      const row = headerRow + 1 + si;

      ws.getCell(row, 1).value = st.no;
      ws.getCell(row, 1).font = fontData;
      ws.getCell(row, 1).alignment = centerAlign;

      ws.getCell(row, 2).value = st.studentCode;
      ws.getCell(row, 2).font = fontData;
      ws.getCell(row, 2).alignment = centerAlign;

      ws.getCell(row, 3).value = st.firstName;
      ws.getCell(row, 3).font = fontData;

      ws.getCell(row, 4).value = st.lastName;
      ws.getCell(row, 4).font = fontData;

      // สถานะแต่ละวัน
      st.statuses.forEach((s, ci) => {
        const cell = ws.getCell(row, 5 + ci);
        cell.value = s.symbol;
        cell.font = fontStatus;
        cell.alignment = centerAlign;

        if (s.status === 'absent') {
          cell.font = { ...fontStatus, color: { argb: 'FFFF0000' } };
        } else if (s.status === 'sick_leave') {
          cell.font = { ...fontStatus, color: { argb: 'FFF97316' } };
        } else if (s.status === 'personal_leave') {
          cell.font = { ...fontStatus, color: { argb: 'FF8B5CF6' } };
        }
      });
    });

    // ── แถวท้าย: ลงชื่อครูผู้สอน ──
    const footerStart = headerRow + students.length + 2;
    ws.mergeCells(footerStart, 1, footerStart, lastCol);
    ws.getCell(footerStart, 1).value = '';

    ws.mergeCells(footerStart + 1, 1, footerStart + 1, lastCol);
    ws.getCell(footerStart + 1, 1).value = 'ลงชื่อ...................................................................................................ครูผู้สอน';
    ws.getCell(footerStart + 1, 1).font = fontHeader;
    ws.getCell(footerStart + 1, 1).alignment = { horizontal: 'center' };

    ws.mergeCells(footerStart + 2, 1, footerStart + 2, lastCol);
    ws.getCell(footerStart + 2, 1).value = `( ${teacherName} )`;
    ws.getCell(footerStart + 2, 1).font = fontHeader;
    ws.getCell(footerStart + 2, 1).alignment = { horizontal: 'center' };

    const today = new Date();
    const todayStr = formatThaiDateLong(today.toISOString().slice(0, 10));
    ws.mergeCells(footerStart + 3, 1, footerStart + 3, lastCol);
    ws.getCell(footerStart + 3, 1).value = ` ${todayStr}`;
    ws.getCell(footerStart + 3, 1).font = fontHeader;
    ws.getCell(footerStart + 3, 1).alignment = { horizontal: 'center' };

    // ── ตั้งค่าหน้ากระดาษ ──
    ws.pageSetup = {
      orientation: 'landscape',
      paperSize: 9, // A4
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0
    };

    // ── ส่งไฟล์ ──
    const fileName = encodeURIComponent(`รายงานผลเวลาเรียน_${subjectCode}_${sectionFilter}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Report export error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ── GET /api/report/time-preview ──
// รายงานเวลาเข้าเรียน — แสดงทีละวัน
router.get('/time-preview', async (req, res) => {
  try {
    const { subject_id, section, date } = req.query;
    if (!subject_id || !date) return res.status(400).json({ error: 'กรุณาเลือกวิชาและวันที่' });

    // ดึงข้อมูลตาราง + เวลาเรียนตามตาราง
    const schedResult = await pool.query(
      `SELECT s.id, s.custom_start_time, s.custom_end_time,
              s.start_period, s.end_period, s.section,
              sub.subject_code, sub.subject_name,
              t.name AS teacher_name,
              pt_start.start_time AS period_start,
              pt_end.end_time AS period_end
       FROM schedules s
       JOIN subjects sub ON s.subject_id = sub.id
       LEFT JOIN teachers t ON s.teacher_id = t.id
       LEFT JOIN period_times pt_start ON s.start_period = pt_start.period_number
       LEFT JOIN period_times pt_end ON s.end_period = pt_end.period_number
       WHERE s.subject_id = $1 AND s.is_active = TRUE
       ${section ? 'AND s.section = $2' : ''}
       LIMIT 1`,
      section ? [subject_id, section] : [subject_id]
    );
    if (schedResult.rows.length === 0) return res.status(404).json({ error: 'ไม่พบตารางสอน' });

    const sched = schedResult.rows[0];
    const schedStart = sched.custom_start_time || sched.period_start || '08:00';
    const schedEnd = sched.custom_end_time || sched.period_end || '11:00';
    const [sh, sm] = schedStart.split(':').map(Number);
    const [eh, em] = schedEnd.split(':').map(Number);
    const scheduledMinutes = (eh * 60 + em) - (sh * 60 + sm);
    const schedSection = sched.section || '';
    const shortSection = schedSection.split(' - ')[0].trim() || schedSection;

    // ดึงนักเรียน
    const studentsResult = await pool.query(
      `SELECT id, student_code, name, prefix, first_name, last_name, group_name
       FROM students WHERE is_active = TRUE
       AND (group_name = $1 OR group_name = $2)
       ORDER BY student_code`,
      [schedSection, shortSection]
    );

    // ดึง attendance ของวันที่เลือก
    const attResult = await pool.query(
      `SELECT ar.student_id, ar.status,
              TO_CHAR(ar.checked_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in_time,
              TO_CHAR(ar.checked_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out_time
       FROM attendance_records ar
       LEFT JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       WHERE (qs.subject_id = $1 OR ar.schedule_id = ANY(
         SELECT id FROM schedules WHERE subject_id = $1 AND is_active = TRUE
       ))
       AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') = $2
       AND ar.check_type = 'check_in'
       ORDER BY ar.checked_at`,
      [subject_id, date]
    );

    const attMap = {};
    attResult.rows.forEach(r => { attMap[r.student_id] = r; });

    // สร้างข้อมูลนักเรียน
    const rows = studentsResult.rows.map((st, idx) => {
      const { firstName, lastName } = splitStudentNameForReport(st);

      const att = attMap[st.id];
      let actualMinutes = 0, percent = 0, passed = false;

      if (att && att.check_in_time && att.check_out_time) {
        const [ciH, ciM] = att.check_in_time.split(':').map(Number);
        const [coH, coM] = att.check_out_time.split(':').map(Number);
        actualMinutes = (coH * 60 + coM) - (ciH * 60 + ciM);
        if (actualMinutes < 0) actualMinutes = 0;
        percent = Math.min(100, Math.round((actualMinutes / scheduledMinutes) * 100));
        passed = percent >= 80;
      }

      const actualHours = Math.floor(actualMinutes / 60);
      const actualMins = actualMinutes % 60;

      return {
        no: idx + 1,
        studentCode: st.student_code,
        firstName,
        lastName,
        status: att ? att.status : 'absent',
        checkIn: att?.check_in_time || '-',
        checkOut: att?.check_out_time || '-',
        actualTime: actualMinutes > 0 ? `${actualHours} ชม.${actualMins > 0 ? ` ${actualMins} น.` : ''}` : '-',
        actualMinutes,
        percent,
        passed
      };
    });

    const schedHours = Math.floor(scheduledMinutes / 60);
    const schedMins = scheduledMinutes % 60;

    res.json({
      subjectCode: sched.subject_code,
      subjectName: sched.subject_name,
      teacherName: sched.teacher_name || '',
      section: schedSection,
      date,
      dateDisplay: formatThaiDate(date),
      scheduledTime: `${schedHours} ชม.${schedMins > 0 ? ` ${schedMins} น.` : ''}`,
      scheduledMinutes,
      scheduleStart: schedStart,
      scheduleEnd: schedEnd,
      students: rows
    });
  } catch (err) {
    console.error('Time report error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { reportApiRouter: router };

// ═══════════════════════════════════════════
// รายงานร้อยละการขาดเรียน + แจ้ง ขร.
// GET /api/report/absence-rate?subject_id=&section=
// ═══════════════════════════════════════════
router.get('/absence-rate', async (req, res) => {
  try {
    const { subject_id, section } = req.query;
    if (!subject_id) return res.status(400).json({ error: 'กรุณาเลือกรายวิชา' });

    // ดึงข้อมูลตารางสอน
    const schedResult = await pool.query(
      `SELECT s.id, s.custom_start_time, s.custom_end_time,
              s.start_period, s.end_period, s.section,
              sub.subject_code, sub.subject_name, sub.credits,
              t.name AS teacher_name
       FROM schedules s
       JOIN subjects sub ON s.subject_id = sub.id
       LEFT JOIN teachers t ON s.teacher_id = t.id
       WHERE s.subject_id = $1 AND s.is_active = TRUE
       ${section ? 'AND s.section = $2' : ''}
       LIMIT 1`,
      section ? [subject_id, section] : [subject_id]
    );
    if (schedResult.rows.length === 0) return res.status(404).json({ error: 'ไม่พบตารางสอน' });

    const sched = schedResult.rows[0];
    // คำนวณเวลาต่อครั้ง (นาที)
    let minutesPerSession = 50; // default 1 คาบ
    if (sched.custom_start_time && sched.custom_end_time) {
      const [sh, sm] = sched.custom_start_time.split(':').map(Number);
      const [eh, em] = sched.custom_end_time.split(':').map(Number);
      minutesPerSession = (eh * 60 + em) - (sh * 60 + sm);
    } else if (sched.start_period && sched.end_period) {
      minutesPerSession = (sched.end_period - sched.start_period + 1) * 50;
    }
    const WEEKS = 18;
    const totalMinutes = minutesPerSession * WEEKS; // เวลาทั้งภาค
    const totalHours = (totalMinutes / 60).toFixed(1);

    // ดึงนักเรียน
    const schedSection = sched.section || '';
    const shortSection = schedSection.split(' - ')[0].trim() || schedSection;
    const studentsResult = await pool.query(
      `SELECT id, student_code, name, prefix, first_name, last_name
       FROM students WHERE is_active = TRUE
       AND (group_name = $1 OR group_name = $2)
       ORDER BY student_code`,
      [schedSection, shortSection]
    );

    // ดึง QR sessions ของวิชานี้
    const sessionsResult = await pool.query(
      `SELECT qs.id, qs.session_date
       FROM qr_sessions qs
       WHERE qs.subject_id = $1 AND qs.qr_type = 'check_in'
       ORDER BY qs.session_date`,
      [subject_id]
    );
    const sessionIds = sessionsResult.rows.map(r => r.id);
    const sessionCount = sessionIds.length;

    // ดึง attendance records
    let attendanceMap = {};
    if (sessionIds.length > 0) {
      const attResult = await pool.query(
        `SELECT ar.student_id, ar.status, ar.checked_at, ar.checked_out_at
         FROM attendance_records ar
         WHERE ar.qr_session_id = ANY($1::uuid[])`,
        [sessionIds]
      );
      attResult.rows.forEach(r => {
        if (!attendanceMap[r.student_id]) attendanceMap[r.student_id] = [];
        attendanceMap[r.student_id].push(r);
      });
    }

    const students = studentsResult.rows.map(st => {
      const records = attendanceMap[st.id] || [];
      const absentCount = sessionCount - records.filter(r =>
        r.status === 'present' || r.status === 'late' ||
        r.status === 'sick_leave' || r.status === 'personal_leave'
      ).length;
      const absentMinutes = absentCount * minutesPerSession;
      const absentHours = (absentMinutes / 60).toFixed(1);
      const attendancePercent = totalMinutes > 0
        ? Math.max(0, ((totalMinutes - absentMinutes) / totalMinutes * 100)).toFixed(1)
        : '100.0';
      const name = st.name || `${st.prefix||''}${st.first_name||''} ${st.last_name||''}`.trim();
      return {
        studentCode: st.student_code,
        prefix: st.prefix || '',
        firstName: st.first_name || name.split(' ')[0] || name,
        lastName: st.last_name || name.split(' ').slice(1).join(' ') || '',
        absentCount,
        absentHours: parseFloat(absentHours),
        attendancePercent: parseFloat(attendancePercent),
        pass: parseFloat(attendancePercent) >= 80
      };
    });

    res.json({
      subjectCode: sched.subject_code,
      subjectName: sched.subject_name,
      teacherName: sched.teacher_name || '',
      section: schedSection,
      totalHours,
      totalMinutes,
      minutesPerSession,
      sessionCount,
      weeks: WEEKS,
      students
    });
  } catch (err) {
    console.error('Absence rate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// รายงานบันทึกเวลาเข้า-ออก
// GET /api/report/checkin-log?subject_id=&section=&date_from=&date_to=
// ═══════════════════════════════════════════
router.get('/checkin-log', async (req, res) => {
  try {
    const { subject_id, section, date_from, date_to } = req.query;
    if (!subject_id) return res.status(400).json({ error: 'กรุณาเลือกรายวิชา' });

    let dateFilter = '';
    const params = [subject_id];
    if (date_from) { params.push(date_from); dateFilter += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') >= $${params.length}`; }
    if (date_to) { params.push(date_to); dateFilter += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') <= $${params.length}`; }

    const result = await pool.query(
      `SELECT ar.id,
              st.student_code, st.name, st.prefix, st.first_name, st.last_name,
              sub.subject_code, sub.subject_name,
              ar.status,
              ar.checked_at AT TIME ZONE 'Asia/Bangkok' AS check_in_th,
              ar.checked_out_at AT TIME ZONE 'Asia/Bangkok' AS check_out_th,
              ar.face_confidence, ar.is_manual, ar.remark
       FROM attendance_records ar
       JOIN students st ON ar.student_id = st.id
       JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       JOIN subjects sub ON qs.subject_id = sub.id
       WHERE sub.id = $1 ${dateFilter}
       ORDER BY ar.checked_at DESC`,
      params
    );

    const rows = result.rows.map(r => {
      const name = r.name || `${r.prefix||''}${r.first_name||''} ${r.last_name||''}`.trim();
      const checkIn = r.check_in_th ? new Date(r.check_in_th) : null;
      const checkOut = r.check_out_th ? new Date(r.check_out_th) : null;
      const durationMin = checkIn && checkOut
        ? Math.round((checkOut - checkIn) / 60000) : null;
      return {
        studentCode: r.student_code,
        name,
        status: r.status,
        date: checkIn ? checkIn.toLocaleDateString('th-TH', { timeZone: 'UTC' }) : '-',
        checkIn: checkIn ? checkIn.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '-',
        checkOut: checkOut ? checkOut.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '-',
        duration: durationMin !== null ? `${Math.floor(durationMin/60)} ชม. ${durationMin%60} น.` : '-',
        faceConfidence: r.face_confidence ? `${Math.round(r.face_confidence)}%` : '-',
        isManual: r.is_manual || false,
        remark: r.remark || ''
      };
    });

    res.json({ rows, subjectCode: result.rows[0]?.subject_code || '', subjectName: result.rows[0]?.subject_name || '' });
  } catch (err) {
    console.error('Checkin log error:', err);
    res.status(500).json({ error: err.message });
  }
});
