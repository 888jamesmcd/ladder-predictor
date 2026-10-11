// Service worker: shows kick-off alerts pushed by the kickoff-push Supabase
// function, and opens the app when one is tapped. It caches nothing, so the
// app always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Ladder Predictor', {
    body: msg.body || '',
    tag: msg.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: self.registration.scope },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(url));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
