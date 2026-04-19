const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  min: parseInt(process.env.DB_POOL_MIN || '2', 10),
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // Never log the connection string — only log the message
  console.error('[DB] Unexpected pool error:', err.message);
  process.exit(-1);
});

module.exports = pool;
