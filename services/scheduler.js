const axios = require('axios');
const cron = require('node-cron');
const { Op } = require('sequelize');

const g2bCrawler = require('./g2b-crawler');
const seoulContractCrawler = require('./seoul-contract-crawler');
const localGovCrawler = require('./local-gov-crawler');
const provinceGovCrawler = require('./province-gov-crawler');
const Notice = require('../models/Notice');
const CollectorRunLog = require('../models/collector-run-log');

const ENABLED_COLLECTOR_SOURCES = (
  process.env.ENABLED_COLLECTOR_SOURCES || 'g2b_api,seoul_contract,local_gov,province_gov'
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

// PROVINCE GOV 설정
const PROVINCE_GOV_CRON = process.env.PROVINCE_GOV_CRON || '20,50 8-18 * * *';
const PROVINCE_GOV_MAX_PAGES = Number(process.env.PROVINCE_GOV_MAX_PAGES || 2);
const PROVINCE_GOV_STARTUP_MAX_PAGES = Number(
  process.env.PROVINCE_GOV_STARTUP_MAX_PAGES || 15
);
const PROVINCE_GOV_STARTUP_LOOKBACK_DAYS = Number(
  process.env.PROVINCE_GOV_STARTUP_LOOKBACK_DAYS || 60
);
const PROVINCE_GOV_STARTUP_ENABLED =
  process.env.PROVINCE_GOV_STARTUP_ENABLED !== 'false';

const COLLECTOR_LOG_LIMIT = Math.min(
  Math.max(Number(process.env.COLLECTOR_LOG_LIMIT || 200), 20),
  1000
);

const SLACK_WEBHOOK_URL = String(process.env.SLACK_WEBHOOK_URL || '').trim();
const COLLECTOR_ALERT_COOLDOWN_MINUTES = Math.max(
  Number(process.env.COLLECTOR_ALERT_COOLDOWN_MINUTES || 30),
  1
);
const COLLECTOR_STUCK_THRESHOLD_MINUTES = Math.max(
  Number(process.env.COLLECTOR_STUCK_THRESHOLD_MINUTES || 20),
  5
);
const COLLECTOR_WATCHDOG_CRON =
  process.env.COLLECTOR_WATCHDOG_CRON || '*/5 * * * *';

let runningMinuteJob = false;
let runningSeoulContractJob = false;
let runningPurgeJob = false;
let runningLocalGovJob = false;
let runningProvinceGovJob = false;
let runningG2bSyncJob = '';

const alertCooldownMap = new Map();

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
    _activeLogId: null,
    _activeLogPromise: null,
    _activeContext: null,
    _lastStuckAlertToken: '',
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
  local_gov: createMonitorEntry('local_gov', '서울시·구청 공고', {
    kind: 'collector',
    schedules: [LOCAL_GOV_CRON],
  }),
  province_gov: createMonitorEntry('province_gov', '지방·도청 공고', {
    kind: 'collector',
    schedules: [PROVINCE_GOV_CRON],
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

function safeJson(value) {
  if (value == null) return null;

  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return { value: String(value) };
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function truncateText(value, max = 300) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function inferTriggerType(jobName, context = {}) {
  if (context.triggerType) return String(context.triggerType);
  if (jobName === 'manual') return 'manual';
  if (String(jobName || '').includes('startup')) return 'startup';
  if (jobName === 'purge') return 'maintenance';
  return 'scheduled';
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;

  return {
    userId: Number(actor.userId) > 0 ? Number(actor.userId) : null,
    email: normalizeText(actor.email).slice(0, 255),
    name: normalizeText(actor.name).slice(0, 100),
    role: normalizeText(actor.role).slice(0, 20),
  };
}

function buildLogContext(jobName, context = {}) {
  const actor = normalizeActor(context.actor);
  return {
    triggerType: inferTriggerType(jobName, context),
    actor,
    requestPayload: safeJson(context.requestPayload),
    metadata: safeJson(context.metadata),
  };
}

function buildLogBase(entry, jobName, context = {}) {
  const normalized = buildLogContext(jobName, context);
  const actor = normalized.actor || {};

  return {
    collector_key: entry.key,
    collector_label: entry.label,
    kind: entry.kind,
    job_name: jobName || '',
    trigger_type: normalized.triggerType,
    actor_user_id: actor.userId || null,
    actor_email: actor.email || '',
    actor_name: actor.name || '',
    actor_role: actor.role || '',
    request_payload: normalized.requestPayload,
    metadata: normalized.metadata,
  };
}

function trimRunLogs() {
  Promise.resolve()
    .then(async () => {
      const total = await CollectorRunLog.count();
      if (total <= COLLECTOR_LOG_LIMIT) return;

      const overflow = total - COLLECTOR_LOG_LIMIT;
      const staleRows = await CollectorRunLog.findAll({
        attributes: ['id'],
        order: [['createdAt', 'ASC']],
        limit: overflow,
        raw: true,
      });

      const staleIds = staleRows.map((row) => row.id).filter(Boolean);
      if (!staleIds.length) return;

      await CollectorRunLog.destroy({ where: { id: { [Op.in]: staleIds } } });
    })
    .catch((err) => {
      console.error('[스케줄러] 수집기 로그 정리 실패', err.message);
    });
}

function persistStartedLog(key, jobName, context = {}) {
  const entry = collectorMonitor[key];
  if (!entry) return;

  const startedAt = entry.lastStartedAt ? new Date(entry.lastStartedAt) : new Date();
  const payload = {
    ...buildLogBase(entry, jobName, context),
    status: 'started',
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    result: null,
    error_message: '',
    skip_reason: '',
  };

  const promise = CollectorRunLog.create(payload)
    .then((row) => {
      entry._activeLogId = row.id;
      return row.id;
    })
    .catch((err) => {
      console.error(`[스케줄러] 실행 이력 시작 로그 저장 실패 (${key})`, err.message);
      return null;
    });

  entry._activeLogPromise = promise;
}

function persistTerminalLog(key, status, jobName, payload = {}, context = {}) {
  const entry = collectorMonitor[key];
  if (!entry) return;

  const finishedAt = payload.finishedAt instanceof Date ? payload.finishedAt : new Date();
  const startedAt = payload.startedAt instanceof Date
    ? payload.startedAt
    : (entry.lastStartedAt ? new Date(entry.lastStartedAt) : finishedAt);

  const rowPayload = {
    ...buildLogBase(entry, jobName, context),
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Number(payload.durationMs) >= 0 ? Number(payload.durationMs) : null,
    result: safeJson(payload.result),
    error_message: normalizeText(payload.errorMessage).slice(0, 500),
    skip_reason: normalizeText(payload.skipReason).slice(0, 120),
  };

  const activeRef = entry._activeLogPromise || Promise.resolve(entry._activeLogId || null);

  entry._activeLogPromise = Promise.resolve(activeRef)
    .then(async (logId) => {
      if (logId) {
        const [updatedCount] = await CollectorRunLog.update(rowPayload, {
          where: { id: logId },
        });
        if (updatedCount > 0) {
          return logId;
        }
      }

      const row = await CollectorRunLog.create(rowPayload);
      return row.id;
    })
    .catch((err) => {
      console.error(`[스케줄러] 실행 이력 종료 로그 저장 실패 (${key})`, err.message);
      return null;
    })
    .finally(() => {
      entry._activeLogId = null;
      entry._activeLogPromise = null;
      entry._activeContext = null;
      trimRunLogs();
    });
}

function persistSkippedLog(key, reason, jobName, context = {}) {
  const entry = collectorMonitor[key];
  if (!entry) return;

  const now = new Date();
  const rowPayload = {
    ...buildLogBase(entry, jobName, context),
    status: 'skipped',
    started_at: now,
    finished_at: now,
    duration_ms: null,
    result: null,
    error_message: '',
    skip_reason: normalizeText(reason).slice(0, 120),
  };

  CollectorRunLog.create(rowPayload)
    .then(() => {
      trimRunLogs();
    })
    .catch((err) => {
      console.error(`[스케줄러] 실행 이력 skip 로그 저장 실패 (${key})`, err.message);
    });
}

function isSlackAlertEnabled() {
  return Boolean(SLACK_WEBHOOK_URL);
}

function getCollectorAlertConfig() {
  return {
    slackEnabled: isSlackAlertEnabled(),
    cooldownMinutes: COLLECTOR_ALERT_COOLDOWN_MINUTES,
    stuckThresholdMinutes: COLLECTOR_STUCK_THRESHOLD_MINUTES,
    watchdogCron: COLLECTOR_WATCHDOG_CRON,
  };
}

function shouldSendAlert(dedupeKey, cooldownMinutes = COLLECTOR_ALERT_COOLDOWN_MINUTES) {
  const now = Date.now();
  const cooldownMs = Math.max(Number(cooldownMinutes) || 0, 1) * 60 * 1000;
  const lastSentAt = alertCooldownMap.get(dedupeKey) || 0;

  if (lastSentAt && now - lastSentAt < cooldownMs) {
    return false;
  }

  alertCooldownMap.set(dedupeKey, now);

  if (alertCooldownMap.size > 300) {
    const threshold = now - cooldownMs * 4;
    for (const [key, timestamp] of alertCooldownMap.entries()) {
      if (timestamp < threshold) {
        alertCooldownMap.delete(key);
      }
    }
  }

  return true;
}

async function postSlackWebhook(payload) {
  if (!isSlackAlertEnabled()) return false;
  await axios.post(SLACK_WEBHOOK_URL, payload, {
    timeout: 7000,
    headers: { 'Content-Type': 'application/json' },
  });
  return true;
}

function buildSlackFields(lines = []) {
  return lines
    .filter(Boolean)
    .map((line) => ({ type: 'mrkdwn', text: line }));
}

function queueSlackAlert(payload, dedupeKey) {
  if (!isSlackAlertEnabled()) return;
  if (!shouldSendAlert(dedupeKey)) return;

  Promise.resolve()
    .then(() => postSlackWebhook(payload))
    .then(() => {
      console.log(`[스케줄러] Slack 알림 전송 완료 (${dedupeKey})`);
    })
    .catch((err) => {
      console.error('[스케줄러] Slack 알림 전송 실패', err.message);
    });
}

function buildAlertTitle(prefix, entry, jobName) {
  return `${prefix} · ${entry.label}${jobName ? ` (${jobName})` : ''}`;
}

function sendCollectorErrorAlert(key, jobName, err, result = null, context = {}) {
  const entry = collectorMonitor[key];
  if (!entry || !isSlackAlertEnabled()) return;

  const actor = normalizeActor((context && context.actor) || {}) || {};
  const triggerType = inferTriggerType(jobName, context || {});
  const errorMessage = truncateText(err ? err.message || err : 'unknown_error', 400);
  const resultSummary = truncateText(JSON.stringify(normalizeMonitorResult(result) || {}), 400);
  const startedAt = entry.lastStartedAt || new Date().toISOString();
  const durationText = entry.lastDurationMs ? `${Math.round(entry.lastDurationMs / 1000)}초` : '-';

  const payload = {
    text: `[공고모아] 수집기 오류 - ${entry.label}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: buildAlertTitle('🚨 수집기 오류', entry, jobName) } },
      {
        type: 'section',
        fields: buildSlackFields([
          `*수집기*\n${entry.label} (${entry.key})`,
          `*유형*\n${triggerType}`,
          `*시작 시각*\n${startedAt}`,
          `*소요 시간*\n${durationText}`,
          `*실행자*\n${truncateText(actor.name || actor.email || 'system', 80)}`,
          `*상태*\nerror`,
        ]),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*오류 메시지*\n\`${errorMessage || 'unknown_error'}\``,
        },
      },
      ...(resultSummary && resultSummary !== '{}'
        ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*결과 요약*\n\`${resultSummary}\``,
            },
          }]
        : []),
    ],
  };

  const dedupeKey = [
    'error',
    key,
    jobName || '-',
    truncateText(errorMessage, 120),
  ].join('::');

  queueSlackAlert(payload, dedupeKey);
}

function sendCollectorStuckAlert(entry, elapsedMs) {
  if (!entry || !isSlackAlertEnabled()) return;

  const startedAt = entry.lastStartedAt || new Date().toISOString();
  const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60000));
  const payload = {
    text: `[공고모아] 장기 실행 경보 - ${entry.label}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: buildAlertTitle('⏰ 장기 실행 경보', entry, entry.lastJob) } },
      {
        type: 'section',
        fields: buildSlackFields([
          `*수집기*\n${entry.label} (${entry.key})`,
          `*최근 작업*\n${entry.lastJob || '-'}`,
          `*시작 시각*\n${startedAt}`,
          `*경과 시간*\n약 ${elapsedMinutes}분`,
          `*기준치*\n${COLLECTOR_STUCK_THRESHOLD_MINUTES}분`,
          `*상태*\n실행 중`,
        ]),
      },
      ...(entry.lastErrorMessage
        ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*최근 오류 메시지*\n\`${truncateText(entry.lastErrorMessage, 300)}\``,
            },
          }]
        : []),
    ],
  };

  const dedupeKey = ['stuck', entry.key, entry.lastJob || '-', startedAt].join('::');
  queueSlackAlert(payload, dedupeKey);
}

function syncCollectorEnabledState() {
  ['g2b_api', 'seoul_contract', 'local_gov', 'province_gov'].forEach((key) => {
    if (collectorMonitor[key]) {
      collectorMonitor[key].enabled = isSourceEnabled(key);
    }
  });
}

function markMonitorStart(key, jobName, context = {}) {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = true;
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastStartedAt = nowIso;
  entry.lastErrorMessage = '';
  entry.lastSkippedAt = null;
  entry.lastSkippedReason = '';
  entry.updatedAt = nowIso;
  entry._startedAtMs = Date.now();
  entry._activeContext = buildLogContext(jobName, context);
  entry._lastStuckAlertToken = '';

  persistStartedLog(key, jobName, entry._activeContext);
}

function markMonitorSuccess(key, jobName, result = null, context = null) {
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
  entry._lastStuckAlertToken = '';

  persistTerminalLog(
    key,
    'success',
    jobName,
    {
      finishedAt: new Date(nowIso),
      durationMs: entry.lastDurationMs,
      result: entry.lastResult,
    },
    context || entry._activeContext || {}
  );
}

function markMonitorError(key, jobName, err, result = null, context = null) {
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
  entry._lastStuckAlertToken = '';

  persistTerminalLog(
    key,
    'error',
    jobName,
    {
      finishedAt: new Date(nowIso),
      durationMs: entry.lastDurationMs,
      result: entry.lastResult,
      errorMessage: entry.lastErrorMessage,
    },
    context || entry._activeContext || {}
  );

  sendCollectorErrorAlert(key, jobName, err, result, context || entry._activeContext || {});
}

function markMonitorSkipped(key, reason, jobName = '', context = {}) {
  syncCollectorEnabledState();
  const entry = collectorMonitor[key];
  if (!entry) return;

  const nowIso = new Date().toISOString();
  entry.running = isCollectorRunning(key);
  entry.lastJob = jobName || entry.lastJob || '';
  entry.lastSkippedAt = nowIso;
  entry.lastSkippedReason = reason || '';
  entry.updatedAt = nowIso;

  persistSkippedLog(key, reason, jobName, context);
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

  if (key === 'province_gov') {
    return Boolean(runningProvinceGovJob);
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

async function getCollectorRunLogs(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const where = {};

  if (options.key && options.key !== 'all') {
    where.collector_key = String(options.key).trim();
  }

  if (options.status && options.status !== 'all') {
    where.status = String(options.status).trim();
  }

  const rows = await CollectorRunLog.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });

  return rows.map((row) => row.toJSON());
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

function runCollectorWatchdog() {
  syncCollectorEnabledState();
  syncCollectorRunningState();

  const thresholdMs = COLLECTOR_STUCK_THRESHOLD_MINUTES * 60 * 1000;

  Object.values(collectorMonitor).forEach((entry) => {
    if (!entry.running || !entry.lastStartedAt) return;

    const startedAt = new Date(entry.lastStartedAt);
    if (Number.isNaN(startedAt.getTime())) return;

    const elapsedMs = Date.now() - startedAt.getTime();
    if (elapsedMs < thresholdMs) return;

    const alertToken = `${entry.lastStartedAt}:${entry.lastJob || '-'}`;
    if (entry._lastStuckAlertToken === alertToken) return;

    entry._lastStuckAlertToken = alertToken;
    console.warn(
      `[스케줄러] 장기 실행 감지 — ${entry.key} ${entry.lastJob || '-'} ${Math.round(elapsedMs / 60000)}분`
    );
    sendCollectorStuckAlert(entry, elapsedMs);
  });
}

async function purgeExpiredNotices(context = {}) {
  const logContext = {
    triggerType: context.triggerType || 'maintenance',
    actor: context.actor,
    requestPayload: context.requestPayload,
    metadata: { ...(context.metadata || {}), task: 'purge_expired' },
  };

  if (runningPurgeJob) {
    markMonitorSkipped('purge_expired', 'already_running', 'purge', logContext);
    return;
  }
  runningPurgeJob = true;
  markMonitorStart('purge_expired', 'purge', logContext);

  try {
    const deleted = await Notice.destroy({
      where: {
        closing_at: {
          [Op.lt]: new Date(),
        },
      },
    });

    console.log(`[스케줄러] 만료 공고 삭제 완료 — ${deleted}건`);
    markMonitorSuccess('purge_expired', 'purge', { deleted }, logContext);
    return { deleted };
  } catch (err) {
    console.error('[스케줄러] 만료 공고 삭제 실패', err.message);
    markMonitorError('purge_expired', 'purge', err, null, logContext);
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
  const logContext = {
    triggerType: 'scheduled',
    metadata: { job: 'minute_window' },
  };

  if (runningMinuteJob) {
    console.log('[스케줄러] 분단위 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('g2b_api', 'minute_already_running', 'minute', logContext);
    return;
  }

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'minute', logContext);
    return;
  }

  const kst = getKstNow();
  const hour = kst.getUTCHours();

  if (hour < 8 || hour >= 19) {
    console.log(`[스케줄러] KST ${hour}시 — 수집 시간 범위 밖, 건너뜀`);
    markMonitorSkipped('g2b_api', `out_of_window_${hour}`, 'minute', logContext);
    return;
  }

  if (!tryStartG2bSync('minute')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'minute', logContext);
    return;
  }

  runningMinuteJob = true;
  markMonitorStart('g2b_api', 'minute', logContext);

  try {
    console.log(
      `[스케줄러] 분단위 수집 실행 — ${formatKstDate(kst)} ${String(hour).padStart(
        2,
        '0'
      )}시`
    );

    await purgeExpiredNotices({
      triggerType: 'maintenance',
      metadata: { parentCollector: 'g2b_api', parentJob: 'minute' },
    });
    const result = await g2bCrawler.crawl({ minuteMode: true });
    markMonitorSuccess('g2b_api', 'minute', result, logContext);
  } catch (err) {
    console.error('[스케줄러] 분단위 수집 실패', err.message);
    markMonitorError('g2b_api', 'minute', err, null, logContext);
  } finally {
    runningMinuteJob = false;
    finishG2bSync('minute');
  }
}

async function runG2bBackfill(hours = G2B_BACKFILL_HOURS, context = {}) {
  const logContext = {
    triggerType: context.triggerType || 'scheduled',
    actor: context.actor,
    requestPayload: { hours },
    metadata: { ...(context.metadata || {}), hours },
  };

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'backfill', logContext);
    return;
  }

  if (!tryStartG2bSync('backfill')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'backfill', logContext);
    return;
  }

  markMonitorStart('g2b_api', 'backfill', logContext);

  try {
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - hours * 60 * 60 * 1000);

    const result = await runG2bRangeSync(`G2B 보정 수집(${hours}h)`, fromDate, toDate);
    markMonitorSuccess('g2b_api', 'backfill', result, logContext);
    return result;
  } catch (err) {
    console.error('[스케줄러] G2B 보정 수집 실패', err.message);
    markMonitorError('g2b_api', 'backfill', err, null, logContext);
    throw err;
  } finally {
    finishG2bSync('backfill');
  }
}

async function runG2bStartupBackfill() {
  const logContext = {
    triggerType: 'startup',
    metadata: { job: 'startup_backfill' },
  };

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'startup_backfill', logContext);
    return;
  }

  if (!tryStartG2bSync('startup_backfill')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'startup_backfill', logContext);
    return;
  }

  markMonitorStart('g2b_api', 'startup_backfill', logContext);

  try {
    const fromDate = getKstStartOfDay(1);
    const toDate = new Date();

    const result = await runG2bRangeSync('G2B 기동 보정 수집(오늘+어제)', fromDate, toDate);
    markMonitorSuccess('g2b_api', 'startup_backfill', result, logContext);
    return result;
  } catch (err) {
    console.error('[스케줄러] G2B 기동 보정 수집 실패', err.message);
    markMonitorError('g2b_api', 'startup_backfill', err, null, logContext);
    throw err;
  } finally {
    finishG2bSync('startup_backfill');
  }
}

async function runG2bOpenNoticeResync() {
  const logContext = {
    triggerType: 'scheduled',
    metadata: { job: 'open_resync' },
  };

  if (!isSourceEnabled('g2b_api')) {
    console.log('[스케줄러] g2b_api 비활성화 상태');
    markMonitorSkipped('g2b_api', 'source_disabled', 'open_resync', logContext);
    return;
  }

  if (!tryStartG2bSync('open_resync')) {
    markMonitorSkipped('g2b_api', 'other_g2b_job_running', 'open_resync', logContext);
    return;
  }

  markMonitorStart('g2b_api', 'open_resync', logContext);

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
    markMonitorSuccess('g2b_api', 'open_resync', result, logContext);
    return result;
  } catch (err) {
    console.error('[스케줄러] G2B 미마감 공고 재동기화 실패', err.message);
    markMonitorError('g2b_api', 'open_resync', err, null, logContext);
    throw err;
  } finally {
    finishG2bSync('open_resync');
  }
}

async function runSeoulContractTwiceDaily(context = {}) {
  const logContext = {
    triggerType: context.triggerType || 'scheduled',
    actor: context.actor,
    requestPayload: safeJson(context.requestPayload),
    metadata: { ...(context.metadata || {}), job: 'seoul_contract' },
  };

  if (!isSourceEnabled('seoul_contract')) {
    console.log('[스케줄러] seoul_contract 비활성화 상태');
    markMonitorSkipped('seoul_contract', 'source_disabled', 'scheduled', logContext);
    return;
  }

  if (runningSeoulContractJob) {
    console.log('[스케줄러] 서울 계약마당 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('seoul_contract', 'already_running', 'scheduled', logContext);
    return;
  }

  runningSeoulContractJob = true;
  markMonitorStart('seoul_contract', 'scheduled', logContext);

  try {
    const today = formatKstDate();
    console.log(`[스케줄러] 서울 계약마당 정기 수집 실행 — ${today}`);

    await purgeExpiredNotices({
      triggerType: 'maintenance',
      metadata: { parentCollector: 'seoul_contract', parentJob: 'scheduled' },
    });

    const result = await seoulContractCrawler.crawl({
      fetchDetail: true,
      forceRefreshDetail: false,
      maxPages: Number(process.env.SEOUL_CONTRACT_PAGES_FULL || 8),
      recordCount: Number(process.env.SEOUL_CONTRACT_RECORD_COUNT || 50),
    });
    markMonitorSuccess('seoul_contract', 'scheduled', result, logContext);
    return result;
  } catch (err) {
    console.error('[스케줄러] 서울 계약마당 정기 수집 실패', err.message);
    markMonitorError('seoul_contract', 'scheduled', err, null, logContext);
    throw err;
  } finally {
    runningSeoulContractJob = false;
  }
}

async function runLocalGovRegularCollection(reason = 'scheduled', options = {}, context = {}) {
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

  const logContext = {
    triggerType: context.triggerType || (reason === 'manual' ? 'manual' : reason === 'startup' ? 'startup' : 'scheduled'),
    actor: context.actor,
    requestPayload: {
      ...(Number(maxPages) > 0 ? { maxPages } : {}),
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    },
    metadata: {
      ...(context.metadata || {}),
      reason,
      maxPages,
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    },
  };

  if (!isSourceEnabled('local_gov')) {
    console.log('[스케줄러] local_gov 비활성화 상태');
    markMonitorSkipped('local_gov', 'source_disabled', reason, logContext);
    return;
  }

  if (runningLocalGovJob) {
    console.log('[스케줄러] local_gov 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('local_gov', 'already_running', reason, logContext);
    return;
  }

  runningLocalGovJob = true;
  markMonitorStart('local_gov', reason, logContext);

  try {
    console.log(
      `[스케줄러] local_gov 정기 수집 실행 (${reason}) — maxPages=${maxPages}${
        lookbackDays > 0 ? ` lookbackDays=${lookbackDays}` : ''
      }${targetKeys?.length ? ` keys=${targetKeys.join(',')}` : ''}`
    );

    await purgeExpiredNotices({
      triggerType: 'maintenance',
      metadata: { parentCollector: 'local_gov', parentJob: reason },
    });

    const result = await localGovCrawler.crawl({
      maxPages,
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    });

    console.log(
      `[스케줄러] local_gov 정기 수집 완료 (${reason}) — parsed=${result.parsed} kept=${result.kept} new=${result.newCount} updated=${result.updatedCount} errors=${result.errorCount}`
    );
    markMonitorSuccess('local_gov', reason, result, logContext);
    return result;
  } catch (err) {
    console.error(`[스케줄러] local_gov 정기 수집 실패 (${reason})`, err.message);
    markMonitorError('local_gov', reason, err, null, logContext);
    throw err;
  } finally {
    runningLocalGovJob = false;
  }
}


async function runProvinceGovRegularCollection(reason = 'scheduled', options = {}, context = {}) {
  const configuredKeys = parseCsvList(process.env.PROVINCE_GOV_KEYS);
  const targetKeys =
    Array.isArray(options.keys) && options.keys.length
      ? options.keys
      : configuredKeys.length
      ? configuredKeys
      : undefined;

  const maxPages =
    Number(options.maxPages) > 0
      ? Number(options.maxPages)
      : PROVINCE_GOV_MAX_PAGES;

  const lookbackDays =
    Number(options.lookbackDays) > 0 ? Number(options.lookbackDays) : 0;

  const logContext = {
    triggerType: context.triggerType || (reason === 'manual' ? 'manual' : reason === 'startup' ? 'startup' : 'scheduled'),
    actor: context.actor,
    requestPayload: {
      ...(Number(maxPages) > 0 ? { maxPages } : {}),
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    },
    metadata: {
      ...(context.metadata || {}),
      reason,
      maxPages,
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    },
  };

  if (!isSourceEnabled('province_gov')) {
    console.log('[스케줄러] province_gov 비활성화 상태');
    markMonitorSkipped('province_gov', 'source_disabled', reason, logContext);
    return;
  }

  if (runningProvinceGovJob) {
    console.log('[스케줄러] province_gov 수집 이미 실행 중, 건너뜀');
    markMonitorSkipped('province_gov', 'already_running', reason, logContext);
    return;
  }

  runningProvinceGovJob = true;
  markMonitorStart('province_gov', reason, logContext);

  try {
    console.log(
      `[스케줄러] province_gov 정기 수집 실행 (${reason}) — maxPages=${maxPages}${
        lookbackDays > 0 ? ` lookbackDays=${lookbackDays}` : ''
      }${targetKeys?.length ? ` keys=${targetKeys.join(',')}` : ''}`
    );

    await purgeExpiredNotices({
      triggerType: 'maintenance',
      metadata: { parentCollector: 'province_gov', parentJob: reason },
    });

    const result = await provinceGovCrawler.crawl({
      maxPages,
      ...(lookbackDays > 0 ? { lookbackDays } : {}),
      ...(targetKeys?.length ? { keys: targetKeys } : {}),
    });

    console.log(
      `[스케줄러] province_gov 정기 수집 완료 (${reason}) — parsed=${result.parsed} kept=${result.kept} new=${result.newCount} updated=${result.updatedCount} errors=${result.errorCount}`
    );
    markMonitorSuccess('province_gov', reason, result, logContext);
    return result;
  } catch (err) {
    console.error(`[스케줄러] province_gov 정기 수집 실패 (${reason})`, err.message);
    markMonitorError('province_gov', reason, err, null, logContext);
    throw err;
  } finally {
    runningProvinceGovJob = false;
  }
}

function runCollectorNow(key, payload = {}, actor = null) {
  const collectorKey = String(key || '').trim();
  const allowedKeys = ['g2b_api', 'seoul_contract', 'local_gov', 'province_gov'];

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
  const options = payload && typeof payload === 'object' ? payload : {};
  const actorContext = normalizeActor(actor);

  if (!isSourceEnabled(collectorKey)) {
    markMonitorSkipped(collectorKey, 'manual_source_disabled', 'manual', {
      triggerType: 'manual',
      actor: actorContext,
      requestPayload: options,
    });
    return {
      ok: false,
      started: false,
      code: 'disabled',
      message: `${label} 수집기는 현재 비활성화 상태입니다.`,
      item: getCollectorStatusItem(collectorKey),
    };
  }

  if (isCollectorRunning(collectorKey)) {
    markMonitorSkipped(collectorKey, 'manual_already_running', 'manual', {
      triggerType: 'manual',
      actor: actorContext,
      requestPayload: options,
    });
    return {
      ok: false,
      started: false,
      code: 'already_running',
      message: `${label} 수집기가 이미 실행 중입니다.`,
      item: getCollectorStatusItem(collectorKey),
    };
  }

  let taskPromise;

  if (collectorKey === 'g2b_api') {
    const hours = Number(options.hours) > 0 ? Number(options.hours) : G2B_BACKFILL_HOURS;
    taskPromise = runG2bBackfill(hours, {
      triggerType: 'manual',
      actor: actorContext,
      requestPayload: { hours },
      metadata: { requestedBy: 'admin_api' },
    });
  } else if (collectorKey === 'seoul_contract') {
    taskPromise = runSeoulContractTwiceDaily({
      triggerType: 'manual',
      actor: actorContext,
      requestPayload: options,
      metadata: { requestedBy: 'admin_api' },
    });
  } else if (collectorKey === 'local_gov') {
    taskPromise = runLocalGovRegularCollection(
      'manual',
      {
        ...(Number(options.maxPages) > 0 ? { maxPages: Number(options.maxPages) } : {}),
        ...(Number(options.lookbackDays) > 0
          ? { lookbackDays: Number(options.lookbackDays) }
          : {}),
        ...(Array.isArray(options.keys) && options.keys.length ? { keys: options.keys } : {}),
      },
      {
        triggerType: 'manual',
        actor: actorContext,
        requestPayload: options,
        metadata: { requestedBy: 'admin_api' },
      }
    );
  } else if (collectorKey === 'province_gov') {
    taskPromise = runProvinceGovRegularCollection(
      'manual',
      {
        ...(Number(options.maxPages) > 0 ? { maxPages: Number(options.maxPages) } : {}),
        ...(Number(options.lookbackDays) > 0
          ? { lookbackDays: Number(options.lookbackDays) }
          : {}),
        ...(Array.isArray(options.keys) && options.keys.length ? { keys: options.keys } : {}),
      },
      {
        triggerType: 'manual',
        actor: actorContext,
        requestPayload: options,
        metadata: { requestedBy: 'admin_api' },
      }
    );
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

    await purgeExpiredNotices({ triggerType: 'startup', metadata: { phase: 'initial_load' } });
    await runG2bStartupBackfill();

    if (LOCAL_GOV_STARTUP_ENABLED) {
      await runLocalGovRegularCollection(
        'startup',
        {
          maxPages: LOCAL_GOV_STARTUP_MAX_PAGES,
          lookbackDays: LOCAL_GOV_STARTUP_LOOKBACK_DAYS,
        },
        {
          triggerType: 'startup',
          metadata: { phase: 'initial_load' },
        }
      );
    }

    if (PROVINCE_GOV_STARTUP_ENABLED) {
      await runProvinceGovRegularCollection(
        'startup',
        {
          maxPages: PROVINCE_GOV_STARTUP_MAX_PAGES,
          lookbackDays: PROVINCE_GOV_STARTUP_LOOKBACK_DAYS,
        },
        {
          triggerType: 'startup',
          metadata: { phase: 'initial_load' },
        }
      );
    }
  } catch (err) {
    console.error('[스케줄러] 초기 로드 실패', err.message);
  }
}

function start() {
  syncCollectorEnabledState();
  console.log(`[스케줄러] 활성 수집기: ${ENABLED_COLLECTOR_SOURCES.join(', ')}`);
  console.log(`[스케줄러] Slack 알림 ${isSlackAlertEnabled() ? '활성화' : '비활성화'}`);

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

  cron.schedule(PROVINCE_GOV_CRON, () => runProvinceGovRegularCollection('scheduled'), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 9,18 * * *', () => purgeExpiredNotices({ triggerType: 'maintenance' }), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 9 * * *', () => runSeoulContractTwiceDaily({ triggerType: 'scheduled' }), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 17 * * *', () => runSeoulContractTwiceDaily({ triggerType: 'scheduled' }), {
    timezone: 'Asia/Seoul',
  });

  cron.schedule(COLLECTOR_WATCHDOG_CRON, runCollectorWatchdog, {
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
  console.log(`[스케줄러] province_gov 정기 수집 등록 완료 (${PROVINCE_GOV_CRON})`);
  console.log(
    `[스케줄러] province_gov startup 보정수집 설정 — lookbackDays=${PROVINCE_GOV_STARTUP_LOOKBACK_DAYS}, maxPages=${PROVINCE_GOV_STARTUP_MAX_PAGES}`
  );
  console.log('[스케줄러] 만료 삭제 스케줄 등록 완료 (매일 00:05 KST)');
  console.log('[스케줄러] 서울 계약마당 스케줄 등록 완료 (매일 09:00, 17:00 KST)');
  console.log(
    `[스케줄러] watchdog 등록 완료 (${COLLECTOR_WATCHDOG_CRON}, 기준 ${COLLECTOR_STUCK_THRESHOLD_MINUTES}분)`
  );

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
  getCollectorRunLogs,
  getCollectorAlertConfig,
  runCollectorNow,
  purgeExpiredNotices,
  runG2bBackfill,
  runG2bStartupBackfill,
  runG2bOpenNoticeResync,
  runLocalGovRegularCollection,
  runProvinceGovRegularCollection,
};
