/* middleware/auth.js — JWT 인증 미들웨어 */
const { verifyToken } = require('../utils/jwt');

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = verifyToken(token);
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: '인증이 만료되었거나 올바르지 않습니다. 다시 로그인해주세요.' });
  }
};
