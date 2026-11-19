import asyncio
from types import SimpleNamespace

from hermes_cli.dashboard_auth import native_http
from hermes_cli.web_routers import avatar, webapp
from hermes_cli.web_session_sockets import AUDIO_SOCKETS, DIALOGUE_SOCKET


class _Query:
    def __init__(self, values=None):
        self._values = values or {}

    def get(self, key, default=""):
        return self._values.get(key, default)

    def getlist(self, key):
        value = self._values.get(key)
        if value is None:
            return []
        return value if isinstance(value, list) else [value]


def test_dialogue_is_registered_as_an_audio_socket():
    assert "/api/audio/dialogue" in native_http.AUDIO_STREAM_PATHS
    assert DIALOGUE_SOCKET in AUDIO_SOCKETS
    assert webapp.SOCKET_TICKETS[DIALOGUE_SOCKET] == ("gateway_ticket", False)


def test_redeem_audio_ws_accepts_the_dialogue_path(monkeypatch):
    ticket = "one-use"
    headers = {
        "sec-websocket-protocol": (
            f"hermes-gateway-v1, hermes-gateway-ticket.{ticket}"
        )
    }
    ws = SimpleNamespace(
        headers=headers,
        url=SimpleNamespace(path="/api/audio/dialogue"),
        query_params=_Query(),
    )
    grant = {"profile_id": "/profile/default", "subject": "owner"}
    store = SimpleNamespace(redeem=lambda *args, **kwargs: grant)
    monkeypatch.setattr(native_http, "_native_store", lambda *args: ("runner", store))
    monkeypatch.setattr(
        "gateway.session_authorities.authority_for_profile_id",
        lambda runner, profile_id: object(),
    )

    assert native_http.redeem_audio_ws(ws) == grant


def test_dialogue_route_uses_the_dialogue_socket_name(monkeypatch):
    calls = []

    def reject(ws, **kwargs):
        calls.append(kwargs)
        return False

    closed = []

    class FakeWebSocket:
        async def close(self, code=None):
            closed.append(code)

    monkeypatch.setattr(avatar, "_ws_auth_ok", reject)

    asyncio.run(avatar.dialogue_ws(FakeWebSocket()))

    assert calls == [{"socket": DIALOGUE_SOCKET}]
    assert closed == [4401]
