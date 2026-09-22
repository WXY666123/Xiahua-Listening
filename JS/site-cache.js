(function () {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  const root = new URL('../', document.currentScript.src);
  navigator.serviceWorker.register(new URL('sw.js', root), {scope: root.pathname})
    .catch(error => console.warn('题库离线缓存未就绪，仍可联网使用。', error));
}());
