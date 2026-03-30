/* config/db.js — Sequelize + MySQL 연결 (자동 DB 생성) */
const { Sequelize } = require('sequelize');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.MYSQL_DATABASE || 'gonggomoa';
const DB_USER = process.env.MYSQL_USER     || 'root';
const DB_PASS = process.env.MYSQL_PASSWORD || '';
const DB_HOST = process.env.MYSQL_HOST     || '127.0.0.1';
const DB_PORT = parseInt(process.env.MYSQL_PORT) || 3306;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host:    DB_HOST,
  port:    DB_PORT,
  dialect: 'mysql',
  logging: process.env.NODE_ENV === 'production' ? false : console.log,
  timezone: '+09:00',
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', timestamps: true }
});

async function connectDB() {
  try {
    // ★ DB가 없으면 자동 생성
    const conn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.end();
    console.log(`✅ 데이터베이스 '${DB_NAME}' 확인/생성 완료`);

    // Sequelize 연결
    await sequelize.authenticate();
    console.log('✅ MySQL 연결 성공');

    await sequelize.sync({ alter: true });
    console.log('✅ 테이블 동기화 완료');
  } catch (err) {
    console.error('❌ MySQL 연결 실패:', err.message);
    process.exit(1);
  }
}

module.exports = { sequelize, connectDB };
