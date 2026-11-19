const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/server');
const { HOUR } = require('../src/core');

function setup(start = Date.UTC(2026, 10, 19, 12)) {
  let now = start;
  const sent = [];
  const messenger = { provider: 'test', send: async (to, body) => (sent.push({ to, body }), { ok: true }) };
  const service = createService({ db: openDb(':memory:'), messenger, publicUrl: 'http://td.test', clock: () => now });
  return { service, sent, advance: (ms) => (now += ms), now: () => now };
}

function newLoad(service, now, overrides = {}) {
  return service.createLoad({
    ref: 'L-100', shipper: 'Acme Foods', driver_name: 'Mike Torres', driver_phone: '(214) 555-0101',
    origin: 'Dallas, TX', destination: 'Atlanta, GA', pickup_at: now, delivery_at: now + 24 * HOUR, ...overrides,
  });
}

test('createLoad validates input', () => {
  const { service, now } = setup();
  assert.throws(() => newLoad(service, now(), { origin: 'Atlantis' }), /Unknown origin/);
  assert.throws(() => newLoad(service, now(), { driver_phone: '12' }), /driver_phone/);
  assert.throws(() => newLoad(service, now(), { delivery_at: now() - HOUR }), /after pickup/);
  const load = newLoad(service, now());
  assert.equal(load.driver_phone, '+12145550101');
  assert.equal(load.health, 'on_time');
});

test('scheduler calls at pickup, then on cadence, and stops after delivery', async () => {
  const { service, sent, advance, now } = setup();
  const load = newLoad(service, now() + HOUR);
  assert.deepEqual(await service.tick(), [], 'not before pickup');
  advance(HOUR);
  assert.deepEqual(await service.tick(), [load.id], 'at pickup');
  assert.match(sent[0].body, /Where are you\?.*http:\/\/td\.test\/c\//);
  advance(2 * HOUR);
  assert.deepEqual(await service.tick(), [], 'not before cadence');
  advance(2 * HOUR);
  assert.deepEqual(await service.tick(), [load.id], 'after 4 hours');
  await service.markDelivered(load.id);
  advance(5 * HOUR);
  assert.deepEqual(await service.tick(), []);
});

test('driver check-in logs location + ETA and answers the call', async () => {
  const { service, advance, now } = setup();
  const load = newLoad(service, now());
  const call = await service.sendCheckCall(load.id);
  advance(10 * 60_000);
  const view = await service.driverCheckIn(call.token, { place: 'Shreveport? no, near Memphis' });
  assert.equal(view.ref, 'L-100');
  const detail = service.getLoad(load.id);
  assert.equal(detail.last_check_in.place, 'Near Memphis, TN');
  assert.ok(detail.eta > now() && detail.eta < load.delivery_at);
  assert.ok(detail.check_calls[0].responded_at);
  assert.equal(detail.health, 'on_time');
});

test('late load raises one alert and texts the broker', async () => {
  const { service, sent, now } = setup();
  service.updateSettings({ broker_phone: '+15550000000' });
  const load = newLoad(service, now(), { delivery_at: now() + 6 * HOUR });
  await service.recordCheckIn(load.id, { place: 'Dallas', source: 'broker' });
  assert.equal(service.getLoad(load.id).health, 'late');
  await service.evaluateAlerts();
  const alerts = service.listAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'late');
  assert.equal(sent.filter((m) => m.to === '+15550000000').length, 1);
  assert.match(service.getLoad(load.id).shipper_update, /after the appointment/);
});

test('unanswered check call becomes no_response', async () => {
  const { service, advance, now } = setup();
  const load = newLoad(service, now());
  await service.sendCheckCall(load.id);
  advance(2 * HOUR);
  await service.evaluateAlerts();
  assert.equal(service.getLoad(load.id).health, 'no_response');
  assert.equal(service.listAlerts()[0].kind, 'no_response');
  await service.recordCheckIn(load.id, { place: 'Shreveport Little Rock' });
  assert.equal(service.listAlerts().length, 0, 'alert clears once the driver answers on time');
});

test('alerts on delivered loads are cleared', async () => {
  const { service, now } = setup();
  const load = newLoad(service, now(), { delivery_at: now() + 6 * HOUR });
  await service.recordCheckIn(load.id, { place: 'Dallas' });
  assert.equal(service.listAlerts().length, 1);
  await service.markDelivered(load.id);
  assert.equal(service.listAlerts().length, 0);
});

test('inbound SMS is matched to the driver and parsed', async () => {
  const { service } = setup();
  const load = newLoad(service, Date.UTC(2026, 10, 19, 12));
  const r = await service.inboundSms({ from: '+12145550101', body: 'near little rock 1 hr late' });
  assert.equal(r.matched, true);
  assert.equal(service.getLoad(load.id).last_check_in.place, 'Near Little Rock, AR');
  const unknown = await service.inboundSms({ from: '+19999999999', body: 'hi' });
  assert.equal(unknown.matched, false);
});

test('billing counts each tracked load once per month', async () => {
  const { service, now, advance } = setup();
  const a = newLoad(service, now());
  newLoad(service, now(), { ref: 'L-101' }); // never called: not billed
  await service.sendCheckCall(a.id);
  advance(4 * HOUR);
  await service.sendCheckCall(a.id);
  const bill = service.billing('2026-11');
  assert.equal(bill.tracked_loads, 1);
  assert.equal(bill.loads[0].calls, 2);
  assert.equal(bill.total, 12);
  assert.equal(service.billing('2026-10').tracked_loads, 0);
});

test('HTTP API: create load, driver page and Twilio webhook', async () => {
  const { service, now } = setup();
  const server = http.createServer(createApp(service)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/api/loads`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 400);
    const created = await (await fetch(`${base}/api/loads`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'L-7', driver_name: 'Ann', driver_phone: '2145550199', origin: 'Denver', destination: 'Omaha', pickup_at: now(), delivery_at: now() + 20 * HOUR }),
    })).json();
    const call = await (await fetch(`${base}/api/loads/${created.id}/call`, { method: 'POST' })).json();
    const page = await fetch(`${base}/c/${call.token}`);
    assert.match(await page.text(), /<html/i);
    const view = await (await fetch(`${base}/api/c/${call.token}`)).json();
    assert.equal(view.ref, 'L-7');
    const twiml = await fetch(`${base}/webhooks/sms`, { method: 'POST', body: 'From=%2B12145550199&Body=near+lincoln+omaha' });
    assert.match(await twiml.text(), /logged near Omaha/);
    assert.equal((await fetch(`${base}/api/c/nope`)).status, 404);
  } finally {
    server.close();
  }
});
