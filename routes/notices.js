/* routes/notices.js — 공고 조회 API (MySQL / Sequelize) */
const router = require('express').Router();
const { Op, fn, col, literal } = require('sequelize');
const Notice = require('../models/Notice');

const CALENDAR_CACHE_TTL = 1000 * 60 * 2; // 2분 캐시
const calendarCache = new Map();

function getCalendarCacheKey(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

function getCachedCalendar(key) {
  const entry = calendarCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > CALENDAR_CACHE_TTL) {
    calendarCache.delete(key);
    return null;
  }

  return entry.data;
}

function setCachedCalendar(key, data) {
  calendarCache.set(key, {
    createdAt: Date.now(),
    data
  });
}

function buildActiveNoticeCondition(now = new Date()) {
  return {
    [Op.or]: [
      { closing_at: null },
      { closing_at: { [Op.gte]: now } }
    ]
  };
}

function normalizeKeywords(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');

  return [...new Set(
    list
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .map(v => v.slice(0, 30))
  )].slice(0, 10);
}

/**
 * 조회 시 숨길 G2B 공고 조건
 *
 * 제외 대상:
 * - 입찰방식 = 전자시담
 * - 낙찰방법 = 수의시담
 * - 낙찰방법세부기준 = 수의시담
 *
 * 저장 컬럼 + raw_data(JSON) 모두 확인
 */
function buildExcludedSuidamReadCondition() {
  return literal(`
    NOT (
      source_system = 'g2b_api'
      AND (
        bid_method = '전자시담'
        OR contract_method = '수의시담'
      )
    )
  `);
}


/* ════════════════════════════════════════════════
   GET /api/notices
════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const {
      q,
      source,
      type,
      sortBy,
      daysLeft,
      deadline,
      keywords: rawKeywords,
      limit: rawLimit,
      page: rawPage
    } = req.query;

    const keywordList = normalizeKeywords(rawKeywords);

    const where = {
      [Op.and]: [
        buildActiveNoticeCondition(),
        buildExcludedSuidamReadCondition()
      ]
    };

    if (q && q.trim()) {
      const text = q.trim();
      where[Op.and].push({
        [Op.or]: [
          { title: { [Op.like]: `%${text}%` } },
          { issuing_org: { [Op.like]: `%${text}%` } },
          { demanding_org: { [Op.like]: `%${text}%` } }
        ]
      });
    }

    if (keywordList.length) {
      const keywordOr = [];

      keywordList.forEach((kw) => {
        keywordOr.push({ title: { [Op.like]: `%${kw}%` } });
        keywordOr.push({ issuing_org: { [Op.like]: `%${kw}%` } });
        keywordOr.push({ demanding_org: { [Op.like]: `%${kw}%` } });
      });

      where[Op.and].push({ [Op.or]: keywordOr });
    }

    if (source) where.source_system = source;
    if (type) where.notice_type = type;

    const days = parseInt(daysLeft || deadline, 10);
    if (!Number.isNaN(days) && days > 0) {
      const now = new Date();
      const until = new Date(now.getTime() + days * 86400000);
      where.closing_at = { [Op.between]: [now, until] };
    }

    const order = sortBy === 'closing'
      ? [['closing_at', 'ASC']]
      : [['published_at', 'DESC']];

    const limit = Math.min(parseInt(rawLimit, 10) || 20, 500);
    const page = Math.max(parseInt(rawPage, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const { count: total, rows } = await Notice.findAndCountAll({
      where,
      order,
      limit,
      offset,
      raw: true
    });

    const data = rows.map((n) => ({
      ...n,
      closing_at: n.closing_at ? new Date(n.closing_at).toISOString() : null,
      published_at: n.published_at ? new Date(n.published_at).toISOString() : null,
      opening_at: n.opening_at ? new Date(n.opening_at).toISOString() : null
    }));

    res.json({ data, total, page, limit });
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
    const rows = await Notice.findAll({
      attributes: [
        'source_system',
        [fn('COUNT', col('id')), 'count']
      ],
      where: {
        [Op.and]: [
          buildActiveNoticeCondition(),
          buildExcludedSuidamReadCondition()
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

    res.json({
      g2b: map.g2b_api || 0,
      seoul: map.seoul_board || 0,
      contract: map.seoul_contract || 0,
      local_gov: map.local_gov || 0,
      total
    });
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
          buildExcludedSuidamReadCondition()
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
          buildExcludedSuidamReadCondition()
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
