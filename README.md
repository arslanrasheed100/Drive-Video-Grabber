<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="Drive Video Grabber icon" />
</p>

<h1 align="center">Drive Video Grabber</h1>

<p align="center">
  Chrome MV3 extension that captures Google Drive <code>videoplayback</code> streams,
  removes the byte-range limit, and saves the video and audio as one MP4<br />
  (or one MKV, when Drive only offers WebM tracks).<br />
  Runs fully local in your browser. Nothing is uploaded, ever.
</p>

> **Status:** free and open source (MIT), personal project. **Not published on the
> Chrome Web Store.** Install it manually with *Load unpacked* (see the quick start
> below). Read the [Legal Disclaimer](#legal-disclaimer--acceptable-use-policy)
> before using it.

---

## Quick start: install from GitHub (first time)

You do not need Node, npm, ffmpeg, or any build step. ffmpeg is bundled with the
extension. Chrome loads the extension directly from the folder you extract, so that
folder has to stay where it is.

**What you need:** a desktop Chromium browser (Chrome, Edge, Brave, Opera, or Vivaldi,
version 109 or newer) and a Google Drive video that your account can already play.

### Step 1: Download the ZIP

On the GitHub page of this project, click the green **Code** button, then
**Download ZIP**. That single ZIP contains the whole extension. If you prefer git,
clone the repository as usual; the result is the same folder.

### Step 2: Extract it somewhere permanent

Right click the downloaded ZIP, choose **Extract All**, and pick a folder you will
keep, for example:

```
C:\Tools\drive-video-grabber
```

Two rules:

- Do not load the extension from inside the ZIP file. It must be extracted first.
- Do not move or delete the folder after installing. The browser reads the extension
  from that path every time it starts. If you move it, load it again.

After extracting you usually get a folder named `drive-video-grabber-main`. That is
the one you want. It must contain `manifest.json` directly.

### Step 3: Load it in the browser

1. Open `chrome://extensions` in a new tab.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the extracted folder, the one that directly contains `manifest.json`.
5. The card **Drive Video Grabber** appears and the extension is active.

If you see *Manifest file is missing or unreadable*, the wrong folder was selected.
Open the extracted folder and pick the level that contains `manifest.json`.

### Step 4: Pin the icon

Click the puzzle piece icon in the toolbar and pin **Drive Video Grabber**, so it is
always one click away. Pinning is optional but makes the next steps easier.

### Step 5: Grab a video

1. Open the Drive video in the browser and press **play**.
2. Let it run for 5 to 10 seconds, or scrub through the timeline. Drive requests the
   video track and the audio track at different moments, and both must be captured.
3. Click the extension icon. Each captured track appears as a card with a link check
   dot.
4. Save it:
   - Click **Merge video + audio**. Chrome downloads both tracks with its own
     downloader at full speed, then the merge page opens in a new tab.
   - If Drive answers with a text page, the extension follows the link inside it
     before saving, so you get the real media file instead of a `.txt`.
   - On that page, click **Pick both files in one dialog** (or drop both files on the
     page). Video and audio are assigned automatically.
   - The page compares both track lengths. If they differ by more than 2 seconds, it
     warns that the files may belong to different videos. Check them before merging.
   - If a `.txt` page was already saved, click **Fix a text page** on the merge page
     and pick that file. The link inside it is downloaded for you.
   - Click **Merge into one file**. The two local files are remuxed into one MP4 or MKV.
   - Already have the files? Click **Merge local files** in the popup instead.
5. Files land in `Downloads/DriveGrabber/` with no save dialog.

A green dot means the link was verified and should download. A grey `unverified` dot
means the check itself could not reach Drive, not that the link is broken, so try the
download anyway. A red `text page` dot means Drive answered with a text page; the
extension will try to follow the link inside it, and if that fails, replay the video.
A red `expired` dot means the signed link is gone, so reload the Drive tab, press play
again, and download right away.

### Updating the extension

1. Download the new ZIP from GitHub and extract it over the old folder, or replace
   the whole folder with the new one.
2. Open `chrome://extensions` and click the reload icon on the extension card.
3. Reload the Drive tab too, then play the video again.

Keeping the same folder path keeps the extension id, so its settings and stored state
survive the update.

### Uninstalling

Open `chrome://extensions`, click **Remove** on the card, then delete the folder. Local
files already saved in `Downloads/DriveGrabber/` are not touched.

### Other Chromium browsers

The steps are identical, only the extensions page changes:

| Browser | Extensions page |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera | `opera://extensions` |
| Vivaldi | `vivaldi://extensions` |

---

## Why this exists

I had a few Google Drive videos that I was allowed to **view** but not **download**.
There was no download button, and while watching, Drive kept throwing playback
errors and *"playback limit reached"* style restrictions that broke the stream.

So I wrote this to watch those videos comfortably, offline, in a normal player,
and to keep a personal copy of content I already had access to.

It does **not** bypass DRM, paywalls, private-file permissions, or any server-side
block. It only reuses the very same stream your browser already plays, minus the
`range` parameter that forces it to come back in small pieces.

That is the whole purpose. It is not built for, and should not be used for,
redistribution or copyright infringement.

---

## What it does

- Watches the network requests the Drive player itself makes and records the
  `videoplayback` URLs for both the video and audio tracks.
- Cleans each URL without touching the signature (`sig` / `lsig` stay byte for byte
  identical), so the server returns the **whole file** instead of a 5 MB slice.
- Sends each track to Chrome's native downloader, so the network part runs at full
  speed and writes straight to disk instead of through the extension's memory.
- Saves the result through `chrome.downloads` with no save dialog.
- If Drive answers with a tiny text page instead of the media (it happens when a
  link is about to expire), the extension reads the link inside it **before** the
  download starts, so the junk page is normally never saved. If a page was already
  saved, the merge page has a **Fix a text page** button that reads it and downloads
  the real link, and the worker still checks finished downloads and removes junk files.
- Optionally merges the two tracks into a single file using `ffmpeg.wasm` that is
  bundled with the extension. No server, no install, no internet needed for the merge.
  The result is `.mp4` for H.264/AAC tracks and `.mkv` for WebM/VP9/Opus tracks.

| | |
|---|---|
| Video + audio in one file | `-c copy` remux, lossless |
| Download | Chrome's native downloader, both tracks at the same time |
| Output folder | `Downloads/DriveGrabber/` |
| Dialogs | none for downloads, files are saved automatically |
| Progress | Chrome's download shelf plus the merge page, which follows both tracks |
| Link check | hover a quality (or just open the popup) and the dot tells you if that URL still downloads |
| Merge limit | 1.5 GB total, the download itself has no limit |
| Telemetry | none |

---

## How to use

### Step 1. Open the video in Drive

You need to be able to **play** the video in your browser. If Drive itself refuses
to play it, this extension cannot help.

### Step 2. Let the player load both tracks

Press **play** and let it run for about 3 to 10 seconds, or scrub through the
timeline. The Drive player requests the video track and the audio track at
different moments, and both must show up before they can be merged.

### Step 3. Open the extension

Click the toolbar icon. Every captured stream is listed as a card:

```
VIDEO   1080p            itag 137 · 128.0 MB
[ Download ]  [ Copy URL ]

AUDIO   128k AAC         itag 140 · 9.0 MB
[ Download ]  [ Copy URL ]
```

The best quality of each kind is highlighted. Then pick one of the paths below.

> **A separate video file has no audio.** Drive sends the video and audio as two
> tracks. Use **Download** on each card, then click **Merge video + audio** (or
> **Merge local files**) to join them into one file with sound.

---

### Path A: one click, native download (recommended)

Click **Merge video + audio**.

1. Chrome's own downloader saves both tracks, in parallel:
   - `Downloads/DriveGrabber/<title> [video 1080p].mp4` (video only, no sound)
   - `Downloads/DriveGrabber/<title> [audio 128k AAC].m4a` (audio only)
2. The merge page opens and follows both downloads live.
3. When both are ready, click **Pick both files in one dialog**, or drag both files
   onto the page. Video and audio are detected automatically. If one track arrived as
   a `.txt` page, click **Fix a text page** and pick it, or drop it anywhere on the page.
   The page also compares both track lengths and warns if they differ by more than 2
   seconds, which usually means the files are from different videos.
4. Optionally change the output name, then click **Merge into one file**. ffmpeg.wasm
   remuxes them with `-c copy`, so nothing is re-encoded.
5. The result is saved to `Downloads/DriveGrabber/<title>.mp4`. The chosen name is also
   written as the video's title metadata, so players and chat apps show it instead of
   Drive's internal string.

This is the fast path because the network part runs in Chrome's native downloader and
writes straight to disk, instead of passing every byte through JavaScript.

If the best tracks Drive offers are WebM/VP9 or Opus, MP4 cannot hold them with
`-c copy`. In that case the result is saved as `<title>.mkv` instead; it is exactly
the same lossless remux, only in a container that supports those codecs. The merge
page tells you which one you are getting before you click.

MP4 files up to 300 MB get `+faststart`, so they start playing while they load.
Larger files skip it to avoid a second full write, and still play normally.

The merge step loads both files into WebAssembly memory, so it is capped at 1.5 GB
total. The download itself has no size limit.

### Path B: merge files you already have

If a track was downloaded earlier, or you want to pick the files yourself:

1. Use **Download** on a stream card to save the video and audio files. The video
   file is silent on its own; the audio file carries the sound.
2. Click **Merge local files**. A merge page opens in a new tab.
3. Pick the video file and the audio file, or drag both files onto the page. A warning
   appears if their lengths differ by more than 2 seconds.
4. Optionally change the output name, then click **Merge into one file**.

Same lossless remux, same output folder. WebM/Opus sources are detected and saved as
`.mkv` automatically.

The commands it can run:

```bash
# small MP4
ffmpeg -i video.mp4 -i audio.m4a -c copy -map 0:v:0 -map 1:a:0 -metadata title="My video" -movflags +faststart "My video.mp4"

# large MP4, or WebM/VP9/Opus source
ffmpeg -i video.webm -i audio.webm -c copy -map 0:v:0 -map 1:a:0 -metadata title="My video" -f matroska "My video.mkv"
```

### Path C: paste a URL by hand

If you already have a `videoplayback` URL, paste it into the box at the bottom of
the popup.

- **Clean** shows what the extension will request (range removed, everything after
  `ump` trimmed).
- **Download** saves it with the right extension.

### Path D: your own ffmpeg

If you have ffmpeg installed, download the two tracks and run the same command
yourself. That is the fastest option of all and needs no extension at merge time.

---

## Where are my files?

Everything lands in `Downloads/DriveGrabber/`.

| Action | File name |
|---|---|
| Merge video + audio | `<page title>.mp4`, or `<page title>.mkv` for WebM sources |
| Download on a card | `<page title> [video 1080p].mp4`, `<page title> [audio 128k AAC].m4a` |
| Merge local files | whatever you type in the output name box |
| Manual paste | `itag<number>.<ext>` |

There is **no save dialog**: files are written straight to that folder. If a file
with the same name exists, Chrome adds `(1)`, `(2)`, and so on.

---

## Troubleshooting

**"Playback limit reached" or playback keeps failing in Drive**
This happens on Drive's side, not in the extension. The extension can only work
with a stream that your browser is able to play. Try: reload the page, play again,
then capture fresh URLs and download within a couple of minutes. If Drive refuses
to play the file at all, there is nothing to capture and this tool cannot help.

**Nothing is listed in the popup**
The capture only starts once the player requests media. Press play, wait, and
scrub a little. Also check that the video is actually open in the active tab; the
list is per tab.

**"Audio stream not captured yet"**
The player loads audio later than video. Keep playing for a few more seconds,
then reopen the popup.

**Two files appeared instead of one**
That is expected. Chrome's native downloader saves the video track and the audio track
separately, then the merge page combines them into one file. The video file is silent
on its own; merging it with the audio file adds the sound. Pick both on that page
and click **Merge into one file**.

**Download fails with 403 / 401**
The URL expired or was bound to a different address. These links are signed and
short lived (usually about 15 minutes). Replay the video and capture again.

**I got a `.txt` file instead of the video**
Drive sometimes replies with a small text page that contains the real link, usually
when the URL is close to expiring. The extension now checks the link **before** it
starts the native download. If Drive is about to send a text page, it follows the real
link inside it and saves the media under the original `.mp4` / `.m4a` name, so the
`.txt` normally never appears in the first place.

If a `.txt` was already saved, open the merge page and click **Fix a text page**, then
pick that `.txt` (or drop it anywhere on the page). The extension reads the link inside
it and starts a native download for the real media. Chrome does not let an extension
read a file from your Downloads folder without a pick, so this one click is needed for
a page that is already on disk. If the page has no usable link, you get a message
asking you to reload the Drive tab and replay the video. The worker also checks
finished downloads and removes junk pages it created itself.

**Some qualities do not download, even after a reload**
Drive re-signs only the streams the player is actually using. The quality that is
playing keeps a fresh URL, while the others keep the URL from the moment they were
first requested and expire after a few minutes. Hover a quality in the popup to check
its link, or switch Drive's player to that quality, let it play, then download. A grey
`unverified` dot means the check itself could not reach Drive, not that the link is
dead, so just try the download.

**The merge fails right away, the links look old**
Every URL is signed and expires after a few minutes, so the popup shows how old each
capture is and warns once it is over ten minutes. When that happens the extension
stops before downloading anything and asks you to reload the Drive tab and press
play. Do that, then merge within a minute or two.

**The merge page says the total is over 1.5 GB**
The merge step loads both files into WebAssembly memory, so it has that guard. Use a
desktop ffmpeg (Path D) for very large videos. The native downloads themselves have
no such limit.

**ffmpeg failed (code 1)**
The error line now carries ffmpeg's own reason at the end. Two common ones:

- `Could not find tag for codec ...` means the tracks do not fit the chosen
  container. This build picks `.mkv` automatically for WebM/VP9/Opus sources, so
  make sure you are on the newest version.
- `moov atom not found` or `Invalid data found` means a downloaded track is not
  media at all, usually an expired link or a Drive text page. Replay the video and
  try again right away.

The extension also follows Drive's text pages by itself, both for normal downloads
and inside the merge, as long as the page contains the real link.

**A download never finishes**
Cancel it in Chrome's download shelf, reload the Drive tab, press play for a few
seconds, then start again. Signed links expire, so an old queued download can stall.

**The merge tab was closed mid-merge**
Nothing is locked. Open **Merge local files** again and pick the files. The downloaded
tracks are still in `Downloads/DriveGrabber/`.

**The merge page opens but ffmpeg does not load**
The bundled core files live in `vendor/ffmpeg/`. If you deleted or moved them, put
them back or reinstall the extension. Chrome 109 or newer is required.

**I changed the code and nothing happened**
Reload the extension from `chrome://extensions`.

---

## How it works (short version)

1. `chrome.webRequest` only *observes* traffic. It cannot modify requests.
2. Every `videoplayback` request is recorded per tab, together with its `itag`,
   `mime`, `clen`, and a cleaned URL. The URL is refreshed on every new request,
   because Drive re-signs the stream and old signatures expire.
3. The cleaner is a pure string operation. It never re-encodes the URL with
   `new URL()` or `URLSearchParams`, so the signature parameters remain identical.
4. `chrome.downloads` saves both tracks with Chrome's native downloader. The merge
   page then loads the two local files and remuxes them with ffmpeg.wasm, inside the
   page, with no server and no upload.

### What gets stripped

1. Delete the `range` parameter.
2. Cut everything after the word `ump`. The `&ump` itself stays.

Example:

```
...&cver=1.20261020.09.00-...&range=17455670-17940474&rn=35&rbuf=61296&ump=1&srfvp=1
```

becomes:

```
...&cver=1.20261020.09.00-...&rn=35&rbuf=61296&ump
```

Config lives at the top of `background.js` and `popup.js`. Keep the two in sync:

```js
const STRIP_PARAMS = ['range'];
const CUT_ANCHOR = '&ump';
```

---

## Privacy

- No analytics, no tracking, no external servers.
- The only network requests are the ones to the Drive stream URLs that the player
  already uses, and nothing else.
- ffmpeg is bundled locally in `vendor/ffmpeg/`, so no CDN is contacted, even for
  the merge.
- Captured URLs live in `chrome.storage.session` and are cleared when the browser
  closes. Nothing is written anywhere else.

---

## Limitations

- Streams are signed, IP bound, and expire. The popup shows the age of each capture
  and checks the link when the list opens or you hover a card. Only the streams the
  Drive player is actively using keep a fresh signature, so the playing quality is
  the most reliable one to download.
- `chrome.webRequest` can only observe; if Drive changes how it serves media, the
  capture may stop working.
- Downloads use Chrome's native downloader, so speed is the same as a normal download.
  The merge step still runs in WebAssembly and caps at 1.5 GB total.
- MP4 compatible tracks (H.264 + AAC) are remuxed into `.mp4`; WebM/VP9 or Opus
  tracks are remuxed into `.mkv` instead. Anything outside those combinations needs
  a real re-encode, which this does not do.
- This does not bypass permissions, DRM, or server-side playback restrictions.

---

## Legal Disclaimer & Acceptable Use Policy

Drive Video Grabber is an open-source utility intended for lawful, authorized
video-stream access, personal backups, interoperability, and testing.

### Permitted Uses

You may use this software only where you have the legal right or explicit
authorization to access, download, capture, or process the relevant media.
Examples may include:

- Downloading your own videos or content you have permission to save.
- Creating personal backups where permitted by the content owner and applicable law.
- Testing media playback, stream handling, and browser networking in authorized environments.
- Using media that is legally available for download or reuse.

### User Responsibilities

By installing or using this software, you acknowledge and agree that:

1. You are solely responsible for how you use the software and for ensuring
   compliance with applicable laws, copyright rules, contractual obligations, and
   the terms of the relevant website or service.
2. You must not use this software to infringe copyright, redistribute content
   without permission, circumvent access controls unlawfully, or violate a content
   owner's rights or restrictions.
3. Access to a video through a browser or network request does not automatically
   grant permission to download, copy, retain, or redistribute it.
4. You must obtain any permissions required for your intended use. When in doubt,
   contact the content owner or use an officially supported download method.
5. The author and contributors do not endorse or encourage unauthorized
   downloading, copyright infringement, or misuse of this software.

### No Affiliation or Warranty

Drive Video Grabber is an independent, community-developed project. It is not
affiliated with, endorsed by, or supported by Google or Google Drive.

The software is provided "AS IS", without warranties of any kind, to the extent
permitted by law. The author and contributors are not responsible for misuse by
users, disputes involving third-party content, or consequences arising from use of
the software.

### Important Notice

This disclaimer describes the project's intended use; it does not grant permission
to access or download any particular content, override third-party policies, or
guarantee that every use is lawful. The software's actual functionality and the
laws applicable to a specific use remain relevant.

**Use responsibly. Respect content owners' rights. Only download media you are
authorized to save.**

---

## Support

This project is free and open source. If it saved you time, you can send a small donation:

- **BEP20 (BNB Smart Chain):** `0x93Fe3b08aF6Ed4dc92Cf81A50ca75f36FDCEcE93`
- **TRC20 (Tron):** `TPTitWXdkDUE9BeUZvL8nZVKscMLZH9eog`

Send only assets on the matching network. A wrong network or coin can be lost.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, icons |
| `background.js` | `webRequest` capture, URL cleaning, per-tab state, downloads |
| `link.js` | shared text-page link extraction used by the worker and the merge page |
| `content.js` | reports page title and file id for filenames |
| `popup.html/css/js` | stream list, manual paste box, link check, native track downloads, merge controls |
| `merge.html/css/js` | stand-alone page: follows the downloads, picks both files and remuxes them in the tab |
| `donate.css/js` | shared donation dialog used by the popup and the merge page |
| `icons/` | `icon.svg` source plus 16 / 32 / 48 / 128 px PNGs for the toolbar |
| `vendor/ffmpeg/` | vendored `@ffmpeg/ffmpeg` 0.12.15 and `@ffmpeg/core` 0.12.10, no CDN |
"# Drive-Video-Grabber" 
