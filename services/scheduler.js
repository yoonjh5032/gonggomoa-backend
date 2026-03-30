/* ═══════════════════════════════════════════════════════════
   services/scheduler.js
   node-cron 기반 스케줄러 (초기 과거 데이터 수집 포함)
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
      console.log('[스케줄러] KST ' + hour + '시 — 수집 시간 범위 밖, 건너뜀');
      return;
    }

    console.log('[스케줄러] KST ' + hour + ':' + String(nowKst.getUTCMinutes()).padStart(2,'0') + ' — 수집 시작');
    await g2bCrawler.crawl({ minuteMode: true });

  } catch (err) {
    console.error('[스케줄러] 에러:', err.message);
  } finally {
    isRunning = false;
  }
}

/* ── 과거 N일 치 데이터 한꺼번에 수집 ── */
async function backfill(days) {
  console.log('[스케줄러] ★ 과거 ' + days + '일치 데이터 수집 시작...');
  var collected = 0;

  for (var i = days; i >= 0; i--) {
    var d = new Date(Date.now() + 9 * 3600000 - i * 86400000);
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var from = y + '' + m + '' + dd + '0000';
    var to   = y + '' + m + '' + dd + '2359';

    console.log('[백필] ' + (days - i + 1) + '/' + (days + 1) + ' — ' + y + '-' + m + '-' + dd);

    try {
      var result = await g2bCrawler.crawl({ minuteMode: false, from: from, to: to });
      collected += result.new;
    } catch (err) {
      console.error('[백필] 에러:', err.message);
    }

    // API Rate limit 방지 (1초 대기)
    await new Promise(function(r) { setTimeout(r, 1000); });
  }

  console.log('[스케줄러] ★ 과거 데이터 수집 완료! 총 ' + collected + '건 신규 수집');
}

function start() {
  cron.schedule('* * * * *', runCrawl, { timezone: 'Asia/Seoul' });
  console.log('[스케줄러] 크론 등록 완료 — 매 분 실행 (KST 08:00~19:00)');

  // ★ 서버 시작 시 과거 30일치 수집
  var BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS) || 30;

  setTimeout(async function() {
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
