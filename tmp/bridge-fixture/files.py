#!/usr/bin/env python3
"""Fixture file server for gera-blender-bridge download tests (not shipped).

/model.glb   valid synthetic GLB with one animation; Range + If-Range supported
/strict.glb  same file, but 403 for the bridge's own User-Agent (browser UA passes)
/flaky.glb   first request announces the full length and drops after half; Range afterwards
/page.glb    200 text/html — a login page pretending to be a model
/slow.glb    valid GLB trickled slowly (about 6 s) to exercise background continuation
/noext       the GLB without an extension (Content-Type model/gltf-binary)
"""
import json
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def build_glb() -> bytes:
    times = [0.0, 0.5, 1.0, 1.5, 2.0]
    bin_chunk = struct.pack("<5f", *times)
    bin_chunk += b"\0" * ((4 - len(bin_chunk) % 4) % 4)
    doc = {
        "asset": {"version": "2.0", "generator": "gera-fixture"},
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 20}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 5, "type": "SCALAR", "min": [0.0], "max": [2.0]}],
        "nodes": [{"name": "Goalkeeper"}, {"name": "Body"}],
        "meshes": [{"primitives": []}],
        "skins": [{"joints": [0]}],
        "animations": [{"name": "Idle", "samplers": [{"input": 0, "output": 0}], "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}]}],
    }
    json_bytes = json.dumps(doc).encode()
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
    return (
        b"glTF" + struct.pack("<II", 2, total)
        + struct.pack("<I", len(json_bytes)) + b"JSON" + json_bytes
        + struct.pack("<I", len(bin_chunk)) + b"BIN\0" + bin_chunk
    )


GLB = build_glb()
ETAG = '"fixture-glb-1"'
flaky_hits = {"count": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[files] %s %s UA=%s Range=%s\n" % (self.command, self.path, self.headers.get("User-Agent"), self.headers.get("Range")))

    def _serve(self, data: bytes, content_type: str, drop_after: int | None = None, trickle: float = 0.0) -> None:
        range_header = self.headers.get("Range")
        start = 0
        if range_header and range_header.startswith("bytes="):
            if_range = self.headers.get("If-Range")
            if if_range and if_range != ETAG:
                start = 0
            else:
                start = int(range_header[6:].split("-")[0])
        body = data[start:]
        if start:
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", ETAG)
        self.end_headers()
        if drop_after is not None and start == 0:
            self.wfile.write(body[:drop_after])
            self.wfile.flush()
            self.close_connection = True
            try:
                self.connection.shutdown(1)
            except OSError:
                pass
            return
        if trickle:
            step = max(1, len(body) // 12)
            for offset in range(0, len(body), step):
                self.wfile.write(body[offset:offset + step])
                self.wfile.flush()
                time.sleep(trickle)
            return
        self.wfile.write(body)

    def do_GET(self):
        ua = self.headers.get("User-Agent", "")
        if self.path == "/model.glb":
            return self._serve(GLB, "model/gltf-binary")
        if self.path == "/noext":
            return self._serve(GLB, "model/gltf-binary")
        if self.path == "/strict.glb":
            if ua.startswith("Mozilla/5.0 (compatible; gera-blender-bridge"):
                body = b"error code: 1010"
                self.send_response(403)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return self._serve(GLB, "model/gltf-binary")
        if self.path == "/flaky.glb":
            flaky_hits["count"] += 1
            return self._serve(GLB, "model/gltf-binary", drop_after=len(GLB) // 2 if flaky_hits["count"] == 1 else None)
        if self.path == "/page.glb":
            body = b"<html><body><h1>Sign in</h1></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/slow.glb":
            return self._serve(GLB, "model/gltf-binary", trickle=0.5)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    sys.stderr.write(f"[files] serving {len(GLB)}-byte GLB on {port}\n")
    server.serve_forever()
