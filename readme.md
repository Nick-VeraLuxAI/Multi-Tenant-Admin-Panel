To Run:
mkdir -p views
# save the HTML above as views/portal.html
# save server.js at project root

npm init -y
npm i express dotenv
node server.js
# Open:
# http://localhost:10000/portal
# (or append ?key=your-shared-key-here if you set CUSTOMER_KEY)


http://localhost:3000/portal?key=dev-shared-key


# Multi-Tenant Portal — Theming & Config README

This explains how to create `config.json` files (one per tenant), where to place assets, and how the portal picks the right theme at runtime.

---

## 1) Folder layout

```
project-root/
├─ server.js
├─ views/
│  └─ portal.html
├─ static/                      # served at /static/*
│  ├─ config.json               # global fallback (optional)
│  ├─ config.default.json       # recommended fallback
│  ├─ config.solomon.json       # tenant "solomon"
│  ├─ config.acme.json          # tenant "acme"
│  └─ brand/
│     ├─ logo.svg               # per-tenant logos (optional)
│     └─ favicon.png            # per-tenant favicons (optional)
└─ .env
```

> Your `server.js` must serve `/static` from the `static/` folder:

```js
app.use('/static', express.static(path.join(__dirname, 'static')));
```

---

## 2) How the portal chooses a config

* The portal reads `tenant` from the URL: `?tenant=<name>`
* It first tries `/static/config.<tenant>.json`
* If missing, it falls back to `/static/config.json` or `/static/config.default.json`

**Examples**

* `http://localhost:10000/portal?tenant=solomon`

  * loads `/static/config.solomon.json`
* `http://localhost:10000/portal?tenant=alexandracohomes`

  * loads `/static/config.acme.json`
* `http://localhost:10000/portal` (no tenant)

  * loads `/static/config.default.json` (or `/static/config.json`)

---

## 3) Config file schema

Create one JSON file per tenant (and a fallback). Example:

```json
{
  "brandName": "Solomon",
  "portalLabel": "Client Portal",
  "titleTemplate": "{{brand}} · {{portal}}",
  "footerText": "© 2025 Solomon — All rights reserved",
  "logo": "/static/brand/logo.svg",
  "favicon": "/static/brand/favicon.png",
  "gradientAngle": 135,
  "colors": {
    "bg": "#2E7D5B",
    "bg2": "#C9A227",
    "card": "#16412e",
    "text": "#e9ecf1",
    "muted": "#a6accd",
    "accent": "#444C56",
    "good": "#2ecc71",
    "warn": "#f1c40f",
    "bad": "#e74c3c",
    "border": "#C9A227"
  },
  "features": {
    "usage": true,
    "errors": true,
    "events": true
  }
}
```

### Fields

* **brandName**: Company/customer name.
* **portalLabel**: Short label (“Client Portal”, “Admin Portal”, etc.).
* **titleTemplate**: Template used for `<title>`, header brand, and default footer.

  * Tokens: `{{brand}}`, `{{portal}}`
* **footerText** *(optional)*: Overrides footer text (if present).
* **logo** *(optional)*: Path to logo (SVG/PNG).
* **favicon** *(optional)*: Path to favicon (ICO/PNG).
* **gradientAngle**: Degrees for the background gradient.
* **colors**: CSS variables used throughout the UI.
* **features**: Toggle sections (set to `false` to hide).

---

## 4) Add a new tenant

1. Copy the fallback config:

   ```
   cp static/config.default.json static/config.<tenant>.json
   ```
2. Edit values (name, colors, logos, etc.).
3. Place tenant assets (if any) under `static/brand/` and reference them in the config.
4. Open:

   ```
   http://localhost:10000/portal?tenant=<tenant>
   ```

---

## 5) Per-tenant auth (optional)

Your server supports a simple key gate. You can use one global key or one per tenant.

**.env**

```
PORT=10000
# Global (for all tenants if you want):
CUSTOMER_KEY=global-secret

# OR per-tenant keys (example):
CUSTOMER_KEY_SOLOMON=solomon-secret-123
CUSTOMER_KEY_ACME=acme-secret-456
```

**Usage (query)**

```
http://localhost:10000/portal?tenant=solomon&key=solomon-secret-123
```

**API calls** (the portal already appends `tenant` and `key` to requests):

```bash
curl "http://localhost:10000/api/portal/metrics?tenant=solomon&key=solomon-secret-123"
```

> If you prefer **headers** instead of query params, switch the helper in `portal.html` to send:

```
x-tenant: <tenant>
x-customer-key: <key>
```

…and update your server gate accordingly.

---

## 6) Theming behavior

* The portal loads the config, then:

  * Sets page `<title>` and header text from `titleTemplate`.
  * Applies `footerText` if provided; otherwise uses `titleTemplate`.
  * Loads `logo` and `favicon` if set.
  * Applies `colors` to CSS variables.
  * Applies `gradientAngle` to the background.
  * Hides sections based on `features`.

**Change look & feel** without touching HTML/JS: edit the tenant’s config JSON.

---

## 7) Example: “Acme” tenant

`static/config.acme.json`:

```json
{
  "brandName": "Acme Co.",
  "portalLabel": "Service Status",
  "titleTemplate": "{{portal}} — {{brand}}",
  "footerText": "© 2025 Acme Co.",
  "logo": "/static/brand/acme.svg",
  "favicon": "/static/brand/acme.ico",
  "gradientAngle": 160,
  "colors": {
    "bg": "#1F4B99",
    "bg2": "#6DD5FA",
    "card": "#0E203F",
    "text": "#EFF4FF",
    "muted": "#A8B3C7",
    "accent": "#9AD6FF",
    "good": "#2ecc71",
    "warn": "#f1c40f",
    "bad": "#e74c3c",
    "border": "#3A6FD6"
  },
  "features": {
    "usage": true,
    "errors": false,
    "events": true
  }
}
```

Open:

```
http://localhost:10000/portal?tenant=acme
```

---

## 8) Troubleshooting

* **Config not applying**

  * Check URL has `?tenant=...`
  * Verify file exists: `http://localhost:10000/static/config.<tenant>.json`
  * Confirm server is serving from `static/`:

    ```js
    app.use('/static', express.static(path.join(__dirname, 'static')));
    ```
* **Logo/Favicon not showing**

  * Ensure file paths are correct and files exist under `static/brand/`
  * Watch console for 404 errors.
* **Unauthorized (401)**

  * Add `&key=...` to the URL or send `x-customer-key` header.
  * Check the right env var is set for that tenant and the server was restarted.

---

## 9) Nice-to-have (optional)

* **Subdomain-based tenant**: derive tenant from `req.hostname` (e.g., `acme.yourdomain.com` → `acme`).
* **Single dynamic config endpoint**: serve `/static/config.json` dynamically per tenant so the filename isn’t guessable.
* **Per-tenant usage metrics**: keep separate counters/billables in your server’s tenant state.

---

## 10) Quick checklist

* [ ] `server.js` serves `/static` from the `static/` folder
* [ ] `views/portal.html` is the multi-tenant version
* [ ] `static/config.default.json` exists (fallback)
* [ ] `static/config.<tenant>.json` for each customer
* [ ] Logos/favicons placed under `static/brand/` (if used)
* [ ] `.env` keys set if using auth
* [ ] Open with `?tenant=<name>[&key=...]`

That’s it. Add a config file for each customer, and the portal will theme itself automatically.
