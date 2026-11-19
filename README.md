# Aura Remote

A phone-first remote for [Aura](https://github.com/gahtv/Aura), a Jellyfin music app for Android TV.
Opens in any browser on your LAN — Android, iOS, macOS, Windows — and behaves like Spotify Connect: the TV
is the endpoint that owns playback, the phone is a controller that reads its state and sends it intents.

No app store, no keypad pairing codes, no ADB for everyday use. One browser tab.

## Status

Version **0.3.0**, pre-release, built for one household on a trusted LAN. Works with Aura
**v0.2.0-alpha.3 or later** (the first release with the mirror link and on-TV pairing); the latest is
v0.5.0-alpha.1. Aura's [roadmap](https://github.com/gahtv/Aura/blob/main/docs/ROADMAP.md) plans live
state instead of polling; retiring ADB is this repo's own next step (see Limitations).

Jellyfin bios, word-by-word (karaoke) lyrics with duet voices and play history come straight from
Jellyfin, so they work with any Aura version. Aura `main` has since added lyric extras the Remote does
not draw yet (translation and romanization sub-lines, instrumental-break dots, song-part spacing and
credits); see Limitations.

---

## What it does

| Feature | How |
|---|---|
| **Library** | Albums / artists / tracks with search, artist pages (albums + top tracks), album pages with "Play album". Album and artist pages show the Jellyfin bio (tap to expand). Artist pages also show Jellyfin logos and banners when available, using the first backdrop if there is no usable banner. |
| **Recent** | A Library tab with Jellyfin's play history, newest first — the same history as Aura's "Recently played" shelf. Opening it while mirroring takes the TV to Home, where that shelf lives. |
| **ATMOS badges** | Anything whose audio stream is `eac3` with a `JOC` or `Dolby Atmos` profile — the same rule Aura uses. Cached 24 h per server+user. |
| **Queue** | The endpoint's live queue and current index; tap a row to jump. |
| **Transport** | Play/pause/next/previous/seek, repeat and shuffle — semantic commands, not key presses. |
| **Lyrics** | A labelled **Lyrics** chip in Now Playing that follows the playhead. Reads line-synced LRC, word-timed (enhanced) LRC, Jellyfin word cues and TTML from Jellyfin, including lyrics saved with Aura's **Find lyrics**. Word-timed lines fill in word by word; singer markers (`v1:`/`v2:`, TTML agents) put the second voice on the right and group lines in the middle. Unsynced lyrics are listed without a highlight. Independent of mirroring, and it lights up automatically when the TV switches to its lyrics view. |
| **Mirroring** | Aura publishes the screen it is on; the remote draws its own native version (album, artist, library tab, Now Playing with lyrics). Navigation travels both ways. The toggle lives in the top bar; the Remote and Queue tabs are exempt so you can drive the TV while mirroring, and re-applying a screen the remote is already showing is a no-op, so lists keep their scroll position. |
| **Cast fallback** | Pick a Cast TV or speaker in the device picker and the bridge plays to it: the first track of what you pick (Cast has no queue here), with play/pause, stop and seek. The picker falls back to Cast on its own when no Aura session is found. |
| **Device picker** | Every Aura session and Cast target, with emulator sessions down-ranked and labelled. Controls follow the pick: the bridge's `AURA_LINK` TV is driven over the mirror link, any other Aura through Jellyfin's remote control (transport, seek, shuffle, repeat and its Jellyfin queue; no D-pad or mirroring). |
| **Launch** | Optional: start Aura if it is not running (needs ADB — see Limitations). |

## Architecture

```
┌──────────────┐   session cookie  ┌──────────────┐   X-Aura-Token    ┌──────────────┐
│   Browser    │ ────────────────► │    Bridge    │ ────────────────► │  Aura (TV)   │
│   (this PWA) │ ◄──────────────── │  (FastAPI)   │ ◄──────────────── │    :8099     │
└──────────────┘                   └──────────────┘                   └──────────────┘
        │                                  │
        │ Jellyfin REST (auth, library)    │ Cast / ADB (optional)
        ▼                                  ▼
   ┌──────────┐                     ┌──────────────┐
   │ Jellyfin │                     │ Cast targets │
   └──────────┘                     └──────────────┘
```

- **The browser talks to Jellyfin directly** for login and the library (Jellyfin sends
  `Access-Control-Allow-Origin: *`). It uses the bridge for everything a browser cannot do: the
  authenticated Aura link, Cast, and optional ADB.
- **The bridge holds two secrets the browser never sees**: the Aura pairing token and its own session store.
  It calls Jellyfin only once per sign-in, to check the browser's token (`/Users/Me`) before issuing a session.
- **Controls follow the device picker.** Only the `AURA_LINK` TV is reached over the mirror link (matched by
  address, then by device name); any other Aura session is driven through Jellyfin's remote-control API, and
  Cast targets through the bridge.
- **Aura serves a mirror link** on port 8099 once it has been opened — see [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Requirements

- **Aura** v0.2.0-alpha.3 or later, which serves the mirror link (`remote/MirrorServer.kt` in the Aura
  repo). Without it the remote still browses the library, controls Aura through Jellyfin and can Cast, but
  the D-pad and mirroring stay dark.
- **Jellyfin** 10.9+ (tested on 10.10, 12.2 and 12.4), reachable from both the bridge and the browser.
- **Docker** with compose, on a machine that can reach the TV on your LAN.

## Quick start

```bash
git clone <this repo> aura-remote && cd aura-remote
cp .env.example .env          # fill in ALLOWED_SERVERS and AURA_LINK
cd server && docker compose up -d --build
```

Open `http://<bridge-host>:8100/`, sign in with a Jellyfin account, then press **Pair with TV**. Aura shows
an allow/deny prompt on the TV; approving it mints the token the bridge keeps from then on.

To sign in without a password, fill in the Jellyfin server and choose **Use Quick Connect**.
On a signed-in Jellyfin device, open your profile → **Quick Connect** and enter the displayed
code within five minutes. Quick Connect must be enabled on the server.

## Configuration

Everything lives in `.env` at the repo root — see [`.env.example`](.env.example). Nothing is hardcoded, and
each feature reports itself as unconfigured until its value is set (`GET /api/config` tells the UI what is
available).

| Variable | Required | Meaning |
|---|---|---|
| `ALLOWED_SERVERS` | yes | Comma-separated Jellyfin origins the bridge will authenticate against. |
| `DEFAULT_JELLYFIN_URL` | no | Prefilled in the sign-in form. |
| `AURA_LINK` | for Connect features | `<tv-ip>:8099` — Aura's mirror link. |
| `ADB_SERIAL` | no | `<tv-ip>:5555` — only for launching Aura when it is not running. |
| `STATIC_TARGETS` | no | Cast hosts to probe when mDNS is filtered (bridged Docker). |
| `BRIDGE_PORT` | no | Host port for the UI/API (default `8100`). |
| `AURA_TOKEN_FILE` | no | Where the pairing token is stored (default `/data/aura_token`). |
| `AURA_TOKEN` | no | A pairing token to use instead of the file (skips pairing; not saved). |
| `AURA_ACTIVITY` | no | Activity `/api/launch` starts (default `com.hans.aura/.MainActivity`). |
| `SESSIONS_FILE` | no | Where bridge sessions are stored (default `/data/sessions.json`). |

## Security model

Three credentials, none shared with the wrong party:

1. **Jellyfin token** — lives in the browser's `localStorage` because the PWA calls the Jellyfin API
   directly. It is exchanged *once* for a bridge session and never stored by the bridge.
2. **Bridge session** — `HttpOnly`, `SameSite=Strict` cookie, 30 days, stored server-side in
   `/data/sessions.json`. Every `/api/*` route except `/api/health`, `/api/config` and `/api/session*`
   requires it, and JavaScript cannot read it.
3. **Aura pairing token** — minted only when someone approves the prompt **on the TV**; stored in Aura's
   prefs and in `/data/aura_token` (0600). It never leaves the bridge, so a browser cannot replay it.

Revoking access:

- **Aura**: approving another bridge's pairing replaces the token, and the old bridge gets 401s. The TV
  has no unpair button yet.
- **Bridge**: the PWA's **Sign out** button (top bar), `POST /api/session/logout` from that device, or
  delete the entry in `/data/sessions.json`.

Caveats: the bridge speaks plain HTTP on the LAN, so the cookie has no `Secure` flag and travels
unencrypted — put TLS in front if you expose it beyond a trusted network. Aura's mirror link is likewise
plain HTTP, protected only by the token.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | What this bridge is configured for (no secrets). |
| GET | `/api/health` | Liveness. |
| POST | `/api/session/login` | `{server, token}` → sets the session cookie. |
| GET | `/api/session` | Is this browser signed in? |
| POST | `/api/session/logout` | Drop the session. |
| GET | `/api/aura/state` | Aura's screen, playback and queue. |
| POST | `/api/aura/control` | `{action}` — play/pause/next/prev/seek/skip/shuffle/repeat. |
| POST | `/api/aura/navigate` | `{screen, itemId}` — move the TV. |
| POST | `/api/aura/input` | `{key}` — `up`/`down`/`left`/`right`/`center`/`back`/`home`/`playpause`, dispatched inside the app. |
| GET | `/api/aura/paired` | Whether the bridge holds a pairing token, and its `AURA_LINK`. |
| POST | `/api/aura/pair` | `{name}` — asks the TV; blocks until someone answers the prompt (up to 90 s). |
| GET | `/api/targets` | Cast targets. |
| POST | `/api/load`, `/api/transport`, `/api/seek`, `/api/volume` | Cast playback (`/api/volume` is API-only; the UI has no volume control). |
| GET | `/api/status?device=` | Now playing on a Cast target. |
| POST | `/api/launch` | Start Aura (requires `ADB_SERIAL`). |

The bridge still serves the old ADB mirroring endpoints, replaced by `/api/aura/*`. They are deprecated and
left out here; the bridge's `/docs` page lists them.

## Development

```bash
cd server
python3.12 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # pychromecast 14 needs Python 3.11+
AURA_LINK=127.0.0.1:9099 ./.venv/bin/uvicorn app:app --port 8098
```

To iterate against an emulator, forward Aura's port and point the bridge at localhost:

```bash
adb -s emulator-5554 forward tcp:9099 tcp:8099
```

The UI is plain HTML/CSS/JS with no build step, and the compose file bind-mounts `server/web`, so edits are
live.

The web tests need only Node 18+: they load the real `server/web` scripts against a stub DOM.
Run the bridge tests with Python and the server's dev requirements.

```bash
node --test tests/*.test.js
server/.venv/bin/python -m pip install -r server/requirements-dev.txt
server/.venv/bin/python -m pytest tests/test_cast_discovery.py
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AURA_LINK is not configured` | `.env` has no `AURA_LINK`. |
| `Aura mirror link unreachable` | Aura has not been opened since the TV started (or Android stopped it), or the build predates the mirror link. With `HTTP Error 401` in the message, the TV no longer accepts the bridge's token: pair again. |
| `This remote isn't paired with the TV yet` | Press **Pair with TV**. Aura keeps one token, so pairing another bridge with the same TV unpairs this one. |
| D-pad says it only reaches one TV | The picked Aura is not the `AURA_LINK` TV; pick that TV, or point `AURA_LINK` at the other one. |
| `bridge login required` | Session cookie expired, or `ALLOWED_SERVERS` does not match the URL you signed in with. |
| `the TV is showing an ADB authorization prompt` | First auto-launch; approve on the TV once, the key persists in `adb-keys/`. |
| Cast target missing | mDNS filtered; add the host to `STATIC_TARGETS`. |
| Mirror shows an album you did not pick | Mirroring is two-way and Aura drove it; turn mirroring off to drive the remote independently. |

## Limitations

- Single-user: any bridge session can control the TV.
- One linked TV per bridge (`AURA_LINK`), and one paired bridge per TV. Other Aura TVs get Jellyfin remote
  control only: no D-pad, mirroring, or exact queue jumps.
- Cast plays one track at a time; there is no Cast queue, and Cast plays are not reported to Jellyfin, so
  they do not show up under **Recent**.
- Lyrics show the sung lines only. Aura's translation and romanization sub-lines, instrumental-break dots,
  song-part spacing and credits are TV-only. An LRC translation sharing its lead line's timestamp shows as a
  separate line that takes the highlight, a blank LRC timestamp shows as an empty row, and an inline TTML
  romanization (`x-roman` span) is run into its line's text.
- Lyrics Aura finds through its optional LRCLIB lookup stay on the TV; the Remote shows only what Jellyfin has.
- Word highlights run on a local clock between Jellyfin's progress reports, so they can drift by up to
  a poll (2 s) after a seek on the TV.
- Auto-launch is the only ADB-dependent feature; replacing it with the Android TV Remote v2 protocol
  (PIN pairing) is the obvious next step.
- The queue is a 2 s poll, not a live subscription.
- No offline mode: the UI is served over HTTP, so there is no service worker.

## License

MIT.
