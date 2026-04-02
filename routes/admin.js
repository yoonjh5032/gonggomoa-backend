const router = require('express').Router();
const { Op } = require('sequelize');
const auth = require('../middleware/auth');
const Inquiry = require('../models/Inquiry');
const User = require('../models/User');
const PageView = require('../models/PageView');

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  }
  next();
}

router.use(auth, requireAdmin);

function getKstStartOfTodayUtc() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  return new Date(Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
    -9, 0, 0, 0
  ));
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .map(v => String(v || '').trim())
        .filter(Boolean)
    )];
  }

  if (typeof value === 'string') {
    return [...new Set(
      value
        .split(/[\n,]/)
        .map(v => v.trim())
        .filter(Boolean)
    )];
  }

  return [];
}

function toUserListItem(user) {
  const item = user.toJSON ? user.toJSON() : user;
  return {
    ...item,
    keywordsCount: Array.isArray(item.keywords) ? item.keywords.length : 0,
    bookmarksCount: Array.isArray(item.bookmarks) ? item.bookmarks.length : 0
  };
}

/* ─────────────────────────────
   GET /api/admin/dashboard
───────────────────────────── */
router.get('/dashboard', async (req, res) => {
  try {
    const todayStart = getKstStartOfTodayUtc();

    const [
      usersTotal,
      usersAdmin,
      usersNormal,
      usersToday,
      inquiriesTotal,
      inquiriesReceived,
      inquiriesInProgress,
      inquiriesDone,
      todayPageViews,
      todayPageViewRows,
      recentUsers,
      recentInquiries
    ] = await Promise.all([
      User.count(),
      User.count({ where: { role: 'admin' } }),
      User.count({ where: { role: 'user' } }),
      User.count({ where: { createdAt: { [Op.gte]: todayStart } } }),
      Inquiry.count(),
      Inquiry.count({ where: { status: 'received' } }),
      Inquiry.count({ where: { status: 'in_progress' } }),
      Inquiry.count({ where: { status: 'done' } }),
      PageView.count({ where: { createdAt: { [Op.gte]: todayStart } } }),
      PageView.findAll({
        attributes: ['session_id'],
        where: { createdAt: { [Op.gte]: todayStart } },
        raw: true
      }),
      User.findAll({
        order: [['createdAt', 'DESC']],
        limit: 5,
        attributes: ['id', 'email', 'nickname', 'company', 'phone', 'role', 'createdAt']
      }),
      Inquiry.findAll({
        order: [['createdAt', 'DESC']],
        limit: 5,
        attributes: ['id', 'name', 'email', 'title', 'category', 'status', 'createdAt', 'message']
      })
    ]);

    const todayVisitors = new Set(
      todayPageViewRows.map(row => String(row.session_id || '').trim()).filter(Boolean)
    ).size;

    res.json({
      summary: {
        usersTotal,
        usersAdmin,
        usersNormal,
        usersToday,
        inquiriesTotal,
        inquiriesReceived,
        inquiriesInProgress,
        inquiriesDone,
        pageviewsToday: todayPageViews,
        visitorsToday: todayVisitors
      },
      recentUsers: recentUsers.map(user => toUserListItem(user)),
      recentInquiries: recentInquiries.map(item => {
        const row = item.toJSON();
        return {
          ...row,
          messagePreview: String(row.message || '').replace(/\s+/g, ' ').slice(0, 100)
        };
      })
    });
  } catch (err) {
    console.error('[ADMIN_DASHBOARD]', err);
    res.status(500).json({ error: '대시보드 데이터를 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   GET /api/admin/users
───────────────────────────── */
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || 'all').trim();

    const where = {};

    if (role && role !== 'all') {
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: '유효하지 않은 권한 필터입니다.' });
      }
      where.role = role;
    }

    if (q) {
      where[Op.or] = [
        { email: { [Op.like]: `%${q}%` } },
        { nickname: { [Op.like]: `%${q}%` } },
        { company: { [Op.like]: `%${q}%` } },
        { phone: { [Op.like]: `%${q}%` } }
      ];
    }

    const [result, total, adminCount, userCount] = await Promise.all([
      User.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        offset,
        limit
      }),
      User.count(),
      User.count({ where: { role: 'admin' } }),
      User.count({ where: { role: 'user' } })
    ]);

    res.json({
      data: result.rows.map(user => toUserListItem(user)),
      pagination: {
        total: result.count,
        page,
        limit,
        pages: Math.max(Math.ceil(result.count / limit), 1)
      },
      summary: {
        total,
        admin: adminCount,
        user: userCount
      },
      filters: { q, role }
    });
  } catch (err) {
    console.error('[ADMIN_USERS]', err);
    res.status(500).json({ error: '회원 목록을 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   GET /api/admin/users/:id
───────────────────────────── */
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
    }

    res.json({
      user: toUserListItem(user)
    });
  } catch (err) {
    console.error('[ADMIN_USER_DETAIL]', err);
    res.status(500).json({ error: '회원 상세를 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   PATCH /api/admin/users/:id
───────────────────────────── */
router.patch('/users/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
    }

    const {
      nickname,
      company,
      phone,
      role,
      keywords
    } = req.body || {};

    if (nickname !== undefined) {
      const value = String(nickname || '').trim();
      if (!value) {
        return res.status(400).json({ error: '닉네임은 비워둘 수 없습니다.' });
      }
      user.nickname = value;
    }

    if (company !== undefined) {
      user.company = String(company || '').trim();
    }

    if (phone !== undefined) {
      user.phone = String(phone || '').trim();
    }

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: '유효하지 않은 권한값입니다.' });
      }

      if (Number(user.id) === Number(req.userId) && role !== 'admin') {
        return res.status(400).json({ error: '본인 관리자 권한은 해제할 수 없습니다.' });
      }

      user.role = role;
    }

    if (keywords !== undefined) {
      user.keywords = normalizeKeywords(keywords);
    }

    await user.save();

    res.json({
      message: '회원 정보가 저장되었습니다.',
      user: toUserListItem(user)
    });
  } catch (err) {
    console.error('[ADMIN_USER_UPDATE]', err);
    res.status(500).json({ error: '회원 정보 수정 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   GET /api/admin/inquiries
───────────────────────────── */
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
        where: { id: { [Op.in]: userIds } },
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
