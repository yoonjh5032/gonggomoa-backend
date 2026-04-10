const router = require('express').Router();
const { Op } = require('sequelize');
const auth = require('../middleware/auth');
const Inquiry = require('../models/Inquiry');
const User = require('../models/User');
const PageView = require('../models/PageView');
const CollectorRunLog = require('../models/collector-run-log');
const scheduler = require('../services/scheduler');

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

function toCollectorLogItem(row) {
  const item = row.toJSON ? row.toJSON() : row;
  return {
    id: item.id,
    collector_key: item.collector_key,
    collector_label: item.collector_label,
    kind: item.kind,
    job_name: item.job_name,
    trigger_type: item.trigger_type,
    status: item.status,
    started_at: item.started_at,
    finished_at: item.finished_at,
    duration_ms: item.duration_ms,
    result: item.result,
    error_message: item.error_message,
    skip_reason: item.skip_reason,
    actor_user_id: item.actor_user_id,
    actor_email: item.actor_email,
    actor_name: item.actor_name,
    actor_role: item.actor_role,
    request_payload: item.request_payload,
    metadata: item.metadata,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function toInquiryItem(row) {
  const item = row.toJSON ? row.toJSON() : row;
  return {
    ...item,
    adminMemo: item.adminMemo || '',
    processedAt: item.processedAt || null,
    processedBy: item.processedBy || null,
    messagePreview: String(item.message || '').replace(/\s+/g, ' ').slice(0, 120)
  };
}

function parseDateBoundary(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);

  if (isDateOnly) {
    return endOfDay
      ? new Date(`${raw}T23:59:59.999Z`)
      : new Date(`${raw}T00:00:00.000Z`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function buildCollectorLogFilters(query = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

  const key = String(query.key || 'all').trim();
  const status = String(query.status || 'all').trim();
  const trigger_type = String(query.trigger_type || 'all').trim();
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  const q = String(query.q || '').trim();

  return {
    page,
    limit,
    offset: (page - 1) * limit,
    key,
    status,
    trigger_type,
    from,
    to,
    q
  };
}

function buildCollectorLogWhere(filters) {
  const where = {};

  if (filters.key && filters.key !== 'all') {
    where.collector_key = filters.key;
  }

  if (filters.status && filters.status !== 'all') {
    if (!['started', 'success', 'error', 'skipped'].includes(filters.status)) {
      throw new Error('유효하지 않은 상태 필터입니다.');
    }
    where.status = filters.status;
  }

  if (filters.trigger_type && filters.trigger_type !== 'all') {
    if (!['manual', 'scheduled', 'startup', 'maintenance'].includes(filters.trigger_type)) {
      throw new Error('유효하지 않은 실행 유형 필터입니다.');
    }
    where.trigger_type = filters.trigger_type;
  }

  const startedAt = {};
  const fromDate = parseDateBoundary(filters.from, false);
  const toDate = parseDateBoundary(filters.to, true);

  if (filters.from && !fromDate) {
    throw new Error('유효하지 않은 시작일입니다.');
  }

  if (filters.to && !toDate) {
    throw new Error('유효하지 않은 종료일입니다.');
  }

  if (fromDate) {
    startedAt[Op.gte] = fromDate;
  }

  if (toDate) {
    startedAt[Op.lte] = toDate;
  }

  if (Object.keys(startedAt).length) {
    where.started_at = startedAt;
  }

  if (filters.q) {
    where[Op.or] = [
      { collector_key: { [Op.like]: `%${filters.q}%` } },
      { collector_label: { [Op.like]: `%${filters.q}%` } },
      { job_name: { [Op.like]: `%${filters.q}%` } },
      { actor_name: { [Op.like]: `%${filters.q}%` } },
      { actor_email: { [Op.like]: `%${filters.q}%` } },
      { error_message: { [Op.like]: `%${filters.q}%` } },
      { skip_reason: { [Op.like]: `%${filters.q}%` } }
    ];
  }

  return where;
}

function buildRunningTooLongItems(collectorStatus, thresholdMinutes) {
  const items = Array.isArray(collectorStatus.items) ? collectorStatus.items : [];
  const now = Date.now();
  const thresholdMs = Math.max(Number(thresholdMinutes) || 20, 1) * 60 * 1000;

  return items
    .filter(item => item && item.running && item.lastStartedAt)
    .map(item => {
      const startedAt = new Date(item.lastStartedAt);
      const elapsedMs = startedAt instanceof Date && !Number.isNaN(startedAt.getTime())
        ? now - startedAt.getTime()
        : 0;

      return {
        key: item.key,
        label: item.label,
        job_name: item.lastJob || '',
        started_at: item.lastStartedAt,
        elapsed_minutes: Math.max(0, Math.round(elapsedMs / 60000)),
        threshold_minutes: thresholdMinutes,
        last_error_message: item.lastErrorMessage || ''
      };
    })
    .filter(item => item.elapsed_minutes * 60 * 1000 >= thresholdMs);
}

/* ─────────────────────────────
   GET /api/admin/dashboard
───────────────────────────── */
router.get('/dashboard', async (req, res) => {
  try {
    const todayStart = getKstStartOfTodayUtc();
    const errorWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const alertConfig = typeof scheduler.getCollectorAlertConfig === 'function'
      ? scheduler.getCollectorAlertConfig()
      : {
          slackEnabled: false,
          cooldownMinutes: 30,
          stuckThresholdMinutes: 20,
          watchdogCron: '*/5 * * * *'
        };

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
      recentInquiries,
      recentCollectorLogs,
      recentCollectorErrors,
      collectorErrorCount24h
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
        attributes: [
          'id',
          'name',
          'email',
          'title',
          'category',
          'status',
          'createdAt',
          'message',
          'adminMemo',
          'processedAt',
          'processedBy'
        ]
      }),
      CollectorRunLog.findAll({
        order: [['createdAt', 'DESC']],
        limit: 20
      }),
      CollectorRunLog.findAll({
        where: {
          status: 'error',
          createdAt: { [Op.gte]: errorWindowStart }
        },
        order: [['createdAt', 'DESC']],
        limit: 5
      }),
      CollectorRunLog.count({
        where: {
          status: 'error',
          createdAt: { [Op.gte]: errorWindowStart }
        }
      })
    ]);

    const todayVisitors = new Set(
      todayPageViewRows.map(row => String(row.session_id || '').trim()).filter(Boolean)
    ).size;

    const collectorStatus = typeof scheduler.getCollectorStatuses === 'function'
      ? scheduler.getCollectorStatuses()
      : { generatedAt: new Date().toISOString(), items: [] };

    const collectorItems = Array.isArray(collectorStatus.items)
      ? collectorStatus.items
      : [];

    const collectorsEnabled = collectorItems.filter(item => item.enabled).length;
    const collectorsRunning = collectorItems.filter(item => item.running).length;
    const runningTooLongItems = buildRunningTooLongItems(
      collectorStatus,
      alertConfig.stuckThresholdMinutes
    );

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
        visitorsToday: todayVisitors,
        collectorsEnabled,
        collectorsRunning,
        collectorLogCount: recentCollectorLogs.length,
        collectorErrorCount24h,
        collectorsRunningTooLong: runningTooLongItems.length
      },
      collectorStatus,
      collectorAlerts: {
        generatedAt: new Date().toISOString(),
        slackEnabled: Boolean(alertConfig.slackEnabled),
        cooldownMinutes: alertConfig.cooldownMinutes,
        stuckThresholdMinutes: alertConfig.stuckThresholdMinutes,
        watchdogCron: alertConfig.watchdogCron,
        hasWarning: collectorErrorCount24h > 0 || runningTooLongItems.length > 0,
        recentErrorCount24h: collectorErrorCount24h,
        runningTooLongCount: runningTooLongItems.length,
        runningTooLongItems,
        recentErrors: recentCollectorErrors.map(toCollectorLogItem)
      },
      recentCollectorLogs: recentCollectorLogs.map(toCollectorLogItem),
      recentUsers: recentUsers.map(user => toUserListItem(user)),
      recentInquiries: recentInquiries.map(item => toInquiryItem(item))
    });
  } catch (err) {
    console.error('[ADMIN_DASHBOARD]', err);
    res.status(500).json({ error: '대시보드 데이터를 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   GET /api/admin/collectors/logs
───────────────────────────── */
router.get('/collectors/logs', async (req, res) => {
  try {
    const filters = buildCollectorLogFilters(req.query);
    const where = buildCollectorLogWhere(filters);

    const [result, startedCount, successCount, errorCount, skippedCount] = await Promise.all([
      CollectorRunLog.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        offset: filters.offset,
        limit: filters.limit
      }),
      CollectorRunLog.count({ where: { ...where, status: 'started' } }),
      CollectorRunLog.count({ where: { ...where, status: 'success' } }),
      CollectorRunLog.count({ where: { ...where, status: 'error' } }),
      CollectorRunLog.count({ where: { ...where, status: 'skipped' } })
    ]);

    res.json({
      data: result.rows.map(toCollectorLogItem),
      pagination: {
        total: result.count,
        page: filters.page,
        limit: filters.limit,
        pages: Math.max(Math.ceil(result.count / filters.limit), 1)
      },
      filters: {
        key: filters.key,
        status: filters.status,
        trigger_type: filters.trigger_type,
        from: filters.from,
        to: filters.to,
        q: filters.q
      },
      summary: {
        total: result.count,
        started: startedCount,
        success: successCount,
        error: errorCount,
        skipped: skippedCount
      }
    });
  } catch (err) {
    if (err && /유효하지 않은/.test(err.message || '')) {
      return res.status(400).json({ error: err.message });
    }

    console.error('[ADMIN_COLLECTOR_LOGS]', err);
    res.status(500).json({ error: '수집기 실행 이력을 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   GET /api/admin/collectors/logs/:id
───────────────────────────── */
router.get('/collectors/logs/:id', async (req, res) => {
  try {
    const row = await CollectorRunLog.findByPk(req.params.id);

    if (!row) {
      return res.status(404).json({ error: '실행 이력을 찾을 수 없습니다.' });
    }

    res.json({
      item: toCollectorLogItem(row)
    });
  } catch (err) {
    console.error('[ADMIN_COLLECTOR_LOG_DETAIL]', err);
    res.status(500).json({ error: '수집기 실행 이력 상세를 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   POST /api/admin/collectors/:key/run
───────────────────────────── */
router.post('/collectors/:key/run', async (req, res) => {
  try {
    const key = String(req.params.key || '').trim();

    const actorRow = req.userId
      ? await User.findByPk(req.userId, {
          attributes: ['id', 'email', 'nickname', 'role']
        })
      : null;

    const actor = actorRow
      ? {
          userId: actorRow.id,
          email: actorRow.email,
          name: actorRow.nickname,
          role: actorRow.role
        }
      : {
          userId: req.userId || null,
          role: req.userRole || 'admin'
        };

    const result = typeof scheduler.runCollectorNow === 'function'
      ? scheduler.runCollectorNow(key, req.body || {}, actor)
      : {
          ok: false,
          started: false,
          code: 'not_supported',
          message: '수동 실행 기능이 준비되지 않았습니다.',
          item: null
        };

    if (!result.ok && result.code === 'invalid_collector') {
      return res.status(400).json({ error: result.message, ...result });
    }

    const collectorStatus = typeof scheduler.getCollectorStatuses === 'function'
      ? scheduler.getCollectorStatuses()
      : { generatedAt: new Date().toISOString(), items: [] };

    const item = Array.isArray(collectorStatus.items)
      ? (collectorStatus.items.find(entry => entry.key === key) || result.item || null)
      : (result.item || null);

    const recentCollectorLogs = await CollectorRunLog.findAll({
      order: [['createdAt', 'DESC']],
      limit: 20
    });

    res.json({
      ...result,
      item,
      collectorStatus,
      recentCollectorLogs: recentCollectorLogs.map(toCollectorLogItem)
    });
  } catch (err) {
    console.error('[ADMIN_COLLECTOR_RUN]', err);
    res.status(500).json({ error: '수집기 수동 실행 중 오류가 발생했습니다.' });
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
        { category: { [Op.like]: `%${q}%` } },
        { adminMemo: { [Op.like]: `%${q}%` } }
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
      const item = toInquiryItem(row);
      return {
        ...item,
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

/* ─────────────────────────────
   GET /api/admin/inquiries/:id
───────────────────────────── */
router.get('/inquiries/:id', async (req, res) => {
  try {
    const inquiry = await Inquiry.findByPk(req.params.id);

    if (!inquiry) {
      return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });
    }

    let user = null;
    let processedByUser = null;

    if (inquiry.user_id) {
      const userRow = await User.findByPk(inquiry.user_id, {
        attributes: ['id', 'email', 'nickname', 'company', 'phone', 'role']
      });
      user = userRow ? userRow.toJSON() : null;
    }

    if (inquiry.processedBy) {
      const adminRow = await User.findByPk(inquiry.processedBy, {
        attributes: ['id', 'email', 'nickname', 'role']
      });
      processedByUser = adminRow ? adminRow.toJSON() : null;
    }

    res.json({
      inquiry: {
        ...toInquiryItem(inquiry),
        user,
        processedByUser
      }
    });
  } catch (err) {
    console.error('[ADMIN_INQUIRY_DETAIL]', err);
    res.status(500).json({ error: '문의 상세를 불러오는 중 오류가 발생했습니다.' });
  }
});

/* ─────────────────────────────
   PATCH /api/admin/inquiries/:id
───────────────────────────── */
router.patch('/inquiries/:id', async (req, res) => {
  try {
    const inquiry = await Inquiry.findByPk(req.params.id);

    if (!inquiry) {
      return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });
    }

    const {
      status,
      adminMemo
    } = req.body || {};

    if (status !== undefined) {
      const nextStatus = String(status || '').trim();
      if (!['received', 'in_progress', 'done'].includes(nextStatus)) {
        return res.status(400).json({ error: '유효하지 않은 상태값입니다.' });
      }
      inquiry.status = nextStatus;

      if (nextStatus === 'done') {
        inquiry.processedAt = new Date();
        inquiry.processedBy = req.userId || inquiry.processedBy || null;
      } else if (nextStatus === 'received') {
        inquiry.processedAt = null;
        inquiry.processedBy = null;
      }
    }

    if (adminMemo !== undefined) {
      inquiry.adminMemo = String(adminMemo || '').trim();
    }

    await inquiry.save();

    let processedByUser = null;
    if (inquiry.processedBy) {
      const adminRow = await User.findByPk(inquiry.processedBy, {
        attributes: ['id', 'email', 'nickname', 'role']
      });
      processedByUser = adminRow ? adminRow.toJSON() : null;
    }

    res.json({
      message: '문의 상태가 저장되었습니다.',
      inquiry: {
        ...toInquiryItem(inquiry),
        processedByUser
      }
    });
  } catch (err) {
    console.error('[ADMIN_INQUIRY_UPDATE]', err);
    res.status(500).json({ error: '문의 상태 저장 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
