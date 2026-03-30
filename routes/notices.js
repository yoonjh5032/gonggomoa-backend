/* routes/notices.js — 공고 조회 API (MySQL / Sequelize) */
const router = require('express').Router();
const { Op, fn, col } = require('sequelize');
const Notice = require('../models/Notice');

function buildActiveNoticeCondition(now = new Date()) {
  return {
    [Op.or]: [
      { closing_at: null },
      { closing_at: { [Op.gte]: now } }
    ]
  };
}

/* ════════════════════════════════════════════════
   GET /api/notices
════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const {
      q, source, type, sortBy,
      daysLeft, deadline,
      limit: rawLimit, page: rawPage
    } = req.query;

    const where = {
      [Op.and]: [buildActiveNoticeCondition()]
    };

    // 검색어
    if (q && q.trim()) {
      where[Op.and].push({
        [Op.or]: [
          { title:        { [Op.like]: `%${q.trim()}%` } },
          { issuing_org:  { [Op.like]: `%${q.trim()}%` } },
          { demanding_org:{ [Op.like]: `%${q.trim()}%` } }
        ]
      });
    }

    // 소스 필터
    if (source) where.source_system = source;

    // 유형 필터
    if (type) where.notice_type = type;

    // 마감 임박 필터
    const days = parseInt(daysLeft || deadline);
    if (!isNaN(days) && days > 0) {
      const now   = new Date();
      const until = new Date(now.getTime() + days * 86400000);
      where.closing_at = { [Op.between]: [now, until] };
    }

    // 정렬
    const order = sortBy === 'closing'
      ? [['closing_at', 'ASC']]
      : [['published_at', 'DESC']];

    // 페이지네이션
    const limit  = Math.min(parseInt(rawLimit) || 20, 500);
    const page   = Math.max(parseInt(rawPage)  || 1, 1);
    const offset = (page - 1) * limit;

    const { count: total, rows } = await Notice.findAndCountAll({
      where, order, limit, offset,
      raw: true
    });

    // 프론트엔드 호환 (closing_at → ISO 문자열)
    const data = rows.map(n => ({
      ...n,
      closing_at:   n.closing_at   ? new Date(n.closing_at).toISOString()   : null,
      published_at: n.published_at ? new Date(n.published_at).toISOString() : null
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
      where: buildActiveNoticeCondition(),
      group: ['source_system'],
      raw: true
    });

    const map = {};
    let total = 0;
    rows.forEach(r => {
      map[r.source_system] = parseInt(r.count);
      total += parseInt(r.count);
    });

    res.json({
      g2b:      map.g2b_api        || 0,
      seoul:    map.seoul_board     || 0,
      contract: map.seoul_contract  || 0,
      total
    });
  } catch (err) {
    res.status(500).json({ error: '통계 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/calendar/:year/:month
════════════════════════════════════════════════ */
router.get('/calendar/:year/:month', async (req, res) => {
  try {
    const y = parseInt(req.params.year);
    const m = parseInt(req.params.month);
    if (!y || !m || m < 1 || m > 12) {
      return res.status(400).json({ error: '올바른 연/월을 입력하세요.' });
    }

    const from = new Date(y, m - 1, 1);
    const to   = new Date(y, m, 0, 23, 59, 59, 999);
    const now = new Date();
    const effectiveFrom = from > now ? from : now;

    const list = await Notice.findAll({
      where: {
        closing_at: { [Op.between]: [effectiveFrom, to] }
      },
      order: [['closing_at', 'ASC']],
      raw: true
    });

    const grouped = {};
    list.forEach(n => {
      const ds = new Date(n.closing_at).toISOString().slice(0, 10);
      if (!grouped[ds]) grouped[ds] = [];
      grouped[ds].push({
        ...n,
        closing_at:   new Date(n.closing_at).toISOString(),
        published_at: n.published_at ? new Date(n.published_at).toISOString() : null
      });
    });

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
    const notice = await Notice.findByPk(req.params.id, { raw: true });
    if (!notice) return res.status(404).json({ error: '공고를 찾을 수 없습니다.' });
    res.json(notice);
  } catch (err) {
    res.status(500).json({ error: '공고 조회 중 오류' });
  }
});

module.exports = router;
