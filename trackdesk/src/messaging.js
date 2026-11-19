// Outbound SMS. Uses Twilio when TWILIO_* env vars are set; otherwise
// messages are only logged to the outbox (visible in the app) so you can demo it.

function createMessenger(env = process.env, fetchImpl = globalThis.fetch) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const live = Boolean(sid && token && from);

  return {
    provider: live ? 'twilio' : 'outbox',
    async send(to, body) {
      if (!live) return { ok: true };
      try {
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from, Body: body }),
        });
        if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
  };
}

module.exports = { createMessenger };
