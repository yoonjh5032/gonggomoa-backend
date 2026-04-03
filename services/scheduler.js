const cron = require('node-cron');
const { Op } = require('sequelize');
const g2bCrawler = require('./g2b-crawler');
const seoulContractCrawler = require('./seoul-contract-crawler');
const Notice = require('../models/Notice');

const ENABLED_COLLECTOR_SOURCES = (
  process.env.ENABLED_COLLECTOR_SOURCES || 'g2b_api,seoul_contract'
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const G2B_BACKFILL_HOURS = Number(process.env.G2B_BACKFILL_HOURS || 72);
const G2B_BACKFILL_CRON = process.env.G2B_BACKFILL_CRON || '0,30 * * * *';
const G2B_OPEN_RESYNC_CRON = process.env.G2B_OPEN_RESYNC_CRON || '15 0,6,12,18 * * *';
const G2B_OPEN_RESYNC_FALLBACK_DAYS = Number(process.env.G2B_OPEN_RESYNC_FALLBACK_DAYS || 30);
const G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS = Number(process.env.G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS || 90);
const G2B_OPEN_RESYNC_BUFFER_HOURS = Number(process.env.G2B_OPEN_RESYNC_BUFFER_HOURS || 6);

let runningMinuteJob = false;
let runningSeoulContractJob = false;
let runningPurgeJob = false;
let runningG2bSyncJob = '';

function isSourceEnabled(source) {
  return ENABLED_COLLECTOR_SOURCES.includes(source);
}

function getEnabledCollectorSources() {
  return ENABLED_COLLECTOR_SOURCES;
}

function getKstNow() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

function formatKstDate(date = getKstNow()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatKstDateTime(date = new Date()) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${d}${h}${mi}`;
}

function getKstStartOfDay(daysAgo = 0) {
  const nowKst = getKstNow();
  return new Date(
    Date.UTC(
      nowKst.getUTCFullYear(),
      nowKst.getUTCMonth(),
      nowKst.getUTCDate() - daysAgo,
      0, 0, 0, 0
    ) - KST_OFFSET_MS
  );
}

function buildKstRange(fromDate, toDate = new Date()) {
  return {
    from: formatKstDateTime(fromDate),
    to: formatKstDateTime(toDate),
  };
}

function tryStartG2bSync(jobName) {
  if (runningG2bSyncJob) {
    console.log(`[스케줄러] ${jobName} 건너뜀 — 다른 G2B 작업 실행 중 (${runningG2bSyncJob})`);
    return false;
  }
  runningG2bSyncJob = jobName;
  return true;
}

function finishG2bSync(jobName) {
  if (runningG2bSyncJob === jobName) {
    runningG2bSyncJob = '';
  }
}

async function purgeExpiredNotices() {
  if (runningPurgeJob) return;
  runningPurgeJob = true;

  try {
    const deleted = await Notice.destroy({
      where: {
        closing_at: {
          [Op.lt]: new Date(),
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

async function runG2bRangeSync(label, fromDate, toDate = new Date()) {
  const range = buildKstRange(fromDate, toDate);

  console.log(`[스케줄러] ${label} 실행 — ${range.from} ~ ${range.to}`);

  const result = await g2bCrawler.crawl({
    minuteMode: false,
    from: range.from,
    to: range.to,
  });

  console.log(
    `[스케줄러] ${label} 완료 — 신규 ${result.new}건 / 갱신 ${result.updated}건 / 에러 ${result.errors}건`
  );

  return result;
}

async function runMinuteCollectors() {
  if (runningMinuteJob) {
    console.log('[스케줄러] 분단위 수집 이미 실행 중, 건너뜀');
    return;
  }

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    return;
  }

  const kst = getKstNow();
  const hour = kst.getUTCHours();

  // 기존 정책 유지: 분단위 수집은 08~19시만
  if (hour < 8 || hour >= 19) {
    console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
    return;
  }

  if (!tryStartG2bSync('minute')) {
    return;
  }

  runningMinuteJob = true;

  try {
    console.log(
      `[스케줄러] 분단위 수집 실행 — ${formatKstDate(kst)} ${String(hour).padStart(2, '0')}시`
    );

    await purgeExpiredNotices();
    await g2bCrawler.crawl({ minuteMode: true });
  } catch (err) {
    console.error('[스케줄러] 분단위 수집 실패', err.message);
  } finally {
    runningMinuteJob = false;
    finishG2bSync('minute');
  }
}

async function runG2bBackfill(hours = G2B_BACKFILL_HOURS) {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    return;
  }

  if (!tryStartG2bSync('backfill')) {
    return;
  }

  try {
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - hours * 60 * 60 * 1000);

    await runG2bRangeSync(`G2B 보정 수집(${hours}h)`, fromDate, toDate);
  } catch (err) {
    console.error('[스케줄러] G2B 보정 수집 실패', err.message);
  } finally {
    finishG2bSync('backfill');
  }
}

async function runG2bStartupBackfill() {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    return;
  }

  if (!tryStartG2bSync('startup_backfill')) {
    return;
  }

  try {
    const fromDate = getKstStartOfDay(1); // 어제 00:00 KST
    const toDate = new Date(); // 현재 시각

    await runG2bRangeSync('G2B 기동 보정 수집(오늘+어제)', fromDate, toDate);
  } catch (err) {
    console.error('[스케줄러] G2B 기동 보정 수집 실패', err.message);
  } finally {
    finishG2bSync('startup_backfill');
  }
}

async function runG2bOpenNoticeResync() {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    return;
  }

  if (!tryStartG2bSync('open_resync')) {
    return;
  }

  try {
    const now = new Date();

    const earliestOpenNotice = await Notice.findOne({
      attributes: ['published_at'],
      where: {
        source_system: 'g2b_api',
        published_at: { [Op.ne]: null },
        [Op.or]: [
          { closing_at: null },
          { closing_at: { [Op.gte]: now } },
        ],
      },
      order: [['published_at', 'ASC']],
      raw: true,
    });

    let fromDate;

    if (earliestOpenNotice?.published_at) {
      const buffered = new Date(
        new Date(earliestOpenNotice.published_at).getTime()
          - G2B_OPEN_RESYNC_BUFFER_HOURS * 60 * 60 * 1000
      );

      const maxLookbackFloor = new Date(
        now.getTime() - G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
      );

      fromDate = buffered < maxLookbackFloor ? maxLookbackFloor : buffered;
    } else {
      fromDate = new Date(
        now.getTime() - G2B_OPEN_RESYNC_FALLBACK_DAYS * 24 * 60 * 60 * 1000
      );
    }

    await runG2bRangeSync('G2B 미마감 공고 재동기화', fromDate, now);
  } catch (err) {
    console.error('[스케줄러] G2B 미마감 공고 재동기화 실패', err.message);
  } finally {
    finishG2bSync('open_resync');
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
    await runG2bStartupBackfill();

    // 초기 기동 시에는 서울 계약마당 자동 실행하지 않음
    // (페이지 부담 최소화 목적)
  } catch (err) {
    console.error('[스케줄러] 초기 로드 실패', err.message);
  }
}

function start() {
  console.log(`[스케줄러] 활성 수집기: ${ENABLED_COLLECTOR_SOURCES.join(', ')}`);

  // G2B 분단위 실시간 수집
  cron.schedule('* * * * *', runMinuteCollectors, {
    timezone: 'Asia/Seoul',
  });

  // G2B 보정 수집: 30분마다 최근 72시간
  cron.schedule(G2B_BACKFILL_CRON, () => runG2bBackfill(), {
    timezone: 'Asia/Seoul',
  });

  // G2B 미마감 공고 재동기화: 하루 4회
  cron.schedule(G2B_OPEN_RESYNC_CRON, runG2bOpenNoticeResync, {
    timezone: 'Asia/Seoul',
  });

  // 만료 공고 정리: 매일 00:05 KST
  cron.schedule('5 0 * * *', purgeExpiredNotices, {
    timezone: 'Asia/Seoul',
  });

  // 서울 계약마당: 하루 2회
  cron.schedule('0 9 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 17 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  console.log('[스케줄러] 분단위 수집 등록 완료');
  console.log(`[스케줄러] G2B 보정 수집 등록 완료 (${G2B_BACKFILL_CRON})`);
  console.log(`[스케줄러] G2B 미마감 재동기화 등록 완료 (${G2B_OPEN_RESYNC_CRON})`);
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
  runG2bBackfill,
  runG2bStartupBackfill,
  runG2bOpenNoticeResync,
};
