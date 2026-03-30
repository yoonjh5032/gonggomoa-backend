/* ═══════════════════════════════════════════════════
   server.js  —  공고모아 백엔드 (MySQL 버전)
═══════════════════════════════════════════════════ */
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { connectDB } = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 4000;

/* ── 미들웨어 ── */
app.use(helmet());
app.use(express.json({ limit: '2mb' }));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
}));

/* ── 라우트 ── */
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/notices', require('./routes/notices'));

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || '서버 에러' });
});

/* ── DB 연결 → 서버 시작 → 스케줄러 ── */
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 공고모아 API 서버 시작: http://localhost:${PORT}`);

    if (process.env.CRON_ENABLED === 'true') {
      const scheduler = require('./services/scheduler');
      scheduler.start();
      console.log('⏰ 크론 스케줄러 활성화 (KST 08:00~19:00 매 분)');
    }
  });
});
