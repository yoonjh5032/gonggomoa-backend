/* routes/notices.js — 공고 조회 API (MySQL / Sequelize) */
const router = require('express').Router();
const { Op, fn, col, literal } = require('sequelize');
const { sequelize } = require('../config/db');
const Notice = require('../models/Notice');

const CALENDAR_CACHE_TTL = 1000 * 60 * 2; // 2분 캐시
const LIST_CACHE_TTL = 1000 * 20; // 20초 캐시
const COUNT_CACHE_TTL = 1000 * 20; // 20초 캐시
const STATS_CACHE_TTL = 1000 * 60; // 1분 캐시
const MAX_NOTICE_LIMIT = 100;
const MAX_CACHE_ENTRIES = 200;
const SEARCH_TOKEN_LIMIT = 5;

const LIST_ATTRIBUTES = [
  'id',
  'title',
  'notice_type',
  'issuing_org',
  'demanding_org',
  'budget_formatted',
  'closing_at',
  'published_at',
  'opening_at',
  'source_system',
  'detail_url',
  'createdAt',
  'updatedAt'
];

const calendarCache = new Map();
const noticeListCache = new Map();
const noticeCountCache = new Map();
const noticeStatsCache = new Map();

function getCalendarCacheKey(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

function readCache(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > ttl) {
    map.delete(key);
    return null;
  }

  return entry.data;
}

function writeCache(map, key, data) {
  map.set(key, {
    createdAt: Date.now(),
    data
  });

  if (map.size <= MAX_CACHE_ENTRIES) return;

  const firstKey = map.keys().next();
  if (!firstKey.done) {
    map.delete(firstKey.value);
  }
}

function getCachedCalendar(key) {
  return readCache(calendarCache, key, CALENDAR_CACHE_TTL);
}

function setCachedCalendar(key, data) {
  writeCache(calendarCache, key, data);
}

function getCachedNoticeList(key) {
  return readCache(noticeListCache, key, LIST_CACHE_TTL);
}

function setCachedNoticeList(key, data) {
  writeCache(noticeListCache, key, data);
}

function getCachedNoticeCount(key) {
  return readCache(noticeCountCache, key, COUNT_CACHE_TTL);
}

function setCachedNoticeCount(key, data) {
  writeCache(noticeCountCache, key, data);
}

function getCachedNoticeStats(key) {
  return readCache(noticeStatsCache, key, STATS_CACHE_TTL);
}

function setCachedNoticeStats(key, data) {
  writeCache(noticeStatsCache, key, data);
}

function buildActiveNoticeCondition(now = new Date()) {
  return {
    [Op.or]: [
      { closing_at: null },
      { closing_at: { [Op.gte]: now } }
    ]
  };
}

function buildVisibleNoticeCondition() {
  return {
    [Op.or]: [
      { is_hidden: false },
      { is_hidden: null }
    ]
  };
}

function buildBaseNoticeWhere(now = new Date()) {
  return {
    [Op.and]: [
      buildActiveNoticeCondition(now),
      buildVisibleNoticeCondition()
    ]
  };
}

function normalizeKeywords(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');

  return [...new Set(
    list
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .map((v) => v.slice(0, 30))
  )].slice(0, SEARCH_TOKEN_LIMIT);
}

function normalizeText(value, maxLength = 60) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function buildBooleanSearchText(text) {
  const tokens = normalizeText(text, 80)
    .split(' ')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, index, arr) => arr.indexOf(v) === index)
    .slice(0, SEARCH_TOKEN_LIMIT);

  if (!tokens.length) return '';

  return tokens
    .map((token) => {
      const cleaned = token.replace(/[+\-<>~*()"@]+/g, '').trim();
      return cleaned ? ('+' + cleaned + '*') : '';
    })
    .filter(Boolean)
    .join(' ');
}

function buildSearchLiteral(text) {
  const booleanQuery = buildBooleanSearchText(text);
  if (!booleanQuery) return null;

  return literal(
    'MATCH(title, issuing_org, demanding_org) AGAINST ('
    + sequelize.escape(booleanQuery)
    + ' IN BOOLEAN MODE)'
  );
}

function buildNoticeListCacheKey(params) {
  return JSON.stringify({
    q: params.q || '',
    source: params.source || '',
    type: params.type || '',
    sortBy: params.sortBy || 'recent',
    days: params.days || 0,
    keywords: params.keywordList || [],
    page: params.page || 1,
    limit: params.limit || 20
  });
}

function buildNoticeCountCacheKey(params) {
  return JSON.stringify({
    q: params.q || '',
    source: params.source || '',
    type: params.type || '',
    days: params.days || 0,
    keywords: params.keywordList || []
  });
}

function toNoticeListItem(n) {
  return {
    id: n.id,
    title: n.title,
    notice_type: n.notice_type,
    issuing_org: n.issuing_org,
    demanding_org: n.demanding_org,
    budget_formatted: n.budget_formatted,
    closing_at: n.closing_at ? new Date(n.closing_at).toISOString() : null,
    published_at: n.published_at ? new Date(n.published_at).toISOString() : null,
    opening_at: n.opening_at ? new Date(n.opening_at).toISOString() : null,
    source_system: n.source_system,
    detail_url: n.detail_url || '',
    createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null,
    updatedAt: n.updatedAt ? new Date(n.updatedAt).toISOString() : null
  };
}

function buildNoticeListQuery(req) {
  const q = normalizeText(req.query.q, 60);
  const source = normalizeText(req.query.source, 30);
  const type = normalizeText(req.query.type, 20);
  const sortBy = req.query.sortBy === 'closing' ? 'closing' : 'recent';
  const keywordList = normalizeKeywords(req.query.keywords);
  const rawDays = parseInt(req.query.daysLeft || req.query.deadline, 10);
  const days = !Number.isNaN(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_NOTICE_LIMIT);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  return {
    q,
    source,
    type,
    sortBy,
    keywordList,
    days,
    limit,
    page,
    offset: (page - 1) * limit
  };
}

function applySearchFilters(where, query) {
  if (query.q) {
    const text = query.q;
    const searchOr = [
      { issuing_org: { [Op.like]: '%' + text + '%' } },
      { demanding_org: { [Op.like]: '%' + text + '%' } }
    ];

    const textSearch = buildSearchLiteral(text);
    if (textSearch) {
      searchOr.unshift(textSearch);
    } else {
      searchOr.unshift({ title: { [Op.like]: '%' + text + '%' } });
    }

    where[Op.and].push({ [Op.or]: searchOr });
  }

  if (query.keywordList.length) {
    const keywordOr = [];

    query.keywordList.forEach((kw) => {
      const textSearch = buildSearchLiteral(kw);
      if (textSearch) keywordOr.push(textSearch);
      keywordOr.push({ issuing_org: { [Op.like]: '%' + kw + '%' } });
      keywordOr.push({ demanding_org: { [Op.like]: '%' + kw + '%' } });
    });

    where[Op.and].push({ [Op.or]: keywordOr });
  }

  if (query.source) where.source_system = query.source;
  if (query.type) where.notice_type = query.type;

  if (query.days > 0) {
    const now = new Date();
    const until = new Date(now.getTime() + query.days * 86400000);
    where.closing_at = { [Op.between]: [now, until] };
  }

  return where;
}

async function getNoticeListTotal(where, cacheKey) {
  const cached = getCachedNoticeCount(cacheKey);
  if (cached !== null) return cached;

  const total = await Notice.count({ where });
  setCachedNoticeCount(cacheKey, total);
  return total;
}

/* ════════════════════════════════════════════════
   GET /api/notices
════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const query = buildNoticeListQuery(req);
    const listCacheKey = buildNoticeListCacheKey(query);
    const countCacheKey = buildNoticeCountCacheKey(query);
    const cachedResponse = getCachedNoticeList(listCacheKey);

    if (cachedResponse) {
      res.set('X-Notice-Cache', 'HIT');
      return res.json(cachedResponse);
    }

    const where = applySearchFilters(buildBaseNoticeWhere(), query);
    const order = query.sortBy === 'closing'
      ? [['closing_at', 'ASC'], ['id', 'DESC']]
      : [['published_at', 'DESC'], ['id', 'DESC']];

    const [total, rows] = await Promise.all([
      getNoticeListTotal(where, countCacheKey),
      Notice.findAll({
        attributes: LIST_ATTRIBUTES,
        where,
        order,
        limit: query.limit,
        offset: query.offset,
        raw: true,
        subQuery: false
      })
    ]);

    const response = {
      data: rows.map(toNoticeListItem),
      total,
      page: query.page,
      limit: query.limit,
      hasMore: query.offset + rows.length < total
    };

    setCachedNoticeList(listCacheKey, response);
    res.set('X-Notice-Cache', 'MISS');
    res.json(response);
  } catch (err) {
    console.error('[GET /notices]', err);
    res.status(500).json({ error: '공고 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/stats
════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const cacheKey = 'active-visible-stats';
    const cached = getCachedNoticeStats(cacheKey);
    if (cached) {
      res.set('X-Notice-Stats-Cache', 'HIT');
      return res.json(cached);
    }

    const rows = await Notice.findAll({
      attributes: [
        'source_system',
        [fn('COUNT', col('id')), 'count']
      ],
      where: {
        [Op.and]: [
          buildActiveNoticeCondition(),
          buildVisibleNoticeCondition()
        ]
      },
      group: ['source_system'],
      raw: true
    });

    const map = {};
    let total = 0;

    rows.forEach((r) => {
      const count = parseInt(r.count, 10) || 0;
      map[r.source_system] = count;
      total += count;
    });

    const response = {
      g2b: map.g2b_api || 0,
      seoul: map.seoul_board || 0,
      contract: map.seoul_contract || 0,
      local_gov: map.local_gov || 0,
      total
    };

    setCachedNoticeStats(cacheKey, response);
    res.set('X-Notice-Stats-Cache', 'MISS');
    res.json(response);
  } catch (err) {
    console.error('[GET /notices/stats]', err);
    res.status(500).json({ error: '통계 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/calendar/:year/:month
════════════════════════════════════════════════ */
router.get('/calendar/:year/:month', async (req, res) => {
  try {
    const y = parseInt(req.params.year, 10);
    const m = parseInt(req.params.month, 10);

    if (!y || !m || m < 1 || m > 12) {
      return res.status(400).json({ error: '올바른 연/월을 입력하세요.' });
    }

    const cacheKey = getCalendarCacheKey(y, m);
    const cached = getCachedCalendar(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0, 23, 59, 59, 999);

    const now = new Date();
    const effectiveFrom = from > now ? from : now;

    const list = await Notice.findAll({
      attributes: [
        'id',
        'title',
        'notice_type',
        'issuing_org',
        'budget_formatted',
        'closing_at',
        'published_at',
        'source_system',
        'detail_url'
      ],
      where: {
        [Op.and]: [
          { closing_at: { [Op.between]: [effectiveFrom, to] } },
          buildVisibleNoticeCondition()
        ]
      },
      order: [['closing_at', 'ASC']],
      raw: true
    });

    const grouped = {};

    list.forEach((n) => {
      const ds = new Date(n.closing_at).toISOString().slice(0, 10);
      if (!grouped[ds]) grouped[ds] = [];

      grouped[ds].push({
        id: n.id,
        title: n.title,
        notice_type: n.notice_type,
        issuing_org: n.issuing_org,
        budget_formatted: n.budget_formatted,
        closing_at: n.closing_at ? new Date(n.closing_at).toISOString() : null,
        published_at: n.published_at ? new Date(n.published_at).toISOString() : null,
        source_system: n.source_system,
        detail_url: n.detail_url || ''
      });
    });

    setCachedCalendar(cacheKey, grouped);
    res.json(grouped);
  } catch (err) {
    console.error('[CALENDAR]', err);
    res.status(500).json({ error: '캘린더 데이터 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/:id
════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const notice = await Notice.findOne({
      where: {
        id: req.params.id,
        [Op.and]: [
          buildVisibleNoticeCondition()
        ]
      },
      raw: true
    });

    if (!notice) {
      return res.status(404).json({ error: '공고를 찾을 수 없습니다.' });
    }

    res.json({
      ...notice,
      closing_at: notice.closing_at ? new Date(notice.closing_at).toISOString() : null,
      published_at: notice.published_at ? new Date(notice.published_at).toISOString() : null,
      opening_at: notice.opening_at ? new Date(notice.opening_at).toISOString() : null
    });
  } catch (err) {
    console.error('[GET /notices/:id]', err);
    res.status(500).json({ error: '공고 조회 중 오류' });
  }
});

module.exports = router;
