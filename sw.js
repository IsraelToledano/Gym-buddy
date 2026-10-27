const CACHE = "gym-buddy-v127";
const IMG_CACHE = "gym-buddy-exercise-img-v2";
// Small notes the page leaves for the service worker (when the "still working
// out?" nudge is due, when the current rest ends). Kept across versions.
const META_CACHE = "gym-buddy-meta";
const IMG_PATH = "/Gym-buddy/img/exercises/";
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE && k !== META_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell: always try to fetch the latest index.html
// (and other shell assets) first, only falling back to the cache if the
// network request fails (offline). This is what makes updates show up
// reliably after a fresh deploy — a pure cache-first strategy would keep
// serving the old cached version until the next SW activate cycle.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  // Exercise photos are immutable and remote: cache-first, and keep them
  // in their own cache so an app-shell version bump doesn't force a
  // re-download of every image on the next gym session.
  const url = new URL(e.request.url);
  if (url.pathname.includes(IMG_PATH)) {
    e.respondWith(
      caches.open(IMG_CACHE).then((c) =>
        c.match(e.request).then((hit) => {
          if (hit) return hit;
          return fetch(e.request)
            .then((res) => {
              if (res && res.status === 200) c.put(e.request, res.clone());
              return res;
            })
            .catch(() => hit);
        })
      )
    );
    return;
  }

  // cache: "no-store" is required here — iOS's WKWebView disk cache for
  // Home Screen (standalone) PWAs is known to ignore standard Cache-Control
  // headers and can silently serve a stale cached response to a plain
  // fetch(), even though this handler is "network-first" in principle.
  // Explicitly bypassing HTTP cache is what actually guarantees a fresh
  // fetch on every load.
  e.respondWith(
    fetch(e.request,{cache:"no-store"})
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ---- Rest timer background alert ----
// The page posts a message with how many ms are left; we set a real timer
// here in the service worker context, which keeps running even if the page
// is backgrounded/screen-locked (subject to OS power management — Android
// Chrome installed PWAs and iOS Safari PWAs both generally honor this for
// short rest-timer durations).
let alertTimeout = null;

self.addEventListener("message", (e) => {
  const data = e.data || {};
  if (data.type === "schedule-rest-alert") {
    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => fireNotification(data.label), data.ms);
  } else if (data.type === "cancel-rest-alert") {
    if (alertTimeout) {
      clearTimeout(alertTimeout);
      alertTimeout = null;
    }
  }
});

function fireNotification(label) {
  self.registration.showNotification(label || "Rest is up", {
    body: "Time for your next set.",
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [120, 80, 120, 80, 200],
    tag: "rest-timer",
    renotify: true,
  });
  // Also tell any open page tabs, so the in-page beep/vibrate can fire too
  self.clients.matchAll().then((clients) => {
    clients.forEach((c) => c.postMessage({ type: "rest-alert-fired" }));
  });
}

// Web Push from the push worker. Pushes carry no payload, so which one this is
// comes from the notes the page left: a rest ending right now wins; otherwise,
// if the "still working out?" nudge is due, it's that one.
async function readMeta(key) {
  try { const c = await caches.open(META_CACHE); const r = await c.match(key); return r ? await r.json() : null; } catch (e) { return null; }
}
async function pushKind() {
  const now = Date.now();
  const rest = await readMeta("/__rest");
  if (rest && rest.restAt && Math.abs(now - rest.restAt) < 90000) return { type: "rest" };
  const idle = await readMeta("/__idle");
  if (idle && idle.idleAt && now >= idle.idleAt - 120000 && now <= idle.idleAt + 6 * 3600000) return Object.assign({ type: "idle" }, idle);
  return { type: "rest" };
}
self.addEventListener("push", (e) => {
  e.waitUntil(
    pushKind().then((k) => {
      if (k.type === "idle")
        return self.registration.showNotification("Still working out?", {
          body: `Nothing logged since ${k.lastLabel || "a while"}. Tap to finish — the workout will end at ${k.endLabel || "your last set + 5 min"}.`,
          icon: "icon-192.png",
          badge: "icon-192.png",
          tag: "idle-nudge",
          renotify: true,
        });
      return self.registration.showNotification("Rest is up 💪", {
        body: "Time for your next set.",
        icon: "icon-192.png",
        badge: "icon-192.png",
        tag: "rest-timer",
        renotify: true,
      });
    })
  );
});

// iOS/Android can rotate a push subscription at any time. Without this the
// app keeps posting a dead subscription to the push worker forever and the
// rest alert silently stops arriving. Tell any open page so it re-registers.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    self.clients.matchAll().then((clients) => {
      clients.forEach((c) => c.postMessage({ type: "push-sub-changed" }));
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow("./index.html");
    })
  );
});
