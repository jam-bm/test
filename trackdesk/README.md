# Track Desk

Check calls for small freight brokers, done for them.

Brokers spend hours every week phoning truckers to ask "where are you?". Large brokers buy AI tools for this; the broker with ten trucks is still dialling. Track Desk fills that gap:

1. **Texts every driver**: an SMS with a one-tap check-in link (or the driver just replies with a city).
2. **At pickup, then every few hours**: on a schedule you set (default every 4 hours) until the load delivers.
3. **Logs the location and ETA**: from the driver's GPS or nearest city, with road miles, average speed and rest breaks.
4. **Flags late loads before the shipper asks**: late and no-answer alerts on the board (and by text to you), plus a ready-to-send shipper update.

Billing is **per tracked load**: a load counts once in a month if it got at least one check call.

## Run it

Requires Node.js 22.5 or newer (it uses the built-in `node:sqlite`). There are no npm dependencies.

```bash
cd trackdesk
npm run seed -- --reset   # optional: demo loads (late, at risk, no answer, delivered…)
npm start                 # http://localhost:3000
npm test
```

Without Twilio keys, outgoing texts are saved to **Messages** in the app. Open the link in a message to see the driver's check-in page and answer as the driver.

## Screens

| Screen | What it does |
| --- | --- |
| Load board | Every load sorted late first, with last location, ETA versus appointment, status and next call. Alerts appear at the top. |
| Load detail | Route progress, a timeline of calls, check-ins and alerts, "Call driver now", manual check-in, "Mark delivered" and the shipper update. |
| New load | Load number, shipper, driver cell, carrier, origin and destination, pickup and appointment times. |
| Messages | Every SMS in and out. |
| Billing | Tracked loads and the total for a month. |
| Settings | Call frequency, late grace period, no-answer timeout, average speed, price per load, time zone and your alert phone number. |
| Driver page (`/c/:token`) | A mobile page: share location or pick a city, choose on time, late or delivered, and send. |

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL used in the driver links sent by SMS |
| `TRACKDESK_DB` | `trackdesk.db` | SQLite file |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | none | Turns on real SMS through Twilio |

To accept driver replies by text, point your Twilio number's incoming-message webhook to `POST {PUBLIC_URL}/webhooks/sms`. Replies like `near memphis 1 hr late` or `delivered` are understood and matched to the driver's active load.

## How it works

- `src/core.js`: pure logic covering cities, distance, ETA (road factor 1.2 and a 10-hour rest per 11 hours of driving), load status and call schedule.
- `src/service.js`: loads, check calls, check-ins, alerts, inbound SMS and billing on SQLite.
- `src/server.js`: the HTTP API, static files and a scheduler that sends due calls every minute.
- `public/`: the broker console (`index.html`, `app.js`) and the driver page (`driver.html`).

### Load status

| Status | Rule |
| --- | --- |
| Late | The ETA, or the current time, is more than the grace period past the appointment. |
| At risk | The ETA is within the grace period of the appointment. |
| No answer | A check call has gone unanswered for longer than the no-answer timeout. |
| Scheduled | Before pickup, with no check-ins yet. |
| On time | Anything else that is still active. |
| Delivered | The load has delivered. |

Alerts clear themselves when a load recovers or delivers.

## Not built yet

- Voice calls with an AI agent. The messenger in `src/messaging.js` is the place to add a voice provider.
- Stripe billing. The Billing screen already computes the per-load invoice.
- Multiple brokerages and logins. Right now it is one brokerage per deployment.
- Real geocoding. Locations snap to a built-in list of 41 US freight hubs.
