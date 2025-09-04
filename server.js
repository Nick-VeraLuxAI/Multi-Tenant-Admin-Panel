// server.js (ADMIN) — unified DB-backed portal
require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { encrypt, mask, hasKey } = require('./utils/kms'); // ← add this


// DB (same RDS as the bot)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const COOKIE_NAME = 'solomon_session';
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || '';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');


// ⛔ Per-IP limiter for login: 20 failed attempts / 15 min
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
  skipSuccessfulRequests: true,           // ✅ only counts 4xx/5xx (i.e., failed logins)
});

// ⛔ Per-email limiter for login: 7 failed attempts / 15 min
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 7,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
  keyGenerator: (req, _res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return email || ipKeyGenerator(req.ip, 64);   // ✅ safe IPv6 fallback
  },
  skipSuccessfulRequests: true,
});


// 🌐 Gentle global limiter for the authed portal APIs
// Your UI polls ~18 req/min; 120/min leaves plenty of headroom per IP.
const portalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => {
    return `${req.user.tenantId}:${req.user.adminUserId || ipKeyGenerator(req.ip, 64)}`;
  }
});


const intakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) =>
    `${req.headers['x-customer-key'] || 'nokey'}:${ipKeyGenerator(req.ip, 64)}:${String(req.headers['x-tenant'] || '')}`,
});




// --- Guards ---
if (!ADMIN_KEY) {
  console.error('ADMIN_KEY missing. Set ADMIN_CUSTOMER_KEY or ADMIN_KEY.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-secret') {
  throw new Error('JWT_SECRET must be set in production');
}


app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' })); 

/* ------------------------- Session helpers ------------------------- */
function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

function readSession(req) {
  const t = req.cookies?.[COOKIE_NAME];
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}

function requireAuth(req, res, next) {
  const sess = readSession(req);
  if (!sess) return res.status(401).json({ error: 'auth_required' });
  req.user = sess; // { adminUserId, tenantId, email }
  next();
}

/* --------------------------- Healthcheck -------------------------- */
app.get('/api/portal/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ------------------------ INTake (no cookie) ---------------------- */
/**
 * Bot -> Admin intake. Header-gated.
 * Headers:
 *  - x-customer-key: ADMIN_KEY
 *  - X-Tenant: <tenantId or subdomain>
 */
app.post('/api/portal/log', intakeLimiter, async (req, res) => {
  try {
    const key = req.headers['x-customer-key'];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'bad_key' });

    const hint = String(req.headers['x-tenant'] || req.query.tenant || '').toLowerCase();
    if (!hint) return res.status(400).json({ error: 'tenant_missing' });

    const tenant = await prisma.tenant.findFirst({
      where: { OR: [{ id: hint }, { subdomain: hint }] },
      select: { id: true }
    });
    if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });

    const { type } = req.body || {};

    switch (type) {
      case 'event': {
        const { role = 'info', message = '' } = req.body;
        await prisma.event.create({ data: { tenantId: tenant.id, type: role, content: String(message) } });
        break;
      }
      case 'error': {
        const { user = 'unknown', message = '' } = req.body;
        await prisma.event.create({ data: { tenantId: tenant.id, type: `error:${user}`, content: String(message) } });
        break;
      }
      case 'usage': {
        const u = req.body.usage || {};
        await prisma.usage.create({
          data: {
            tenantId: tenant.id,
            model: String(u.model || ''),
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            cachedTokens: u.cached_tokens || 0,
            cost: Number((u.costUSD ?? u.cost) || 0),
            breakdown: u.breakdown ?? undefined
          }
        });
        break;
      }

      case 'metric': {
        const { metricType = 'custom', value = 0 } = req.body;
        await prisma.metric.create({
          data: { tenantId: tenant.id, name: String(metricType), value: Number(value) || 0 }
        });
        break;
      }
      case 'lead': {
        const { name = '', email = '', phone = '', snippet = '', tags = [] } = req.body;
        await prisma.lead.create({
          data: {
            tenantId: tenant.id,
            name: String(name),
            email: String(email),
            phone: String(phone),
            snippet: String(snippet),
            tags: Array.isArray(tags) ? tags.map(String) : []
          }
        });
        break;
      }
      case 'conversation': {
        const { sessionId = '', data = {} } = req.body;
        if (!sessionId) break;
        const convo = await prisma.conversation.upsert({
          where: { tenantId_sessionId: { tenantId: tenant.id, sessionId } },
          update: {},
          create: { tenantId: tenant.id, sessionId }
        });
        if (data.userMessage) {
          await prisma.message.create({ data: { conversationId: convo.id, role: 'user', content: String(data.userMessage) } });
        }
        if (data.aiReply) {
          await prisma.message.create({ data: { conversationId: convo.id, role: 'assistant', content: String(data.aiReply) } });
        }
        break;
      }
      default:
        return res.status(400).json({ error: 'bad_type' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('intake_error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------- Auth-protected routes below ----------------- */
app.use('/api/portal', requireAuth, portalLimiter);

/* ------------------------------ Login ----------------------------- */

app.post('/api/login', loginIpLimiter, loginEmailLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase();
    const password = String(req.body?.password || '');
    const tenantHint = String(req.body?.tenantHint || '').toLowerCase();
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

    // Find all accounts with this email across tenants
    const accounts = await prisma.adminUser.findMany({
      where: { email },
      select: {
        id: true, tenantId: true, passwordHash: true,
        tenant: { select: { id: true, name: true, subdomain: true } }
      }
    });
    if (accounts.length === 0) return res.status(401).json({ error: 'invalid_credentials' });

    // If no hint and multiple tenants, ask the client to choose
    if (!tenantHint && accounts.length > 1) {
      return res.status(400).json({
        error: 'tenant_required',
        tenants: accounts.map(a => a.tenant)
      });
    }

    // Resolve the chosen account
    let acct = accounts[0];
    if (tenantHint) {
      const byHint = accounts.find(a =>
        a.tenant.id.toLowerCase() === tenantHint ||
        (a.tenant.subdomain || '').toLowerCase() === tenantHint
      );
      if (!byHint) return res.status(404).json({ error: 'tenant_not_found_for_email' });
      acct = byHint;
    }

    const valid = await bcrypt.compare(password, acct.passwordHash);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });

    setSessionCookie(res, { adminUserId: acct.id, tenantId: acct.tenantId, email });
    res.json({ ok: true, tenantId: acct.tenantId });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ error: 'server_error' });
  }
});


app.post('/api/logout', requireAuth, (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user); // { adminUserId, tenantId, email }
});

/* ------------------------ Branding / Config ----------------------- */
// Used by portal.html instead of static JSON files
app.get('/api/portal/config', requireAuth, async (req, res) => {
  const t = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
  if (!t) return res.status(404).json({ error: 'tenant_not_found' });

  res.json({
    brandName: t.name,
    colors: {
      bg: t.botBg || '#F4F1EA',
      card: t.glassBg || 'rgba(250,248,244,0.88)',
      text: t.userText || '#2C2C2C',
      accent: t.brandColor || '#6B705C',
      hover: t.brandHover || '#556052',
      border: '#D9D6CE'
    },
    logo: t.watermarkUrl || '/static/brand/logo.png',
    features: { usage: true, errors: true, events: true, premium: true }
  });
});

/* --------------------- Tenant secrets (masked) -------------------- */
// READ (masked): never decrypt for the browser
app.get('/api/portal/tenant/secrets', requireAuth, async (req, res) => {
  const t = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: {
      // non-secret (can be shown as-is)
      name: true, subdomain: true, smtpHost: true, smtpPort: true, smtpUser: true,
      emailFrom: true, emailTo: true,

      // secrets / tokens (mask them)
      smtpPass: true, openaiKey: true,
      googleClientId: true,           // not strictly secret, but often treated carefully
      googleClientSecret: true,       // secret -> mask
      googleRedirectUri: true,
      googleTokens: true              // may be encrypted string or json
    }
  });
  if (!t) return res.status(404).json({ error: 'tenant_not_found' });

  // If googleTokens is JSON, just indicate presence
  const tokensMasked = typeof t.googleTokens === 'string'
    ? mask(t.googleTokens)
    : (t.googleTokens ? 'present' : '');

  res.json({
    ok: true,
    kmsConfigured: hasKey(),
    fields: {
      name: t.name,
      subdomain: t.subdomain,
      smtpHost: t.smtpHost,
      smtpPort: t.smtpPort,
      smtpUser: t.smtpUser,
      emailFrom: t.emailFrom,
      emailTo: t.emailTo,

      // masked
      smtpPass: mask(t.smtpPass),
      openaiKey: mask(t.openaiKey),
      googleClientId: mask(t.googleClientId),
      googleClientSecret: mask(t.googleClientSecret),
      googleRedirectUri: t.googleRedirectUri || '',
      googleTokens: tokensMasked
    }
  });
});

// WRITE (encrypt-on-save): only encrypt provided fields
app.put('/api/portal/tenant/secrets', requireAuth, async (req, res) => {
  if (!hasKey()) return res.status(400).json({ error: 'kms_not_configured' });

  const {
    smtpHost, smtpPort, smtpUser, smtpPass,
    emailFrom, emailTo,
    openaiKey,
    googleClientId, googleClientSecret, googleRedirectUri, googleTokens
  } = req.body || {};

  // Build update object; encrypt sensitive fields
  const data = {};
  if (smtpHost != null) data.smtpHost = String(smtpHost);
  if (smtpPort != null) data.smtpPort = Number(smtpPort) || 0;
  if (smtpUser != null) data.smtpUser = String(smtpUser);
  if (emailFrom != null) data.emailFrom = String(emailFrom);
  if (emailTo != null) data.emailTo = String(emailTo);

  if (typeof smtpPass === 'string')  data.smtpPass  = encrypt(smtpPass);
  if (typeof openaiKey === 'string') data.openaiKey = encrypt(openaiKey);

  if (googleClientId != null)        data.googleClientId = String(googleClientId);
  if (typeof googleClientSecret === 'string') data.googleClientSecret = encrypt(googleClientSecret);
  if (googleRedirectUri != null)     data.googleRedirectUri = String(googleRedirectUri);

  if (googleTokens != null) {
    // Accept either an object or a string; store encrypted string
    const asString = typeof googleTokens === 'string'
      ? googleTokens
      : JSON.stringify(googleTokens);
    data.googleTokens = encrypt(asString);
  }

  await prisma.tenant.update({
    where: { id: req.user.tenantId },
    data
  });

  // Optional audit
  await prisma.event.create({
    data: {
      tenantId: req.user.tenantId,
      type: 'admin:update_secrets',
      content: `Updated: ${Object.keys(data).join(', ')}`
    }
  });

  res.json({ ok: true });
});


/* -------------------------- Portal reads -------------------------- */

// Summarized metrics (last 24h-ish)
app.get('/api/portal/metrics', async (req, res) => {
  const tenantId = req.user.tenantId;

  // Avg latency, success rate from metrics
  const metrics = await prisma.metric.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 500
  });

  const latencies = metrics.filter(m => m.name === 'latency').map(m => m.value);
  const successCount = metrics.filter(m => m.name === 'success').length;
  // crude requests count = success + events count; adjust to your definition
  const eventsCount = await prisma.event.count({ where: { tenantId } });
  const requests = Math.max(successCount, eventsCount);

  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const successRate = requests ? Math.round((successCount / requests) * 1000) / 10 : 100;

  // Current usage = last usage row
  const lastUsage = await prisma.usage.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' }
  });

  res.json({
    status: successRate >= 99 && avgLatency < 250 ? 'ok' : (successRate >= 95 ? 'degraded' : 'down'),
    uptimeSec: null, // can be added via a DB-stored boot time if you need it
    requestsToday: requests,
    successRate,
    avgLatencyMs: avgLatency,
    usage: lastUsage ? {
      period: 'Current',
      at: lastUsage.createdAt,
      model: lastUsage.model,
      prompt_tokens: lastUsage.promptTokens,
      completion_tokens: lastUsage.completionTokens,
      cached_tokens: lastUsage.cachedTokens,
      costUSD: lastUsage.cost,
      breakdown: lastUsage.breakdown || {}
    } : null
  });
});

// Events (latest first)
app.get('/api/portal/events', async (req, res) => {
  const rows = await prisma.event.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.json(rows.map(r => ({
    at: r.createdAt, role: r.type, message: r.content
  })));
});

// Errors (filter events with type starting "error:")
app.get('/api/portal/errors', async (req, res) => {
  const rows = await prisma.event.findMany({
    where: { tenantId: req.user.tenantId, type: { startsWith: 'error:' } },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.json(rows.map(r => ({ at: r.createdAt, user: r.type.slice(6), message: r.content })));
});

// Usage history
app.get('/api/portal/usage', async (req, res) => {
  const tenantId = req.user.tenantId;
  const history = await prisma.usage.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 200
  });
  const current = history[0] || null;

  res.json({
    current: current ? {
      period: 'Current',
      at: current.createdAt,
      model: current.model,
      prompt_tokens: current.promptTokens,
      completion_tokens: current.completionTokens,
      cached_tokens: current.cachedTokens,
      costUSD: current.cost,
      breakdown: current.breakdown || {}
    } : null,
    history: history.map(u => ({
      at: u.createdAt,
      model: u.model,
      prompt_tokens: u.promptTokens,
      completion_tokens: u.completionTokens,
      cached_tokens: u.cachedTokens,
      user: null,
      costUSD: u.cost,
      breakdown: u.breakdown || {}
    }))
  });
});

// Metrics log (raw)
app.get('/api/portal/metrics-log', async (req, res) => {
  const rows = await prisma.metric.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 500
  });
  res.json(rows.map(r => ({ at: r.createdAt, type: r.name, value: r.value })));
});

// Conversations (recent)
app.get('/api/portal/conversations', async (req, res) => {
  const convos = await prisma.conversation.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { startedAt: 'desc' },
    take: 50,
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
  });

  const shaped = convos.reduce((acc, c) => {
    acc[c.sessionId] = {
      at: c.startedAt,
      lastMessage: c.messages[0]?.content || '',
      // placeholders for premium view parity
      name: '',
      email: '',
      phone: '',
      tags: []
    };
    return acc;
  }, {});
  res.json(shaped);
});

// Premium summary (from DB)
app.get('/api/portal/premium', async (req, res) => {
  const leads = await prisma.lead.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 200
  });

  const totalLeads = leads.length;
  const withContact = leads.filter(l => (l.email && l.phone)).length;

  const tagCounts = new Map();
  for (const l of leads) {
    for (const t of (l.tags || [])) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const topics = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);

  const conversations = leads.map(l => ({
    name: l.name || 'Unknown',
    snippet: l.snippet || '',
    at: l.createdAt,
    email: l.email || '',
    phone: l.phone || '',
    tags: l.tags || []
  }));

  res.json({ totalLeads, withContact, conversations, topics });
});

/* ---------------------- Tenants picker (UI) ---------------------- */
app.get('/api/tenants', requireAuth, async (_req, res) => {
  const rows = await prisma.tenant.findMany({
    select: { id: true, name: true, subdomain: true, plan: true },
    orderBy: { name: 'asc' }
  });
  res.json(rows);
});

/* ------------------------------ Pages ---------------------------- */
app.get('/pricing', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'pricing.html')));
app.get('/', (_req, res) => res.redirect('/portal'));
app.get('/portal', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'portal.html')));

/* ------------------------------ Start ---------------------------- */
app.listen(PORT, () => {
  console.log(`✅ Portal running at http://localhost:${PORT}/portal`);
});
['SIGINT','SIGTERM'].forEach(sig => {
  process.on(sig, async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});


