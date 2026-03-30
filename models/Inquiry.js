const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Inquiry = sequelize.define('Inquiry', {
  id: {
    type: DataTypes.INTEGER.UNSIGNED,
    autoIncrement: true,
    primaryKey: true
  },
  category: {
    type: DataTypes.ENUM('general', 'service', 'advertisement', 'bug', 'partnership', 'other'),
    allowNull: false,
    defaultValue: 'general'
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: { isEmail: true }
  },
  phone: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: ''
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  agree: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  pageUrl: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: ''
  },
  referrer: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: ''
  },
  status: {
    type: DataTypes.ENUM('received', 'in_progress', 'done'),
    allowNull: false,
    defaultValue: 'received'
  }
}, {
  tableName: 'inquiries',
  indexes: [
    { fields: ['status'] },
    { fields: ['email'] },
    { fields: ['createdAt'] }
  ]
});

module.exports = Inquiry;
