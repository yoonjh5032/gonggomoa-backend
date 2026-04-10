require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.env.MYSQL_DATABASE || 'gonggomoa';
const DB_USER = process.env.MYSQL_USER || 'root';
const DB_PASS = process.env.MYSQL_PASSWORD || '';
const DB_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;

async function main() {
  let conn;

  try {
    conn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME
    });

    const [columns] = await conn.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'inquiries'`,
      [DB_NAME]
    );

    const [indexes] = await conn.query(
      `SELECT DISTINCT INDEX_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'inquiries'`,
      [DB_NAME]
    );

    const columnNames = columns.map(row => row.COLUMN_NAME);
    const indexNames = indexes.map(row => row.INDEX_NAME);

    const requiredColumns = ['adminMemo', 'processedAt', 'processedBy'];
    const requiredIndexes = ['idx_inquiries_processedAt', 'idx_inquiries_processedBy'];

    const missingColumns = requiredColumns.filter(name => !columnNames.includes(name));
    const missingIndexes = requiredIndexes.filter(name => !indexNames.includes(name));

    if (missingColumns.length || missingIndexes.length) {
      console.error('❌ inquiry admin 스키마 누락 발견');
      if (missingColumns.length) {
        console.error(`- 누락 컬럼: ${missingColumns.join(', ')}`);
      }
      if (missingIndexes.length) {
        console.error(`- 누락 인덱스: ${missingIndexes.join(', ')}`);
      }
      process.exit(1);
    }

    console.log('✅ inquiry admin 스키마 점검 통과');
  } catch (err) {
    console.error('❌ inquiry admin 스키마 점검 실패:', err.message);
    process.exit(1);
  } finally {
    if (conn) {
      await conn.end();
    }
  }
}

main();
