"""Avatar companion routes: image "look" and the realtime voice dialogue socket.

Extracted from the pre-modular ``hermes_cli.web_server`` so the desktop cyber
companion keeps working after upstream moved route handlers into web_routers/.
Helpers that live in sibling modules are late-bound exactly like ``audio.py``.
"""

import asyncio
import contextlib
import json
import logging
import os
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from hermes_cli.config import cfg_get, load_config
from hermes_cli.web_deps import late
from hermes_cli.web_server_chat import _ws_auth_ok, _ws_request_is_allowed

_log = logging.getLogger("hermes_cli.web_server")
router = APIRouter()

# Late-bound so a test's monkeypatch on the owning module wins at call time.
_config_profile_scope = late("_config_profile_scope", "hermes_cli.web_server_profiles")


def _voice_history_dir() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "logs"


_BOT_NAME_ALIASES = (
    "小贺",
    "小荷",
    "小和",
    "小何",
    "晓赫",
    "晓贺",
    "晓荷",
    "晓和",
    "晓何",
)


def _normalize_bot_name(text: str) -> str:
    """Doubao ASR often hears 小赫 as a homophone; normalize before display/history."""
    if not text:
        return text
    normalized = text
    for alias in _BOT_NAME_ALIASES:
        normalized = normalized.replace(alias, "小赫")
    return normalized


def _append_voice_history(user_text: str, assistant_text: str) -> None:
    """Best-effort disk record of one realtime voice turn (side channel only)."""
    if not user_text and not assistant_text:
        return
    try:
        log_dir = _voice_history_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / "voice-history.jsonl"
        record = {
            "ts": int(time.time() * 1000),
            "user": user_text,
            "assistant": assistant_text,
        }
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        _log.debug("voice history append failed", exc_info=True)


def _append_voice_history_to_session(
    session_id: str, user_text: str, assistant_text: str
) -> None:
    """Append one realtime voice turn to the live Hermes session DB."""
    if not session_id or (not user_text and not assistant_text):
        return
    try:
        from tui_gateway.server import _sessions
        from tui_gateway.session_workdir import _session_db

        session = _sessions.get(session_id)
        if not session:
            return
        messages = []
        if user_text:
            messages.append({"role": "user", "content": user_text})
        if assistant_text:
            messages.append({"role": "assistant", "content": assistant_text})
        if not messages:
            return
        with _session_db(session) as db:
            if db is None:
                return
            db.append_messages_batch(
                str(session.get("session_key") or session_id),
                messages,
            )
    except Exception:
        _log.debug("voice history session append failed", exc_info=True)


def _avatar_minimax_key() -> str:
    key = (os.environ.get("MINIMAX_API_KEY") or "").strip()
    if key:
        return key
    for env_path in (
        Path.home() / ".hermes" / ".env",
        Path.home() / "Documents" / "New project" / ".env",
    ):
        try:
            for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip().lstrip("\ufeff")
                if line.startswith("MINIMAX_API_KEY="):
                    candidate = line.split("=", 1)[1].strip().strip("\"'")
                    if candidate:
                        return candidate
        except Exception:
            continue
    return ""


def _call_minimax_text(
    model: str,
    api_key: str,
    prompt: str,
    image_b64: str = "",
    image_mime: str = "image/png",
    max_tokens: int = 120,
    timeout: int = 60,
) -> str:
    """MiniMax Anthropic-compatible chat. Pass image_b64 to give the model
    vision (Anthropic image content block)."""
    import json as _json
    import urllib.request

    content: list[dict] = [{"type": "text", "text": prompt}]
    if image_b64:
        content.insert(
            0,
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_mime,
                    "data": image_b64,
                },
            },
        )
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": content}],
    }
    req = urllib.request.Request(
        "https://api.minimaxi.com/anthropic/v1/messages",
        data=_json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = _json.loads(resp.read().decode("utf-8"))
    return "".join(
        block.get("text", "")
        for block in body.get("content", [])
        if block.get("type") == "text"
    ).strip()


def _avatar_persona_block(persona: str = "") -> str:
    """Flatten the user-editable avatar-persona.md into a short prompt block."""
    persona = (persona or "").strip()
    if not persona:
        return ""
    lines = [
        ln.strip()
        for ln in persona.splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    return "\n".join(lines)[:800]


def _split_data_url(data_url: str) -> tuple[str, str]:
    """Split a data:image/xxx;base64,... URL into (mime, base64)."""
    if not data_url or "," not in data_url:
        return "image/png", ""
    head, b64 = data_url.split(",", 1)
    mime = "image/png"
    if head.startswith("data:") and "base64" in head:
        mime = head[5:].split(";", 1)[0] or mime
    return mime, (b64 or "").strip()


@router.post("/api/avatar/see")
async def avatar_see(request: Request) -> dict:
    """Look at a dropped image and answer (vision + TTS in the overlay)."""
    try:
        try:
            body = await request.json()
        except Exception:
            body = {}
        image_data_url = str(body.get("image_b64") or "").strip()
        persona = str(body.get("persona") or "")
        if not image_data_url:
            return {"text": None, "error": "no_image"}

        cfg = load_config()
        model = str(cfg_get(cfg, "model", "default") or "MiniMax-M3")
        api_key = _avatar_minimax_key()
        if not api_key:
            return {"text": None, "error": "no_api_key"}
        mime, b64 = _split_data_url(image_data_url)
        persona_block = _avatar_persona_block(persona)
        prompt = (
            "你是常驻桌面的赛博女友小可，用户在给你看一张图片。"
            "用一句到两句话自然回应：可以说说你看到了什么、像真人女友那样有情绪、"
            "偶尔俏皮撒娇，不要列清单、不要复述提示词。"
            "如果图片里有文字，可以读出来；看不清就撒娇说看不清。"
        )
        if persona_block:
            prompt += f"\n你的人设（自然融入）：\n{persona_block}"
        text = _call_minimax_text(
            model,
            api_key,
            prompt,
            image_b64=b64,
            image_mime=mime,
            max_tokens=180,
        )
        return {"text": (text or "")[:120] or None}
    except Exception:
        _log.exception("avatar see failed")
        return {"text": None, "error": "see_failed"}


@router.websocket("/api/audio/dialogue")
async def dialogue_ws(ws: "WebSocket") -> None:
    """Realtime dialogue for the desktop voice dock / cyber companion.

    Protocol:
      client -> ``{"type": "start"}`` before each spoken turn (first turn may
               be implicit from the first PCM frame),
      client -> binary 16 kHz int16 mono PCM frames,
                ``{"type": "end"}`` to end the user turn (EndASR),
                ``{"type": "stop"}`` or disconnect = barge-in
      server -> ``{"type": "start", "sample_rate": 16000, "channels": 1}``,
                ``{"type": "asr", "text": ..., "final": ...}``,
                ``{"type": "chat", "text": ...}``,
                binary 24 kHz int16 mono PCM frames,
                ``{"type": "end"}`` when the spoken reply is done
    """
    if not _ws_auth_ok(ws):
        await ws.close(code=4401)
        return
    if not _ws_request_is_allowed(ws):
        await ws.close(code=4403)
        return
    await ws.accept()

    profile = (ws.query_params.get("profile") or "").strip() or None
    session_id = (ws.query_params.get("session_id") or "").strip() or ""
    mode = (ws.query_params.get("mode") or "half_duplex").strip()
    full_duplex = mode == "full_duplex"
    _log.info("dialogue ws connected mode=%s profile=%s", mode, profile)
    loop = asyncio.get_running_loop()

    def _resolve():
        from tools.doubao_dialogue import DoubaoDialogueSession
        from hermes_cli.config import get_env_value

        with _config_profile_scope(profile):
            cfg = load_config() or {}
            voice_cfg = cfg.get("voice") or {}
            api_key = str(get_env_value("DOUBAO_TTS_TOKEN") or "").strip()
            persona_enabled = bool(voice_cfg.get("realtime_dialogue_persona"))
            persona_path = str(voice_cfg.get("realtime_dialogue_persona_path") or "").strip()
            bot_name = str(voice_cfg.get("realtime_dialogue_bot_name") or "").strip()
            speaking_style = str(voice_cfg.get("realtime_dialogue_speaking_style") or "").strip()
            voice_history_in_session = bool(
                voice_cfg.get("voice_history_in_session", False)
            )
            system_prompt = ""
            if persona_enabled:
                if persona_path:
                    persona_file = Path(persona_path).expanduser()
                    if persona_file.exists():
                        system_prompt = persona_file.read_text(encoding="utf-8")
                else:
                    from hermes_cli.web_server_profiles import _resolve_profile_dir

                    profile_name = (profile or "default").strip() or "default"
                    soul_path = _resolve_profile_dir(profile_name) / "SOUL.md"
                    if soul_path.exists():
                        system_prompt = soul_path.read_text(encoding="utf-8")
            if voice_cfg.get("persona_mode"):
                try:
                    _scripts = str(Path.home() / ".hermes" / "scripts")
                    if _scripts not in sys.path:
                        sys.path.insert(0, _scripts)
                    from assistant_store import AssistantStore
                    from persona_mode import build_system_prompt

                    facts = [
                        item["content"]
                        for item in AssistantStore().list_facts(10)
                    ]
                    system_prompt = build_system_prompt(facts=facts)
                except Exception:
                    _log.debug("persona_mode build failed", exc_info=True)
        return (
            DoubaoDialogueSession,
            api_key,
            system_prompt,
            bot_name,
            speaking_style,
            voice_history_in_session,
        )

    try:
        (
            session_cls,
            api_key,
            system_prompt,
            bot_name,
            speaking_style,
            voice_history_in_session,
        ) = await loop.run_in_executor(None, _resolve)
    except Exception:
        _log.exception("dialogue config resolution failed")
        session_cls, api_key = None, ""
    if not api_key or session_cls is None:
        with contextlib.suppress(Exception):
            await ws.send_json(
                {"type": "error", "message": "DOUBAO_TTS_TOKEN not configured"}
            )
        with contextlib.suppress(Exception):
            await ws.close()
        return

    await ws.send_json(
        {
            "type": "start",
            "sample_rate": 16000,
            "channels": 1,
            "output_sample_rate": 24000,
        }
    )

    stop = threading.Event()
    up_q: queue.Queue = queue.Queue()  # bytes PCM, _START, or None = EndASR
    down_q: asyncio.Queue = asyncio.Queue()  # event dicts; None = done
    _POLL = object()
    _START = object()

    def _produce():
        session = None
        turn_active = False
        last_send = 0.0
        last_user_text = ""
        assistant_parts = []
        work_assistant_enabled = False
        try:
            work_assistant_enabled = bool(
                ((load_config() or {}).get("voice") or {}).get("work_assistant")
            )
        except Exception:
            pass
        try:
            loop.call_soon_threadsafe(
                down_q.put_nowait, {"type": "session_started"}
            )
            while not stop.is_set():
                try:
                    item = up_q.get(timeout=0.01)
                except queue.Empty:
                    item = _POLL
                if item is not _POLL:
                    if item is _START:
                        if session is None:
                            session = session_cls(
                                api_key=api_key,
                                mode=mode,
                                system_prompt=system_prompt,
                                bot_name=bot_name,
                                speaking_style=speaking_style,
                            )
                            session.start()
                            _log.info("dialogue session started mode=%s profile=%s", mode, profile)
                            turn_active = True
                    elif isinstance(item, dict) and item.get("greet"):
                        if session is not None and turn_active:
                            with contextlib.suppress(Exception):
                                session.say_hello(str(item["greet"]))
                    elif item is None:
                        if not full_duplex and session is not None and turn_active:
                            session.end_input()
                            turn_active = False
                    elif isinstance(item, (bytes, bytearray)):
                        if session is None:
                            session = session_cls(
                                api_key=api_key,
                                mode=mode,
                                system_prompt=system_prompt,
                                bot_name=bot_name,
                                speaking_style=speaking_style,
                            )
                            session.start()
                            _log.info("dialogue session started mode=%s profile=%s", mode, profile)
                            turn_active = True
                        session.send_audio(bytes(item))
                        last_send = time.monotonic()
                if (
                    full_duplex
                    and session is not None
                    and time.monotonic() - last_send >= 0.25
                ):
                    with contextlib.suppress(Exception):
                        session.send_audio(b"\x00\x00" * 3200)  # 100 ms silence
                    last_send = time.monotonic()
                try:
                    event = session.recv_event(timeout=0.0) if session is not None else None
                except Exception as exc:
                    loop.call_soon_threadsafe(
                        down_q.put_nowait,
                        {
                            "type": "error",
                            "message": f"dialogue receive failed: {exc}",
                        },
                    )
                    break
                if event is not None:
                    if event.get("type") == "asr":
                        event = {
                            **event,
                            "text": _normalize_bot_name(str(event.get("text") or "")),
                        }
                    if event.get("type") == "asr" and event.get("final"):
                        last_user_text = str(event.get("text") or "")
                        if work_assistant_enabled:
                            handle_voice_command = None
                            try:
                                _scripts = str(Path.home() / ".hermes" / "scripts")
                                if _scripts not in sys.path:
                                    sys.path.insert(0, _scripts)
                                from voice_work_assistant import handle_voice_command
                            except Exception:
                                handle_voice_command = None
                            if handle_voice_command is not None:
                                command_result = handle_voice_command(
                                    last_user_text,
                                    source="desktop",
                                )
                                if command_result.get("handled"):
                                    command_reply = str(
                                        command_result.get("reply") or ""
                                    )
                                    if session is not None:
                                        with contextlib.suppress(Exception):
                                            session.close()
                                    session = None
                                    turn_active = False
                                    loop.call_soon_threadsafe(
                                        down_q.put_nowait, event
                                    )
                                    loop.call_soon_threadsafe(
                                        down_q.put_nowait,
                                        {"type": "chat", "text": command_reply},
                                    )
                                    try:
                                        from tools.tts_streaming import DoubaoStreamer

                                        for chunk in DoubaoStreamer({}, {}).stream(
                                            command_reply
                                        ):
                                            loop.call_soon_threadsafe(
                                                down_q.put_nowait,
                                                {"type": "audio", "payload": chunk},
                                            )
                                    except Exception as exc:
                                        _log.warning(
                                            "work assistant tts failed: %s", exc
                                        )
                                    loop.call_soon_threadsafe(
                                        down_q.put_nowait,
                                        {"type": "session_finished"},
                                    )
                                    _append_voice_history(
                                        last_user_text, command_reply
                                    )
                                    if voice_history_in_session:
                                        _append_voice_history_to_session(
                                            session_id, last_user_text, command_reply
                                        )
                                    continue
                    elif event.get("type") == "chat":
                        assistant_parts.append(str(event.get("text") or ""))
                    loop.call_soon_threadsafe(down_q.put_nowait, event)
                    if event.get("type") in ("tts_ended", "session_finished"):
                        assistant_text = "".join(assistant_parts).strip()
                        _append_voice_history(last_user_text, assistant_text)
                        if voice_history_in_session:
                            _append_voice_history_to_session(
                                session_id,
                                last_user_text,
                                assistant_text,
                            )
                        last_user_text = ""
                        assistant_parts = []
                        _log.info("dialogue turn finished event=%s mode=%s", event.get("type"), mode)
                        if full_duplex:
                            if event.get("type") == "session_finished":
                                with contextlib.suppress(Exception):
                                    session.close()
                                session = None
                                turn_active = False
                        else:
                            with contextlib.suppress(Exception):
                                session.close()
                            session = None
                            turn_active = False
                    elif event.get("type") == "error":
                        break
        except Exception as exc:
            _log.warning("dialogue session failed: %s", exc)
            loop.call_soon_threadsafe(
                down_q.put_nowait,
                {"type": "error", "message": str(exc)},
            )
        finally:
            if session is not None:
                with contextlib.suppress(Exception):
                    session.close()
            loop.call_soon_threadsafe(down_q.put_nowait, None)

    threading.Thread(target=_produce, daemon=True).start()

    async def _pump_client():
        try:
            while True:
                frame = await ws.receive()
                if frame.get("type") == "websocket.disconnect":
                    break
                text = frame.get("text")
                if text is not None:
                    try:
                        data = json.loads(text)
                    except Exception:
                        break
                    if data.get("type") == "end":
                        up_q.put(None)
                    elif data.get("type") == "start":
                        up_q.put(_START)
                        greet = str(data.get("greet") or "").strip()
                        if greet:
                            # Spoken answer to the wake word: 豆包 voices this exact
                            # line instead of the model inventing a greeting.
                            up_q.put({"greet": greet})
                    elif data.get("type") == "stop":
                        break
                elif frame.get("bytes"):
                    up_q.put(frame["bytes"])
        except Exception:
            pass
        stop.set()
        with contextlib.suppress(queue.Full):
            up_q.put(None)

    pump = asyncio.ensure_future(_pump_client())
    try:
        while True:
            event = await down_q.get()
            if event is None:
                break
            etype = event.get("type")
            if etype == "audio":
                await ws.send_bytes(event["payload"])
            elif etype == "asr":
                await ws.send_json(
                    {
                        "type": "asr",
                        "text": event.get("text", ""),
                        "final": bool(event.get("final", False)),
                    }
                )
            elif etype == "chat":
                await ws.send_json(
                    {"type": "chat", "text": event.get("text", "")}
                )
            elif etype == "error":
                await ws.send_json(
                    {"type": "error", "message": event.get("message", "")}
                )
                break
            elif etype in ("tts_ended", "session_finished"):
                await ws.send_json({"type": "end"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        stop.set()
        with contextlib.suppress(queue.Full):
            up_q.put(None)
        pump.cancel()
        with contextlib.suppress(Exception):
            await ws.close()
