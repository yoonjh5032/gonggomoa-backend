/* middleware/auth.js — JWT 인증 미들웨어 */
const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  try {
    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId    = decoded.id;
    req.userRole  = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' });
  }
};
