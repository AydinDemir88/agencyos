require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes       = require('./routes/auth');
const userRoutes       = require('./routes/users');
const ndcRoutes        = require('./routes/ndc');
const corporateRoutes  = require('./routes/corporates');
const searchRoutes     = require('./routes/search');
const bookingRoutes    = require('./routes/bookings');
const visaRoutes       = require('./routes/visas');

const app = express();

// ---------------------------------------------------------------------------
// Security headers (helmet defaults + CSP)
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'"],
      objectSrc  : ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// ---------------------------------------------------------------------------
// CORS — whitelist only, no wildcard
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server requests (no Origin header) and whitelisted origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin '${origin}' not allowed by CORS policy`));
    }
  },
  credentials: true,         // Required for httpOnly cookies
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------------
// Body parsing & cookies
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10kb' }));   // Reject oversized payloads
app.use(cookieParser());

// Trust first proxy hop — required for accurate req.ip behind load balancers
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/auth',         authRoutes);
app.use('/users',        userRoutes);
app.use('/ndc/airlines', ndcRoutes);
app.use('/corporates',   corporateRoutes);
app.use('/search',       searchRoutes);
app.use('/bookings',     bookingRoutes);
app.use('/visas',        visaRoutes);

// Health check (no auth required)
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never expose internal error details to clients
  console.error('[APP] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
