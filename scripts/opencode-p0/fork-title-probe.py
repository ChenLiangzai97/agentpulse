#!/usr/bin/env python3
"""Probe: does native fork accept a title (atomically)? Can it be renamed after?

Re-runnable evidence for the fork crash-window policy (design v2.1 §1).
Writes fork-title-evidence.json (sanitized) next to this script when run
from the repository root. Isolated instance + mock model, no real credentials.
"""
import json, os, re, shutil, signal, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0, "scripts/opencode-p0")
import probe as p

if p.STATE.exists():
    raise SystemExit("existing P0 manifest")
evidence = []
def call(base, path, body=None, method=None):
    try:
        r = p.request(base, path, body, method)
        return {"status": 200, "response": r}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")[:200]
        return {"status": exc.code, "error": raw}
    except Exception as exc:
        return {"status": "ERR", "error": str(exc)[:200]}

try:
    p.start()
    state = json.loads(p.STATE.read_text())
    base = state["base"]
    a = call(base, "/session", {"title": "fork title probe root"})
    aid = a["response"]["id"]
    call(base, f"/session/{aid}/prompt_async", {"messageID": "msg_tp1", "parts": [{"type": "text", "text": "marker alpha"}]})
    for _ in range(200):
        st = p.request(base, "/session/status").get(aid, {}).get("type", "idle")
        msgs = p.request(base, f"/session/{aid}/message")
        if st == "idle" and len(msgs) >= 2 and msgs[-1]["info"].get("time", {}).get("completed"):
            break
        time.sleep(0.1)
    # 1) fork WITH title — additionalProperties:false should reject
    with_title = call(base, f"/session/{aid}/fork", {"title": "agentpulse-fork:test123"})
    evidence.append({"label": "fork with title", "result": with_title})
    # 2) normal fork — check response title field
    normal = call(base, f"/session/{aid}/fork", {})
    normal_title = (normal.get("response") or {}).get("title")
    evidence.append({"label": "fork without title (response title field)", "result": {"status": normal["status"], "title": normal_title, "id": (normal.get("response") or {}).get("id")}})
    # 3) PATCH rename the child
    child_id = (normal.get("response") or {}).get("id")
    if child_id:
        renamed = call(base, f"/session/{child_id}", {"title": "agentpulse-fork:probe"}, method="PATCH")
        after = call(base, f"/session/{child_id}")
        evidence.append({"label": "PATCH rename child", "result": {"patch": renamed.get("status"), "title_after": (after.get("response") or {}).get("title")}})
        # 4) duplicate-title probe: rename the PARENT to the same marker (multi-match scenario)
        dup = call(base, f"/session/{aid}", {"title": "agentpulse-fork:probe"}, method="PATCH")
        listing = call(base, "/session")
        matches = [s["id"] for s in (listing.get("response") or []) if s.get("title") == "agentpulse-fork:probe"]
        evidence.append({"label": "title is mutable and multi-matchable", "result": {"parent_patch": dup.get("status"), "matches": len(matches)}})
    import re as _re
    def _scrub(v):
        if isinstance(v, dict): return {k: _scrub(x) for k, x in v.items()}
        if isinstance(v, list): return [_scrub(x) for x in v]
        if isinstance(v, str):
            v = _re.sub(r"/tmp/ap-opencode-p0-[A-Za-z0-9]+", "<ISOLATED_ROOT>", v)
            return _re.sub(r"ses_[A-Za-z0-9]{16,}", "SES_ANON", v)
        return v
    out = {"cli_version": "1.18.35", "records": _scrub(evidence)}
    from pathlib import Path as _P
    (_P(__file__).parent / "fork-title-evidence.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(evidence, ensure_ascii=False, indent=1))
finally:
    if p.STATE.exists():
        st = json.loads(p.STATE.read_text())
        for field in ["pid"]:
            pid = st.get(field)
            if not pid: continue
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
                if b"opencode" not in cmd: raise RuntimeError("refusing")
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, FileNotFoundError): pass
        time.sleep(0.3)
        shutil.rmtree(st["root"], ignore_errors=True)
        p.STATE.unlink()
