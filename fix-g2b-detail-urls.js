require('dotenv').config();

const { Op } = require('sequelize');
const { connectDB } = require('./config/db');
const Notice = require('./models/Notice');

function buildNewG2bUrl(bidNtceNo, bidNtceOrd) {
  if (!bidNtceNo) return '';

  const ord = String(bidNtceOrd || '000').padStart(3, '0');

  return `https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=${encodeURIComponent(bidNtceNo)}&bidPbancOrd=${encodeURIComponent(ord)}`;
}

async function run() {
  try {
    await connectDB();
    console.log('✅ DB 연결 및 테이블 확인 완료');

    const targets = await Notice.findAll({
      where: {
        source_system: 'g2b_api',
        [Op.or]: [
          { detail_url: { [Op.like]: 'https://www.g2b.go.kr:8101/%' } },
          { detail_url: null },
          { detail_url: '' },
          { detail_url: 'undefined' },
          { detail_url: 'null' }
        ]
      },
      order: [['id', 'ASC']]
    });

    console.log(`🔎 수정 대상 G2B 공고: ${targets.length}건`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const notice of targets) {
      try {
        const bidNo = String(notice.bid_ntce_no || '').trim();
        const bidOrd = String(notice.bid_ntce_ord || '').trim();

        if (!bidNo) {
          console.warn(`⚠️ 건너뜀: id=${notice.id} / bid_ntce_no 없음`);
          skipped++;
          continue;
        }

        const newUrl = buildNewG2bUrl(bidNo, bidOrd);

        if (!newUrl) {
          console.warn(`⚠️ 건너뜀: id=${notice.id} / 새 URL 생성 실패`);
          skipped++;
          continue;
        }

        notice.detail_url = newUrl;
        await notice.save();

        updated++;
        console.log(`✅ 수정 완료: id=${notice.id} / ${newUrl}`);
      } catch (err) {
        failed++;
        console.error(`❌ 수정 실패: id=${notice.id}`, err.message);
      }
    }

    console.log('────────────────────────────────');
    console.log(`✅ 업데이트 완료: ${updated}건`);
    console.log(`ℹ️ 건너뜀: ${skipped}건`);
    console.log(`❌ 실패: ${failed}건`);
    console.log('────────────────────────────────');

    process.exit(0);
  } catch (err) {
    console.error('❌ fix-g2b-detail-urls 실행 실패:', err);
    process.exit(1);
  }
}

run();
