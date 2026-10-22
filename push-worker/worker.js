// Gym Buddy rest-timer push server (Cloudflare Worker + Durable Object).
//
// When a rest starts, the app POSTs its push subscription and the delay to
// /schedule. One Durable Object per device keeps that subscription and sets an
// alarm for the end of the rest; when the alarm fires it sends a Web Push, so
// the notification arrives even if the phone is locked or the app is closed.
// /cancel clears a pending alarm (rest skipped/done early).
//
// Two independent timers per device, by "kind": "rest" (the default — what
// older app versions send) and "idle" (the "still working out?" nudge 30 min
// after the last logged set). A Durable Object has a single alarm, so it is
// set to whichever timer is due first and re-armed after each one fires.
//
// The push has no payload (the app's service worker shows a fixed "Rest is up"
// notification), so only VAPID signing is needed, not payload encryption.
// The VAPID key pair is generated on first use and stored inside Cloudflare
// (in a dedicated Durable Object instance) — there are no secrets to set up.

const APP_ORIGIN = "https://israeltoledano.github.io";
const VAPID_SUBJECT = "https://israeltoledano.github.io/Gym-buddy/";
const KEYS_NAME = "__vapid_keys__";

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin === APP_ORIGIN || (origin || "").startsWith("http://localhost") ? origin : APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json", ...cors(origin) } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/vapid-public") {
        const r = await keysStub(env).fetch("https://do/keys");
        const k = await r.json();
        return json({ key: k.publicB64 }, 200, origin);
      }
      if (req.method === "POST" && ["/schedule", "/cancel", "/test"].includes(url.pathname)) {
        const body = await req.json();
        const sub = body && body.sub;
        if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint)) return json({ error: "bad subscription" }, 400, origin);
        const stub = env.TIMER.get(env.TIMER.idFromName(sub.endpoint));
        const r = await stub.fetch("https://do" + url.pathname, { method: "POST", body: JSON.stringify(body) });
        return json(await r.json(), r.status, origin);
      }
      if (url.pathname === "/") return json({ ok: true, service: "gym-buddy-push", kinds: ["rest", "idle"] }, 200, origin);
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, origin);
    }
  },
};

function keysStub(env) { return env.TIMER.get(env.TIMER.idFromName(KEYS_NAME)); }

export class RestTimer {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/keys") return Response.json(await this.getOrCreateKeys());
    const body = await req.json();
    const kind = body.kind === "idle" ? "idle" : "rest";
    if (path === "/schedule") {
      const cap = kind === "idle" ? 6 * 3600 * 1000 : 15 * 60 * 1000;
      const delay = Math.max(1000, Math.min(cap, Number(body.delayMs) || 0));
      await this.state.storage.put("sub", body.sub);
      const timers = await this.timers();
      timers[kind] = Date.now() + delay;
      await this.state.storage.put("timers", timers);
      await this.rearm(timers);
      return Response.json({ ok: true, at: timers[kind], kind });
    }
    if (path === "/cancel") {
      const timers = await this.timers();
      delete timers[kind];
      await this.state.storage.put("timers", timers);
      await this.rearm(timers);
      return Response.json({ ok: true, kind });
    }
    if (path === "/test") {
      const res = await sendPush(body.sub, await this.vapidKeys());
      return Response.json({ ok: res.ok, status: res.status });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  async timers() { return (await this.state.storage.get("timers")) || {}; }

  async rearm(timers) {
    const ats = Object.values(timers);
    if (ats.length) await this.state.storage.setAlarm(Math.min(...ats));
    else await this.state.storage.deleteAlarm();
  }

  async alarm() {
    const sub = await this.state.storage.get("sub");
    if (!sub) return;
    const stored = await this.state.storage.get("timers");
    let send = true;
    if (stored) {
      // Fire whatever is due now (one push even if both are), keep the rest armed.
      const now = Date.now();
      const due = Object.keys(stored).filter((k) => stored[k] <= now + 1500);
      due.forEach((k) => delete stored[k]);
      await this.state.storage.put("timers", stored);
      await this.rearm(stored);
      send = due.length > 0;
    } // no timers map: an alarm armed before the multi-timer version — just send it
    if (!send) return;
    const res = await sendPush(sub, await this.vapidKeys());
    // 404/410: the subscription is gone (permission revoked / app removed) — forget it.
    if (res.status === 404 || res.status === 410) await this.state.storage.delete("sub");
  }

  async vapidKeys() {
    const r = await keysStub(this.env).fetch("https://do/keys");
    return r.json();
  }

  async getOrCreateKeys() {
    let k = await this.state.storage.get("vapid");
    if (k) return k;
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    k = { privateJwk, publicB64: b64urlBytes(rawPub) };
    await this.state.storage.put("vapid", k);
    return k;
  }
}

async function sendPush(sub, keys) {
  const aud = new URL(sub.endpoint).origin;
  const enc = new TextEncoder();
  const header = b64urlBytes(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlBytes(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto ECDSA signatures are raw r||s (64 bytes), which is exactly the JWS ES256 format.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims)));
  const jwt = header + "." + claims + "." + b64urlBytes(sig);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: "vapid t=" + jwt + ", k=" + keys.publicB64, TTL: "120", Urgency: "high", "Content-Length": "0" },
  });
}

function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
