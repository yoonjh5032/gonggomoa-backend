const cron = require('node-cron');
const g2bCrawler = require('./g2b-crawler');

let isRunning = false;

async function runCrawl() {
  if (isRunning) {
    console.log('[스케줄러] 이전 작업이 진행 중, 건너뜀');
    return;
  }

  isRunning = true;
  try {
    const nowKst = new Date(Date.now() + 9 * 3600000);
    const hour = nowKst.getUTCHours();
    const minute = String(nowKst.getUTCMinutes()).padStart(2, '0');

    if (hour < 8 || hour >= 19) {
      console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
      return;
    }

    console.log(`[스케줄러] KST ${hour}:${minute} — 수집 시작`);
    await g2bCrawler.crawl({ minuteMode: true });
  } catch (err) {
    console.error('[스케줄러] 에러:', err.message);
  } finally {
    isRunning = false;
  }
}

async function backfill(days) {
  console.log(`[스케줄러] 초기 백필 시작 — 최근 ${days}일 수집`);
  let collected = 0;
  let updated = 0;
  let errors = 0;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() + 9 * 3600000 - i * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const from = `${y}${m}${day}0000`;
    const to = `${y}${m}${day}2359`;

    console.log(`[백필] ${y}-${m}-${day} 수집`);
    try {
      const result = await g2bCrawler.crawl({ minuteMode: false, from, to });
      collected += result.new;
      updated += result.updated;
      errors += result.errors;
    } catch (err) {
      console.error(`[백필] ${y}-${m}-${day} 에러:`, err.message);
      errors += 1;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[스케줄러] 초기 백필 완료 — 신규 ${collected}, 갱신 ${updated}, 에러 ${errors}`);
}

function start() {
  cron.schedule('* * * * *', runCrawl, { timezone: 'Asia/Seoul' });
  console.log('[스케줄러] 크론 등록 완료 — 매 분 실행 (KST 08:00~19:00)');

  const BACKFILL_DAYS = Math.max(parseInt(process.env.BACKFILL_DAYS || '30', 10), 1);

  setTimeout(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await backfill(BACKFILL_DAYS);
    } catch (err) {
      console.error('[스케줄러] 초기 적재 에러:', err.message);
    } finally {
      isRunning = false;
    }
  }, 5000);
}

module.exports = { start };