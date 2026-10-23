// 浏览器调试模式（scripts/dev_server.py）：用 fetch 模拟 window.pywebview.api。
// 只在地址带 ?dev=1 时生效，正常运行（PyWebView）时什么都不做。
(function () {
  if (!new URLSearchParams(location.search).has('dev')) return;
  const api = new Proxy({}, {
    get: (_t, name) => (...args) =>
      fetch('/api/' + String(name), { method: 'POST', body: JSON.stringify(args) }).then((r) => r.json()),
  });
  window.pywebview = { api };
  setTimeout(() => window.dispatchEvent(new Event('pywebviewready')), 0);
})();
