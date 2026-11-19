// Pure logic: geography, ETA, load health, check-call scheduling.
// No I/O here so it is easy to test.

const HOUR = 3600_000;
const MIN = 60_000;

// Common US freight hubs. Drivers can pick one of these or share GPS.
const CITIES = {
  'Albuquerque, NM': [35.084, -106.651],
  'Atlanta, GA': [33.749, -84.388],
  'Birmingham, AL': [33.519, -86.81],
  'Boise, ID': [43.615, -116.202],
  'Boston, MA': [42.36, -71.059],
  'Charlotte, NC': [35.227, -80.843],
  'Chicago, IL': [41.878, -87.63],
  'Cincinnati, OH': [39.103, -84.512],
  'Columbus, OH': [39.961, -82.999],
  'Dallas, TX': [32.777, -96.797],
  'Denver, CO': [39.739, -104.99],
  'Detroit, MI': [42.331, -83.046],
  'El Paso, TX': [31.762, -106.485],
  'Houston, TX': [29.76, -95.37],
  'Indianapolis, IN': [39.768, -86.158],
  'Jacksonville, FL': [30.332, -81.656],
  'Kansas City, MO': [39.1, -94.579],
  'Laredo, TX': [27.506, -99.507],
  'Las Vegas, NV': [36.17, -115.14],
  'Little Rock, AR': [34.746, -92.29],
  'Los Angeles, CA': [34.052, -118.244],
  'Louisville, KY': [38.253, -85.759],
  'Memphis, TN': [35.149, -90.049],
  'Miami, FL': [25.762, -80.192],
  'Minneapolis, MN': [44.978, -93.265],
  'Nashville, TN': [36.163, -86.781],
  'Newark, NJ': [40.736, -74.172],
  'Oklahoma City, OK': [35.468, -97.516],
  'Omaha, NE': [41.257, -95.934],
  'Philadelphia, PA': [39.953, -75.165],
  'Phoenix, AZ': [33.448, -112.074],
  'Pittsburgh, PA': [40.441, -79.996],
  'Portland, OR': [45.515, -122.679],
  'Reno, NV': [39.53, -119.814],
  'Sacramento, CA': [38.582, -121.494],
  'Salt Lake City, UT': [40.761, -111.891],
  'San Antonio, TX': [29.424, -98.494],
  'Savannah, GA': [32.081, -81.091],
  'Seattle, WA': [47.606, -122.332],
  'St. Louis, MO': [38.627, -90.199],
  'Tulsa, OK': [36.154, -95.993],
};

function cityCoords(name) {
  if (!name) return null;
  const key = findCity(name);
  return key ? CITIES[key] : null;
}

// Loose match: "dallas", "Dallas TX", "near dallas" all resolve to "Dallas, TX".
function findCity(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let best = null;
  for (const key of Object.keys(CITIES)) {
    const city = key.split(',')[0].toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (` ${t} `.includes(` ${city} `) && (!best || city.length > best.len)) best = { key, len: city.length };
  }
  return best ? best.key : null;
}

function haversineMiles([lat1, lon1], [lat2, lon2]) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestCity(coords) {
  let best = null;
  for (const [name, c] of Object.entries(CITIES)) {
    const d = haversineMiles(coords, c);
    if (!best || d < best.miles) best = { name, miles: d };
  }
  return best;
}

const ROAD_FACTOR = 1.2; // straight line -> road miles

// Estimate arrival: road miles at avgMph, plus a 10h rest for every 11h of driving (HOS).
function estimateEta({ from, to, at, avgMph = 50 }) {
  if (!from || !to) return null;
  const miles = haversineMiles(from, to) * ROAD_FACTOR;
  const driveHours = miles / avgMph;
  const rests = Math.floor(driveHours / 11);
  return Math.round(at + (driveHours + rests * 10) * HOUR);
}

/**
 * Health of a load at time `now`.
 * Returns one of: scheduled, on_time, at_risk, late, no_response, delivered.
 */
function loadHealth({ load, lastCheckIn, openCall, now, settings }) {
  const grace = settings.grace_minutes * MIN;
  if (load.status === 'delivered') return 'delivered';
  if (now > load.delivery_at + grace) return 'late';
  if (lastCheckIn && lastCheckIn.eta != null) {
    if (lastCheckIn.eta > load.delivery_at + grace) return 'late';
    if (lastCheckIn.eta > load.delivery_at - grace) return 'at_risk';
  }
  if (openCall && now - openCall.sent_at > settings.no_response_minutes * MIN) return 'no_response';
  if (now < load.pickup_at && !lastCheckIn) return 'scheduled';
  return 'on_time';
}

// When the next automatic check call is due: at pickup, then every cadence hours.
function nextCheckCallAt({ load, lastCall, settings }) {
  if (load.status === 'delivered') return null;
  if (!lastCall) return load.pickup_at;
  return lastCall.sent_at + settings.cadence_hours * HOUR;
}

// Parse a free-text SMS reply from a driver, e.g. "near memphis running 1hr late" or "delivered".
function parseDriverReply(body) {
  const text = String(body || '').trim();
  const lower = text.toLowerCase();
  const delivered = /\b(delivered|unloaded|empty)\b/.test(lower);
  const city = findCity(text);
  let delayMinutes = 0;
  const m = lower.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b[^.]*\blate\b/);
  if (m) delayMinutes = Math.round(parseFloat(m[1]) * (m[2].startsWith('h') ? 60 : 1));
  return { delivered, city, delayMinutes, note: text };
}

module.exports = {
  HOUR,
  MIN,
  CITIES,
  findCity,
  cityCoords,
  haversineMiles,
  nearestCity,
  estimateEta,
  loadHealth,
  nextCheckCallAt,
  parseDriverReply,
};
