#!/usr/bin/env python3
"""End-to-end test against the real Cooper Email API.

Usage: scripts/live-test.py SENDER_CREDS.json RECEIVER_CREDS.json

Each creds file is JSON with an "api_key" field for a Cooper account (use
throwaway accounts). The script:
  1. creates a temporary sender inbox and a temporary receiver inbox
     (ttl_hours=2 as a safety net),
  2. runs tests/live through the EmDash sandbox runner, which saves the
     plugin settings and sends two emails via the plugin,
  3. waits until both emails arrive in the receiver inbox,
  4. deletes both inboxes, even if a step fails.
API keys are passed to the test via the environment and never printed.
"""
import base64, json, os, secrets, subprocess, sys, time, urllib.error, urllib.request

API = "https://cooperemail.com/api/v1"


def call(key, method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": "emdash-plugin-cooper-email-live-test",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:200].decode(errors="replace")}


def main():
    sender_key = json.load(open(sys.argv[1]))["api_key"]
    receiver_key = json.load(open(sys.argv[2]))["api_key"]
    tag = secrets.token_hex(4)
    created = []
    ok = False
    try:
        s, snd = call(sender_key, "POST", "/inboxes", {"username": f"emdash-plugin-{tag}", "display_name": "EmDash plugin test", "ttl_hours": 2})
        print("create sender inbox:", s, snd.get("id"), snd.get("email"))
        assert s in (200, 201), snd
        created.append((sender_key, snd["id"]))
        s, rcv = call(receiver_key, "POST", "/inboxes", {"username": f"emdash-recv-{tag}", "ttl_hours": 2})
        print("create receiver inbox:", s, rcv.get("id"), rcv.get("email"))
        assert s in (200, 201), rcv
        created.append((receiver_key, rcv["id"]))

        subject = f"EmDash plugin live test {tag}"
        env = dict(os.environ,
                   COOPER_LIVE_API_KEY=sender_key,
                   COOPER_LIVE_INBOX_ID=snd["id"],
                   COOPER_LIVE_TO=rcv["email"],
                   COOPER_LIVE_SUBJECT=subject,
                   EMDASH_ENCRYPTION_KEY="emdash_enc_v1_" + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("="))
        r = subprocess.run(["pnpm", "run", "test:live"], env=env, capture_output=True, text=True)
        out = (r.stdout + r.stderr).replace(sender_key, "[redacted]")
        print(out[-3000:])
        assert r.returncode == 0, "live vitest failed"
        assert "1 passed" in out, "live test did not run"

        deadline = time.time() + 120
        msgs = []
        while time.time() < deadline:
            s, lst = call(receiver_key, "GET", f"/inboxes/{rcv['id']}/messages?limit=20")
            msgs = [m for m in lst.get("data", []) if m.get("direction", "inbound") == "inbound"]
            if len(msgs) >= 2:
                break
            time.sleep(5)
        for m in msgs:
            print("received:", m.get("from"), "|", m.get("subject"))
        assert any(m.get("subject") == subject for m in msgs), "hook email not received"
        assert any("Test email" in (m.get("subject") or "") for m in msgs), "settings test email not received"
        ok = True
    finally:
        for key, iid in created:
            s, body = call(key, "DELETE", f"/inboxes/{iid}")
            print("delete", iid, "->", s, "" if s < 300 else body)
    print("LIVE TEST", "PASSED" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
