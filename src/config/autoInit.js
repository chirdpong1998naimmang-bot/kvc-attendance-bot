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

    // 3.5 เพิ่มคอลัมน์ leave_image (เก็บรูปหลักฐานการลา)
    await client.query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS leave_image TEXT
    `);
    console.log('  ✓ leave_image column');

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

    // ─── Migration 2: custom time ในตารางสอน ───
    console.log('🔄 Running migration 2 (custom schedule times)...');

    await client.query(`
      ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS custom_start_time VARCHAR(5)
    `);
    await client.query(`
      ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS custom_end_time VARCHAR(5)
    `);
    console.log('  ✓ custom_start_time / custom_end_time columns');

    // เพิ่ม semester / academic_year
    await client.query(`
      ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS semester VARCHAR(10)
    `);
    await client.query(`
      ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS academic_year VARCHAR(10)
    `);
    console.log('  ✓ semester / academic_year columns');

    // เพิ่มคอลัมน์ใน face_embeddings (ถ้ายังไม่มี)
    await client.query(`
      ALTER TABLE face_embeddings
      ADD COLUMN IF NOT EXISTS embedding_data TEXT
    `);
    await client.query(`
      ALTER TABLE face_embeddings
      ADD COLUMN IF NOT EXISTS photo_url TEXT
    `);
    await client.query(`
      ALTER TABLE face_embeddings
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
    `);
    console.log('  ✓ face_embeddings columns');

    // เติมค่าเริ่มต้นจาก period_times (ถ้ายังเป็น NULL)
    await client.query(`
      UPDATE schedules s
      SET custom_start_time = LPAD(
            CASE s.start_period
              WHEN 1 THEN '08:30' WHEN 2 THEN '09:20' WHEN 3 THEN '10:20' WHEN 4 THEN '11:10'
              WHEN 5 THEN '13:00' WHEN 6 THEN '13:50' WHEN 7 THEN '14:50' WHEN 8 THEN '15:40'
            END, 5, '0'),
          custom_end_time = LPAD(
            CASE s.end_period
              WHEN 1 THEN '09:20' WHEN 2 THEN '10:10' WHEN 3 THEN '11:10' WHEN 4 THEN '12:00'
              WHEN 5 THEN '13:50' WHEN 6 THEN '14:40' WHEN 7 THEN '15:40' WHEN 8 THEN '16:30'
            END, 5, '0')
      WHERE s.custom_start_time IS NULL OR s.custom_end_time IS NULL
    `);
    console.log('  ✓ populated existing schedules with times');

    console.log('✅ All migrations complete');
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
