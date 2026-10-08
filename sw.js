// 공간제작소 관리자 — 서비스 워커 (웹 푸시 수신 + 알림 탭 처리)
// 캐시는 하지 않음: 화면은 항상 서버 최신 버전을 쓰고, 이 파일은 푸시만 담당
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || '공간제작소 관리자';
  const opts = {
    body: d.body || '',
    icon: 'favicon.png',
    badge: 'favicon.png',
    tag: d.tag || undefined,          // 같은 현장 알림은 하나로 묶임
    renotify: !!d.tag,
    data: { hash: d.hash || '#sites' },
    vibrate: d.call ? [200, 100, 200, 100, 200] : [120],
    requireInteraction: !!d.call,     // 호출은 사용자가 닫을 때까지 유지(지원 브라우저만)
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.hash) || '#sites';
  // 현장 알림으로 새로 열 때는 ?chat=1 → 좁은 화면이면 대화 칸으로 바로 이동
  const target = new URL('./' + (hash.startsWith('#site/') ? '?chat=1' : '') + hash, self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = list.find(c => new URL(c.url).origin === self.location.origin);
    if (mine) {
      await mine.focus();
      mine.postMessage({ type: 'open', hash });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
