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

Only the Python standard library is used. Third-party bridges such as
`mcp-proxy` import private symbols of the `mcp` package, which is why
`mcp==2.0.0` (2026-07-28) broke them with
`ImportError: cannot import name 'request_ctx'`; nothing here can drift like that.

Usage:
    uv run gera-blender-bridge.py --tunnel       # serve + Cloudflare quick tunnel, prints what to paste into Gera
    uv run gera-blender-bridge.py                # serve on 127.0.0.1:8000 only (bring your own HTTPS tunnel)
    uv run gera-blender-bridge.py --show-token   # print the stored token and exit
    uv run gera-blender-bridge.py --rotate-token # replace the stored token

`python3 gera-blender-bridge.py ...` works too (Python 3.10+).
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "1.0.1"
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
    """One line on stderr; never headers, bodies or the token."""
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
# HTTP endpoint


class BridgeState:
    def __init__(self, token: str, child: StdioMcpChild) -> None:
        self.token = token
        self.child = child
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
        self.end_headers()
        if body:
            self.wfile.write(body)

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
        if isinstance(upstream.get("instructions"), str):
            result["instructions"] = upstream["instructions"]
        return {"jsonrpc": "2.0", "id": message["id"], "result": result}

    def _forward(self, message: dict[str, Any]) -> dict[str, Any]:
        method = message["method"]
        if method == "server/discover":
            # The 2026-07-28 probe: this is a handshake-era server, so the client falls back to initialize.
            return rpc_error(message["id"], JSON_RPC_METHOD_NOT_FOUND, "Method not found: server/discover (gera-blender-bridge speaks the initialize handshake)")
        try:
            self.state.child.ensure_started()
            frame = self.state.child.request(method, message.get("params"))
        except BridgeError as exc:
            return rpc_error(message["id"], exc.code, str(exc))
        relayed = dict(frame)
        relayed["id"] = message["id"]
        relayed.setdefault("jsonrpc", "2.0")
        return relayed

    @staticmethod
    def _describe(method: str, params: Any, response: dict[str, Any]) -> str:
        label = method
        if method == "tools/call" and isinstance(params, dict) and isinstance(params.get("name"), str):
            label = f"tools/call {params['name']}"
        if "error" in response:
            error = response["error"]
            code = error.get("code") if isinstance(error, dict) else "?"
            return f"{label} → error {code}"
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

    child = StdioMcpChild(command, args.timeout)
    BridgeHandler.state = BridgeState(token, child)
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
