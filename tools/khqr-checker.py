#!/usr/bin/env python3
# Quiz Library — automatic KHQR check (runs in Termux on the admin's Android phone).
#
# Bakong only answers apps inside Cambodia, so this phone does the checking:
# every few seconds it asks Supabase for waiting KHQR payments, asks Bakong if
# each QR was paid, and tells Supabase. Supabase switches the plan on only when
# the right amount went to your Bakong ID.
#
#   python ~/khqr.py setup <SECRET>   first time (asks for your Bakong token)
#   python ~/khqr.py                  start checking (leave Termux open)
#   python ~/khqr.py token            paste a new Bakong token (every ~90 days)
#
# Your Bakong token stays in ~/.ql-khqr.json on this phone only. It can only
# CHECK payments — it cannot send or move money.

import getpass, json, os, shutil, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

SUPABASE = "https://hcultemyohiljypthtyb.supabase.co"
PUBLIC_KEY = "sb_publishable_MLyLNla9gaM3r8EUM00hYg_Gyejrvbd"  # public, same one the website uses
BAKONG = "https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5"
CONF = os.path.expanduser("~/.ql-khqr.json")
EVERY = 8  # seconds between rounds


def say(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def load():
    try:
        with open(CONF) as f:
            return json.load(f)
    except Exception:
        return {}


def save(c):
    with open(CONF, "w") as f:
        json.dump(c, f)
    os.chmod(CONF, 0o600)


def post(url, body, headers, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "quiz-library-khqr/1", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def rpc(name, args):
    code, text = post(f"{SUPABASE}/rest/v1/rpc/{name}", args, {"apikey": PUBLIC_KEY})
    if code >= 400:
        if "Wrong secret key" in text:
            raise SystemExit("❌ The secret key was changed in admin. Copy the new setup command from admin → Settings → KHQR.")
        raise RuntimeError(f"Supabase {code}: {text[:150]}")
    return json.loads(text) if text else None


def bakong(token, md5):
    """Returns ('paid', data) / ('unpaid', None) / ('error', message)."""
    code, text = post(BAKONG, {"md5": md5}, {"Authorization": "Bearer " + token})
    try:
        j = json.loads(text)
    except Exception:
        j = None
    if code == 403 and not j:
        return "error", "Bakong blocked this phone. Use Cambodian internet (Wi-Fi or 4G), no VPN."
    if code == 401 or (j and j.get("errorCode") == 6):
        return "error", "Bakong token expired or wrong. Renew it, then run: python ~/khqr.py token"
    if code == 429:
        return "error", "Bakong says too many checks. Waiting a bit."
    if j and j.get("responseCode") == 0 and isinstance(j.get("data"), dict):
        return "paid", j["data"]
    if j and "responseCode" in j:
        return "unpaid", None
    return "error", f"Bakong answered HTTP {code}"


def age_minutes(iso):
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() / 60
    except Exception:
        return 0


def due(p, last_check):
    """Check new payments every round, older ones less often (saves Bakong calls)."""
    a, last = age_minutes(p["created_at"]), last_check.get(p["id"], 0)
    gap = 0 if a < 15 else 30 if a < 60 else 120 if a < 360 else 600
    return time.time() - last >= gap


def run():
    c = load()
    if not c.get("secret") or not c.get("token"):
        raise SystemExit("First run:  python ~/khqr.py setup <SECRET>   (copy it from admin → Settings → KHQR)")
    if shutil.which("termux-wake-lock"):
        subprocess.run(["termux-wake-lock"], check=False)  # keep running while the screen is off
    device = "Android · Termux"
    say("⚡ Quiz Library KHQR auto-check is running. Leave Termux open (you can lock the screen).")
    last_check, told, note, approved = {}, set(), "ok", 0
    while True:
        try:
            res = rpc("ql_khqr_pending", {"p_secret": c["secret"], "p_note": note, "p_device": device}) or {}
            note = "ok"
            for p in res.get("pending") or []:
                if not p.get("md5") or not due(p, last_check):
                    continue
                last_check[p["id"]] = time.time()
                st, d = bakong(c["token"], p["md5"])
                if st == "error":
                    note = d
                    if d not in told:
                        say("⚠️  " + d)
                        told.add(d)
                    break
                if st == "paid":
                    r = rpc("ql_khqr_confirm", {"p_secret": c["secret"], "p_id": p["id"], "p_hash": d.get("hash") or "",
                                                "p_amount": d.get("amount"), "p_currency": d.get("currency") or "",
                                                "p_to": d.get("toAccountId") or "", "p_from": d.get("fromAccountId") or ""})
                    if r == "approved":
                        approved += 1
                        say(f"✅ Approved {p.get('bill')} · ${float(p.get('amount') or 0):.2f} (approved since start: {approved})")
                    elif r == "mismatch" and p["id"] not in told:
                        told.add(p["id"])
                        say(f"⚠️  {p.get('bill')}: Bakong shows a different amount/account — check it in admin")
            if note == "ok":
                told = {t for t in told if len(t) == 36}  # forget old warnings once things work again
        except SystemExit:
            raise
        except Exception as e:
            note = f"Network problem: {str(e)[:120]}"
            if note not in told:
                say("⚠️  " + note + " (retrying)")
                told.add(note)
        time.sleep(EVERY)


def ask_token(c):
    t = getpass.getpass("Paste your Bakong token (it stays hidden), then press Enter: ").strip()
    if len(t) < 20:
        raise SystemExit("That doesn't look like a Bakong token. Try again.")
    c["token"] = t
    save(c)
    st, d = bakong(t, "0" * 32)
    print("✅ Bakong answered — token works." if st != "error" else "⚠️  " + d)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["setup"] and len(a) == 2:
        c = load()
        c["secret"] = a[1].strip()
        save(c)
        rpc("ql_khqr_pending", {"p_secret": c["secret"], "p_note": "setting up", "p_device": "Android · Termux"})
        print("✅ Connected to Quiz Library.")
        ask_token(c)
        run()
    elif a[:1] == ["token"]:
        c = load()
        ask_token(c)
        print("Now start it again:  python ~/khqr.py")
    else:
        run()
