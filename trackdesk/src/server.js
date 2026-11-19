const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createMessenger } = require('./messaging');
const { createService } = require('./service');
const { CITIES } = require('./core');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function createApp(service) {
  const routes = [
    ['GET', /^\/api\/loads$/, (req, m, url) => service.listLoads({ includeDelivered: url.searchParams.get('all') !== '0' })],
    ['POST', /^\/api\/loads$/, (req, m, url, body) => service.createLoad(body)],
    ['GET', /^\/api\/loads\/(\d+)$/, (req, m) => service.getLoad(Number(m[1]))],
    ['POST', /^\/api\/loads\/(\d+)\/call$/, (req, m) => service.sendCheckCall(Number(m[1]))],
    ['POST', /^\/api\/loads\/(\d+)\/checkins$/, (req, m, url, body) => service.recordCheckIn(Number(m[1]), {
      place: body.place, lat: body.lat, lng: body.lng, note: body.note, delayMinutes: Number(body.delayMinutes) || 0, source: 'broker',
    })],
    ['POST', /^\/api\/loads\/(\d+)\/delivered$/, (req, m) => service.markDelivered(Number(m[1]))],
    ['GET', /^\/api\/alerts$/, () => service.listAlerts()],
    ['POST', /^\/api\/alerts\/(\d+)\/ack$/, (req, m) => (service.ackAlert(Number(m[1])), { ok: true })],
    ['GET', /^\/api\/messages$/, () => service.listMessages()],
    ['GET', /^\/api\/billing$/, (req, m, url) => service.billing(url.searchParams.get('month'))],
    ['GET', /^\/api\/settings$/, () => service.getSettings()],
    ['PUT', /^\/api\/settings$/, (req, m, url, body) => service.updateSettings(body)],
    ['GET', /^\/api\/cities$/, () => Object.keys(CITIES)],
    ['POST', /^\/api\/tick$/, async () => ({ called: await service.tick() })],
    ['GET', /^\/api\/c\/([\w-]+)$/, (req, m) => service.driverView(m[1])],
    ['POST', /^\/api\/c\/([\w-]+)$/, (req, m, url, body) => service.driverCheckIn(m[1], body)],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Twilio inbound SMS webhook: replies with TwiML.
      if (req.method === 'POST' && url.pathname === '/webhooks/sms') {
        const form = new URLSearchParams(await readBody(req));
        const result = await service.inboundSms({ from: form.get('From'), body: form.get('Body') });
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(result.reply)}</Message></Response>`);
      }

      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || req.method !== method) continue;
        const raw = method === 'GET' ? '' : await readBody(req);
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
        }
        return send(res, 200, await fn(req, m, url, body));
      }

      if (req.method === 'GET') return serveStatic(url.pathname, res);
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    }
  };
}

function serveStatic(pathname, res) {
  let file;
  if (pathname.startsWith('/c/')) file = 'driver.html';
  else if (pathname === '/' || !path.extname(pathname)) file = 'index.html';
  else file = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '').slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data ?? null));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(Object.assign(new Error('Body too large'), { status: 413 }));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
  const db = openDb();
  const messenger = createMessenger();
  const service = createService({ db, messenger, publicUrl });
  http.createServer(createApp(service)).listen(port, () => {
    console.log(`Track Desk running at ${publicUrl}  (SMS: ${messenger.provider})`);
  });
  const runTick = () => service.tick().catch((e) => console.error('tick failed', e));
  runTick();
  setInterval(runTick, 60_000);
}

module.exports = { createApp };
