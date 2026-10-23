'use strict';

/**
 * Link extraction shared by the background worker and the merge page.
 *
 * Drive sometimes answers a media request with a small text or HTML page that
 * contains the real download link. These helpers pull that link out, without
 * touching any signature bytes.
 */

/** Turn a Drive file page into a direct download URL. */
function normalizeDriveLink(url) {
  const file = url.match(/^https?:\/\/drive\.google\.com\/file\/d\/([^/?#]+)/i);
  if (file) return 'https://drive.google.com/uc?export=download&id=' + file[1];

  const open = url.match(/^https?:\/\/drive\.google\.com\/open\?id=([^&]+)/i);
  if (open) return 'https://drive.google.com/uc?export=download&id=' + open[1];

  return url;
}

/** Does this URL look like a real media or Drive download link? */
function looksMediaLink(url) {
  if (!url) return false;

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  const trusted =
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    host.endsWith('.googleusercontent.com') ||
    host.endsWith('.googlevideo.com') ||
    host.endsWith('.googleapis.com');
  if (!trusted) return false;

  if (/videoplayback/i.test(url)) return true;
  if (/drive\.usercontent\.google\.com\/download/i.test(url)) return true;
  if (/drive\.google\.com\/uc\?/i.test(url)) {
    if (/export=view/i.test(url)) return false;
    return /(?:export=download|[?&]id=)/i.test(url);
  }
  if (/drive\.google\.com\/download(?:[?/]|$)/i.test(url)) return true;
  if (/\.(mp4|m4v|webm|mkv|mov|m4a|aac|mp3|opus|ogg)(?:[?#]|$)/i.test(url)) return true;
  return false;
}

/**
 * Find the first usable media link in a text page. Handles plain URLs,
 * HTML-escaped ampersands, JSON-escaped slashes, and href/action attributes.
 */
function linkFromText(text, pageUrl) {
  const normalized = String(text || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"');

  const clean = (u) =>
    u
      .replace(/&amp;/gi, '&')
      .replace(/&#38;/g, '&')
      .replace(/&quot;/gi, '"')
      .replace(/[)\]}"'<>.,;!?]+$/, '')
      .trim();

  const patterns = [
    /https?:\/\/[^\s"'<>\\]+videoplayback[^\s"'<>\\]*/i,
    /https?:\/\/drive\.usercontent\.google\.com\/download[^\s"'<>\\]*/i,
    /https?:\/\/drive\.google\.com\/(?:uc|download)\?[^\s"'<>\\]+/i,
    /https?:\/\/drive\.google\.com\/uc\?[^\s"'<>\\]*export=download[^\s"'<>\\]*/i,
    /https?:\/\/[^\s"'<>\\]+\.(?:mp4|m4a|webm|mkv|mov)(?:\?[^\s"'<>\\]*)?/i,
    /https?:\/\/drive\.google\.com\/file\/d\/[^\s"'<>\\]+/i,
    /https?:\/\/drive\.google\.com\/open\?id=[^\s"'<>\\]+/i
  ];

  for (const re of patterns) {
    const m = normalized.match(re);
    if (!m) continue;
    const candidate = normalizeDriveLink(clean(m[0]));
    if (looksMediaLink(candidate)) return candidate;
  }

  const hrefs = [...normalized.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1]
  );

  const ranked = hrefs
    .filter((h) => !/(?:support|accounts)\.google\.com/i.test(h))
    .sort((a, b) => {
      const score = (h) =>
        /download|videoplayback|export=|\.(mp4|m4a|webm|mkv|mov)/i.test(h) ? 1 : 0;
      return score(b) - score(a);
    });

  for (const raw of ranked) {
    if (/\.(css|js|png|jpe?g|svg|gif|ico|woff2?)(?:[?#]|$)/i.test(raw)) continue;

    let url = clean(raw);
    if (!/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url, pageUrl || 'https://drive.google.com/').href;
      } catch (_) {
        continue;
      }
    }

    if (/^https?:\/\//i.test(url)) {
      const normalizedUrl = normalizeDriveLink(url);
      if (looksMediaLink(normalizedUrl)) return normalizedUrl;
    }
  }

  return null;
}
