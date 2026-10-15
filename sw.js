// 只为满足浏览器「可安装」的判定条件（Chrome 需要已注册且带 fetch 处理器的 service worker）。
// 刻意不缓存任何东西：fetch 处理器不调用 respondWith，请求照常走网络。
// 这样既能出现「添加到桌面」的安装提示，又不会出现页面/词库读到旧版本的问题。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
