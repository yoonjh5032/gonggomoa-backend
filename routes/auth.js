/* routes/auth.js — 회원가입 / 로그인 / 마이페이지 (MySQL) */
const router = require('express').Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const { signUserToken } = require('../utils/jwt');

function normalizeKeywords(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(
    list
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .map(v => v.slice(0, 30))
  )].slice(0, 10);
}
function serializeUser(user) {
  const data = user.toJSON ? user.toJSON() : { ...user };
  data.keywords = normalizeKeywords(data.keywords);
  data.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
  return data;
}

/* ──────────── 회원가입 ──────────── */
router.post('/register', async (req, res) => {
  try {
    const { email, password, nickname, company, phone } = req.body;

    if (!email || !password || !nickname) {
      return res.status(400).json({ error: '이메일, 비밀번호, 닉네임은 필수입니다.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
    }

    const exists = await User.scope('withPassword').findOne({ where: { email } });
    if (exists) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });

    const user = await User.create({
      email,
      password,
      nickname,
      company: company || '',
      phone: phone || ''
    });

    const userData = user.toJSON();
    delete userData.password;
    const token = signUserToken(user);

    res.status(201).json({ token, user: userData });
  } catch (err) {
    console.error('[REGISTER]', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    }
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
  }
});

/* ──────────── 로그인 ──────────── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' });
    }

    const user = await User.scope('withPassword').findOne({ where: { email } });
    if (!user) return res.status(401).json({ error: '이메일 또는 비밀번호가 일치하지 않습니다.' });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ error: '이메일 또는 비밀번호가 일치하지 않습니다.' });

    const userData = user.toJSON();
    delete userData.password;
    const token = signUserToken(user);

    res.json({ token, user: userData });
  } catch (err) {
    console.error('[LOGIN]', err);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

/* ──────────── 내 정보 조회 ──────────── */
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

/* ──────────── 내 정보 수정 ──────────── */
router.put('/me', auth, async (req, res) => {
  try {
    const { nickname, company, phone, keywords } = req.body;
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    if (nickname !== undefined) user.nickname = String(nickname || '').trim();
    if (company !== undefined) user.company = String(company || '').trim();
    if (phone !== undefined) user.phone = String(phone || '').trim();
    if (keywords !== undefined) user.keywords = normalizeKeywords(keywords);
    await user.save();

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: '정보 수정 중 오류가 발생했습니다.' });
  }
});

/* ──────────── 비밀번호 변경 ──────────── */
router.put('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다.' });
    }

    const user = await User.scope('withPassword').findByPk(req.userId);
    const match = await user.comparePassword(currentPassword);
    if (!match) return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });

    user.password = newPassword;
    await user.save();
    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
  }
});

/* ──────────── 즐겨찾기 토글 ──────────── */
router.post('/bookmark/:noticeId', auth, async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    const noticeId = parseInt(req.params.noticeId);
    let bookmarks = user.bookmarks || [];

    const idx = bookmarks.indexOf(noticeId);
    if (idx === -1) {
      bookmarks.push(noticeId);
    } else {
      bookmarks.splice(idx, 1);
    }

    user.bookmarks = bookmarks;
    await user.save();
    res.json({ bookmarks: user.bookmarks });
  } catch (err) {
    res.status(500).json({ error: '즐겨찾기 처리 중 오류' });
  }
});

module.exports = router;
