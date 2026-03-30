const router = require('express').Router();
const { Op } = require('sequelize');
const auth = require('../middleware/auth');
const Inquiry = require('../models/Inquiry');
const User = require('../models/User');

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  }
  next();
}

router.use(auth, requireAdmin);

router.get('/inquiries', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all').trim();

    const where = {};

    if (status && status !== 'all') {
      if (!['received', 'in_progress', 'done'].includes(status)) {
        return res.status(400).json({ error: '유효하지 않은 상태값입니다.' });
      }
      where.status = status;
    }

    if (q) {
      where[Op.or] = [
        { name: { [Op.like]: `%${q}%` } },
        { email: { [Op.like]: `%${q}%` } },
        { phone: { [Op.like]: `%${q}%` } },
        { title: { [Op.like]: `%${q}%` } },
        { message: { [Op.like]: `%${q}%` } },
        { category: { [Op.like]: `%${q}%` } }
      ];
    }

    const [result, total, received, inProgress, done] = await Promise.all([
      Inquiry.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        offset,
        limit
      }),
      Inquiry.count(),
      Inquiry.count({ where: { status: 'received' } }),
      Inquiry.count({ where: { status: 'in_progress' } }),
      Inquiry.count({ where: { status: 'done' } })
    ]);

    const userIds = [...new Set(result.rows.map(row => row.user_id).filter(Boolean))];
    let userMap = new Map();

    if (userIds.length) {
      const users = await User.findAll({
        where: { id: userIds },
        attributes: ['id', 'email', 'nickname', 'company', 'phone', 'role']
      });
      userMap = new Map(users.map(user => [user.id, user.toJSON()]));
    }

    const data = result.rows.map(row => {
      const item = row.toJSON();
      return {
        ...item,
        messagePreview: (item.message || '').replace(/\s+/g, ' ').slice(0, 120),
        user: item.user_id ? (userMap.get(item.user_id) || null) : null
      };
    });

    res.json({
      data,
      pagination: {
        total: result.count,
        page,
        limit,
        pages: Math.max(Math.ceil(result.count / limit), 1)
      },
      summary: {
        total,
        received,
        in_progress: inProgress,
        done
      },
      filters: { q, status }
    });
  } catch (err) {
    console.error('[ADMIN_INQUIRIES]', err);
    res.status(500).json({ error: '문의 목록을 불러오는 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
