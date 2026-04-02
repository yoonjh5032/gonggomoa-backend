const jwt = require('jsonwebtoken');

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
  }
  return secret;
}

function signUserToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

module.exports = {
  getJwtSecret,
  signUserToken,
  verifyToken
};
