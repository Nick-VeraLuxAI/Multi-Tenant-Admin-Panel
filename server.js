// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

// DB (same RDS as the bot)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 4000;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const COOKIE_NAME = 'solomon_session';

function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',  // ✅ only over HTTPS in prod
    maxAge: 1000*60*60*24*7
  });
}

function readSession(req) {
  const t = req.cookies?.[COOKIE_NAME];
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}

function requireAuth(req, res, next) {
  // gate() runs earlier; it will pass when either key is valid OR req.user is set.
  const sess = readSession(req);
  if (!sess) return res.status(401).json({ error: 'auth_required' });
  req.user = sess; // { adminUserId, tenantId, email }
  next();
}




app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.json());
app.use(cookieParser());
app.use('/api/portal', requireAuth);

app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'pricing.html'));
});

// serve the portal
app.get('/', (req, res) => res.redirect('/portal'));
app.get('/portal', (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'portal.html'))
);

// --- POST /api/login ---
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // find user by email (unique across all tenants)
    const user = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });

    // ✅ login success — set session cookie
    const payload = { adminUserId: user.id, tenantId: user.tenantId, email: user.email };
    setSessionCookie(res, payload);

    res.json({ ok: true, tenantId: user.tenantId });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ error: 'server_error' });
  }
});


// --- POST /api/logout ---
app.post('/api/logout', requireAuth, (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// --- GET /api/me (check session) ---
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user); // { adminUserId, tenantId, email }
});



// Resolve tenant for admin (from session)
function resolveAdminTenant(req) {
  // ✅ If session is present, always use tenantId from it
  if (req.user && req.user.tenantId) {
    return String(req.user.tenantId).toLowerCase();
  }
  return 'default';
}



// List tenants for picker
app.get('/api/tenants', requireAuth, async (_req, res) => {
  const rows = await prisma.tenant.findMany({
    select: { id: true, name: true, subdomain: true, plan: true },
    orderBy: { name: 'asc' }
  });
  res.json(rows);
});




// server.js (the admin/portal server)
app.get('/api/portal/premium', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const state = getTenantState(tenant);

  const leads = (state.metrics || []).filter(m => m.type === 'lead' && m.value);
  const totalLeads  = leads.length;
  const withContact = leads.filter(m => m.value.email && m.value.phone).length;

  const conversations = Object.values(state.conversations || {}).map(c => ({
    name: c.name || c.email || 'Unknown',
    snippet: c.snippet || c.lastMessage || '',
    at: c.at || new Date().toISOString(),
    email: c.email || '',
    phone: c.phone || '',
    tags: Array.isArray(c.tags) ? c.tags : []
  }));

  const tagCounts = {};
  for (const m of leads) {
    for (const t of (m.value.tags || [])) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  const topics = Object.entries(tagCounts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10)
    .map(([t]) => t);

  res.json({ totalLeads, withContact, conversations, topics });
});


// -------------------- Multi-tenant state --------------------
const stateByTenant = {};
function getTenantState(tenant) {
  if (!stateByTenant[tenant]) {
    stateByTenant[tenant] = {
      startedAt: Date.now(),
      requestsToday: 0,
      successesToday: 0,
      latSamples: [],
      events: [],
      errors: [],
      usage: { period: 'Current', tokens: 0, costUSD: 0, model: null, user: null },
      usages: [],
      metrics: [],
      conversations: {}
    };
  }
  return stateByTenant[tenant];
}

function metrics(state) {
  const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
  const successRate = state.requestsToday
    ? Math.round((state.successesToday / state.requestsToday) * 1000) / 10
    : 100;
  const avgLatency = state.latSamples.length
    ? Math.round(state.latSamples.reduce((a, b) => a + b, 0) / state.latSamples.length)
    : 0;

  return {
    status: successRate >= 99 && avgLatency < 250 ? 'ok' :
            successRate >= 95 ? 'degraded' : 'down',
    uptimeSec,
    requestsToday: state.requestsToday,
    successRate,
    avgLatencyMs: avgLatency,
    leadsByDay: [], // placeholder for chart
    usage: state.usage
  };
}

// -------------------- APIs (read) --------------------
app.get('/api/portal/metrics', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const data = metrics(getTenantState(tenant));
  console.log(`📤 [${tenant}] Sending metrics:`, data);
  res.json(data);
});

app.get('/api/portal/events', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const events = getTenantState(tenant).events;
  console.log(`📤 [${tenant}] Sending ${events.length} events`);
  res.json(events);
});

app.get('/api/portal/errors', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const errors = getTenantState(tenant).errors;
  console.log(`📤 [${tenant}] Sending ${errors.length} errors`);
  res.json(errors);
});

app.get('/api/portal/usage', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const state = getTenantState(tenant);
  console.log(`📤 [${tenant}] Sending usage: current=`, state.usage, `history count=${state.usages.length}`);
  res.json({ current: state.usage, history: state.usages });
});

app.get('/api/portal/health', (req, res) => {
  console.log(`📤 Health check ping at ${new Date().toISOString()}`);
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/portal/metrics-log', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const metricsLog = getTenantState(tenant).metrics;
  console.log(`📤 [${tenant}] Sending metrics-log (${metricsLog.length} entries)`);
  res.json(metricsLog);
});

app.get('/api/portal/conversations', requireAuth, (req, res) => {
  const tenant = resolveAdminTenant(req);
  const conversations = getTenantState(tenant).conversations;
  console.log(`📤 [${tenant}] Sending conversations: ${Object.keys(conversations).length} sessions`);
  res.json(conversations);
});

// -------------------- APIs (write: unified) --------------------
app.post('/api/portal/log', (req, res) => {
  const tenant = resolveAdminTenant(req);
  const state = getTenantState(tenant);
  const { type, role, message, user, usage, metricType, value, sessionId, data } = req.body;

  switch (type) {
    case "event":
      addEvent(state, role, message, tenant);
      break;
    case "error":
      addError(state, user, message, tenant);
      break;
    case "usage":
      addUsage(state, usage, tenant);
      break;
    case "metric":
      addMetric(state, metricType, value, tenant);
      break;
    case "conversation":
      addConversation(state, sessionId, data, tenant);
      break;
    default:
      console.warn(`⚠️ [${tenant}] Unknown log type: ${type}`);
  }

  res.json({ ok: true });
});

// -------------------- APIs (write: explicit endpoints) --------------------
app.post('/api/portal/log-event', (req, res) => {
  const tenant = resolveAdminTenant(req);
  const { role } = req.query; // or move role into body if you prefer
  addEvent(getTenantState(tenant), role, req.body.message, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-error', (req, res) => {
  const tenant = resolveAdminTenant(req);
  const { user } = req.query; // or body
  addError(getTenantState(tenant), user, req.body.message, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-usage', (req, res) => {
  const tenant = resolveAdminTenant(req);
  addUsage(getTenantState(tenant), req.body, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-metric', (req, res) => {
  const tenant = resolveAdminTenant(req);
  const { type } = req.query; // or body
  addMetric(getTenantState(tenant), type, req.body.value, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-conversation', (req, res) => {
  const tenant = resolveAdminTenant(req);
  const { sessionId } = req.query; // or body
  addConversation(getTenantState(tenant), sessionId, req.body, tenant);
  res.json({ ok: true });
});


// -------------------- Helpers --------------------
function addEvent(state, role, message, tenant) {
  state.events.unshift({
    at: new Date().toISOString(),
    role: role || "sys",
    message: message || ""
  });
  state.events = state.events.slice(0, 50);
  state.requestsToday++;
  console.log(`📝 [${tenant}] Event:`, role, message);
}

function addError(state, user, message, tenant) {
  state.errors.unshift({
    at: new Date().toISOString(),
    user,
    message: message || "error"
  });
  state.errors = state.errors.slice(0, 100);
  console.log(`❌ [${tenant}] Error:`, message);
}

function addUsage(state, usage, tenant) {
  const u = usage || {};

  // Normalize breakdown so frontend charts always get consistent keys
  const breakdown = {
    promptUSD: u.breakdown?.inputCost ?? u.breakdown?.promptUSD ?? 0,
    completionUSD: u.breakdown?.outputCost ?? u.breakdown?.completionUSD ?? 0,
    cachedUSD: u.breakdown?.cachedCost ?? u.breakdown?.cachedUSD ?? 0,
    total: u.breakdown?.total ?? u.costUSD ?? u.cost ?? 0
  };

  // Normalize into a single record
  const normalized = {
    at: new Date().toISOString(),
    model: u.model,
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
    cached_tokens: u.cached_tokens || 0,
    user: u.user,
    costUSD: u.costUSD || u.cost || 0,
    breakdown
  };

  // Save "current"
  state.usage = { ...normalized, period: 'Current' };

  // Save to history
  state.usages.unshift(normalized);
  state.usages = state.usages.slice(0, 100);

  console.log(`📊 [${tenant}] Usage log:`, normalized);
}


function addMetric(state, type, value, tenant) {
  state.metrics.unshift({ at: new Date().toISOString(), type, value });
  state.metrics = state.metrics.slice(0, 100);
  if (type === "latency") state.latSamples.push(value);
  if (type === "success") state.successesToday++;
  console.log(`📈 [${tenant}] Metric: ${type} = ${value}`);
}

function addConversation(state, sessionId, data, tenant) {
  state.conversations[sessionId] = { at: new Date().toISOString(), ...data };

  // Premium counters
  state.totalLeads = (state.totalLeads || 0) + 1;
  if (data.email || data.phone) state.withContact = (state.withContact || 0) + 1;
  if (Array.isArray(data.tags)) {
    const cur = new Set(state.topics || []);
    data.tags.forEach(t => cur.add(String(t)));
    state.topics = Array.from(cur);
  }
}

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Portal running at http://localhost:${PORT}/portal`);
});

