/* models/User.js — 회원 모델 (Sequelize + MySQL) */
const { DataTypes } = require('sequelize');
const { sequelize }  = require('../config/db');
const bcrypt          = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER.UNSIGNED,
    autoIncrement: true,
    primaryKey: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
    validate: { isEmail: true }
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  nickname: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  company: {
    type: DataTypes.STRING(100),
    defaultValue: ''
  },
  phone: {
    type: DataTypes.STRING(20),
    defaultValue: ''
  },
  role: {
    type: DataTypes.ENUM('user', 'admin'),
    defaultValue: 'user'
  },
  // 관심 키워드 (JSON 배열로 저장)
  keywords: {
    type: DataTypes.JSON,
    defaultValue: []
  },
  // 즐겨찾기 공고 ID 배열 (JSON)
  bookmarks: {
    type: DataTypes.JSON,
    defaultValue: []
  }
}, {
  tableName: 'users',
  // password를 기본 JSON 응답에서 제외
  defaultScope: {
    attributes: { exclude: ['password'] }
  },
  scopes: {
    withPassword: { attributes: {} }  // password 포함 조회용
  }
});

// ── 비밀번호 해시 (저장 전) ──
User.beforeCreate(async (user) => {
  user.password = await bcrypt.hash(user.password, 12);
});
User.beforeUpdate(async (user) => {
  if (user.changed('password')) {
    user.password = await bcrypt.hash(user.password, 12);
  }
});

// ── 비밀번호 비교 ──
User.prototype.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = User;
