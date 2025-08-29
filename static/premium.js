// premium.js
(function initPremium() {
  const container = document.getElementById("premium-sections");
  if (!container) return;

// --- Config discovery ---
const qs = new URLSearchParams(location.search);
const TENANT = (window?.CONFIG?.TENANT || container.dataset.tenant || qs.get('tenant') || 'default').toLowerCase();
const KEY    =  window?.CONFIG?.KEY    || container.dataset.key    || qs.get('key')    || '';

  // --- State ---
  let lastData = null;
  let pollTimer = null;
  let inFlight = null; // AbortController
  const LS_PREFIX = "premium:section:";

  // --- Utils ---
const byId = (id) => document.getElementById(id);
const safeText = (str) => (str == null ? "" : String(str));
const fmtDate = (d) => new Date(d).toLocaleString();
const saveOpenState = (id, open) => localStorage.setItem(LS_PREFIX + id, open ? "1" : "0");
const getOpenState  = (id) => localStorage.getItem(LS_PREFIX + id) === "1";

function setLoading(el, on){
  if (!el) return;
  let spinner = el.querySelector('[data-loading]');
  if (on) {
    if (!spinner) {
      spinner = document.createElement('div');
      spinner.dataset.loading = '1';
      spinner.setAttribute('role','status');
      spinner.setAttribute('aria-live','polite');
      spinner.style.opacity = '.8';
      spinner.textContent = 'Loading…';
      el.prepend(spinner);              // overlay on top, content stays
    }
  } else if (spinner) {
    spinner.remove();
  }
}

function setError(msg=''){ const el = byId('pf-error'); if (el) el.textContent = msg; }


  function toCSV(rows) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map(r => r.map(esc).join(",")).join("\n");
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  }

  // --- Accessible collapsible card ---
  function createCollapsibleCard(title, contentId) {
    const card = document.createElement("div");
    card.className = "card section";

    const headerBtn = document.createElement("button");
    headerBtn.type = "button";
    headerBtn.className = "section-toggle";
    headerBtn.setAttribute("aria-controls", contentId);
    headerBtn.setAttribute("aria-expanded", "false");
    headerBtn.style.all = "unset";
    headerBtn.style.cursor = "pointer";
    headerBtn.style.display = "block";

    const h3 = document.createElement("h3");
    h3.textContent = title;
    headerBtn.appendChild(h3);

    const body = document.createElement("div");
    body.id = contentId;
    body.hidden = true;
    body.style.marginTop = "8px";

    // restore persisted state
    const initiallyOpen = getOpenState(contentId);
    body.hidden = !initiallyOpen;
    headerBtn.setAttribute("aria-expanded", String(initiallyOpen));

    headerBtn.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      headerBtn.setAttribute("aria-expanded", String(open));
      saveOpenState(contentId, open);
    });

    card.appendChild(headerBtn);
    card.appendChild(body);
    return card;
  }

  // --- Lead Funnel ---
  const leadCard = createCollapsibleCard("📊 Lead Funnel", "lead-funnel");
  container.appendChild(leadCard);
  byId("lead-funnel").innerHTML = `
    <p><strong>Total Leads:</strong> <span id="pf-total-leads">—</span></p>
    <p><strong>With Contact Info:</strong> <span id="pf-contact-leads">—</span></p>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="pf-export-btn">Export to CSV</button>
      <span id="pf-last-updated" style="font-size:12px;color:var(--muted)"></span>
    </div>
    <div id="pf-error" style="color:var(--bad);font-size:12px;margin-top:6px;"></div>
  `;

  // --- Conversation Viewer ---
  const convoCard = createCollapsibleCard("💬 Conversation Viewer", "convo-viewer");
  container.appendChild(convoCard);
  byId("convo-viewer").innerHTML = `
    <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);padding:8px;border-radius:8px;">
      <ul id="pf-convo-list" style="list-style:none;margin:0;padding:0;">
        <li style="color:var(--muted)">No conversations loaded</li>
      </ul>
    </div>
  `;

  // --- Topic Analysis ---
  const topicCard = createCollapsibleCard("🏷️ Topic Analysis", "topic-analysis");
  container.appendChild(topicCard);
  byId("topic-analysis").innerHTML = `
    <p>Automatic tags across conversations:</p>
    <ul id="pf-topic-tags" style="margin:0;padding-left:18px;">
      <li style="color:var(--muted)">No tags yet</li>
    </ul>
  `;

  // --- Data loader with cancellation & errors ---
async function loadPremiumData() {
  setError('');

  if (inFlight) inFlight.abort();
  inFlight = new AbortController();

  setLoading(byId("lead-funnel"), true);
  setLoading(byId("convo-viewer"), true);
  setLoading(byId("topic-analysis"), true);

  try {
    if (!TENANT || !KEY) throw new Error("Missing TENANT/KEY");

    const res = await fetch(
      `/api/portal/premium?tenant=${encodeURIComponent(TENANT)}&key=${encodeURIComponent(KEY)}`,
      { signal: inFlight.signal, headers: { "Accept": "application/json" } }
    );
    if (!res.ok) throw new Error(`Premium API unavailable (${res.status})`);

    lastData = (await res.json()) || {};

    // Lead funnel
    const totalEl   = byId("pf-total-leads");
    const contactEl = byId("pf-contact-leads");
    const updatedEl = byId("pf-last-updated");
    if (totalEl)   totalEl.textContent   = lastData.totalLeads ?? 0;
    if (contactEl) contactEl.textContent = lastData.withContact ?? 0;
    if (updatedEl) updatedEl.textContent = `Last updated: ${fmtDate(Date.now())}`;

    // Conversations
    const list = byId("pf-convo-list");
    if (list) {
      list.innerHTML = "";
      const convos = Array.isArray(lastData.conversations) ? lastData.conversations : [];
      if (!convos.length) {
        list.innerHTML = `<li style="color:var(--muted)">No conversations found</li>`;
      } else {
        convos.slice().sort((a,b)=>new Date(b.at)-new Date(a.at)).forEach(c=>{
          const li   = document.createElement("li"); li.style.marginBottom = "8px";
          const name = document.createElement("strong"); name.textContent = safeText(c.name || "Unknown");
          const meta = document.createElement("div"); meta.style.fontSize="12px"; meta.style.color="var(--muted)"; meta.textContent = safeText(fmtDate(c.at));
          const snip = document.createElement("div"); snip.textContent = safeText(c.snippet || "");
          li.append(name, meta, snip); list.appendChild(li);
        });
      }
    }

    // Topics
    const tagsEl = byId("pf-topic-tags");
    if (tagsEl) {
      tagsEl.innerHTML = "";
      const topics = Array.isArray(lastData.topics) ? lastData.topics : [];
      if (!topics.length) {
        tagsEl.innerHTML = `<li style="color:var(--muted)">No topics detected</li>`;
      } else {
        topics.forEach(t => {
          const li = document.createElement("li");
          li.textContent = `• ${safeText(t)}`;
          tagsEl.appendChild(li);
        });
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") setError(err.message || "Failed to load premium data.");
  } finally {
    inFlight = null;
    // ✅ always remove the loading indicators
    setLoading(byId("lead-funnel"), false);
    setLoading(byId("convo-viewer"), false);
    setLoading(byId("topic-analysis"), false);
  }
}


  // --- Export handler ---
  container.addEventListener("click", (e) => {
    if (e.target.id === "pf-export-btn") {
      const rows = [
        ["Name", "Timestamp", "Snippet", "Email", "Phone", "Tags"],
      ];
      const convos = Array.isArray(lastData?.conversations) ? lastData.conversations : [];
      convos.forEach((c) => {
        rows.push([
          safeText(c.name || ""),
          safeText(fmtDate(c.at || "")),
          safeText(c.snippet || ""),
          safeText(c.email || ""),
          safeText(c.phone || ""),
          Array.isArray(c.tags) ? c.tags.join("|") : "",
        ]);
      });
      download(`leads_${TENANT}_${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    }
  });

  // --- Start/Stop polling ---
  loadPremiumData();
  pollTimer = setInterval(loadPremiumData, 15000);
  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
    if (inFlight) inFlight.abort();
  });
})();
