"""Payload capture and the ``code_mode.capture`` note (otel-code-mode.md 7). OpenTelemetry has no
way to say a value on a record was shortened or removed: the SDK's own length limit cuts silently
and ``dropped_attributes_count`` speaks only for attributes dropped whole. So the note is minted
here.

Values are Opt-In. With ``values`` off nothing is serialized at all, which is both the spec's
default and the cheap path: an absent Opt-In attribute says nothing, and claims nothing.

Serializing one of these values runs program-authored code: a property, a ``__getattr__``, a
``__dict__`` that lies, a cycle. So the value is streamed rather than built, and every fault the
stream can raise costs that one value and never the call.
"""

from __future__ import annotations

from asyncio import CancelledError

import hashlib
import re
import json
from dataclasses import dataclass
from typing import Any, MutableMapping

#: See ``_core._INTERRUPT``: a real interrupt is this process being stopped, not a program
#: describing itself, so it is re-raised rather than contained.
_INTERRUPT = (KeyboardInterrupt, SystemExit, CancelledError)

#: Bytes of JSON kept per value. Under every SDK, collector and backend limit we know of.
DEFAULT_CAP = 1 << 13
#: The program is the host's own record of what it ran, and a reader wants more of it whole.
DEFAULT_PROGRAM_CAP = 1 << 15
#: A string longer than this many times the cap is not read at all. The same bound the TypeScript
#: implementation uses, so the two agree on which oversized values are refused.
_READ_FACTOR = 64

#: Unpaired surrogates, which have no UTF-8 encoding. See ``Capture.program``.
_SURROGATE = re.compile("[\ud800-\udfff]")

#: Bytes read to measure and hash the whole value, well above what is written. ``bytes`` and
#: ``hash`` are reported only for a value read whole, and they describe the original, so reading no
#: further than the write cap would drop them exactly where a truncated value needs them most.
DEFAULT_MEASURE = 1 << 20


@dataclass(frozen=True, slots=True)
class CapturePolicy:
    #: Turns on the Opt-In attributes: program text, crossing arguments and results, execution
    #: result and outputs, error bodies. Off by default, because they are agent-written code and
    #: target data.
    values: bool = False
    #: Bytes kept per value. Past it the attribute is a prefix and the note says ``truncated``.
    cap: int = DEFAULT_CAP
    #: The same for the program text.
    program_cap: int = DEFAULT_PROGRAM_CAP
    #: Bytes read to measure and hash a whole value. Past it a truncated note carries no size.
    measure: int = DEFAULT_MEASURE


def _default(o: Any) -> Any:
    """What ``json`` cannot encode by itself. An object's own ``__dict__`` is the nearest thing
    Python has to JavaScript's own-enumerable-properties rule; anything else is refused, and a
    refusal reads as a redaction rather than a fault."""
    if isinstance(o, BaseException):
        return _exception(o)
    d = getattr(o, "__dict__", None)
    if isinstance(d, dict):
        return d
    raise TypeError("mocon: not serializable")


def _exception(e: BaseException) -> dict[str, Any]:
    """An exception's ``__dict__`` is almost always empty, so it would serialize to ``{}`` and
    ``code_mode.error.body`` would carry a hash of nothing while asserting it captured the error.
    The class name and the message are what make it readable, so they lead. ``str`` on an exception
    a program raised runs that program's ``__str__``, which is contained here rather than lost."""
    try:
        members = dict(getattr(e, "__dict__", None) or {})
    except _INTERRUPT:
        raise
    except BaseException:
        members = {}
    # An own `name` or `message` wins over the class and `str`, matching the TypeScript emitter,
    # where reading the property finds the own value when there is one. Dropping them instead
    # deletes the only reason a bridge that sets them had for setting them.
    out: dict[str, Any] = {}
    name = members.pop("name", None)
    out["name"] = name if isinstance(name, str) and name else type(e).__name__
    message = members.pop("message", None)
    if not (isinstance(message, str) and message):
        try:
            message = str(e)
        except _INTERRUPT:
            raise
        except BaseException:
            # `str` on an exception a program raised runs that program's `__str__`, and BaseException
            # rather than Exception because that is the guard a hostile program steps around.
            message = None
    if isinstance(message, str) and message:
        out["message"] = message
    out.update(members)
    return out


# One encoder, shared: ``iterencode`` builds its own cycle markers per call, so it is re-entrant.
# ``allow_nan`` is off. NaN and Infinity are not JSON, and the two ways to keep going are both worse
# than stopping: Python would write a bare ``NaN`` token that no consumer can parse, and replacing it
# with ``null`` turns a reading into a reading of nothing, which a reader who misses the flag takes
# at face value. So such a payload is redacted whole, with no ``bytes`` and no ``hash``, since both
# are defined over an original that could not be serialized.
_ENCODER = json.JSONEncoder(
    ensure_ascii=False,
    allow_nan=False,
    check_circular=True,
    separators=(",", ":"),
    default=_default,
)


@dataclass(frozen=True, slots=True)
class _Encoded:
    #: ``None`` when the value was refused rather than read, which the caller reports as redacted.
    text: str | None
    truncated: bool
    #: Byte length of the whole serialization, when the encoder read it whole.
    size: int | None
    #: Lowercase hex SHA-256 of the whole serialization, present with ``size``.
    digest: str | None


class Capture:
    __slots__ = ("values", "_cap", "_program_cap", "_measure")

    def __init__(self, policy: CapturePolicy | None) -> None:
        if policy is None:
            policy = CapturePolicy()
        if not isinstance(policy, CapturePolicy):
            raise TypeError("mocon: capture must be a CapturePolicy")
        if not isinstance(policy.values, bool):
            raise TypeError("mocon: capture values must be a bool")
        self.values = policy.values
        self._cap = _positive(policy.cap, "cap")
        self._program_cap = _positive(policy.program_cap, "program_cap")
        self._measure = max(_positive(policy.measure, "measure"), self._cap)

    def program(self, text: str, attrs: MutableMapping[str, Any], notes: MutableMapping[str, dict[str, Any]]) -> None:
        """The program. Its hash is written whatever the policy says: 4.2 makes it Recommended
        because it is how two dispatches of one text are matched and the only thing left when the
        text is withheld."""
        # 4.2 defines the hash over UTF-8 bytes, and an unpaired surrogate has no UTF-8 encoding, so
        # each one is replaced with U+FFFD before encoding. Not errors="replace", which substitutes
        # "?" when encoding, and not a surrogatepass round trip, which yields one U+FFFD per byte
        # rather than per character. This digest is the only key matching one dispatch to another
        # across hosts, so it has to be the same number in every language.
        raw = _SURROGATE.sub("\ufffd", text).encode("utf-8")
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        attrs["code_mode.program.hash"] = digest
        if not self.values:
            return
        note: dict[str, Any] = {"bytes": len(raw), "hash": digest}
        if len(raw) <= self._program_cap:
            attrs["code_mode.program.text"] = text
        else:
            attrs["code_mode.program.text"] = raw[: self._program_cap].decode("utf-8", "ignore")
            note["truncated"] = True
        notes["code_mode.program.text"] = note

    def value(self, key: str, value: Any, attrs: MutableMapping[str, Any], notes: MutableMapping[str, dict[str, Any]]) -> None:
        """One Opt-In payload attribute and its note, as a JSON string: the span attribute APIs of
        the three major languages take primitives and homogeneous arrays, never the nested map
        ``any`` allows."""
        if not self.values:
            return
        try:
            encoded = self._encode(value)
        except _INTERRUPT:
            raise
        except BaseException:
            # Serializing runs program-authored code: a property, a __getattr__, a __dict__ that
            # lies, and a cycle raises by design. 7 calls a value the host could not serialize one
            # it dropped by its own policy, which is `redacted`. This is an ordinary path, not a
            # fault, and nothing from it may raise into the caller: an emitter that can fail a call
            # has made observability an outage.
            self.redacted(key, notes)
            return
        if encoded.text is None:
            self.redacted(key, notes)
            return
        attrs[key] = encoded.text
        note: dict[str, Any] = {}
        if encoded.truncated:
            note["truncated"] = True
        if encoded.size is not None:
            note["bytes"] = encoded.size
        if encoded.digest is not None:
            note["hash"] = "sha256:" + encoded.digest
        if note:
            notes[key] = note

    def redacted(self, key: str, notes: MutableMapping[str, dict[str, Any]], size: int | None = None) -> None:
        """The host held this value and removed it by policy, which is not the same as never
        recording it."""
        notes[key] = {"redacted": True} if size is None else {"redacted": True, "bytes": size}

    def _encode(self, value: Any) -> _Encoded:
        """Streams the serialization: the first ``cap`` bytes are kept, the whole is measured and
        hashed up to ``measure``, and nothing past that is read at all. The value is never
        materialized as one string first, which is what a program would use to exhaust the host."""
        # A single string far past the cap is refused rather than read: `json` escapes a string as
        # one chunk, so escaping it first is work a program can ask for without limit, and there is
        # nothing useful to report about a value that was never read. ponytail: this catches the
        # value itself, not one buried in an object, where the loop below stops only after the chunk
        # is built; bounding that needs an encoder that escapes incrementally.
        if isinstance(value, str) and len(value) > _READ_FACTOR * self._cap:
            return _Encoded(text=None, truncated=True, size=None, digest=None)
        digest = hashlib.sha256()
        kept: list[str] = []
        room = self._cap
        written = 0
        total = 0
        complete = True
        for chunk in _ENCODER.iterencode(value):
            raw = chunk.encode("utf-8")
            if room > 0:
                if len(raw) <= room:
                    kept.append(chunk)
                    room -= len(raw)
                    written += len(raw)
                else:
                    # errors="ignore" drops a partial trailing sequence, so the cut lands on a
                    # UTF-8 code point boundary. The prefix need not parse; 7 says so.
                    head = raw[:room].decode("utf-8", "ignore")
                    kept.append(head)
                    written += len(head.encode("utf-8"))
                    room = 0
            total += len(raw)
            if total > self._measure:
                complete = False
                break
            digest.update(raw)
        prefix = "".join(kept)
        truncated = not complete or written < total
        return _Encoded(
            # A whole serialization is written as itself. A prefix is written as a JSON string
            # literal instead, so the attribute still parses: a consumer that parses every payload
            # attribute would otherwise meet a half-open brace and treat the whole span as corrupt.
            # Cutting the source before escaping is what keeps the cut outside an escape sequence.
            text=prefix if not truncated else _fit_literal(prefix, self._cap),
            truncated=truncated,
            size=total if complete else None,
            digest=digest.hexdigest() if complete else None,
        )


def _fit_literal(s: str, cap: int) -> str:
    """The longest prefix of ``s`` whose JSON string literal fits in ``cap`` bytes. A literal is
    never shorter than what it quotes, so the answer lies inside ``s`` and a binary search finds it
    in a handful of passes."""
    literal = json.dumps(s, ensure_ascii=False)
    if len(literal.encode("utf-8")) <= cap:
        return literal
    if cap < 2:
        return ""
    low, high = 0, len(s)
    while low < high:
        mid = (low + high + 1) // 2
        if len(json.dumps(s[:mid], ensure_ascii=False).encode("utf-8")) <= cap:
            low = mid
        else:
            high = mid - 1
    return json.dumps(s[:low], ensure_ascii=False)


def write_notes(attrs: MutableMapping[str, Any], notes: MutableMapping[str, dict[str, Any]]) -> None:
    """Writes the note onto the span, if the host has anything to say about what it captured."""
    if notes:
        attrs["code_mode.capture"] = json.dumps(notes, separators=(",", ":"), ensure_ascii=False)


def _positive(given: int, name: str) -> int:
    if not isinstance(given, int) or isinstance(given, bool) or given < 1:
        raise ValueError(f"mocon: capture {name} must be a positive integer")
    return given
