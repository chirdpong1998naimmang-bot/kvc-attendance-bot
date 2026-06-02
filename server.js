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
app.use('/api/report', express.json({ limit: '10mb' }), reportApiRouter);
app.use('/api', express.json({ limit: '10mb' }), dashboardApiRouter);


// Health check — ไม่ให้ DB ล่มแล้ว Render restart loop
app.get('/health', async (req, res) => {
  const payload = {
    status: 'ok',
    uptime: process.uptime(),
    database: 'unknown'
  };
  try {
    const dbResult = await pool.query('SELECT NOW()');
    payload.database = 'connected';
    payload.timestamp = dbResult.rows[0].now;
    res.json(payload);
  } catch (err) {
    payload.status = 'degraded';
    payload.database = 'disconnected';
    payload.dbError = err.message;
    console.error('Health check DB error:', err.message);
    res.status(200).json(payload);
  }
});

// ============================================================
// Start Server
// ============================================================

async function connectDatabaseWithRetry(maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await testConnection();
      return;
    } catch (err) {
      console.error(`❌ Database connection attempt ${attempt}/${maxAttempts}:`, err.message);
      if (!process.env.DATABASE_URL) {
        console.error('❌ ไม่พบ DATABASE_URL — ตรวจ Environment บน Render ว่าผูก attendance-db แล้ว');
      }
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
}

async function runStartupMigrations() {
  try {
    await pool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMP');
    console.log('✅ Migration: checked_out_at column ready');
  } catch (err) {
    console.warn('⚠️ Migration warning:', err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE schedules
        ADD COLUMN IF NOT EXISTS custom_start_time TIME,
        ADD COLUMN IF NOT EXISTS custom_end_time TIME,
        ADD COLUMN IF NOT EXISTS academic_year VARCHAR(10),
        ADD COLUMN IF NOT EXISTS section VARCHAR(20)
    `);
    console.log('✅ Migration: schedule columns ready');
  } catch (err) {
    console.warn('⚠️ Schedule migration warning:', err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE students
        ADD COLUMN IF NOT EXISTS class_year TEXT,
        ADD COLUMN IF NOT EXISTS room TEXT,
        ADD COLUMN IF NOT EXISTS major TEXT,
        ADD COLUMN IF NOT EXISTS department TEXT,
        ADD COLUMN IF NOT EXISTS year TEXT,
        ADD COLUMN IF NOT EXISTS section TEXT,
        ADD COLUMN IF NOT EXISTS prefix TEXT,
        ADD COLUMN IF NOT EXISTS first_name TEXT,
        ADD COLUMN IF NOT EXISTS last_name TEXT
    `);
    console.log('✅ Migration: students columns ready');
  } catch (err) {
    console.warn('⚠️ Students migration warning:', err.message);
  }
}

async function start() {
  await connectDatabaseWithRetry();
  await autoInitDatabase();
  await runStartupMigrations();

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