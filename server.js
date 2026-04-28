// ============================================================
// ระบบเช็คชื่อผู้เรียน - วิทยาลัยอาชีวศึกษากาญจนบุรี
// Main Server Entry Point
// ============================================================

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { lineWebhookRouter } = require('./src/webhook/lineWebhook');
const { liffApiRouter } = require('./src/api/liffApi');
const { dashboardApiRouter } = require('./src/api/dashboardApi');
const { reportApiRouter } = require('./src/api/reportApi');
const { rmsApiRouter } = require('./src/api/rmsApi');
const { startScheduler } = require('./src/services/scheduleService');
const { pool, testConnection } = require('./src/config/database');

const app = express();
const PORT = process.env.PORT || 3000;
const { autoInitDatabase } = require('./src/config/autoInit');

// Render ตั้ง RENDER_EXTERNAL_URL ให้อัตโนมัติ
if (!process.env.BASE_URL && process.env.RENDER_EXTERNAL_URL) {
  process.env.BASE_URL = process.env.RENDER_EXTERNAL_URL;
}

// ============================================================
// Middleware
// ============================================================

// Helmet สำหรับ security headers (ยกเว้น webhook route)
app.use(helmet({ contentSecurityPolicy: false }));

// CORS สำหรับ LIFF App
app.use(cors());

// ⚠️ สำคัญ: LINE webhook ต้องรับ raw body ก่อน express.json()
// ดังนั้นเราไม่ใส่ express.json() ที่ app level
// แต่ใส่ในแต่ละ router แทน

// ============================================================
// Routes
// ============================================================

// LINE Webhook - ใช้ raw body สำหรับ signature verification
app.use('/webhook', lineWebhookRouter);

// LIFF API - ใช้ JSON body
app.use('/api/liff', express.json({ limit: '10mb' }), liffApiRouter);
app.use('/api/rms', express.json({ limit: '10mb' }), rmsApiRouter);
app.use('/api/report', express.json({ limit: '10mb' }), reportApiRouter);
app.use('/api', express.json({ limit: '10mb' }), dashboardApiRouter);


// Health check
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      timestamp: dbResult.rows[0].now,
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// Start Server
// ============================================================

async function start() {
  // ทดสอบเชื่อมต่อ Database
  await testConnection();
  await autoInitDatabase();

  // Migration: เพิ่มคอลัมน์ checked_out_at (รันซ้ำได้ปลอดภัย)
  try {
    await pool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMP');
    console.log('✅ Migration: checked_out_at column ready');
  } catch (err) {
    console.warn('⚠️ Migration warning:', err.message);
  }
  // Migration: สร้างตาราง RMS Mappings (รันซ้ำได้ปลอดภัย)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rms_student_mappings (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        student_id UUID NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
        rms_student_code VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rms_subject_mappings (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        section VARCHAR(100) NOT NULL,
        rms_subject_id VARCHAR(50) NOT NULL,
        rms_group_id VARCHAR(50) NOT NULL,
        rms_timetable_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(subject_id, section)
      );
      CREATE TABLE IF NOT EXISTS rms_teacher_mappings (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        teacher_id UUID NOT NULL UNIQUE REFERENCES teachers(id) ON DELETE CASCADE,
        rms_teacher_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_rms_student_code ON rms_student_mappings(rms_student_code);
      CREATE INDEX IF NOT EXISTS idx_rms_subject_section ON rms_subject_mappings(subject_id, section);
      CREATE INDEX IF NOT EXISTS idx_rms_teacher_id ON rms_teacher_mappings(rms_teacher_id);
    `);
    console.log('✅ Migration: RMS mapping tables ready');
  } catch (err) {
    console.warn('⚠️ RMS migration warning:', err.message);
  }
  
  // เริ่ม Cron Job ส่ง QR อัตโนมัติ
  startScheduler();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   ระบบเช็คชื่อผู้เรียน - KVC Attendance Bot   ║
║   Server running on port ${PORT}                ║
║   Webhook: ${process.env.BASE_URL}/webhook/line  
║   LIFF API: ${process.env.BASE_URL}/api/liff     
╚══════════════════════════════════════════════╝
    `);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
