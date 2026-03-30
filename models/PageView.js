const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const PageView = sequelize.define('PageView', {
  id: {
    type: DataTypes.INTEGER.UNSIGNED,
    autoIncrement: true,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true
  },
  session_id: {
    type: DataTypes.STRING(100),
    allowNull: false,
    defaultValue: ''
  },
  path: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  title: {
    type: DataTypes.STRING(255),
    defaultValue: ''
  },
  referrer: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  ip: {
    type: DataTypes.STRING(64),
    defaultValue: ''
  },
  user_agent: {
    type: DataTypes.TEXT,
    defaultValue: ''
  }
}, {
  tableName: 'page_views',
  indexes: [
    { fields: ['createdAt'] },
    { fields: ['path'] },
    { fields: ['session_id'] },
    { fields: ['user_id'] }
  ]
});

module.exports = PageView;
