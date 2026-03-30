/* config/db.js — MongoDB 연결 */
const mongoose = require('mongoose');

module.exports = async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/gonggomoa';
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB 연결 성공');
  } catch (err) {
    console.error('❌ MongoDB 연결 실패:', err.message);
    process.exit(1);
  }
};
