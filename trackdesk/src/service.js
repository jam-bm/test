const crypto = require('node:crypto');
const core = require('./core');
const { DEFAULT_SETTINGS } = require('./db');

const NUMERIC_SETTINGS = ['cadence_hours', 'grace_minutes', 'no_response_minutes', 'avg_mph', 'price_per_load'];

function createService({ db, messenger, publicUrl = 'http://localhost:3000', clock = () => Date.now() }) {
  const q = (sql) => db.prepare(sql);
  const fmt = (ms) => fmtTz(ms, getSettings().timezone);

  // ---------- settings ----------
  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const { key, value } of q('SELECT key, value FROM settings').all()) {
      if (key in out) out[key] = NUMERIC_SETTINGS.includes(key) ? Number(value) : value;
    }
    return out;
  }

  function updateSettings(patch) {
    const stmt = q('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (NUMERIC_SETTINGS.includes(key)) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${key} must be a positive number`);
        stmt.run(key, String(n));
      } else if (key === 'timezone') {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(raw) }); } catch { throw httpError(400, `Unknown time zone: ${raw}`); }
        stmt.run(key, String(raw));
      } else {
        stmt.run(key, String(raw ?? ''));
      }
    }
    return getSettings();
  }

  // ---------- loads ----------
  function createLoad(input) {
    const required = ['ref', 'driver_name', 'driver_phone', 'origin', 'destination', 'pickup_at', 'delivery_at'];
    for (const f of required) if (input[f] == null || input[f] === '') throw httpError(400, `${f} is required`);
    const origin = core.findCity(input.origin);
    const destination = core.findCity(input.destination);
    if (!origin) throw httpError(400, `Unknown origin city: ${input.origin}`);
    if (!destination) throw httpError(400, `Unknown destination city: ${input.destination}`);
    const pickup = toMs(input.pickup_at);
    const delivery = toMs(input.delivery_at);
    if (!pickup || !delivery) throw httpError(400, 'pickup_at and delivery_at must be valid dates');
    if (delivery <= pickup) throw httpError(400, 'Delivery must be after pickup');
    const phone = normalizePhone(input.driver_phone);
    if (!phone) throw httpError(400, 'driver_phone must be a valid phone number');

    const r = q(`INSERT INTO loads (ref, shipper, shipper_contact, carrier, driver_name, driver_phone, origin, destination, pickup_at, delivery_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(input.ref), String(input.shipper || ''), String(input.shipper_contact || ''), String(input.carrier || ''),
      String(input.driver_name), phone, origin, destination, pickup, delivery, clock()
    );
    return getLoad(Number(r.lastInsertRowid));
  }

  function rawLoad(id) {
    const load = q('SELECT * FROM loads WHERE id = ?').get(id);
    if (!load) throw httpError(404, 'Load not found');
    return load;
  }

  function summarize(load, settings, now) {
    const lastCheckIn = q('SELECT * FROM check_ins WHERE load_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(load.id) || null;
    const lastCall = q('SELECT * FROM check_calls WHERE load_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1').get(load.id) || null;
    const openCall = lastCall && !lastCall.responded_at ? lastCall : null;
    const health = core.loadHealth({ load, lastCheckIn, openCall, now, settings });
    return {
      ...load,
      health,
      last_check_in: lastCheckIn,
      last_call: lastCall,
      next_call_at: core.nextCheckCallAt({ load, lastCall, settings }),
      eta: lastCheckIn ? lastCheckIn.eta : null,
      progress: progressOf(load, lastCheckIn),
    };
  }

  // Share of the route covered, from the last known position (0..1).
  function progressOf(load, lastCheckIn) {
    if (load.status === 'delivered') return 1;
    if (!lastCheckIn || lastCheckIn.lat == null) return 0;
    const o = core.cityCoords(load.origin);
    const d = core.cityCoords(load.destination);
    const total = core.haversineMiles(o, d);
    if (!total) return 1;
    const left = core.haversineMiles([lastCheckIn.lat, lastCheckIn.lng], d);
    return Math.max(0, Math.min(1, 1 - left / total));
  }

  function listLoads({ includeDelivered = true } = {}) {
    const settings = getSettings();
    const now = clock();
    const rows = q(`SELECT * FROM loads ${includeDelivered ? '' : "WHERE status != 'delivered'"} ORDER BY delivery_at ASC`).all();
    const order = { late: 0, no_response: 1, at_risk: 2, on_time: 3, scheduled: 4, delivered: 5 };
    return rows.map((l) => summarize(l, settings, now)).sort((a, b) => order[a.health] - order[b.health] || a.delivery_at - b.delivery_at);
  }

  function getLoad(id) {
    const load = summarize(rawLoad(id), getSettings(), clock());
    load.check_ins = q('SELECT * FROM check_ins WHERE load_id = ? ORDER BY at DESC, id DESC').all(id);
    load.check_calls = q('SELECT * FROM check_calls WHERE load_id = ? ORDER BY sent_at DESC, id DESC').all(id);
    load.alerts = q('SELECT * FROM alerts WHERE load_id = ? ORDER BY at DESC').all(id);
    load.shipper_update = shipperUpdate(load);
    return load;
  }

  // ---------- check calls ----------
  async function sendCheckCall(loadId) {
    const load = rawLoad(loadId);
    if (load.status === 'delivered') throw httpError(400, 'Load already delivered');
    const settings = getSettings();
    const token = crypto.randomBytes(9).toString('base64url');
    const now = clock();
    const r = q('INSERT INTO check_calls (load_id, token, sent_at) VALUES (?, ?, ?)').run(load.id, token, now);
    const link = `${publicUrl}/c/${token}`;
    const body = `${settings.company_name}: Hi ${firstName(load.driver_name)}, check call for load ${load.ref} ` +
      `(${load.origin} → ${load.destination}). Where are you? Tap to update: ${link} or reply with your city.`;
    await logAndSend({ loadId: load.id, phone: load.driver_phone, body });
    return { id: Number(r.lastInsertRowid), token, link };
  }

  async function logAndSend({ loadId = null, phone, body }) {
    const result = await messenger.send(phone, body);
    q('INSERT INTO messages (load_id, direction, phone, body, at, provider, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(loadId, 'out', phone, body, clock(), messenger.provider, result.ok ? null : result.error);
    return result;
  }

  // Scheduler step: send any check calls that are due. Returns the load ids called.
  async function tick() {
    const settings = getSettings();
    const now = clock();
    const called = [];
    for (const load of q("SELECT * FROM loads WHERE status != 'delivered'").all()) {
      const lastCall = q('SELECT * FROM check_calls WHERE load_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1').get(load.id);
      const due = core.nextCheckCallAt({ load, lastCall, settings });
      if (due != null && due <= now) {
        await sendCheckCall(load.id);
        called.push(load.id);
      }
    }
    await evaluateAlerts();
    return called;
  }

  // ---------- check-ins ----------
  async function recordCheckIn(loadId, { lat, lng, place, note = '', delivered = false, delayMinutes = 0, source = 'driver', callId = null }) {
    const load = rawLoad(loadId);
    if (load.status === 'delivered') throw httpError(400, 'Load already delivered');
    const settings = getSettings();
    const now = clock();
    let coords = null;
    let placeName = null;
    if (lat != null && lng != null && lat !== '' && lng !== '') {
      coords = [Number(lat), Number(lng)];
      if (!coords.every(Number.isFinite)) throw httpError(400, 'Invalid coordinates');
      placeName = `Near ${core.nearestCity(coords).name}`;
    } else if (place) {
      const city = core.findCity(place);
      if (!city) throw httpError(400, `Unknown city: ${place}`);
      coords = core.CITIES[city];
      placeName = `Near ${city}`;
    } else if (!delivered) {
      throw httpError(400, 'A location (GPS or city) is required');
    }

    let eta = null;
    if (delivered) eta = now;
    else eta = core.estimateEta({ from: coords, to: core.cityCoords(load.destination), at: now, avgMph: settings.avg_mph }) + delayMinutes * core.MIN;

    q('INSERT INTO check_ins (load_id, call_id, at, lat, lng, place, eta, note, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(load.id, callId, now, coords ? coords[0] : null, coords ? coords[1] : null, placeName || load.destination, eta, String(note || ''), source);

    // Any reply answers every open call on this load.
    q('UPDATE check_calls SET responded_at = ? WHERE load_id = ? AND responded_at IS NULL').run(now, load.id);
    if (delivered) {
      q("UPDATE loads SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now, load.id);
      q('UPDATE alerts SET acked_at = ? WHERE load_id = ? AND acked_at IS NULL').run(now, load.id);
    }
    await evaluateAlerts();
    return getLoad(load.id);
  }

  function callByToken(token) {
    const call = q('SELECT * FROM check_calls WHERE token = ?').get(token);
    if (!call) throw httpError(404, 'This check-in link is not valid');
    const load = rawLoad(call.load_id);
    return { call, load };
  }

  function driverView(token) {
    const { load } = callByToken(token);
    return {
      ref: load.ref,
      driver_name: load.driver_name,
      origin: load.origin,
      destination: load.destination,
      delivery_at: load.delivery_at,
      delivered: load.status === 'delivered',
      company_name: getSettings().company_name,
      cities: Object.keys(core.CITIES),
    };
  }

  async function driverCheckIn(token, body) {
    const { call, load } = callByToken(token);
    await recordCheckIn(load.id, {
      lat: body.lat, lng: body.lng, place: body.place, note: body.note,
      delivered: Boolean(body.delivered), delayMinutes: Number(body.delay_minutes) || 0, callId: call.id,
    });
    return driverView(token);
  }

  // Inbound SMS (e.g. Twilio webhook). Matches the sender to their most recent active load.
  async function inboundSms({ from, body }) {
    const phone = normalizePhone(from);
    const msg = q('INSERT INTO messages (load_id, direction, phone, body, at, provider) VALUES (NULL, ?, ?, ?, ?, ?)')
      .run('in', phone || String(from), String(body || ''), clock(), messenger.provider);
    const load = phone && q("SELECT * FROM loads WHERE driver_phone = ? AND status != 'delivered' ORDER BY pickup_at DESC LIMIT 1").get(phone);
    if (!load) return { matched: false, reply: 'Thanks. We could not match this number to an active load.' };
    q('UPDATE messages SET load_id = ? WHERE id = ?').run(load.id, msg.lastInsertRowid);
    const parsed = core.parseDriverReply(body);
    if (!parsed.delivered && !parsed.city) {
      return { matched: true, loadId: load.id, reply: `Got it. Please reply with the nearest city (e.g. "near Memphis") or tap the link we sent.` };
    }
    await recordCheckIn(load.id, { place: parsed.city, note: parsed.note, delivered: parsed.delivered, delayMinutes: parsed.delayMinutes, source: 'sms' });
    return { matched: true, loadId: load.id, reply: parsed.delivered ? `Thanks, ${load.ref} marked delivered.` : `Thanks, logged near ${parsed.city}.` };
  }

  // ---------- alerts ----------
  async function evaluateAlerts() {
    const settings = getSettings();
    const now = clock();
    for (const raw of q("SELECT * FROM loads WHERE status != 'delivered'").all()) {
      const load = summarize(raw, settings, now);
      // Clear alerts the load has recovered from (e.g. driver answered, or ETA back on time).
      q('UPDATE alerts SET acked_at = ? WHERE load_id = ? AND acked_at IS NULL AND kind != ?').run(now, load.id, load.health);
      if (load.health !== 'late' && load.health !== 'no_response') continue;
      const existing = q('SELECT id FROM alerts WHERE load_id = ? AND kind = ? AND acked_at IS NULL').get(load.id, load.health);
      if (existing) continue;
      const message = load.health === 'late'
        ? `Load ${load.ref} is running late: ETA ${fmt(load.eta)} vs appointment ${fmt(load.delivery_at)}.`
        : `Driver ${load.driver_name} has not answered the check call for load ${load.ref}.`;
      q('INSERT INTO alerts (load_id, kind, message, at) VALUES (?, ?, ?, ?)').run(load.id, load.health, message, now);
      if (settings.broker_phone) await logAndSend({ loadId: load.id, phone: settings.broker_phone, body: `Track Desk alert: ${message}` });
    }
  }

  function listAlerts() {
    return q(`SELECT a.*, l.ref FROM alerts a JOIN loads l ON l.id = a.load_id WHERE a.acked_at IS NULL ORDER BY a.at DESC`).all();
  }

  function ackAlert(id) {
    q('UPDATE alerts SET acked_at = ? WHERE id = ?').run(clock(), id);
  }

  function listMessages() {
    return q('SELECT m.*, l.ref FROM messages m LEFT JOIN loads l ON l.id = m.load_id ORDER BY m.at DESC, m.id DESC LIMIT 200').all();
  }

  // ---------- billing ----------
  // A load is billable in a month if at least one check call went out for it that month.
  function billing(month) {
    const ym = month || new Date(clock()).toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw httpError(400, 'month must be YYYY-MM');
    const start = Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
    const end = Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1);
    const rows = q(`SELECT l.id, l.ref, l.shipper, l.origin, l.destination, COUNT(c.id) AS calls
                    FROM loads l JOIN check_calls c ON c.load_id = l.id
                    WHERE c.sent_at >= ? AND c.sent_at < ? GROUP BY l.id ORDER BY l.id`).all(start, end);
    const price = getSettings().price_per_load;
    return { month: ym, price_per_load: price, tracked_loads: rows.length, total: rows.length * price, loads: rows };
  }

  function shipperUpdate(load) {
    if (load.status === 'delivered') return `Update on load ${load.ref}: delivered at ${fmt(load.delivered_at)}.`;
    if (!load.last_check_in) return `Update on load ${load.ref}: scheduled for pickup ${fmt(load.pickup_at)} in ${load.origin}.`;
    const lateNote = load.health === 'late' ? ' This is after the appointment; we are working with the carrier and will keep you posted.' : '';
    return `Update on load ${load.ref}: truck is ${load.last_check_in.place.replace(/^Near/, 'near')} as of ${fmt(load.last_check_in.at)}. ` +
      `Estimated arrival in ${load.destination}: ${fmt(load.eta)} (appointment ${fmt(load.delivery_at)}).${lateNote}`;
  }

  return {
    getSettings, updateSettings, createLoad, listLoads, getLoad, sendCheckCall, tick, recordCheckIn,
    driverView, driverCheckIn, inboundSms, listAlerts, ackAlert, listMessages, billing, evaluateAlerts,
    markDelivered: (id) => recordCheckIn(id, { delivered: true, source: 'broker', note: 'Marked delivered by broker' }),
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function toMs(v) {
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && String(p).trim().startsWith('+')) return `+${digits}`;
  return null;
}

function firstName(n) {
  return String(n).trim().split(/\s+/)[0];
}

function fmtTz(ms, timeZone = 'America/Chicago') {
  if (ms == null) return 'unknown';
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
}

module.exports = { createService, httpError, normalizePhone };
