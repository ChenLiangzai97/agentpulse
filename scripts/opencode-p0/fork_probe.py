#!/usr/bin/env python3
"""Fork semantics probe for OpenCode 1.18.35 (isolated instance + real model).

Runs the three fork variants codex's methodology requires, captures sanitized
request/response evidence and source/branch message lists into a fixture dir.
Usage: python3 fork_probe.py <fixture_out_dir>
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "fork-fixture"
ROOT = os.path.abspath(OUT)
os.makedirs(f"{ROOT}/instance", exist_ok=True)
BASE = "http://127.0.0.1:4611"


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    r.add_header("content-type", "application/json")
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else {}


def main():
    evidence = {"base": BASE, "model": "zhipuai-coding-plan/glm-5.3-flash"}
    # 1. two completed turns in the SAME directory
    a = req("POST", "/session", {"title": "fork probe root"})
    aid = a["id"]
    evidence["root_session"] = aid
    for i, secret in enumerate(["第一句暗号：苹果", "第二句暗号：香蕉"], start=1):
        req(
            "POST",
            f"/session/{aid}/prompt_async",
            {
                "messageID": f"msg_probe_{i}",
                "parts": [{"type": "text", "text": f"请只记住并回复两个字：{secret.split('：')[1]}"}],
            },
        )
        deadline = time.time() + 60
        while time.time() < deadline:
            msgs = req("GET", f"/session/{aid}/message")
            infos = [m["info"] for m in msgs]
            last = [i for i in infos if i["role"] == "assistant"]
            if last and last[-1].get("time", {}).get("completed"):
                break
            time.sleep(1)
    root_msgs = req("GET", f"/session/{aid}/message")
    evidence["root_messages"] = [
        {"id": m["info"]["id"], "role": m["info"]["role"]} for m in root_msgs
    ]
    assert len(evidence["root_messages"]) == 4, "need two completed turns"

    last_assistant = evidence["root_messages"][-1]["id"]
    middle_user = evidence["root_messages"][0]["id"]

    def probe(label, fork_body, question):
        f = req("POST", f"/session/{aid}/fork", fork_body)
        fid = f.get("id")
        evidence[label] = {"fork_request": fork_body, "fork_response": {k: f.get(k) for k in ("id", "title", "parentID")}}
        if not fid:
            evidence[label]["error"] = f
            return
        req(
            "POST",
            f"/session/{fid}/prompt_async",
            {"messageID": f"msg_probe_q_{label}", "parts": [{"type": "text", "text": question}]},
        )
        deadline = time.time() + 90
        answer = None
        while time.time() < deadline:
            msgs = req("GET", f"/session/{fid}/message")
            infos = [m for m in msgs if m["info"]["role"] == "assistant"]
            if infos and infos[-1].get("time", {}).get("completed"):
                answer = "".join(
                    str(p.get("text"))
                    for p in msgs[-1]["parts"]
                    if p.get("type") == "text"
                )
                break
            time.sleep(1)
        evidence[label]["branch_messages_before_question"] = [
            {"id": m["info"]["id"], "role": m["info"]["role"]} for m in req("GET", f"/session/{fid}/message")
        ][:4]
        evidence[label]["answer"] = answer

    # variant A: omit messageID
    try:
        probe("omit_messageID", {}, "我的两句话暗号分别是什么？只回答两个词")
    except Exception as exc:  # noqa: BLE001
        evidence["omit_messageID"] = {"error": str(exc)}
    # variant B: fork at the LAST completed assistant message
    probe("at_last_assistant", {"messageID": last_assistant}, "我的两句话暗号分别是什么？只回答两个词")
    # variant C: fork at the middle (first user) message
    probe("at_middle_user", {"messageID": middle_user}, "我到目前为止说过的暗号是什么？只回答暗号词")

    with open(f"{ROOT}/evidence.json", "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=1)
    print(json.dumps({k: (v.get("answer") if isinstance(v, dict) else v) for k, v in evidence.items() if k.startswith(("omit", "at_"))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
