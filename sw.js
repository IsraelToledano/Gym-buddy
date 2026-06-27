const CACHE = "gym-buddy-v1";
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Offline-first for the app shell; network for everything else (fonts, etc.)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).catch(() => cached))
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
