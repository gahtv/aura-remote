# Aura Remote

A phone-first remote for [Aura](https://github.com/gahtv/Aura), a Jellyfin music app for Android TV.
Opens in any browser on your LAN — Android, iOS, macOS, Windows — and behaves like Spotify Connect: the TV
is the endpoint that owns playback, the phone is a controller that reads its state and sends it intents.

No app store, no keypad pairing codes, no ADB for everyday use. One browser tab.

---

## What it does

| Feature | How |
|---|---|
| **Library** | Albums / artists / tracks with search, artist pages (albums + top tracks), album pages with "Play album". |
| **ATMOS badges** | Anything whose audio stream is `eac3` with a `JOC` or `Dolby Atmos` profile — the same rule Aura uses. Cached 24 h per server+user. |
| **Queue** | The endpoint's live queue and current index; tap a row to jump. |
| **Transport** | Play/pause/next/previous/seek, repeat and shuffle — semantic commands, not key presses. |
| **Lyrics** | A labelled **Lyrics** chip in Now Playing that fetches synced lyrics and follows the playhead. Independent of mirroring, and it lights up automatically when the TV switches to its lyrics view. |
| **Mirroring** | Aura publishes the screen it is on; the remote draws its own native version (album, artist, library tab, Now Playing with lyrics). Navigation travels both ways. The toggle lives in the top bar; the Remote and Queue tabs are exempt so you can drive the TV while mirroring, and re-applying a screen the remote is already showing is a no-op, so lists keep their scroll position. |
| **Cast fallback** | With no Aura running, tracks can be Cast to a TV or speaker through the bridge. |
| **Device picker** | Every Aura session and Cast target, with emulator sessions down-ranked and labelled. |
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
- **Aura serves a mirror link** on port 8099 while it is in the foreground — see [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Requirements

- **Aura** built with the mirror link (`ui/MirrorLink.kt` in the Aura repo). Without it the remote still
  browses the library and can Cast, but queue, transport and mirroring stay dark.
- **Jellyfin** 10.9+ (12.x tested), reachable from both the bridge and the browser.
- **Docker** with compose, on a machine that can reach the TV on your LAN.

## Quick start

```bash
git clone <this repo> aura-remote && cd aura-remote
cp .env.example .env          # fill in ALLOWED_SERVERS and AURA_LINK
cd server && docker compose up -d --build
```

Open `http://<bridge-host>:8100/`, sign in with a Jellyfin account, then press **Pair with TV**. Aura shows
an allow/deny prompt on the TV; approving it mints the token the bridge keeps from then on.

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
| `SESSIONS_FILE` | no | Where bridge sessions are stored (default `/data/sessions.json`). |
| `MIRROR_WIDTH` / `MIRROR_QUALITY` | no | Screenshot-fallback size (`960`, `70`). |

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

- **Aura**: `MirrorLink.unpair()` in the TV app clears its token (the bridge then gets 401s).
- **Bridge**: `POST /api/session/logout` from that device, or delete the entry in `/data/sessions.json`.

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
| POST | `/api/aura/input` | `{key}` — D-pad, dispatched inside the app. |
| GET / POST | `/api/aura/paired`, `/api/aura/pair` | Pairing status and request. |
| GET | `/api/targets` | Cast targets. |
| POST | `/api/load`, `/api/transport`, `/api/seek` | Cast playback. |
| GET | `/api/status?device=` | Now playing on a Cast target. |
| POST | `/api/launch` | Start Aura (requires `ADB_SERIAL`). |
| GET | `/api/tvstate`, `/api/screen` | Accessibility-tree dump / JPEG frame fallback. |

## Development

```bash
cd server
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
AURA_LINK=127.0.0.1:9099 ./.venv/bin/uvicorn app:app --port 8098
```

To iterate against an emulator, forward Aura's port and point the bridge at localhost:

```bash
adb -s emulator-5554 forward tcp:9099 tcp:8099
```

The UI is plain HTML/CSS/JS with no build step, and the compose file bind-mounts `server/web`, so edits are
live.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AURA_LINK is not configured` | `.env` has no `AURA_LINK`. |
| `Aura mirror link unreachable` | Aura is not in the foreground, or the installed build predates the mirror link. |
| `bridge login required` | Session cookie expired, or `ALLOWED_SERVERS` does not match the URL you signed in with. |
| `the TV is showing an ADB authorization prompt` | First auto-launch; approve on the TV once, the key persists in `adb-keys/`. |
| Cast target missing | mDNS filtered; add the host to `STATIC_TARGETS`. |
| Mirror shows an album you did not pick | Mirroring is two-way and Aura drove it; turn mirroring off to drive the remote independently. |

## Limitations

- Single-user: any bridge session can control the TV.
- Auto-launch is the only ADB-dependent feature; replacing it with the Android TV Remote v2 protocol
  (PIN pairing) is the obvious next step.
- The queue is a 2 s poll, not a live subscription.
- No offline mode: the UI is served over HTTP, so there is no service worker.

## License

MIT.
