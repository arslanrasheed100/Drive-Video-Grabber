'use strict';

/* Shared link parsing. The service worker is classic, not a module. */
importScripts('link.js');

/**
 * Drive Video Grabber background service worker
 *
 * Job: watch network traffic for Google Drive `videoplayback` requests, keep one
 * entry per (kind, itag) stream, and store a *cleaned* URL that makes the server
 * return the whole file instead of a 1 MB byte range.
 *
 * Clean = two steps, pure string surgery so Google's signature stays valid:
 *   1. delete the `range` param
 *   2. cut everything after the word `ump` (the `&ump` itself is kept)
 *
 * The sample URL ends like:
 *   ...&cver=1.2026...&range=17455670-17940474&rn=35&rbuf=61296&ump=1&srfvp=1
 * and becomes:
 *   ...&cver=1.2026...&rn=35&rbuf=61296&ump
 *
 * Everything else is preserved verbatim.
 */

/** Params deleted outright. */
const STRIP_PARAMS = ['range'];

/** Everything from the first occurrence of this anchor onward is dropped,
 *  but the anchor itself is kept:
 *    "...&range=1-2&rn=35&rbuf=61296&ump=1&srfvp=1"  ->  "...&rn=35&rbuf=61296&ump"
 */
const CUT_ANCHOR = '&ump';

const MAX_STREAMS_PER_TAB = 60;
const STORAGE_KEY = 'grabberState';
const DL_KEY = 'grabberDownloads';
const RECOVER_KEY = 'grabberRecovered';

const ITAG_LABELS = {
  // video (muxed)
  18: '360p', 22: '720p', 37: '1080p', 59: '480p', 78: '480p',
  // video (adaptive, mp4)
  160: '144p', 133: '240p', 134: '360p', 135: '480p', 136: '720p', 137: '1080p',
  264: '1440p', 266: '2160p', 298: '720p60', 299: '1080p60',
  // video (adaptive, webm)
  242: '240p', 243: '360p', 244: '480p', 247: '720p', 248: '1080p',
  // audio
  139: '48k AAC', 140: '128k AAC', 141: '256k AAC',
  249: '50k Opus', 250: '70k Opus', 251: '160k Opus',
  256: '192k AAC', 258: '384k AAC'
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let state = { tabs: {} };
let saveTimer = null;
let ownDownloads = {}; // download id -> { url, filename, expectedSize, tries, handled }
let recoveredIds = {}; // old download id -> the id that replaced it
const pendingBlobNames = new Map(); // blob URL -> filename the merge page wants

const ready = (async () => {
  try {
    const got = await chrome.storage.session.get([STORAGE_KEY, DL_KEY, RECOVER_KEY]);
    if (got && got[STORAGE_KEY]) state = got[STORAGE_KEY];
    if (got && got[DL_KEY]) ownDownloads = got[DL_KEY];
    if (got && got[RECOVER_KEY]) recoveredIds = got[RECOVER_KEY];
  } catch (_) {
    /* storage.session unavailable, keeping state in memory only */
  }
})();

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ [STORAGE_KEY]: state }).catch(() => {});
  }, 150);
}

function bump(tabId) {
  scheduleSave();
  chrome.runtime
    .sendMessage({ type: 'streams-updated', tabId })
    .catch(() => {}); /* no popup open, ignore */
}

function updateBadge(tabId) {
  const tab = state.tabs[tabId];
  const n = tab ? Object.keys(tab.streams).length : 0;
  try {
    chrome.action.setBadgeText({ tabId, text: n ? (n > 9 ? '9+' : String(n)) : '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2b7cff' }).catch(() => {});
  } catch (_) {
    /* tab already closed */
  }
}

/* ------------------------------------------------------------------ */
/* url helpers                                                         */
/* ------------------------------------------------------------------ */

/** Read a query param without round-tripping through URL() (avoids re-encoding). */
function paramOf(url, name) {
  const m = url.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return m ? m[1] : null;
}

/**
 * Drop the byte-range params, then cut everything after the anchor word.
 * Pure string surgery: no URL() round-trip, so Google's sig/lsig stay identical.
 */
function cleanUrl(raw, strip = STRIP_PARAMS, anchor = CUT_ANCHOR) {
  let url = raw;

  for (const p of strip) {
    // keep the "?" if the param happened to be first
    url = url.replace(new RegExp('[?&]' + p + '=[^&]*', 'g'), (m) => (m[0] === '?' ? '?' : ''));
  }

  const i = anchor ? url.indexOf(anchor) : -1;
  if (i !== -1) url = url.slice(0, i + anchor.length);

  // if the stripped param was first, we may be left with "?&"
  return url.replace('?&', '?');
}

function extFor(kind, mime) {
  if (/webm/.test(mime)) return 'webm';
  if (kind === 'audio') return /mpeg/.test(mime) ? 'mp3' : 'm4a';
  return 'mp4';
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

function handleRequest(details) {
  const { url, tabId } = details;
  if (tabId < 0 || !url || url.indexOf('videoplayback') === -1) return;

  const mime = paramOf(url, 'mime') || '';
  let kind = null;
  if (mime.indexOf('audio') === 0) kind = 'audio';
  else if (mime.indexOf('video') === 0) kind = 'video';
  if (!kind) return;

  const itag = paramOf(url, 'itag') || '?';
  const clen = Number(paramOf(url, 'clen')) || null;

  const tab = state.tabs[tabId] || (state.tabs[tabId] = { title: '', fileId: null, streams: {} });

  const key = `${kind}:${itag}:${clen || 'na'}`;
  const now = Date.now();
  const existing = tab.streams[key];

  if (existing) {
    existing.lastSeen = now;
    existing.hits += 1;

    /* Drive re-signs the URL on almost every request and the signature expires
       after roughly 15 minutes. Keeping the first URL means a long playback
       session ends up with dead links, while a stream that was requested a
       moment ago still works. Always keep the freshest one. */
    const fresh = cleanUrl(url);
    if (fresh !== existing.cleanUrl) {
      existing.cleanUrl = fresh;
      existing.rawUrl = url;
      existing.mime = mime;
      existing.ext = extFor(kind, mime);
      if (clen) existing.size = clen;
      scheduleSave();
    }

    return; /* no popup bump, the list has not changed */
  }

  if (Object.keys(tab.streams).length >= MAX_STREAMS_PER_TAB) return;

  tab.streams[key] = {
    key,
    kind,
    itag,
    label: ITAG_LABELS[itag] || `${kind} ${itag}`,
    size: clen,
    ext: extFor(kind, mime),
    mime,
    fileId: paramOf(url, 'driveid') || paramOf(url, 'id'),
    cleanUrl: cleanUrl(url),
    rawUrl: url,
    firstSeen: now,
    lastSeen: now,
    hits: 1
  };

  updateBadge(tabId);
  bump(tabId);
}

function relayPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* downloads                                                           */
/*                                                                     */
/* Drive sometimes answers a media request with a tiny text page that  */
/* contains the real link (quota / expired signature / anti-bot page). */
/* chrome.downloads then saves a .txt instead of the video. We detect  */
/* that, follow the link, and remove the junk file.                    */
/* ------------------------------------------------------------------ */

const MAX_TRACKED_DOWNLOADS = 40;

/* Guard against a runaway text-page loop: automatic recoveries are cheap but
   must never turn into an endless stream of downloads in the shelf. */
const RECOVER_WINDOW_MS = 60000;
const recoverBudget = { start: 0, count: 0 };

function allowAutoRecover() {
  const now = Date.now();
  if (now - recoverBudget.start > RECOVER_WINDOW_MS) {
    recoverBudget.start = now;
    recoverBudget.count = 0;
  }
  recoverBudget.count += 1;
  return recoverBudget.count <= 4;
}

/**
 * Cheap "will this URL actually download?" probe for the popup: ask for the
 * first two bytes and look at the answer. Text pages and 403s mean the signed
 * link is gone, a 200/206 with a media type means the URL is still good.
 *
 * A fetch from the worker can fail for reasons that have nothing to do with the
 * link (blocked redirect, a Range request the CDN dislikes, a suspended worker),
 * so a plain request is tried as a fallback and a total failure is reported as
 * "unverified" instead of scaring the user away from a working URL.
 */
async function probeOnce(url, credentials, withRange) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 8000);

  try {
    const options = { credentials, cache: 'no-store', signal: ctl.signal };
    if (withRange) options.headers = { Range: 'bytes=0-1' };

    const res = await fetch(url, options);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const texty = type.startsWith('text/') || type.includes('html') || type.includes('json');
    cancelBody(res);

    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, reason: 'denied' };
    if (!res.ok && res.status !== 206) return { ok: false, status: res.status, reason: 'http' };
    if (texty) return { ok: false, status: res.status, reason: 'text' };

    return { ok: true, status: res.status, type };
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    console.warn('[grabber] probe failed', withRange ? 'range' : 'plain', e && e.message ? e.message : e);
    return { ok: false, status: 0, reason: timeout ? 'timeout' : 'unverified' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeUrl(url) {
  const plans = [
    { credentials: 'include', range: true },
    { credentials: 'omit', range: true },
    { credentials: 'omit', range: false }
  ];

  let last = { ok: false, status: 0, reason: 'unverified' };

  for (const plan of plans) {
    last = await probeOnce(url, plan.credentials, plan.range);

    /* definitive answers: no point in asking a second time */
    if (last.ok || last.reason === 'denied' || last.reason === 'text' || last.reason === 'http') {
      return last;
    }
  }

  return last;
}

function persistDownloads() {
  chrome.storage.session.set({ [DL_KEY]: ownDownloads }).catch(() => {});
}

/**
 * Remember that a download id was replaced by a recovered one. The merge page
 * can be opened before the recovery finishes, so it reads this map on load in
 * case it missed the live message.
 */
function rememberRecovery(oldId, newId) {
  recoveredIds[oldId] = newId;

  const ids = Object.keys(recoveredIds);
  if (ids.length > 40) delete recoveredIds[ids[0]];

  chrome.storage.session.set({ [RECOVER_KEY]: recoveredIds }).catch(() => {});
}

function trackDownload(id, info) {
  ownDownloads[id] = info;

  const ids = Object.keys(ownDownloads);
  if (ids.length > MAX_TRACKED_DOWNLOADS) {
    delete ownDownloads[ids[0]];
  }

  persistDownloads();
}

async function startDownload(url, filename, expectedSize, tries = 0) {
  let target = url;
  let count = tries || 0;

  /* Look before downloading. If Drive is about to answer with a text page,
     follow the link inside it now so the junk file normally never lands in
     Downloads. */
  const pre = await inspectUrl(url, 7000, ['include'], true);

  if (pre.texty) {
    if (pre.link && count < 2) {
      target = pre.link;
      count += 1;
      console.info('[grabber] preflight followed a text page link', filename);
      relayPopup({ type: 'toast', text: 'Drive sent a text page, following the real link.' });
    } else {
      throw new Error(
        pre.link
          ? 'Drive keeps returning a text page. Reload the Drive tab, press play, then try again'
          : 'Drive returned a text page with no download link. Reload the Drive tab, press play, then try again'
      );
    }
  }

  const id = await chrome.downloads.download({
    url: target,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  trackDownload(id, {
    url: target,
    filename,
    expectedSize: expectedSize || 0,
    tries: count,
    handled: false
  });

  /* A tiny text page can finish before the id is tracked, so its "complete"
     event is missed. Check the item once now that tracking is in place. */
  chrome.downloads
    .search({ id })
    .then(([item]) => {
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        inspectDownload(id).catch(() => {});
      }
    })
    .catch(() => {});

  return id;
}

/** Did Chrome save a text / html page instead of the media file? */
function looksTexty(item) {
  const mime = (item.mime || '').toLowerCase();
  const name = (item.filename || '').toLowerCase();
  return mime.startsWith('text/') || /\.(txt|html?)$/.test(name);
}

/**
 * Cancel a response body without throwing on an already locked or closed stream.
 */
function cancelBody(res) {
  try {
    if (!res || !res.body) return;
    const p = res.body.cancel();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    /* stream already locked or closed */
  }
}

/**
 * Read at most `limit` bytes from a response and decode them as text. This keeps
 * a mislabelled large file from being pulled into memory just to look for a link.
 */
async function readTextCapped(res, limit = 65536) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    return (await res.text()).slice(0, limit);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      /* already closed */
    }
    try {
      reader.releaseLock();
    } catch (_) {
      /* still locked */
    }
  }

  const buf = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, buf.length - at);
    buf.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= buf.length) break;
  }

  return new TextDecoder().decode(buf);
}

/**
 * Re-ask the URL what it is. Only reads the body when the response is text,
 * otherwise it cancels the stream straight away so a video is never pulled twice.
 * `forceText` also sniffs small unknown bodies, for a text page served as
 * application/octet-stream.
 */
async function inspectUrl(
  url,
  timeoutMs = 12000,
  plans = ['include', 'omit'],
  forceText = false,
  sniffMedia = false
) {
  let sawText = false;

  /* Some Drive pages need the browser cookies, others do not. Try the normal
     request first, then a cookie-free one, and never hang forever on a CDN. */
  for (const credentials of plans) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);

    try {
      const res = await fetch(url, { credentials, cache: 'no-store', signal: ctl.signal });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const texty = type.startsWith('text/') || type.includes('html') || type.includes('json');
      const mediaType = type.startsWith('video/') || type.startsWith('audio/');

      if (!texty) {
        if (forceText && (!mediaType || sniffMedia)) {
          const text = await readTextCapped(res);
          const found = linkFromText(text, url);
          const link = found && looksMediaLink(found) ? found : null;
          if (link) return { texty: true, link };
        }
        cancelBody(res);
        return { texty: false, link: null };
      }

      sawText = true;
      const text = await readTextCapped(res);
      const found = linkFromText(text, url);
      const link = found && looksMediaLink(found) ? found : null;
      if (link || credentials === 'omit') return { texty: true, link };
    } catch (e) {
      console.warn('[grabber] inspect fetch failed', credentials, e && e.message ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }

  return { texty: sawText, link: null };
}

async function dropDownload(id) {
  try {
    await chrome.downloads.cancel(id);
  } catch (_) {
    /* already finished */
  }
  try {
    await chrome.downloads.removeFile(id);
  } catch (_) {
    /* nothing on disk */
  }
  try {
    await chrome.downloads.erase({ id });
  } catch (_) {
    /* already gone */
  }
}

async function inspectDownload(id) {
  const info = ownDownloads[id];
  if (!info || info.handled) return;

  info.handled = true;
  persistDownloads();

  let item = null;
  try {
    [item] = await chrome.downloads.search({ id });
  } catch (_) {
    return;
  }
  if (!item) return;

  const expected = info.expectedSize || 0;
  const got = item.fileSize || 0;
  const interrupted = item.state === 'interrupted';
  const tiny = got > 0 && got < 16384;
  const sizeJunk = expected > 262144 && got < 65536;
  const textyItem = looksTexty(item);
  const suspicious = interrupted || textyItem || sizeJunk || (expected === 0 && tiny);

  if (!suspicious) {
    delete ownDownloads[id];
    persistDownloads();
    return;
  }

  console.info(
    '[grabber] checking suspicious download',
    info.filename,
    'size=' + got,
    'expected=' + expected,
    'mime=' + (item.mime || 'none'),
    'state=' + item.state
  );

  const page = await inspectUrl(
    info.url,
    12000,
    ['include', 'omit'],
    textyItem || sizeJunk,
    textyItem
  );

  /* not a text page after all, leave a complete file alone */
  if (!interrupted && !page.texty && !textyItem && !sizeJunk) {
    console.info('[grabber] download looks fine after all', info.filename);
    delete ownDownloads[id];
    persistDownloads();
    return;
  }

  if (!page.link || !looksMediaLink(page.link) || info.tries >= 2) {
    /* the page is junk, keeping it only confuses the Downloads folder */
    console.warn('[grabber] no usable link for', info.filename, 'texty=' + page.texty);
    await dropDownload(id);
    delete ownDownloads[id];
    persistDownloads();
    relayPopup({
      type: 'toast',
      text: interrupted
        ? 'The download was interrupted. Reload the Drive tab, press play, then try again right away.'
        : 'The link expired. Reload the Drive tab, press play, then download again right away.'
    });
    return;
  }

  if (!allowAutoRecover()) {
    await dropDownload(id);
    delete ownDownloads[id];
    persistDownloads();
    relayPopup({
      type: 'toast',
      text: 'Stopped a text-page loop. Replay the video, then download again.'
    });
    return;
  }

  await dropDownload(id);
  delete ownDownloads[id];

  console.info('[grabber] text page recovery', info.filename);

  try {
    const newId = await startDownload(page.link, info.filename, 0, (info.tries || 0) + 1);
    rememberRecovery(id, newId);
    relayPopup({ type: 'toast', text: 'Drive sent a text page, following the real link.' });
    relayPopup({ type: 'download-recovered', oldId: id, newId, filename: info.filename });
  } catch (e) {
    console.warn('[grabber] recovery download failed', e && e.message ? e.message : e);
    relayPopup({ type: 'toast', text: 'Could not start the recovered download.' });
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state) return;

  const phase = delta.state.current;
  if (phase !== 'complete' && phase !== 'interrupted') return;

  /* This event can wake the worker before storage has restored ownDownloads. */
  ready.then(() => {
    if (!ownDownloads[delta.id]) return;
    inspectDownload(delta.id).catch((e) => {
      console.warn('[grabber] inspect failed', e && e.message ? e.message : e);
    });
  });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = pendingBlobNames.get(item.url);
  if (!wanted) {
    suggest();
    return;
  }

  pendingBlobNames.delete(item.url);
  suggest({ filename: wanted, conflictAction: 'uniquify' });
});

/* ------------------------------------------------------------------ */
/* listeners                                                           */
/* ------------------------------------------------------------------ */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      try {
        handleRequest(details);
      } catch (e) {
        console.warn('[grabber] capture error', e);
      }
    });
  },
  {
    urls: [
      'https://*.drive.google.com/*',
      'https://*.googleusercontent.com/*',
      'https://*.googlevideo.com/*',
      'https://drive.google.com/*'
    ]
  }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'page-info' && sender.tab) {
    ready.then(() => {
      const id = sender.tab.id;
      const tab = state.tabs[id] || (state.tabs[id] = { title: '', fileId: null, streams: {} });
      if (msg.title) tab.title = msg.title;
      if (msg.fileId) tab.fileId = msg.fileId;
      if (msg.href) tab.href = msg.href;
      scheduleSave();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'get-state') {
    ready.then(() => {
      sendResponse({ tab: state.tabs[msg.tabId] || null });
    });
    return true;
  }

  if (msg.type === 'download') {
    ready.then(async () => {
      try {
        const id = await startDownload(msg.url, msg.filename, msg.expectedSize);
        sendResponse({ ok: true, id });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
    return true;
  }

  /* the merge page names its blob download here, so the filename is forced
     even when Chrome wants to derive a name from the blob URL */
  if (msg.type === 'name-blob' && msg.url && msg.filename) {
    pendingBlobNames.set(msg.url, msg.filename);
    setTimeout(() => pendingBlobNames.delete(msg.url), 120000);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'probe-url') {
    probeUrl(msg.url)
      .then((res) => {
        try {
          sendResponse(res);
        } catch (_) {
          /* popup closed */
        }
      })
      .catch((e) => {
        try {
          sendResponse({ ok: false, status: 0, reason: e && e.message ? e.message : 'error' });
        } catch (_) {
          /* popup closed */
        }
      });
    return true;
  }

  if (msg.type === 'clear-tab') {
    ready.then(() => {
      delete state.tabs[msg.tabId];
      updateBadge(msg.tabId);
      scheduleSave();
      sendResponse({ ok: true });
    });
    return true;
  }

  return;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    if (state.tabs[tabId]) {
      delete state.tabs[tabId];
      scheduleSave();
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#2b7cff' });
});

/* expose for the popup's manual-paste box */
globalThis.__grabberCleanUrl = cleanUrl;
