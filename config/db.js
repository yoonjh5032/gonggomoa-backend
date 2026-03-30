/* config/db.js — Sequelize + MySQL 연결 */
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'gonggomoa',
  process.env.MYSQL_USER     || 'root',
  process.env.MYSQL_PASSWORD || '',
  {
    host:    process.env.MYSQL_HOST || '127.0.0.1',
    port:    parseInt(process.env.MYSQL_PORT) || 3306,
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'production' ? false : console.log,
    timezone: '+09:00',   // KST
    pool: {
      max:     10,
      min:     0,
      acquire: 30000,
      idle:    10000
    },
    define: {
      charset:   'utf8mb4',
      collate:   'utf8mb4_unicode_ci',
      timestamps: true      // createdAt, updatedAt 자동 관리
    }
  }
);

async function connectDB() {
  try {
    await sequelize.authenticate();
    console.log('✅ MySQL 연결 성공');

    // 테이블 자동 생성/동기화 (alter: 기존 데이터 유지하며 스키마 변경)
    await sequelize.sync({ alter: true });
    console.log('✅ 테이블 동기화 완료');
  } catch (err) {
    console.error('❌ MySQL 연결 실패:', err.message);
    process.exit(1);
  }
}

module.exports = { sequelize, connectDB };
