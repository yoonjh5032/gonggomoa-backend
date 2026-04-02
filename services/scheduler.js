const cron = require('node-cron');
const { Op } = require('sequelize');
const g2bCrawler = require('./g2b-crawler');
const seoulContractCrawler = require('./seoul-contract-crawler');
const Notice = require('../models/Notice');

const DEFAULT_ENABLED_COLLECTOR_SOURCES = ['g2b_api', 'seoul_contract'];
const VALID_SOURCES = new Set(DEFAULT_ENABLED_COLLECTOR_SOURCES);

const ENABLED_COLLECTOR_SOURCES = (() => {
  const raw = String(
    process.env.ENABLED_COLLECTOR_SOURCES ||
    DEFAULT_ENABLED_COLLECTOR_SOURCES.join(',')
  );

  const parsed = raw
    .split(',')
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter(v => VALID_SOURCES.has(v));

  return parsed.length ? parsed : DEFAULT_ENABLED_COLLECTOR_SOURCES.slice();
})();

let isRunning = false;

function getEnabledCollectorSources() {
  return ENABLED_COLLECTOR_SOURCES.slice();
}

function isSourceEnabled(source) {
  return ENABLED_COLLECTOR_SOURCES.includes(source);
}

function getKstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getSeoulContractMinuteInterval() {
  return Math.max(parseInt(process.env.SEOUL_CONTRACT_MINUTE_INTERVAL || '10', 10), 1);
}

async function purgeExpiredNotices() {
  const now = new Date();
  const deleted = await Notice.destroy({
    where: {
      closing_at: { [Op.lt]: now }
    }
  });

  if (deleted > 0) {
    console.log(`[정리] 마감 지난 공고 ${deleted}건 삭제 완료`);
  } else {
    console.log('[정리] 삭제할 마감 종료 공고 없음');
  }

  return deleted;
}

async function runMinuteCollectors(nowKst) {
  if (isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] 나라장터 증분 수집 시작');
    await g2bCrawler.crawl({ minuteMode: true });
  }

  if (isSourceEnabled('seoul_contract')) {
    const minute = nowKst.getUTCMinutes();
    const interval = getSeoulContractMinuteInterval();

    if (minute % interval === 0) {
      console.log(`[스케줄러] 서울 계약마당 증분 수집 시작 (매 ${interval}분 주기)`);
      await seoulContractCrawler.crawl({ minuteMode: true });
    } else {
      console.log(`[스케줄러] 서울 계약마당 대기 — ${interval}분 주기 미도달`);
    }
  }
}

async function runCrawl() {
  if (isRunning) {
    console.log('[스케줄러] 이전 작업이 진행 중, 건너뜀');
    return;
  }

  isRunning = true;

  try {
    const nowKst = getKstNow();
    const hour = nowKst.getUTCHours();
    const minute = String(nowKst.getUTCMinutes()).padStart(2, '0');

    if (hour < 8 || hour >= 19) {
      console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
      return;
    }

    console.log(`[스케줄러] KST ${hour}:${minute} — 만료 공고 정리 후 증분 수집 시작`);
    await purgeExpiredNotices();
    await runMinuteCollectors(nowKst);
  } catch (err) {
    console.error('[스케줄러] 에러:', err.message);
  } finally {
    isRunning = false;
  }
}

async function backfill(days) {
  console.log(`[스케줄러] 최초 1회 백필 시작 — 최근 ${days}일`);

  let collected = 0;
  let updated = 0;
  let errors = 0;

  if (isSourceEnabled('g2b_api')) {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() + 9 * 3600000 - i * 86400000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const from = `${y}${m}${day}0000`;
      const to = `${y}${m}${day}2359`;

      console.log(`[백필][G2B] ${y}-${m}-${day} 수집`);

      try {
        const result = await g2bCrawler.crawl({ minuteMode: false, from, to });
        collected += result.new || 0;
        updated += result.updated || 0;
        errors += result.errors || 0;
      } catch (err) {
        console.error(`[백필][G2B] ${y}-${m}-${day} 에러:`, err.message);
        errors += 1;
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (isSourceEnabled('seoul_contract')) {
    try {
      console.log('[백필][SEOUL CONTRACT] 계약마당 전체 동기화 실행');
      const result = await seoulContractCrawler.crawl({
        minuteMode: false,
        maxPages: parseInt(process.env.SEOUL_CONTRACT_PAGES_FULL || '8', 10)
      });

      collected += result.new || 0;
      updated += result.updated || 0;
      errors += result.errors || 0;
    } catch (err) {
      console.error('[백필][SEOUL CONTRACT] 에러:', err.message);
      errors += 1;
    }
  }

  console.log(`[스케줄러] 최초 백필 완료 — 신규 ${collected}, 갱신 ${updated}, 에러 ${errors}`);
}

async function loadTodayFull() {
  const nowKst = getKstNow();
  const y = nowKst.getUTCFullYear();
  const m = String(nowKst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(nowKst.getUTCDate()).padStart(2, '0');
  const from = `${y}${m}${day}0000`;
  const to = `${y}${m}${day}2359`;

  if (isSourceEnabled('g2b_api')) {
    console.log(`[스케줄러] 당일 전체 동기화 실행(나라장터) — ${y}-${m}-${day}`);
    await g2bCrawler.crawl({ minuteMode: false, from, to });
  }

  if (isSourceEnabled('seoul_contract')) {
    console.log(`[스케줄러] 당일 전체 동기화 실행(서울 계약마당) — ${y}-${m}-${day}`);
    await seoulContractCrawler.crawl({
      minuteMode: false,
      maxPages: parseInt(process.env.SEOUL_CONTRACT_PAGES_FULL || '8', 10)
    });
  }
}

async function initialLoad() {
  const BACKFILL_DAYS = Math.max(parseInt(process.env.BACKFILL_DAYS || '30', 10), 1);
  const noticeCount = await Notice.count();

  if (noticeCount === 0) {
    console.log('[스케줄러] notices 테이블이 비어 있어 최초 백필을 실행합니다.');
    await backfill(BACKFILL_DAYS);
    await purgeExpiredNotices();
    return;
  }

  console.log(`[스케줄러] 기존 데이터 ${noticeCount}건 확인 — 최초 백필은 건너뛰고 오늘 데이터만 동기화합니다.`);
  await purgeExpiredNotices();
  await loadTodayFull();
}

function start() {
  cron.schedule('* * * * *', runCrawl, { timezone: 'Asia/Seoul' });
  console.log('[스케줄러] 크론 등록 완료 — 매 분 실행 (KST 08:00~19:00)');
  console.log('[스케줄러] 활성 수집 소스:', getEnabledCollectorSources().join(', '));

  cron.schedule('5 0 * * *', async () => {
    try {
      console.log('[스케줄러] 자정 지난 공고 정리 실행');
      await purgeExpiredNotices();
    } catch (err) {
      console.error('[스케줄러] 만료 공고 정리 에러:', err.message);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('[스케줄러] 만료 공고 정리 크론 등록 완료 — 매일 00:05 KST');

  setTimeout(async () => {
    if (isRunning) return;

    isRunning = true;
    try {
      await initialLoad();
    } catch (err) {
      console.error('[스케줄러] 초기 적재 에러:', err.message);
    } finally {
      isRunning = false;
    }
  }, 5000);
}

module.exports = { start, getEnabledCollectorSources };
