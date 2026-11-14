# The Aura mirror-link protocol

This is the contract between the bridge and the TV app. It is implemented server-side by Aura
(`ui/MirrorLink.kt`, in the [Aura repo](https://github.com/gahtv/Aura)) and consumed here by
`server/app.py`.

Aura serves it on **port 8099** while it is in the foreground. When Aura is closed, nothing listens — that
absence is also how a client knows the app is not running.

## Why a link at all

A browser can drive Jellyfin, but it cannot ask an Android app "which screen are you on?" or "pause the
thing you are playing". The link answers both, and it is deliberately tiny: a hand-rolled HTTP/1.0 server
with four endpoints and a pairing gate.

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
  `nowplaying`, `queue`, `collection`, `artist`.
- `itemId` is set only for `collection` and `artist`.
- `lyrics` is true when Now Playing is showing lyrics rather than artwork — this is what lets a remote
  mirror the lyrics view exactly when the TV does.
- `repeat`: `0` none, `1` one, `2` all. `queue` is capped at 300 entries.

### `POST /navigate?screen=<name>&itemId=<id>`

Moves the TV. `screen` uses the same vocabulary as above; `itemId` is required for `collection`/`artist`.
Returns `204`.

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

All are applied on Aura's main thread. Returns `204` on success, `400` for an unknown action.

### `POST /input?key=<key>`

`up`, `down`, `left`, `right`, `select`, `back`, `playpause`, `home`. Aura dispatches these as `KeyEvent`s
**inside its own process** — no ADB, no USB debugging. `home` means Aura's Home screen, not the Android
launcher.

### `POST /pair/request?name=<device name>`

Returns `{"token": "...", "device": "..."}` after someone approves the prompt on the TV, `403` if they
deny, press BACK, or ignore it for 90 seconds. The token is what `/state`, `/control`, `/navigate` and
`/input` expect in the `X-Aura-Token` header; `/health` and `/pair/request` are the only open endpoints.

### `GET /health`

`ok`, unauthenticated, for liveness checks.

## Client rules

- **Poll `/state` at 1–2 Hz.** There is no push channel; a subscription would be the next improvement.
- **Pair once and store the token server-side.** The bridge keeps it in `/data/aura_token` (0600) and never
  forwards it to a browser.
- **Treat 401 as "not paired"** and re-run `/pair/request` rather than retrying blindly.
- **Do not send keystrokes for library actions.** Prefer `/navigate` + `/control`; `/input` exists for
  free-form D-pad use, and every press is a synthetic key inside the app.
