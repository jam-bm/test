// Fills the database with a realistic demo week: loads on time, at risk, late,
// unanswered and delivered. Usage: npm run seed  (add --reset to wipe first)
const fs = require('node:fs');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { HOUR, MIN } = require('../src/core');

const file = process.env.TRACKDESK_DB || 'trackdesk.db';
if (process.argv.includes('--reset')) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });

const db = openDb(file);
const realNow = Date.now();
let now = realNow;
const service = createService({
  db,
  messenger: { provider: 'outbox', send: async () => ({ ok: true }) },
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  clock: () => now,
});

const at = (h) => realNow + h * HOUR;

// [ref, shipper, driver, phone, carrier, origin, destination, pickup(h from now), appt(h from now), check-ins [h, city, delayMin]]
const LOADS = [
  ['L-2041', 'Bluebonnet Foods', 'Mike Torres', '2145550101', 'Torres Trucking', 'Dallas, TX', 'Atlanta, GA', -10, 6, [[-10, 'Dallas'], [-6, 'Shreveport Texarkana Little Rock'], [-2, 'Memphis']]],
  ['L-2042', 'Ridgeline Steel', 'Dana Price', '4045550142', 'Price Freight', 'Atlanta, GA', 'Chicago, IL', -8, 4, [[-8, 'Atlanta'], [-4, 'Nashville'], [-1, 'Louisville', 90]]],
  ['L-2043', 'Mesa Produce', 'Luis Ortega', '6025550177', 'Ortega Bros', 'Phoenix, AZ', 'Denver, CO', -9, 10, [[-9, 'Phoenix'], [-5, 'Albuquerque']]],
  ['L-2044', 'Northstar Paper', 'Kim Nguyen', '6125550110', 'KN Logistics', 'Minneapolis, MN', 'Kansas City, MO', -5, 9, [[-5, 'Minneapolis']]],
  ['L-2045', 'Gulf Coast Chem', 'Ray Jackson', '7135550133', 'RJ Transport', 'Houston, TX', 'San Antonio, TX', -3, 0.6, [[-3, 'Houston']]],
  ['L-2046', 'Sierra Home Goods', 'Ann Becker', '7755550188', 'Becker Haul', 'Reno, NV', 'Salt Lake City, UT', 2, 14, []],
  ['L-2047', 'Peach State Bottling', 'Omar Haddad', '9125550166', 'Haddad Carriers', 'Savannah, GA', 'Charlotte, NC', -30, -20, [[-30, 'Savannah'], [-26, 'Columbia Charlotte']], true],
  ['L-2048', 'Prairie Grain Co', 'Beth Collins', '4025550121', 'Collins Freight', 'Omaha, NE', 'Tulsa, OK', -7, 3, [[-7, 'Omaha'], [-3, 'Kansas City']]],
];

(async () => {
  for (const [ref, shipper, driver, phone, carrier, origin, destination, pickupH, apptH, checkIns, delivered] of LOADS) {
    now = at(pickupH) - 2 * HOUR;
    const load = service.createLoad({
      ref, shipper, shipper_contact: `dispatch@${shipper.toLowerCase().replace(/[^a-z]/g, '')}.com`, carrier,
      driver_name: driver, driver_phone: phone, origin, destination, pickup_at: at(pickupH), delivery_at: at(apptH),
    });
    for (const [h, city, delay = 0] of checkIns) {
      now = at(h);
      await service.sendCheckCall(load.id);
      now = at(h) + 7 * MIN;
      await service.recordCheckIn(load.id, { place: city, delayMinutes: delay, source: 'driver', note: delay ? `Traffic, about ${delay} min behind` : '' });
    }
    if (ref === 'L-2044') { now = at(-1.8); await service.sendCheckCall(load.id); } // unanswered
    if (delivered) { now = at(apptH) - 20 * MIN; await service.markDelivered(load.id); }
  }
  now = realNow;
  await service.evaluateAlerts();
  console.log(`Seeded ${LOADS.length} demo loads into ${file}`);
})();
