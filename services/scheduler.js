const cron = require('node-cron');
const { Op } = require('sequelize');

const g2bCrawler = require('./g2b-crawler');
const seoulContractCrawler = require('./seoul-contract-crawler');
const localGovCrawler = require('./local-gov-crawler');
const Notice = require('../models/Notice');

const ENABLED_COLLECTOR_SOURCES = (
  process.env.ENABLED_COLLECTOR_SOURCES || 'g2b_api,seoul_contract,local_gov'
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// G2B 설정
const G2B_BACKFILL_HOURS = Number(process.env.G2B_BACKFILL_HOURS || 72);
const G2B_BACKFILL_CRON = process.env.G2B_BACKFILL_CRON || '0,30 * * * *';
const G2B_OPEN_RESYNC_CRON =
  process.env.G2B_OPEN_RESYNC_CRON || '15 0,6,12,18 * * *';
const G2B_OPEN_RESYNC_FALLBACK_DAYS = Number(
  process.env.G2B_OPEN_RESYNC_FALLBACK_DAYS || 30
);
const G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS = Number(
  process.env.G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS || 90
);
const G2B_OPEN_RESYNC_BUFFER_HOURS = Number(
  process.env.G2B_OPEN_RESYNC_BUFFER_HOURS || 6
);

// LOCAL GOV 설정
const LOCAL_GOV_CRON = process.env.LOCAL_GOV_CRON || '10,40 8-18 * * *';
const LOCAL_GOV_MAX_PAGES = Number(process.env.LOCAL_GOV_MAX_PAGES || 2);

// startup 보정수집은 일반 수집보다 넓게 본다
const LOCAL_GOV_STARTUP_MAX_PAGES = Number(
  process.env.LOCAL_GOV_STARTUP_MAX_PAGES || 20
);
const LOCAL_GOV_STARTUP_LOOKBACK_DAYS = Number(
  process.env.LOCAL_GOV_STARTUP_LOOKBACK_DAYS || 90
);
const LOCAL_GOV_STARTUP_ENABLED =
  process.env.LOCAL_GOV_STARTUP_ENABLED !== 'false';

let runningMinuteJob = false;
let runningSeoulContractJob = false;
let runningPurgeJob = false;
let runningLocalGovJob = false;
let runningG2bSyncJob = '';

function createMonitorEntry(key, label, options = {}) {
  return {
    key,
    label,
    kind: options.kind || 'collector',
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    schedules: Array.isArray(options.schedules) ? options.schedules : [],
    running: false,
    lastJob: '',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: '',
    lastSkippedAt: null,
    lastSkippedReason: '',
    lastDurationMs: null,
    lastResult: null,
    updatedAt: null,
    _startedAtMs: null,
  };
}

const collectorMonitor = {
  g2b_api: createMonitorEntry('g2b_api', '나라장터 G2B', {
    kind: 'collector',
    schedules: ['minute-window', G2B_BACKFILL_CRON, G2B_OPEN_RESYNC_CRON],
  }),
  seoul_contract: createMonitorEntry('seoul_contract', '서울 계약마당', {
    kind: 'collector',
    schedules: ['0 9 * * *', '0 17 * * *'],
  }),
  local_gov: createMonitorEntry('local_gov', '지자체 공고', {
    kind: 'collector',
    schedules: [LOCAL_GOV_CRON],
  }),
  purge_expired: createMonitorEntry('purge_expired', '만료 공고 삭제', {
    kind: 'maintenance',
    enabled: true,
    schedules: ['5 0 * * *'],
  }),
};

function cloneMonitorEntry(entry) {
  return {
    key: entry.key,
    label: entry.label,
    kind: entry.kind,
    enabled: entry.enabled,
    schedules: entry.schedules,
    running: entry.running,
    lastJob: entry.lastJob,
    lastStartedAt: entry.lastStartedAt,
    lastFinishedAt: entry.lastFinishedAt,
    lastSuccessAt: entry.lastSuccessAt,
    lastErrorAt: entry.lastErrorAt,
    lastErrorMessage: entry.lastErrorMessage,
    lastSkippedAt: entry.lastSkippedAt,
    lastSkippedReason: entry.lastSkippedReason,
    lastDurationMs: entry.lastDurationMs,
    lastResult: entry.lastResult,
    updatedAt: entry.updatedAt,
  };
}

function normalizeMonitorResult(result) {
  if (result == null) return null;
  if (typeof result !== 'object') return { value: result };

  const allowed = [
    'new',
    'updated',
    'errors',
    'parsed',
    'kept',
    'newCount',
    'updatedCount',
    'errorCount',
    'parsedCount',
    'attachmentNoticeCount',
    'attachmentFileCount',
    'deleted',
    'reason',
    'dateWindow',
  ];

  const out = {};
  allowed.forEach((key) => {
    if (result[key] !== undefined) out[key] = result[key];
  });
  return out;
}

function syncCollectorEnabledState() {
  ['g2b_api', 'seoul_contract', 'local_gov'].forEach((key) => {
    if (collectorMonitor[key]) {
      collectorMonitor[key].enabled = isSourceEnabled(key);
    }
  });
}

function markMonitorStart(key, jobName) {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = true;
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastStartedAt = nowIso;
  entry.lastErrorMessage = '';
  entry.updatedAt = nowIso;
  entry._startedAtMs = Date.now();
}

function markMonitorSuccess(key, jobName, result = null) {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = false;
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastFinishedAt = nowIso;
  entry.lastSuccessAt = nowIso;
  entry.lastDurationMs = entry._startedAtMs ? Date.now() - entry._startedAtMs : null;
  entry.lastResult = normalizeMonitorResult(result);
  entry.updatedAt = nowIso;
  entry._startedAtMs = null;
}

function markMonitorError(key, jobName, err, result = null) {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = false;
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastFinishedAt = nowIso;
  entry.lastErrorAt = nowIso;
  entry.lastErrorMessage = err ? String(err.message || err) : 'unknown_error';
  entry.lastDurationMs = entry._startedAtMs ? Date.now() - entry._startedAtMs : null;
  entry.lastResult = normalizeMonitorResult(result);
  entry.updatedAt = nowIso;
  entry._startedAtMs = null;
}

function markMonitorSkipped(key, reason, jobName = '') {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = isCollectorRunning(key);
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastSkippedAt = nowIso;
  entry.lastSkippedReason = reason || '';
  entry.updatedAt = nowIso;
}

function isCollectorRunning(key) {
  if (key === 'g2b_api') {
    return Boolean(runningMinuteJob || runningG2bSyncJob);
  }

  if (key === 'seoul_contract') {
    return Boolean(runningSeoulContractJob);
  }

  if (key === 'local_gov') {
    return Boolean(runningLocalGovJob);
  }

  if (key === 'purge_expired') {
    return Boolean(runningPurgeJob);
  }

  return false;
}

function syncCollectorRunningState() {
  Object.keys(collectorMonitor).forEach((key) => {
    collectorMonitor[key].running = isCollectorRunning(key);
  });
}

function getCollectorStatusItem(key) {
  syncCollectorEnabledState();
  syncCollectorRunningState();
  const entry = collectorMonitor[key];
  return entry ? cloneMonitorEntry(entry) : null;
}

function getCollectorStatuses() {
  syncCollectorEnabledState();
  syncCollectorRunningState();
  return {
    generatedAt: new Date().toISOString(),
    items: Object.values(collectorMonitor).map(cloneMonitorEntry),
  };
}

function parseCsvList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

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
      0,
      0,
      0,
      0
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
    console.log(
      `[스케줄러] ${jobName} 건너뜀 — 다른 G2B 작업 실행 중 (${runningG2bSyncJob})`
    );
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
  if (runningPurgeJob) {
    markMonitorSkipped('purge_expired', 'already_running', 'purge');
    return;
  }
  runningPurgeJob = true;
  markMonitorStart('purge_expired', 'purge');

  try {
    const deleted = await Notice.destroy({
      where: {
        closing_at: {
          [Op.lt]: new Date(),
        },
      },
    });

    console.log(`[스케줄러] 만료 공고 삭제 완료 — ${deleted}건`);
    markMonitorSuccess('purge_expired', 'purge', { deleted });
    return { deleted };
  } catch (err) {
    console.error('[스케줄러] 만료 공고 삭제 실패', err.message);
    markMonitorError('purge_expired', 'purge', err);
    throw err;
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
    markMonitorSkipped('g2b_api', 'minute_already_running', 'minute');
    return;
  }

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'minute');
    return;
  }

  const kst = getKstNow();
  const hour = kst.getUTCHours();

  if (hour < 8 || hour >= 19) {
    console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
    markMonitorSkipped('g2b_api', `out_of_window_${hour}`, 'minute');
    return;
  }

  if (!tryStartG2bSync('minute')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'minute');
    return;
  }

  runningMinuteJob = true;
  markMonitorStart('g2b_api', 'minute');

  try {
    console.log(
      `[스케줄러] 분단위 수집 실행 — ${formatKstDate(kst)} ${String(hour).padStart(
        2,
        '0'
      )}시`
    );

    await purgeExpiredNotices();
    const result = await g2bCrawler.crawl({ minuteMode: true });
    markMonitorSuccess('g2b_api', 'minute', result);
  } catch (err) {
    console.error('[스케줄러] 분단위 수집 실패', err.message);
    markMonitorError('g2b_api', 'minute', err);
  } finally {
    runningMinuteJob = false;
    finishG2bSync('minute');
  }
}

async function runG2bBackfill(hours = G2B_BACKFILL_HOURS) {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'backfill');
    return;
  }

  if (!tryStartG2bSync('backfill')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'backfill');
    return;
  }

  markMonitorStart('g2b_api', 'backfill');

  try {
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - hours * 60 * 60 * 1000);

    const result = await runG2bRangeSync(`G2B 보정 수집(${hours}h)`, fromDate, toDate);
    markMonitorSuccess('g2b_api', 'backfill', result);
  } catch (err) {
    console.error('[스케줄러] G2B 보정 수집 실패', err.message);
    markMonitorError('g2b_api', 'backfill', err);
  } finally {
    finishG2bSync('backfill');
  }
}

async function runG2bStartupBackfill() {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'startup_backfill');
    return;
  }

  if (!tryStartG2bSync('startup_backfill')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'startup_backfill');
    return;
  }

  markMonitorStart('g2b_api', 'startup_backfill');

  try {
    const fromDate = getKstStartOfDay(1);
    const toDate = new Date();

    const result = await runG2bRangeSync('G2B 기동 보정 수집(오늘+어제)', fromDate, toDate);
    markMonitorSuccess('g2b_api', 'startup_backfill', result);
  } catch (err) {
    console.error('[스케줄러] G2B 기동 보정 수집 실패', err.message);
    markMonitorError('g2b_api', 'startup_backfill', err);
  } finally {
    finishG2bSync('startup_backfill');
  }
}

async function runG2bOpenNoticeResync() {
  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'open_resync');
    return;
  }

  if (!tryStartG2bSync('open_resync')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'open_resync');
    return;
  }

  markMonitorStart('g2b_api', 'open_resync');

  try {
    const now = new Date();

    const earliestOpenNotice = await Notice.findOne({
      attributes: ['published_at'],
      where: {
        source_system: 'g2b_api',
        published_at: { [Op.ne]: null },
        [Op.or]: [{ closing_at: null }, { closing_at: { [Op.gte]: now } }],
      },
      order: [['published_at', 'ASC']],
      raw: true,
    });

    let fromDate;

    if (earliestOpenNotice?.published_at) {
      const buffered = new Date(
        new Date(earliestOpenNotice.published_at).getTime() -
          G2B_OPEN_RESYNC_BUFFER_HOURS * 60 * 60 * 1000
      );

      const maxLookbackFloor = new Date(
        now.getTime() -
          G2B_OPEN_RESYNC_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
      );

      fromDate = buffered < maxLookbackFloor ? maxLookbackFloor : buffered;
    } else {
      fromDate = new Date(
        now.getTime() -
          G2B_OPEN_RESYNC_FALLBACK_DAYS * 24 * 60 * 60 * 1000
      );
    }

    const result = await runG2bRangeSync('G2B 미마감 공고 재동기화', fromDate, now);
    markMonitorSuccess('g2b_api', 'open_resync', result);
  } catch (err) {
    console.error('[스케줄러] G2B 미마감 공고 재동기화 실패', err.message);
    markMonitorError('g2b_api', 'open_resync', err);
  } finally {
    finishG2bSync('open_resync');
  }
}

async function runSeoulContractTwiceDaily() {
  if (!isSourceEnabled('seoul_contract')) {
    console.log('[스케줄러] seoul_contract 비활성화 상태');
    markMonitorSkipped('seoul_contract', 'source_disabled', 'scheduled');
    return;
  }

  if (runningSeoulContractJob) {
    console.log('[스케줄러] 서울 계약마당 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('seoul_contract', 'already_running', 'scheduled');
    return;
  }

  runningSeoulContractJob = true;
  markMonitorStart('seoul_contract', 'scheduled');

  try {
    const today = formatKstDate();
    console.log(`[스케줄러] 서울 계약마당 정기 수집 실행 — ${today}`);

    await purgeExpiredNotices();

    const result = await seoulContractCrawler.crawl({
      fetchDetail: true,
      forceRefreshDetail: false,
      maxPages: Number(process.env.SEOUL_CONTRACT_PAGES_FULL || 8),
      recordCount: Number(process.env.SEOUL_CONTRACT_RECORD_COUNT || 50),
    });
    markMonitorSuccess('seoul_contract', 'scheduled', result);
  } catch (err) {
    console.error('[스케줄러] 서울 계약마당 정기 수집 실패', err.message);
    markMonitorError('seoul_contract', 'scheduled', err);
  } finally {
    runningSeoulContractJob = false;
  }
}

async function runLocalGovRegularCollection(reason = 'scheduled', options = {}) {
  if (!isSourceEnabled('local_gov')) {
    console.log('[스케줄러] local_gov 비활성화 상태');
    markMonitorSkipped('local_gov', 'source_disabled', reason);
    return;
  }

  if (runningLocalGovJob) {
    console.log('[스케줄러] local_gov 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('local_gov', 'already_running', reason);
    return;
  }

  runningLocalGovJob = true;
  markMonitorStart('local_gov', reason);

  try {
    const configuredKeys = parseCsvList(process.env.LOCAL_GOV_KEYS);
    const targetKeys =
      Array.isArray(options.keys) && options.keys.length
        ? options.keys
        : configuredKeys.length
        ? configuredKeys
        : undefined;

    const maxPages =
      Number(options.maxPages) > 0
        ? Number(options.maxPages)
        : LOCAL_GOV_MAX_PAGES;

    const lookbackDays =
      Number(options.lookbackDays) > 0 ? Number(options.lookbackDays) : 0;

    console.log(
      `[스케줄러] local_gov 정기 수집 실행 (${reason}) — maxPages=${maxPages}${
        lookbackDays > 0 ? ` lookbackDays=${lookbackDays}` : ''
      }${targetKeys?.length ? ` keys=${targetKeys.join(',')}` : ''}`
    );

    await purgeExpiredNotices();

    const result = await localGovCrawler.crawl({
      maxPages,
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    });

    console.log(
      `[스케줄러] local_gov 정기 수집 완료 (${reason}) — parsed=${result.parsed} kept=${result.kept} new=${result.newCount} updated=${result.updatedCount} errors=${result.errorCount}`
    );
    markMonitorSuccess('local_gov', reason, result);
  } catch (err) {
    console.error(`[스케줄러] local_gov 정기 수집 실패 (${reason})`, err.message);
    markMonitorError('local_gov', reason, err);
  } finally {
    runningLocalGovJob = false;
  }
}

function runCollectorNow(key, payload = {}) {
  const collectorKey = String(key || '').trim();
  const allowedKeys = ['g2b_api', 'seoul_contract', 'local_gov'];

  if (!allowedKeys.includes(collectorKey)) {
    return {
      ok: false,
      started: false,
      code: 'invalid_collector',
      message: '지원하지 않는 수집기입니다.',
      item: null,
    };
  }

  const label = collectorMonitor[collectorKey]?.label || collectorKey;

  if (!isSourceEnabled(collectorKey)) {
    markMonitorSkipped(collectorKey, 'manual_source_disabled', 'manual');
    return {
      ok: false,
      started: false,
      code: 'disabled',
      message: `${label} 수집기는 현재 비활성화 상태입니다.`,
      item: getCollectorStatusItem(collectorKey),
    };
  }

  if (isCollectorRunning(collectorKey)) {
    markMonitorSkipped(collectorKey, 'manual_already_running', 'manual');
    return {
      ok: false,
      started: false,
      code: 'already_running',
      message: `${label} 수집기가 이미 실행 중입니다.`,
      item: getCollectorStatusItem(collectorKey),
    };
  }

  const options = payload && typeof payload === 'object' ? payload : {};
  let taskPromise;

  if (collectorKey === 'g2b_api') {
    const hours = Number(options.hours) > 0 ? Number(options.hours) : G2B_BACKFILL_HOURS;
    taskPromise = runG2bBackfill(hours);
  } else if (collectorKey === 'seoul_contract') {
    taskPromise = runSeoulContractTwiceDaily();
  } else if (collectorKey === 'local_gov') {
    taskPromise = runLocalGovRegularCollection('manual', {
      ...(Number(options.maxPages) > 0 ? { maxPages: Number(options.maxPages) } : {}),
      ...(Number(options.lookbackDays) > 0
        ? { lookbackDays: Number(options.lookbackDays) }
        : {}),
      ...(Array.isArray(options.keys) && options.keys.length ? { keys: options.keys } : {}),
    });
  }

  Promise.resolve(taskPromise).catch((err) => {
    console.error(`[스케줄러] 수동 실행 예외 (${collectorKey})`, err.message);
  });

  return {
    ok: true,
    started: true,
    code: 'started',
    message: `${label} 수동 실행을 시작했습니다.`,
    item: getCollectorStatusItem(collectorKey),
  };
}

async function initialLoad() {
  try {
    const count = await Notice.count();
    console.log(`[스케줄러] 초기 점검 — notices ${count}건`);

    await purgeExpiredNotices();
    await runG2bStartupBackfill();

    if (LOCAL_GOV_STARTUP_ENABLED) {
      await runLocalGovRegularCollection('startup', {
        maxPages: LOCAL_GOV_STARTUP_MAX_PAGES,
        lookbackDays: LOCAL_GOV_STARTUP_LOOKBACK_DAYS,
      });
    }

    // 초기 기동 시에는 서울 계약마당 자동 실행하지 않음
  } catch (err) {
    console.error('[스케줄러] 초기 로드 실패', err.message);
  }
}

function start() {
  syncCollectorEnabledState();
  console.log(`[스케줄러] 활성 수집기: ${ENABLED_COLLECTOR_SOURCES.join(', ')}`);

  cron.schedule('* * * * *', runMinuteCollectors, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule(G2B_BACKFILL_CRON, () => runG2bBackfill(), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule(G2B_OPEN_RESYNC_CRON, runG2bOpenNoticeResync, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule(LOCAL_GOV_CRON, () => runLocalGovRegularCollection('scheduled'), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('5 0 * * *', purgeExpiredNotices, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 9 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 17 * * *', runSeoulContractTwiceDaily, {
    timezone: 'Asia/Seoul',
  });

  console.log('[스케줄러] 분단위 수집 등록 완료');
  console.log(`[스케줄러] G2B 보정 수집 등록 완료 (${G2B_BACKFILL_CRON})`);
  console.log(
    `[스케줄러] G2B 미마감 재동기화 등록 완료 (${G2B_OPEN_RESYNC_CRON})`
  );
  console.log(`[스케줄러] local_gov 정기 수집 등록 완료 (${LOCAL_GOV_CRON})`);
  console.log(
    `[스케줄러] local_gov startup 보정수집 설정 — lookbackDays=${LOCAL_GOV_STARTUP_LOOKBACK_DAYS}, maxPages=${LOCAL_GOV_STARTUP_MAX_PAGES}`
  );
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
  getCollectorStatuses,
  getCollectorStatusItem,
  runCollectorNow,
  purgeExpiredNotices,
  runG2bBackfill,
  runG2bStartupBackfill,
  runG2bOpenNoticeResync,
  runLocalGovRegularCollection,
};
