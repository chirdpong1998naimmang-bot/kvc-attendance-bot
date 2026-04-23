const { pool } = require('./database');
const fs = require('fs');
const path = require('path');

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
      return;
    }

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
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

module.exports = { autoInitDatabase };
