require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.env.MYSQL_DATABASE || 'gonggomoa';
const DB_USER = process.env.MYSQL_USER || 'root';
const DB_PASS = process.env.MYSQL_PASSWORD || '';
const DB_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;

async function hasColumn(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [DB_NAME, tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function hasIndex(conn, tableName, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [DB_NAME, tableName, indexName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function main() {
  let conn;

  try {
    conn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      multipleStatements: false
    });

    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${DB_NAME}\``);

    const [tables] = await conn.query(`SHOW TABLES LIKE 'inquiries'`);
    if (!Array.isArray(tables) || !tables.length) {
      throw new Error("'inquiries' 테이블이 존재하지 않습니다. 먼저 기본 테이블 생성/배포를 완료하세요.");
    }

    const columnPlans = [
      {
        name: 'adminMemo',
        sql: "ALTER TABLE inquiries ADD COLUMN adminMemo TEXT NOT NULL DEFAULT '' AFTER status"
      },
      {
        name: 'processedAt',
        sql: 'ALTER TABLE inquiries ADD COLUMN processedAt DATETIME NULL DEFAULT NULL AFTER adminMemo'
      },
      {
        name: 'processedBy',
        sql: 'ALTER TABLE inquiries ADD COLUMN processedBy INT UNSIGNED NULL DEFAULT NULL AFTER processedAt'
      }
    ];

    for (const plan of columnPlans) {
      const exists = await hasColumn(conn, 'inquiries', plan.name);
      if (exists) {
        console.log(`ℹ️ 컬럼 이미 존재: ${plan.name}`);
        continue;
      }

      console.log(`➕ 컬럼 추가: ${plan.name}`);
      await conn.query(plan.sql);
      console.log(`✅ 컬럼 추가 완료: ${plan.name}`);
    }

    const indexPlans = [
      {
        name: 'idx_inquiries_processedAt',
        sql: 'CREATE INDEX idx_inquiries_processedAt ON inquiries (processedAt)'
      },
      {
        name: 'idx_inquiries_processedBy',
        sql: 'CREATE INDEX idx_inquiries_processedBy ON inquiries (processedBy)'
      }
    ];

    for (const plan of indexPlans) {
      const exists = await hasIndex(conn, 'inquiries', plan.name);
      if (exists) {
        console.log(`ℹ️ 인덱스 이미 존재: ${plan.name}`);
        continue;
      }

      console.log(`➕ 인덱스 추가: ${plan.name}`);
      await conn.query(plan.sql);
      console.log(`✅ 인덱스 추가 완료: ${plan.name}`);
    }

    const [columns] = await conn.query('DESCRIBE inquiries');
    const names = columns.map(row => row.Field);
    const required = ['adminMemo', 'processedAt', 'processedBy'];
    const missing = required.filter(name => !names.includes(name));

    if (missing.length) {
      throw new Error(`마이그레이션 후에도 누락된 컬럼이 있습니다: ${missing.join(', ')}`);
    }

    console.log('🎉 inquiry admin 스키마 마이그레이션 완료');
  } catch (err) {
    console.error('❌ inquiry admin 스키마 마이그레이션 실패:', err.message);
    process.exitCode = 1;
  } finally {
    if (conn) {
      await conn.end();
    }
  }
}

main();
