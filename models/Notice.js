/* models/Notice.js — 공고 모델 (Sequelize + MySQL) */
const { DataTypes } = require('sequelize');
const { sequelize }  = require('../config/db');

const Notice = sequelize.define('Notice', {
  id: {
    type: DataTypes.INTEGER.UNSIGNED,
    autoIncrement: true,
    primaryKey: true
  },

  /* ── 식별 ── */
  bid_ntce_no: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  bid_ntce_ord: {
    type: DataTypes.STRING(10),
    defaultValue: '00'
  },
  source_system: {
    type: DataTypes.ENUM('g2b_api', 'seoul_board', 'seoul_contract', 'nonghyup', 'local_gov'),
    allowNull: false
  },

  /* ── 기본 정보 ── */
  title: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  notice_type: {
    type: DataTypes.STRING(20),
    defaultValue: ''
  },
  bid_method: {
    type: DataTypes.STRING(100),
    defaultValue: ''
  },
  contract_method: {
    type: DataTypes.STRING(100),
    defaultValue: ''
  },

  /* ── 기관 ── */
  issuing_org: {
    type: DataTypes.STRING(200),
    defaultValue: ''
  },
  demanding_org: {
    type: DataTypes.STRING(200),
    defaultValue: ''
  },

  /* ── 금액 ── */
  budget: {
    type: DataTypes.BIGINT,
    defaultValue: 0
  },
  estimated_price: {
    type: DataTypes.BIGINT,
    defaultValue: 0
  },
  budget_formatted: {
    type: DataTypes.STRING(50),
    defaultValue: ''
  },

  /* ── 일시 ── */
  published_at: {
    type: DataTypes.DATE
  },
  closing_at: {
    type: DataTypes.DATE
  },
  opening_at: {
    type: DataTypes.DATE
  },

  /* ── 링크 ── */
  detail_url: {
    type: DataTypes.STRING(500),
    defaultValue: ''
  },

  /* ── 메타 ── */
  raw_data: {
    type: DataTypes.JSON
  },
  collected_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'notices',
  indexes: [
    // 중복 방지: 공고번호+차수+출처
    {
      unique: true,
      fields: ['bid_ntce_no', 'bid_ntce_ord', 'source_system'],
      name: 'uq_notice'
    },
    // 검색/정렬용 인덱스
    { fields: ['closing_at'] },
    { fields: ['published_at'] },
    { fields: ['source_system'] },
    { fields: ['notice_type'] },
    { fields: ['title'], type: 'FULLTEXT' }
  ]
});

module.exports = Notice;
