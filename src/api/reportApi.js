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
  const d = new Date(dateStr + 'T00:00:00+07:00');
  const day = d.getDate();
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const month = months[d.getMonth()];
  const year = d.getFullYear() + 543;
  return `${String(day).padStart(2, '0')} ${month} ${year}`;
}

function formatThaiDateLong(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  const day = d.getDate();
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const month = months[d.getMonth()];
  const year = d.getFullYear() + 543;
  return `${day} ${month} ${year}`;
}

// ── GET /api/report/filters ──
router.get('/filters', async (req, res) => {
  try {
    const subjects = await pool.query(
      `SELECT DISTINCT sub.id, sub.subject_code, sub.subject_name
       FROM schedules s JOIN subjects sub ON s.subject_id = sub.id
       WHERE s.is_active = TRUE ORDER BY sub.subject_code`
    );
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
  const sectionFilter = section || 'ปวช.2/1';
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
       AND COALESCE(s.section, 'ปวช.2/1') = $2
     ORDER BY s.day_of_week, s.start_period`,
    [subject_id, sectionFilter]
  );
  if (schedResult.rows.length === 0) throw new Error('ไม่พบตารางสอนของวิชานี้');

  const schedules = schedResult.rows;
  const subjectCode = schedules[0].subject_code;
  const subjectName = schedules[0].subject_name;
  const teacherName = schedules[0].teacher_name || '';
  const sem = semester || schedules[0].semester || '';
  const acadYear = academic_year || schedules[0].academic_year || '';
  const scheduleIds = schedules.map(s => s.id);

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

  const studentsResult = await pool.query(
    `SELECT id, student_code, name, group_name FROM students
     WHERE is_active = TRUE AND COALESCE(group_name, 'ปวช.2/1') = $1
     ORDER BY student_code`,
    [sectionFilter]
  );
  const students = studentsResult.rows;

  let dateCondition = '';
  const params = [scheduleIds];
  let pi = 2;
  if (date_from) { dateCondition += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') >= $${pi}`; params.push(date_from); pi++; }
  if (date_to) { dateCondition += ` AND DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') <= $${pi}`; params.push(date_to); pi++; }

  const attResult = await pool.query(
    `SELECT ar.student_id, ar.schedule_id, ar.status,
            DATE(ar.checked_at AT TIME ZONE 'Asia/Bangkok') AS attend_date
     FROM attendance_records ar
     WHERE ar.schedule_id = ANY($1) ${dateCondition}
     ORDER BY ar.checked_at`,
    params
  );

  const attMap = {};
  const dateSet = new Set();
  attResult.rows.forEach(r => {
    const dateStr = r.attend_date instanceof Date ? r.attend_date.toISOString().slice(0,10) : String(r.attend_date).slice(0,10);
    dateSet.add(dateStr);
    attMap[`${r.student_id}|${dateStr}|${r.schedule_id}`] = r.status;
  });

  const sortedDates = [...dateSet].sort();
  const columns = [];
  sortedDates.forEach(dateStr => {
    const d = new Date(dateStr + 'T00:00:00+07:00');
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
    const fullName = st.name || '';
    let firstName = fullName, lastName = '-';
    for (const p of ['นางสาว','นาย','นาง']) {
      if (fullName.startsWith(p)) {
        const rest = fullName.slice(p.length).trim().split(' ');
        firstName = p + (rest[0] || '');
        lastName = rest.slice(1).join(' ') || '-';
        break;
      }
    }
    if (firstName === fullName) {
      const parts = fullName.split(' ');
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '-';
    }

    const statuses = columns.map(col => {
      const status = attMap[`${st.id}|${col.date}|${col.scheduleId}`];
      return {
        status: status || null,
        symbol: status ? (STATUS_SYMBOLS[status] || '/') : ''
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
    section: sectionFilter, columns, students: matrix,
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

module.exports = { reportApiRouter: router };
