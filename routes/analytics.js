const router = require('express').Router();
const { Op } = require('sequelize');
const auth = require('../middleware/auth');
const PageView = require('../models/PageView');
const { verifyToken } = require('../utils/jwt');

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  }
  next();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

function tryGetUserId(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.split(' ')[1];
    const decoded = verifyToken(token);
    return decoded.id || null;
  } catch (_) {
    return null;
  }
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

router.post('/pageview', async (req, res) => {
  try {
    const path = String(req.body.path || '').trim();
    const title = String(req.body.title || '').trim();
    const referrer = String(req.body.referrer || '').trim();
    const sessionId = String(req.body.sessionId || '').trim();

    if (!path) {
      return res.status(400).json({ error: 'path는 필수입니다.' });
    }

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId는 필수입니다.' });
    }

    if (path.startsWith('/api')) {
      return res.json({ ok: true });
    }

    await PageView.create({
      user_id: tryGetUserId(req),
      session_id: sessionId.slice(0, 100),
      path: path.slice(0, 255),
      title: title.slice(0, 255),
      referrer,
      ip: getClientIp(req).slice(0, 64),
      user_agent: String(req.headers['user-agent'] || '')
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /analytics/pageview]', err);
    res.status(500).json({ error: '페이지뷰 저장 중 오류가 발생했습니다.' });
  }
});

router.get('/visitor-stats', auth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
    const todayStart = startOfToday();
    const rangeStart = new Date(todayStart.getTime() - (days - 1) * 86400000);

    const [rows, recentRows] = await Promise.all([
      PageView.findAll({
        attributes: ['path', 'session_id', 'createdAt'],
        where: {
          createdAt: { [Op.gte]: rangeStart }
        },
        order: [['createdAt', 'ASC']],
        raw: true
      }),
      PageView.findAll({
        attributes: ['path', 'session_id', 'createdAt', 'referrer'],
        order: [['createdAt', 'DESC']],
        limit: 20,
        raw: true
      })
    ]);

    const todayRows = rows.filter(row => new Date(row.createdAt) >= todayStart);

    const uniqueCount = (list) => {
      const set = new Set(
        list.map(v => String(v.session_id || '').trim()).filter(Boolean)
      );
      return set.size;
    };

    const dateMap = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(rangeStart.getTime() + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dateMap[key] = { date: key, views: 0, visitorsSet: new Set() };
    }

    const pathMap = {};

    rows.forEach(row => {
      const dateKey = new Date(row.createdAt).toISOString().slice(0, 10);
      if (dateMap[dateKey]) {
        dateMap[dateKey].views += 1;
        if (row.session_id) dateMap[dateKey].visitorsSet.add(row.session_id);
      }

      const path = row.path || '/';
      if (!pathMap[path]) pathMap[path] = 0;
      pathMap[path] += 1;
    });

    const daily = Object.values(dateMap).map(item => ({
      date: item.date,
      views: item.views,
      visitors: item.visitorsSet.size
    }));

    const topPages = Object.entries(pathMap)
      .map(([path, views]) => ({ path, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);

    res.json({
      summary: {
        days,
        todayViews: todayRows.length,
        todayVisitors: uniqueCount(todayRows),
        totalViews: rows.length,
        totalVisitors: uniqueCount(rows)
      },
      daily,
      topPages,
      recent: recentRows.map(row => ({
        path: row.path,
        session_id: row.session_id,
        referrer: row.referrer,
        createdAt: row.createdAt
      }))
    });
  } catch (err) {
    console.error('[GET /analytics/visitor-stats]', err);
    res.status(500).json({ error: '방문자 통계 조회 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
