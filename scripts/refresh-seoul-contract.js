require('dotenv').config();

const { sequelize } = require('../models');
const seoulContractCrawler = require('../services/seoul-contract-crawler');

async function main() {
  try {
    console.log('[MANUAL] 서울 계약마당 강제 갱신 시작');

    await sequelize.authenticate();
    console.log('[MANUAL] DB 연결 성공');

    const result = await seoulContractCrawler.crawl({
      fetchDetail: true,
      forceRefreshDetail: true,
      maxPages: Number(process.env.SEOUL_CONTRACT_PAGES_FULL || 8),
      recordCount: Number(process.env.SEOUL_CONTRACT_RECORD_COUNT || 50),
    });

    console.log('[MANUAL] 서울 계약마당 강제 갱신 완료');
    console.log(result);

    process.exit(0);
  } catch (err) {
    console.error('[MANUAL] 서울 계약마당 강제 갱신 실패');
    console.error(err);
    process.exit(1);
  }
}

main();
