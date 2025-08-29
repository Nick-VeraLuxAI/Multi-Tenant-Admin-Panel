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

app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.json());

// apply gate to portal + APIs
app.use(['/portal', '/api/portal'], gate);

// serve the portal
app.get('/', (req, res) => res.redirect('/portal'));
app.get('/portal', (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'portal.html'))
);

// server.js (the admin/portal server)
app.get('/api/portal/premium', (req, res) => {
  const tenant = (req.query.tenant || "default").toLowerCase();
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
app.get('/api/portal/metrics', (req, res) => {
  const tenant = req.query.tenant || "default";
  const data = metrics(getTenantState(tenant));
  console.log(`📤 [${tenant}] Sending metrics:`, data);
  res.json(data);
});

app.get('/api/portal/events', (req, res) => {
  const tenant = req.query.tenant || "default";
  const events = getTenantState(tenant).events;
  console.log(`📤 [${tenant}] Sending ${events.length} events`);
  res.json(events);
});

app.get('/api/portal/errors', (req, res) => {
  const tenant = req.query.tenant || "default";
  const errors = getTenantState(tenant).errors;
  console.log(`📤 [${tenant}] Sending ${errors.length} errors`);
  res.json(errors);
});

app.get('/api/portal/usage', (req, res) => {
  const tenant = req.query.tenant || "default";
  const state = getTenantState(tenant);
  console.log(`📤 [${tenant}] Sending usage: current=`, state.usage, `history count=${state.usages.length}`);
  res.json({ current: state.usage, history: state.usages });
});

app.get('/api/portal/health', (req, res) => {
  console.log(`📤 Health check ping at ${new Date().toISOString()}`);
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/portal/metrics-log', (req, res) => {
  const tenant = req.query.tenant || "default";
  const metricsLog = getTenantState(tenant).metrics;
  console.log(`📤 [${tenant}] Sending metrics-log (${metricsLog.length} entries)`);
  res.json(metricsLog);
});

app.get('/api/portal/conversations', (req, res) => {
  const tenant = req.query.tenant || "default";
  const conversations = getTenantState(tenant).conversations;
  console.log(`📤 [${tenant}] Sending conversations: ${Object.keys(conversations).length} sessions`);
  res.json(conversations);
});

// -------------------- APIs (write: unified) --------------------
app.post('/api/portal/log', (req, res) => {
  const tenant = req.query.tenant || "default";
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
  const { tenant = "default", role } = req.query;
  addEvent(getTenantState(tenant), role, req.body.message, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-error', (req, res) => {
  const { tenant = "default", user } = req.query;
  addError(getTenantState(tenant), user, req.body.message, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-usage', (req, res) => {
  const { tenant = "default" } = req.query;
  addUsage(getTenantState(tenant), req.body, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-metric', (req, res) => {
  const { tenant = "default", type } = req.query;
  addMetric(getTenantState(tenant), type, req.body.value, tenant);
  res.json({ ok: true });
});

app.post('/api/portal/log-conversation', (req, res) => {
  const { tenant = "default", sessionId } = req.query;
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
  if (process.env.CUSTOMER_KEY) {
    console.log('🔐 Auth enabled: supply ?key=YOUR_KEY or header x-customer-key: YOUR_KEY');
  }
});
