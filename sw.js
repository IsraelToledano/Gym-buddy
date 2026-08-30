const CACHE = "gym-buddy-v32";
const IMG_CACHE = "gym-buddy-exercise-img-v2";
const IMG_PATH = "/Gym-buddy/img/exercises/";
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k)))
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

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow("./index.html");
    })
  );
});
