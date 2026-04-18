require('dotenv').config();

// Guard: abort startup if critical secrets are missing
const REQUIRED_ENV = ['DB_URL', 'JWT_SECRET', 'MASTER_ENCRYPTION_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[STARTUP] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app  = require('./app');
const pool = require('./config/db');

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  // Verify DB connectivity before accepting traffic
  try {
    await pool.query('SELECT 1');
    console.log('[STARTUP] Database connection verified');
  } catch (err) {
    console.error('[STARTUP] Cannot connect to database:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`[STARTUP] AgencyOS API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[SHUTDOWN] ${signal} received — closing server`);
    server.close(async () => {
      await pool.end();
      console.log('[SHUTDOWN] DB pool closed. Exiting.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
