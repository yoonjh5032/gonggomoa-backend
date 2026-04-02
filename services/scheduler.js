const cron = require('node-cron');
const g2bCrawler = require('./g2b-crawler');
const seoulContractCrawler = require('./seoul-contract-crawler');
const Notice = require('../models/Notice');

const ENABLED_COLLECTOR_SOURCES = (
  process.env.ENABLED_COLLECTOR_SOURCES || 'g2b_api,seoul_contract'
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

let runningMinuteJob = false;
let runningSeoulContractJob = false;
let runningPurgeJob = false;

function isSourceEnabled(source) {
  return ENABLED_COLLECTOR_SOURCES.includes(source);
}

function getEnabledCollectorSources() {
  return ENABLED_COLLECTOR_SOURCES;
}

function getKstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function formatKstDate(date = getKstNow()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function purgeExpiredNotices() {
  if (runningPurgeJob) return;
  runningPurgeJob = true;

  try {
    const deleted = await Notice.destroy({
      where: {
        closing_at: {
          [Notice.sequelize.Sequelize.Op.lt]: new Date(),
        },
      },
    });

    console.log(`[스케줄러] 만료 공고 삭제 완료 — ${deleted}건`);
  } catch (err) {
    console.error('[스케줄러] 만료 공고 삭제 실패', err.message);
  } finally {
    runningPurgeJob = false;
  }
}

async function runMinuteCollectors() {
  if (runningMinuteJob) {
    console.log('[스케줄러] 분단위 수집 이미 실행 중, 건너뜀');
    return;
  }

  const kst = getKstNow();
  const hour = kst.getUTCHours();

  // 기존 정책 유지: 분단위 수집은 08~19시만
  if (hour < 8 || hour >= 19) {
    console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
    return;
  }

  runningMinuteJob = true;

  try {
    console.log(`[스케줄러] 분단위 수집 실행 — ${formatKstDate(kst)} ${String(hour).padStart(2, '0')}시`);

    await purgeExpiredNotices();

    if (isSourceEnabled('g2b_api')) {
      await g2bCrawler.crawl({ minuteMode: true });
    }

    // seoul_contract는 페이지 부담 때문에 여기서 돌리지 않음
  } catch (err) {
    console.error('[스케줄러] 분단위 수집 실패', err.message);
  } finally {
    runningMinuteJob = false;
  }
}

async function runSeoulContractTwiceDaily() {
  if (!isSourceEnabled('seoul_contract')) {
    console.log('[스케줄러] seoul_contract 비활성화 상태');
    return;
  }

  if (runningSeoulContractJob) {
    console.log('[스케줄러] 서울 계약마당 수집 이미 실행 중, 건너뜀');
    return;
  }

  runningSeoulContractJob = true;

  try {
    const today = formatKstDate();
    console.log(`[스케줄러] 서울 계약마당 정기 수집 실행 — ${today}`);

    await purgeExpiredNotices();

    await seoulContractCrawler.crawl({
      fetchDetail: true,
      forceRefreshDetail: false,
      maxPages: Number(process.env.SEOUL_CONTRACT_PAGES_FULL || 8),
      recordCount: Number(process.env.SEOUL_CONTRACT_RECORD_COUNT || 50),
    });
  } catch (err) {
    console.error('[스케줄러] 서울 계약마당 정기 수집 실패', err.message);
  } finally {
    runningSeoulContractJob = false;
  }
}

async function initialLoad() {
  try {
    const count = await Notice.count();
    console.log(`[스케줄러] 초기 점검 — notices ${count}건`);

    await purgeExpiredNotices();

    // 초기 기동 시에는 서울 계약마당 자동 실행하지 않음
    // (페이지 부담 최소화 목적)
    // 필요 시 수동으로만 실행
  } catch (err) {
    console.error('[스케줄러] 초기 로드 실패', err.message);
  }
}

function start() {
  console.log(`[스케줄러] 활성 수집기: ${ENABLED_COLLECTOR_SOURCES.join(', ')}`);

  // G2B 등 분단위 수집
  cron.schedule('* * * * *', runMinuteCollectors, {
    timezone: 'Asia/Seoul',
  });

  // 만료 공고 정리: 매일 00:05 KST
  cron.schedule('5 0 * * *', purgeExpiredNotices, {
    timezone: 'Asia/Seoul',
  });

  // 서울 계약마당: 하루 2회만
  // 09:00 KST
  cron.schedule('0 9 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  // 17:00 KST
  cron.schedule('0 17 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  console.log('[스케줄러] 분단위 수집 등록 완료');
  console.log('[스케줄러] 만료 삭제 스케줄 등록 완료 (매일 00:05 KST)');
  console.log('[스케줄러] 서울 계약마당 스케줄 등록 완료 (매일 09:00, 17:00 KST)');

  setTimeout(() => {
    initialLoad().catch((err) => {
      console.error('[스케줄러] 초기 로드 예외', err.message);
    });
  }, 5000);
}

module.exports = {
  start,
  getEnabledCollectorSources,
  purgeExpiredNotices,
};
