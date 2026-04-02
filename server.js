/* ═══════════════════════════════════════════════════
   server.js  —  공고모아 백엔드 (MySQL 버전)
═══════════════════════════════════════════════════ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { connectDB } = require('./config/db');
const Notice = require('./models/Notice');
const User = require('./models/User');
const app = express();
const PORT = process.env.PORT || 4000;
const scheduler = require('./services/scheduler');

app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '2mb' }));

const allowedOrigins = [
  'https://gonggomoa.kr',
  'https://www.gonggomoa.kr',
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
].filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);

    const normalizedOrigin = String(origin).replace(/\/$/, '');
    const isAllowed = allowedOrigins.some((o) => {
      const normalizedAllowed = String(o).replace(/\/$/, '');
      return normalizedOrigin === normalizedAllowed;
    });

    if (isAllowed) return cb(null, true);

    console.warn('⛔ CORS 차단:', origin);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
}));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/notices', require('./routes/notices'));
app.use('/api/inquiries', require('./routes/inquiries'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/analytics', require('./routes/analytics'));

app.get('/api/health', (_, res) => {
  const enabledCollectors = typeof scheduler.getEnabledCollectorSources === 'function'
    ? scheduler.getEnabledCollectorSources()
    : ['g2b_api'];
  res.json({ status: 'ok', time: new Date().toISOString(), enabledCollectors });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || '서버 에러' });
});

async function applyAdminRolesFromEnv() {
  const emails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

  if (!emails.length) {
    console.log('ℹ️ ADMIN_EMAILS 설정이 없어 관리자 승격 자동 적용을 건너뜁니다.');
    return;
  }

  try {
    const [updatedCount] = await User.update(
      { role: 'admin' },
      { where: { email: emails } }
    );
    console.log(`✅ 관리자 권한 자동 적용 완료 (변경 수: ${updatedCount})`);
  } catch (err) {
    console.error('❌ 관리자 권한 적용 실패:', err.message);
  }
}

connectDB().then(async () => {
  if (process.env.RESET_NOTICES_ON_START === 'true') {
    try {
      await Notice.destroy({ where: {}, truncate: true });
      console.log('🧹 notices 테이블 초기화 완료 (회원 데이터는 유지됨)');
    } catch (err) {
      console.error('❌ notices 초기화 실패:', err.message);
      process.exit(1);
    }
  }

  await applyAdminRolesFromEnv();

  app.listen(PORT, () => {
    console.log(`✅ 공고모아 API 서버 시작: http://localhost:${PORT}`);
    scheduler.start();
  });
}).catch((err) => {
  console.error('❌ 서버 시작 실패:', err.message);
  process.exit(1);
});
