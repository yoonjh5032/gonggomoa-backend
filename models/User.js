/* models/User.js — 회원 스키마 */
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String, required: true, unique: true,
    lowercase: true, trim: true,
    match: [/^\S+@\S+\.\S+$/, '유효한 이메일을 입력하세요.']
  },
  password:  { type: String, required: true, minlength: 6 },
  nickname:  { type: String, required: true, trim: true, minlength: 2, maxlength: 20 },
  company:   { type: String, default: '' },
  phone:     { type: String, default: '' },
  role:      { type: String, enum: ['user', 'admin'], default: 'user' },
  // 즐겨찾기 (공고 ID 배열)
  bookmarks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Notice' }],
  // 키워드 알림
  keywords:  [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 비밀번호 해시
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.updatedAt = new Date();
  next();
});

// 비밀번호 비교
userSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// JSON 직렬화 시 password 제거
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
