# The Aura mirror-link protocol

This is the contract between the bridge and the TV app. It is implemented server-side by Aura
(`remote/MirrorServer.kt`, behind the `ui/MirrorLink.kt` facade, in the
[Aura repo](https://github.com/gahtv/Aura)) and consumed here by `server/app.py`. Every Aura release since
v0.2.0-alpha.3 speaks it as described here.

Aura starts serving it on **port 8099** when its activity is created and keeps listening for as long as the
app's process lives. Before Aura is opened, or after Android stops it, nothing listens — that absence is
also how a client knows the app is not running.

## Why a link at all

A browser can drive Jellyfin, but it cannot ask an Android app "which screen are you on?" or "pause the
thing you are playing". The link answers both, and it is deliberately tiny: a hand-rolled HTTP/1.0 server
with five endpoints, a health check and a pairing gate.

## Endpoints

### `GET /state`

```json
{
  "deviceName": "Living Room TV",
  "screen": "nowplaying",
  "itemId": null,
  "title": null,
  "lyrics": true,
  "playing": true,
  "positionMs": 4193,
  "durationMs": 210000,
  "shuffle": false,
  "repeat": 0,
  "trackId": "…",
  "trackTitle": "Vanessa",
  "trackArtist": "…",
  "queueIndex": 0,
  "queue": [{ "id": "…", "title": "Vanessa", "artist": "…" }]
}
```

- `screen` is one of `home`, `artists`, `albums`, `tracks`, `playlists`, `search`, `settings`,
  `nowplaying`, `queue`, `collection`, `artist`. Aura's genre screens publish as `albums`.
- `itemId` is set only for `collection` and `artist`. `title` is currently always `null`.
- With no player bound yet, `playing` is `false`, the positions are `0` and the `track*` fields are `null`.
- `lyrics` is true when Now Playing is showing lyrics rather than artwork — this is what lets a remote
  mirror the lyrics view exactly when the TV does.
- `repeat`: `0` none, `1` one, `2` all. `queue` is capped at 300 entries; `queueIndex` is the player's
  real index and can point past the returned list.

### `POST /navigate?screen=<name>&itemId=<id>`

Moves the TV. `screen` uses the same vocabulary as above (default `home`); `itemId` is required for
`collection`/`artist`, which Aura fetches from Jellyfin before jumping. Library tabs, `search` and `settings`
replace the back stack; `nowplaying` and `queue` push onto it. Always returns `204`: an unknown screen, or an
item screen without a valid `itemId`, is ignored.

### `POST /control?action=<action>[&params]`

Semantic playback commands — the Connect-style half. Actions:

| Action | Extra params | Effect |
|---|---|---|
| `play` / `pause` / `playpause` | — | Transport |
| `next` / `prev` | — | Track skip |
| `seek` | `position=<ms>` | Absolute seek |
| `skip` | `index=<n>` | Jump within the queue |
| `shuffle` | `on=true\|false` | Shuffle |
| `repeat` | `mode=0\|1\|2` | Repeat mode |

All are queued onto Aura's main thread, so `204` means accepted, not yet applied; a missing or invalid
numeric parameter is also accepted and then ignored. Returns `400` for an unknown action or when no player
is bound yet.

### `POST /input?key=<key>`

`up`, `down`, `left`, `right`, `select`, `back`, `playpause`, `home`. Aura dispatches these as `KeyEvent`s
**inside its own process** — no ADB, no USB debugging. `home` means Aura's Home screen, not the Android
launcher. Any other key, or no Aura activity to dispatch into, returns `400`. The bridge's `/api/aura/input`
takes `center` for the middle D-pad button and sends it as `select`.

### `POST /pair/request?name=<device name>`

Returns `{"token": "...", "device": "..."}` after someone approves the prompt on the TV, `403` if they
deny, press BACK, or ignore it for 90 seconds. The token is what `/state`, `/control`, `/navigate` and
`/input` expect in the `X-Aura-Token` header; `/health` and `/pair/request` are the only open endpoints.
Without a valid token they answer `401` (`{"error":"unauthorized"}`). Aura keeps a single token: approving a
new request replaces it, so the previously paired client starts getting `401`. Unknown paths return `404`.
Aura answers one request at a time, so other requests wait while a pairing prompt is open; give
`/pair/request` a timeout above 90 seconds (the bridge uses 100).

### `GET /health`

`ok`, unauthenticated, for liveness checks.

## Client rules

- **Poll `/state` at 1–2 Hz.** There is no push channel; a subscription would be the next improvement.
- **Pair once and store the token server-side.** The bridge keeps it in `/data/aura_token` (0600) and never
  forwards it to a browser.
- **Treat 401 as "not paired"** and re-run `/pair/request` rather than retrying blindly.
- **Do not send keystrokes for library actions.** Prefer `/navigate` + `/control`; `/input` exists for
  free-form D-pad use, and every press is a synthetic key inside the app.
