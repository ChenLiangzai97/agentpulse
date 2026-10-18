#!/usr/bin/env python3
"""Native command/API capability probe for OpenCode 1.18.35 (isolated instance + mock model).

Fills the COMMAND-MATRIX gaps the taskbook P0 asks for: /undo via revert/unrevert
(with history-content assertions against what the fixture model actually received),
/api compact, dedicated /api session model & agent switch endpoints, TUI control
endpoints, TUI builtin names routed through POST /session/{id}/command, and
per-session model isolation.

Evidence is sanitized (native ses_/msg_ IDs replaced by stable labels) into
capability-evidence.json next to this script; a post-write artifact check fails
the run (non-zero exit) if any native-looking ID survives. Key /undo assertions
fail the run with a collected failure list. No real credentials, no production
integration, loopback only.
"""
import json
import os
import re
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
failures = []


def fail(message):
    failures.append(message)


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
    prompt_rec = call(f"/session/{sid}/prompt_async", {"messageID": f"msg_cap_{i}", "parts": [{"type": "text", "text": text}]}, label=f"turn {i} prompt")
    for _ in range(400):
        wait_idle(sid, timeout=40)
        msgs = p.request(s["base"], f"/session/{sid}/message")
        if len(msgs) >= before + 2 and msgs[-1]["info"]["role"] == "assistant" and msgs[-1]["info"].get("time", {}).get("completed"):
            return
        time.sleep(0.1)
    status = p.request(s["base"], "/session/status").get(sid)
    raise RuntimeError(f"turn {i} did not complete (have {len(p.request(s['base'], f'/session/{sid}/message'))} messages, prompt_status={prompt_rec.get('status')}, session_status={status}, server_log_tail={server_log_tail()})")


def server_log_tail(limit=400):
    try:
        return (Path(s["root"]) / "server.log").read_text(errors="replace")[-limit:].replace("\n", " | ")
    except Exception:  # noqa: BLE001
        return "<unavailable>"


def try_turn(sid, text, i, timeout=12):
    """Non-raising turn attempt for boundary facts; returns (completed, diagnostics)."""
    before = len(p.request(s["base"], f"/session/{sid}/message"))
    prompt_rec = call(f"/session/{sid}/prompt_async", {"messageID": f"msg_cap_{i}", "parts": [{"type": "text", "text": text}]}, label=f"turn {i} prompt (boundary)")
    deadline = time.time() + timeout
    while time.time() < deadline:
        wait_idle(sid, timeout=timeout)
        msgs = p.request(s["base"], f"/session/{sid}/message")
        if len(msgs) >= before + 2 and msgs[-1]["info"]["role"] == "assistant" and msgs[-1]["info"].get("time", {}).get("completed"):
            return True, None
        time.sleep(0.2)
    diagnostics = {
        "prompt_status": prompt_rec.get("status"),
        "prompt_response": prompt_rec.get("response"),
        "message_count": len(p.request(s["base"], f"/session/{sid}/message")),
        "session_status": p.request(s["base"], "/session/status").get(sid),
        "server_log_tail": server_log_tail(),
    }
    return False, diagnostics


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

    sid_map = {}  # native session id -> label
    turn_counter = [0]

    def new_session(label, title):
        rec = call("/session", {"title": title}, label=f"create {label}")
        sid_map[rec["response"]["id"]] = label
        return rec["response"]["id"]

    def seeded_session(label, markers):
        sid = new_session(label, f"capability {label}")
        for marker in markers:
            turn_counter[0] += 1
            turn(sid, f"history marker {marker}", turn_counter[0])
        msgs = call(f"/session/{sid}/message", label=f"{label} messages after seed turns")["response"]
        return sid, summarized(msgs)

    def model_requests():
        f = root / "mock-records.jsonl"
        if not f.exists():
            return []
        return [json.loads(line) for line in f.read_text().splitlines()]

    def assert_history(label, sid, expected_present, expected_absent):
        """Sends a uniquely-marked probe prompt and asserts which history markers
        the model actually received, by inspecting the recorded fixture request."""
        marker = f"probe-{label}"
        before = len(model_requests())
        turn_counter[0] += 1
        try:
            turn(sid, f"history marker {marker}", turn_counter[0])
        except Exception as exc:  # noqa: BLE001
            fail(f"{label}: probe turn failed: {exc}")
            return None
        delta = model_requests()[before:]
        if not delta:
            fail(f"{label}: no model request recorded for the probe")
            return None
        received = " ".join(m.get("text") or "" for m in delta[-1]["messages"])
        record = {
            "label": f"history-assert {label}",
            "probe_marker": marker,
            "model_message_count": len(delta[-1]["messages"]),
            "received_user_markers": sorted(set(re.findall(r"history marker ([A-Za-z0-9-]+)", received))),
        }
        evidence.append(record)
        for wanted in expected_present + [marker]:
            if f"history marker {wanted}" not in received:
                fail(f"{label}: expected '{wanted}' in model context, missing")
        for unwanted in expected_absent:
            if f"history marker {unwanted}" in received:
                fail(f"{label}: '{unwanted}' should be excluded from model context, still present")
        return record

    # ══════════════ /undo semantics on DEDICATED fresh sessions ══════════════
    # Verified fact from the first instrumented run: after a revert, a prompt
    # with a NEW messageID stalls (never completes), while RESENDING with the
    # SAME messageID (the TUI undo+edit replacement flow) completes. All
    # post-revert context assertions therefore go through the resend flow.

    def resend_edited(sid, message_id, marker):
        started_ms = time.time() * 1000
        call(f"/session/{sid}/prompt_async", {"messageID": message_id, "parts": [{"type": "text", "text": f"history marker {marker}"}]}, label=f"resend same messageID ({marker})")
        for _ in range(300):
            wait_idle(sid, timeout=40)
            msgs_now = p.request(s["base"], f"/session/{sid}/message")
            last = msgs_now[-1]["info"] if msgs_now else {}
            if last.get("role") == "assistant" and last.get("time", {}).get("completed", 0) > started_ms:
                return True
            time.sleep(0.1)
        fail(f"resend {marker} did not complete")
        return False

    # R1: revert at turn-3 USER excludes the named message and everything after.
    r1, r1_turns = seeded_session("SES_R1", ["r1alpha", "r1bravo", "r1charlie"])
    assert_history("R1 baseline", r1, ["r1alpha", "r1bravo", "r1charlie"], [])
    call(f"/session/{r1}/revert", {"messageID": r1_turns[4]["id"]}, label="R1 revert at turn-3 USER")
    resend_edited(r1, r1_turns[4]["id"], "r1delta")
    assert_history("R1 after revert@turn3-user + resend", r1, ["r1alpha", "r1bravo", "r1delta"], ["r1charlie"])

    # R2: revert at turn-3 ASSISTANT excludes only that assistant message;
    #     turn-2 survives and the turn-3 user message can be replaced.
    r2, r2_turns = seeded_session("SES_R2", ["r2alpha", "r2bravo", "r2charlie"])
    call(f"/session/{r2}/revert", {"messageID": r2_turns[5]["id"]}, label="R2 revert at turn-3 ASSISTANT")
    resend_edited(r2, r2_turns[4]["id"], "r2delta")
    assert_history("R2 after revert@turn3-assistant + resend", r2, ["r2alpha", "r2bravo", "r2delta"], ["r2charlie"])

    # R3: revert at turn-2 ASSISTANT drops turn 2's answer and everything after.
    r3, r3_turns = seeded_session("SES_R3", ["r3alpha", "r3bravo", "r3charlie"])
    call(f"/session/{r3}/revert", {"messageID": r3_turns[3]["id"]}, label="R3 revert at turn-2 ASSISTANT")
    resend_edited(r3, r3_turns[4]["id"], "r3delta")
    assert_history("R3 after revert@turn2-assistant + resend", r3, ["r3alpha", "r3delta"], ["r3bravo", "r3charlie"])

    # R4: unrevert semantics without interference — revert then immediately
    #     unrevert: the reverted turn RETURNS to the model context.
    r4, r4_turns = seeded_session("SES_R4", ["r4alpha", "r4bravo", "r4charlie"])
    call(f"/session/{r4}/revert", {"messageID": r4_turns[4]["id"]}, label="R4 revert at turn-3 USER")
    call(f"/session/{r4}/unrevert", None, method="POST", label="R4 immediate unrevert")
    assert_history("R4 after immediate unrevert", r4, ["r4alpha", "r4bravo", "r4charlie"], [])

    # R2B: boundary fact — after a revert, a prompt with a NEW messageID does
    #      not complete on this build (stall recorded with diagnostics).
    r2b, r2b_turns = seeded_session("SES_R2B", ["r2balpha", "r2bbravo", "r2bcharlie"])
    call(f"/session/{r2b}/revert", {"messageID": r2b_turns[4]["id"]}, label="R2B revert at turn-3 USER")
    turn_counter[0] += 1
    completed, diagnostics = try_turn(r2b, "history marker r2bnew", turn_counter[0], timeout=12)
    evidence.append({"label": "R2B new-messageID prompt after revert", "completed_within_12s": completed, "diagnostics": diagnostics})
    if completed:
        fail("R2B: new-messageID prompt unexpectedly completed after revert (stall boundary changed)")
    # Boundary: after the stalled prompt, unrevert unblocks new prompts but the
    # reverted turn does NOT return to the model context on this build.
    call(f"/session/{r2b}/unrevert", None, method="POST", label="R2B unrevert after stalled prompt")
    assert_history("R2B after stall + unrevert", r2b, ["r2balpha", "r2bbravo"], ["r2bcharlie"])

    # Bogus messageID: response shape only (no context claim).
    call(f"/session/{r3}/revert", {"messageID": "msg_nonexistent_cap"}, label="revert bogus messageID (error shape)")

    # ══════════════ capability surface on session A ══════════════
    a = new_session("SES_A", "capability probe A")
    for i, text in enumerate(["cap one", "cap two", "cap three"], start=1):
        turn_counter[0] += 1
        turn(a, text, turn_counter[0])

    # ── dedicated switch endpoints (/api family; ModelRef = {id, providerID, variant?})
    call(f"/api/session/{a}/model", {"model": {"id": "missing-model", "providerID": "p0"}}, label="/api switch model to missing-model (full ModelRef)")
    model_after_switch = call(f"/session/{a}", label="session A after model switch")["response"]
    b = new_session("SES_B", "capability probe B")
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
    if len(listing_before_tui) != len(listing_after_tui_new):
        fail("tui execute-command new changed the session list in headless mode")
    if active_after_select.get("response", {}).get("data"):
        fail("tui select-session changed /api/session/active in headless mode")

    # ── TUI builtin names routed through the native command endpoint
    for name in ["undo", "compact", "export", "new", "session", "help", "model", "agent", "share", "theme"]:
        rec = call(f"/session/{a}/command", {"command": name, "arguments": ""}, label=f"/command builtin '{name}'")
        if rec.get("status") == 200:
            fail(f"/command builtin '{name}' unexpectedly accepted")

    # ── session switching surface: list + active
    listing = call("/session", label="session list with per-session model")["response"]
    for entry in listing:
        sid_map.setdefault(entry["id"], f"SES_LIST_{len(sid_map)}")
    active = call("/api/session/active", label="/api session/active shape")

    # ── summarize endpoint
    call(f"/session/{a}/summarize", {"providerID": "p0", "modelID": "fixture-model"}, label="summarize")
    summarize_after = call(f"/session/{a}", label="session A after summarize")["response"]

    # ── per-session model isolation assertion
    ma = (model_after_switch or {}).get("model") or {}
    mb = (model_b or {}).get("model")
    if ma.get("id") != "missing-model":
        fail(f"session A model switch did not persist: {ma}")
    if mb is not None:
        fail(f"session B should have no explicit model, got {mb}")

    # ══════════════ sanitize evidence: native IDs → labels ══════════════
    # Named session labels first (readability), then a generic regex fallback
    # over the serialized text catches every remaining native-looking ID
    # (messages, parts, ids nested in paths or payloads we never enumerated).
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
        "failures": failures,
        "records": evidence,
    }
    text = json.dumps(scrub(out), ensure_ascii=False, indent=1)
    # Stable anonymization: one label per UNIQUE native ID, so the same ID
    # always maps to the same label wherever it appears (evidence links stay
    # correlated) and distinct IDs never merge onto one label.
    label_counters = {"SES": 0, "MSG": 0, "PRT": 0}
    stable_id_map = {}

    def stable_repl(match, prefix):
        native = match.group(0)
        if native not in stable_id_map:
            label_counters[prefix] += 1
            stable_id_map[native] = f"{prefix}_ANON_{label_counters[prefix]}"
        return stable_id_map[native]

    text = re.sub(r"ses_[A-Za-z0-9_-]{12,}", lambda m: stable_repl(m, "SES"), text)
    text = re.sub(r"msg_[A-Za-z0-9_-]{16,}", lambda m: stable_repl(m, "MSG"), text)
    text = re.sub(r"prt_[A-Za-z0-9_-]{12,}", lambda m: stable_repl(m, "PRT"), text)
    labels_assigned = sorted(stable_id_map.values())
    if len(labels_assigned) != len(set(labels_assigned)):
        print("ANON MAPPING CHECK FAILED: duplicate labels for distinct IDs")
        raise SystemExit(1)
    artifact = here / "capability-evidence.json"
    artifact.write_text(text)
    print("records:", len(evidence), "failures:", len(failures), "stable_anon_ids:", len(stable_id_map), "per_kind:", label_counters)
    for message in failures:
        print("FAIL:", message)

    # ── artifact self-check: no NATIVE-FORMAT IDs survive sanitization.
    # Short artificial markers (msg_cap_*, probe-*) are probe-chosen labels,
    # not native IDs, and are expected to remain.
    leftover_text = artifact.read_text()
    leftovers = {
        "ses": len(re.findall(r"ses_[A-Za-z0-9_-]{12,}", leftover_text)),
        "msg": len(re.findall(r"msg_[A-Za-z0-9_-]{16,}", leftover_text)),
        "prt": len(re.findall(r"prt_[A-Za-z0-9_-]{12,}", leftover_text)),
    }
    if any(leftovers.values()):
        print("ARTIFACT CHECK FAILED (native-format IDs remain):", leftovers)
        raise SystemExit(1)
    if failures:
        raise SystemExit(1)
    print("artifact check: no native-format IDs remain; stable mapping is injective; all history assertions passed")


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
