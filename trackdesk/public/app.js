/* Track Desk broker console: a tiny hash-routed single page app. */
const $view = document.getElementById('view');
let cities = [];
let TZ; // brokerage time zone from settings
let refreshTimer = null;

const HEALTH_LABEL = {
  late: 'Late', at_risk: 'At risk', no_response: 'No answer', on_time: 'On time', scheduled: 'Scheduled', delivered: 'Delivered',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pill = (h) => `<span class="pill h-${h}">${HEALTH_LABEL[h] || h}</span>`;
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function when(ms, { short = false } = {}) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-US', short
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ, timeZoneName: 'short' });
}

function ago(ms) {
  if (ms == null) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (Math.abs(m) < 1) return 'just now';
  const fmt = (v, u) => `${v}${u}`;
  const abs = Math.abs(m);
  const s = abs < 60 ? fmt(abs, 'm') : abs < 2880 ? fmt(Math.round(abs / 60), 'h') : fmt(Math.round(abs / 1440), 'd');
  return m > 0 ? `${s} ago` : `in ${s}`;
}

function etaDelta(load) {
  if (load.eta == null || load.status === 'delivered') return '';
  const diff = Math.round((load.eta - load.delivery_at) / 60000);
  const abs = Math.abs(diff);
  const txt = abs < 60 ? `${abs}m` : `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`;
  return diff > 0 ? `<span style="color:var(--red)">${txt} late</span>` : `<span class="muted">${txt} early</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

async function updateAlertCount() {
  try {
    const alerts = await api('/api/alerts');
    const el = document.getElementById('alert-count');
    el.hidden = alerts.length === 0;
    el.textContent = alerts.length;
    return alerts;
  } catch { return []; }
}

// ---------------- Load board ----------------
async function board() {
  const [loads, alerts] = await Promise.all([api('/api/loads'), updateAlertCount()]);
  const active = loads.filter((l) => l.status !== 'delivered');
  const count = (h) => active.filter((l) => l.health === h).length;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const deliveredThisMonth = loads.filter((l) => l.status === 'delivered' && l.delivered_at >= monthStart.getTime()).length;

  $view.innerHTML = `
    <div class="head">
      <div><h1>Load board</h1><p class="sub">Every active load, checked on automatically. Late ones float to the top.</p></div>
      <div class="row"><button class="btn" id="tick">Run due check calls</button><a class="btn primary" href="#/new">+ New load</a></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Active loads</div><div class="v">${active.length}</div></div>
      <div class="stat bad"><div class="k">Late</div><div class="v">${count('late')}</div></div>
      <div class="stat warn"><div class="k">At risk / no answer</div><div class="v">${count('at_risk') + count('no_response')}</div></div>
      <div class="stat good"><div class="k">Delivered this month</div><div class="v">${deliveredThisMonth}</div></div>
    </div>
    ${alerts.map((a) => `
      <div class="alert ${a.kind}">
        <div><strong>${a.kind === 'late' ? 'Running late' : 'No answer'}</strong> · ${esc(a.message)} <span class="muted small">${ago(a.at)}</span></div>
        <div class="row"><a class="btn" href="#/loads/${a.load_id}">Open</a><button class="btn" data-ack="${a.id}">Dismiss</button></div>
      </div>`).join('')}
    <div class="card flush">
      ${loads.length === 0 ? `<div class="empty">No loads yet. <a href="#/new">Add your first load</a> or run <code>npm run seed</code> for demo data.</div>` : `
      <table>
        <thead><tr><th>Load</th><th>Route</th><th class="hide-sm">Driver</th><th>Last location</th><th>ETA</th><th>Status</th><th class="hide-sm">Next call</th></tr></thead>
        <tbody>
          ${loads.map((l) => `
            <tr class="link ${l.health === 'late' ? 'late' : ''}" data-id="${l.id}">
              <td><strong>${esc(l.ref)}</strong><div class="muted small">${esc(l.shipper)}</div></td>
              <td>${esc(l.origin.split(',')[0])} → ${esc(l.destination.split(',')[0])}<div class="muted small">Appt ${when(l.delivery_at, { short: true })}</div></td>
              <td class="hide-sm">${esc(l.driver_name)}<div class="muted small">${esc(l.carrier)}</div></td>
              <td>${l.last_check_in ? `${esc(l.last_check_in.place)}<div class="muted small">${ago(l.last_check_in.at)}</div>` : '<span class="muted">—</span>'}</td>
              <td class="mono">${l.status === 'delivered' ? `<span class="muted">${when(l.delivered_at, { short: true })}</span>` : l.eta ? `${when(l.eta, { short: true })}<div class="small">${etaDelta(l)}</div>` : '<span class="muted">—</span>'}</td>
              <td>${pill(l.health)}</td>
              <td class="hide-sm muted small">${l.next_call_at ? ago(l.next_call_at) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;

  $view.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/loads/${tr.dataset.id}`)));
  $view.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/alerts/${b.dataset.ack}/ack`, { method: 'POST' }); render(); }));
  document.getElementById('tick').addEventListener('click', async () => {
    const r = await api('/api/tick', { method: 'POST' });
    toast(r.called.length ? `Sent ${r.called.length} check call${r.called.length > 1 ? 's' : ''}` : 'No check calls due right now');
    render();
  });
  refreshTimer = setInterval(() => { if (!document.hidden) board().catch(() => {}); }, 30000);
}

// ---------------- Load detail ----------------
async function loadDetail(id) {
  const l = await api(`/api/loads/${id}`);
  const events = [
    ...l.check_ins.map((c) => ({ at: c.at, cls: '', html: `<strong>${esc(c.place)}</strong> <span class="muted small">via ${esc(c.source)}</span>${c.eta && l.status !== 'delivered' ? `<div class="small">ETA ${when(c.eta)}</div>` : ''}${c.note ? `<div class="muted small">“${esc(c.note)}”</div>` : ''}` })),
    ...l.check_calls.map((c) => ({ at: c.sent_at, cls: 'call', html: `Check call sent to ${esc(l.driver_name)} <span class="muted small">${c.responded_at ? `answered ${ago(c.responded_at)}` : 'no answer yet'}</span>` })),
    ...l.alerts.map((a) => ({ at: a.at, cls: 'alert-ev', html: `<span style="color:var(--red)">Alert:</span> ${esc(a.message)}` })),
  ].sort((a, b) => b.at - a.at);
  const delivered = l.status === 'delivered';

  $view.innerHTML = `
    <p class="small"><a href="#/" class="muted">← Load board</a></p>
    <div class="head">
      <div>
        <h1>${esc(l.ref)} ${pill(l.health)}</h1>
        <p class="sub">${esc(l.shipper || 'No shipper')} ${l.carrier ? `· ${esc(l.carrier)}` : ''}</p>
      </div>
      <div class="row">
        <button class="btn primary" id="call" ${delivered ? 'disabled' : ''}>Call driver now</button>
        <button class="btn" id="deliver" ${delivered ? 'disabled' : ''}>Mark delivered</button>
      </div>
    </div>
    <div class="grid2">
      <div>
        <div class="card">
          <div class="route">${esc(l.origin)} <span class="arrow">→</span> ${esc(l.destination)}</div>
          <div class="progress"><div style="width:${Math.round(l.progress * 100)}%"></div></div>
          <div class="muted small">${Math.round(l.progress * 100)}% of the way${l.last_check_in ? ` · last seen ${esc(l.last_check_in.place.replace(/^Near/, 'near'))} ${ago(l.last_check_in.at)}` : ''}</div>
          <dl class="kv" style="margin-top:16px">
            <dt>Pickup</dt><dd>${when(l.pickup_at)}</dd>
            <dt>Appointment</dt><dd>${when(l.delivery_at)}</dd>
            <dt>Current ETA</dt><dd>${delivered ? `Delivered ${when(l.delivered_at)}` : l.eta ? `${when(l.eta)} ${etaDelta(l)}` : '<span class="muted">Waiting for first check-in</span>'}</dd>
            <dt>Driver</dt><dd>${esc(l.driver_name)} · <a href="tel:${esc(l.driver_phone)}">${esc(l.driver_phone)}</a></dd>
            <dt>Next check call</dt><dd>${l.next_call_at ? `${when(l.next_call_at)} (${ago(l.next_call_at)})` : '—'}</dd>
            ${l.shipper_contact ? `<dt>Shipper contact</dt><dd>${esc(l.shipper_contact)}</dd>` : ''}
          </dl>
        </div>
        <div class="card">
          <h2>Shipper update</h2>
          <p class="muted small" style="margin-top:-6px">Send this before they ask.</p>
          <div class="copybox" id="update">${esc(l.shipper_update)}</div>
          <div class="row" style="margin-top:10px"><button class="btn" id="copy">Copy</button>
          ${l.shipper_contact.includes('@') ? `<a class="btn" href="mailto:${esc(l.shipper_contact)}?subject=${encodeURIComponent('Load ' + l.ref + ' update')}&body=${encodeURIComponent(l.shipper_update)}">Email shipper</a>` : ''}</div>
        </div>
        ${delivered ? '' : `
        <div class="card">
          <h2>Log a check-in by hand</h2>
          <p class="muted small" style="margin-top:-6px">Use this if the driver called you directly.</p>
          <form id="manual">
            <div class="grid2">
              <div class="field"><label>Nearest city</label><select name="place" required><option value="">Choose…</option>${cities.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
              <div class="field"><label>Extra delay (minutes)</label><input name="delay_minutes" type="number" min="0" value="0"></div>
            </div>
            <div class="field"><label>Note</label><input name="note" placeholder="e.g. waiting at the dock"></div>
            <div class="err" id="manual-err"></div>
            <button class="btn">Log check-in</button>
          </form>
        </div>`}
      </div>
      <div class="card">
        <h2>Timeline</h2>
        ${events.length ? `<ul class="timeline">${events.map((e) => `<li class="${e.cls}"><div class="muted small">${when(e.at)}</div>${e.html}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet. The first check call goes out at pickup.</p>'}
      </div>
    </div>`;

  document.getElementById('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(l.shipper_update); toast('Copied'); } catch { toast('Copy failed: select the text instead'); }
  });
  if (!delivered) {
    document.getElementById('call').addEventListener('click', async () => {
      await api(`/api/loads/${id}/call`, { method: 'POST' });
      toast('Check call sent'); render();
    });
    document.getElementById('deliver').addEventListener('click', async () => {
      if (!confirm(`Mark ${l.ref} as delivered? Check calls will stop.`)) return;
      await api(`/api/loads/${id}/delivered`, { method: 'POST' }); render();
    });
    document.getElementById('manual').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/api/loads/${id}/checkins`, { method: 'POST', body: { ...f, delayMinutes: Number(f.delay_minutes) || 0 } });
        toast('Check-in logged'); render();
      } catch (err) { document.getElementById('manual-err').textContent = err.message; }
    });
  }
}

// ---------------- New load ----------------
function localInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function newLoad() {
  const now = Date.now();
  const opts = cities.map((c) => `<option>${esc(c)}</option>`).join('');
  $view.innerHTML = `
    <h1>New load</h1>
    <p class="sub">Add the load once. Track Desk texts the driver at pickup and every few hours until it delivers.</p>
    <form id="f" class="card" style="max-width:760px">
      <div class="grid3">
        <div class="field"><label>Load #</label><input name="ref" required placeholder="L-2041"></div>
        <div class="field"><label>Shipper</label><input name="shipper" placeholder="Acme Foods"></div>
        <div class="field"><label>Shipper contact</label><input name="shipper_contact" placeholder="ops@acme.com"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Driver name</label><input name="driver_name" required></div>
        <div class="field"><label>Driver cell</label><input name="driver_phone" required type="tel" placeholder="(214) 555-0101"></div>
        <div class="field"><label>Carrier</label><input name="carrier" placeholder="Torres Trucking LLC"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Origin</label><select name="origin" required><option value="">Choose…</option>${opts}</select></div>
        <div class="field"><label>Destination</label><select name="destination" required><option value="">Choose…</option>${opts}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Pickup</label><input name="pickup_at" type="datetime-local" required value="${localInput(now + 3600e3)}"></div>
        <div class="field"><label>Delivery appointment</label><input name="delivery_at" type="datetime-local" required value="${localInput(now + 26 * 3600e3)}"></div>
      </div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn primary">Create load</button><a class="btn" href="#/">Cancel</a></div>
    </form>`;
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.pickup_at = new Date(f.pickup_at).getTime();
    f.delivery_at = new Date(f.delivery_at).getTime();
    try {
      const load = await api('/api/loads', { method: 'POST', body: f });
      toast('Load created');
      location.hash = `#/loads/${load.id}`;
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
}

// ---------------- Messages ----------------
async function outbox() {
  const msgs = await api('/api/messages');
  $view.innerHTML = `
    <h1>Messages</h1>
    <p class="sub">Every text sent to and from drivers. Without Twilio keys, texts stay here: open a link to play the driver.</p>
    <div class="card">
      ${msgs.length ? msgs.map((m) => {
        const link = (m.body.match(/https?:\/\/\S+\/c\/[\w-]+/) || [])[0];
        const driverPath = link ? new URL(link).pathname : null;
        return `
        <div style="margin-bottom:14px">
          <div class="row small muted" style="margin-bottom:4px">
            <span>${m.direction === 'out' ? 'To' : 'From'} ${esc(m.phone)}</span>
            ${m.ref ? `<a href="#/loads/${m.load_id}">${esc(m.ref)}</a>` : ''}
            <span>${when(m.at)}</span><span>via ${esc(m.provider)}</span>
            ${m.error ? `<span style="color:var(--red)">failed: ${esc(m.error)}</span>` : ''}
          </div>
          <div class="bubble ${m.direction}">${esc(m.body)}</div>
          ${driverPath ? `<a class="btn" style="margin-top:6px" href="${esc(driverPath)}" target="_blank">Open driver page ↗</a>` : ''}
        </div>`;
      }).join('') : '<p class="muted">No messages yet.</p>'}
    </div>`;
}

// ---------------- Billing ----------------
async function billing(month) {
  const b = await api(`/api/billing${month ? `?month=${month}` : ''}`);
  $view.innerHTML = `
    <div class="head">
      <div><h1>Billing</h1><p class="sub">Priced per tracked load. A load counts once a month if we sent it at least one check call.</p></div>
      <div><label>Month</label><input type="month" id="month" value="${b.month}"></div>
    </div>
    <div class="stats" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><div class="k">Tracked loads</div><div class="v">${b.tracked_loads}</div></div>
      <div class="stat"><div class="k">Price per load</div><div class="v">${money(b.price_per_load)}</div></div>
      <div class="stat"><div class="k">Total for ${b.month}</div><div class="v gold">${money(b.total)}</div></div>
    </div>
    <div class="card flush">
      ${b.loads.length ? `<table><thead><tr><th>Load</th><th>Shipper</th><th>Route</th><th>Check calls</th><th>Amount</th></tr></thead><tbody>
        ${b.loads.map((l) => `<tr class="link" data-id="${l.id}"><td><strong>${esc(l.ref)}</strong></td><td>${esc(l.shipper)}</td><td>${esc(l.origin)} → ${esc(l.destination)}</td><td class="mono">${l.calls}</td><td class="mono">${money(b.price_per_load)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No tracked loads this month.</div>'}
    </div>`;
  document.getElementById('month').addEventListener('change', (e) => billing(e.target.value));
  $view.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/loads/${tr.dataset.id}`)));
}

// ---------------- Settings ----------------
async function settings() {
  const s = await api('/api/settings');
  $view.innerHTML = `
    <h1>Settings</h1>
    <p class="sub">How often drivers get checked on, and when a load counts as late.</p>
    <form id="f" class="card" style="max-width:680px">
      <div class="grid2">
        <div class="field"><label>Company name</label><input name="company_name" value="${esc(s.company_name)}"><div class="hint">Shown in texts to drivers.</div></div>
        <div class="field"><label>Your cell for alerts</label><input name="broker_phone" value="${esc(s.broker_phone)}" placeholder="+12145550000"><div class="hint">We text you when a load goes late. Leave empty to skip.</div></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Check call every (hours)</label><input name="cadence_hours" type="number" step="0.5" min="0.5" value="${s.cadence_hours}"></div>
        <div class="field"><label>Late after (minutes past appt)</label><input name="grace_minutes" type="number" min="1" value="${s.grace_minutes}"></div>
        <div class="field"><label>No answer after (minutes)</label><input name="no_response_minutes" type="number" min="1" value="${s.no_response_minutes}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Time zone</label><input name="timezone" value="${esc(s.timezone)}" placeholder="America/Chicago"><div class="hint">All times are shown in this zone.</div></div>
        <div class="field"><label>Average speed (mph)</label><input name="avg_mph" type="number" min="1" value="${s.avg_mph}"><div class="hint">Used for ETAs. Rest breaks are added.</div></div>
        <div class="field"><label>Price per tracked load ($)</label><input name="price_per_load" type="number" step="0.01" min="0.01" value="${s.price_per_load}"></div>
      </div>
      <div class="err" id="err"></div>
      <button class="btn primary">Save settings</button>
    </form>`;
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { TZ = (await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) })).timezone; toast('Saved'); }
    catch (err) { document.getElementById('err').textContent = err.message; }
  });
}

// ---------------- Router ----------------
async function render() {
  clearInterval(refreshTimer);
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  const name = hash.startsWith('/loads/') ? 'board' : (hash.slice(1) || 'board');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === name));
  try {
    if (!cities.length) cities = await api('/api/cities');
    if (!TZ) TZ = (await api('/api/settings')).timezone;
    if ((m = hash.match(/^\/loads\/(\d+)$/))) await loadDetail(m[1]);
    else if (hash === '/new') newLoad();
    else if (hash === '/outbox') await outbox();
    else if (hash === '/billing') await billing();
    else if (hash === '/settings') await settings();
    else await board();
    updateAlertCount();
  } catch (e) {
    $view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back to load board</a></div>`;
  }
}

window.addEventListener('hashchange', render);
render();
