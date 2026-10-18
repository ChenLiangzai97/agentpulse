#!/usr/bin/env python3
"""Native command/API capability probe for OpenCode 1.18.35 (isolated instance + mock model).

Fills the COMMAND-MATRIX gaps the taskbook P0 asks for: /undo via revert/unrevert,
/api compact, dedicated /api session model & agent switch endpoints, TUI control
endpoints (execute-command / select-session / open-sessions), TUI builtin names
routed through POST /session/{id}/command, and per-session model isolation.

Evidence is sanitized (native IDs replaced by stable labels) into
capability-evidence.json next to this script. No real credentials, no production
integration, loopback only.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
from pathlib import Path

import probe as p

here = Path(__file__).resolve().parent
if p.STATE.exists():
    raise SystemExit("Existing P0 manifest: clean its owned processes before another run")

s = None
evidence = []


def call(path, body=None, method=None, label=None):
    rec = {"label": label or path, "path": path, "method": method or ("POST" if body is not None else "GET"), "request": body}
    try:
        rec["response"] = p.request(s["base"], path, body, method)
        rec["status"] = 200
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            rec["response"] = json.loads(raw)
        except Exception:
            rec["response"] = raw[:500]
        rec["status"] = exc.code
    except Exception as exc:  # noqa: BLE001
        rec["error"] = str(exc)[:500]
    evidence.append(rec)
    return rec


def wait_idle(sid, timeout=40):
    for _ in range(int(timeout / 0.1)):
        if p.request(s["base"], "/session/status").get(sid, {}).get("type", "idle") == "idle":
            return
        time.sleep(0.1)
    raise RuntimeError(f"session {sid} did not become idle")


def turn(sid, text, i):
    before = len(p.request(s["base"], f"/session/{sid}/message"))
    call(f"/session/{sid}/prompt_async", {"messageID": f"msg_cap_{i}", "parts": [{"type": "text", "text": text}]}, label=f"turn {i} prompt")
    for _ in range(400):
        wait_idle(sid, timeout=40)
        msgs = p.request(s["base"], f"/session/{sid}/message")
        if len(msgs) >= before + 2 and msgs[-1]["info"]["role"] == "assistant" and msgs[-1]["info"].get("time", {}).get("completed"):
            return
        time.sleep(0.1)
    raise RuntimeError(f"turn {i} did not complete (have {len(p.request(s['base'], f'/session/{sid}/message'))} messages)")


def summarized(messages):
    return [{"id": m["info"]["id"], "role": m["info"]["role"]} for m in messages]


def main():
    global s
    # ── isolated server + deterministic mock model (bootstrap.py steps inlined)
    p.start()
    s = json.loads(p.STATE.read_text())
    root = Path(s["root"])
    with open(root / "mock.log", "wb") as log:
        mock_env = dict(os.environ)
        mock_env["P0_RECORD_FILE"] = str(root / "mock-records.jsonl")
        proc = subprocess.Popen([sys.executable, str(here / "mock_model.py")], stdout=log, stderr=subprocess.STDOUT, env=mock_env, start_new_session=True)
    s["mock_pid"] = proc.pid
    p.STATE.write_text(json.dumps(s))
    for _ in range(100):
        try:
            port = int((root / "mock.log").read_text().splitlines()[0])
            break
        except (ValueError, IndexError):
            time.sleep(0.05)
    else:
        raise RuntimeError("mock startup failed")
    config = {"model": "p0/fixture-model", "small_model": "p0/fixture-model", "enabled_providers": ["p0"], "snapshot": False, "share": "disabled", "provider": {"p0": {"npm": "@ai-sdk/openai-compatible", "name": "P0 fixture", "options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "p0-fixture-key", "timeout": 20000}, "models": {"fixture-model": {"name": "P0 fixture", "tool_call": True, "limit": {"context": 32768, "output": 2048}}, "missing-model": {"name": "P0 missing", "limit": {"context": 32768, "output": 2048}}}}}}
    env = json.loads((root / "env.json").read_text())
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    (root / "env.json").write_text(json.dumps(env))
    from lifecycle import restart

    restart(s)

    sid_map = {}

    def sid(label):
        return sid_map.get(label, label)

    # ── three completed turns on session A
    a = call("/session", {"title": "capability probe A"}, label="create session A")["response"]["id"]
    sid_map["SES_A"] = a
    for i, text in enumerate(["cap one", "cap two", "cap three"], start=1):
        turn(a, text, i)
    msgs = call(f"/session/{a}/message", label="messages after 3 turns")["response"]
    turns = summarized(msgs)
    assert len(turns) == 6, f"expected 6 messages, got {len(turns)}"

    # ── /undo semantics: revert at turn-3 user message
    call(f"/session/{a}/revert", {"messageID": turns[4]["id"]}, label="revert at turn-3 user message")
    after_revert = summarized(call(f"/session/{a}/message", label="messages after revert")["response"])
    call(f"/session/{a}/unrevert", None, method="POST", label="unrevert")
    after_unrevert = summarized(call(f"/session/{a}/message", label="messages after unrevert")["response"])
    call(f"/session/{a}/revert", {"messageID": "msg_nonexistent_cap"}, label="revert bogus messageID (error shape)")

    # ── dedicated switch endpoints (/api family; ModelRef = {id, providerID, variant?})
    call(f"/api/session/{a}/model", {"model": {"id": "missing-model", "providerID": "p0"}}, label="/api switch model to missing-model (full ModelRef)")
    model_after_switch = call(f"/session/{a}", label="session A after model switch")["response"]
    b = call("/session", {"title": "capability probe B"}, label="create session B")["response"]["id"]
    sid_map["SES_B"] = b
    model_b = call(f"/session/{b}", label="session B default model")["response"]
    call(f"/api/session/{a}/model", {"model": {"id": "fixture-model", "providerID": "p0"}}, label="/api switch model back to fixture (full ModelRef)")
    model_a_restored = call(f"/session/{a}", label="session A after model restore")["response"]
    call(f"/api/session/{a}/agent", {"agent": "build"}, label="/api switch agent to build")
    agent_after = call(f"/session/{a}", label="session A after agent switch")["response"]
    call(f"/api/session/{a}/agent", {"agent": "no-such-agent"}, label="/api switch agent to nonexistent (error shape)")
    agent_bogus = call(f"/session/{a}", label="session A after bogus agent switch")["response"]
    call(f"/api/session/{a}/agent", {"agent": "build"}, label="/api restore agent to build")
    call(f"/api/session/{a}/model", {"model": {"providerID": "p0", "modelID": "missing-model"}}, label="/api switch model (providerID/modelID form, error shape)")

    # ── compact
    call(f"/api/session/{a}/compact", None, method="POST", label="/api compact")

    # ── TUI control endpoints in headless server mode — do they actually act?
    listing_before_tui = [x["id"] for x in call("/session", label="session list before tui commands")["response"]]
    call("/tui/execute-command", {"command": "undo"}, label="tui execute-command undo (headless)")
    after_tui_undo = summarized(call(f"/session/{a}/message", label="messages after tui undo")["response"])
    call("/tui/execute-command", {"command": "new"}, label="tui execute-command new (headless)")
    listing_after_tui_new = [x["id"] for x in call("/session", label="session list after tui new")["response"]]
    call("/tui/select-session", {"sessionID": b}, label="tui select-session B (headless)")
    active_after_select = call("/api/session/active", label="/api active after tui select-session")
    call("/tui/open-sessions", None, method="POST", label="tui open-sessions (headless)")
    call("/tui/execute-command", {"command": "model"}, label="tui execute-command model (headless)")

    # ── TUI builtin names routed through the native command endpoint
    for name in ["undo", "compact", "export", "new", "session", "help", "model", "agent", "share", "theme"]:
        call(f"/session/{a}/command", {"command": name, "arguments": ""}, label=f"/command builtin '{name}'")

    # ── session switching surface: list + active
    listing = call("/session", label="session list with per-session model")["response"]
    active = call("/api/session/active", label="/api session/active shape")

    # ── summarize endpoint
    call(f"/session/{a}/summarize", {"providerID": "p0", "modelID": "fixture-model"}, label="summarize")
    summarize_after = call(f"/session/{a}", label="session A after summarize")["response"]

    # ── full message info after a fresh revert + context-level effect
    turn(a, "cap four", 4)
    msgs4 = call(f"/session/{a}/message", label="messages after 4th turn")["response"]
    context_before = call(f"/api/session/{a}/context", label="context before final revert")["response"]

    def model_requests():
        f = root / "mock-records.jsonl"
        if not f.exists():
            return []
        return [json.loads(line) for line in f.read_text().splitlines()]

    probe_counter = [100]

    def probe_context(label):
        before = len(model_requests())
        probe_counter[0] += 1
        try:
            turn(a, f"probe {label}", probe_counter[0])
        except Exception as exc:  # noqa: BLE001
            evidence.append({"label": f"model-context {label}", "error": f"turn failed: {exc}", "message_count_now": len(p.request(s["base"], f"/session/{a}/message"))})
            return
        reqs = model_requests()[before:]
        roles = [[m["role"] for m in r["messages"]] for r in reqs]
        evidence.append({"label": f"model-context {label}", "call_count": len(reqs), "message_counts": [len(x) for x in roles], "last_roles_tail": roles[-1][-6:] if roles else []})

    probe_context("baseline (no revert)")
    call(f"/session/{a}/revert", {"messageID": summarized(msgs4)[-1]["id"]}, label="revert at final assistant message")
    final_revert_info = call(f"/session/{a}/message", label="full info after final revert")["response"]
    context_after = call(f"/api/session/{a}/context", label="context after final revert")["response"]
    probe_context("after revert@final-assistant")
    call(f"/session/{a}/unrevert", None, method="POST", label="unrevert after probe")
    probe_context("after unrevert")

    # ── staged revert workflow (/api stage/commit/clear shapes)
    call(f"/api/session/{a}/revert/stage", {"messageID": summarized(msgs4)[-2]["id"]}, label="staged revert at turn-4 user message")
    staged_context = call(f"/api/session/{a}/context", label="context after staged revert")["response"]
    probe_context("after stage (pre-commit)")
    call(f"/api/session/{a}/revert/commit", None, method="POST", label="staged revert commit")
    committed = call(f"/session/{a}/message", label="messages after staged revert commit")["response"]
    probe_context("after stage commit")
    call(f"/api/session/{a}/revert/clear", None, method="POST", label="staged revert clear (nothing staged)")

    # ── sanitize evidence: replace native IDs with labels, keep structure
    def scrub(value):
        if isinstance(value, str):
            for native, label in sid_map.items():
                value = value.replace(native, label)
            return value
        if isinstance(value, list):
            return [scrub(v) for v in value]
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items()}
        return value

    out = {
        "cli_version": "1.18.35",
        "captured_at": "2026-10-18",
        "turns_before_revert": turns,
        "after_revert": after_revert,
        "after_unrevert": after_unrevert,
        "model_a_after_switch": model_after_switch,
        "model_a_restored": model_a_restored,
        "model_b_default": model_b,
        "agent_a_after_switch": agent_after,
        "agent_a_after_bogus": agent_bogus,
        "summarize_session_after": summarize_after,
        "session_listing": listing,
        "active_sessions": active,
        "listing_before_tui": listing_before_tui,
        "after_tui_undo": after_tui_undo,
        "listing_after_tui_new": listing_after_tui_new,
        "active_after_select": active_after_select,
        "final_revert_info": final_revert_info,
        "context_before_final_revert": context_before,
        "context_after_final_revert": context_after,
        "staged_context": staged_context,
        "after_staged_commit": summarized(committed),
        "records": evidence,
    }
    (here / "capability-evidence.json").write_text(json.dumps(scrub(out), ensure_ascii=False, indent=1))
    print("records:", len(evidence))
    print("revert:", len(after_revert), "unrevert:", len(after_unrevert), "model A:", (model_after_switch or {}).get("modelID"), "model B:", (model_b or {}).get("modelID"))


if __name__ == "__main__":
    try:
        main()
    finally:
        if p.STATE.exists():
            state = json.loads(p.STATE.read_text())
            for field in ["pid", "mock_pid"]:
                pid = state.get(field)
                if not pid:
                    continue
                try:
                    cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
                    if field == "pid" and (b"opencode" not in cmd or Path(f"/proc/{pid}/cwd").resolve() != Path(state["project"])):
                        raise RuntimeError("Refusing to stop unknown process")
                    if field == "mock_pid" and b"mock_model.py" not in cmd:
                        raise RuntimeError("Refusing to stop unknown mock process")
                    os.killpg(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except FileNotFoundError:
                    pass
            time.sleep(0.3)
            shutil.rmtree(state["root"], ignore_errors=True)
            p.STATE.unlink()
        print("capability probe cleaned up")
