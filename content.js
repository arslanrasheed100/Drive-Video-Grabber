'use strict';

/**
 * Reports the current Drive file's title + id to the background worker so
 * downloads get sensible filenames. Drive is an SPA, so we poll cheaply and
 * only send when something actually changed.
 */
(() => {
  const FILE_RE = /\/file\/d\/([-\w]{10,})/;
  let lastPayload = '';

  function report() {
    if (location.hostname !== 'drive.google.com') return;

    const m = location.pathname.match(FILE_RE);
    const title = document.title.replace(/\s*-\s*Google Drive\s*$/i, '').trim();

    const payload = {
      type: 'page-info',
      fileId: m ? m[1] : null,
      title: title || '',
      href: location.href.split('?')[0]
    };

    const key = JSON.stringify(payload);
    if (key === lastPayload) return;
    lastPayload = key;

    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (_) {
      /* extension context invalidated (reloaded), ignore */
    }
  }

  report();
  setInterval(report, 1200);
})();
