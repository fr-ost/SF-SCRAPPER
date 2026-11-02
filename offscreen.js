// Hidden offscreen document that keeps the scraping service worker alive.
// Chrome stops an MV3 service worker after ~30 s without events. A runtime message every
// 20 s is an event, so the worker never idles out. If Chrome still restarts the worker,
// the message wakes it again and the engine resumes from its saved state.
function ping() {
  try {
    chrome.runtime.sendMessage({ type: 'keepAlive' }, () => void chrome.runtime.lastError);
  } catch (e) { /* extension reloading */ }
}
ping();
setInterval(ping, 20000);
