const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CollectorRunLog = sequelize.define('CollectorRunLog', {
  id: {
    type: DataTypes.INTEGER.UNSIGNED,
    autoIncrement: true,
    primaryKey: true,
  },
  collector_key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  collector_label: {
    type: DataTypes.STRING(100),
    defaultValue: '',
  },
  kind: {
    type: DataTypes.STRING(30),
    defaultValue: 'collector',
  },
  job_name: {
    type: DataTypes.STRING(50),
    defaultValue: '',
  },
  trigger_type: {
    type: DataTypes.STRING(30),
    defaultValue: 'scheduled',
  },
  status: {
    type: DataTypes.ENUM('started', 'success', 'error', 'skipped'),
    allowNull: false,
    defaultValue: 'started',
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  finished_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  duration_ms: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  },
  result: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  error_message: {
    type: DataTypes.STRING(500),
    defaultValue: '',
  },
  skip_reason: {
    type: DataTypes.STRING(120),
    defaultValue: '',
  },
  actor_user_id: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  },
  actor_email: {
    type: DataTypes.STRING(255),
    defaultValue: '',
  },
  actor_name: {
    type: DataTypes.STRING(100),
    defaultValue: '',
  },
  actor_role: {
    type: DataTypes.STRING(20),
    defaultValue: '',
  },
  request_payload: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'collector_run_logs',
  indexes: [
    { fields: ['collector_key'] },
    { fields: ['status'] },
    { fields: ['trigger_type'] },
    { fields: ['started_at'] },
    { fields: ['createdAt'] },
    { fields: ['collector_key', 'createdAt'] },
    { fields: ['collector_key', 'status'] },
  ],
});

module.exports = CollectorRunLog;
