'use strict';

/**
 * Merge page. Merges two already-downloaded local files.
 *
 * Why this exists: downloading straight to disk with chrome.downloads (or any
 * external downloader) is full speed and has no size limit, while the in-browser
 * capture path has to push every byte through JS + WASM memory. Here the files
 * are read once from disk, remuxed with `-c copy` (no re-encode), and saved.
 *
 * Nothing ever leaves this machine.
 */

const FFmpeg = self.FFmpegWASM.FFmpeg;

const MAX_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 900000;

/**
 * +faststart rewrites the whole output once to move the moov atom to the front.
 * That is nice for streaming, but on a big local file it doubles the write work
 * for no benefit, so it is only used for files below this size.
 */
const FASTSTART_LIMIT = 300 * 1024 * 1024;

const els = {
  videoInput: document.getElementById('videoInput'),
  audioInput: document.getElementById('audioInput'),
  videoZone: document.getElementById('videoZone'),
  audioZone: document.getElementById('audioZone'),
  videoName: document.getElementById('videoName'),
  audioName: document.getElementById('audioName'),
  videoMeta: document.getElementById('videoMeta'),
  audioMeta: document.getElementById('audioMeta'),
  outName: document.getElementById('outName'),
  statusBox: document.getElementById('statusBox'),
  statusText: document.getElementById('statusText'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  mergeBtn: document.getElementById('mergeBtn'),
  resetBtn: document.getElementById('resetBtn'),
  log: document.getElementById('log'),
  logWrap: document.getElementById('logWrap'),
  ext: document.getElementById('ext'),
  containerNote: document.getElementById('containerNote'),
  cmd: document.getElementById('cmd'),
  bothBtn: document.getElementById('bothBtn'),
  bothInput: document.getElementById('bothInput'),
  txtBtn: document.getElementById('txtBtn'),
  txtInput: document.getElementById('txtInput'),
  lengthWarn: document.getElementById('lengthWarn'),
  lengthText: document.getElementById('lengthText'),
  dlbar: document.getElementById('dlbar'),
  dlTitle: document.getElementById('dlTitle'),
  dlNote: document.getElementById('dlNote'),
  dlLines: document.getElementById('dlLines'),
  silentNote: document.getElementById('silentNote'),
  silentNoteClose: document.getElementById('silentNoteClose')
};

const SILENT_NOTE_KEY = 'driveGrabber.silentNoteDismissed';

function initSilentNote() {
  if (!els.silentNote || !els.silentNoteClose) return;

  try {
    if (localStorage.getItem(SILENT_NOTE_KEY) === '1') {
      els.silentNote.hidden = true;
    }
  } catch (_) {
    /* storage can be unavailable, the note still works for this page */
  }

  els.silentNoteClose.addEventListener('click', () => {
    els.silentNote.hidden = true;
    try {
      localStorage.setItem(SILENT_NOTE_KEY, '1');
    } catch (_) {
      /* nothing else to do */
    }
  });
}

initSilentNote();

const state = { video: null, audio: null };
let ffmpeg = null;
let loadingPromise = null;
let busy = false;
let tempFiles = [];
let ticker = null;

/* download ids passed by the popup, so this page can follow Chrome's progress */
let dlIds = { video: 0, audio: 0 };
try {
  dlIds = {
    video: Number(new URLSearchParams(location.search).get('videoId')) || 0,
    audio: Number(new URLSearchParams(location.search).get('audioId')) || 0
  };
} catch (_) {
  /* no query string, opened from Merge local files */
}

/**
 * chrome.downloads.onChanged does not fire for every byte, so a page that only
 * listens to it shows a frozen percentage. Poll while a track is in progress.
 */
let progressTimer = null;
let progressPaint = null;

/** Length check: warn when the two picked files clearly do not match. */
const LENGTH_DIFF_LIMIT = 2; // seconds
let lengthCheck = null;
let lengthMismatch = false;
let lengthAcknowledged = false;
let lengthToken = 0;
let starting = false;

/* ------------------------------------------------------------------ */
/* ui helpers                                                          */
/* ------------------------------------------------------------------ */

function bytesLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function setStatus(text, kind, pct) {
  if (!text) {
    els.statusBox.hidden = true;
    els.bar.hidden = true;
    return;
  }

  els.statusBox.hidden = false;
  els.statusBox.className = 'statusbox' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;

  if (typeof pct === 'number') {
    els.bar.hidden = false;
    els.barFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  } else {
    els.bar.hidden = true;
  }
}

function logLine(line) {
  const atBottom = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 30;
  els.log.textContent += line + '\n';
  if (atBottom) els.log.scrollTop = els.log.scrollHeight;
}

function extOf(name, fallback) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : fallback;
}

function baseName(name) {
  return (name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
}

function sanitize(name) {
  const out = (name || 'merged')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 90)
    .replace(/[.\s]+$/g, '')
    .trim();

  if (!out || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) return 'merged';
  return out;
}

function durationLabel(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

/** Read a local file's duration without loading its media data into memory. */
function probeDuration(file, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    const url = URL.createObjectURL(file);
    let settled = false;
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      try {
        el.load();
      } catch (_) {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      resolve(value);
    };

    timer = setTimeout(() => finish(null), 8000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const value = Number(el.duration);
      finish(Number.isFinite(value) && value > 0 ? value : null);
    };
    el.onerror = () => finish(null);
    el.src = url;
    el.load();
  });
}

function clearLengthWarning() {
  lengthMismatch = false;
  lengthAcknowledged = false;
  els.lengthWarn.hidden = true;
  els.lengthText.textContent = '';
  if (!busy) els.mergeBtn.textContent = 'Merge into one file';
}

async function checkLengths() {
  const token = ++lengthToken;
  lengthMismatch = false;
  lengthAcknowledged = false;
  els.lengthWarn.hidden = true;
  if (!busy) els.mergeBtn.textContent = 'Merge into one file';

  const v = state.video;
  const a = state.audio;
  if (!v || !a) return;

  const [videoSeconds, audioSeconds] = await Promise.all([
    probeDuration(v, 'video'),
    probeDuration(a, 'audio')
  ]);

  if (token !== lengthToken) return;

  if (videoSeconds == null || audioSeconds == null) {
    logLine('[length] could not read one or both durations');
    return;
  }

  const diff = Math.abs(videoSeconds - audioSeconds);
  if (diff <= LENGTH_DIFF_LIMIT) return;

  lengthMismatch = true;
  els.lengthText.textContent =
    'Video is ' +
    durationLabel(videoSeconds) +
    ' long and audio is ' +
    durationLabel(audioSeconds) +
    ' long, a difference of ' +
    durationLabel(diff) +
    '. You may have chosen files from two different videos. Check both files before merging.';
  els.lengthWarn.hidden = false;
}

function startLengthCheck() {
  const run = checkLengths().catch((e) => {
    logLine('[length] check failed: ' + (e && e.message ? e.message : e));
  });

  lengthCheck = run;
  run.finally(() => {
    if (lengthCheck === run) lengthCheck = null;
  });
}

function setBusy(on) {
  busy = on;
  els.mergeBtn.disabled = on || !(state.video && state.audio);
  els.resetBtn.disabled = on;
  els.videoZone.style.pointerEvents = on ? 'none' : '';
  els.audioZone.style.pointerEvents = on ? 'none' : '';
  els.outName.disabled = on;
  els.mergeBtn.textContent = on ? 'Working…' : 'Merge into one file';
}

/* ------------------------------------------------------------------ */
/* file picking                                                        */
/* ------------------------------------------------------------------ */

const WEBMISH = /\.(webm|mkv|ogg|ogv|opus)$/i;
const VIDEOISH = /\.(mp4|m4v|webm|mkv|mov|avi)$/i;
const AUDIOISH = /\.(m4a|aac|mp3|opus|ogg|oga)$/i;

/** Guess which of two dropped files is the video and which is the audio. */
function kindOf(file) {
  const name = (file.name || '').toLowerCase();
  if (/\[audio\b/.test(name)) return 'audio';
  if (/\[video\b/.test(name)) return 'video';
  if (/^audio\//.test(file.type || '')) return 'audio';
  if (/^video\//.test(file.type || '')) return 'video';
  if (AUDIOISH.test(name)) return 'audio';
  if (VIDEOISH.test(name)) return 'video';
  return null;
}

/**
 * Read a .txt / .html page, find the media link inside it, and start a native
 * download for that link. This is the fallback for a page that was already
 * saved before the worker could follow it.
 */
async function adoptTextFile(file) {
  if (busy) return;

  let text = '';
  try {
    text = (await file.text()).slice(0, 65536);
  } catch (_) {
    setStatus('Could not read that text file.', 'error');
    return;
  }

  const found = linkFromText(text, 'https://drive.google.com/');
  const link = found && looksMediaLink(found) ? found : null;

  if (!link) {
    setStatus(
      'No media link was found in that text file. Open it and use Manual paste in the popup if the link is there.',
      'error'
    );
    return;
  }

  let mime = '';
  try {
    mime = decodeURIComponent((link.match(/[?&]mime=([^&]*)/) || [])[1] || '');
  } catch (_) {
    mime = '';
  }

  const lower = (file.name || '').toLowerCase();
  const kind =
    /^audio/i.test(mime) || /\[audio\b/.test(lower) || /\baudio\b/.test(lower) ? 'audio' : 'video';

  let name = (file.name || 'recovered').replace(/\.(txt|html?)$/i, '');
  if (!/\.(mp4|m4v|webm|mkv|mov|m4a|aac|mp3|opus|ogg)$/i.test(name)) {
    const audio = kind === 'audio';
    const webm = /webm|opus/i.test(mime) || /\.webm$/i.test(name);
    name += '.' + (audio ? (webm ? 'webm' : 'm4a') : webm ? 'webm' : 'mp4');
  }

  setStatus('Checking the link inside the text page...', 'busy');

  try {
    /* Send it through the worker so the same preflight, tracking and recovery
       apply to this link as to a normal popup download. */
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      url: link,
      filename: 'DriveGrabber/' + name,
      expectedSize: 0
    });

    if (!res || !res.ok) throw new Error((res && res.error) || 'download failed');

    const id = res.id;
    dlIds[kind] = id;
    els.dlbar.hidden = false;
    els.dlTitle.textContent = 'Downloading the real file';
    els.dlNote.textContent =
      'The link inside the text page was found. Progress updates automatically.';
    refreshDownloads();
    setStatus(
      'Found the media link inside the text page. Chrome is downloading the real file now.',
      'ok'
    );
  } catch (e) {
    setStatus('Could not start the download: ' + (e && e.message ? e.message : 'unknown'), 'error');
  }
}

/**
 * Assign one or two files at once. The popup names its downloads
 * "<title> [video 1080p].mp4" and "<title> [audio 128k AAC].m4a", so the
 * bracket hints are enough to tell them apart even when the MIME type is vague.
 */
function assignFiles(fileList) {
  if (busy) return;

  const all = Array.from(fileList || []);
  if (!all.length) return;

  const texts = all.filter((f) => /\.(txt|html?)$/i.test(f.name || ''));
  const usable = all.filter((f) => !/\.(txt|html?)$/i.test(f.name || ''));

  if (texts.length) adoptTextFile(texts[0]);
  if (!usable.length) return;

  const pool = usable.slice();
  let v = pool.find((f) => kindOf(f) === 'video') || null;
  let a = pool.find((f) => kindOf(f) === 'audio') || null;

  /* no useful names or MIME types: the larger file is almost always the video */
  if (!v && !a && pool.length >= 2) {
    const sorted = pool.slice().sort((x, y) => (y.size || 0) - (x.size || 0));
    v = sorted[0];
    a = sorted[1];
  }

  /* if only one side was recognised, the other file is the missing track */
  const leftover = pool.filter((f) => f !== v && f !== a);
  if (v && !a && leftover.length === 1) a = leftover[0];
  if (a && !v && leftover.length === 1) v = leftover[0];

  if (!v && !a && pool.length === 1) {
    const only = pool[0];
    const kind = kindOf(only);
    if (kind === 'audio') a = only;
    else if (kind === 'video') v = only;
    else if (!state.video) v = only;
    else if (!state.audio) a = only;
  }

  if (!v && !a) {
    setStatus('Could not tell which file is video and which is audio. Use the two boxes below.', 'error');
    return;
  }

  /* fill the video first so the output name comes from the video file */
  if (v) setFile('video', v);
  if (a) setFile('audio', a);
}

function wirePicker(kind) {
  const input = kind === 'video' ? els.videoInput : els.audioInput;
  const zone = kind === 'video' ? els.videoZone : els.audioZone;

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) setFile(kind, file);
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('hover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('hover'));

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('hover');

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    /* one file dropped on a box means exactly that box, two mean pair them up */
    if (files.length === 1) setFile(kind, files[0]);
    else assignFiles(files);
  });
}

/** WebM/VP9/Opus cannot be copied into MP4, so those go into Matroska. */
function containerExt() {
  const names = [state.video && state.video.name, state.audio && state.audio.name].filter(Boolean);
  return names.some((n) => WEBMISH.test(n)) ? 'mkv' : 'mp4';
}

function syncContainer() {
  const ext = containerExt();
  const total = (state.video ? state.video.size : 0) + (state.audio ? state.audio.size : 0);
  const faststart = ext === 'mp4' && total <= FASTSTART_LIMIT;

  els.ext.textContent = '.' + ext;
  els.outName.placeholder = 'merged.' + ext;

  const args = ['ffmpeg', '-i', 'video', '-i', 'audio', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0'];
  if (ext === 'mkv') args.push('-f', 'matroska');
  else if (faststart) args.push('-movflags', '+faststart');
  args.push('output.' + ext);
  els.cmd.textContent = args.join(' ');

  if (ext === 'mkv') {
    els.containerNote.textContent =
      'WebM/Opus source found, so the result is a .mkv file. Still lossless, no re-encode.';
    els.containerNote.hidden = false;
  } else if (!faststart) {
    els.containerNote.textContent =
      'Large file: faststart is skipped to save a full extra write. The result still plays normally.';
    els.containerNote.hidden = false;
  } else {
    els.containerNote.textContent = '';
    els.containerNote.hidden = true;
  }
}

function lastLogLines(count) {
  const lines = els.log.textContent
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^Aborted/.test(s));
  return lines.slice(-(count || 2)).join(' | ');
}

function setFile(kind, file) {
  if (!file) return;

  if (/\.(txt|html?)$/i.test(file.name)) {
    adoptTextFile(file);
    return;
  }

  state[kind] = file;

  const zone = kind === 'video' ? els.videoZone : els.audioZone;
  const nameEl = kind === 'video' ? els.videoName : els.audioName;
  const metaEl = kind === 'video' ? els.videoMeta : els.audioMeta;

  zone.classList.add('filled');
  nameEl.textContent = file.name;
  metaEl.textContent = bytesLabel(file.size);

  if (kind === 'video' && !els.outName.dataset.touched) {
    els.outName.value = sanitize(
      baseName(file.name).replace(/\s*\[(?:video|audio)[^\]]*\]\s*$/i, '')
    );
  }

  els.mergeBtn.disabled = !(state.video && state.audio);
  syncContainer();

  if (state.video && state.audio) startLengthCheck();
  else clearLengthWarning();

  const total = (state.video ? state.video.size : 0) + (state.audio ? state.audio.size : 0);
  if (total > MAX_TOTAL_BYTES) {
    setStatus(
      `Total ${bytesLabel(total)} is over the ${bytesLabel(MAX_TOTAL_BYTES)} browser limit. Use a desktop ffmpeg for this one.`,
      'error'
    );
  } else {
    setStatus('');
  }
}

/* ------------------------------------------------------------------ */
/* ffmpeg                                                              */
/* ------------------------------------------------------------------ */

async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => logLine(message));
    ff.on('progress', ({ progress }) => {
      if (!busy) return;
      const pct = Math.max(0, Math.min(99, Math.round((Number(progress) || 0) * 100)));
      setStatus(`Merging (stream copy)… ${pct}%`, 'busy', pct);
    });

    await ff.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm')
    });

    ffmpeg = ff;
    return ff;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function cleanup() {
  for (const name of tempFiles) {
    try {
      await ffmpeg.deleteFile(name);
    } catch (_) {
      /* ignore */
    }
  }
  tempFiles = [];
}

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

async function runMerge() {
  if (busy || starting) return;

  /* If the length check is still running, let it finish so the warning is
     visible before anything is merged. */
  starting = true;
  try {
    if (lengthCheck) {
      setStatus('Checking both track lengths…', 'busy');
      await lengthCheck;
    }
  } finally {
    starting = false;
  }

  if (busy) return;

  if (lengthMismatch && !lengthAcknowledged) {
    lengthAcknowledged = true;
    els.mergeBtn.textContent = 'Merge anyway';
    setStatus(
      'The two files have different lengths. Check the warning above. Click Merge again if you are sure.',
      'error'
    );
    return;
  }

  const v = state.video;
  const a = state.audio;
  if (!v || !a) return;

  const total = v.size + a.size;
  if (total > MAX_TOTAL_BYTES) {
    setStatus(`Total ${bytesLabel(total)} exceeds the ${bytesLabel(MAX_TOTAL_BYTES)} browser limit.`, 'error');
    return;
  }

  setBusy(true);
  els.log.textContent = '';
  setStatus('Loading ffmpeg (first run only, ~32 MB)…', 'busy', 0);

  const startedAt = Date.now();
  ticker = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    if (secs > 3 && !/Merging/.test(els.statusText.textContent)) {
      const base = els.statusText.textContent.replace(/\s*\(\d+s\)$/, '');
      els.statusText.textContent = base + ` (${secs}s)`;
    }
  }, 1000);

  try {
    const ff = await ensureFFmpeg();

    const vName = 'in_v' + extOf(v.name, '.mp4');
    const aName = 'in_a' + extOf(a.name, '.m4a');
    const container = containerExt();
    const outName = 'out.' + container;
    const typedName = sanitize(els.outName.value || baseName(v.name) || 'merged');
    const outBase = sanitize(typedName.replace(/\.(mp4|mkv|webm|m4v|mov)$/i, ''));
    tempFiles = [vName, aName, outName];

    setStatus('Reading video file…', 'busy', 0);
    await ff.writeFile(vName, new Uint8Array(await v.arrayBuffer()));

    setStatus('Reading audio file…', 'busy', 0);
    await ff.writeFile(aName, new Uint8Array(await a.arrayBuffer()));

    setStatus('Merging (stream copy)…', 'busy', 0);

    const args = [
      '-i',
      vName,
      '-i',
      aName,
      '-c',
      'copy',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-metadata',
      'title=' + outBase
    ];
    if (container === 'mkv') args.push('-f', 'matroska');
    else if (total <= FASTSTART_LIMIT) args.push('-movflags', '+faststart');
    args.push(outName);

    const code = await ff.exec(args, EXEC_TIMEOUT_MS);

    if (code !== 0) {
      const tail = lastLogLines(2);
      throw new Error('ffmpeg failed (code ' + code + ')' + (tail ? ': ' + tail : ', see the log below'));
    }

    setStatus('Saving…', 'busy', 99);

    const data = await ff.readFile(outName);
    const type = container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    const name = outBase + '.' + container;
    const file = new File([data], name, { type });
    const url = URL.createObjectURL(file);

    /* Give the worker the exact name first, so onDeterminingFilename can force
       it if Chrome would otherwise derive a name from the blob URL. */
    try {
      await chrome.runtime.sendMessage({
        type: 'name-blob',
        url,
        filename: 'DriveGrabber/' + name
      });
    } catch (_) {
      /* the filename option below still names the file */
    }

    const id = await chrome.downloads.download({
      url,
      filename: 'DriveGrabber/' + name,
      conflictAction: 'uniquify',
      saveAs: false
    });

    /* Wait for Chrome to finish writing, so the message shows the name that
       actually landed on disk, not only the name we asked for. */
    setStatus('Saving to Downloads/DriveGrabber/' + name + '…', 'busy', 99);
    const saved = await waitForSaved(id);

    if (saved && saved.state === 'interrupted') {
      throw new Error('Chrome could not save the file: ' + (saved.error || 'interrupted'));
    }

    const savedName = saved && saved.filename ? tailName(saved.filename) : name;
    logLine('[save] ' + (saved && saved.filename ? saved.filename : 'no download item'));
    setStatus(
      `Your video is downloaded. Saved to Downloads/DriveGrabber/${savedName}   (${bytesLabel(file.size)})`,
      'ok',
      100
    );

    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    setStatus('Merge failed: ' + msg, 'error');
    els.logWrap.open = true;
    logLine('[error] ' + msg);
  } finally {
    clearInterval(ticker);
    ticker = null;
    await cleanup().catch(() => {});
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* native download progress (page opened by the popup)                 */
/* ------------------------------------------------------------------ */

function tailName(path) {
  const p = path || '';
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Wait until Chrome finishes writing a download, then return its item. */
function waitForSaved(id, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const done = (item) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(item);
    };

    const check = () => {
      chrome.downloads
        .search({ id })
        .then(([item]) => {
          if (!item || item.state === 'complete' || item.state === 'interrupted') done(item);
        })
        .catch(() => done(null));
    };

    const onChanged = (delta) => {
      if (delta && delta.id === id && (delta.state || delta.error)) check();
    };

    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => done(null), timeoutMs);
    check();
  });
}

/** Follow the two chrome.downloads ids the popup started. */
function paintDownloads() {
  if (progressPaint) return progressPaint;

  progressPaint = paintDownloadsNow().finally(() => {
    progressPaint = null;
  });

  return progressPaint;
}

/** Paint once, and report whether another poll is needed. */
async function paintDownloadsNow() {
  const wanted = [
    ['video', dlIds.video],
    ['audio', dlIds.audio]
  ].filter((pair) => pair[1]);

  if (!wanted.length) return false;

  const lines = [];
  let ready = 0;
  let failed = false;
  let active = false;

  for (const [kind, id] of wanted) {
    const label = kind === 'video' ? 'Video' : 'Audio';
    let item = null;

    try {
      [item] = await chrome.downloads.search({ id });
    } catch (_) {
      item = null;
    }

    if (!item) {
      lines.push({ text: label + ': not available (removed or expired)', kind: 'bad' });
      failed = true;
    } else if (item.state === 'complete') {
      lines.push({
        text: label + ' ready: ' + tailName(item.filename) + ' (' + bytesLabel(item.fileSize) + ')',
        kind: 'ok'
      });
      ready += 1;
    } else if (item.state === 'in_progress') {
      active = true;
      const got = item.bytesReceived || 0;
      const total = item.totalBytes || 0;
      const text =
        total > 0
          ? label +
            ' downloading: ' +
            Math.min(100, Math.round((got / total) * 100)) +
            '% (' +
            bytesLabel(got) +
            ' of ' +
            bytesLabel(total) +
            ')'
          : label + ' downloading: ' + bytesLabel(got);
      lines.push({ text, kind: 'busy' });
    } else {
      lines.push({ text: label + ' failed: ' + (item.error || 'interrupted'), kind: 'bad' });
      failed = true;
    }
  }

  els.dlbar.hidden = false;
  els.dlbar.classList.toggle('ok', ready === wanted.length);
  els.dlbar.classList.toggle('error', failed);

  if (failed) els.dlTitle.textContent = 'Download problem';
  else if (ready === wanted.length) els.dlTitle.textContent = 'Both tracks are ready';
  else els.dlTitle.textContent = 'Downloading with Chrome';

  els.dlLines.textContent = '';
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'dl-line ' + line.kind;
    row.textContent = line.text;
    els.dlLines.appendChild(row);
  }

  if (failed) {
    els.dlNote.textContent = 'Go back to the Drive tab and try again.';
  } else if (ready === wanted.length) {
    els.dlNote.textContent = 'Pick both files below in one dialog.';
  } else {
    els.dlNote.textContent = 'Progress updates automatically.';
  }

  return active;
}

/** Poll again soon while at least one track is still downloading. */
function scheduleProgress() {
  if (progressTimer) return;

  progressTimer = setTimeout(() => {
    progressTimer = null;
    refreshDownloads();
  }, 500);
}

/** Repaint now, then keep polling if a download is still running. */
function refreshDownloads() {
  clearTimeout(progressTimer);
  progressTimer = null;

  paintDownloads()
    .then((active) => {
      if (active) scheduleProgress();
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

wirePicker('video');
wirePicker('audio');

els.bothBtn.addEventListener('click', () => els.bothInput.click());

els.bothInput.addEventListener('change', () => {
  assignFiles(els.bothInput.files);
  els.bothInput.value = '';
});

els.txtBtn.addEventListener('click', () => els.txtInput.click());

els.txtInput.addEventListener('change', () => {
  const file = els.txtInput.files && els.txtInput.files[0];
  if (file) adoptTextFile(file);
  els.txtInput.value = '';
});

/* dropping two files anywhere on the page pairs them up */
document.addEventListener('dragover', (e) => {
  if (!busy) e.preventDefault();
});

document.addEventListener('drop', (e) => {
  if (busy) return;
  e.preventDefault();
  assignFiles(e.dataTransfer && e.dataTransfer.files);
});

/* the worker may replace a text-page download with a fresh id */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'download-recovered') return;

  const kind = /\[audio/i.test(msg.filename || '') ? 'audio' : 'video';
  if (dlIds[kind] !== msg.oldId) return;

  dlIds[kind] = msg.newId;
  refreshDownloads();
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta) return;
  if (delta.id !== dlIds.video && delta.id !== dlIds.audio) return;
  if (!delta.state && !delta.error && !delta.paused && !delta.filename) return;
  refreshDownloads();
});

if (dlIds.video || dlIds.audio) {
  els.dlbar.hidden = false;
  els.dlNote.textContent = 'Waiting for both tracks to finish…';

  /* A fast text page can be recovered before this tab finishes loading, so
     catch up from the session map as well as the live message above. */
  const follow = (map, id) => {
    let out = id;
    for (let i = 0; i < 5 && map[out]; i++) out = map[out];
    return out;
  };

  const paint = () => refreshDownloads();

  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session
      .get('grabberRecovered')
      .then((got) => {
        const map = (got && got.grabberRecovered) || {};
        if (map[dlIds.video]) dlIds.video = follow(map, dlIds.video);
        if (map[dlIds.audio]) dlIds.audio = follow(map, dlIds.audio);
      })
      .catch(() => {})
      .finally(paint);
  } else {
    paint();
  }
}

els.outName.addEventListener('input', () => {
  els.outName.dataset.touched = '1';
});

els.mergeBtn.addEventListener('click', runMerge);

els.resetBtn.addEventListener('click', () => {
  if (busy) return;
  lengthToken += 1;
  lengthCheck = null;
  clearLengthWarning();
  state.video = null;
  state.audio = null;
  els.videoInput.value = '';
  els.audioInput.value = '';
  els.bothInput.value = '';
  els.txtInput.value = '';
  els.videoZone.classList.remove('filled');
  els.audioZone.classList.remove('filled');
  els.videoName.textContent = 'Choose or drop a video file';
  els.audioName.textContent = 'Choose or drop an audio file';
  els.videoMeta.textContent = 'mp4 / m4v / webm / mkv';
  els.audioMeta.textContent = 'm4a / aac / mp3 / opus';
  els.outName.value = '';
  delete els.outName.dataset.touched;
  els.log.textContent = '';
  els.mergeBtn.disabled = true;
  setStatus('');
  syncContainer();
});

/* filename hint passed by the popup: merge.html?title=<drive title> */
try {
  const title = new URLSearchParams(location.search).get('title');
  if (title) {
    els.outName.value = sanitize(baseName(title));
    els.outName.dataset.touched = '1';
  }
} catch (_) {
  /* ignore */
}

syncContainer();
