#!/usr/bin/env python3
# Quiz Library — automatic KHQR check (runs in Termux on the admin's Android phone).
#
# Bakong only answers apps inside Cambodia, so this phone does the checking:
# it asks Supabase for KHQR payments, asks Bakong if they were paid, and tells
# Supabase. Supabase switches the plan on only when the right amount went to
# your Bakong ID.
#
# A free Bakong token allows only 100 checks a day, so a payment is checked only
# after the student taps "I paid" (at once, then a few retries if not found yet).
#
#   python ~/khqr.py setup <SECRET>   first time (asks for your Bakong token)
#   python ~/khqr.py                  start checking (leave Termux open)
#   python ~/khqr.py token            paste a new Bakong token (every ~90 days)
#   python ~/khqr.py check            show what it is watching and Bakong's answer
#
# Your Bakong token stays in ~/.ql-khqr.json on this phone only. It can only
# CHECK payments — it cannot send or move money.

import getpass, json, os, shutil, socket, subprocess, sys, threading, time, urllib.error, urllib.request
from datetime import datetime, timezone

SUPABASE = "https://hcultemyohiljypthtyb.supabase.co"
PUBLIC_KEY = "sb_publishable_MLyLNla9gaM3r8EUM00hYg_Gyejrvbd"  # public, same one the website uses
BAKONG = "https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5"
BAKONG_LIST = "https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5_list"
DAILY = 100      # Bakong's limit per token per day
KEEP = 15        # last checks kept for "I paid" payments when the day is almost used up
# when to check (seconds after the QR was shown / after "I paid")
QR_AT = []      # a QR on screen is NOT checked — the student taps "I paid" (saves the daily limit)
WAIT_AT = [0, 30, 90, 300, 1800, 7200, 43200, 86400]   # after "I paid": at once, then a few retries
CONF = os.path.expanduser("~/.ql-khqr.json")
EVERY = 8  # seconds between rounds (Supabase only — free)
STUCK = 90  # no finished round for this long (e.g. the internet switched mid-check) → restart by itself
socket.setdefaulttimeout(25)
BEAT = [time.time()]


def watchdog():
    while True:
        time.sleep(15)
        if time.time() - BEAT[0] > STUCK:
            say("🔄 No answer for a while (internet changed?) — restarting the checker by itself…")
            sys.stdout.flush()
            os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])


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
        return "error", "Bakong blocked this phone (HTTP 403). Use Cambodian internet (Wi-Fi or 4G), no VPN."
    if code == 401 or (j and j.get("errorCode") == 6):
        return "error", "Bakong token expired or wrong. Renew it, then run: python ~/khqr.py token"
    if code == 429 or limited(j):
        return "limit", LIMIT_MSG
    if j and j.get("responseCode") == 0 and isinstance(j.get("data"), dict):
        return "paid", j["data"]
    if j and "responseCode" in j:
        return "unpaid", None
    return "error", f"Bakong answered HTTP {code}"


LIMIT_MSG = "Bakong daily limit reached (100 checks a day). Approve payments by hand until it resets."


def limited(j):
    return isinstance(j, dict) and "limit" in str(j.get("responseMessage") or "").lower()


def bakong_list(token, md5s):
    """One request for many QRs. Returns ('ok', {md5: data-or-True}) / ('limit'|'error', message)."""
    code, text = post(BAKONG_LIST, md5s, {"Authorization": "Bearer " + token})
    try:
        j = json.loads(text)
    except Exception:
        j = None
    if code in (400, 403, 404, 405) and not isinstance(j, dict):
        return "nolist", f"HTTP {code}"
    if code == 401 or (j and j.get("errorCode") == 6):
        return "error", "Bakong token expired or wrong. Renew it, then run: python ~/khqr.py token"
    if code == 429 or limited(j):
        return "limit", LIMIT_MSG
    if not isinstance(j, dict) or "responseCode" not in j:
        return "error", f"Bakong answered HTTP {code}"
    paid = {}
    for it in j.get("data") or []:
        if isinstance(it, dict) and str(it.get("status", "")).upper() in ("SUCCESS", "PAID") and it.get("md5"):
            d = it.get("data")
            paid[it["md5"]] = d if isinstance(d, dict) and d.get("hash") else True
    return "ok", paid


def single_checks(c, items):
    """Ask Bakong about each payment separately (counts each one)."""
    paid = {}
    for p in items:
        st, d = bakong(c["token"], p["md5"])
        if st in ("limit", "error"):
            return st, d
        if st == "paid":
            paid[p["md5"]] = d
        count_call(c)
    count_call(c, -1)  # the caller counts one more
    return "ok", paid


def today():
    # Bakong's daily limit seems to reset at midnight UTC (7:00 AM in Cambodia), so count by UTC day
    return time.strftime("%Y-%m-%d", time.gmtime())


def count_call(c, n=1):
    if c.get("day") != today():
        c["day"], c["used"] = today(), 0
    c["used"] = c.get("used", 0) + n
    save(c)
    return c["used"]


def used_today(c):
    return c.get("used", 0) if c.get("day") == today() else 0


def age_minutes(iso):
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() / 60
    except Exception:
        return 0


def due(p, done):
    """How many checks this payment should have had by now (see QR_AT / WAIT_AT)."""
    age = age_minutes(p["created_at"]) * 60
    plan = WAIT_AT if p.get("status") == "waiting" else QR_AT
    return sum(1 for t in plan if age >= t) > done.get(p["id"], 0)


def run():
    c = load()
    if not c.get("secret") or not c.get("token"):
        raise SystemExit("First run:  python ~/khqr.py setup <SECRET>   (copy it from admin → Settings → KHQR)")
    if shutil.which("termux-wake-lock"):
        subprocess.run(["termux-wake-lock"], check=False)  # keep running while the screen is off
    device = "Android · Termux"
    say("⚡ Quiz Library KHQR auto-check is running. Leave Termux open (you can lock the screen).")
    done, told, note, approved, problem, pause = {}, set(), "ok", 0, False, 0
    BEAT[0] = time.time()
    threading.Thread(target=watchdog, daemon=True).start()
    while True:
        BEAT[0] = time.time()
        try:
            res = rpc("ql_khqr_pending", {"p_secret": c["secret"], "p_note": note,
                                          "p_device": f"{device} · {used_today(c)}/{DAILY} Bakong checks today"}) or {}
            if problem:
                say("✅ Connection back — checking payments again.")
                problem = False
            if note != LIMIT_MSG or time.time() >= pause:
                note = "ok"
            items = [p for p in res.get("pending") or [] if p.get("md5")]
            left = DAILY - used_today(c)
            todo = [p for p in items if due(p, done) and (left > KEEP or p.get("status") == "waiting")]
            if todo and time.time() >= pause and left > 0:
                if c.get("single"):
                    st, paid = single_checks(c, todo[:max(1, min(left, 10))])
                    todo = todo[:max(1, min(left, 10))]
                else:
                    st, paid = bakong_list(c["token"], [p["md5"] for p in todo[:50]])
                    if st == "nolist":  # this token can't use the list check → ask one by one from now on
                        count_call(c)
                        c["single"] = True
                        save(c)
                        say("ℹ️  Bakong's group check isn't available for this token — checking payments one by one.")
                        st, paid = single_checks(c, todo[:max(1, min(left, 10))])
                        todo = todo[:max(1, min(left, 10))]
                used = count_call(c)
                BEAT[0] = time.time()
                if st == "limit":
                    pause, note = time.time() + 3600, LIMIT_MSG
                    if LIMIT_MSG not in told:
                        say("⚠️  " + LIMIT_MSG)
                        told.add(LIMIT_MSG)
                elif st == "error":
                    note = paid
                    if paid not in told:
                        say("⚠️  " + paid)
                        told.add(paid)
                else:
                    for p in todo[:50]:
                        done[p["id"]] = done.get(p["id"], 0) + 1
                    if used in (50, 80, 95):
                        say(f"ℹ️  {used} of {DAILY} Bakong checks used today.")
                    for p in todo[:50]:
                        d = paid.get(p["md5"])
                        if not d:
                            continue
                        if d is True:  # the list said paid but without details → ask for this one
                            st1, d = bakong(c["token"], p["md5"])
                            count_call(c)
                            if st1 != "paid":
                                continue
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
            problem = True
            note = f"Network problem: {str(e)[:120]}"
            if note not in told:
                say("⚠️  " + note + " (retrying)")
                told.add(note)
        time.sleep(EVERY)


def check_once():
    """python ~/khqr.py check — show every payment the phone is watching and Bakong's answer."""
    c = load()
    res = rpc("ql_khqr_pending", {"p_secret": c["secret"], "p_note": "ok", "p_device": "Android · Termux"}) or {}
    print("Your Bakong ID in admin:", res.get("bakong_id"))
    items = res.get("pending") or []
    print(f"Payments being watched: {len(items)}")
    print(f"Bakong checks used today: {used_today(c)}/{DAILY}")
    if not items:
        return
    st, paid = bakong_list(c["token"], [p["md5"] for p in items[:50]])
    if st == "nolist":
        print("(group check not available for this token — asking one by one)")
        st, paid = single_checks(c, items[:10])
    count_call(c)
    if st != "ok":
        print("Bakong:", paid)
        return
    for p in items[:50]:
        d = paid.get(p["md5"])
        ans = "PAID ✅" + (f" · {d.get('amount')} {d.get('currency')} to {d.get('toAccountId')}" if isinstance(d, dict) else "") if d else "not paid yet"
        print(f"- {p.get('bill')} · ${p.get('amount')} · {p.get('status', '?')} · {int(age_minutes(p['created_at']))} min ago → {ans}")


def ask_token(c):
    t = getpass.getpass("Paste your Bakong token (it stays hidden), then press Enter: ").strip()
    if len(t) < 20:
        raise SystemExit("That doesn't look like a Bakong token. Try again.")
    c["token"] = t
    save(c)
    st, d = bakong(t, "0" * 32)
    count_call(c)
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
    elif a[:1] == ["check"]:
        check_once()
    elif a[:1] == ["token"]:
        c = load()
        ask_token(c)
        print("Now start it again:  python ~/khqr.py")
    else:
        run()
