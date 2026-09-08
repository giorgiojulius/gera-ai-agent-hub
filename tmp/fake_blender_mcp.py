#!/usr/bin/env python3
"""Fake blender-mcp stdio server for bridge smoke tests (not shipped)."""
import json
import sys
import threading
import time

TOOLS = [
    {"name": "get_scene_info", "description": "Scene info", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "execute_blender_code", "description": "Run Blender Python", "inputSchema": {"type": "object", "properties": {"code": {"type": "string"}}}},
    {"name": "slow", "description": "Sleeps", "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}}},
    {"name": "crash", "description": "Exits", "inputSchema": {"type": "object", "properties": {}}},
]
write_lock = threading.Lock()


def send(frame):
    with write_lock:
        sys.stdout.write(json.dumps(frame) + "\n")
        sys.stdout.flush()


def handle(msg):
    method = msg.get("method")
    rid = msg.get("id")
    if method is None:
        sys.stderr.write(f"fake: got client reply {json.dumps(msg)}\n")
        return
    if rid is None:
        if method == "notifications/initialized":
            # Server -> client request to check the bridge answers it.
            send({"jsonrpc": "2.0", "id": "srv-ping-1", "method": "ping"})
            send({"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info", "data": "fake ready"}})
        return
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}, "logging": {}},
            "serverInfo": {"name": "BlenderMCP", "version": "1.8.7"},
            "instructions": "Fake instructions",
        }})
        return
    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        name = (msg.get("params") or {}).get("name")
        args = (msg.get("params") or {}).get("arguments") or {}
        if name == "get_scene_info":
            send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": json.dumps({"name": "Scene", "object_count": 3})}]}})
            return
        if name == "execute_blender_code":
            # Mimics blender-mcp: stdout of the script comes back as text. The bridge's import script prints one
            # GERA_IMPORT_JSON line; echo a plausible summary so the parsing path is exercised end to end.
            code = str(args.get("code", ""))
            if "GERA_IMPORT_JSON" in code:
                path = next((line.split("=", 1)[1].strip() for line in code.splitlines() if line.startswith("path =")), "?")
                summary = {"scene": "Scene", "fps": 24.0, "frame_range": [1, 250], "collection": None, "object_count": 2,
                           "objects": [{"name": "Goalkeeper", "type": "ARMATURE", "bones": 52}, {"name": "Body", "type": "MESH", "vertices": 4200}],
                           "actions": [{"name": "Idle", "frames": [1.0, 48.0], "seconds": 1.958}], "imported_path": path}
                text = "Code executed successfully: GERA_IMPORT_JSON " + json.dumps(summary) + "\n"
            else:
                text = "Code executed successfully: "
            send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}})
            return
        if name == "slow":
            time.sleep(float(args.get("seconds", 1)))
            send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": f"slept {args.get('seconds')}"}]}})
            return
        if name == "crash":
            sys.stderr.write("fake: crashing on purpose\n")
            sys.stderr.flush()
            import os
            os._exit(3)
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": f"Unknown tool: {name}"}})
        return
    if method == "ping":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
        return
    send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main():
    sys.stderr.write("fake blender-mcp starting\n")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        threading.Thread(target=handle, args=(msg,), daemon=True).start()


if __name__ == "__main__":
    main()
