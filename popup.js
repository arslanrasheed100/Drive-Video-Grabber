'use strict';

const STRIP_PARAMS = ['range'];
const CUT_ANCHOR = '&ump';

/** muxed itags already contain audio, no merge needed */
const MUXED_ITAGS = new Set(['18', '22', '37', '59', '78']);

const els = {
  list: document.getElementById('list'),
  meta: document.getElementById('meta'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  paste: document.getElementById('paste'),
  cleaned: document.getElementById('cleaned'),
  cleanBtn: document.getElementById('cleanBtn'),
  dlBtn: document.getElementById('dlBtn'),
  pasteHelp: document.getElementById('pasteHelp'),
  pasteHelpBtn: document.getElementById('pasteHelpBtn'),
  mergeBtn: document.getElementById('mergeBtn'),
  localBtn: document.getElementById('localBtn'),
  clearBtn: document.getElementById('clearBtn'),
  hint: document.getElementById('hint')
};

let tabId = null;
let tabInfo = null;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function cleanUrl(raw, strip = STRIP_PARAMS, anchor = CUT_ANCHOR) {
  let url = raw;

  for (const p of strip) {
    url = url.replace(new RegExp('[?&]' + p + '=[^&]*', 'g'), (m) => (m[0] === '?' ? '?' : ''));
  }

  const i = anchor ? url.indexOf(anchor) : -1;
  if (i !== -1) url = url.slice(0, i + anchor.length);

  return url.replace('?&', '?');
}

function paramOf(url, name) {
  const m = url.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return m ? m[1] : null;
}

function fmtSize(bytes) {
  if (!bytes) return 'unknown size';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

/* Drive signs each stream URL and the signature dies after a few minutes, so
   the age of the last capture is the best hint we have before a download. */
const STALE_LINK_MS = 10 * 60 * 1000;

function linkAge(stream) {
  return stream && stream.lastSeen ? Date.now() - stream.lastSeen : Infinity;
}

function isStale(stream) {
  return linkAge(stream) > STALE_LINK_MS;
}

function ageText(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + ' h';
}

function ageLabel(stream) {
  const ms = linkAge(stream);
  return Number.isFinite(ms) ? ageText(ms) + ' ago' : '';
}

/* ------------------------------------------------------------------ */
/* link check (hover / on open)                                        */
/* ------------------------------------------------------------------ */

const probeCache = new Map(); // stream key -> { url, at, result }
const PROBE_TTL_MS = 60000;

function probeLabel(res) {
  if (!res) return 'Could not check this link.';
  if (res.ok) return 'Link looks good, the download should start.';
  if (res.reason === 'denied') {
    return 'Drive answered ' + res.status + '. The link expired, reload the Drive tab and press play.';
  }
  if (res.reason === 'text') {
    return 'Drive returned a text page instead of the video. The extension will try to follow the link inside it. If that fails, replay the video.';
  }
  if (res.reason === 'timeout') return 'Drive did not answer in time, so this is unverified. Try the download anyway.';
  if (res.reason === 'unverified' || res.reason === 'network') {
    return 'Could not verify this link (network or a blocked redirect). The download may still work.';
  }
  if (res.status) return 'Drive answered HTTP ' + res.status + '. The link is probably dead.';
  return 'Could not check this link.';
}

function paintDot(dot, qualityEl, stateEl, res) {
  const good = !!(res && res.ok);
  const unknown = !good && !!res && (res.reason === 'unverified' || res.reason === 'network' || res.reason === 'timeout');

  dot.className = 'dot ' + (good ? 'ok' : unknown ? 'unknown' : 'bad');
  dot.title = probeLabel(res);
  if (qualityEl) qualityEl.title = probeLabel(res);
  if (!stateEl) return;

  if (good) {
    stateEl.className = 'linkstate';
    stateEl.textContent = '';
  } else if (unknown) {
    stateEl.className = 'linkstate unknown';
    stateEl.textContent = 'unverified';
  } else {
    stateEl.className = 'linkstate bad';
    stateEl.textContent = res && res.reason === 'text' ? 'text page' : 'expired';
  }
}

/**
 * Last resort: if the worker could not verify the link (blocked redirect,
 * suspended worker), try once from the popup itself. A 403 here is reported as
 * unverified, never as expired, because cookies can differ from the download
 * request and a false alarm is worse than no answer.
 */
async function probeHere(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 8000);

  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const texty = type.startsWith('text/') || type.includes('html') || type.includes('json');
    if (res.body) res.body.cancel().catch(() => {});

    if (texty) return { ok: false, status: res.status, reason: 'text' };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, reason: 'unverified' };
    if (!res.ok && res.status !== 206) return { ok: false, status: res.status, reason: 'unverified' };

    return { ok: true, status: res.status, type };
  } catch (_) {
    return { ok: false, status: 0, reason: 'unverified' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeStream(stream, dot, qualityEl, stateEl) {
  const cached = probeCache.get(stream.key);
  if (cached && cached.url === stream.cleanUrl && Date.now() - cached.at < PROBE_TTL_MS) {
    paintDot(dot, qualityEl, stateEl, cached.result);
    return;
  }

  dot.className = 'dot wait';
  dot.title = 'Checking this link...';
  if (stateEl) {
    stateEl.className = 'linkstate wait';
    stateEl.textContent = 'checking';
  }

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'probe-url', url: stream.cleanUrl });
  } catch (e) {
    console.warn('[grabber] probe message failed', e && e.message ? e.message : e);
    res = null;
  }

  if (!res || typeof res !== 'object') res = { ok: false, reason: 'unverified' };

  if (!res.ok && (res.reason === 'unverified' || res.reason === 'network' || res.reason === 'timeout')) {
    const local = await probeHere(stream.cleanUrl);
    if (local.ok || local.reason === 'text') res = local;
  }

  probeCache.set(stream.key, { url: stream.cleanUrl, at: Date.now(), result: res });
  paintDot(dot, qualityEl, stateEl, res);
}

function knownDead(stream) {
  const cached = probeCache.get(stream.key);
  if (!cached || cached.url !== stream.cleanUrl) return false;
  if (Date.now() - cached.at > PROBE_TTL_MS) return false;
  const r = cached.result;
  return !!r && !r.ok && r.reason === 'denied';
}

function sanitize(name) {
  const out = (name || 'drive-video')
    .replace(/\.(mp4|mkv|mov|webm|avi|m4v)$/i, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 80)
    .replace(/[.\s]+$/g, '')
    .trim();

  if (!out || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) return 'drive-video';
  return out;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}

function setStatus(text, kind, pct) {
  if (!text) {
    els.status.hidden = true;
    els.bar.hidden = true;
    return;
  }

  els.status.hidden = false;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;

  if (typeof pct === 'number') {
    els.bar.hidden = false;
    els.barFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  } else {
    els.bar.hidden = true;
    els.barFill.style.width = '0%';
  }
}

/* ------------------------------------------------------------------ */
/* downloading                                                         */
/* ------------------------------------------------------------------ */

async function download(url, kind, label, ext, quiet, size) {
  const base = sanitize(tabInfo && tabInfo.title);
  const suffix = kind === 'audio' ? 'audio' : 'video';
  const filename = `DriveGrabber/${base} [${suffix} ${label}].${ext || 'mp4'}`;

  try {
    /* the worker starts the download so it can spot the text pages Drive
       sometimes returns and follow the real link inside them */
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      url,
      filename,
      expectedSize: size || 0
    });

    if (!res || !res.ok) throw new Error((res && res.error) || 'download failed');
    if (!quiet) toast('Saved to Downloads/DriveGrabber');
    return { ok: true, id: res.id };
  } catch (e) {
    const error = e && e.message ? e.message : 'unknown';
    toast('Download failed: ' + error);
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

function bestOf(streams, kind) {
  return streams
    .filter((s) => s.kind === kind)
    .sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
}

/**
 * Best stream that also fits an MP4 container. Drive often serves the same
 * quality twice (H.264 mp4 + VP9 webm); MP4 remuxes cleanly, so prefer it and
 * only fall back to WebM when there is nothing else.
 */
function pickForMerge(streams, kind) {
  const list = streams.filter((s) => s.kind === kind);
  if (!list.length) return null;

  const compatible = list.filter((s) => (kind === 'audio' ? s.ext === 'm4a' : s.ext === 'mp4'));
  const pool = compatible.length ? compatible : list;

  return pool.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

/** Open the merge page. Download ids let the page follow native progress. */
async function openMergePage(opts = {}) {
  const title = sanitize(tabInfo && tabInfo.title);
  const q = new URLSearchParams({ title });
  if (opts.videoId) q.set('videoId', String(opts.videoId));
  if (opts.audioId) q.set('audioId', String(opts.audioId));

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('merge.html?' + q.toString())
    });
  } catch (e) {
    els.mergeBtn.disabled = false;
    setStatus('Could not open the merge page: ' + (e && e.message ? e.message : 'unknown'), 'error');
    return;
  }

  window.close();
}

/**
 * Both tracks go through Chrome's own downloader (C++ and straight to disk),
 * because that is far faster than pulling them through JS and WASM memory.
 * The merge page then remuxes the two local files into one.
 */
async function merge() {
  const streams = tabInfo && tabInfo.streams ? Object.values(tabInfo.streams) : [];
  const v = pickForMerge(streams, 'video');
  const a = pickForMerge(streams, 'audio');

  if (!v) {
    toast('No video stream yet, play the video longer');
    return;
  }

  if (MUXED_ITAGS.has(String(v.itag))) {
    toast('That stream already has audio');
    await download(v.cleanUrl, 'video', v.label.replace(/\s+/g, ' '), v.ext);
    return;
  }

  if (!a) {
    toast('No audio stream captured yet');
    return;
  }

  /* an old signature fails halfway through, better to stop before the wait */
  const oldest = Math.max(linkAge(v), linkAge(a));
  if (oldest > STALE_LINK_MS) {
    setStatus(
      'These links were captured about ' +
        ageText(oldest) +
        ' ago and Drive signatures expire after a few minutes. Reload the Drive tab, press play for a few seconds, then try again right away.',
      'error'
    );
    return;
  }

  els.mergeBtn.disabled = true;
  setStatus('Starting both downloads with Chrome…', 'busy');

  const [rv, ra] = await Promise.all([
    download(v.cleanUrl, 'video', v.label.replace(/\s+/g, ' '), v.ext, true, v.size),
    download(a.cleanUrl, 'audio', a.label.replace(/\s+/g, ' '), a.ext, true, a.size)
  ]);

  if (!rv.ok || !ra.ok) {
    els.mergeBtn.disabled = false;
    setStatus(
      'Could not start the downloads: ' + (rv.error || ra.error || 'unknown') + '. Reload the Drive tab and try again.',
      'error'
    );
    return;
  }

  setStatus('Both tracks are downloading with Chrome. Opening the merge page…', 'busy');
  await openMergePage({ videoId: rv.id, audioId: ra.id });
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

let lastListSig = '';

function render(tab) {
  tabInfo = tab;

  const streams = tab && tab.streams ? Object.values(tab.streams) : [];
  const vBest = bestOf(streams, 'video');
  const aBest = bestOf(streams, 'audio');
  const canMerge = !!(vBest && aBest);

  els.meta.textContent = streams.length
    ? (tab.title || 'untitled') + ' · ' + streams.length + ' stream' + (streams.length === 1 ? '' : 's')
    : 'no streams yet';

  /* rebuild the cards only when the capture actually changed, so the 1.5 s
     refresh poll can't yank the list out from under the cursor */
  const sig = streams.map((s) => s.key + ':' + (s.size || 0)).join('|') + '#' + (canMerge ? 1 : 0);

  if (sig !== lastListSig) {
    lastListSig = sig;
    setStatus('');
    els.list.textContent = '';

    if (!streams.length) {
      const empty = el('div', 'empty');
      empty.append(
        el('div', null, 'Open a Drive video and press play.'),
        el('div', null, 'Streams appear here as the player requests them.')
      );
      els.list.appendChild(empty);
    } else {
      const ordered = [...streams].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
        return (b.size || 0) - (a.size || 0);
      });

      const dots = new Map();

      for (const s of ordered) {
        const isBest =
          (s.kind === 'video' && vBest && s.key === vBest.key) ||
          (s.kind === 'audio' && aBest && s.key === aBest.key);

        const card = el('div', 'card' + (isBest ? ' best' : ''));
        const head = el('div', 'card-head');

        const dot = el('span', 'dot');
        dot.title = 'Hover to check this link';

        const quality = el('span', 'quality', s.label);
        quality.title = 'Hover to check this link';

        const state = el('span', 'linkstate', '');

        const stale = isStale(s);
        const sub = el(
          'span',
          'sub' + (stale ? ' stale' : ''),
          'itag ' + s.itag + ' · ' + fmtSize(s.size) + (stale ? ' · ' + ageLabel(s) : '')
        );
        sub.title = stale
          ? 'Captured ' + ageLabel(s) + '. Drive links expire quickly, replay the video for a fresh one.'
          : 'Captured ' + ageLabel(s);

        head.append(el('span', 'tag ' + s.kind, s.kind));
        if (s.kind === 'video' && !MUXED_ITAGS.has(String(s.itag))) {
          const noAudio = el('span', 'noaudio', '(no audio)');
          noAudio.title = 'This video track has no sound. Merge it with the audio track to add audio.';
          head.append(noAudio);
        }
        head.append(dot, quality, state, sub);
        card.appendChild(head);

        dots.set(s.key, { dot, quality, state });

        /* a quick check when the pointer touches a stream, so the answer is
           already there before the Download click */
        card.addEventListener('mouseenter', () => probeStream(s, dot, quality, state));

        const actions = el('div', 'actions');

        const dl = el('button', 'primary', 'Download');
        dl.addEventListener('click', () => {
          if (knownDead(s)) {
            toast('This link is dead. Reload the Drive tab, press play, then download again.');
            return;
          }
          download(s.cleanUrl, s.kind, s.label.replace(/\s+/g, ' '), s.ext, false, s.size);
        });

        const cp = el('button', 'ghost', 'Copy URL');
        cp.addEventListener('click', async () => {
          await navigator.clipboard.writeText(s.cleanUrl);
          toast('URL copied');
        });

        actions.append(dl, cp);
        card.appendChild(actions);
        els.list.appendChild(card);
      }

      /* check the two streams a merge would use, without any hover */
      for (const s of [vBest, aBest]) {
        const slot = s && dots.get(s.key);
        if (slot) probeStream(s, slot.dot, slot.quality, slot.state);
      }
    }
  }

  els.mergeBtn.disabled = !canMerge;
  updateHint();
}

/**
 * Hint under the stream list. The primary button now downloads both tracks
 * with Chrome's downloader and hands them to the merge page, so say that
 * plainly instead of recommending a separate manual path.
 */
function updateHint() {
  const streams = tabInfo && tabInfo.streams ? Object.values(tabInfo.streams) : [];
  const vBest = bestOf(streams, 'video');
  const aBest = bestOf(streams, 'audio');

  if (!vBest || !aBest) {
    els.hint.hidden = true;
    return;
  }

  if (isStale(vBest) || isStale(aBest)) {
    els.hint.classList.add('warn');
    els.hint.innerHTML =
      'These links were captured a while ago and Drive signatures expire after a few minutes. Reload the Drive tab, press play for a few seconds, then try again right away.';
    els.hint.hidden = false;
    return;
  }

  els.hint.classList.remove('warn');
  els.hint.innerHTML =
    'Click <b>Merge video + audio</b> to download both tracks with Chrome at full speed. The merge page opens and you pick both files there. Already have them? Use <b>Merge local files</b>.';
  els.hint.hidden = false;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

async function refresh() {
  if (tabId == null) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'get-state', tabId });
    render(res && res.tab);
  } catch (_) {
    render(null);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'toast' && msg.text) {
      toast(msg.text);
      return;
    }

    if (msg.type === 'streams-updated' && msg.tabId === tabId) refresh();
  });

  // cheap safety net in case a message is missed while the worker was asleep
  setInterval(refresh, 1500);

  els.cleanBtn.addEventListener('click', () => {
    const raw = els.paste.value.trim();
    if (!raw) return toast('Paste a URL first');
    els.cleaned.textContent = cleanUrl(raw);
  });

  els.dlBtn.addEventListener('click', async () => {
    const raw = els.paste.value.trim();
    if (!raw) return toast('Paste a URL first');
    const url = cleanUrl(raw);
    els.cleaned.textContent = url;

    const mime = paramOf(raw, 'mime') || '';
    const itag = paramOf(raw, 'itag') || '?';
    const kind = mime.indexOf('audio') === 0 ? 'audio' : 'video';
    const ext = kind === 'audio' ? 'm4a' : /webm/.test(mime) ? 'webm' : 'mp4';
    await download(url, kind, 'itag' + itag, ext, false, 0);
  });

  els.mergeBtn.addEventListener('click', merge);

  els.localBtn.addEventListener('click', () => openMergePage());

  els.pasteHelpBtn.addEventListener('click', () => {
    const open = els.pasteHelp.hidden;
    els.pasteHelp.hidden = !open;
    els.pasteHelpBtn.setAttribute('aria-expanded', String(open));
  });

  els.clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear-tab', tabId });
    await refresh();
    setStatus('');
    toast('Cleared');
  });
}

init();
