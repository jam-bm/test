const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

const H = core.HOUR;
const settings = { cadence_hours: 4, grace_minutes: 30, no_response_minutes: 90, avg_mph: 50 };

test('findCity matches loose driver text', () => {
  assert.equal(core.findCity('near dallas'), 'Dallas, TX');
  assert.equal(core.findCity('Just past Salt Lake City, running fine'), 'Salt Lake City, UT');
  assert.equal(core.findCity('Kansas City MO'), 'Kansas City, MO');
  assert.equal(core.findCity('somewhere in the desert'), null);
});

test('haversine: Dallas to Memphis is about 420 miles straight line', () => {
  const d = core.haversineMiles(core.CITIES['Dallas, TX'], core.CITIES['Memphis, TN']);
  assert.ok(d > 400 && d < 440, `got ${d}`);
});

test('estimateEta adds a rest break for every 11 hours of driving', () => {
  const at = 0;
  const short = core.estimateEta({ from: core.CITIES['Dallas, TX'], to: core.CITIES['Memphis, TN'], at });
  assert.ok(short / H > 9 && short / H < 11, `short trip ${short / H}h`);
  const long = core.estimateEta({ from: core.CITIES['Los Angeles, CA'], to: core.CITIES['Chicago, IL'], at });
  const miles = core.haversineMiles(core.CITIES['Los Angeles, CA'], core.CITIES['Chicago, IL']) * 1.2;
  assert.ok(long / H > miles / 50 + 20, 'long trip includes at least two rests');
});

test('loadHealth classifies loads', () => {
  const load = { status: 'active', pickup_at: 10 * H, delivery_at: 20 * H };
  const base = { load, settings, lastCheckIn: null, openCall: null };
  assert.equal(core.loadHealth({ ...base, now: 5 * H }), 'scheduled');
  assert.equal(core.loadHealth({ ...base, now: 12 * H, lastCheckIn: { eta: 18 * H } }), 'on_time');
  assert.equal(core.loadHealth({ ...base, now: 12 * H, lastCheckIn: { eta: 20 * H } }), 'at_risk');
  assert.equal(core.loadHealth({ ...base, now: 12 * H, lastCheckIn: { eta: 21 * H } }), 'late');
  assert.equal(core.loadHealth({ ...base, now: 21 * H }), 'late');
  assert.equal(core.loadHealth({ ...base, now: 12 * H, openCall: { sent_at: 10 * H } }), 'no_response');
  assert.equal(core.loadHealth({ ...base, now: 12 * H, openCall: { sent_at: 11.5 * H } }), 'on_time');
  assert.equal(core.loadHealth({ ...base, load: { ...load, status: 'delivered' }, now: 30 * H }), 'delivered');
});

test('nextCheckCallAt: at pickup, then every cadence hours, none after delivery', () => {
  const load = { status: 'active', pickup_at: 10 * H };
  assert.equal(core.nextCheckCallAt({ load, lastCall: null, settings }), 10 * H);
  assert.equal(core.nextCheckCallAt({ load, lastCall: { sent_at: 10 * H }, settings }), 14 * H);
  assert.equal(core.nextCheckCallAt({ load: { ...load, status: 'delivered' }, lastCall: null, settings }), null);
});

test('parseDriverReply understands city, delay and delivery', () => {
  assert.deepEqual(
    { ...core.parseDriverReply('near Memphis, running 2 hrs late'), note: undefined },
    { delivered: false, city: 'Memphis, TN', delayMinutes: 120, note: undefined }
  );
  assert.equal(core.parseDriverReply('Delivered, empty now').delivered, true);
  assert.equal(core.parseDriverReply('ok').city, null);
});
