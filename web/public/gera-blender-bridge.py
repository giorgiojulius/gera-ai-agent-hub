#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Gera Blender bridge.

Runs the upstream `blender-mcp` stdio server (ahujasid/blender-mcp) on this
computer and publishes it as a Streamable HTTP MCP endpoint that Gera's
server can call through an HTTPS tunnel:

    http://127.0.0.1:8000/mcp

The bridge protects itself: every request must carry its own Bearer token,
so the HTTPS address may be a plain tunnel (Cloudflare quick tunnel, ngrok,
...) with no Cloudflare Access application or service token in front of it.
Requests without the token are answered 401 before anything reaches Blender.

Besides relaying blender-mcp's own tools, the bridge adds two of its own so
files from the internet land on this computer reliably instead of being
fetched inside Blender's Python (where Python's default User-Agent is
answered 403 by CDNs such as *.r2.dev, nothing can retry or resume, and the
add-on's safe mode forbids network code altogether):

    download_file           public URL → ~/.gera/blender-downloads/<name>, returns the local path
    import_model_from_url   the same download, then imports the model into the open scene

Only the Python standard library is used. Third-party bridges such as
`mcp-proxy` import private symbols of the `mcp` package, which is why
`mcp==2.0.0` (2026-07-28) broke them with
`ImportError: cannot import name 'request_ctx'`; nothing here can drift like that.

Usage:
    uv run gera-blender-bridge.py --tunnel       # serve + Cloudflare quick tunnel, prints what to paste into Gera
    uv run gera-blender-bridge.py                # serve on 127.0.0.1:8000 only (bring your own HTTPS tunnel)
    uv run gera-blender-bridge.py --show-token   # print the stored token and exit
    uv run gera-blender-bridge.py --rotate-token # replace the stored token
    uv run gera-blender-bridge.py --downloads-dir ~/Models --max-download-mb 4096

`python3 gera-blender-bridge.py ...` works too (Python 3.10+).
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import re
import secrets
import shlex
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "1.1.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_COMMAND = "uvx blender-mcp"
DEFAULT_TIMEOUT_S = 120.0
STARTUP_TIMEOUT_S = 300.0  # the first `uvx blender-mcp` run downloads and installs packages
MAX_BODY_BYTES = 16 * 1024 * 1024
MCP_PATH = "/mcp"
# The bridge relays tools/list and tools/call, whose wire shape is identical across these revisions.
# 2025-11-25 is the newest revision of the initialize-handshake line and the ceiling of the mcp 1.x SDK that
# `blender-mcp` pins (`mcp<2`). The 2026-07-28 revision (server/discover, no handshake or sessions) is the
# client's business: Gera probes it first and falls back to initialize when this bridge answers -32601.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
WWW_AUTHENTICATE = 'Bearer realm="gera-blender-bridge"'
TOKEN_FILE = Path.home() / ".gera" / "blender-bridge.token"
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# Downloads land here; Blender reads them from the returned absolute path.
DOWNLOADS_DIR = Path.home() / ".gera" / "blender-downloads"
DOWNLOAD_MAX_MB = 2048
# Gera abandons an MCP tools/call after 40 s. A call waits this long for the transfer, then reports progress;
# the transfer itself keeps running and the next call with the same URL picks it up.
DOWNLOAD_WAIT_S = 25.0
DOWNLOAD_WAIT_MAX_S = 30.0
DOWNLOAD_ATTEMPTS = 5
DOWNLOAD_READ_TIMEOUT_S = 30.0
DOWNLOAD_CHUNK_BYTES = 256 * 1024
# Cloudflare's r2.dev (and other CDNs) answer Python's default `Python-urllib/3.x` User-Agent with 403.
BRIDGE_USER_AGENT = f"Mozilla/5.0 (compatible; gera-blender-bridge/{BRIDGE_VERSION})"
BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
CONTENT_TYPE_EXTENSIONS = {
    "model/gltf-binary": ".glb",
    "model/gltf+json": ".gltf",
    "model/obj": ".obj",
    "model/stl": ".stl",
    "application/sla": ".stl",
    "model/vnd.usdz+zip": ".usdz",
    "application/x-blender": ".blend",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/vnd.radiance": ".hdr",
    "image/x-exr": ".exr",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/zip": ".zip",
    "application/octet-stream": "",
}
# Importers Blender may have, newest first. Blender 5.0 made the C++ FBX importer (`wm.fbx_import`) the
# default and marked the Python add-on legacy; 4.x still has `import_scene.fbx`. Every candidate is tried.
IMPORTERS: dict[str, tuple[str, ...]] = {
    ".glb": ("bpy.ops.import_scene.gltf",),
    ".gltf": ("bpy.ops.import_scene.gltf",),
    ".fbx": ("bpy.ops.wm.fbx_import", "bpy.ops.import_scene.fbx"),
    ".obj": ("bpy.ops.wm.obj_import", "bpy.ops.import_scene.obj"),
    ".stl": ("bpy.ops.wm.stl_import", "bpy.ops.import_mesh.stl"),
    ".ply": ("bpy.ops.wm.ply_import", "bpy.ops.import_mesh.ply"),
    ".usd": ("bpy.ops.wm.usd_import",),
    ".usda": ("bpy.ops.wm.usd_import",),
    ".usdc": ("bpy.ops.wm.usd_import",),
    ".usdz": ("bpy.ops.wm.usd_import",),
    ".abc": ("bpy.ops.wm.alembic_import",),
    ".dae": ("bpy.ops.wm.collada_import",),
    ".blend": (),  # appended through bpy.data.libraries instead of an operator
}
IMPORTABLE_EXTENSIONS = tuple(IMPORTERS)
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def negotiate_version(requested: Any, upstream: Any) -> str:
    """Pick the revision to advertise to Gera: never newer than what blender-mcp itself agreed to.

    Revisions are ISO dates, so plain string comparison orders them. A client asking for an older
    supported revision gets it (the relayed methods are identical); anything else gets the upstream one.
    """
    ceiling = upstream if isinstance(upstream, str) and upstream in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0]
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS and requested <= ceiling:
        return requested
    return ceiling


JSON_RPC_PARSE_ERROR = -32700
JSON_RPC_INVALID_REQUEST = -32600
JSON_RPC_METHOD_NOT_FOUND = -32601
BRIDGE_TIMEOUT_ERROR = -32001
BRIDGE_UPSTREAM_ERROR = -32002

_log_lock = threading.Lock()


def log(message: str) -> None:
    """One line on stderr; never headers, bodies, full URLs or the token."""
    with _log_lock:
        sys.stderr.write(f"[gera-bridge {time.strftime('%H:%M:%S')}] {message}\n")
        sys.stderr.flush()


def banner(lines: list[str]) -> None:
    rule = "─" * 72
    with _log_lock:
        sys.stdout.write("\n" + rule + "\n" + "\n".join(f"  {line}" for line in lines) + "\n" + rule + "\n\n")
        sys.stdout.flush()


class BridgeError(Exception):
    """A failure the bridge reports to the client as a JSON-RPC error."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class ToolError(Exception):
    """A bridge-tool failure reported to the model as an `isError` tool result, never as a JSON-RPC error."""


class _Retry(Exception):
    """One download attempt failed in a way the next attempt may fix (resume or plain retry)."""


def rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


# ---------------------------------------------------------------------------
# Token


def load_or_create_token(path: Path, rotate: bool = False) -> tuple[str, bool]:
    """Returns (token, created). The file is private to the current user."""
    if not rotate and path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token, False
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    return token, True


# ---------------------------------------------------------------------------
# Upstream stdio MCP server


class _Pending:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.frame: dict[str, Any] | None = None
        self.failure: str | None = None


class StdioMcpChild:
    """One upstream stdio MCP server, initialized once and shared by every HTTP session."""

    def __init__(self, command: list[str], timeout_s: float) -> None:
        self.command = command
        self.timeout_s = timeout_s
        self.init_result: dict[str, Any] = {}
        self._proc: subprocess.Popen[bytes] | None = None
        self._start_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[int, _Pending] = {}
        self._next_id = 0

    # -- lifecycle ----------------------------------------------------------

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def ensure_started(self) -> None:
        """Spawns and initializes the upstream server if it is not running (single-flight)."""
        with self._start_lock:
            if self.is_running():
                return
            self._spawn()
            try:
                self._handshake()
            except BridgeError:
                self.stop()
                raise

    def _spawn(self) -> None:
        executable = shutil.which(self.command[0])
        if executable is None:
            raise BridgeError(
                BRIDGE_UPSTREAM_ERROR,
                f"'{self.command[0]}' was not found on PATH. Install uv (https://docs.astral.sh/uv/) or pass --command.",
            )
        env = dict(os.environ)
        env.setdefault("DISABLE_TELEMETRY", "true")
        env.setdefault("PYTHONUNBUFFERED", "1")
        log(f"starting upstream: {' '.join(self.command)}")
        self._proc = subprocess.Popen(
            [executable, *self.command[1:]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # blender-mcp logs to stderr; keep it visible in this terminal
            env=env,
            bufsize=0,
        )
        threading.Thread(target=self._read_loop, args=(self._proc,), name="upstream-stdout", daemon=True).start()

    def _handshake(self) -> None:
        frame = self.request(
            "initialize",
            {
                "protocolVersion": SUPPORTED_PROTOCOL_VERSIONS[0],
                "capabilities": {},
                "clientInfo": {"name": "gera-blender-bridge", "version": BRIDGE_VERSION},
            },
            timeout_s=STARTUP_TIMEOUT_S,
        )
        if "error" in frame:
            message = frame["error"].get("message") if isinstance(frame.get("error"), dict) else None
            raise BridgeError(BRIDGE_UPSTREAM_ERROR, f"blender-mcp refused initialize: {message or 'unknown error'}")
        result = frame.get("result")
        self.init_result = result if isinstance(result, dict) else {}
        self.notify("notifications/initialized")
        info = self.init_result.get("serverInfo") or {}
        log(
            f"upstream ready: {info.get('name', 'blender-mcp')} {info.get('version', '')} "
            f"· MCP {self.init_result.get('protocolVersion', '?')}"
        )

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.poll() is not None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    # -- wire ----------------------------------------------------------------

    def _write(self, message: dict[str, Any]) -> None:
        data = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        with self._write_lock:
            proc = self._proc
            if proc is None or proc.stdin is None or proc.poll() is not None:
                raise BridgeError(BRIDGE_UPSTREAM_ERROR, "blender-mcp is not running")
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise BridgeError(BRIDGE_UPSTREAM_ERROR, f"could not write to blender-mcp: {exc}") from exc

    def notify(self, method: str, params: Any = None) -> None:
        frame: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        self._write(frame)

    def request(self, method: str, params: Any, timeout_s: float | None = None) -> dict[str, Any]:
        """Sends one request and returns the upstream response frame (its `id` is the bridge's own)."""
        pending = _Pending()
        with self._pending_lock:
            self._next_id += 1
            request_id = self._next_id
            self._pending[request_id] = pending
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        timeout = timeout_s or self.timeout_s
        try:
            self._write(frame)
            if not pending.event.wait(timeout):
                raise BridgeError(
                    BRIDGE_TIMEOUT_ERROR,
                    f"blender-mcp did not answer {method} within {int(timeout)} s. Is Blender open with the add-on's "
                    "MCP server started (N panel → BlenderMCP → Start MCP Server)?",
                )
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)
        if pending.failure is not None:
            raise BridgeError(BRIDGE_UPSTREAM_ERROR, pending.failure)
        return pending.frame or rpc_error(request_id, BRIDGE_UPSTREAM_ERROR, "empty upstream response")

    def _read_loop(self, proc: subprocess.Popen[bytes]) -> None:
        stdout = proc.stdout
        assert stdout is not None
        for raw in iter(stdout.readline, b""):
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                log(f"upstream wrote a non-JSON line to stdout ({len(line)} bytes); ignored")
                continue
            for frame in message if isinstance(message, list) else [message]:
                if isinstance(frame, dict):
                    self._dispatch(frame)
        code = proc.wait()
        log(f"upstream exited with code {code}")
        self._fail_pending(f"blender-mcp exited with code {code}; the next request restarts it")

    def _dispatch(self, frame: dict[str, Any]) -> None:
        method = frame.get("method")
        if method is None:
            request_id = frame.get("id")
            with self._pending_lock:
                pending = self._pending.get(request_id) if isinstance(request_id, int) else None
            if pending is None:
                log(f"upstream response for unknown request id {request_id!r}; dropped")
                return
            pending.frame = frame
            pending.event.set()
            return
        if "id" in frame and frame["id"] is not None:
            # Server → client requests: blender-mcp does not use them; answer honestly.
            if method == "ping":
                reply: dict[str, Any] = {"jsonrpc": "2.0", "id": frame["id"], "result": {}}
            elif method == "roots/list":
                reply = {"jsonrpc": "2.0", "id": frame["id"], "result": {"roots": []}}
            else:
                reply = rpc_error(frame["id"], JSON_RPC_METHOD_NOT_FOUND, f"gera-blender-bridge does not support {method}")
            try:
                self._write(reply)
            except BridgeError:
                pass
            return
        # Notifications (logging, progress, list_changed) have no stream to ride on; the POST reply carries the result.

    def _fail_pending(self, reason: str) -> None:
        with self._pending_lock:
            waiting = list(self._pending.values())
            self._pending.clear()
        for pending in waiting:
            pending.failure = reason
            pending.event.set()


# ---------------------------------------------------------------------------
# Downloads: files from the internet land on this computer, next to Blender


def format_bytes(count: int | None) -> str:
    if count is None:
        return "unknown size"
    if count < 1024:
        return f"{count} B"
    if count < 1024 * 1024:
        return f"{count / 1024:.0f} KB"
    return f"{count / (1024 * 1024):.1f} MB"


def safe_file_name(name: str) -> str:
    """Letters, digits, dot, dash, underscore; no directories, no hidden files, at most 100 characters."""
    cleaned = SAFE_NAME_RE.sub("_", name).strip("._")
    return cleaned[:100] or "download"


def name_from_url(url: str) -> str:
    path = urllib.parse.unquote(urllib.parse.urlsplit(url).path)
    return safe_file_name(path.rsplit("/", 1)[-1])


def validate_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolError("url is required")
    url = value.strip()
    if any(character in url for character in "\r\n\t "):
        raise ToolError("url contains whitespace or control characters")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ToolError("url must be a public http(s) address; file:, data: and local paths cannot be downloaded")
    return url


def wait_seconds(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return DOWNLOAD_WAIT_S
    return max(0.0, min(float(value), DOWNLOAD_WAIT_MAX_S))


def extension_for(content_type: str, head: bytes) -> str:
    if head[:4] == b"glTF":
        return ".glb"
    if content_type in CONTENT_TYPE_EXTENSIONS:
        return CONTENT_TYPE_EXTENSIONS[content_type]
    return mimetypes.guess_extension(content_type) or "" if content_type else ""


def gltf_facts(doc: dict[str, Any]) -> dict[str, Any]:
    """Counts, animation clips with their length in seconds, and external resources the file still points at."""
    accessors = doc.get("accessors") if isinstance(doc.get("accessors"), list) else []
    animations: list[dict[str, Any]] = []
    for index, animation in enumerate(doc.get("animations") or []):
        if not isinstance(animation, dict):
            continue
        seconds = 0.0
        for sampler in animation.get("samplers") or []:
            input_index = sampler.get("input") if isinstance(sampler, dict) else None
            accessor = accessors[input_index] if isinstance(input_index, int) and 0 <= input_index < len(accessors) else {}
            maximum = accessor.get("max") if isinstance(accessor, dict) else None
            if isinstance(maximum, list) and maximum and isinstance(maximum[0], (int, float)):
                seconds = max(seconds, float(maximum[0]))
        animations.append({"name": animation.get("name") or f"animation_{index}", "seconds": round(seconds, 3), "channels": len(animation.get("channels") or [])})
    external = [
        item["uri"]
        for key in ("buffers", "images")
        for item in (doc.get(key) or [])
        if isinstance(item, dict) and isinstance(item.get("uri"), str) and not item["uri"].startswith("data:")
    ]
    asset = doc.get("asset") if isinstance(doc.get("asset"), dict) else {}
    facts: dict[str, Any] = {
        "generator": asset.get("generator"),
        "nodes": len(doc.get("nodes") or []),
        "meshes": len(doc.get("meshes") or []),
        "materials": len(doc.get("materials") or []),
        "skins": len(doc.get("skins") or []),
        "animations": animations[:40],
    }
    if external:
        facts["external_resources"] = external[:20]
        facts["external_resources_note"] = "These files are referenced by relative URI; download them next to the model before importing."
    return facts


def summarize_glb(path: Path) -> dict[str, Any]:
    """Validates the binary-glTF container and reports what is inside without opening Blender."""
    size = path.stat().st_size
    with path.open("rb") as handle:
        header = handle.read(20)
        if len(header) < 20 or header[:4] != b"glTF":
            return {"ok": False, "detail": "not a binary glTF: the file does not start with the glTF magic (an HTML error or login page instead of a model?)"}
        version = int.from_bytes(header[4:8], "little")
        declared = int.from_bytes(header[8:12], "little")
        chunk_length = int.from_bytes(header[12:16], "little")
        if header[16:20] != b"JSON" or chunk_length > size:
            return {"ok": False, "detail": "binary glTF header is damaged: the first chunk is not JSON"}
        try:
            doc = json.loads(handle.read(chunk_length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {"ok": False, "detail": "binary glTF JSON chunk does not parse"}
    ok = version == 2 and declared == size
    detail = "valid binary glTF 2.0" if ok else f"glTF version {version}; header declares {declared} bytes, the file has {size}"
    return {"ok": ok, "detail": detail, **gltf_facts(doc if isinstance(doc, dict) else {})}


def verify_file(path: Path, suffix: str, head: bytes, size: int, announced: int | None) -> dict[str, Any]:
    """Structure checks for the formats the bridge knows; a size check for everything else."""
    if suffix == ".glb":
        return summarize_glb(path)
    if suffix == ".gltf":
        try:
            doc = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return {"ok": False, "detail": "glTF JSON does not parse"}
        return {"ok": True, "detail": "glTF JSON parses", **gltf_facts(doc if isinstance(doc, dict) else {})}
    if suffix == ".blend":
        ok = head.startswith(b"BLENDER") or head[:2] == b"\x1f\x8b" or head[:4] == b"\x28\xb5\x2f\xfd"  # plain, gzip, zstd
        return {"ok": ok, "detail": "Blender file" if ok else "does not look like a .blend file"}
    if announced is not None:
        return {"ok": True, "detail": f"complete: {format_bytes(size)}, matches the server's Content-Length"}
    return {"ok": True, "detail": f"complete: {format_bytes(size)} (the server sent no Content-Length)"}


def import_hint(suffix: str, path: Path) -> str:
    literal = repr(str(path))
    if suffix == ".blend":
        return f"Append its objects with import_model_from_url (same url), or open it: bpy.ops.wm.open_mainfile(filepath={literal})"
    if suffix in IMPORTERS:
        return f"Import with import_model_from_url (same url) or in execute_blender_code: {IMPORTERS[suffix][0]}(filepath={literal})"
    if suffix in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".bmp"):
        return f"Use it as a texture in execute_blender_code: bpy.data.images.load({literal})"
    if suffix in (".mp3", ".wav", ".ogg", ".flac"):
        return f"Load it in execute_blender_code: bpy.data.sounds.load({literal})"
    if suffix in (".mp4", ".mov", ".webm"):
        return f"Load it in execute_blender_code: bpy.data.movieclips.load({literal})"
    return f"The file is at {literal} on the Blender computer; use it from execute_blender_code."


def _body_excerpt(error: urllib.error.HTTPError) -> str:
    try:
        text = error.read(400).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - the excerpt is a courtesy
        return ""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()
    return f": {text[:160]}" if text else ""


def _retry_after(error: urllib.error.HTTPError) -> float:
    value = error.headers.get("Retry-After") if error.headers is not None else None
    if isinstance(value, str) and value.strip().isdigit():
        return min(float(value.strip()), 10.0)
    return 0.0


def _is_certificate_error(error: urllib.error.URLError) -> bool:
    reason = error.reason
    return isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason)


class DownloadJob:
    """One transfer; lives on after the HTTP call that started it so a slow file is never restarted."""

    def __init__(self, url: str, target: Path) -> None:
        self.url = url
        self.host = urllib.parse.urlsplit(url).hostname or "?"
        self.target = target
        self.part = target.with_name(target.name + ".part")
        self.done = threading.Event()
        self.state = "downloading"  # downloading | done | failed
        self.error: str | None = None
        self.received = 0
        self.total: int | None = None
        self.content_type = ""
        self.validator: str | None = None  # ETag or Last-Modified, needed to resume safely
        self.attempts = 0
        self.notes: list[str] = []
        self.result: dict[str, Any] = {}
        self.started = time.monotonic()
        self.elapsed = 0.0

    def status(self) -> dict[str, Any]:
        elapsed = self.elapsed if self.state != "downloading" else time.monotonic() - self.started
        payload: dict[str, Any] = {
            "status": self.state,
            "file": self.target.name,
            "path": str(self.target),
            "host": self.host,
            "received_bytes": self.received,
            "total_bytes": self.total,
            "elapsed_seconds": round(elapsed, 1),
            "attempts": self.attempts,
        }
        if self.total:
            payload["percent"] = round(100 * self.received / self.total, 1)
        if self.notes:
            payload["notes"] = list(self.notes)
        if self.state == "downloading":
            payload["hint"] = "The transfer keeps running on this computer. Call again with the same url to keep waiting; the reply arrives as soon as it finishes."
        elif self.state == "failed":
            payload["error"] = self.error
            payload["hint"] = "Call again to retry from scratch, or open the URL in a browser to see what the server answers."
        else:
            payload.update(self.result)
        return payload


class Downloader:
    """Browser-grade headers, retries with backoff, resume, verification and a manifest of what was saved."""

    def __init__(self, directory: Path, max_bytes: int) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._jobs: dict[str, DownloadJob] = {}

    # -- public --------------------------------------------------------------

    def fetch(self, url: str, filename: str | None, overwrite: bool, wait_s: float) -> dict[str, Any]:
        """Starts (or joins) the transfer for `url`, waits up to `wait_s` for it and returns its status."""
        with self._lock:
            job = self._jobs.get(url)
            if job is not None and job.state != "downloading" and (overwrite or job.state == "failed" or not job.target.exists()):
                self._jobs.pop(url, None)
                job = None
            finished_earlier = job is not None and job.done.is_set()
            if job is None:
                cached = None if overwrite else self._cached(url)
                if cached is not None:
                    return cached
                self.directory.mkdir(parents=True, exist_ok=True)
                job = DownloadJob(url, self._target_for(url, filename, overwrite))
                self._jobs[url] = job
                threading.Thread(target=self._run, args=(job,), name=f"download-{job.target.name}", daemon=True).start()
        job.done.wait(max(0.0, wait_s))
        payload = job.status()
        if finished_earlier and payload.get("status") == "done":
            payload["cached"] = True
            payload["hint"] = f"Already on this computer from an earlier download (pass overwrite=true for a fresh copy). {import_hint(job.target.suffix.lower(), job.target)}"
        return payload

    # -- manifest ------------------------------------------------------------

    def _manifest_path(self) -> Path:
        return self.directory / "manifest.json"

    def _load_manifest(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self._manifest_path().read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        files = data.get("files") if isinstance(data, dict) else None
        return {name: entry for name, entry in files.items() if isinstance(entry, dict)} if isinstance(files, dict) else {}

    def _save_manifest(self, files: dict[str, dict[str, Any]]) -> None:
        path = self._manifest_path()
        temporary = path.with_name("manifest.json.tmp")
        temporary.write_text(json.dumps({"bridge": BRIDGE_VERSION, "files": files}, indent=2), "utf-8")
        os.replace(temporary, path)

    def _cached(self, url: str) -> dict[str, Any] | None:
        for name, entry in self._load_manifest().items():
            if entry.get("url") != url:
                continue
            path = self.directory / name
            if not path.exists() or path.stat().st_size != entry.get("bytes"):
                continue
            return {
                "status": "done",
                "cached": True,
                "file": name,
                "path": str(path),
                "host": urllib.parse.urlsplit(url).hostname or "?",
                "bytes": entry.get("bytes"),
                "size": format_bytes(entry.get("bytes") if isinstance(entry.get("bytes"), int) else None),
                "sha256": entry.get("sha256"),
                "content_type": entry.get("content_type"),
                "saved_at": entry.get("saved_at"),
                "verification": entry.get("verification"),
                "hint": f"Already on this computer from an earlier download (pass overwrite=true for a fresh copy). {import_hint(path.suffix.lower(), path)}",
            }
        return None

    def _target_for(self, url: str, filename: str | None, overwrite: bool) -> Path:
        manifest = self._load_manifest()
        if overwrite:
            for name, entry in list(manifest.items()):
                if entry.get("url") == url:
                    manifest.pop(name)
                    (self.directory / name).unlink(missing_ok=True)
            self._save_manifest(manifest)
        name = safe_file_name(filename) if filename else name_from_url(url)
        busy = {job.target.name for job in self._jobs.values() if job.url != url}
        taken = (self.directory / name).exists() and manifest.get(name, {}).get("url") != url
        if name in busy or taken:
            stem, extension = os.path.splitext(name)
            name = f"{stem}-{hashlib.sha1(url.encode('utf-8')).hexdigest()[:6]}{extension}"
        return self.directory / name

    # -- transfer ------------------------------------------------------------

    def _run(self, job: DownloadJob) -> None:
        try:
            self._transfer(job)
            self._finish(job)
            job.elapsed = time.monotonic() - job.started
            job.state = "done"
            verification = job.result.get("verification") if isinstance(job.result.get("verification"), dict) else {}
            log(f"download {job.target.name} ← {job.host} · {format_bytes(job.received)} · {job.elapsed:.1f}s · {verification.get('detail', 'ok')}")
        except ToolError as exc:
            self._fail(job, str(exc))
        except Exception as exc:  # noqa: BLE001 - the model must hear about it and the bridge must stay up
            self._fail(job, f"{type(exc).__name__}: {exc}")
        finally:
            job.done.set()

    def _fail(self, job: DownloadJob, error: str) -> None:
        job.elapsed = time.monotonic() - job.started
        job.error = error
        job.state = "failed"
        job.part.unlink(missing_ok=True)
        log(f"download {job.target.name} ← {job.host} failed: {error}")

    def _transfer(self, job: DownloadJob) -> None:
        job.part.unlink(missing_ok=True)
        offset = 0
        user_agent = BRIDGE_USER_AGENT
        delay = 1.0
        last_error = "no attempt was made"
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            job.attempts = attempt
            headers = {"User-Agent": user_agent, "Accept": "*/*", "Accept-Encoding": "identity"}
            if offset and job.validator:
                headers["Range"] = f"bytes={offset}-"
                headers["If-Range"] = job.validator
            elif offset:
                offset = 0  # nothing to validate a resume against: start over
            try:
                request = urllib.request.Request(job.url, headers=headers)
                with urllib.request.urlopen(request, timeout=DOWNLOAD_READ_TIMEOUT_S) as response:
                    self._receive(job, response, offset)
                return
            except urllib.error.HTTPError as exc:
                excerpt = _body_excerpt(exc)
                if exc.code == 403 and user_agent == BRIDGE_USER_AGENT:
                    user_agent = BROWSER_USER_AGENT
                    job.notes.append("403 for the bridge User-Agent; retrying with a browser User-Agent")
                    continue
                if exc.code == 416 and offset:
                    offset = 0
                    job.notes.append("server refused the resume range; starting over")
                    continue
                if exc.code not in RETRYABLE_HTTP_STATUSES:
                    raise ToolError(f"HTTP {exc.code} {exc.reason} from {job.host}{excerpt}") from exc
                last_error = f"HTTP {exc.code} {exc.reason}{excerpt}"
                delay = max(delay, _retry_after(exc))
            except urllib.error.URLError as exc:
                if _is_certificate_error(exc):
                    self._transfer_with_curl(job, offset)
                    return
                last_error = f"connection to {job.host} failed: {exc.reason}"
            except (OSError, http.client.HTTPException, _Retry) as exc:
                last_error = str(exc) or type(exc).__name__
                offset = job.part.stat().st_size if job.part.exists() else 0  # resume from what landed
            if attempt < DOWNLOAD_ATTEMPTS:
                job.notes.append(f"attempt {attempt} failed ({last_error}); retrying in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, 8.0)
        raise ToolError(f"gave up after {DOWNLOAD_ATTEMPTS} attempts: {last_error}")

    def _receive(self, job: DownloadJob, response: Any, offset: int) -> None:
        status = getattr(response, "status", 200)
        if offset and status != 206:
            offset = 0  # the server sent the whole file again: ranges unsupported or the file changed
            job.notes.append("server did not honour the resume range; starting over")
        elif offset:
            job.notes.append(f"resumed at {format_bytes(offset)}")
        headers = response.headers
        total: int | None = None
        if status == 206:
            match = re.search(r"/(\d+)\s*$", headers.get("Content-Range") or "")
            total = int(match.group(1)) if match else None
        else:
            length = (headers.get("Content-Length") or "").strip()
            total = int(length) if length.isdigit() else None
        if total is not None and total > self.max_bytes:
            raise ToolError(f"{format_bytes(total)} exceeds this bridge's limit of {self.max_bytes // (1024 * 1024)} MB (start it with --max-download-mb to raise it)")
        job.total = total
        job.content_type = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
        job.validator = headers.get("ETag") or headers.get("Last-Modified") or job.validator
        with job.part.open("ab" if offset else "wb") as handle:
            while True:
                chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                handle.write(chunk)
                offset += len(chunk)
                job.received = offset
                if offset > self.max_bytes:
                    raise ToolError(f"more than {self.max_bytes // (1024 * 1024)} MB arrived; stopped (start the bridge with --max-download-mb to allow it)")
        if total is not None and offset < total:
            raise _Retry(f"connection closed after {format_bytes(offset)} of {format_bytes(total)}")

    def _transfer_with_curl(self, job: DownloadJob, offset: int) -> None:
        """Fallback for Pythons without a CA bundle (python.org macOS builds before Install Certificates.command)."""
        binary = shutil.which("curl")
        if binary is None:
            raise ToolError(
                "Python could not verify the server's TLS certificate (this Python has no CA bundle) and curl is not installed. "
                "Run the 'Install Certificates.command' that ships with python.org builds, or install curl, then retry."
            )
        job.notes.append("Python has no CA bundle for TLS; downloading with curl instead")
        command = [
            binary, "--fail", "--silent", "--show-error", "--location", "--retry", "3", "--retry-all-errors",
            "--max-time", "900", "--max-filesize", str(self.max_bytes), "--user-agent", BRIDGE_USER_AGENT,
            "--header", "Accept: */*", "--write-out", "%{content_type}", "--output", str(job.part),
        ]
        if offset:
            command += ["--continue-at", "-"]
        command.append(job.url)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        while process.poll() is None:
            time.sleep(0.5)
            job.received = job.part.stat().st_size if job.part.exists() else 0
        stdout, stderr = process.communicate()
        if process.returncode != 0:
            raise ToolError(f"curl failed ({process.returncode}): {stderr.decode('utf-8', 'replace').strip()[:300]}")
        job.received = job.part.stat().st_size if job.part.exists() else 0
        job.total = job.received
        job.content_type = stdout.decode("utf-8", "replace").split(";")[0].strip().lower()

    def _finish(self, job: DownloadJob) -> None:
        size = job.part.stat().st_size if job.part.exists() else 0
        if size == 0:
            raise ToolError(f"{job.host} sent an empty file")
        if job.total is not None and size != job.total:
            raise ToolError(f"received {format_bytes(size)} but the server announced {format_bytes(job.total)}")
        with job.part.open("rb") as handle:
            head = handle.read(16)
        target = job.target
        if not target.suffix:
            extension = extension_for(job.content_type, head)
            if extension:
                target = target.with_name(target.name + extension)
        suffix = target.suffix.lower()
        verification = verify_file(job.part, suffix, head, size, job.total)
        if suffix in (".glb", ".gltf") and not verification.get("ok"):
            raise ToolError(f"{target.name}: {verification.get('detail')} (Content-Type {job.content_type or 'unknown'})")
        digest = hashlib.sha256()
        with job.part.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        with self._lock:
            manifest = self._load_manifest()
            if target != job.target and target.exists() and manifest.get(target.name, {}).get("url") != job.url:
                stem, extension = os.path.splitext(target.name)
                target = target.with_name(f"{stem}-{hashlib.sha1(job.url.encode('utf-8')).hexdigest()[:6]}{extension}")
            os.replace(job.part, target)
            job.target = target
            entry = {
                "url": job.url,
                "bytes": size,
                "sha256": digest.hexdigest(),
                "content_type": job.content_type,
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "verification": verification,
            }
            manifest[target.name] = entry
            self._save_manifest(manifest)
        job.received = size
        job.result = {
            "cached": False,
            "bytes": size,
            "size": format_bytes(size),
            "sha256": entry["sha256"],
            "content_type": job.content_type,
            "verification": verification,
            "hint": import_hint(suffix, target),
        }


# ---------------------------------------------------------------------------
# Bridge tools (added to blender-mcp's tools/list, answered here)

DOWNLOAD_FILE_DESCRIPTION = (
    "Download a file from a public http(s) URL onto this computer (the one running Blender) and return its absolute local path. "
    "Use this for anything from the internet instead of urllib/requests inside execute_blender_code: CDNs such as *.r2.dev answer "
    "Python's default User-Agent with 403, a download inside Blender blocks the add-on with no retry or resume, and its safe mode "
    "forbids network code. The bridge sends browser-grade headers, retries with backoff, resumes interrupted transfers, verifies "
    "the size (and the structure of .glb/.gltf/.blend files), saves under ~/.gera/blender-downloads and returns instantly when the "
    "same URL was saved before. Big transfers keep running in the background: while status is \"downloading\", call again with the "
    "same url to keep waiting. Afterwards import with import_model_from_url (one step) or in execute_blender_code with the returned "
    "path, e.g. bpy.ops.import_scene.gltf(filepath=path)."
)
IMPORT_MODEL_DESCRIPTION = (
    "Download a 3D model from a public http(s) URL (same engine as download_file) and import it into the open Blender scene in one "
    "step. Formats: .glb/.gltf, .fbx, .obj, .stl, .ply, .usd/.usda/.usdc/.usdz, .abc, .dae, and .blend (appends all its objects). "
    "Existing objects are left untouched. The reply lists the new objects (type, dimensions, vertices, materials, bones), the "
    "animation actions that arrived (name, frame range, seconds), the scene fps and the local path. Optional collection: move the "
    "new objects into a collection of that name. Importing the same file twice creates duplicates, so check get_scene_info first. "
    "While status is \"downloading\", call again with the same url; the import happens as soon as the file is complete."
)
EXECUTE_CODE_NOTE = (
    "Files from the internet: do not download inside this tool. Python's default User-Agent is answered 403 by CDNs such as "
    "*.r2.dev, a transfer here blocks the add-on with no retry or resume, and safe mode rejects network code. Use download_file "
    "(returns a local path) or import_model_from_url (downloads and imports) from this bridge instead."
)
BRIDGE_INSTRUCTIONS = (
    f"gera-blender-bridge {BRIDGE_VERSION}: files from the internet go through download_file or import_model_from_url "
    "(browser-grade headers, retries, resume, verification, saved under the bridge's downloads folder). "
    "Never download inside execute_blender_code."
)
_URL_PROPERTY = {"type": "string", "description": "Public http(s) URL of the file."}
_FILENAME_PROPERTY = {
    "type": "string",
    "description": "Optional name to save under (letters, digits, . _ -). Default: the last URL path segment; a missing extension is inferred from the content.",
}
_OVERWRITE_PROPERTY = {"type": "boolean", "description": "Download again even if this URL was already saved (default false: a saved file is returned instantly)."}
_WAIT_PROPERTY = {
    "type": "integer",
    "minimum": 0,
    "maximum": int(DOWNLOAD_WAIT_MAX_S),
    "description": f"How long this call may wait for the transfer before reporting progress (default {int(DOWNLOAD_WAIT_S)}).",
}
BRIDGE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "download_file",
        "title": "Download a file to the Blender computer",
        "description": DOWNLOAD_FILE_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {"url": _URL_PROPERTY, "filename": _FILENAME_PROPERTY, "overwrite": _OVERWRITE_PROPERTY, "wait_seconds": _WAIT_PROPERTY},
            "required": ["url"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "import_model_from_url",
        "title": "Download a 3D model and import it into the scene",
        "description": IMPORT_MODEL_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": _URL_PROPERTY,
                "filename": _FILENAME_PROPERTY,
                "collection": {"type": "string", "description": "Optional collection name to move the imported objects into (created when missing)."},
                "overwrite": _OVERWRITE_PROPERTY,
                "wait_seconds": _WAIT_PROPERTY,
            },
            "required": ["url"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
]
BRIDGE_TOOL_NAMES = frozenset(tool["name"] for tool in BRIDGE_TOOLS)


def annotate_tools(tools: list[Any]) -> list[Any]:
    """Appends the bridge tools and points execute_blender_code's description at them."""
    annotated: list[Any] = []
    for tool in tools:
        if isinstance(tool, dict) and tool.get("name") == "execute_blender_code" and isinstance(tool.get("description"), str) and EXECUTE_CODE_NOTE not in tool["description"]:
            tool = {**tool, "description": tool["description"].rstrip() + "\n\n" + EXECUTE_CODE_NOTE}
        annotated.append(tool)
    present = {tool.get("name") for tool in annotated if isinstance(tool, dict)}
    annotated.extend(tool for tool in BRIDGE_TOOLS if tool["name"] not in present)
    return annotated


def import_script(path: Path, collection: str | None) -> str:
    """Blender Python that imports `path` into the open scene and prints a JSON summary of what arrived.

    Written to pass blender-mcp's safe mode: literal operator calls (no computed getattr), no os/open, and
    the .blend append (library loading) is only emitted for .blend files.
    """
    suffix = path.suffix.lower()
    lines = [
        "import bpy, json",
        f"path = {str(path)!r}",
        f"collection_name = {collection!r}",
        "scene = bpy.context.scene",
        "objects_before = set(bpy.data.objects.keys())",
        "actions_before = set(bpy.data.actions.keys())",
        "errors = []",
        "imported = False",
    ]
    if suffix == ".blend":
        lines += [
            "with bpy.data.libraries.load(path, link=False) as (source, target):",
            "    target.objects = list(source.objects)",
            "for obj in target.objects:",
            "    if obj is not None:",
            "        scene.collection.objects.link(obj)",
            "imported = True",
        ]
    for operator in IMPORTERS.get(suffix, ()):
        lines += [
            "if not imported:",
            "    try:",
            f"        {operator}(filepath=path)",
            "        imported = True",
            "    except AttributeError as exc:",
            "        errors.append(str(exc))",
        ]
    lines += [
        "if not imported:",
        f"    raise RuntimeError('no importer for {suffix} in this Blender: ' + '; '.join(errors))",
        "new_objects = [obj for name, obj in bpy.data.objects.items() if name not in objects_before]",
        "new_actions = [act for name, act in bpy.data.actions.items() if name not in actions_before]",
        "if collection_name:",
        "    coll = bpy.data.collections.get(collection_name)",
        "    if coll is None:",
        "        coll = bpy.data.collections.new(collection_name)",
        "    if coll.name not in scene.collection.children.keys():",
        "        scene.collection.children.link(coll)",
        "    for obj in new_objects:",
        "        for owner in list(obj.users_collection):",
        "            if owner is not coll:",
        "                owner.objects.unlink(obj)",
        "        if obj.name not in coll.objects.keys():",
        "            coll.objects.link(obj)",
        "fps = scene.render.fps / scene.render.fps_base",
        "def describe(obj):",
        "    info = {'name': obj.name, 'type': obj.type, 'dimensions': [round(v, 3) for v in obj.dimensions], 'location': [round(v, 3) for v in obj.location], 'parent': obj.parent.name if obj.parent else None}",
        "    if obj.type == 'MESH':",
        "        info['vertices'] = len(obj.data.vertices)",
        "        info['materials'] = [slot.material.name for slot in obj.material_slots if slot.material]",
        "    if obj.type == 'ARMATURE':",
        "        info['bones'] = len(obj.data.bones)",
        "    if obj.animation_data and obj.animation_data.action:",
        "        info['action'] = obj.animation_data.action.name",
        "    return info",
        "summary = {",
        "    'scene': scene.name, 'fps': fps, 'frame_range': [scene.frame_start, scene.frame_end],",
        "    'collection': collection_name, 'object_count': len(new_objects),",
        "    'objects': [describe(obj) for obj in new_objects[:60]],",
        "    'actions': [{'name': act.name, 'frames': [round(act.frame_range[0], 1), round(act.frame_range[1], 1)], 'seconds': round((act.frame_range[1] - act.frame_range[0]) / fps, 3)} for act in new_actions[:40]],",
        "}",
        "print('GERA_IMPORT_JSON ' + json.dumps(summary))",
    ]
    return "\n".join(lines) + "\n"


def result_text(result: Any) -> str:
    if not isinstance(result, dict):
        return ""
    parts = [
        item["text"]
        for item in (result.get("content") or [])
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
    ]
    return "\n".join(parts)


class BridgeTools:
    """download_file and import_model_from_url — the only tools answered by the bridge itself."""

    def __init__(self, downloader: Downloader, child: StdioMcpChild) -> None:
        self.downloader = downloader
        self.child = child

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "download_file":
            return self.download(arguments)
        if name == "import_model_from_url":
            return self.import_model(arguments)
        raise ToolError(f"unknown bridge tool {name}")

    def download(self, arguments: dict[str, Any]) -> dict[str, Any]:
        url = validate_url(arguments.get("url"))
        filename = arguments.get("filename")
        filename = filename.strip() if isinstance(filename, str) and filename.strip() else None
        return self.downloader.fetch(url, filename, arguments.get("overwrite") is True, wait_seconds(arguments.get("wait_seconds")))

    def import_model(self, arguments: dict[str, Any]) -> dict[str, Any]:
        status = self.download(arguments)
        if status.get("status") != "done":
            if status.get("status") == "downloading":
                status["hint"] = "Still downloading. Call import_model_from_url again with the same url; the import runs as soon as the file is complete."
            return status
        path = Path(str(status["path"]))
        suffix = path.suffix.lower()
        if suffix not in IMPORTERS:
            raise ToolError(
                f"{path.name} is not a model Blender can import here (supported: {', '.join(IMPORTABLE_EXTENSIONS)}). "
                f"The file is saved at {path}; handle it with execute_blender_code."
            )
        collection = arguments.get("collection")
        collection = collection.strip()[:63] if isinstance(collection, str) and collection.strip() else None
        self.child.ensure_started()
        frame = self.child.request("tools/call", {"name": "execute_blender_code", "arguments": {"code": import_script(path, collection)}})
        if "error" in frame:
            error = frame["error"] if isinstance(frame.get("error"), dict) else {}
            raise ToolError(f"blender-mcp refused execute_blender_code: {error.get('message') or 'unknown error'}")
        text = result_text(frame.get("result"))
        match = re.search(r"GERA_IMPORT_JSON (\{.*\})", text, re.S)
        file_facts = {key: status[key] for key in ("bytes", "size", "sha256", "content_type", "verification", "cached") if key in status}
        if match is None:
            return {
                "status": "failed",
                "error": text.strip()[:1500] or "Blender returned no import summary",
                "path": str(path),
                "file": file_facts,
                "hint": "The file itself is saved. Is Blender open with the add-on's MCP server started? You can also import it with execute_blender_code using the path above.",
            }
        try:
            summary: Any = json.loads(match.group(1))
        except ValueError:
            summary = {"raw": match.group(1)[:1500]}
        log(f"import {path.name} → {summary.get('object_count', '?') if isinstance(summary, dict) else '?'} objects")
        return {"status": "imported", "path": str(path), "blender": summary, "file": file_facts}


# ---------------------------------------------------------------------------
# HTTP endpoint


class BridgeState:
    def __init__(self, token: str, child: StdioMcpChild, downloader: Downloader) -> None:
        self.token = token
        self.child = child
        self.downloader = downloader
        self.tools = BridgeTools(downloader, child)
        self.sessions: set[str] = set()


class BridgeHandler(BaseHTTPRequestHandler):
    """Streamable HTTP MCP (legacy handshake revisions) behind a mandatory Bearer token."""

    server_version = f"gera-blender-bridge/{BRIDGE_VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    state: BridgeState

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler signature
        pass  # the bridge writes its own lines and never echoes headers

    # -- plumbing ------------------------------------------------------------

    def _authorized(self) -> bool:
        scheme, _, credential = self.headers.get("Authorization", "").strip().partition(" ")
        if scheme.lower() != "bearer" or not credential.strip():
            return False
        return hmac.compare_digest(credential.strip().encode("utf-8"), self.state.token.encode("utf-8"))

    def _send(self, status: int, body: bytes | None, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body or b"")))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        try:
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Gera gave up waiting (its tools/call budget is 40 s); a download that was running keeps running.
            self.close_connection = True
            log(f"client closed the connection before the reply to {self.command} {self.path}")

    def _send_json(self, status: int, payload: Any, extra: dict[str, str] | None = None) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), extra)

    def _gate(self) -> bool:
        """Token first, path second; refusals close the connection so an unread body cannot desync keep-alive."""
        if not self._authorized():
            self.close_connection = True
            self._send_json(
                401,
                {"error": "unauthorized", "hint": "Send 'Authorization: Bearer <bridge token>' — the token printed when the bridge started."},
                {"WWW-Authenticate": WWW_AUTHENTICATE},
            )
            log(f"401 {self.command} {self.path} — missing or wrong token")
            return False
        if self.path.split("?", 1)[0].rstrip("/") != MCP_PATH:
            self.close_connection = True
            self._send_json(404, {"error": "not found", "hint": f"The MCP endpoint is {MCP_PATH}"})
            return False
        return True

    def _read_body(self) -> bytes | None:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.close_connection = True
            self._send_json(411, {"error": "length required"})
            return None
        try:
            length = int(length_header)
        except ValueError:
            self.close_connection = True
            self._send_json(400, {"error": "bad content-length"})
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send_json(413, {"error": "payload too large"})
            return None
        return self.rfile.read(length)

    # -- verbs ---------------------------------------------------------------

    def do_GET(self) -> None:
        if not self._gate():
            return
        # No server-initiated stream: every reply travels on its own POST response.
        self._send_json(405, {"error": "method not allowed", "hint": f"POST JSON-RPC to {MCP_PATH}"}, {"Allow": "POST, DELETE"})

    def do_OPTIONS(self) -> None:
        if not self._gate():
            return
        # No CORS headers on purpose: browsers never talk to the bridge, Gera's server does.
        self._send(204, None, {"Allow": "POST, DELETE"})

    def do_DELETE(self) -> None:
        if not self._gate():
            return
        session_id = self.headers.get("Mcp-Session-Id")
        if session_id:
            self.state.sessions.discard(session_id)
        self._send(204, None)

    def do_POST(self) -> None:
        if not self._gate():
            return
        body = self._read_body()
        if body is None:
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, rpc_error(None, JSON_RPC_PARSE_ERROR, "invalid JSON"))
            return
        messages = payload if isinstance(payload, list) else [payload]
        if not messages or not all(isinstance(message, dict) for message in messages):
            self._send_json(400, rpc_error(None, JSON_RPC_INVALID_REQUEST, "expected a JSON-RPC message"))
            return

        started = time.monotonic()
        responses: list[dict[str, Any]] = []
        summary: list[str] = []
        new_session: str | None = None
        for message in messages:
            method = message.get("method")
            if not isinstance(method, str):
                continue  # a client reply to a server request — the bridge never issues those
            if message.get("id") is None:
                self._handle_notification(method, message.get("params"))
                continue
            if method == "initialize":
                new_session = uuid.uuid4().hex
                self.state.sessions.add(new_session)
                responses.append(self._initialize(message))
            else:
                responses.append(self._forward(message))
            summary.append(self._describe(method, message.get("params"), responses[-1]))

        extra: dict[str, str] = {}
        session_id = new_session or self.headers.get("Mcp-Session-Id")
        if session_id:
            extra["Mcp-Session-Id"] = session_id
        if not responses:
            self._send(202, None, extra)
            return
        self._send_json(200, responses if isinstance(payload, list) else responses[0], extra)
        log(f"{', '.join(summary)} · {time.monotonic() - started:.1f}s")

    # -- MCP -----------------------------------------------------------------

    def _handle_notification(self, method: str, params: Any) -> None:
        if method == "notifications/initialized":
            return  # the upstream session was initialized by the bridge itself
        if method == "notifications/cancelled":
            return  # request ids are remapped per upstream call; cancellation cannot be translated
        try:
            self.state.child.notify(method, params)
        except BridgeError:
            pass

    def _initialize(self, message: dict[str, Any]) -> dict[str, Any]:
        try:
            self.state.child.ensure_started()
        except BridgeError as exc:
            return rpc_error(message["id"], exc.code, str(exc))
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        requested = params.get("protocolVersion")
        upstream = self.state.child.init_result
        version = negotiate_version(requested, upstream.get("protocolVersion"))
        result: dict[str, Any] = {
            "protocolVersion": version,
            "capabilities": upstream.get("capabilities") or {"tools": {}},
            "serverInfo": upstream.get("serverInfo") or {"name": "blender-mcp"},
        }
        instructions = upstream.get("instructions")
        result["instructions"] = f"{instructions.rstrip()}\n\n{BRIDGE_INSTRUCTIONS}" if isinstance(instructions, str) and instructions.strip() else BRIDGE_INSTRUCTIONS
        return {"jsonrpc": "2.0", "id": message["id"], "result": result}

    def _forward(self, message: dict[str, Any]) -> dict[str, Any]:
        method = message["method"]
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if method == "server/discover":
            # The 2026-07-28 probe: this is a handshake-era server, so the client falls back to initialize.
            return rpc_error(message["id"], JSON_RPC_METHOD_NOT_FOUND, "Method not found: server/discover (gera-blender-bridge speaks the initialize handshake)")
        if method == "tools/call" and params.get("name") in BRIDGE_TOOL_NAMES:
            return self._bridge_tool(message, params)
        try:
            self.state.child.ensure_started()
            frame = self.state.child.request(method, message.get("params"))
        except BridgeError as exc:
            return rpc_error(message["id"], exc.code, str(exc))
        relayed = dict(frame)
        relayed["id"] = message["id"]
        relayed.setdefault("jsonrpc", "2.0")
        if method == "tools/list":
            result = relayed.get("result")
            if isinstance(result, dict) and isinstance(result.get("tools"), list) and not result.get("nextCursor"):
                relayed["result"] = {**result, "tools": annotate_tools(result["tools"])}
        return relayed

    def _bridge_tool(self, message: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            payload = self.state.tools.call(str(params.get("name")), arguments)
        except ToolError as exc:
            payload = {"status": "failed", "error": str(exc)}
        except BridgeError as exc:
            return rpc_error(message["id"], exc.code, str(exc))
        result = {
            "content": [{"type": "text", "text": json.dumps(payload, indent=2, ensure_ascii=False)}],
            "isError": payload.get("status") == "failed",
        }
        return {"jsonrpc": "2.0", "id": message["id"], "result": result}

    @staticmethod
    def _describe(method: str, params: Any, response: dict[str, Any]) -> str:
        label = method
        if method == "tools/call" and isinstance(params, dict) and isinstance(params.get("name"), str):
            label = f"tools/call {params['name']}"
        if "error" in response:
            error = response["error"]
            code = error.get("code") if isinstance(error, dict) else "?"
            return f"{label} → error {code}"
        result = response.get("result")
        if isinstance(result, dict) and result.get("isError") is True:
            return f"{label} → tool error"
        return f"{label} → ok"


# ---------------------------------------------------------------------------
# Cloudflare quick tunnel (optional)


class QuickTunnel:
    """`cloudflared tunnel --url` without an account; the address changes on every start, the token does not."""

    def __init__(self, port: int, token: str) -> None:
        self.port = port
        self.token = token
        self.url: str | None = None
        self._proc: subprocess.Popen[bytes] | None = None

    def start(self) -> bool:
        binary = shutil.which("cloudflared")
        if binary is None:
            log(
                "cloudflared is not installed, so no tunnel was started. Install it (macOS: brew install cloudflared · "
                "Windows: winget install Cloudflare.cloudflared · Linux: https://developers.cloudflare.com/cloudflare-one/"
                "connections/connect-networks/downloads/) and run again with --tunnel, or point any other HTTPS tunnel "
                f"at http://127.0.0.1:{self.port} — the bridge token protects it either way."
            )
            return False
        self._proc = subprocess.Popen(
            [binary, "tunnel", "--url", f"http://127.0.0.1:{self.port}", "--no-autoupdate"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
        threading.Thread(target=self._pump, name="cloudflared", daemon=True).start()
        log("cloudflared quick tunnel starting…")
        return True

    def _pump(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            match = TUNNEL_URL_RE.search(line)
            if match and self.url is None:
                self.url = match.group(0)
                banner(
                    [
                        "Paste into Gera → MCP → Blender MCP → Connect",
                        f"Endpoint : {self.url}{MCP_PATH}",
                        "Auth     : Bridge token",
                        f"Token    : {self.token}",
                        "",
                        "Give the tunnel about 10 seconds before pressing Connect & verify.",
                        "This quick-tunnel address changes whenever cloudflared restarts; the token does not.",
                    ]
                )
            elif " ERR " in line or " WRN " in line:
                log(f"cloudflared: {line[-200:]}")
        code = proc.wait()
        log(f"cloudflared exited with code {code}; the public address is gone. Restart the bridge to get a new one.")

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------------------
# Entry point


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Token-protected Streamable HTTP bridge for the blender-mcp stdio server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"bind address (default {DEFAULT_HOST}; keep it on loopback)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"bind port (default {DEFAULT_PORT})")
    parser.add_argument("--command", default=DEFAULT_COMMAND, help=f"upstream stdio command (default: {DEFAULT_COMMAND!r})")
    parser.add_argument("--token", default=os.environ.get("GERA_BRIDGE_TOKEN") or None, help="use this Bearer token instead of the stored one (env GERA_BRIDGE_TOKEN)")
    parser.add_argument("--token-file", default=str(TOKEN_FILE), help=f"where the generated token is kept (default {TOKEN_FILE})")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S, help=f"seconds to wait for blender-mcp per request (default {int(DEFAULT_TIMEOUT_S)})")
    parser.add_argument("--downloads-dir", default=str(DOWNLOADS_DIR), help=f"where download_file / import_model_from_url save files (default {DOWNLOADS_DIR})")
    parser.add_argument("--max-download-mb", type=int, default=DOWNLOAD_MAX_MB, help=f"largest file the bridge downloads, in MB (default {DOWNLOAD_MAX_MB})")
    parser.add_argument("--tunnel", action="store_true", help="also start a Cloudflare quick tunnel (needs cloudflared) and print the HTTPS address to paste")
    parser.add_argument("--show-token", action="store_true", help="print the stored token and exit")
    parser.add_argument("--rotate-token", action="store_true", help="replace the stored token, then continue")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    token_path = Path(args.token_file).expanduser()
    if args.token:
        token, created = args.token.strip(), False
        if len(token) < 16:
            log("refusing a token shorter than 16 characters")
            return 2
    else:
        token, created = load_or_create_token(token_path, rotate=args.rotate_token)
    if args.show_token:
        print(token)
        return 0

    command = shlex.split(args.command)
    if not command:
        log("--command must not be empty")
        return 2
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log(f"warning: binding {args.host} exposes the bridge to your network; the token is still required, but loopback plus a tunnel is safer")
    if args.max_download_mb < 1:
        log("--max-download-mb must be at least 1")
        return 2

    downloads_dir = Path(args.downloads_dir).expanduser()
    try:
        downloads_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log(f"could not create the downloads folder {downloads_dir} ({exc}); download_file will fail until it exists")

    child = StdioMcpChild(command, args.timeout)
    BridgeHandler.state = BridgeState(token, child, Downloader(downloads_dir, args.max_download_mb * 1024 * 1024))
    try:
        server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    except OSError as exc:
        log(f"could not bind {args.host}:{args.port} ({exc}). Is another bridge running? Use --port to pick another one.")
        return 1
    server.daemon_threads = True

    log("starting blender-mcp (the first run may take a minute while uv installs it)…")
    try:
        child.ensure_started()
    except BridgeError as exc:
        log(f"blender-mcp did not start: {exc}")
        server.server_close()
        return 1

    tunnel = QuickTunnel(args.port, token) if args.tunnel else None
    if tunnel is not None:
        tunnel.start()

    where = "generated just now" if created else f"stored in {token_path}"
    banner(
        [
            f"Gera Blender bridge {BRIDGE_VERSION} is running",
            f"Local endpoint : http://{args.host}:{args.port}{MCP_PATH}",
            f"Token          : {token}",
            f"                 ({where}; run with --rotate-token to replace it)",
            f"Downloads      : {downloads_dir}",
            "                 (download_file / import_model_from_url save here, up to "
            f"{args.max_download_mb} MB per file)",
            "Every request without 'Authorization: Bearer <token>' is answered 401.",
            "" if tunnel is not None and tunnel._proc is not None else f"Publish it with any HTTPS tunnel, e.g.  cloudflared tunnel --url http://127.0.0.1:{args.port}",
            "Keep Blender open with the add-on's MCP server started. Ctrl+C stops everything.",
        ]
    )

    def _terminate(signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), _terminate)
            except (ValueError, OSError):
                pass

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log("stopping…")
    finally:
        server.server_close()
        if tunnel is not None:
            tunnel.stop()
        child.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
