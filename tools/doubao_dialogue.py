"""Doubao Realtime Dialogue provider for Hermes.

Connects to the Volcano Realtime Dialogue WebSocket
(``wss://openspeech.bytedance.com/api/v3/realtime/dialogue``) with the same
binary frame protocol as ``tools.doubao_protocols`` and the sync websocket
pattern used by ``tools.tts_streaming.DoubaoStreamer``.

The session is push-to-talk scoped (half-duplex): stream the user's 16 kHz
PCM, send EndASR, then iterate ASR / Chat / TTS events until the spoken
reply ends. Auth uses the existing DOUBAO_TTS_TOKEN as ``X-Api-Key``, which
was validated against the live endpoint by ``doubao_dialogue_probe.py``.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Dict, Iterator, Optional

from websockets.sync.client import connect

from tools.doubao_protocols import (
    CompressionBits,
    EventType,
    Message,
    MsgType,
    MsgTypeFlagBits,
    SerializationBits,
)

logger = logging.getLogger(__name__)

DIALOGUE_URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
DIALOGUE_RESOURCE_ID = "volc.speech.dialog"

# EndASR is not present in the local EventType enum; 400 matches the
# upstream ClientEvent.END_ASR used by the s2s example.
END_ASR_EVENT = 400


def _full_frame(
    event: int,
    payload: bytes = b"{}",
    session_id: str = "",
) -> bytes:
    msg = Message(
        type=MsgType.FullClientRequest,
        flag=MsgTypeFlagBits.WithEvent,
        event=event,
        session_id=session_id,
        payload=payload,
    )
    return msg.marshal()


def _audio_frame(pcm: bytes, session_id: str) -> bytes:
    msg = Message(
        type=MsgType.AudioOnlyClient,
        flag=MsgTypeFlagBits.WithEvent,
        serialization=SerializationBits.Raw,
        compression=CompressionBits.None_,
        event=EventType.TaskRequest,
        session_id=session_id,
        payload=pcm,
    )
    return msg.marshal()


class DoubaoDialogueSession:
    """Turn-scoped half-duplex dialogue session.

    Usage::

        session = DoubaoDialogueSession(api_key="...")
        with session:
            session.send_audio(chunk)
            session.end_input()
            for event in session.iter_events():
                ...
    """

    sample_rate = 16000  # input PCM contract
    output_sample_rate = 24000
    channels = 1

    def __init__(
        self,
        api_key: str,
        model: str = "1.2.1.1",
        speaker: str = "zh_female_vv_uranus_bigtts",
        system_prompt: str = "",
        bot_name: str = "",
        speaking_style: str = "",
        max_tokens: int = 0,
        speech_rate: int = 0,
        dialog_context: Optional[list[dict]] = None,
        mode: str = "half_duplex",
        url: str = DIALOGUE_URL,
        resource_id: str = DIALOGUE_RESOURCE_ID,
        timeout: float = 30.0,
    ) -> None:
        if not api_key.strip():
            raise ValueError("Doubao dialogue requires DOUBAO_TTS_TOKEN")
        self._api_key = api_key.strip()
        self._model = model
        self._speaker = speaker
        self._system_prompt = system_prompt
        self._bot_name = bot_name
        self._speaking_style = speaking_style
        self._max_tokens = max(0, int(max_tokens))
        self._speech_rate = max(-50, min(100, int(speech_rate)))
        self._dialog_context = dialog_context or []
        self._mode = mode
        self._url = url
        self._resource_id = resource_id
        self._timeout = timeout
        self._session_id = ""
        self._ws = None

    @property
    def session_id(self) -> str:
        return self._session_id

    def __enter__(self) -> "DoubaoDialogueSession":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """Open one WebSocket connection (StartConnection handshake only)."""
        headers = {
            "X-Api-Key": self._api_key,
            "X-Api-Resource-Id": self._resource_id,
            "X-Api-Request-Id": str(uuid.uuid4()),
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        self._ws = connect(
            self._url,
            additional_headers=headers,
            max_size=20 * 1024 * 1024,
        )
        self._ws.send(_full_frame(EventType.StartConnection))
        self._wait_for_message(MsgType.FullServerResponse, EventType.ConnectionStarted)

    def start(self) -> None:
        """Connect and start the first (and only) dialogue turn."""
        if self._ws is None:
            self.connect()
        self._session_id = str(uuid.uuid4())
        self._ws.send(
            _full_frame(
                EventType.StartSession,
                self._session_payload(),
                self._session_id,
            )
        )
        self._wait_for_message(MsgType.FullServerResponse, EventType.SessionStarted)

    def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is None:
            return
        if self._session_id:
            try:
                ws.send(_full_frame(EventType.FinishSession, b"{}", self._session_id))
            except Exception:
                pass
            self._session_id = ""
        try:
            ws.send(_full_frame(EventType.FinishConnection))
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Upstream
    # ------------------------------------------------------------------

    def send_audio(self, pcm: bytes) -> None:
        self._require_turn()
        self._ws.send(_audio_frame(pcm, self._session_id))

    def end_input(self) -> None:
        self._require_turn()
        self._ws.send(_full_frame(END_ASR_EVENT, b"{}", self._session_id))
    def say_hello(self, text: str = "") -> None:
        """Make the bot speak first, without waiting for user audio (event 300).

        With ``content`` the service voices exactly that line — the wake-word
        acknowledgement ("在呢，马哥"). Bare ``{}`` asks for the greeting the bot
        was configured with, which is empty here and yields no audio (verified
        against the live endpoint 2026-09-12; ChatTTSText is a no-op there).
        """
        self._require_turn()
        content = (text or "").strip()
        payload = json.dumps({"content": content}).encode("utf-8") if content else b"{}"
        self._ws.send(_full_frame(EventType.SayHello, payload, self._session_id))

    # ------------------------------------------------------------------
    # Downstream
    # ------------------------------------------------------------------

    def recv_event(self, timeout: Optional[float] = None) -> Optional[Dict]:
        """Return the next decoded event, or None on socket timeout."""
        self._require_open()
        try:
            data = self._ws.recv(timeout=timeout)
        except TimeoutError:
            return None
        if isinstance(data, str):
            raise RuntimeError(
                f"Doubao dialogue got a text frame: {data[:120]}"
            )
        msg = Message.from_bytes(data)
        return self._event_from_message(msg)

    def iter_events(self) -> Iterator[Dict]:
        """Yield events until the spoken reply ends or the session fails."""
        deadline = time.monotonic() + self._timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    "Doubao dialogue timed out waiting for terminal event"
                )
            event = self.recv_event(timeout=min(1.0, remaining))
            if event is None:
                continue
            yield event
            if event.get("type") in ("tts_ended", "session_finished", "error"):
                return

    def end_turn(self) -> None:
        """Finish the current turn but keep the WebSocket open for reuse."""
        if self._ws is None or not self._session_id:
            return
        try:
            self._ws.send(_full_frame(EventType.FinishSession, b"{}", self._session_id))
        except Exception:
            pass
        self._session_id = ""

    def cancel_turn(self) -> None:
        """Cancel the active turn immediately while keeping the WebSocket open."""
        if self._ws is None or not self._session_id:
            return
        self._ws.send(
            _full_frame(EventType.CancelSession, b"{}", self._session_id)
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _require_open(self) -> None:
        if self._ws is None:
            raise RuntimeError("Doubao dialogue session is not open")

    def _require_turn(self) -> None:
        self._require_open()
        if not self._session_id:
            raise RuntimeError("Doubao dialogue turn is not started")

    def _session_payload(self) -> bytes:
        is_sc = self._model in ("SC", "2.2.0.0")
        payload: dict = {
            "tts": {
                "speaker": self._speaker,
                "audio_config": {
                    "channel": 1,
                    "format": "pcm_s16le",
                    "sample_rate": self.output_sample_rate,
                },
            },
            "dialog": {
                "extra": {
                    "model": self._model,
                },
            },
        }
        if self._mode == "half_duplex":
            payload["dialog"]["extra"]["input_mod"] = "push_to_talk"
        if self._system_prompt:
            if is_sc:
                payload["dialog"]["character_manifest"] = self._system_prompt
            else:
                payload["dialog"]["system_role"] = self._system_prompt
        if not is_sc:
            if self._bot_name:
                payload["dialog"]["bot_name"] = self._bot_name
            if self._speaking_style:
                payload["dialog"]["speaking_style"] = self._speaking_style
        if self._dialog_context:
            payload["dialog"]["dialog_context"] = self._dialog_context
        if self._max_tokens:
            payload["props"] = {"max_tokens": self._max_tokens}
        if self._speech_rate:
            payload["tts"]["audio_config"]["speech_rate"] = self._speech_rate
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def _recv_message(self, timeout: Optional[float] = None) -> Message:
        data = self._ws.recv(timeout=timeout)
        if isinstance(data, str):
            raise RuntimeError(
                f"Doubao dialogue got a text frame: {data[:120]}"
            )
        return Message.from_bytes(data)

    def _wait_for_message(
        self,
        msg_type: MsgType,
        event_type: EventType,
        timeout: Optional[float] = None,
    ) -> Message:
        deadline = time.monotonic() + (timeout or self._timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"Doubao dialogue timed out waiting for {event_type}"
                )
            msg = self._recv_message(timeout=remaining)
            if msg.type == MsgType.Error:
                detail = msg.payload.decode("utf-8", "ignore")[:200]
                raise RuntimeError(
                    f"Doubao dialogue error: code={msg.error_code} payload={detail}"
                )
            if msg.type == msg_type and msg.event == event_type:
                return msg

    def _event_from_message(self, msg: Message) -> Optional[Dict]:
        if msg.type == MsgType.Error:
            return {
                "type": "error",
                "code": msg.error_code,
                "message": msg.payload.decode("utf-8", "ignore"),
            }
        if msg.type == MsgType.FullServerResponse:
            payload = msg.json_payload() or {}
            if msg.event == EventType.ASRResponse:
                text = ""
                final = False
                for result in payload.get("results") or []:
                    if not isinstance(result, dict):
                        continue
                    if result.get("text"):
                        text = str(result["text"])
                    if not result.get("is_interim", True):
                        final = True
                return {"type": "asr", "text": text, "final": final}
            if msg.event == EventType.ASREnded:
                return {"type": "asr_ended"}
            if msg.event == EventType.ChatResponse:
                return {
                    "type": "chat",
                    "text": str(payload.get("content") or ""),
                }
            if msg.event == EventType.ChatEnded:
                return {"type": "chat_ended"}
            if msg.event == EventType.TTSSentenceStart:
                return {"type": "tts_sentence_start"}
            if msg.event == EventType.TTSSentenceEnd:
                return {"type": "tts_sentence_end"}
            if msg.event == EventType.TTSEnded:
                return {"type": "tts_ended"}
            if msg.event == EventType.SessionFinished:
                return {"type": "session_finished"}
            if msg.event == EventType.SessionCanceled:
                return {"type": "session_canceled"}
            if msg.event == EventType.SessionFailed:
                return {
                    "type": "error",
                    "message": str(payload.get("error") or payload),
                }
            if msg.event == EventType.UsageResponse:
                return {"type": "usage"}
            return None
        if msg.type == MsgType.AudioOnlyServer:
            return {"type": "audio", "payload": msg.payload}
        return None
