#!/usr/bin/env node
require('dotenv').config();

const { Op } = require('sequelize');
const { connectDB, sequelize } = require('../config/db');
const Notice = require('../models/Notice');
const { buildVisibilityMeta } = require('../utils/notice-visibility');

function parseArgs(argv) {
  const args = {
    source: '',
    limit: 500,
    dryRun: false,
    fromId: 0,
    toId: 0,
    includeAlreadyNormalized: true,
  };

  argv.forEach((arg) => {
    if (arg === '--dry-run') {
      args.dryRun = true;
      return;
    }
    if (arg.startsWith('--source=')) {
      args.source = String(arg.split('=').slice(1).join('=') || '').trim();
      return;
    }
    if (arg.startsWith('--limit=')) {
      const v = Number(arg.split('=').slice(1).join('='));
      if (Number.isFinite(v) && v > 0) args.limit = Math.min(Math.floor(v), 5000);
      return;
    }
    if (arg.startsWith('--from-id=')) {
      const v = Number(arg.split('=').slice(1).join('='));
      if (Number.isFinite(v) && v > 0) args.fromId = Math.floor(v);
      return;
    }
    if (arg.startsWith('--to-id=')) {
      const v = Number(arg.split('=').slice(1).join('='));
      if (Number.isFinite(v) && v > 0) args.toId = Math.floor(v);
      return;
    }
    if (arg === '--only-missing') {
      args.includeAlreadyNormalized = false;
    }
  });

  return args;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function pickFirst(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function extractMethodFields(notice) {
  const raw = notice.raw_data && typeof notice.raw_data === 'object' ? notice.raw_data : {};
  const sourceSystem = normalizeText(notice.source_system);

  if (sourceSystem === 'g2b_api') {
    return {
      sourceSystem,
      bidMethod: pickFirst(notice.bid_method, raw.bidMethdNm),
      contractMethod: pickFirst(notice.contract_method, raw.cntrctMthdNm),
      detailMethod: pickFirst(raw.sucsfbidMthdCdNm),
    };
  }

  if (sourceSystem === 'seoul_contract') {
    return {
      sourceSystem,
      bidMethod: pickFirst(notice.bid_method, raw.orgGroup),
      contractMethod: pickFirst(notice.contract_method, raw.contractMethod),
      detailMethod: '',
    };
  }

  if (sourceSystem === 'local_gov') {
    return {
      sourceSystem,
      bidMethod: pickFirst(notice.bid_method, raw.bidMethod),
      contractMethod: pickFirst(notice.contract_method, raw.contractMethod),
      detailMethod: pickFirst(raw.detailMethod),
    };
  }

  return {
    sourceSystem,
    bidMethod: pickFirst(notice.bid_method, raw.bidMethod),
    contractMethod: pickFirst(notice.contract_method, raw.contractMethod),
    detailMethod: pickFirst(raw.detailMethod),
  };
}

function buildNextState(notice) {
  const fields = extractMethodFields(notice);
  const visibility = buildVisibilityMeta(fields);

  return {
    bid_method: fields.bidMethod,
    contract_method: fields.contractMethod,
    normalized_bid_method: normalizeText(visibility.normalized_bid_method),
    is_hidden: Boolean(visibility.is_hidden),
    hidden_reason: normalizeText(visibility.hidden_reason),
  };
}

function hasChanged(notice, next) {
  return normalizeText(notice.bid_method) !== next.bid_method ||
    normalizeText(notice.contract_method) !== next.contract_method ||
    normalizeText(notice.normalized_bid_method) !== next.normalized_bid_method ||
    Boolean(notice.is_hidden) !== next.is_hidden ||
    normalizeText(notice.hidden_reason) !== next.hidden_reason;
}

function buildWhere(args, cursorId) {
  const where = {};
  const and = [];

  if (args.source) {
    where.source_system = args.source;
  }

  if (args.fromId > 0) {
    and.push({ id: { [Op.gte]: args.fromId } });
  }

  if (args.toId > 0) {
    and.push({ id: { [Op.lte]: args.toId } });
  }

  if (cursorId > 0) {
    and.push({ id: { [Op.gt]: cursorId } });
  }

  if (!args.includeAlreadyNormalized) {
    and.push({
      [Op.or]: [
        { normalized_bid_method: '' },
        { normalized_bid_method: null },
        { hidden_reason: '' },
        { hidden_reason: null },
      ]
    });
  }

  if (and.length) where[Op.and] = and;
  return where;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('▶ notice visibility backfill 시작');
  console.log(JSON.stringify({
    source: args.source || 'all',
    limit: args.limit,
    dryRun: args.dryRun,
    fromId: args.fromId || null,
    toId: args.toId || null,
    onlyMissing: !args.includeAlreadyNormalized,
  }, null, 2));

  await connectDB();

  let cursorId = args.fromId > 0 ? args.fromId - 1 : 0;
  let scanned = 0;
  let changed = 0;
  let hiddenChanged = 0;
  let updated = 0;
  let createdHidden = 0;
  let clearedHidden = 0;

  while (true) {
    const notices = await Notice.findAll({
      where: buildWhere(args, cursorId),
      order: [['id', 'ASC']],
      limit: args.limit,
    });

    if (!notices.length) break;

    for (const notice of notices) {
      cursorId = notice.id;
      scanned += 1;

      const next = buildNextState(notice);
      const changedNow = hasChanged(notice, next);
      if (!changedNow) continue;

      changed += 1;
      if (Boolean(notice.is_hidden) !== next.is_hidden) {
        hiddenChanged += 1;
        if (!notice.is_hidden && next.is_hidden) createdHidden += 1;
        if (notice.is_hidden && !next.is_hidden) clearedHidden += 1;
      }

      const beforeSummary = {
        id: notice.id,
        source_system: notice.source_system,
        bid_method: normalizeText(notice.bid_method),
        contract_method: normalizeText(notice.contract_method),
        normalized_bid_method: normalizeText(notice.normalized_bid_method),
        is_hidden: Boolean(notice.is_hidden),
        hidden_reason: normalizeText(notice.hidden_reason),
      };

      const afterSummary = {
        ...beforeSummary,
        ...next,
      };

      console.log(`[CHANGE] #${notice.id} ${notice.source_system} ${notice.bid_ntce_no}/${notice.bid_ntce_ord} :: ${JSON.stringify({ before: beforeSummary, after: afterSummary })}`);

      if (!args.dryRun) {
        await notice.update(next);
        updated += 1;
      }
    }

    console.log(`... 진행 중: scanned=${scanned}, changed=${changed}, updated=${updated}, lastId=${cursorId}`);
  }

  console.log('✅ notice visibility backfill 완료');
  console.log(JSON.stringify({
    scanned,
    changed,
    updated,
    hiddenChanged,
    createdHidden,
    clearedHidden,
    dryRun: args.dryRun,
    source: args.source || 'all',
    lastId: cursorId || null,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error('❌ notice visibility backfill 실패:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (_) {
      // ignore close errors
    }
  });
