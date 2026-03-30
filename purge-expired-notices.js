require('dotenv').config();

const { Op } = require('sequelize');
const { connectDB } = require('./config/db');
const Notice = require('./models/Notice');

async function run() {
  try {
    await connectDB();
    console.log('✅ DB 연결 및 테이블 확인 완료');

    const now = new Date();

    const targets = await Notice.findAll({
      where: {
        closing_at: {
          [Op.lt]: now
        }
      },
      attributes: ['id', 'title', 'closing_at', 'source_system'],
      order: [['closing_at', 'ASC']],
      raw: true
    });

    console.log(`🔎 삭제 대상 만료 공고: ${targets.length}건`);

    if (!targets.length) {
      console.log('ℹ️ 삭제할 만료 공고가 없습니다.');
      process.exit(0);
    }

    const deleted = await Notice.destroy({
      where: {
        closing_at: {
          [Op.lt]: now
        }
      }
    });

    console.log(`✅ 만료 공고 삭제 완료: ${deleted}건`);
    process.exit(0);
  } catch (err) {
    console.error('❌ purge-expired-notices 실행 실패:', err);
    process.exit(1);
  }
}

run();
