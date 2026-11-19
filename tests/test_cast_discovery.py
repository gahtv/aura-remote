import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from server import app as bridge


pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client(monkeypatch):
    monkeypatch.setattr(bridge, "_cache", None)
    monkeypatch.setattr(bridge, "_cache_at", 0.0)
    monkeypatch.setattr(bridge, "_discovery", None)
    monkeypatch.setattr(bridge, "STATIC_TARGETS", [])
    monkeypatch.setattr(bridge, "_sessions", {"test": {"created": bridge.time.time()}})
    monkeypatch.setattr(bridge.pychromecast.discovery, "stop_discovery", Mock())
    with ThreadPoolExecutor(max_workers=1) as executor:
        monkeypatch.setattr(bridge, "_discovery_executor", executor)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=bridge.app),
            base_url="http://test",
            cookies={"aura_remote": "test"},
        ) as client:
            yield client


async def test_empty_cast_discovery_is_cached(client, monkeypatch):
    discover = Mock(return_value=([], None))
    monkeypatch.setattr(bridge.pychromecast, "get_chromecasts", discover)

    for _ in range(3):
        response = await client.get("/api/targets")
        assert response.status_code == 200
        assert response.json() == {"targets": []}

    discover.assert_called_once()


async def test_expired_cast_cache_is_served_during_one_refresh(client, monkeypatch):
    refresh_started = Event()
    release_refresh = Event()
    refresh_finished = Event()
    cast = SimpleNamespace(cast_info=SimpleNamespace(
        friendly_name="Living Room", host="192.0.2.1", port=8009, model_name="Chromecast",
    ))

    def refresh(**kwargs):
        refresh_started.set()
        release_refresh.wait(timeout=5)
        refresh_finished.set()
        return [cast], None

    scan = Mock(return_value=([], None))
    monkeypatch.setattr(bridge.pychromecast, "get_chromecasts", scan)
    assert (await client.get("/api/targets")).json() == {"targets": []}
    scan.side_effect = refresh
    monkeypatch.setattr(bridge, "_cache_at", bridge.time.monotonic() - bridge.DISCOVERY_TTL)

    try:
        assert (await client.get("/api/targets")).json() == {"targets": []}
        assert await asyncio.to_thread(refresh_started.wait, 5)
        assert (await client.get("/api/targets")).json() == {"targets": []}
        assert (await client.get("/api/health")).json() == {"ok": True, "devices": 0}
        assert not refresh_finished.is_set()
        assert scan.call_count == 2
    finally:
        release_refresh.set()

    await asyncio.wait_for(asyncio.wrap_future(bridge._discovery), timeout=5)
    assert (await client.get("/api/targets")).json() == {"targets": [
        {"name": "Living Room", "host": "192.0.2.1", "model": "Chromecast"},
    ]}
    assert scan.call_count == 2
