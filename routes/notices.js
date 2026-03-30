/* routes/notices.js — 공고 조회 API */
const router = require('express').Router();
const Notice = require('../models/Notice');

/* ════════════════════════════════════════════════
   GET /api/notices
   쿼리 파라미터:
     q        — 검색어 (제목/기관)
     source   — g2b_api | seoul_board | seoul_contract
     type     — 공사 | 용역 | 물품 | 외자
     sortBy   — recent (기본) | closing
     daysLeft — 마감 D-N 이내 (정수)
     deadline — daysLeft alias
     limit    — 기본 20, 최대 500
     page     — 페이지 (기본 1)
════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const {
      q, source, type, sortBy,
      daysLeft, deadline,
      limit: rawLimit, page: rawPage
    } = req.query;

    const filter = {};

    // 검색어 (제목, 기관에 포함)
    if (q && q.trim()) {
      const regex = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { title: regex },
        { issuing_org: regex },
        { demanding_org: regex }
      ];
    }

    // 소스 필터
    if (source) filter.source_system = source;

    // 유형 필터
    if (type) filter.notice_type = type;

    // 마감 임박 필터
    const days = parseInt(daysLeft || deadline);
    if (!isNaN(days) && days > 0) {
      const now   = new Date();
      const until = new Date(now.getTime() + days * 86400000);
      filter.closing_at = { $gte: now, $lte: until };
    }

    // 정렬
    const sort = sortBy === 'closing'
      ? { closing_at: 1 }    // 마감 임박순
      : { published_at: -1 }; // 최신순 (기본)

    // 페이지네이션
    const limit = Math.min(parseInt(rawLimit) || 20, 500);
    const page  = Math.max(parseInt(rawPage)  || 1, 1);
    const skip  = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Notice.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Notice.countDocuments(filter)
    ]);

    // id 필드 매핑 (프론트엔드 호환)
    const mapped = data.map(d => ({
      ...d,
      id: d._id,
      closing_at: d.closing_at ? d.closing_at.toISOString() : null,
      published_at: d.published_at ? d.published_at.toISOString() : null
    }));

    res.json({ data: mapped, total, page, limit });
  } catch (err) {
    console.error('[GET /notices]', err);
    res.status(500).json({ error: '공고 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/stats
   소스별 건수 통계
════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const agg = await Notice.aggregate([
      { $group: { _id: '$source_system', count: { $sum: 1 } } }
    ]);
    const map = {};
    let total = 0;
    agg.forEach(a => {
      map[a._id] = a.count;
      total += a.count;
    });
    res.json({
      g2b:      map.g2b_api          || 0,
      seoul:    map.seoul_board       || 0,
      contract: map.seoul_contract    || 0,
      total
    });
  } catch (err) {
    res.status(500).json({ error: '통계 조회 중 오류' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/notices/calendar/:year/:month
   해당 월의 마감일별 공고 그룹핑
   → { '2025-07-01': [...], '2025-07-02': [...] }
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

    const list = await Notice.find({
      closing_at: { $gte: from, $lte: to }
    }).sort({ closing_at: 1 }).lean();

    const grouped = {};
    list.forEach(n => {
      const ds = n.closing_at.toISOString().slice(0, 10);
      if (!grouped[ds]) grouped[ds] = [];
      grouped[ds].push({
        ...n,
        id: n._id,
        closing_at: n.closing_at.toISOString(),
        published_at: n.published_at ? n.published_at.toISOString() : null
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
   공고 상세 (단건)
════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id).lean();
    if (!notice) return res.status(404).json({ error: '공고를 찾을 수 없습니다.' });
    res.json({ ...notice, id: notice._id });
  } catch (err) {
    res.status(500).json({ error: '공고 조회 중 오류' });
  }
});

module.exports = router;
