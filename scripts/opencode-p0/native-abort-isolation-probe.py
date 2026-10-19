#!/usr/bin/env python3
"""Real-provider stop/isolation evidence (taskbook P1 + fork design §D).

Against an isolated 1.18.35 instance + a slow-turn mock model, this probe
records with timestamps:
  1. NATIVE TERMINATION vs transport success: POST /session/{id}/abort returns
     200 immediately, but termination is only PROVEN when /session/status
     leaves 'busy' and the interrupted turn's message completes/errors.
  2. LATE ABORT vs a resumed task: abort issued for an OLD turn while a NEW
     turn is running — does the late arrival kill the new work?
  3. real isolateTarget semantics: instance-level stop (the only reliable
     isolation for in-flight requests) confirmed by the server going away.

Writes native-abort-evidence.json next to this script (sanitized).
"""
import json, os, re, shutil, signal, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import probe as p

records = []
def note(label, **kw):
    kw["label"] = label
    kw["t"] = round(time.time() - T0, 2)
    records.append(kw)
    print(f"[{kw['t']:7.2f}] {label}: " + json.dumps({k: v for k, v in kw.items() if k not in ("label", "t")}, ensure_ascii=False)[:160])

def call(base, path, body=None, method=None, timeout=20):
    try:
        r = p.request(base, path, body, method, timeout=timeout)
        return {"status": 200, "response": r}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")[:200]
        # 2xx-with-empty-body must not read as a transport failure
        if 200 <= exc.code < 300:
            return {"status": exc.code, "response": None, "empty": True}
        return {"status": exc.code, "error": raw}
    except Exception as exc:
        # JSON parse failures tell us the body wasn't JSON — the status is
        # unknown here, so never upgrade this to a fake 200.
        if "Expecting value" in str(exc):
            # urlopen only raises HTTPError for >=400, so reaching the JSON
            # parse means the request SUCCEEDED with a non-JSON/empty body.
            return {"status": "2XX_EMPTY", "response": None, "empty": True}
        return {"status": "ERR", "error": str(exc)[:200]}

def status_of(base, sid):
    r = call(base, "/session/status")
    return ((r.get("response") or {}).get(sid) or {}).get("type", "unknown")

T0 = time.time()
if p.STATE.exists():
    raise SystemExit("existing P0 manifest")

try:
    p.start()
    state = json.loads(p.STATE.read_text())
    base, root = state["base"], Path(state["root"])
    base = base  # pre-restart base; refreshed again after restart below
    # slow model: every turn sleeps so we can observe busy/abort
    mock = subprocess.Popen([sys.executable, str(Path(__file__).parent / "mock_model.py")],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                            env={**os.environ, "P0_SLOW_EVERY": "1"})
    port = int(mock.stdout.readline().decode().strip())
    config = {"model": "p0/fixture-model", "small_model": "p0/fixture-model", "enabled_providers": ["p0"], "snapshot": False, "share": "disabled",
              "provider": {"p0": {"npm": "@ai-sdk/openai-compatible", "name": "P0 fixture",
                                  "options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "p0-fixture-key", "timeout": 60000},
                                  "models": {"fixture-model": {"name": "F", "tool_call": True, "limit": {"context": 32768, "output": 2048}}}}}}
    env = json.loads((root / "env.json").read_text())
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    (root / "env.json").write_text(json.dumps(env))
    from lifecycle import restart
    state = restart(state)
    base = state["base"]

    ra = call(base, "/session", {"title": "abort probe A"})
    s1 = (ra.get("response") or {}).get("id")
    if not s1:
        raise RuntimeError("session create failed: " + json.dumps(ra)[:200])
    note("session created", session=re.sub(r"sese?s?_[A-Za-z0-9]+", "SES", s1))

    # ── 1) transport 200 ≠ termination
    call(base, f"/session/{s1}/prompt_async", {"messageID": "msg_np1", "parts": [{"type": "text", "text": "slow turn one"}]})
    time.sleep(1.0)
    busy = status_of(base, s1)
    note("turn 1 running", status=busy)
    abort1 = call(base, f"/session/{s1}/abort")
    note("abort returned", http=abort1["status"], empty=bool(abort1.get("empty")))
    t0 = time.time()
    terminated = None
    while time.time() - t0 < 20:
        st = status_of(base, s1)
        if st != "busy":
            terminated = round(time.time() - t0, 2)
            break
        time.sleep(0.2)
    note("termination observed via status", seconds=terminated, final_status=st if terminated else "busy")
    msgs1 = call(base, f"/session/{s1}/message")["response"]
    last_state = None
    turn1_completed = None
    for m in reversed(msgs1):
        for part in m["parts"]:
            if part.get("type") == "text" and last_state is None:
                last_state = part.get("text", "")[:40]
        if m["info"].get("id") == "msg_np1" and m["info"].get("role") == "user":
            # the assistant reply that follows the aborted user turn
            idx = msgs1.index(m)
            if idx + 1 < len(msgs1):
                turn1_completed = bool(msgs1[idx + 1]["info"].get("time", {}).get("completed"))
    note("turn 1 final text", text=last_state, turn_completed_despite_abort=turn1_completed)

    # ── 2) late abort vs a NEW turn
    call(base, f"/session/{s1}/prompt_async", {"messageID": "msg_np2", "parts": [{"type": "text", "text": "slow turn two (the one that must survive)"}]})
    time.sleep(1.0)
    note("turn 2 running", status=status_of(base, s1))
    late = call(base, f"/session/{s1}/abort")
    note("late abort http", status=late["status"], empty=bool(late.get("empty")))
    t0 = time.time()
    while time.time() - t0 < 30:
        if status_of(base, s1) != "busy":
            break
        time.sleep(0.3)
    msgs2 = call(base, f"/session/{s1}/message")["response"]
    turn2 = [m for m in msgs2 if m["info"].get("id") == "msg_np2"]
    turn2_done = None
    if turn2:
        idx2 = msgs2.index(turn2[0])
        if idx2 + 1 < len(msgs2):
            turn2_done = bool(msgs2[idx2 + 1]["info"].get("time", {}).get("completed"))
    note("turn 2 outcome", status=status_of(base, s1), turn2_present=bool(turn2), turn2_reply_completed=turn2_done)

    # ── 3) isolateTarget semantics: instance stop is the reliable isolation
    stop = call(base, "/shutdown")  # probe: is there any graceful HTTP stop?
    note("graceful http shutdown endpoint", http=stop["status"], detail=str(stop.get("error", ""))[:60])
except Exception as exc:
    note("probe error", error=str(exc)[:200])
finally:
    if p.STATE.exists():
        st = json.loads(p.STATE.read_text())
        pid = st.get("pid")
        if pid:
            try:
                os.killpg(pid, signal.SIGTERM)
                note("isolateTarget=SIGTERM instance", pid=pid)
                gone = False
                for _ in range(60):
                    time.sleep(0.2)
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        gone = True
                        break
                if gone:
                    note("instance terminated via SIGTERM (isolation confirmed)", pid=pid)
                else:
                    os.killpg(pid, signal.SIGKILL)
                    time.sleep(0.5)
                    state_line = ""
                    try:
                        state_line = Path(f"/proc/{pid}/stat").read_text().split()[2]
                    except (FileNotFoundError, IndexError):
                        pass
                    if state_line == "Z":
                        note("instance terminated via SIGKILL (zombie reaped by parent — isolation confirmed)", pid=pid)
                    else:
                        note(f"instance state after SIGKILL: {state_line or 'unknown-gone'}", pid=pid)
            except ProcessLookupError:
                pass
        mp = st.get("mock_pid")
        if mp:
            try:
                os.killpg(mp, signal.SIGTERM)
            except (ProcessLookupError, FileNotFoundError):
                pass
        time.sleep(0.3)
        shutil.rmtree(st["root"], ignore_errors=True)
        p.STATE.unlink()
    try:
        mock.kill()
    except Exception:
        pass

out = {"cli_version": "1.18.35", "captured_at": "2026-10-19", "records": records}
(Path(__file__).parent / "native-abort-evidence.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("EVIDENCE WRITTEN")
