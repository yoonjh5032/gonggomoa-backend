const express = require('express');
const router = express.Router();
const Inquiry = require('../models/Inquiry');

function clean(value) {
  return String(value || '').trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/', async (req, res) => {
  try {
    const category = clean(req.body.category) || 'general';
    const name = clean(req.body.name);
    const email = clean(req.body.email);
    const phone = clean(req.body.phone);
    const title = clean(req.body.title);
    const message = clean(req.body.message);
    const pageUrl = clean(req.body.pageUrl);
    const referrer = clean(req.body.referrer);
    const agree = !!req.body.agree;

    if (!name || !email || !title || !message) {
      return res.status(400).json({
        error: '이름, 이메일, 제목, 문의 내용은 필수입니다.'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: '올바른 이메일 형식을 입력해주세요.'
      });
    }

    if (!agree) {
      return res.status(400).json({
        error: '개인정보 수집 및 이용 동의가 필요합니다.'
      });
    }

    const inquiry = await Inquiry.create({
      category,
      name,
      email,
      phone,
      title,
      message,
      agree,
      pageUrl,
      referrer,
      status: 'received'
    });

    return res.status(201).json({
      ok: true,
      message: '문의가 정상 접수되었습니다.',
      inquiry: {
        id: inquiry.id,
        category: inquiry.category,
        name: inquiry.name,
        email: inquiry.email,
        phone: inquiry.phone,
        title: inquiry.title,
        message: inquiry.message,
        status: inquiry.status,
        createdAt: inquiry.createdAt
      }
    });
  } catch (err) {
    console.error('[INQUIRIES_POST]', err);
    return res.status(500).json({
      error: '문의 저장 중 오류가 발생했습니다.'
    });
  }
});

module.exports = router;
