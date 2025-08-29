// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- simple auth gate (optional) ---
function gate(req, res, next) {
  const key = process.env.CUSTOMER_KEY;
  if (!key) return next(); // gate off if no key set
  const provided = req.query.key || req.get('x-customer-key');
  if (provided === key) return next();
  return res.status(401).send('Unauthorized');
}

// Serve static files from the "static" directory
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.json());

// apply gate to portal + APIs
app.use(['/portal', '/api/portal'], gate);

// serve the portal
app.get('/', (req, res) => res.redirect('/portal'));
app.get('/portal', (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'portal.html'))
);

// -------- In-memory data (replace with real data later) --------
const state = {
  startedAt: Date.now(),
  requestsToday: 0,
  successesToday: 0,
  latSamples: [],         // keep last N latencies in ms
  events: [],             // { at, message }
  errors: [],             // { at, message }
  usage: { period: 'Current', tokens: 0, costUSD: 0, model: null, user: null }
};

// Demo ticker so the UI isn’t empty (remove when wired to real data)
setInterval(() => {
  const r = Math.floor(30 + Math.random() * 70);
  const ok = Math.floor(r * (0.95 + Math.random() * 0.05));
  state.requestsToday += r;
  state.successesToday += ok;
  state.latSamples.push(100 + Math.random() * 150);
  if (state.latSamples.length > 200) state.latSamples.shift();
}, 2000);

function metrics() {
  const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
  const successRate = state.requestsToday
    ? Math.round((state.successesToday / state.requestsToday) * 1000) / 10
    : 100;
  const avgLatency = state.latSamples.length
    ? Math.round(state.latSamples.reduce((a,b)=>a+b,0) / state.latSamples.length)
    : 0;

  return {
    status: successRate >= 99 && avgLatency < 250 ? 'ok' :
            successRate >= 95 ? 'degraded' : 'down',
    uptimeSec,
    requestsToday: state.requestsToday,
    successRate,
    avgLatencyMs: avgLatency,
    leadsByDay: [], // placeholder if you want a chart later
    usage: state.usage
  };
}

// -------------------- APIs (read) --------------------
app.get('/api/portal/metrics', (req, res) => res.json(metrics()));
app.get('/api/portal/events',  (req, res) => res.json(state.events));
app.get('/api/portal/errors',  (req, res) => res.json(state.errors));
app.get('/api/portal/health',  (req, res) => res.json({ ok: true, ts: Date.now() }));

// -------------------- APIs (write) --------------------
app.post('/api/portal/log-event', (req, res) => {
  const { message } = req.body;
  const role = req.query.role || "sys";

  if (!state.events) state.events = [];

  state.events.unshift({
    at: new Date().toISOString(),
    role,
    message
  });

  // Keep only recent 50
  state.events = state.events.slice(0, 50);

  console.log("📝 Logged event:", role, message);
  res.json({ ok: true });
});



app.post('/api/portal/log-error', (req, res) => {
  const msg = (req.body && req.body.message) || 'error';
  state.errors.unshift({ at: Date.now(), message: msg });
  state.errors = state.errors.slice(0, 100);
  res.json({ ok: true });
});

// NEW: usage logging
// NEW: usage logging
app.post('/api/portal/log-usage', (req, res) => {
  const usage = req.body || {};
  console.log("📊 Received usage log:", usage); 
  state.usage = {
    period: 'Current',
    model: usage.model,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    cached_tokens: usage.cached_tokens,
    user: usage.user,
    costUSD: usage.costUSD || usage.cost || 0,   // 👈 flexible
    breakdown: usage.breakdown || null           // 👈 optional
  };

  res.json({ ok: true });
});


// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Portal running at http://localhost:${PORT}/portal`);
  if (process.env.CUSTOMER_KEY) {
    console.log('🔐 Auth enabled: supply ?key=YOUR_KEY or header x-customer-key: YOUR_KEY');
  }
});
