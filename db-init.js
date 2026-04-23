// ============================================================
// Database Initialization Script
// รันครั้งเดียวเพื่อสร้างตาราง + ข้อมูลเริ่มต้น
// วิธีใช้: node db-init.js
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function initDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  console.log('🔄 Connecting to database...');
  
  try {
    // ทดสอบเชื่อมต่อ
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Connected:', res.rows[0].now);

    // อ่านไฟล์ SQL
    const sqlFile = path.join(__dirname, 'attendance-schema.sql');
    if (!fs.existsSync(sqlFile)) {
      console.error('❌ attendance-schema.sql not found!');
      process.exit(1);
    }

    const sql = fs.readFileSync(sqlFile, 'utf8');
    
    console.log('🔄 Creating tables...');
    await pool.query(sql);
    
    console.log('✅ Database initialized successfully!');
    console.log('');
    console.log('Tables created:');
    
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    tables.rows.forEach(r => console.log(`  - ${r.table_name}`));
    
    console.log('');
    console.log('Sample data inserted:');
    
    const teachers = await pool.query('SELECT name FROM teachers');
    console.log(`  Teachers: ${teachers.rows.map(r => r.name).join(', ')}`);
    
    const students = await pool.query('SELECT student_code, name FROM students ORDER BY student_code');
    console.log(`  Students: ${students.rows.length} records`);
    
    const subjects = await pool.query('SELECT subject_code, subject_name FROM subjects');
    subjects.rows.forEach(r => console.log(`  - ${r.subject_code}: ${r.subject_name}`));

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Tables already exist - skipping. Use DROP TABLE IF EXISTS to reset.');
    }
  } finally {
    await pool.end();
  }
}

initDatabase();
