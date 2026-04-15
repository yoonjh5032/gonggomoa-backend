/* models/Notice.js — 공고 모델 (Sequelize + MySQL) */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

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
    type: DataTypes.ENUM('g2b_api', 'seoul_board', 'seoul_contract', 'nonghyup', 'local_gov', 'province_gov'),
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
  normalized_bid_method: {
    type: DataTypes.STRING(100),
    defaultValue: ''
  },

  /* ── 노출 정책 ── */
  is_hidden: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  hidden_reason: {
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
    {
      unique: true,
      fields: ['bid_ntce_no', 'bid_ntce_ord', 'source_system'],
      name: 'uq_notice'
    },
    { fields: ['closing_at'] },
    { fields: ['published_at'] },
    { fields: ['source_system'] },
    { fields: ['notice_type'] },
    { fields: ['is_hidden'] },
    { fields: ['source_system', 'is_hidden'] },
    { fields: ['is_hidden', 'closing_at'], name: 'idx_notice_visible_closing' },
    { fields: ['source_system', 'is_hidden', 'closing_at'], name: 'idx_notice_source_visible_closing' },
    { fields: ['notice_type', 'is_hidden', 'closing_at'], name: 'idx_notice_type_visible_closing' },
    { fields: ['source_system', 'notice_type', 'is_hidden', 'closing_at'], name: 'idx_notice_source_type_visible_closing' },
    { fields: ['is_hidden', 'published_at'], name: 'idx_notice_visible_published' },
    { fields: ['source_system', 'is_hidden', 'published_at'], name: 'idx_notice_source_visible_published' },
    { fields: ['notice_type', 'is_hidden', 'published_at'], name: 'idx_notice_type_visible_published' },
    {
      fields: ['title', 'issuing_org', 'demanding_org'],
      type: 'FULLTEXT',
      name: 'ft_notice_search'
    }
  ]
});

module.exports = Notice;
