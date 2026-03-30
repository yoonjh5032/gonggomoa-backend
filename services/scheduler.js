/* ═══════════════════════════════════════════════════════════
   services/scheduler.js
   node-cron 기반 스케줄러 (MySQL 버전 — 동일)
═══════════════════════════════════════════════════════════ */
const cron       = require('node-cron');
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
    const hour   = nowKst.getUTCHours();

    if (hour < 8 || hour >= 19) {
      console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
      return;
    }

    console.log(`[스케줄러] KST ${hour}:${String(nowKst.getUTCMinutes()).padStart(2,'0')} — 수집 시작`);
    await g2bCrawler.crawl({ minuteMode: true });

    // ─── 향후 확장 ───
    // await nonghyupCrawler.crawl();
    // await localGovCrawler.crawl();

  } catch (err) {
    console.error('[스케줄러] 에러:', err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  cron.schedule('* * * * *', runCrawl, { timezone: 'Asia/Seoul' });
  console.log('[스케줄러] 크론 등록 완료 — 매 분 실행 (KST 08:00~19:00)');

  // 서버 시작 시 즉시 1회 실행
  setTimeout(async () => {
    console.log('[스케줄러] 초기 데이터 적재 시작 (오늘 하루치)...');
    isRunning = true;
    try {
      await g2bCrawler.crawl({ minuteMode: false });
    } catch (err) {
      console.error('[스케줄러] 초기 적재 에러:', err.message);
    } finally {
      isRunning = false;
    }
  }, 5000);
}

module.exports = { start };
