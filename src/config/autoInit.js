const { pool } = require('./database');
const fs = require('fs');
const path = require('path');

// ─── Migration: เพิ่มสถานะลาป่วย/ลากิจ + คอลัมน์ใหม่ ───
async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');

    // 1. เพิ่มคอลัมน์ is_manual
    await client.query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE
    `);

    // 2. เพิ่มคอลัมน์ remark
    await client.query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS remark TEXT
    `);

    // 3. เพิ่มคอลัมน์ updated_at
    await client.query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);

    // 4. อนุญาตให้ qr_session_id เป็น NULL (สำหรับ manual entry)
    const colCheck = await client.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'attendance_records' AND column_name = 'qr_session_id'
    `);
    if (colCheck.rows.length > 0 && colCheck.rows[0].is_nullable === 'NO') {
      await client.query(`ALTER TABLE attendance_records ALTER COLUMN qr_session_id DROP NOT NULL`);
      console.log('  ✓ qr_session_id → nullable');
    }

    // 5. แก้ constraint สถานะ → 5 แบบ (มา/สาย/ขาด/ลาป่วย/ลากิจ)
    const constraints = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'attendance_records'::regclass
        AND contype = 'c'
        AND (conname LIKE '%status%' OR conname LIKE '%check%')
    `);
    for (const row of constraints.rows) {
      await client.query(`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }
    // เช็คว่า constraint ใหม่มีอยู่แล้วหรือยัง
    const newConst = await client.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'attendance_status_5types'
    `);
    if (newConst.rows.length === 0) {
      await client.query(`
        ALTER TABLE attendance_records
        ADD CONSTRAINT attendance_status_5types
        CHECK (status IN ('present', 'late', 'absent', 'sick_leave', 'personal_leave'))
      `);
    }

    console.log('✅ Migrations complete (5 statuses + manual columns)');
  } catch (err) {
    if (err.code === '42710') {
      console.log('✅ Migrations already applied');
    } else {
      console.error('⚠️ Migration warning:', err.message);
    }
  } finally {
    client.release();
  }
}

// ─── Auto Init ───
async function autoInitDatabase() {
  try {
    const check = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'teachers'
      )
    `);

    if (check.rows[0].exists) {
      console.log('✅ Database tables already exist');
    } else {
      console.log('🔄 First run - creating database tables...');
      const sqlFile = path.join(__dirname, '..', '..', 'attendance-schema.sql');
      const sql = fs.readFileSync(sqlFile, 'utf8');
      await pool.query(sql);

      const tables = await pool.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      console.log('✅ Created ' + tables.rows.length + ' tables');
    }

    // รัน migration ทุกครั้ง (ปลอดภัย รันซ้ำได้)
    await runMigrations();

  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

module.exports = { autoInitDatabase };
