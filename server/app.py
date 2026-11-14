"""
Aura Remote — cast bridge.

The browser can drive Aura directly (Jellyfin's remote-control protocol, CORS is
open). What a browser cannot do is talk Cast, especially on iOS. This service
does that part: it discovers Cast targets, loads a URL onto one, and reports
status. The PWA calls it only when no Aura session is available.

Runs on the LAN next to the TVs — pychromecast needs multicast, so the container
uses host networking.
"""

import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Literal, Optional

import pychromecast
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DEFAULT_MEDIA_RECEIVER = "CC1AD845"
DISCOVERY_TTL = 60.0
# Keep this in step with VERSION in web/app.js — both end up in Jellyfin's device list.
BRIDGE_VERSION = "0.2.0"

# Fallback discovery: when the container cannot see mDNS multicast (bridged
# networking), reach these hosts directly over their Cast setup endpoint.
STATIC_TARGETS = [
    h.strip() for h in os.environ.get("STATIC_TARGETS", "").split(",")
    if h.strip()
]

# Android TV control (launching Aura when it is not running).
# Optional: only used to launch Aura when it is not running.
ADB_SERIAL = os.environ.get("ADB_SERIAL", "")
# Aura's mirror link (ui/MirrorLink.kt) — required for the Connect-style features.
AURA_LINK = os.environ.get("AURA_LINK", "")
AURA_TOKEN_FILE = os.environ.get("AURA_TOKEN_FILE", "/data/aura_token")

# Bridge sessions: the browser proves who it is with a Jellyfin token, and the
# bridge hands back an HttpOnly cookie. The Jellyfin token never lands in a
# cookie, and the Aura token never reaches the client at all.
SESSIONS_FILE = os.environ.get("SESSIONS_FILE", "/data/sessions.json")
SESSION_TTL = 30 * 24 * 3600
ALLOWED_SERVERS = [
    s.strip().rstrip("/")
    for s in os.environ.get("ALLOWED_SERVERS", "").split(",")
    if s.strip()
]
DEFAULT_JELLYFIN_URL = os.environ.get("DEFAULT_JELLYFIN_URL", "").rstrip("/")

_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def _load_sessions() -> None:
    global _sessions
    try:
        with open(SESSIONS_FILE) as fh:
            data = json.load(fh)
        now = time.time()
        _sessions = {k: v for k, v in data.items() if now - v.get("created", 0) < SESSION_TTL}
    except (OSError, json.JSONDecodeError):
        _sessions = {}


def _save_sessions() -> None:
    try:
        os.makedirs(os.path.dirname(SESSIONS_FILE), exist_ok=True)
        with open(SESSIONS_FILE, "w") as fh:
            json.dump(_sessions, fh)
        os.chmod(SESSIONS_FILE, 0o600)
    except OSError:
        pass


_load_sessions()


def _load_token() -> str:
    token = os.environ.get("AURA_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(AURA_TOKEN_FILE) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _save_token(token: str) -> None:
    global _AURA_TOKEN
    _AURA_TOKEN = token
    try:
        os.makedirs(os.path.dirname(AURA_TOKEN_FILE), exist_ok=True)
        with open(AURA_TOKEN_FILE, "w") as fh:
            fh.write(token)
        os.chmod(AURA_TOKEN_FILE, 0o600)
    except OSError:
        pass


_AURA_TOKEN = _load_token()


def _aura_request(path: str, method: str = "GET", timeout: float = 4.0):
    if not AURA_LINK:
        raise HTTPException(503, "AURA_LINK is not configured")
    req = urllib.request.Request(f"http://{AURA_LINK}{path}", method=method)
    if _AURA_TOKEN:
        req.add_header("X-Aura-Token", _AURA_TOKEN)
    return urllib.request.urlopen(req, timeout=timeout)
AURA_ACTIVITY = os.environ.get("AURA_ACTIVITY", "com.hans.aura/.MainActivity")
ADB_TIMEOUT = 12

app = FastAPI(title="Aura Remote Bridge", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class Device:
    name: str
    host: str
    port: int
    model: str
    cast: object = field(repr=False)


_lock = threading.Lock()
_cache: list[Device] = []
_cache_at: float = 0.0


def _static_devices() -> list[Device]:
    """Probe known Cast hosts directly — no multicast required."""
    found: list[Device] = []
    for host in STATIC_TARGETS:
        try:
            with urllib.request.urlopen(
                f"http://{host}:8008/setup/eureka_info?params=detail", timeout=3
            ) as resp:
                info = json.load(resp)
        except Exception:  # noqa: BLE001 - unreachable host is normal
            continue
        name = info.get("name") or host
        udn = info.get("ssdp_udn") or ""
        uuid = udn.split(":")[-1] if udn else None
        try:
            cast = pychromecast.get_chromecast_from_host(
                (host, 8009, uuid, info.get("model_name"), name)
            )
        except Exception:  # noqa: BLE001
            continue
        found.append(Device(name=name, host=host, port=8009, model=info.get("model_name") or "", cast=cast))
    return found


def _discover(force: bool = False) -> list[Device]:
    global _cache, _cache_at
    with _lock:
        if not force and _cache and (time.time() - _cache_at) < DISCOVERY_TTL:
            return _cache

        devices: list[Device] = []
        try:
            casts, browser = pychromecast.get_chromecasts(tries=2, retry_wait=1)
            pychromecast.discovery.stop_discovery(browser)
            devices = [
                Device(
                    name=c.cast_info.friendly_name,
                    host=c.cast_info.host,
                    port=c.cast_info.port,
                    model=c.cast_info.model_name,
                    cast=c,
                )
                for c in casts
            ]
        except Exception:  # noqa: BLE001 - multicast unavailable in bridged mode
            devices = []

        known = {d.host for d in devices}
        try:
            devices += [d for d in _static_devices() if d.host not in known]
        except Exception:  # noqa: BLE001
            pass

        _cache = devices
        _cache_at = time.time()
        return _cache


def _find(name: str) -> Device:
    devices = _discover()
    exact = [d for d in devices if d.name.lower() == name.lower()]
    matches = exact or [d for d in devices if name.lower() in d.name.lower()]
    if not matches:
        raise HTTPException(404, f"no cast target matching {name!r}")
    if len(matches) > 1:
        raise HTTPException(409, "ambiguous target: " + ", ".join(d.name for d in matches))
    device = matches[0]
    try:
        device.cast.wait(timeout=10)
    except Exception:  # noqa: BLE001 - idle devices answer late; status will tell
        pass
    return device


class LoadRequest(BaseModel):
    device: str
    url: str
    content_type: str = "audio/mp4"


class TransportRequest(BaseModel):
    device: str
    action: Literal["play", "pause", "playpause", "stop", "next", "prev"]


class VolumeRequest(BaseModel):
    device: str
    level: float


class SeekRequest(BaseModel):
    device: str
    position_s: float


@app.get("/api/targets")
def targets():
    out = []
    for d in _discover():
        out.append({"name": d.name, "model": d.model, "host": d.host})
    out.sort(key=lambda d: d["name"])
    return {"targets": out}


@app.post("/api/load")
def load(req: LoadRequest):
    device = _find(req.device)
    cc = device.cast
    cc.media_controller.play_media(req.url, req.content_type)
    try:
        cc.media_controller.block_until_active(timeout=12)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"target refused the load: {exc}") from exc
    return {"ok": True, "device": device.name, "url": req.url}


@app.post("/api/transport")
def transport(req: TransportRequest):
    device = _find(req.device)
    mc = device.cast.media_controller
    try:
        if req.action == "play":
            mc.play()
        elif req.action == "pause":
            mc.pause()
        elif req.action == "playpause":
            mc.pause() if mc.status.player_is_playing else mc.play()
        elif req.action == "stop":
            try:
                mc.stop()
            except Exception:  # noqa: BLE001 - nothing playing, or receiver already idle
                device.cast.quit_app()
        elif req.action == "next":
            mc.queue_next()
        elif req.action == "prev":
            mc.queue_prev()
        else:
            raise HTTPException(400, "unknown action")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - idle receivers reject transport calls
        raise HTTPException(502, f"{req.action} failed: {exc}") from exc
    return {"ok": True}


@app.post("/api/volume")
def volume(req: VolumeRequest):
    device = _find(req.device)
    level = max(0.0, min(1.0, req.level))
    device.cast.set_volume(level)
    return {"ok": True, "level": level}


@app.post("/api/seek")
def seek(req: SeekRequest):
    device = _find(req.device)
    device.cast.media_controller.seek(max(0.0, req.position_s))
    return {"ok": True}


@app.get("/api/status")
def status(device: str):
    d = _find(device)
    cc = d.cast
    try:
        st = cc.media_controller.status
        volume = cc.status.volume_level
    except Exception:  # noqa: BLE001 - asleep or unreachable target is not an error
        return {
            "device": d.name,
            "reachable": False,
            "playing": False,
            "paused": False,
            "idle": True,
            "position_s": 0.0,
            "duration_s": None,
            "title": None,
            "artist": None,
            "album": None,
            "volume": None,
        }
    return {
        "device": d.name,
        "reachable": True,
        "playing": st.player_is_playing,
        "paused": st.player_is_paused,
        "idle": st.player_is_idle,
        "position_s": round(st.adjusted_current_time or 0.0, 1),
        "duration_s": None,
        "title": st.title,
        "artist": st.artist,
        "album": st.album_name,
        "volume": volume,
    }


@app.middleware("http")
async def require_bridge_session(request: Request, call_next):
    """Every API call except health/session needs a bridge session cookie."""
    path = request.url.path
    open_paths = ("/api/health", "/api/session", "/api/config")
    if path.startswith("/api/") and not path.startswith(open_paths):
        sid = request.cookies.get("aura_remote")
        with _sessions_lock:
            session = _sessions.get(sid) if sid else None
        if not session or time.time() - session.get("created", 0) > SESSION_TTL:
            return JSONResponse({"detail": "bridge login required"}, status_code=401)
    return await call_next(request)


class BridgeLogin(BaseModel):
    server: str
    token: str


def _jellyfin_me(server: str, token: str) -> dict:
    req = urllib.request.Request(
        f"{server}/Users/Me",
        headers={"Authorization": f'MediaBrowser Client="Aura Remote", Device="Bridge", '
                                 f'DeviceId="bridge", Version="{BRIDGE_VERSION}", Token="{token}"'},
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        return json.load(resp)


@app.post("/api/session/login")
def session_login(req: BridgeLogin, response: Response):
    """Jellyfin is the identity provider: a valid token buys a bridge cookie."""
    server = req.server.rstrip("/")
    if not ALLOWED_SERVERS:
        raise HTTPException(503, "ALLOWED_SERVERS is not configured")
    if server not in ALLOWED_SERVERS:
        raise HTTPException(400, "server not allowed")

    try:
        me = _jellyfin_me(server, req.token)
    except urllib.error.HTTPError as exc:
        raise HTTPException(401, "Jellyfin rejected the token") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Jellyfin unreachable: {exc}") from exc

    sid = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[sid] = {"user": me.get("Name", "user"), "server": server, "created": time.time()}
        _save_sessions()

    response.set_cookie(
        "aura_remote", sid, max_age=SESSION_TTL, httponly=True, samesite="strict", path="/"
    )
    return {"authenticated": True, "user": me.get("Name"), "device": me.get("DeviceName")}


@app.get("/api/session")
def session_state(request: Request):
    sid = request.cookies.get("aura_remote")
    with _sessions_lock:
        session = _sessions.get(sid) if sid else None
    if not session:
        return {"authenticated": False}
    return {"authenticated": True, "user": session.get("user"), "since": session.get("created")}


@app.post("/api/session/logout")
def session_logout(request: Request, response: Response):
    sid = request.cookies.get("aura_remote")
    with _sessions_lock:
        if sid:
            _sessions.pop(sid, None)
            _save_sessions()
    response.delete_cookie("aura_remote", path="/")
    return {"authenticated": False}


@app.get("/api/config")
def config():
    """What this bridge is configured for — no secrets, just capabilities."""
    return {
        "defaultServer": DEFAULT_JELLYFIN_URL,
        "auraConfigured": bool(AURA_LINK),
        "adbConfigured": bool(ADB_SERIAL),
        "castTargets": STATIC_TARGETS,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "devices": len(_cache)}


# ---------------- Android TV input + view mirroring ----------------

KEY_CODES = {
    "up": "KEYCODE_DPAD_UP",
    "down": "KEYCODE_DPAD_DOWN",
    "left": "KEYCODE_DPAD_LEFT",
    "right": "KEYCODE_DPAD_RIGHT",
    "center": "KEYCODE_DPAD_CENTER",
    "back": "KEYCODE_BACK",
    "home": "KEYCODE_HOME",
    "playpause": "KEYCODE_MEDIA_PLAY_PAUSE",
    "next": "KEYCODE_MEDIA_NEXT",
    "prev": "KEYCODE_MEDIA_PREVIOUS",
    "wake": "KEYCODE_WAKEUP",
}


class KeyRequest(BaseModel):
    key: Literal["up", "down", "left", "right", "center", "back", "home",
                 "playpause", "next", "prev", "wake"]


@app.post("/api/aura/input")
def aura_input(req: "KeyRequest"):
    """D-pad etc. dispatched inside the running app — no ADB, no dev options."""
    try:
        _aura_request(f"/input?{urllib.parse.urlencode({'key': req.key})}", method="POST").read()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Aura mirror link unreachable: {exc}") from exc
    return {"ok": True}


@app.post("/api/key")
def key(req: KeyRequest):
    ok, message = _adb_connect()
    if not ok:
        raise HTTPException(503, message)
    code = KEY_CODES[req.key]
    result = _adb("-s", ADB_SERIAL, "shell", "input", "keyevent", code)
    if result.returncode != 0:
        raise HTTPException(502, (result.stderr or "keyevent failed")[:160])
    return {"ok": True, "key": code}


_screen_lock = threading.Lock()
_screen_cache: dict = {"at": 0.0, "jpeg": b""}
MIRROR_WIDTH = int(os.environ.get("MIRROR_WIDTH", "960"))
MIRROR_QUALITY = int(os.environ.get("MIRROR_QUALITY", "70"))


def _to_jpeg(png: bytes) -> bytes:
    """Full-res screencap is ~1.3 MB; the mirror needs ~60 KB per frame."""
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(png)) as img:
        img = img.convert("RGB")
        if img.width > MIRROR_WIDTH:
            height = int(img.height * (MIRROR_WIDTH / img.width))
            img = img.resize((MIRROR_WIDTH, height), Image.LANCZOS)
        out = BytesIO()
        img.save(out, format="JPEG", quality=MIRROR_QUALITY, optimize=True)
        return out.getvalue()


@app.get("/api/screen")
def screen():
    """One frame of the TV, for the mirror view. adb screencap caps this at ~1 fps."""
    _require_adb()
    ok, message = _adb_connect()
    if not ok:
        raise HTTPException(503, message)

    with _screen_lock:
        if time.time() - _screen_cache["at"] < 0.8 and _screen_cache["jpeg"]:
            return Response(content=_screen_cache["jpeg"], media_type="image/jpeg",
                            headers={"Cache-Control": "no-store"})

        result = subprocess.run(
            ["adb", "-s", ADB_SERIAL, "exec-out", "screencap", "-p"],
            capture_output=True, timeout=ADB_TIMEOUT,
        )
        if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG"):
            raise HTTPException(502, "screen capture unavailable")

        try:
            jpeg = _to_jpeg(result.stdout)
        except Exception:  # noqa: BLE001 - Pillow missing or decode failure
            jpeg = b""

        if jpeg:
            _screen_cache["jpeg"] = jpeg
            _screen_cache["at"] = time.time()
            return Response(content=jpeg, media_type="image/jpeg",
                            headers={"Cache-Control": "no-store"})

        # Fallback: send the raw PNG so mirroring still works without Pillow.
        _screen_cache["jpeg"] = b""
        return Response(content=result.stdout, media_type="image/png",
                        headers={"Cache-Control": "no-store"})



# ---------------- Android TV control ----------------

def _require_adb() -> None:
    if not ADB_SERIAL:
        raise HTTPException(503, "ADB_SERIAL is not configured (optional: only used to launch Aura)")


def _require_aura() -> None:
    if not AURA_LINK:
        raise HTTPException(503, "AURA_LINK is not configured")


def _adb(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=ADB_TIMEOUT)


def _adb_connect() -> tuple[bool, str]:
    """Make sure the bridge can talk to the TV. Returns (usable, message)."""
    if not shutil.which("adb"):
        return False, "adb is not installed in the bridge image"
    connect = _adb("connect", ADB_SERIAL)
    out = (connect.stdout + connect.stderr).strip()
    if "unauthorized" in out.lower():
        return False, "the TV is showing an ADB authorization prompt — approve it once, then retry"
    probe = _adb("-s", ADB_SERIAL, "shell", "echo", "ok")
    if probe.returncode != 0 or "ok" not in probe.stdout:
        return False, f"ADB cannot reach {ADB_SERIAL}: {(probe.stderr or out).strip()[:160]}"
    return True, out or "connected"


@app.post("/api/launch")
def launch():
    _require_adb()
    """Bring Aura to the foreground; wake the device if it is asleep."""
    ok, message = _adb_connect()
    if not ok:
        raise HTTPException(503, message)

    _adb("-s", ADB_SERIAL, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    result = _adb("-s", ADB_SERIAL, "shell", "am", "start", "-n", AURA_ACTIVITY)
    out = (result.stdout + result.stderr).strip()
    if result.returncode != 0 or "Error" in out:
        raise HTTPException(502, f"launch failed: {out[:200]}")
    return {"ok": True, "detail": out[:200]}


@app.get("/api/device")
def device_state():
    _require_adb()
    """What is in the foreground, so the PWA can avoid a pointless relaunch."""
    ok, message = _adb_connect()
    if not ok:
        return {"available": False, "reason": message}
    dump = _adb("-s", ADB_SERIAL, "shell", "dumpsys", "window", "displays")
    text = dump.stdout or ""
    foreground = None
    for marker in ("mCurrentFocus", "mFocusedApp"):
        for line in text.splitlines():
            if marker in line:
                foreground = line.strip()
                break
        if foreground:
            break
    return {
        "available": True,
        "foreground": foreground,
        "aura_foreground": bool(foreground and AURA_ACTIVITY.split("/")[0] in foreground),
    }


@app.get("/api/tvstate")
def tvstate():
    _require_adb()
    """An HTML-renderable model of what is on the TV right now.

    Reads the accessibility tree over ADB rather than taking a screenshot, so
    the remote can redraw the screen as HTML with real text and layout, and mark
    whatever has focus.
    """
    ok, message = _adb_connect()
    if not ok:
        raise HTTPException(503, message)

    dump = _adb("-s", ADB_SERIAL, "shell", "uiautomator", "dump", "/sdcard/aura_remote_ui.xml")
    if dump.returncode != 0:
        raise HTTPException(502, (dump.stderr or "uiautomator dump failed")[:160])

    raw = subprocess.run(
        ["adb", "-s", ADB_SERIAL, "exec-out", "cat", "/sdcard/aura_remote_ui.xml"],
        capture_output=True, timeout=ADB_TIMEOUT,
    ).stdout
    if not raw:
        raise HTTPException(502, "could not read the UI dump")

    nodes = _parse_ui(raw)
    if not nodes:
        raise HTTPException(502, "UI dump had no readable nodes")

    width = max(n["x2"] for n in nodes) or 1920
    height = max(n["y2"] for n in nodes) or 1080
    for n in nodes:
        n["l"] = round(n.pop("x1") / width, 4)
        n["t"] = round(n.pop("y1") / height, 4)
        n["w"] = round((n.pop("x2") / width) - n["l"], 4)
        n["h"] = round((n.pop("y2") / height) - n["t"], 4)

    return {"width": width, "height": height, "nodes": nodes}


def _parse_ui(raw: bytes) -> list[dict]:
    import xml.etree.ElementTree as ET

    bounds_re = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")
    out: list[dict] = []

    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
    except ET.ParseError:
        return out

    for node in root.iter("node"):
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        label = text or desc
        if not label:
            continue
        match = bounds_re.match(node.get("bounds") or "")
        if not match:
            continue
        x1, y1, x2, y2 = (int(v) for v in match.groups())
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        out.append({
            "text": label[:120],
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "focused": node.get("focused") == "true",
            "clickable": node.get("clickable") == "true",
            "role": (node.get("class") or "").split(".")[-1][:24],
        })
        if len(out) >= 140:
            break
    return out


class ControlRequest(BaseModel):
    action: str
    position: Optional[int] = None
    index: Optional[int] = None
    on: Optional[bool] = None
    mode: Optional[int] = None


class NavigateRequest(BaseModel):
    screen: str
    itemId: Optional[str] = None


class PairRequest(BaseModel):
    name: str


@app.get("/api/aura/paired")
def aura_paired():
    return {"paired": bool(_AURA_TOKEN), "link": AURA_LINK}


@app.post("/api/aura/pair")
def aura_pair(req: PairRequest):
    """USB-debugging style: the TV asks the user, and only Allow returns a token."""
    params = urllib.parse.urlencode({"name": req.name})
    try:
        # Generous timeout: this blocks while the prompt is on screen.
        with _aura_request(f"/pair/request?{params}", method="POST", timeout=100) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise HTTPException(403, "the TV denied the pairing request") from exc
        raise HTTPException(502, f"Aura returned {exc.code}") from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Aura mirror link unreachable: {exc}") from exc

    _save_token(data["token"])
    return {"paired": True, "device": data.get("device"), "requested": req.name}


@app.get("/api/aura/state")
def aura_state():
    """Proxy Aura's own screen state (ui/MirrorLink.kt on the TV)."""
    try:
        with _aura_request("/state") as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise HTTPException(401, "pairing required") from exc
        raise HTTPException(502, f"Aura returned {exc.code}") from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Aura mirror link unreachable: {exc}") from exc


@app.post("/api/aura/control")
def aura_control(req: ControlRequest):
    """Connect-style transport: the TV is the endpoint and owns playback."""
    params = {"action": req.action}
    if req.position is not None:
        params["position"] = str(req.position)
    if req.index is not None:
        params["index"] = str(req.index)
    if req.on is not None:
        params["on"] = "true" if req.on else "false"
    if req.mode is not None:
        params["mode"] = str(req.mode)
    try:
        _aura_request(f"/control?{urllib.parse.urlencode(params)}", method="POST").read()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Aura mirror link unreachable: {exc}") from exc
    return {"ok": True}


@app.post("/api/aura/navigate")
def aura_navigate(req: NavigateRequest):
    params = {"screen": req.screen}
    if req.itemId:
        params["itemId"] = req.itemId
    try:
        _aura_request(f"/navigate?{urllib.parse.urlencode(params)}", method="POST").read()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"Aura mirror link unreachable: {exc}") from exc
    return {"ok": True, "screen": req.screen, "itemId": req.itemId}


# Serve the PWA. Mounted last so /api routes win.
_web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
if os.path.isdir(_web):
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")
