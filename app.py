"""Team 9470 Ctrl-Alt-Defeat FRC Team Portal — lightweight self-hosted app.

Stack: Flask + stdlib sqlite3. Accounts live in the users table with
scrypt-hashed passwords; login state is a signed session cookie (see README).

Run:  pip install -r requirements.txt && python app.py
Env:  DB=<path>   SQLite file (default: data.db next to this file)
      DB=:memory: ephemeral in-memory mode (data lost on restart)
      PORT=<port>  default 5000
"""
import base64
import csv
import datetime
import functools
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import struct
import threading
import time

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB", os.path.join(BASE_DIR, "data.db"))

app = Flask(__name__, static_folder="static", static_url_path="/static")
# Dev server, iterated daily: never let the browser cache the page or
# the script for hours, or a pull shows yesterday's HTML against today's
# JS (which once killed the whole page — see BUGS.md).
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")


def _load_secret_key():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    path = os.path.join(BASE_DIR, ".secret_key")
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        key = secrets.token_hex(32)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(key)
        except OSError:
            pass  # read-only dir: sessions just will not survive restarts
        return key


app.secret_key = _load_secret_key()

# ----------------------------------------------------------------------------
# Database: one shared connection + lock. Fine for a small team on one
# process; a production server would use a real pool and Postgres.
# ----------------------------------------------------------------------------
_lock = threading.Lock()
_conn = None


def get_db():
    global _conn
    if _conn is None:
        if DB_PATH == ":memory:":
            # shared-cache URI so the single connection sees one DB
            _conn = sqlite3.connect("file:frcmem?mode=memory&cache=shared",
                                    uri=True, check_same_thread=False)
        else:
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
    return _conn


def init_db():
    db = get_db()
    with open(os.path.join(BASE_DIR, "schema.sql")) as f:
        db.executescript(f.read())
    _migrate(db)
    from seed import seed
    with _lock:
        seeded = seed(db)
    if seeded:
        print("Seeded sample data.")


def _dedupe_carpool_claims(db):
    """Collapse duplicate carpool rows from before the claim guard: one row
    per person per carpool. Keeps the earliest claimed row if any, else the
    earliest waitlisted row."""
    rows = db.execute(
        "SELECT * FROM carpool_claims ORDER BY carpool_id, id").fetchall()
    groups = {}
    for r in rows:
        key = (r["carpool_id"],
               r["member_id"] if r["member_id"] is not None
               else "name:" + (r["person_name"] or ""),
               r["person_kind"])
        groups.setdefault(key, []).append(r)
    for members in groups.values():
        if len(members) < 2:
            continue
        claimed = [r for r in members if r["status"] == "claimed"]
        keep = claimed[0] if claimed else members[0]
        for r in members:
            if r["id"] != keep["id"]:
                db.execute("DELETE FROM carpool_claims WHERE id=?", (r["id"],))


def _migrate(db):
    """Additive migrations for databases created before these columns."""
    room_cols = {r[1] for r in db.execute("PRAGMA table_info(rooms)")}
    car_cols = {r[1] for r in db.execute("PRAGMA table_info(carpools)")}
    user_cols = {r[1] for r in db.execute("PRAGMA table_info(users)")}
    task_cols = {r[1] for r in db.execute("PRAGMA table_info(tasks)")}
    event_cols = {r[1] for r in db.execute("PRAGMA table_info(events)")}
    member_cols = {r[1] for r in db.execute("PRAGMA table_info(members)")}
    lr_cols = {r[1] for r in db.execute("PRAGMA table_info(link_requests)")}
    tool_cols = {r[1] for r in db.execute("PRAGMA table_info(tools)")}
    van_cols = {r[1] for r in db.execute("PRAGMA table_info(team_vans)")}
    with _lock:
        if "parent_member_id" not in room_cols:
            db.execute("ALTER TABLE rooms ADD COLUMN parent_member_id INTEGER")
        if "parent_name" not in room_cols:
            db.execute("ALTER TABLE rooms ADD COLUMN parent_name TEXT")
        if "room_number" not in room_cols:
            db.execute("ALTER TABLE rooms ADD COLUMN room_number TEXT")
        if "beds" not in room_cols:
            db.execute("ALTER TABLE rooms ADD COLUMN beds TEXT")
        if "vehicle" not in car_cols:
            db.execute("ALTER TABLE carpools ADD COLUMN vehicle TEXT")
        if "driver_user_id" not in car_cols:
            db.execute("ALTER TABLE carpools ADD COLUMN driver_user_id INTEGER")
        if "vehicle_type" not in tool_cols:
            db.execute("ALTER TABLE tools ADD COLUMN vehicle_type TEXT")
        if "vehicle_id" not in tool_cols:
            db.execute("ALTER TABLE tools ADD COLUMN vehicle_id INTEGER")
        if "driver_user_id" not in van_cols:
            db.execute("ALTER TABLE team_vans ADD COLUMN driver_user_id INTEGER")
        if "seats" not in van_cols:
            db.execute("ALTER TABLE team_vans ADD COLUMN seats INTEGER")
        db.execute("""CREATE TABLE IF NOT EXISTS van_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            van_id INTEGER NOT NULL REFERENCES team_vans(id)
                ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id)
                ON DELETE CASCADE,
            member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
            person_kind TEXT, person_name TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        if "season" not in event_cols:
            db.execute("ALTER TABLE events ADD COLUMN season TEXT")
        if "totp_secret" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT")
        if "totp_enabled" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_enabled INTEGER"
                       " NOT NULL DEFAULT 0")
        if "totp_backup_codes" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_backup_codes TEXT")
        if "first_name" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN first_name TEXT")
        if "last_name" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN last_name TEXT")
        if "whatsapp" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN whatsapp TEXT")
        if "avatar" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
        if "disabled" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN disabled INTEGER"
                       " NOT NULL DEFAULT 0")
        if "must_change_password" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN must_change_password"
                       " INTEGER NOT NULL DEFAULT 0")
        if "temp_password_hash" not in member_cols:
            db.execute("ALTER TABLE members ADD COLUMN temp_password_hash TEXT")
        # Only when the table already exists (fresh DBs get the column
        # from the CREATE below; the ALTER would fail on a missing table).
        if lr_cols and "temp_password_hash" not in lr_cols:
            db.execute("ALTER TABLE link_requests ADD COLUMN"
                       " temp_password_hash TEXT")
        if lr_cols and "requester_whatsapp" not in lr_cols:
            db.execute("ALTER TABLE link_requests ADD COLUMN"
                       " requester_whatsapp TEXT NOT NULL DEFAULT ''")
        # 2026-10-25: build/workshop sessions do not provide lunch.
        # The wording round fixed the seed note, but existing databases
        # already hold the old text on their events, and there is no UI
        # to edit an event's notes — so rewrite it where it still says
        # so. Idempotent: after the rewrite the LIKE no longer matches.
        db.execute("UPDATE events SET notes = REPLACE(notes,"
                   " 'lunch provided for full-day crew',"
                   " 'no lunch provided — bring your own')"
                   " WHERE notes LIKE '%lunch provided for full-day crew%'")
        db.execute("CREATE TABLE IF NOT EXISTS meta ("
                   "key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("""CREATE TABLE IF NOT EXISTS user_members (
            user_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('self','parent')),
            PRIMARY KEY (user_id, member_id, kind))""")
        db.execute("""CREATE TABLE IF NOT EXISTS totp_recovery_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0, used_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (user_id, code_hash))""")
        db.execute("""CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
            author TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        db.execute("""CREATE TABLE IF NOT EXISTS team_vans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '')""")
        db.execute("""CREATE TABLE IF NOT EXISTS link_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_name TEXT NOT NULL,
            requester_email TEXT NOT NULL DEFAULT '',
            requester_phone TEXT NOT NULL DEFAULT '',
            requester_kind TEXT NOT NULL
                CHECK (requester_kind IN ('parent','student')),
            requester_whatsapp TEXT NOT NULL DEFAULT '',
            member_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','declined')),
            temp_password_hash TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        db.execute("""CREATE TABLE IF NOT EXISTS password_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        db.execute("""CREATE TABLE IF NOT EXISTS deletion_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, requested_by INTEGER,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','declined')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        # Backfill: split display names into first/last, filling only
        # columns still NULL so a later manual edit is never overwritten.
        for r in db.execute(
                "SELECT id, name, first_name, last_name FROM users"
                " WHERE first_name IS NULL OR last_name IS NULL"):
            parts = (r["name"] or "").split(None, 1)
            if r["first_name"] is None:
                db.execute("UPDATE users SET first_name=? WHERE id=?",
                           (parts[0] if parts else "", r["id"]))
            if r["last_name"] is None:
                db.execute("UPDATE users SET last_name=? WHERE id=?",
                           (parts[1] if len(parts) > 1 else "", r["id"]))
        # Move legacy JSON recovery-code hashes into the dedicated table
        # (once: the column is nulled after the move, so this never re-runs).
        for r in db.execute(
                "SELECT id, totp_backup_codes FROM users"
                " WHERE totp_backup_codes IS NOT NULL"
                " AND totp_backup_codes != ''"):
            try:
                hashes = json.loads(r["totp_backup_codes"])
            except (ValueError, TypeError):
                hashes = []
            if isinstance(hashes, list):
                for h in hashes:
                    db.execute("INSERT OR IGNORE INTO totp_recovery_codes"
                               " (user_id, code_hash) VALUES (?,?)",
                               (r["id"], h))
            db.execute("UPDATE users SET totp_backup_codes=NULL WHERE id=?",
                       (r["id"],))
        # One-time backfill, tracked by a marker row — NOT by the link
        # table's existence, because init_db creates the table from
        # schema.sql before _migrate runs, so existence can never signal
        # "first boot". The marker is what keeps the backfill from
        # re-running on later restarts. Later accounts link at creation,
        # and members link at approval.
        backfilled = db.execute(
            "SELECT value FROM meta WHERE key='iam_links_backfilled'"
            ).fetchone() is not None
        if not backfilled:
            for u in db.execute("SELECT id, name FROM users"):
                for mid, kind in _link_candidates(
                        u["name"], db.execute(
                            "SELECT id, first_name, last_name, parent_name"
                            " FROM members")):
                    db.execute("INSERT OR IGNORE INTO user_members"
                               " (user_id, member_id, kind) VALUES (?,?,?)",
                               (u["id"], mid, kind))
            db.execute("INSERT INTO meta (key, value) VALUES (?,?)",
                       ("iam_links_backfilled", "1"))
        # Fill an empty user whatsapp from the linked member's parent
        # WhatsApp, but only where the family opted in to WhatsApp updates.
        for r in db.execute(
                "SELECT um.user_id, m.parent_whatsapp FROM user_members um"
                " JOIN members m ON m.id = um.member_id"
                " WHERE um.kind='parent' AND m.whatsapp_opt_in=1"
                " AND m.parent_whatsapp IS NOT NULL"
                " AND m.parent_whatsapp != ''"):
            db.execute("UPDATE users SET whatsapp=? WHERE id=?"
                       " AND (whatsapp IS NULL OR whatsapp='')",
                       (r["parent_whatsapp"], r["user_id"]))
        if "assignees" not in task_cols:
            db.execute("ALTER TABLE tasks ADD COLUMN assignees TEXT")
        if "archived" not in task_cols:
            db.execute("ALTER TABLE tasks ADD COLUMN archived INTEGER"
                       " NOT NULL DEFAULT 0")
        # Backfill: legacy single assignee -> one-person list. Runs on
        # every boot but only touches rows whose assignees is still NULL.
        for r in db.execute(
                "SELECT id, assignee FROM tasks WHERE assignees IS NULL"
                " AND assignee IS NOT NULL AND assignee != ''"):
            db.execute("UPDATE tasks SET assignees=? WHERE id=?",
                       (json.dumps([r["assignee"]]), r["id"]))
        _dedupe_carpool_claims(db)
        # 2026-10-28: tools point at vehicles by id now, not by driver
        # name. One-time migration from the old claimed_by strings:
        # match an event carpool driver first, else a van name. Names
        # that match nothing (including every carpool wiped by the
        # driver-account clean slate) fall back to unassigned — the
        # tool returns to the pool instead of pointing at a ghost.
        migrated = db.execute(
            "SELECT value FROM meta WHERE key='tools_vehicle_ids_2026_10_28'"
            ).fetchone() is not None
        if not migrated:
            for t in db.execute(
                    "SELECT id, event_id, claimed_by FROM tools"
                    " WHERE claimed_by IS NOT NULL AND claimed_by != ''"
                    " AND vehicle_type IS NULL"):
                car = db.execute(
                    "SELECT id, driver_name FROM carpools WHERE event_id=?",
                    (t["event_id"],)).fetchall()
                match = [c for c in car
                         if _norm_name(c["driver_name"]) == _norm_name(t["claimed_by"])]
                if match:
                    db.execute("UPDATE tools SET vehicle_type='carpool',"
                               " vehicle_id=? WHERE id=?",
                               (match[0]["id"], t["id"]))
                    continue
                vans = db.execute("SELECT id, name FROM team_vans").fetchall()
                vmatch = [v for v in vans
                          if _norm_name(v["name"]) == _norm_name(t["claimed_by"])]
                if vmatch:
                    db.execute("UPDATE tools SET vehicle_type='van',"
                               " vehicle_id=? WHERE id=?",
                               (vmatch[0]["id"], t["id"]))
            db.execute("INSERT INTO meta (key, value) VALUES (?,?)",
                       ("tools_vehicle_ids_2026_10_28", "1"))
        # 2026-10-28: carpool model change (driver accounts, edit/remove).
        # Clear every posted ride so the pool restarts clean instead of
        # mixing old free-text drivers with the new account drivers.
        # Marker-gated: runs once, so rides posted after the wipe are
        # never touched. Claims go with their cars.
        wiped = db.execute(
            "SELECT value FROM meta WHERE key='carpools_wiped_2026_10_28'"
            ).fetchone() is not None
        if not wiped:
            db.execute("DELETE FROM carpool_claims")
            db.execute("DELETE FROM carpools")
            db.execute("INSERT INTO meta (key, value) VALUES (?,?)",
                       ("carpools_wiped_2026_10_28", "1"))
        db.commit()
        db.commit()


def row(d):
    """sqlite3.Row -> plain dict, parsing JSON columns."""
    d = dict(d)
    for k in ("prefs", "discovery_chats", "agreements", "preferred_roommates",
              "vehicle", "beds", "totp_backup_codes"):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except (ValueError, TypeError):
                pass
    return d


def q_all(sql, args=()):
    with _lock:
        cur = get_db().execute(sql, args)
        return [row(r) for r in cur.fetchall()]


def q_one(sql, args=()):
    with _lock:
        cur = get_db().execute(sql, args)
        r = cur.fetchone()
        return row(r) if r else None


def execute(sql, args=()):
    with _lock:
        db = get_db()
        cur = db.execute(sql, args)
        db.commit()
        return cur.lastrowid


def err(msg, code=400):
    return jsonify({"error": msg}), code


# ----------------------------------------------------------------------------
# Authentication — accounts live in the users table (SQLite); passwords are
# scrypt-hashed (werkzeug). Login state is Flask's signed session cookie.
# Public without login: the fresh sign-up application (POST /api/members),
# the subteam list the form needs, and the /api/auth/* endpoints.
# ----------------------------------------------------------------------------
PUBLIC_API = {("GET", "/api/subteams"), ("POST", "/api/members"),
              ("GET", "/api/members/duplicate-check"),
              ("GET", "/api/roster-names"), ("POST", "/api/link-requests"),
              ("GET", "/api/parent-names")}
MENTOR_ROLES = ("mentor", "admin")


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return q_one("SELECT id, name, email, role FROM users WHERE id=?", (uid,))


def setup_required():
    """True until at least one account has a password (first-run setup)."""
    r = q_one("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL")
    return not r or r["n"] == 0


def require_role(*roles):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            u = current_user()
            if not u:
                return err("login required", 401)
            if u["role"] not in roles:
                return err("mentor/admin access required", 403)
            return fn(*args, **kwargs)
        return wrapper
    return deco


def _mentor_denied():
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] not in MENTOR_ROLES:
        return err("mentor/admin access required", 403)
    return None


@app.before_request
def _auth_gate():
    p = request.path
    if not p.startswith("/api/") or p.startswith("/api/auth/"):
        return None
    if (request.method, p) in PUBLIC_API:
        return None
    u = current_user()
    if not u:
        return err("login required", 401)
    # A disabled account's session dies on its next request, and an
    # account on a temporary password can do nothing until it sets its
    # own (the forced-change endpoint lives under /api/auth/, so it
    # passes the early return above).
    full = q_one("SELECT disabled, must_change_password FROM users"
                 " WHERE id=?", (u["id"],))
    if full and full["disabled"]:
        session.clear()
        return err("account disabled", 401)
    if full and full["must_change_password"]:
        return err("password change required", 403)
    # Mentors/admins must have 2FA: without it, every non-auth API
    # route is closed. Setup itself lives under /api/auth/, so a
    # locked-out mentor can always reach it. Students/parents stay
    # opt-in.
    if u["role"] in MENTOR_ROLES:
        full = q_one("SELECT totp_enabled FROM users WHERE id=?", (u["id"],))
        if full and not full["totp_enabled"]:
            return err("two-factor setup required", 403)
    return None


def _flag_2fa_required(d, uid):
    """Carry requires_2fa on every user payload the frontend stores as
    ME, so the UI can hold mentor/admin accounts on Security until
    they set 2FA up (the server gate enforces the same rule)."""
    if d.get("role") in MENTOR_ROLES:
        full = q_one("SELECT totp_enabled FROM users WHERE id=?", (uid,))
        d["requires_2fa"] = bool(full) and not full["totp_enabled"]
    else:
        d["requires_2fa"] = False
    return d


def _flag_pw_change(d, uid):
    """Carry must_change_password on every user payload the frontend
    stores as ME, so the UI can hold first-login accounts on the
    password-change view (the server gate enforces the same rule)."""
    full = q_one("SELECT must_change_password FROM users WHERE id=?",
                 (uid,))
    d["must_change_password"] = bool(full) and bool(
        full["must_change_password"])
    return d


def _user_is_bif(uid):
    """True if any roster member linked to this account attends BASIS
    Independent Fremont — the school Club events are for."""
    for r in q_all("SELECT m.school FROM user_members um"
                   " JOIN members m ON m.id = um.member_id"
                   " WHERE um.user_id=?", (uid,)):
        if "basisindependentfremont" in _norm_name(r.get("school")):
            return True
    return False


def _public_user(u):
    d = {k: u[k] for k in ("id", "name", "email", "role")}
    d["bif"] = _user_is_bif(u["id"])
    return d


@app.route("/api/auth/me")
def api_auth_me():
    u = current_user()
    if not u:
        return jsonify({"user": None, "setup_required": setup_required()})
    user = _public_user(u)
    user["links"] = _user_links_map([u["id"]]).get(u["id"], [])
    full = q_one("SELECT phone, whatsapp, created_at, first_name,"
                 " last_name, totp_enabled FROM users WHERE id=?", (u["id"],))
    user["phone"] = full["phone"]
    user["whatsapp"] = full["whatsapp"]
    user["member_since"] = full["created_at"]
    user["first_name"] = full["first_name"]
    user["last_name"] = full["last_name"]
    user["totp_enabled"] = bool(full["totp_enabled"])
    _flag_2fa_required(user, u["id"])
    _flag_pw_change(user, u["id"])
    return jsonify({"user": user, "setup_required": setup_required()})


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    b = request.get_json(force=True, silent=True) or {}
    email = (b.get("email") or "").strip().lower()
    u = q_one("SELECT * FROM users WHERE lower(email)=?", (email,))
    if u and u.get("disabled"):
        return err("account disabled", 403)
    if (not u or not u["password_hash"] or
            not check_password_hash(u["password_hash"], b.get("password") or "")):
        return err("invalid email or password", 401)
    session.clear()
    if u.get("totp_enabled"):
        # password passed, but the session stays half-open until the code
        session["pending_uid"] = u["id"]
        return jsonify({"need_2fa": True})
    session["uid"] = u["id"]
    user = _public_user(u)
    _flag_2fa_required(user, u["id"])
    _flag_pw_change(user, u["id"])
    return jsonify({"user": user})


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/setup", methods=["POST"])
def api_auth_setup():
    if not setup_required():
        return err("setup is already complete", 400)
    b = request.get_json(force=True, silent=True) or {}
    name = (b.get("name") or "").strip()
    email = (b.get("email") or "").strip().lower()
    pw = b.get("password") or ""
    if not name or "@" not in email or len(pw) < 8:
        return err("name, a valid email, and a password of 8+ characters required")
    existing = q_one("SELECT * FROM users WHERE lower(email)=?", (email,))
    parts = name.split(None, 1)
    first, last = parts[0], parts[1] if len(parts) > 1 else ""
    if existing:
        execute("UPDATE users SET name=?, first_name=?, last_name=?,"
                " password_hash=? WHERE id=?",
                (name, first, last, generate_password_hash(pw),
                 existing["id"]))
        uid = existing["id"]
    else:
        uid = execute("INSERT INTO users (name, first_name, last_name,"
                      " email, role, password_hash) VALUES (?,?,?,?,?,?)",
                      (name, first, last, email, "admin",
                       generate_password_hash(pw)))
    _auto_link_user(uid)
    session.clear()
    session["uid"] = uid
    return jsonify({"user": _public_user(q_one(
        "SELECT id, name, email, role FROM users WHERE id=?", (uid,)))}), 201


def _password_reused(uid, new_password):
    """True if the new password matches any password this user has held
    (history includes every temporary password, so one can never be
    reused — for that account, ever again)."""
    for r in q_all("SELECT password_hash FROM password_history"
                   " WHERE user_id=?", (uid,)):
        if r["password_hash"] and check_password_hash(r["password_hash"],
                                                      new_password):
            return True
    return False


def _record_password(uid, password_hash):
    execute("INSERT INTO password_history (user_id, password_hash)"
            " VALUES (?,?)", (uid, password_hash))


@app.route("/api/auth/password", methods=["POST"])
def api_auth_password():
    u = current_user()
    if not u:
        return err("login required", 401)
    b = request.get_json(force=True, silent=True) or {}
    full = q_one("SELECT * FROM users WHERE id=?", (u["id"],))
    if not check_password_hash(full["password_hash"] or "", b.get("current") or ""):
        return err("current password is incorrect", 403)
    new = b.get("new") or ""
    if len(new) < 8:
        return err("new password must be 8+ characters")
    # Before the 2FA gate, for the same reason: a doomed request must
    # never spend a recovery code — and a reused password is doomed.
    if _password_reused(u["id"], new):
        return err("that password was used before — pick a new one")
    # Hardening: when 2FA is on, changing the password needs the second
    # factor too — otherwise a stolen password alone would let an
    # attacker lock the owner out. Same throttle, window, and recovery
    # fallback as login; the gate runs after the length check so a
    # recovery code is never spent on a request that would fail anyway.
    if full.get("totp_enabled"):
        if _totp_throttled(u["id"]):
            return err("too many failed codes — try again in 10 minutes", 429)
        code = (b.get("code") or "").strip()
        if not code:
            return err("two-factor code required", 403)
        secret = _totp_decrypt(full["totp_secret"]) if full.get("totp_secret") else None
        ok = bool(secret) and totp_check(secret, code)
        if not ok:
            digest = _hash_code(code.replace(" ", "").replace("-", "").upper())
            ok = _consume_recovery_code(u["id"], digest)
        if not ok:
            _totp_fail(u["id"])
            return err("that code did not match", 403)
        _totp_clear(u["id"])
    h = generate_password_hash(new)
    execute("UPDATE users SET password_hash=?, must_change_password=0"
            " WHERE id=?", (h, u["id"]))
    _record_password(u["id"], h)
    return jsonify({"ok": True})


@app.route("/api/auth/force-password-change", methods=["POST"])
def api_auth_force_password_change():
    """First-login reset for accounts on a temporary password (auto-created
    at approval, or reset by a mentor): the session proves the login, and
    the current password must still match, so a stale session alone
    cannot change it. The new password must not match any previous one —
    history includes the temp password, so it can never be reused."""
    u = current_user()
    if not u:
        return err("login required", 401)
    b = request.get_json(force=True, silent=True) or {}
    full = q_one("SELECT * FROM users WHERE id=?", (u["id"],))
    if not check_password_hash(full["password_hash"] or "",
                               b.get("current") or ""):
        return err("current password is incorrect", 403)
    new = b.get("new") or ""
    if len(new) < 8:
        return err("new password must be 8+ characters")
    if _password_reused(u["id"], new):
        return err("that password was used before — pick a new one")
    h = generate_password_hash(new)
    execute("UPDATE users SET password_hash=?, must_change_password=0"
            " WHERE id=?", (h, u["id"]))
    _record_password(u["id"], h)
    return jsonify({"ok": True})


def _valid_avatar(data):
    """A data URL the server will store: a small raster image, base64.
    The frontend resizes to 256px first, so a real upload is tens of KB;
    the 500KB cap is a backstop against abuse, not a target."""
    if not isinstance(data, str) or len(data) > 500000:
        return False
    for prefix in ("data:image/png;base64,", "data:image/jpeg;base64,",
                   "data:image/gif;base64,", "data:image/webp;base64,"):
        if data.startswith(prefix):
            payload = data[len(prefix):]
            break
    else:
        return False
    if not payload:
        return False
    try:
        base64.b64decode(payload, validate=True)
    except Exception:
        return False
    return True


@app.route("/api/auth/avatar", methods=["GET", "POST", "DELETE"])
def api_auth_avatar():
    """Your own avatar. Self-only by construction: the route takes no
    user id, it always acts on the logged-in account. NULL = no photo,
    and the UI falls back to name initials."""
    u = current_user()
    if not u:
        return err("login required", 401)
    if request.method == "GET":
        row = q_one("SELECT avatar FROM users WHERE id=?", (u["id"],))
        if not row or not row["avatar"]:
            return err("no avatar", 404)
        return jsonify({"avatar": row["avatar"]})
    if request.method == "DELETE":
        execute("UPDATE users SET avatar=NULL WHERE id=?", (u["id"],))
        return jsonify({"ok": True})
    b = request.get_json(force=True, silent=True) or {}
    if not _valid_avatar(b.get("avatar")):
        return err("avatar must be a PNG, JPEG, GIF, or WebP image"
                   " under 500KB", 400)
    execute("UPDATE users SET avatar=? WHERE id=?", (b["avatar"], u["id"]))
    return jsonify({"ok": True})


@app.route("/api/users/<int:uid>/avatar")
def api_user_avatar(uid):
    """Another account's avatar: the owner, or a mentor/admin (who
    manages accounts). Any other logged-in user gets a 403."""
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["id"] != uid and u["role"] not in ("mentor", "admin"):
        return err("forbidden", 403)
    row = q_one("SELECT avatar FROM users WHERE id=?", (uid,))
    if not row or not row["avatar"]:
        return err("no avatar", 404)
    return jsonify({"avatar": row["avatar"]})


@app.route("/api/auth/profile", methods=["POST"])
def api_auth_profile():
    """Self-service profile update: phone, WhatsApp, first/last name,
    and — for your own roster record — school and grade. Email stays
    mentor-managed; absent keys keep their current value, and anything
    else in the body is ignored. School/grade only land when the
    account has a roster link of kind 'self' (in practice a student);
    without one they are ignored, not an error."""
    u = current_user()
    if not u:
        return err("login required", 401)
    b = request.get_json(force=True, silent=True) or {}
    cur = q_one("SELECT name, phone, whatsapp, first_name, last_name"
                " FROM users WHERE id=?", (u["id"],))
    phone = ((b.get("phone") if "phone" in b else cur["phone"]) or "").strip()[:40]
    whatsapp = ((b.get("whatsapp") if "whatsapp" in b else cur["whatsapp"]) or "").strip()[:40]
    first = ((b.get("first_name") if "first_name" in b else cur["first_name"]) or "").strip()[:60]
    last = ((b.get("last_name") if "last_name" in b else cur["last_name"]) or "").strip()[:60]
    name = (first + " " + last).strip() or cur["name"]
    execute("UPDATE users SET phone=?, whatsapp=?, first_name=?,"
            " last_name=?, name=? WHERE id=?",
            (phone, whatsapp, first, last, name, u["id"]))
    if "school" in b or "grade" in b:
        link = q_one("SELECT member_id FROM user_members"
                     " WHERE user_id=? AND kind='self'", (u["id"],))
        if link:
            mcur = q_one("SELECT school, grade FROM members WHERE id=?",
                         (link["member_id"],))
            school = ((b.get("school") if "school" in b else mcur["school"]) or "").strip()[:120]
            grade = ((b.get("grade") if "grade" in b else mcur["grade"]) or "").strip()[:20]
            execute("UPDATE members SET school=?, grade=? WHERE id=?",
                    (school, grade, link["member_id"]))
    return jsonify(q_one("SELECT id, name, first_name, last_name, email,"
                         " phone, whatsapp, role FROM users WHERE id=?",
                         (u["id"],)))


# ----------------------------------------------------------------------------
# Two-factor authentication (TOTP, RFC 6238) — opt-in per user.
# Works with Google Authenticator and Apple Passwords: both accept the
# standard otpauth:// QR code. Secrets are encrypted at rest with a key
# derived from the app secret; recovery codes are sha256-hashed.
# ----------------------------------------------------------------------------
try:
    from cryptography.fernet import Fernet
except ImportError:  # pragma: no cover - requirements cover this
    Fernet = None
try:
    import qrcode
    import qrcode.image.svg
except ImportError:  # pragma: no cover
    qrcode = None

_TOTP_FAILS = {}  # user_id -> [fail_count, locked_until_epoch]; in-memory only


def _qr_svg_for_html(uri):
    """QR code SVG that actually renders when inserted via innerHTML.

    qrcode's SvgImage emits <svg:rect> elements, which browsers ignore
    in HTML-parsed content (they are not SVG shapes there), so the code
    came out as a blank box. Normalize to plain <rect> elements, and
    convert the millimetre coordinates to a viewBox so the code scales
    to its container instead of overflowing it.
    """
    import re
    raw = qrcode.make(uri,
                      image_factory=qrcode.image.svg.SvgImage).to_string()
    raw = raw.decode()
    raw = raw.replace("<svg:", "<").replace("</svg:", "</")
    raw = raw.replace('xmlns:svg="http://www.w3.org/2000/svg" ', "")
    m = re.search(r'width="([\d.]+)mm" height="([\d.]+)mm"', raw)
    if m:
        w, h = m.group(1), m.group(2)
        raw = raw.replace(f'width="{w}mm" height="{h}mm"',
                          f'width="100%" viewBox="0 0 {w} {h}"')
        raw = re.sub(r'="([\d.]+)mm"', r'="\1"', raw)
    return raw


def _totp_fernet():
    if Fernet is None:
        raise RuntimeError("cryptography package is not installed")
    digest = hashlib.sha256(app.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _totp_encrypt(secret):
    return _totp_fernet().encrypt(secret.encode()).decode()


def _totp_decrypt(token):
    if not token:
        return None
    try:
        return _totp_fernet().decrypt(token.encode()).decode()
    except Exception:
        return None


def totp_new_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_uri(secret, account):
    from urllib.parse import quote
    issuer = "FRC Team App"
    return ("otpauth://totp/" + quote(issuer) + ":" + quote(account)
            + "?secret=" + secret + "&issuer=" + quote(issuer)
            + "&algorithm=SHA1&digits=6&period=30")


def totp_code(secret, at=None):
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = int((at if at is not None else time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[off:off + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def totp_check(secret, code, window=1):
    code = (code or "").strip().replace(" ", "").replace("-", "")
    if not (code.isdigit() and len(code) == 6):
        return False
    now = int(time.time())
    return any(hmac.compare_digest(totp_code(secret, at=now + d * 30), code)
               for d in range(-window, window + 1))


def _backup_codes(n=8):
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no lookalike chars
    return ["".join(secrets.choice(alphabet) for _ in range(4)) + "-" +
            "".join(secrets.choice(alphabet) for _ in range(4))
            for _ in range(n)]


def _hash_code(code):
    return hashlib.sha256(code.encode()).hexdigest()


def _store_recovery_codes(uid, codes):
    """Replace a user's recovery codes with a fresh set, stored one row
    per code (sha256 hashes only — the plaintext codes are shown once
    and never stored)."""
    with _lock:
        db = get_db()
        db.execute("DELETE FROM totp_recovery_codes WHERE user_id=?", (uid,))
        for c in codes:
            db.execute("INSERT INTO totp_recovery_codes (user_id, code_hash)"
                       " VALUES (?,?)",
                       (uid, _hash_code(c.replace("-", ""))))
        db.commit()


def _consume_recovery_code(uid, digest):
    """Atomically mark one unused recovery code used (used_at kept as an
    audit trail). True only if an unused matching code existed — so a
    code can never be spent twice, even by two simultaneous logins."""
    with _lock:
        db = get_db()
        cur = db.execute(
            "UPDATE totp_recovery_codes SET used=1, used_at=datetime('now')"
            " WHERE user_id=? AND code_hash=? AND used=0", (uid, digest))
        db.commit()
        return cur.rowcount > 0


def _clear_recovery_codes(uid):
    with _lock:
        db = get_db()
        db.execute("DELETE FROM totp_recovery_codes WHERE user_id=?", (uid,))
        db.commit()


def _totp_throttled(uid):
    rec = _TOTP_FAILS.get(uid)
    return bool(rec and rec[1] > time.time())


def _totp_fail(uid):
    rec = _TOTP_FAILS.get(uid, [0, 0])
    rec[0] += 1
    if rec[0] >= 5:
        rec[1] = time.time() + 600  # 10-minute lockout after 5 bad codes
    _TOTP_FAILS[uid] = rec


def _totp_clear(uid):
    _TOTP_FAILS.pop(uid, None)


def _totp_full_user(uid):
    return q_one("SELECT * FROM users WHERE id=?", (uid,))


@app.route("/api/auth/totp-status")
def api_totp_status():
    u = current_user()
    if not u:
        return err("login required", 401)
    full = _totp_full_user(u["id"])
    remaining = q_one("SELECT COUNT(*) AS n FROM totp_recovery_codes"
                      " WHERE user_id=? AND used=0", (u["id"],))["n"]
    return jsonify({"enabled": bool(full.get("totp_enabled")),
                    "backup_codes_remaining": remaining})


@app.route("/api/auth/totp-setup", methods=["POST"])
def api_totp_setup():
    u = current_user()
    if not u:
        return err("login required", 401)
    full = _totp_full_user(u["id"])
    if full.get("totp_enabled"):
        return err("two-factor authentication is already on;"
                   " disable it first to set up again")
    secret = totp_new_secret()
    try:
        token = _totp_encrypt(secret)
    except RuntimeError:
        return err("two-factor setup needs the cryptography package — run:"
                   " python3 -m pip install -r requirements.txt, then restart"
                   " the server", 503)
    execute("UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?",
            (token, u["id"]))
    _clear_recovery_codes(u["id"])
    # QR codes need the qrcode package; without it enrollment still works
    # via the manual key, which both authenticator apps accept.
    svg = None
    if qrcode is not None:
        svg = _qr_svg_for_html(totp_uri(secret, u["name"]))
    return jsonify({"qr_svg": svg, "secret": secret})


@app.route("/api/auth/totp-verify", methods=["POST"])
def api_totp_verify():
    """Confirm enrollment: the code must match the pending secret."""
    u = current_user()
    if not u:
        return err("login required", 401)
    full = _totp_full_user(u["id"])
    if full.get("totp_enabled"):
        return err("two-factor authentication is already on")
    secret = _totp_decrypt(full.get("totp_secret"))
    b = request.get_json(force=True, silent=True) or {}
    if not secret or not totp_check(secret, b.get("code")):
        return err("that code did not match — check the app and try again")
    codes = _backup_codes()
    execute("UPDATE users SET totp_enabled=1 WHERE id=?", (u["id"],))
    _store_recovery_codes(u["id"], codes)
    return jsonify({"enabled": True, "backup_codes": codes})


@app.route("/api/auth/totp-disable", methods=["POST"])
def api_totp_disable():
    u = current_user()
    if not u:
        return err("login required", 401)
    full = _totp_full_user(u["id"])
    if not full.get("totp_enabled"):
        return err("two-factor authentication is not on")
    secret = _totp_decrypt(full.get("totp_secret"))
    b = request.get_json(force=True, silent=True) or {}
    if not secret or not totp_check(secret, b.get("code")):
        return err("a current authenticator code is required to disable 2FA")
    execute("UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?",
            (u["id"],))
    _clear_recovery_codes(u["id"])
    return jsonify({"enabled": False})


@app.route("/api/auth/totp-regenerate", methods=["POST"])
def api_totp_regenerate():
    u = current_user()
    if not u:
        return err("login required", 401)
    full = _totp_full_user(u["id"])
    if not full.get("totp_enabled"):
        return err("two-factor authentication is not on")
    secret = _totp_decrypt(full.get("totp_secret"))
    b = request.get_json(force=True, silent=True) or {}
    if not secret or not totp_check(secret, b.get("code")):
        return err("a current authenticator code is required")
    codes = _backup_codes()
    _store_recovery_codes(u["id"], codes)
    return jsonify({"backup_codes": codes})


@app.route("/api/auth/verify-2fa", methods=["POST"])
def api_verify_2fa():
    """Second login step: accepts a TOTP code or an unused recovery code."""
    uid = session.get("pending_uid")
    if not uid:
        return err("no two-factor login in progress", 401)
    if _totp_throttled(uid):
        return err("too many failed codes — try again in 10 minutes", 429)
    full = _totp_full_user(uid)
    if not full or not full.get("totp_enabled"):
        return err("two-factor authentication is not on for this account", 400)
    b = request.get_json(force=True, silent=True) or {}
    code = (b.get("code") or "").strip()
    secret = _totp_decrypt(full.get("totp_secret"))
    ok = bool(secret) and totp_check(secret, code)
    if not ok:
        # recovery code: normalized (dashless, uppercase) so typing the
        # code with or without its dash both work; consumed on use, and
        # the consume is atomic — a spent code can never be reused.
        digest = _hash_code(code.replace(" ", "").replace("-", "").upper())
        ok = _consume_recovery_code(uid, digest)
    if not ok:
        _totp_fail(uid)
        return err("that code did not match", 401)
    _totp_clear(uid)
    session.clear()
    session["uid"] = uid
    user = _public_user(q_one(
        "SELECT id, name, email, role FROM users WHERE id=?", (uid,)))
    _flag_2fa_required(user, uid)
    _flag_pw_change(user, uid)
    return jsonify({"user": user})


@app.route("/api/auth/totp-reset", methods=["POST"])
@require_role("mentor", "admin")
def api_totp_reset():
    """Mentor safety valve: clear a user's 2FA (e.g. lost phone)."""
    b = request.get_json(force=True, silent=True) or {}
    if not b.get("user_id"):
        return err("user_id required")
    if not q_one("SELECT id FROM users WHERE id=?", (b["user_id"],)):
        return err("user not found", 404)
    execute("UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?",
            (b["user_id"],))
    _clear_recovery_codes(b["user_id"])
    _totp_clear(b["user_id"])
    return jsonify({"ok": True})



# ----------------------------------------------------------------------------
# Frontend (same origin, no CORS)
# ----------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ----------------------------------------------------------------------------
# Reference data
# ----------------------------------------------------------------------------
@app.route("/api/subteams")
def api_subteams():
    from seed import SUBTEAM_BLURBS
    return jsonify([{"name": n, "blurb": b}
                    for n, b in SUBTEAM_BLURBS.items()])


def _user_links_map(user_ids=None):
    """{user_id: [{member_id, kind, member_name, school, grade,
    assigned_subteam, parent_name, prefs, linked_parents}]} for the link
    table. linked_parents is the parent accounts linked to that member
    (kind='parent') — so a student's Relationship can read "child of
    <parents>" from links, falling back to the parent_name string."""
    sql = ("SELECT um.user_id, um.member_id, um.kind,"
           " m.first_name AS m_first, m.last_name AS m_last,"
           " m.school, m.grade, m.assigned_subteam, m.parent_name,"
           " m.prefs"
           " FROM user_members um JOIN members m ON m.id = um.member_id")
    args = ()
    if user_ids is not None:
        sql += " WHERE um.user_id IN (%s)" % ",".join("?" * len(user_ids))
        args = tuple(user_ids)
    out = {}
    for l in q_all(sql, args):
        out.setdefault(l["user_id"], []).append({
            "member_id": l["member_id"], "kind": l["kind"],
            "member_name": ((l["m_first"] or "") + " "
                             + (l["m_last"] or "")).strip(),
            "school": l["school"], "grade": l["grade"],
            "assigned_subteam": l["assigned_subteam"],
            "parent_name": l["parent_name"],
            "prefs": l["prefs"]})
    member_ids = {l["member_id"] for links in out.values() for l in links}
    parents_by_member = {}
    if member_ids:
        for r in q_all("SELECT um.member_id, u.id AS uid, u.name FROM"
                       " user_members um JOIN users u ON u.id = um.user_id"
                       " WHERE um.kind='parent' AND um.member_id IN (%s)"
                       % ",".join("?" * len(member_ids)),
                       tuple(member_ids)):
            parents_by_member.setdefault(r["member_id"], []).append(
                {"id": r["uid"], "name": r["name"]})
    for links in out.values():
        for l in links:
            l["linked_parents"] = parents_by_member.get(l["member_id"], [])
    return out


@app.route("/api/users", methods=["GET", "POST"])
def api_users():
    denied = _mentor_denied()
    if denied:
        return denied
    if request.method == "GET":
        users = q_all(
            "SELECT id, name, first_name, last_name, email, phone, whatsapp,"
            " role, created_at, disabled,"
            " (password_hash IS NOT NULL) AS has_password,"
            " (totp_enabled IS NOT NULL AND totp_enabled != 0) AS totp_enabled"
            " FROM users ORDER BY name")
        links = _user_links_map()
        for u in users:
            u["links"] = links.get(u["id"], [])
        return jsonify(users)
    b = request.get_json(force=True)
    first = (b.get("first_name") or "").strip()
    last = (b.get("last_name") or "").strip()
    name = (b.get("name") or "").strip()
    if first or last:
        name = (first + " " + last).strip()
    elif name:
        parts = name.split(None, 1)
        first, last = parts[0], parts[1] if len(parts) > 1 else ""
    if not name or b.get("role") not in (
            "student", "parent", "mentor", "admin"):
        return err("name and a valid role (student|parent|mentor|admin) required")
    pw = b.get("password") or ""
    if pw and len(pw) < 8:
        return err("password must be 8+ characters")
    # A mentor-set password is a temporary password: the new account
    # must change it at first login, and it joins history.
    h = generate_password_hash(pw) if pw else None
    try:
        uid = execute(
            "INSERT INTO users (name, first_name, last_name, email, phone,"
            " whatsapp, role, password_hash, must_change_password)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (name, first, last, b.get("email"), b.get("phone"),
             b.get("whatsapp"), b["role"], h, 1 if pw else 0))
    except sqlite3.IntegrityError:
        return err("a user with that email already exists")
    if h:
        _record_password(uid, h)
    _auto_link_user(uid)
    user = q_one("SELECT id, name, first_name, last_name, email, phone,"
                 " whatsapp, role, created_at FROM users WHERE id=?", (uid,))
    user["links"] = _user_links_map([uid]).get(uid, [])
    return jsonify(user), 201


@app.route("/api/users/<int:uid>/password", methods=["POST"])
def api_user_password(uid):
    denied = _mentor_denied()
    if denied:
        return denied
    b = request.get_json(force=True, silent=True) or {}
    pw = b.get("password") or ""
    if len(pw) < 8:
        return err("password must be 8+ characters")
    if not q_one("SELECT id FROM users WHERE id=?", (uid,)):
        return err("user not found", 404)
    # A mentor-set password is a temporary password by definition: the
    # user must change it at next login, and it joins history so it can
    # never be reused. No history CHECK here — the mentor's explicit
    # action is allowed to re-issue a known password.
    h = generate_password_hash(pw)
    execute("UPDATE users SET password_hash=?, must_change_password=1"
            " WHERE id=?", (h, uid))
    _record_password(uid, h)
    return jsonify({"ok": True})


@app.route("/api/users/<int:uid>", methods=["PATCH"])
@require_role("mentor", "admin")
def api_user_patch(uid):
    """Mentor edit of an account's contact handle: currently only
    WhatsApp, which the Team accounts table edits inline. Empty clears
    it. Nothing else about the account changes here."""
    if not q_one("SELECT id FROM users WHERE id=?", (uid,)):
        return err("user not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    if "whatsapp" not in b:
        return err("nothing to update")
    wa = b.get("whatsapp")
    if wa is not None and not isinstance(wa, str):
        return err("whatsapp must be text")
    wa = (wa or "").strip() or None
    execute("UPDATE users SET whatsapp=? WHERE id=?", (wa, uid))
    return jsonify({"ok": True, "whatsapp": wa})


@app.route("/api/users/<int:uid>/relationships", methods=["POST"])
@require_role("mentor", "admin")
def api_user_relationships(uid):
    """Set a Relationship from the Team accounts table, both ways
    around the same parent links:
    - a PARENT account: {member_ids: [...]} sets exactly which roster
      students they are the parent of (kind='parent' links);
    - a STUDENT account: {parent_ids: [...]} sets exactly which parent
      accounts are linked to their roster member (the same rows, seen
      from the other side — so the student's row reads "child of ..."
      and each parent's row reads "parent of ..." automatically).
    Anything not in the list is unlinked. Mentor/admin rows have no
    roster side to edit and stay read-only."""
    u = q_one("SELECT id, role FROM users WHERE id=?", (uid,))
    if not u:
        return err("user not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    if u["role"] == "parent":
        try:
            ids = list(dict.fromkeys(int(x) for x in
                                     (b.get("member_ids") or [])))
        except (ValueError, TypeError):
            return err("member_ids must be a list of ids")
        for mid in ids:
            m = q_one("SELECT id, status FROM members WHERE id=?", (mid,))
            if not m:
                return err(f"member {mid} not found", 404)
            if m["status"] != "approved":
                return err("only roster (approved) students can be picked")
        execute("DELETE FROM user_members WHERE user_id=? AND kind='parent'",
                (uid,))
        for mid in ids:
            execute("INSERT OR IGNORE INTO user_members"
                    " (user_id, member_id, kind) VALUES (?,?,?)",
                    (uid, mid, "parent"))
        return jsonify({"ok": True, "member_ids": ids})
    if u["role"] == "student":
        try:
            ids = list(dict.fromkeys(int(x) for x in
                                     (b.get("parent_ids") or [])))
        except (ValueError, TypeError):
            return err("parent_ids must be a list of ids")
        for pid in ids:
            p = q_one("SELECT id, role FROM users WHERE id=?", (pid,))
            if not p:
                return err(f"user {pid} not found", 404)
            if p["role"] != "parent":
                return err("only parent accounts can be picked")
        self_link = q_one("SELECT member_id FROM user_members"
                          " WHERE user_id=? AND kind='self' LIMIT 1", (uid,))
        if not self_link:
            return err("that student has no roster member linked yet", 400)
        mid = self_link["member_id"]
        execute("DELETE FROM user_members WHERE member_id=?"
                " AND kind='parent'", (mid,))
        for pid in ids:
            execute("INSERT OR IGNORE INTO user_members"
                    " (user_id, member_id, kind) VALUES (?,?,?)",
                    (pid, mid, "parent"))
        return jsonify({"ok": True, "parent_ids": ids})
    return err("relationships are editable only for student and parent"
               " accounts", 400)


@app.route("/api/users/<int:uid>/disable", methods=["POST"])
@require_role("mentor", "admin")
def api_user_disable(uid):
    """Disable an account: it cannot log in, and any live session dies
    on its next request (the auth gate clears it). The account's OWN
    roster entry (self link) goes dormant with it — status 'archived',
    recoverable from the queue. Children's records are untouched: a
    disabled parent must not archive their kids."""
    me = current_user()
    if me and me["id"] == uid:
        return err("you cannot disable your own account", 400)
    u = q_one("SELECT id, role FROM users WHERE id=?", (uid,))
    if not u:
        return err("user not found", 404)
    if u["role"] in MENTOR_ROLES:
        remaining = q_one("SELECT COUNT(*) AS n FROM users"
                          " WHERE role IN ('mentor','admin')"
                          " AND (disabled IS NULL OR disabled=0)"
                          " AND id!=?", (uid,))["n"]
        if remaining == 0:
            return err("cannot disable the last mentor/admin", 400)
    execute("UPDATE users SET disabled=1 WHERE id=?", (uid,))
    execute("UPDATE members SET status='archived' WHERE id IN"
            " (SELECT member_id FROM user_members"
            " WHERE user_id=? AND kind='self')", (uid,))
    return jsonify({"ok": True})


@app.route("/api/users/<int:uid>/enable", methods=["POST"])
@require_role("mentor", "admin")
def api_user_enable(uid):
    """Re-enable a disabled account. The roster entry deliberately stays
    archived until a mentor moves it back — re-enabling the login must
    not silently re-activate the roster."""
    if not q_one("SELECT id FROM users WHERE id=?", (uid,)):
        return err("user not found", 404)
    execute("UPDATE users SET disabled=0 WHERE id=?", (uid,))
    return jsonify({"ok": True})


@app.route("/api/deletion-requests", methods=["GET", "POST"])
def api_deletion_requests():
    if request.method == "GET":
        denied = _mentor_denied()
        if denied:
            return denied
        if request.args.get("status") == "all":
            rows = q_all("SELECT dr.*, u.name AS target_name,"
                         " u.email AS target_email, u.role AS target_role,"
                         " r.name AS requester_name FROM deletion_requests dr"
                         " LEFT JOIN users u ON u.id = dr.user_id"
                         " LEFT JOIN users r ON r.id = dr.requested_by"
                         " ORDER BY dr.id")
        else:
            rows = q_all("SELECT dr.*, u.name AS target_name,"
                         " u.email AS target_email, u.role AS target_role,"
                         " r.name AS requester_name FROM deletion_requests dr"
                         " LEFT JOIN users u ON u.id = dr.user_id"
                         " LEFT JOIN users r ON r.id = dr.requested_by"
                         " WHERE dr.status='pending' ORDER BY dr.id")
        return jsonify(rows)
    denied = _mentor_denied()
    if denied:
        return denied
    b = request.get_json(force=True, silent=True) or {}
    try:
        target = int(b.get("user_id"))
    except (ValueError, TypeError):
        return err("user_id required")
    me = current_user()
    if me and me["id"] == target:
        return err("you cannot request deletion of your own account", 400)
    u = q_one("SELECT id, disabled FROM users WHERE id=?", (target,))
    if not u:
        return err("user not found", 404)
    if not u["disabled"]:
        return err("disable the account first", 400)
    dup = q_one("SELECT id FROM deletion_requests WHERE user_id=?"
                " AND status='pending'", (target,))
    if dup:
        return jsonify({"id": dup["id"], "duplicate": True})
    rid = execute("INSERT INTO deletion_requests (user_id, requested_by)"
                  " VALUES (?,?)", (target, me["id"] if me else None))
    return jsonify({"id": rid, "duplicate": False}), 201


@app.route("/api/deletion-requests/<int:rid>/approve", methods=["POST"])
@require_role("mentor", "admin")
def api_deletion_request_approve(rid):
    """Final deletion, from the queue: the account row, its links, its
    password history, and its recovery codes go. The roster entries
    themselves stay — archived, so a mistaken deletion is recoverable
    by re-approving the member, not by resurrecting the account."""
    r = q_one("SELECT * FROM deletion_requests WHERE id=?", (rid,))
    if not r:
        return err("deletion request not found", 404)
    if r["status"] != "pending":
        return err("deletion request already decided")
    if not q_one("SELECT id FROM users WHERE id=?", (r["user_id"],)):
        execute("UPDATE deletion_requests SET status='declined'"
                " WHERE id=?", (rid,))
        return err("user already gone", 404)
    execute("DELETE FROM user_members WHERE user_id=?", (r["user_id"],))
    execute("DELETE FROM password_history WHERE user_id=?", (r["user_id"],))
    execute("DELETE FROM totp_recovery_codes WHERE user_id=?",
            (r["user_id"],))
    execute("DELETE FROM users WHERE id=?", (r["user_id"],))
    execute("UPDATE deletion_requests SET status='approved' WHERE id=?",
            (rid,))
    execute("UPDATE deletion_requests SET status='declined'"
            " WHERE user_id=? AND status='pending' AND id!=?",
            (r["user_id"], rid))
    return jsonify({"deleted": r["user_id"]})


@app.route("/api/deletion-requests/<int:rid>/decline", methods=["POST"])
@require_role("mentor", "admin")
def api_deletion_request_decline(rid):
    r = q_one("SELECT * FROM deletion_requests WHERE id=?", (rid,))
    if not r:
        return err("deletion request not found", 404)
    if r["status"] != "pending":
        return err("deletion request already decided")
    execute("UPDATE deletion_requests SET status='declined' WHERE id=?",
            (rid,))
    return jsonify({"ok": True})
# ----------------------------------------------------------------------------
# Members (sign-up applications + roster)
# ----------------------------------------------------------------------------
MEMBER_COLS = ("first_name, last_name, school, grade, experience, student_email,"
               " student_phone, parent_name, relationship, parent_email,"
               " parent_phone, parent_whatsapp, whatsapp_opt_in, em_name, em_phone,"
               " medical, prefs, discovery_chats, discovery_sessions, notes,"
               " agreements, assigned_subteam")


@app.route("/api/members", methods=["GET", "POST"])
def api_members():
    if request.method == "GET":
        denied = _mentor_denied()
        if denied:
            return denied
        status = request.args.get("status")
        if status:
            members = q_all("SELECT * FROM members WHERE status=? ORDER BY id",
                            (status,))
        else:
            members = q_all("SELECT * FROM members ORDER BY id")
        return jsonify(members)
    b = request.get_json(force=True)
    # Name-only sign-ups (new-student branch) send just a name plus the
    # signer's contact: first/last name is all the intake requires. The
    # old full application required a parent name and four agreements;
    # the radio-driven sign-up flow replaced it, so those are optional.
    for f in ("first_name", "last_name"):
        if not b.get(f):
            return err(f"{f} is required")
    temp = b.get("temp_password") or ""
    if temp and len(temp) < 8:
        return err("temporary password must be 8+ characters")
    ag = b.get("agreements") or {}
    mid = execute(
        f"""INSERT INTO members (status, sample, {MEMBER_COLS})
            VALUES ('pending', 0, {','.join('?' * 22)})""",
        (b.get("first_name"), b.get("last_name"), b.get("school"),
         b.get("grade"), b.get("experience"), b.get("student_email"),
         b.get("student_phone"), b.get("parent_name"), b.get("relationship"),
         b.get("parent_email"), b.get("parent_phone"),
         b.get("parent_whatsapp"), 1 if b.get("whatsapp_opt_in") else 0,
         b.get("em_name"), b.get("em_phone"), b.get("medical"),
         json.dumps(b.get("prefs") or []),
         json.dumps(b.get("discovery_chats") or []),
         b.get("discovery_sessions"), b.get("notes"),
         json.dumps(ag), b.get("assigned_subteam")))
    execute("UPDATE members SET code=? WHERE id=?", (f"FRC-{100 + mid}", mid))
    if temp:
        execute("UPDATE members SET temp_password_hash=? WHERE id=?",
                (generate_password_hash(temp), mid))
    # A named parent already in the pool brings their contact along.
    _fill_parent_contact(mid)
    return jsonify(q_one("SELECT * FROM members WHERE id=?", (mid,))), 201


@app.route("/api/members/<int:mid>", methods=["GET", "PATCH", "DELETE"])
@require_role("mentor", "admin")
def api_member(mid):
    m = q_one("SELECT * FROM members WHERE id=?", (mid,))
    if not m:
        return err("member not found", 404)
    if request.method == "GET":
        return jsonify(m)
    if request.method == "DELETE":
        execute("DELETE FROM members WHERE id=?", (mid,))
        execute("DELETE FROM user_members WHERE member_id=?", (mid,))
        return jsonify({"deleted": mid})
    b = request.get_json(force=True)
    sets, args = [], []
    if "status" in b:
        if b["status"] not in ("pending", "approved", "waitlisted",
                               "declined", "archived"):
            return err("bad status")
        sets.append("status=?")
        args.append(b["status"])
    if "assigned_subteam" in b:
        sets.append("assigned_subteam=?")
        args.append(b["assigned_subteam"])
    if sets:
        args.append(mid)
        execute(f"UPDATE members SET {', '.join(sets)} WHERE id=?", args)
    if b.get("status") == "approved":
        # Approval brings the member onto the team: link any existing
        # accounts that match this member (or its parent) by name.
        _auto_link_member(mid)
        # ...and create the signer's account from the temporary
        # password, if the sign-up carried one.
        _auto_create_account_for_member(mid)
    return jsonify(q_one("SELECT * FROM members WHERE id=?", (mid,)))


@app.route("/api/members/duplicate-check")
def api_members_duplicate_check():
    """Names-only duplicate hint for the public sign-up form: returns
    existing members whose normalized name matches, so the form can
    warn instead of filing a second application. No contact details
    leave the server here."""
    want = _norm_name(request.args.get("first_name", "")
                      + request.args.get("last_name", ""))
    if not want:
        return jsonify([])
    out = []
    for m in q_all("SELECT first_name, last_name, school, status"
                   " FROM members"):
        if _norm_name(m["first_name"] + m["last_name"]) == want:
            out.append({"name": f"{m['first_name']} {m['last_name']}",
                        "school": m["school"], "status": m["status"]})
    return jsonify(out)


@app.route("/api/roster-names")
def api_roster_names():
    """Names-only approved roster, for the public sign-up picker: a
    visitor picks an existing student without seeing any contact
    details (same names-only rule as the duplicate check)."""
    return jsonify([{"id": m["id"],
                     "name": f"{m['first_name']} {m['last_name']}".strip()}
                    for m in q_all(
                        "SELECT id, first_name, last_name FROM members"
                        " WHERE status='approved' ORDER BY last_name,"
                        " first_name")])


@app.route("/api/parent-names")
def api_parent_names():
    """Public, names-only: parents already in the pool — parent accounts
    plus the parent names on approved roster members — deduped, so a
    student sign-up can pick an existing parent instead of retyping
    one. Contact details stay server-side; the intake fills them from
    the match (see _fill_parent_contact)."""
    seen = {}
    for u in q_all("SELECT name FROM users WHERE role='parent'"):
        seen.setdefault(_norm_name(u["name"]), u["name"])
    for m in q_all("SELECT DISTINCT parent_name FROM members"
                   " WHERE status='approved' AND parent_name IS NOT NULL"
                   " AND parent_name != ''"):
        seen.setdefault(_norm_name(m["parent_name"]), m["parent_name"])
    names = sorted(seen.values(), key=lambda n: n.lower())
    return jsonify([{"name": n} for n in names])


def _link_request_row(rid):
    r = q_one("SELECT lr.*, m.first_name AS m_first, m.last_name AS m_last"
              " FROM link_requests lr JOIN members m ON m.id = lr.member_id"
              " WHERE lr.id=?", (rid,))
    if r:
        r["member_name"] = f"{r.pop('m_first')} {r.pop('m_last')}".strip()
    return r


@app.route("/api/link-requests", methods=["GET", "POST"])
def api_link_requests():
    if request.method == "GET":
        denied = _mentor_denied()
        if denied:
            return denied
        if request.args.get("status") == "all":
            rows = q_all("SELECT lr.*, m.first_name AS m_first,"
                         " m.last_name AS m_last FROM link_requests lr"
                         " JOIN members m ON m.id = lr.member_id"
                         " ORDER BY lr.id")
        else:
            rows = q_all("SELECT lr.*, m.first_name AS m_first,"
                         " m.last_name AS m_last FROM link_requests lr"
                         " JOIN members m ON m.id = lr.member_id"
                         " WHERE lr.status='pending' ORDER BY lr.id")
        for r in rows:
            r["member_name"] = f"{r.pop('m_first')} {r.pop('m_last')}".strip()
        return jsonify(rows)
    b = request.get_json(force=True, silent=True) or {}
    name = (b.get("requester_name") or "").strip()
    kind = b.get("requester_kind")
    if not name or kind not in ("parent", "student"):
        return err("requester_name and kind (parent|student) required")
    temp = b.get("temp_password") or ""
    if temp and len(temp) < 8:
        return err("temporary password must be 8+ characters")
    try:
        mid = int(b.get("member_id"))
    except (ValueError, TypeError):
        return err("member_id required")
    if not q_one("SELECT id FROM members WHERE id=? AND status='approved'",
                 (mid,)):
        return err("that student is not on the roster", 400)
    # A second click (or a second visit) files no duplicate: a pending
    # request for the same person + student is the same request.
    dup = q_one("SELECT id FROM link_requests WHERE member_id=?"
                " AND status='pending' AND lower(requester_name)=lower(?)",
                (mid, name))
    if dup:
        row = _link_request_row(dup["id"])
        row["duplicate"] = True
        return jsonify(row)
    rid = execute("INSERT INTO link_requests (requester_name,"
                  " requester_email, requester_phone, requester_kind,"
                  " member_id, temp_password_hash, requester_whatsapp)"
                  " VALUES (?,?,?,?,?,?,?)",
                  (name, (b.get("requester_email") or "").strip(),
                   (b.get("requester_phone") or "").strip(), kind, mid,
                   generate_password_hash(temp) if temp else None,
                   (b.get("whatsapp") or "").strip()))
    row = _link_request_row(rid)
    row["duplicate"] = False
    return jsonify(row), 201


@app.route("/api/link-requests/<int:rid>/approve", methods=["POST"])
@require_role("mentor", "admin")
def api_link_request_approve(rid):
    """Approve a link request: if the requester already has an account
    (matched by email), link it now. A parent requester also fills the
    member's blank parent contact fields, so a later account creation
    auto-links by name even without an existing account."""
    r = q_one("SELECT * FROM link_requests WHERE id=?", (rid,))
    if not r:
        return err("link request not found", 404)
    if r["status"] != "pending":
        return err("link request already decided")
    linked_user = False
    if r["requester_email"]:
        u = q_one("SELECT id FROM users WHERE lower(email)=lower(?)",
                  (r["requester_email"],))
        if u:
            execute("INSERT OR IGNORE INTO user_members"
                    " (user_id, member_id, kind) VALUES (?,?,?)",
                    (u["id"], r["member_id"], r["requester_kind"]))
            linked_user = True
    if r["requester_kind"] == "parent":
        m = q_one("SELECT parent_name, parent_email, parent_phone,"
                  " parent_whatsapp FROM members WHERE id=?",
                  (r["member_id"],))
        if m:
            if not m["parent_name"] and r["requester_name"]:
                execute("UPDATE members SET parent_name=? WHERE id=?",
                        (r["requester_name"], r["member_id"]))
            if not m["parent_email"] and r["requester_email"]:
                execute("UPDATE members SET parent_email=? WHERE id=?",
                        (r["requester_email"], r["member_id"]))
            if not m["parent_phone"] and r["requester_phone"]:
                execute("UPDATE members SET parent_phone=? WHERE id=?",
                        (r["requester_phone"], r["member_id"]))
            if not m["parent_whatsapp"] and r["requester_whatsapp"]:
                execute("UPDATE members SET parent_whatsapp=? WHERE id=?",
                        (r["requester_whatsapp"], r["member_id"]))
    # No existing account for that email: create one from the temporary
    # password the signer chose (forced to change at first login). An
    # existing account is linked above and its password is never
    # overwritten from a sign-up.
    if not linked_user and r["temp_password_hash"] and r["requester_email"]:
        email = r["requester_email"].strip().lower()
        parts = (r["requester_name"] or "").split(None, 1)
        first = parts[0] if parts else r["requester_name"]
        last = parts[1] if len(parts) > 1 else ""
        # Role is parent/student; the LINK kind is parent/self.
        link_kind = "self" if r["requester_kind"] == "student" else "parent"
        uid = _create_temp_account(r["requester_name"], first, last, email,
                                   r["requester_phone"],
                                   r["requester_kind"],
                                   r["temp_password_hash"], r["member_id"],
                                   link_kind,
                                   r["requester_whatsapp"] or None)
        if uid is None:
            existing = q_one("SELECT id FROM users WHERE lower(email)=?",
                             (email,))
            if existing:
                execute("INSERT OR IGNORE INTO user_members"
                        " (user_id, member_id, kind) VALUES (?,?,?)",
                        (existing["id"], r["member_id"], link_kind))
    # An existing account linked above gets the sign-up WhatsApp too,
    # but only if its own handle is blank — never overwriting. (A
    # freshly created account already carries it, so this is a no-op
    # for that path.)
    if r["requester_whatsapp"] and r["requester_email"]:
        existing = q_one("SELECT id FROM users WHERE lower(email)=?",
                         (r["requester_email"].strip().lower(),))
        if existing:
            execute("UPDATE users SET whatsapp=? WHERE id=?"
                    " AND (whatsapp IS NULL OR whatsapp='')",
                    (r["requester_whatsapp"], existing["id"]))
    execute("UPDATE link_requests SET status='approved',"
            " temp_password_hash=NULL WHERE id=?", (rid,))
    row = _link_request_row(rid)
    row["linked_user"] = linked_user
    return jsonify(row)


@app.route("/api/link-requests/<int:rid>/decline", methods=["POST"])
@require_role("mentor", "admin")
def api_link_request_decline(rid):
    r = q_one("SELECT * FROM link_requests WHERE id=?", (rid,))
    if not r:
        return err("link request not found", 404)
    if r["status"] != "pending":
        return err("link request already decided")
    execute("UPDATE link_requests SET status='declined' WHERE id=?", (rid,))
    return jsonify(_link_request_row(rid))


@app.route("/api/members/bulk-approve", methods=["POST"])
@require_role("mentor", "admin")
def api_members_bulk_approve():
    """Approve several pending members at once (the CSV-import flow can
    land a dozen pending applications; approving one by one is the
    bottleneck). Only currently-pending members change, and each
    approval runs the same account auto-link as a single approval."""
    b = request.get_json(force=True, silent=True) or {}
    ids = b.get("member_ids") or []
    if not isinstance(ids, list):
        return err("member_ids must be a list")
    approved = 0
    for mid in ids:
        try:
            mid = int(mid)
        except (ValueError, TypeError):
            continue
        m = q_one("SELECT status FROM members WHERE id=?", (mid,))
        if m and m["status"] == "pending":
            execute("UPDATE members SET status='approved' WHERE id=?",
                    (mid,))
            _auto_link_member(mid)
            _auto_create_account_for_member(mid)
            approved += 1
    return jsonify({"approved": approved, "requested": len(ids)})


@app.route("/api/members/sample", methods=["DELETE"])
@require_role("mentor", "admin")
def api_members_clear_samples():
    with _lock:
        db = get_db()
        db.execute("DELETE FROM user_members WHERE member_id IN"
                   " (SELECT id FROM members WHERE sample=1)")
        n = db.execute("DELETE FROM members WHERE sample=1").rowcount
        db.commit()
    return jsonify({"cleared": n})


@app.route("/api/members/<int:mid>/welcome")
@require_role("mentor", "admin")
def api_welcome(mid):
    m = q_one("SELECT * FROM members WHERE id=?", (mid,))
    if not m:
        return err("member not found", 404)
    name = f"{m['first_name']} {m['last_name']}"
    lines = [f"Welcome to the team, {name}!"]
    if m.get("assigned_subteam"):
        lines.append(f"You've been placed on the {m['assigned_subteam']} subteam.")
    chats = m.get("discovery_chats") or []
    if chats:
        lines.append("Discovery chat invites coming for: " + ", ".join(chats) + ".")
    if m.get("whatsapp_opt_in") and m.get("parent_whatsapp"):
        lines.append("Your parent will get team updates on WhatsApp at "
                     f"{m['parent_whatsapp']}.")
    lines.append("Watch for the season calendar and first build session details.")
    return jsonify({"message": "\n".join(lines)})


@app.route("/api/backup")
@require_role("mentor", "admin")
def api_backup():
    """One-click full database download. Uses SQLite's online backup
    API under the app lock, so the snapshot is consistent even while
    the server is running; an in-memory database backs up to a file
    the same way."""
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        with _lock:
            src = get_db()
            dst = sqlite3.connect(tmp)
            try:
                src.backup(dst)
            finally:
                dst.close()
        with open(tmp, "rb") as f:
            data = f.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    stamp = datetime.datetime.now().strftime("%Y%m%d")
    return app.response_class(data, mimetype="application/octet-stream",
                              headers={"Content-Disposition":
                                       "attachment; filename="
                                       f"frc-team-app-backup-{stamp}.db"})


@app.route("/api/roster")
@require_role("mentor", "admin")
def api_roster():
    return jsonify(q_all("SELECT * FROM members WHERE status='approved'"
                         " ORDER BY last_name, first_name"))


@app.route("/api/people")
def api_people():
    """Names-only directory of approved members for RSVP/travel pickers.
    Full contact details stay on the mentor-only roster."""
    return jsonify(q_all(
        "SELECT id, first_name, last_name, parent_name FROM members"
        " WHERE status='approved' ORDER BY last_name, first_name"))


@app.route("/api/roster.csv")
@require_role("mentor", "admin")
def api_roster_csv():
    import csv
    import io
    members = q_all("SELECT * FROM members WHERE status='approved'"
                    " ORDER BY last_name, first_name")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Code", "Student", "School", "Grade", "Subteam", "Student email",
                "Student phone", "Parent", "Parent email", "Parent phone",
                "Parent WhatsApp", "WhatsApp updates", "Discovery chats"])
    for m in members:
        w.writerow([m["code"], f"{m['first_name']} {m['last_name']}", m["school"],
                    m["grade"], m["assigned_subteam"], m["student_email"],
                    m["student_phone"], m["parent_name"], m["parent_email"],
                    m["parent_phone"], m["parent_whatsapp"],
                    "yes" if m["whatsapp_opt_in"] else "no",
                    ", ".join(m["discovery_chats"] or [])])
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition":
                                       "attachment; filename=roster.csv"})


@app.route("/api/events.csv")
@require_role("mentor", "admin")
def api_events_csv():
    """Events export: the same columns the events import accepts, so an
    event list round-trips through a spreadsheet."""
    events = q_all("SELECT * FROM events ORDER BY date, id")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Code", "Title", "Type", "Date", "Time", "Location",
                "Capacity", "Deadline", "Session hours", "Notes", "Season"])
    for e in events:
        w.writerow([e["code"], e["title"], e["type"], e["date"], e["time"],
                    e["location"],
                    "" if e["capacity"] is None else e["capacity"],
                    e["deadline"], e["session_hours"], e["notes"],
                    e["season"]])
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition":
                                       "attachment; filename=events.csv"})


# ----------------------------------------------------------------------------
# CSV import (mentor/admin) — the counterpart to CSV export, so a roster
# or event list built in a spreadsheet (or exported from last year) can
# be loaded without retyping it in the UI.
#
# Flow: upload a file -> preview parses and validates every row WITHOUT
# writing anything -> the mentor confirms -> confirm re-validates and
# applies. Rows match existing records by Code: a matching code updates
# that record, a new or blank code creates one. New members start
# pending (they land in the Mentor Queue); new events are live at once,
# like mentor-created ones. On update, only columns present in the file
# overwrite, and a blank cell in a present column clears that field —
# except session_hours, where blank keeps the old value. Rows with
# errors are reported and skipped, never half-written. Previewed rows
# are echoed back by the client for confirm, so confirm never trusts
# an id from the client: it re-resolves every row by code.
# ----------------------------------------------------------------------------
_CSV_MAX_BYTES = 1024 * 1024
_CSV_MAX_ROWS = 2000
_EVENT_TYPES = ("meeting", "build", "competition", "outreach", "club")
_EVENT_HOUR_DEFAULTS = {"meeting": 2, "build": 4, "competition": 8,
                        "outreach": 3, "club": 1}


def _csv_read(file_storage):
    """(normalized headers, [(line, {header: value})]) for an upload.
    Raises ValueError on an unreadable, oversized, or headerless file.
    Blank lines are skipped; values are stripped."""
    raw = file_storage.read(_CSV_MAX_BYTES + 1)
    if len(raw) > _CSV_MAX_BYTES:
        raise ValueError("file is too large (1MB max)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("file must be UTF-8 CSV")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("no header row found")
    headers = []
    for h in reader.fieldnames:
        h = (h or "").strip().lower()
        if h and h not in headers:
            headers.append(h)
    if not headers:
        raise ValueError("no header row found")
    rows = []
    for line_no, raw_row in enumerate(reader, start=2):
        if raw_row is None:
            continue
        vals = {}
        for k, v in raw_row.items():
            if k is None:
                continue
            vals[k.strip().lower()] = (v or "").strip() if isinstance(v, str) else ""
        if not any(vals.values()):
            continue
        rows.append((line_no, vals))
        if len(rows) > _CSV_MAX_ROWS:
            raise ValueError("too many rows (2000 max)")
    return headers, rows


def _yes_no(vals, col):
    raw = (vals.get(col) or "").strip().lower()
    if raw in ("yes", "true", "1", "y"):
        return 1, None
    if raw in ("no", "false", "0", "n", ""):
        return 0, None
    return None, f"{col} must be yes or no"


def _date_or_none(vals, col, errors):
    raw = (vals.get(col) or "").strip()
    if not raw:
        return None
    try:
        datetime.datetime.strptime(raw, "%Y-%m-%d")
    except ValueError:
        errors.append(f"{col} must be YYYY-MM-DD")
        return None
    return raw


def _validate_roster_row(vals, seen_codes, subteam_names):
    """(normalized data, [errors], present DB columns) for one row."""
    errors = []
    first = (vals.get("first name") or "").strip()
    last = (vals.get("last name") or "").strip()
    student = vals.get("student") or ""
    if not first and not last and student:
        parts = student.split(None, 1)
        first = parts[0] if parts else ""
        last = parts[1] if len(parts) > 1 else ""
    if not first:
        errors.append("first name is required")
    if not last:
        errors.append("last name is required")
    code = (vals.get("code") or "").strip()
    if code:
        if code in seen_codes:
            errors.append(f"duplicate code {code} in file")
        seen_codes.add(code)
    for col in ("student email", "parent email"):
        em = (vals.get(col) or "").strip()
        if em and "@" not in em:
            errors.append(f"{col} is not an email")
    sub = (vals.get("subteam") or "").strip()
    if sub and sub not in subteam_names:
        errors.append(f"unknown subteam {sub}")
    opt_in, opt_err = _yes_no(vals, "whatsapp updates")
    if opt_err:
        errors.append(opt_err)
    chats = [c.strip() for c in (vals.get("discovery chats") or "").split(",")]
    chats = [c for c in chats if c]
    data = {"code": code, "first_name": first, "last_name": last,
            "school": (vals.get("school") or "").strip(),
            "grade": (vals.get("grade") or "").strip(),
            "assigned_subteam": sub or None,
            "student_email": (vals.get("student email") or "").strip(),
            "student_phone": (vals.get("student phone") or "").strip(),
            "parent_name": (vals.get("parent") or "").strip(),
            "parent_email": (vals.get("parent email") or "").strip(),
            "parent_phone": (vals.get("parent phone") or "").strip(),
            "parent_whatsapp": (vals.get("parent whatsapp") or "").strip(),
            "whatsapp_opt_in": opt_in if opt_in is not None else 0,
            "discovery_chats": chats}
    present = set()
    if "first name" in vals or "student" in vals:
        present.add("first_name")
    if "last name" in vals or "student" in vals:
        present.add("last_name")
    for header, col in (("school", "school"), ("grade", "grade"),
                        ("subteam", "assigned_subteam"),
                        ("student email", "student_email"),
                        ("student phone", "student_phone"),
                        ("parent", "parent_name"),
                        ("parent email", "parent_email"),
                        ("parent phone", "parent_phone"),
                        ("parent whatsapp", "parent_whatsapp"),
                        ("whatsapp updates", "whatsapp_opt_in"),
                        ("discovery chats", "discovery_chats")):
        if header in vals:
            present.add(col)
    action = "create"
    if code and q_one("SELECT id FROM members WHERE code=?", (code,)):
        action = "update"
    return data, errors, present, action


def _apply_roster_row(data, present):
    existing = None
    if data["code"]:
        existing = q_one("SELECT * FROM members WHERE code=?", (data["code"],))
    if existing:
        sets, args = [], []
        for col in ("first_name", "last_name", "school", "grade",
                    "assigned_subteam", "student_email", "student_phone",
                    "parent_name", "parent_email", "parent_phone",
                    "parent_whatsapp", "whatsapp_opt_in"):
            if col in present:
                sets.append(f"{col}=?")
                args.append(data[col])
        if "discovery_chats" in present:
            sets.append("discovery_chats=?")
            args.append(json.dumps(data["discovery_chats"]))
        if sets:
            execute(f"UPDATE members SET {', '.join(sets)} WHERE id=?",
                    (*args, existing["id"]))
        return "updated"
    mid = execute(
        """INSERT INTO members (status, sample, first_name, last_name,
           school, grade, assigned_subteam, student_email, student_phone,
           parent_name, parent_email, parent_phone, parent_whatsapp,
           whatsapp_opt_in, discovery_chats)
           VALUES ('pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (data["first_name"], data["last_name"], data["school"],
         data["grade"], data["assigned_subteam"], data["student_email"],
         data["student_phone"], data["parent_name"], data["parent_email"],
         data["parent_phone"], data["parent_whatsapp"],
         data["whatsapp_opt_in"], json.dumps(data["discovery_chats"])))
    execute("UPDATE members SET code=? WHERE id=?",
            (data["code"] or f"FRC-{100 + mid}", mid))
    return "created"


def _validate_event_row(vals, seen_codes):
    errors = []
    title = (vals.get("title") or "").strip()
    if not title:
        errors.append("title is required")
    typ = (vals.get("type") or "meeting").strip().lower()
    if typ not in _EVENT_TYPES:
        errors.append(f"unknown type {typ}")
    date = _date_or_none(vals, "date", errors)
    deadline = _date_or_none(vals, "deadline", errors)
    time_raw = (vals.get("time") or "").strip()
    import re as _re
    if time_raw and not _re.match(r"^\d{1,2}:\d{2}(\s*[APap][Mm])?$", time_raw):
        errors.append("time must look like 6:00 PM or 18:00")
    cap_raw = (vals.get("capacity") or "").strip()
    capacity = None
    if cap_raw:
        try:
            capacity = int(cap_raw)
            if capacity < 0:
                raise ValueError
        except ValueError:
            errors.append("capacity must be a whole number 0 or higher")
            capacity = None
    hours_raw = (vals.get("session hours") or "").strip()
    hours = None
    if hours_raw:
        try:
            hours = float(hours_raw)
            if hours < 0:
                raise ValueError
        except ValueError:
            errors.append("session hours must be a number 0 or higher")
            hours = None
    code = (vals.get("code") or "").strip()
    if code:
        if code in seen_codes:
            errors.append(f"duplicate code {code} in file")
        seen_codes.add(code)
    data = {"code": code, "title": title, "type": typ, "date": date,
            "time": time_raw or None,
            "location": (vals.get("location") or "").strip(),
            "capacity": capacity, "deadline": deadline,
            "session_hours": hours,
            "notes": (vals.get("notes") or "").strip(),
            "season": (vals.get("season") or "").strip() or None}
    present = set()
    for header, col in (("title", "title"), ("type", "type"),
                        ("date", "date"), ("time", "time"),
                        ("location", "location"), ("capacity", "capacity"),
                        ("deadline", "deadline"),
                        ("session hours", "session_hours"),
                        ("notes", "notes"), ("season", "season")):
        if header in vals:
            present.add(col)
    action = "create"
    if code and q_one("SELECT id FROM events WHERE code=?", (code,)):
        action = "update"
    return data, errors, present, action


def _apply_event_row(data, present):
    existing = None
    if data["code"]:
        existing = q_one("SELECT * FROM events WHERE code=?", (data["code"],))
    if existing:
        sets, args = [], []
        for col in ("title", "type", "date", "time", "location",
                    "capacity", "deadline", "notes", "season"):
            if col in present:
                sets.append(f"{col}=?")
                args.append(data[col])
        if "session_hours" in present and data["session_hours"] is not None:
            sets.append("session_hours=?")
            args.append(data["session_hours"])
        if sets:
            execute(f"UPDATE events SET {', '.join(sets)} WHERE id=?",
                    (*args, existing["id"]))
        return "updated"
    hours = data["session_hours"]
    if hours is None:
        hours = _EVENT_HOUR_DEFAULTS.get(data["type"], 2)
    eid = execute(
        """INSERT INTO events (title, type, date, time, location, capacity,
           deadline, session_hours, notes, season, sample)
           VALUES (?,?,?,?,?,?,?,?,?,?,0)""",
        (data["title"], data["type"], data["date"], data["time"],
         data["location"], data["capacity"], data["deadline"], hours,
         data["notes"], data["season"]))
    execute("UPDATE events SET code=? WHERE id=?",
            (data["code"] or f"EVT-{200 + eid}", eid))
    return "created"


def _csv_preview(kind):
    """Shared preview step: parse + validate, write nothing."""
    f = request.files.get("file")
    if not f or not f.filename:
        return err("no file uploaded", 400)
    try:
        headers, rows = _csv_read(f)
    except ValueError as e:
        return err(str(e), 400)
    known = {"roster": {"code", "student", "first name", "last name",
                        "school", "grade", "subteam", "student email",
                        "student phone", "parent", "parent email",
                        "parent phone", "parent whatsapp",
                        "whatsapp updates", "discovery chats"},
             "events": {"code", "title", "type", "date", "time",
                        "location", "capacity", "deadline",
                        "session hours", "notes", "season"}}[kind]
    if not (set(headers) & known):
        return err("no recognized columns — is this the right file?"
                   " Export CSV gives you the template.", 400)
    if kind == "roster":
        from seed import SUBTEAM_BLURBS
        subteams = set(SUBTEAM_BLURBS)
    seen = set()
    out = []
    for line_no, vals in rows:
        if kind == "roster":
            data, errors, present, action = _validate_roster_row(
                vals, seen, subteams)
        else:
            data, errors, present, action = _validate_event_row(vals, seen)
        out.append({"line": line_no, "action": action, "errors": errors,
                    "data": data, "present": sorted(present)})
    summary = {"total": len(out),
               "valid": sum(1 for r in out if not r["errors"]),
               "create": sum(1 for r in out if not r["errors"] and r["action"] == "create"),
               "update": sum(1 for r in out if not r["errors"] and r["action"] == "update"),
               "error_rows": sum(1 for r in out if r["errors"])}
    return jsonify({"kind": kind, "headers": headers, "rows": out,
                    "summary": summary})


def _csv_confirm(kind):
    """Shared confirm step: re-validate the previewed rows and apply
    the valid ones, reporting per-row results."""
    b = request.get_json(force=True, silent=True) or {}
    incoming = b.get("rows") or []
    if not isinstance(incoming, list) or not incoming:
        return err("no rows to import", 400)
    if len(incoming) > _CSV_MAX_ROWS:
        return err("too many rows (2000 max)", 400)
    if kind == "roster":
        from seed import SUBTEAM_BLURBS
        subteams = set(SUBTEAM_BLURBS)
    seen = set()
    created = updated = 0
    skipped = []
    for i, row in enumerate(incoming):
        data = row.get("data") or {}
        present = set(row.get("present") or [])
        # Re-validate from the echoed data, not from preview's verdict:
        # rebuild a vals dict the validators understand.
        if kind == "roster":
            vals = {"code": data.get("code") or "",
                    "first name": data.get("first_name") or "",
                    "last name": data.get("last_name") or "",
                    "school": data.get("school") or "",
                    "grade": data.get("grade") or "",
                    "subteam": data.get("assigned_subteam") or "",
                    "student email": data.get("student_email") or "",
                    "student phone": data.get("student_phone") or "",
                    "parent": data.get("parent_name") or "",
                    "parent email": data.get("parent_email") or "",
                    "parent phone": data.get("parent_phone") or "",
                    "parent whatsapp": data.get("parent_whatsapp") or "",
                    "whatsapp updates": "yes" if data.get("whatsapp_opt_in") else "no",
                    "discovery chats": ", ".join(data.get("discovery_chats") or [])}
            norm, errors, _, _ = _validate_roster_row(vals, seen, subteams)
        else:
            vals = {"code": data.get("code") or "",
                    "title": data.get("title") or "",
                    "type": data.get("type") or "",
                    "date": data.get("date") or "",
                    "time": data.get("time") or "",
                    "location": data.get("location") or "",
                    "capacity": "" if data.get("capacity") is None else str(data["capacity"]),
                    "deadline": data.get("deadline") or "",
                    "session hours": "" if data.get("session_hours") is None else str(data["session_hours"]),
                    "notes": data.get("notes") or "",
                    "season": data.get("season") or ""}
            norm, errors, _, _ = _validate_event_row(vals, seen)
        if errors:
            skipped.append({"line": row.get("line", i + 2), "errors": errors})
            continue
        # Apply the normalized row, but only for columns the original
        # file actually contained.
        if kind == "roster":
            result = _apply_roster_row(norm, present)
        else:
            result = _apply_event_row(norm, present)
        if result == "created":
            created += 1
        else:
            updated += 1
    return jsonify({"created": created, "updated": updated, "skipped": skipped})


@app.route("/api/roster/import/preview", methods=["POST"])
@require_role("mentor", "admin")
def api_roster_import_preview():
    return _csv_preview("roster")


@app.route("/api/roster/import/confirm", methods=["POST"])
@require_role("mentor", "admin")
def api_roster_import_confirm():
    return _csv_confirm("roster")


@app.route("/api/events/import/preview", methods=["POST"])
@require_role("mentor", "admin")
def api_events_import_preview():
    return _csv_preview("events")


@app.route("/api/events/import/confirm", methods=["POST"])
@require_role("mentor", "admin")
def api_events_import_confirm():
    return _csv_confirm("events")


# ----------------------------------------------------------------------------
# Announcements: mentor-posted board on the Events page (everyone lands
# there). Logged-in users read; only mentors/admins post or delete.
# ----------------------------------------------------------------------------
@app.route("/api/announcements", methods=["GET", "POST"])
def api_announcements():
    if request.method == "GET":
        return jsonify(q_all("SELECT * FROM announcements"
                             " ORDER BY created_at DESC, id DESC"))
    denied = _mentor_denied()
    if denied:
        return denied
    b = request.get_json(force=True, silent=True) or {}
    if not (b.get("title") or "").strip():
        return err("title is required")
    u = current_user()
    aid = execute("INSERT INTO announcements (title, body, author)"
                  " VALUES (?,?,?)",
                  (b["title"].strip(), (b.get("body") or "").strip(),
                   u["name"] if u else ""))
    return jsonify(q_one("SELECT * FROM announcements WHERE id=?",
                         (aid,))), 201


@app.route("/api/announcements/<int:aid>", methods=["DELETE"])
@require_role("mentor", "admin")
def api_announcement_delete(aid):
    execute("DELETE FROM announcements WHERE id=?", (aid,))
    return jsonify({"deleted": aid})


# ----------------------------------------------------------------------------
# Events
# ----------------------------------------------------------------------------
@app.route("/api/events", methods=["GET", "POST"])
def api_events():
    if request.method == "POST":
        denied = _mentor_denied()
        if denied:
            return denied
    if request.method == "GET":
        # Seasons: current (NULL) by default, so old seasons stop
        # cluttering every list; archived groups history read-only.
        season = request.args.get("season", "current")
        if season == "archived":
            return jsonify(q_all("SELECT * FROM events"
                                 " WHERE season IS NOT NULL"
                                 " ORDER BY season, date, id"))
        if season == "all":
            return jsonify(q_all("SELECT * FROM events"
                                 " ORDER BY date, id"))
        return jsonify(q_all("SELECT * FROM events"
                             " WHERE season IS NULL ORDER BY date, id"))
    b = request.get_json(force=True)
    if not b.get("title"):
        return err("title is required")
    defaults = {"meeting": 2, "build": 4, "competition": 8, "outreach": 3,
                "club": 1}
    eid = execute(
        """INSERT INTO events (title, type, date, time, location, capacity,
           deadline, session_hours, notes, sample)
           VALUES (?,?,?,?,?,?,?,?,?,0)""",
        (b["title"], b.get("type", "meeting"), b.get("date"), b.get("time"),
         b.get("location"), b.get("capacity"), b.get("deadline"),
         b.get("session_hours", defaults.get(b.get("type", "meeting"), 2)),
         b.get("notes")))
    execute("UPDATE events SET code=? WHERE id=?", (f"EVT-{200 + eid}", eid))
    return jsonify(q_one("SELECT * FROM events WHERE id=?", (eid,))), 201


@app.route("/api/events/<int:eid>.ics")
def api_event_ics(eid):
    """Per-event calendar download (ICS). Timed events use the event
    time and session hours; events with a date but no parsable time
    become all-day events; dateless events cannot be calendared."""
    ev = q_one("SELECT * FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    if not ev["date"]:
        return err("event has no date", 400)
    try:
        d0 = datetime.datetime.strptime(ev["date"], "%Y-%m-%d")
    except ValueError:
        return err("event date is not YYYY-MM-DD", 400)

    def esc_ics(s):
        return (s or "").replace("\\", "\\\\").replace(";", "\\;") \
                        .replace(",", "\\,").replace("\n", "\\n")

    def fold(line):
        out = []
        while len(line) > 75:
            out.append(line[:75])
            line = " " + line[75:]
        out.append(line)
        return "\r\n".join(out)

    import re as _re
    mt = _re.match(r"^(\d{1,2}):(\d{2})\s*([APap][Mm])?$",
                   (ev["time"] or "").strip())
    if mt:
        hh, mm = int(mt.group(1)), int(mt.group(2))
        ap = (mt.group(3) or "").upper()
        if ap == "PM" and hh < 12:
            hh += 12
        if ap == "AM" and hh == 12:
            hh = 0
        try:
            dur = float(ev["session_hours"] or 2)
        except (ValueError, TypeError):
            dur = 2
        start_dt = d0.replace(hour=hh, minute=mm)
        end_dt = start_dt + datetime.timedelta(hours=dur)
        start = ("DTSTART:" + start_dt.strftime("%Y%m%dT%H%M%S"),
                 "DTEND:" + end_dt.strftime("%Y%m%dT%H%M%S"))
    else:
        start = (f"DTSTART;VALUE=DATE:{d0.strftime('%Y%m%d')}",
                 "DTEND;VALUE=DATE:"
                 + (d0 + datetime.timedelta(days=1)).strftime("%Y%m%d"))
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//FRC Team App//EN", "BEGIN:VEVENT",
             f"UID:event-{ev['id']}@frc-team-app",
             "DTSTAMP:" + datetime.datetime.now(
                 datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
             start[0], start[1],
             f"SUMMARY:{esc_ics(ev['title'])}"]
    if ev["location"]:
        lines.append(f"LOCATION:{esc_ics(ev['location'])}")
    if ev["notes"]:
        lines.append(f"DESCRIPTION:{esc_ics(ev['notes'])}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    body = "\r\n".join(fold(l) for l in lines) + "\r\n"
    return app.response_class(body, mimetype="text/calendar",
                              headers={"Content-Disposition":
                                       "attachment; filename="
                                       f"{ev['code'] or 'event'}.ics"})


@app.route("/api/events/archive-season", methods=["POST"])
@require_role("mentor", "admin")
def api_events_archive_season():
    """Close the current season: every current (unarchived) event gets
    the season label and leaves the main lists. History stays readable
    in the archive section, and unarchive-season brings it back."""
    b = request.get_json(force=True, silent=True) or {}
    season = (b.get("season") or "").strip()
    if not season:
        return err("season name is required")
    if len(season) > 40:
        return err("season name is too long (40 max)")
    with _lock:
        db = get_db()
        n = db.execute("UPDATE events SET season=? WHERE season IS NULL",
                       (season,)).rowcount
        db.commit()
    return jsonify({"archived": n, "season": season})


@app.route("/api/events/unarchive-season", methods=["POST"])
@require_role("mentor", "admin")
def api_events_unarchive_season():
    b = request.get_json(force=True, silent=True) or {}
    season = (b.get("season") or "").strip()
    if not season:
        return err("season name is required")
    with _lock:
        db = get_db()
        n = db.execute("UPDATE events SET season=NULL WHERE season=?",
                       (season,)).rowcount
        db.commit()
    return jsonify({"restored": n, "season": season})


@app.route("/api/events/<int:eid>", methods=["PATCH", "DELETE"])
@require_role("mentor", "admin")
def api_event(eid):
    if request.method == "DELETE":
        execute("DELETE FROM events WHERE id=?", (eid,))
        return jsonify({"deleted": eid})
    ev = q_one("SELECT * FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    sets, args = [], []
    if "title" in b:
        if not (b["title"] or "").strip():
            return err("title is required")
        sets.append("title=?")
        args.append(b["title"].strip())
    if "type" in b:
        if b["type"] not in ("meeting", "build", "competition",
                             "outreach", "club"):
            return err("unknown type")
        sets.append("type=?")
        args.append(b["type"])
    import re as _re
    for col in ("date", "deadline"):
        if col in b:
            raw = (b[col] or "").strip() or None
            if raw:
                try:
                    datetime.datetime.strptime(raw, "%Y-%m-%d")
                except ValueError:
                    return err(f"{col} must be YYYY-MM-DD")
            sets.append(f"{col}=?")
            args.append(raw)
    if "time" in b:
        raw = (b["time"] or "").strip() or None
        if raw and not _re.match(r"^\d{1,2}:\d{2}(\s*[APap][Mm])?$", raw):
            return err("time must look like 6:00 PM or 18:00")
        sets.append("time=?")
        args.append(raw)
    if "location" in b:
        sets.append("location=?")
        args.append((b["location"] or "").strip() or None)
    if "capacity" in b:
        raw = b["capacity"]
        if raw in ("", None):
            cap = None
        else:
            try:
                cap = int(raw)
                if cap < 0:
                    raise ValueError
            except (ValueError, TypeError):
                return err("capacity must be a whole number 0 or higher")
        sets.append("capacity=?")
        args.append(cap)
    if "session_hours" in b:
        # Blank keeps the old value (hours must never go NULL, or
        # check-in credit breaks); a number replaces it.
        raw = b["session_hours"]
        if raw not in ("", None):
            try:
                hours = float(raw)
                if hours < 0:
                    raise ValueError
            except (ValueError, TypeError):
                return err("session hours must be a number 0 or higher")
            sets.append("session_hours=?")
            args.append(hours)
    if "notes" in b:
        sets.append("notes=?")
        args.append((b["notes"] or "").strip() or None)
    if not sets:
        return err("nothing to update")
    execute(f"UPDATE events SET {', '.join(sets)} WHERE id=?",
            (*args, eid))
    return jsonify(q_one("SELECT * FROM events WHERE id=?", (eid,)))


def _occupancy_count(eid):
    """Spots taken: going + partial both occupy a place at the event."""
    r = q_one("SELECT COUNT(*) c FROM rsvps WHERE event_id=?"
              " AND status IN ('going','partial')", (eid,))
    return r["c"]


@app.route("/api/events/<int:eid>/checkin-qr")
@require_role("mentor", "admin")
def api_event_checkin_qr(eid):
    """Door QR: encodes a link that jumps a scanned phone straight to
    Tracking with this event selected. Phones must reach the server
    (same network) and be logged in; the login flow preserves the
    link and lands on Tracking after signing in."""
    ev = q_one("SELECT id, title FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    url = request.host_url + f"#checkin-{eid}"
    try:
        svg = _qr_svg_for_html(url)
    except Exception:
        return err("QR generation is unavailable on this server", 503)
    return jsonify({"url": url, "title": ev["title"], "qr_svg": svg})


@app.route("/api/events/<int:eid>/rsvps", methods=["GET", "POST"])
def api_rsvps(eid):
    ev = q_one("SELECT * FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    if request.method == "GET":
        rsvps = q_all("SELECT * FROM rsvps WHERE event_id=? ORDER BY created_at, id",
                      (eid,))
        return jsonify({
            "event": ev,
            "rsvps": rsvps,
            "headcounts": {
                "going": sum(1 for r in rsvps if r["status"] == "going"),
                "maybe": sum(1 for r in rsvps if r["status"] == "maybe"),
                "partial": sum(1 for r in rsvps if r["status"] == "partial"),
                "waitlisted": sum(1 for r in rsvps if r["status"] == "waitlisted"),
                "cant": sum(1 for r in rsvps if r["status"] == "cant"),
            },
        })
    b = request.get_json(force=True)
    if b.get("person_kind") not in ("student", "parent") or not b.get("person_name"):
        return err("person_kind (student|parent) and person_name required")
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] not in ("mentor", "admin"):
        student_id, parent_ids = _self_rsvp_scope(u)
        ok = (b.get("person_kind") == "student" and b.get("member_id") == student_id) \
            or (b.get("person_kind") == "parent" and b.get("member_id") in parent_ids)
        if not ok:
            return err("you can only RSVP for yourself"
                       " — mentors can RSVP for others", 403)
        # The scope check above only pins member_id + kind — it never
        # looked at the name. A parent linked to one child could file
        # a going RSVP under another parent's name, and that fake name
        # would then count as a going parent for driver eligibility
        # (going_parents is name-matched), ride status, and headcounts;
        # a student could likewise overwrite their own row's name with
        # someone else's. So the name itself must match: the roster
        # record for that member/kind, or the signer's own account
        # name (the second covers relationship-linked parents, whose
        # recorded parent_name may differ from their account name).
        # Anything else is spoofing and gets a 403, not a silent fix.
        m = q_one("SELECT first_name, last_name, parent_name FROM members"
                  " WHERE id=?", (b.get("member_id"),))
        if not m:
            return err("you can only RSVP for yourself"
                       " — mentors can RSVP for others", 403)
        if b.get("person_kind") == "student":
            canonical = f"{m['first_name']} {m['last_name']}".strip()
        else:
            canonical = (m.get("parent_name") or "").strip()
        allowed = {_norm_name(canonical)} if canonical else set()
        allowed.add(_norm_name(u["name"]))
        if _norm_name(b.get("person_name")) not in allowed:
            return err("that name doesn't match your roster record or"
                       " account — you can only RSVP as yourself", 403)
    # Club events are only for BASIS Independent Fremont students: the
    # member being RSVP'd must attend BIF. Mentors/admins keep their
    # override (e.g. to file while a member's school record is fixed).
    if ev["type"] == "club" and u["role"] not in ("mentor", "admin"):
        m = q_one("SELECT school FROM members WHERE id=?",
                  (b.get("member_id"),))
        if not m or "basisindependentfremont" not in _norm_name(m.get("school")):
            return err("Club events are only for BASIS Independent"
                       " Fremont students", 403)
    want = b.get("status", "going")
    # Deadline is enforced on the server, not just by hiding the buttons:
    # the UI rule (deadline < today, UTC) applies here too, and only
    # mentors/admins may RSVP past it (the override).
    if (ev["deadline"]
            and ev["deadline"] < datetime.datetime.utcnow().date().isoformat()
            and u["role"] not in ("mentor", "admin")):
        return err("RSVP deadline has passed — ask a mentor to RSVP for you",
                   403)
    status = want
    if want in ("going", "partial") and ev["capacity"] \
            and _occupancy_count(eid) >= ev["capacity"]:
        status = "waitlisted"
    with _lock:
        db = get_db()
        db.execute(
            """INSERT INTO rsvps (event_id, member_id, person_kind, person_name, status)
               VALUES (?,?,?,?,?)
               ON CONFLICT(event_id, member_id, person_kind)
               DO UPDATE SET person_name=excluded.person_name, status=excluded.status,
                             created_at=datetime('now')""",
            (eid, b.get("member_id"), b["person_kind"], b["person_name"], status))
        db.commit()
        r = db.execute(
            "SELECT * FROM rsvps WHERE event_id=? AND member_id "
            + ("IS NULL" if b.get("member_id") is None else "=?")
            + " AND person_kind=?",
            tuple([eid] + ([] if b.get("member_id") is None else [b["member_id"]])
                  + [b["person_kind"]])).fetchone()
    return jsonify(row(r)), 201


@app.route("/api/rsvps/<int:rid>", methods=["DELETE"])
def api_rsvp_delete(rid):
    r = q_one("SELECT * FROM rsvps WHERE id=?", (rid,))
    if not r:
        return err("rsvp not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] not in ("mentor", "admin"):
        student_id, parent_ids = _self_rsvp_scope(u)
        mine = (r["person_kind"] == "student" and r["member_id"] == student_id) \
            or (r["person_kind"] == "parent" and r["member_id"] in parent_ids)
        if not mine:
            return err("you can only remove your own RSVP", 403)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM rsvps WHERE id=?", (rid,))
        promoted = None
        if r["status"] in ("going", "partial"):
            nxt = db.execute(
                "SELECT * FROM rsvps WHERE event_id=? AND status='waitlisted'"
                " ORDER BY created_at, id LIMIT 1", (r["event_id"],)).fetchone()
            if nxt:
                db.execute("UPDATE rsvps SET status='going' WHERE id=?",
                           (nxt["id"],))
                promoted = dict(nxt)
        db.commit()
    return jsonify({"deleted": rid, "promoted": promoted})


# ----------------------------------------------------------------------------
# Tracking: check-ins, hours, tasks
# ----------------------------------------------------------------------------
@app.route("/api/checkins", methods=["POST"])
def api_checkin():
    b = request.get_json(force=True)
    for f in ("event_id", "member_id", "person_name"):
        if not b.get(f):
            return err(f"{f} is required")
    method = b.get("method", "mentor")
    if method not in ("self", "mentor"):
        return err("method must be self|mentor")
    verified = 1 if method == "mentor" else 0
    hours = float(b.get("hours", 0) or 0)
    with _lock:
        db = get_db()
        db.execute(
            """INSERT INTO checkins (event_id, member_id, person_kind, person_name,
               method, verified, hours)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(event_id, member_id, person_kind)
               DO UPDATE SET person_name=excluded.person_name, method=excluded.method,
                             verified=excluded.verified, hours=excluded.hours""",
            (b["event_id"], b["member_id"], b.get("person_kind", "student"),
             b["person_name"], method, verified, hours))
        db.commit()
    return jsonify({"ok": True, "verified": bool(verified)}), 201


@app.route("/api/checkins/<int:cid>", methods=["PATCH"])
@require_role("mentor", "admin")
def api_checkin_verify(cid):
    b = request.get_json(force=True)
    if "verified" not in b:
        return err("verified is required")
    execute("UPDATE checkins SET verified=? WHERE id=?",
            (1 if b["verified"] else 0, cid))
    return jsonify(q_one("SELECT * FROM checkins WHERE id=?", (cid,)))


@app.route("/api/events/<int:eid>/checkins")
def api_event_checkins(eid):
    return jsonify(q_all("SELECT * FROM checkins WHERE event_id=? ORDER BY id",
                         (eid,)))


@app.route("/api/hours.csv")
@require_role("mentor", "admin")
def api_hours_csv():
    """Per-student hours summary for award submissions and service-hour
    verification: one row per approved roster member, verified +
    unverified + total. Students with no check-ins still list, at 0."""
    import csv
    import io
    rows = q_all(
        """SELECT m.first_name, m.last_name, m.code, m.school,
                  COALESCE(SUM(CASE WHEN c.verified=1 THEN c.hours
                                    ELSE 0 END), 0) AS verified_hours,
                  COALESCE(SUM(CASE WHEN c.verified=0 THEN c.hours
                                    ELSE 0 END), 0) AS unverified_hours,
                  COUNT(c.id) AS checkins
           FROM members m LEFT JOIN checkins c ON c.member_id = m.id
           WHERE m.status='approved'
           GROUP BY m.id ORDER BY m.last_name, m.first_name""")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Student", "Code", "School", "Verified hours",
                "Unverified hours", "Total hours", "Check-ins"])
    for r in rows:
        v = r["verified_hours"] or 0
        u = r["unverified_hours"] or 0
        w.writerow([f"{r['first_name']} {r['last_name']}", r["code"],
                    r["school"], v, u, v + u, r["checkins"]])
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition":
                                       "attachment; filename=hours.csv"})


@app.route("/api/hours")
def api_hours():
    rows = q_all(
        """SELECT c.member_id, m.first_name, m.last_name,
                  SUM(CASE WHEN c.verified=1 THEN c.hours ELSE 0 END) AS verified_hours,
                  SUM(CASE WHEN c.verified=0 THEN c.hours ELSE 0 END) AS unverified_hours,
                  COUNT(*) AS checkins
           FROM checkins c JOIN members m ON m.id = c.member_id
           GROUP BY c.member_id ORDER BY verified_hours DESC""")
    for r in rows:
        r["breakdown"] = q_all(
            """SELECT c.event_id, e.title, e.date, c.hours, c.verified, c.method
               FROM checkins c JOIN events e ON e.id = c.event_id
               WHERE c.member_id=? ORDER BY e.date""", (r["member_id"],))
    return jsonify(rows)


def _task_out(r):
    """One task row -> dict with assignees as a list and archived as int.
    Legacy rows (assignee only) read as a one-person list."""
    d = row(r)
    a = d.get("assignees")
    if isinstance(a, str):
        try:
            a = json.loads(a)
        except ValueError:
            a = [a]
    if not isinstance(a, list):
        a = [d["assignee"]] if d.get("assignee") else []
    d["assignees"] = [x for x in a if x]
    d["assignee"] = d["assignees"][0] if d["assignees"] else None
    d["archived"] = int(d.get("archived") or 0)
    return d


def _task_assignees(b):
    """assignees list from a request body (or legacy single assignee)."""
    if isinstance(b.get("assignees"), list):
        return [str(x).strip() for x in b["assignees"] if str(x).strip()]
    if b.get("assignee"):
        return [str(b["assignee"]).strip()]
    return []


@app.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "POST":
        denied = _mentor_denied()
        if denied:
            return denied
    if request.method == "GET":
        return jsonify([_task_out(r) for r in
                        q_all("SELECT * FROM tasks ORDER BY id")])
    b = request.get_json(force=True)
    if not b.get("title"):
        return err("title is required")
    assignees = _task_assignees(b)
    tid = execute(
        "INSERT INTO tasks (title, subteam, assignee, assignees, due_date,"
        " notes, status, sample)"
        " VALUES (?,?,?,?,?,?,'todo',0)",
        (b["title"], b.get("subteam"), assignees[0] if assignees else None,
         json.dumps(assignees), b.get("due_date"), b.get("notes")))
    return jsonify(_task_out(q_one("SELECT * FROM tasks WHERE id=?", (tid,)))), 201


@app.route("/api/tasks/<int:tid>", methods=["PATCH", "DELETE"])
def api_task(tid):
    if request.method == "DELETE":
        denied = _mentor_denied()
        if denied:
            return denied
    if request.method == "DELETE":
        execute("DELETE FROM tasks WHERE id=?", (tid,))
        return jsonify({"deleted": tid})
    b = request.get_json(force=True)
    if "archived" in b and current_user()["role"] not in MENTOR_ROLES:
        return err("only mentors can archive or restore tasks", 403)
    sets, args = [], []
    for f in ("title", "subteam", "due_date", "notes"):
        if f in b:
            sets.append(f"{f}=?")
            args.append(b[f])
    if "assignees" in b or "assignee" in b:
        assignees = _task_assignees(b)
        sets.append("assignees=?")
        args.append(json.dumps(assignees))
        sets.append("assignee=?")
        args.append(assignees[0] if assignees else None)
    if "status" in b:
        if b["status"] not in ("todo", "doing", "done"):
            return err("bad status")
        sets.append("status=?")
        args.append(b["status"])
    if "archived" in b:
        sets.append("archived=?")
        args.append(1 if b["archived"] else 0)
    if sets:
        args.append(tid)
        execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id=?", args)
    return jsonify(_task_out(q_one("SELECT * FROM tasks WHERE id=?", (tid,))))


# ----------------------------------------------------------------------------
# Travel & logistics: carpools, tools, hotels
# ----------------------------------------------------------------------------
@app.route("/api/events/<int:eid>/travel")
def api_travel(eid):
    ev = q_one("SELECT * FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    carpools = q_all("SELECT * FROM carpools WHERE event_id=? ORDER BY id", (eid,))
    for c in carpools:
        claims = q_all("SELECT * FROM carpool_claims WHERE carpool_id=?"
                       " ORDER BY created_at, id", (c["id"],))
        c["claims"] = [x for x in claims if x["status"] == "claimed"]
        c["waitlist"] = [x for x in claims if x["status"] == "waitlisted"]
        c["seats_open"] = max(0, c["seats"] - len(c["claims"]))
    # Team vans going to this event: seats set, a designated parent
    # driver who RSVP'd going for this event, and that driver not
    # already driving a carpool for the same event. Driverless or
    # seatless vans stay tools-only and never appear here.
    going_parents = {r["person_name"] for r in q_all(
        "SELECT person_name FROM rsvps WHERE event_id=? AND"
        " person_kind='parent' AND status='going'", (eid,))}
    car_driver_uids = {c["driver_user_id"] for c in carpools
                       if c.get("driver_user_id")}
    event_vans = []
    for v in q_all("SELECT * FROM team_vans ORDER BY name"):
        if not v.get("seats") or not v.get("driver_user_id"):
            continue
        if v["driver_user_id"] in car_driver_uids:
            continue
        drv = q_one("SELECT name FROM users WHERE id=?",
                    (v["driver_user_id"],))
        if not drv or drv["name"] not in going_parents:
            continue
        claims = q_all("SELECT * FROM van_claims WHERE van_id=? AND"
                       " event_id=? ORDER BY created_at, id",
                       (v["id"], eid))
        v["driver_name"] = drv["name"]
        v["claims"] = [x for x in claims if x["status"] == "claimed"]
        v["waitlist"] = [x for x in claims if x["status"] == "waitlisted"]
        v["seats_open"] = max(0, v["seats"] - len(v["claims"]))
        event_vans.append(v)
    tools = q_all("SELECT * FROM tools WHERE event_id=? ORDER BY id", (eid,))
    hotel = q_one("SELECT * FROM hotels WHERE event_id=?", (eid,))
    if hotel:
        rooms = q_all("SELECT * FROM rooms WHERE hotel_id=? ORDER BY id",
                      (hotel["id"],))
        for rm in rooms:
            rm["occupants"] = q_all(
                """SELECT o.id, o.member_id, m.first_name, m.last_name
                   FROM room_occupants o JOIN members m ON m.id = o.member_id
                   WHERE o.room_id=? ORDER BY o.id""", (rm["id"],))
        hotel["rooms"] = rooms
        reqs = q_all(
            """SELECT r.*, m.first_name, m.last_name
               FROM rooming_requests r JOIN members m ON m.id = r.member_id
               WHERE r.hotel_id=? ORDER BY r.created_at, r.id""", (hotel["id"],))
        hotel["requests"] = reqs
        hotel["awaiting"] = sum(1 for x in reqs if x["status"] == "pending")
    attendees = q_all(
        "SELECT member_id, person_kind, person_name FROM rsvps"
        " WHERE event_id=? AND status IN ('going','partial')"
        " ORDER BY person_name", (eid,))
    parent_names = sorted({m["parent_name"] for m in q_all(
        "SELECT parent_name FROM members WHERE parent_name IS NOT NULL"
        " AND parent_name != ''") if m["parent_name"]})
    return jsonify({"event": ev, "carpools": carpools, "tools": tools,
                    "parent_names": parent_names, "event_vans": event_vans,
                    "hotel": hotel, "attendees": attendees})


def is_attending(eid, member_id, kind):
    """Attending = an RSVP with status 'going' or 'partial' for this event."""
    if not member_id:
        return False
    return q_one("SELECT id FROM rsvps WHERE event_id=? AND member_id=?"
                 " AND person_kind=? AND status IN ('going','partial')",
                 (eid, member_id, kind)) is not None


def _norm_name(s):
    """Compare names loosely: case- and whitespace-insensitive, so an
    account named 'zanderchen' matches the member 'Zander Chen'."""
    return "".join((s or "").strip().lower().split())


def _link_candidates(user_name, members):
    """[(member_id, kind)] a display name corresponds to: the member with
    that full name (kind 'self') and any member whose parent_name matches
    (kind 'parent'). Name matching is only used to CREATE links — every
    permission check below reads the link table, never names."""
    n = _norm_name(user_name)
    links = []
    for m in members:
        if n and n == _norm_name((m["first_name"] or "") + " "
                                 + (m["last_name"] or "")):
            links.append((m["id"], "self"))
        if m["parent_name"] and n == _norm_name(m["parent_name"]):
            links.append((m["id"], "parent"))
    return links


def _auto_link_user(uid):
    """Link a (new) account to roster records by name. Idempotent."""
    u = q_one("SELECT id, name FROM users WHERE id=?", (uid,))
    if not u:
        return
    for mid, kind in _link_candidates(
            u["name"], q_all(
                "SELECT id, first_name, last_name, parent_name FROM members")):
        execute("INSERT OR IGNORE INTO user_members"
                " (user_id, member_id, kind) VALUES (?,?,?)",
                (uid, mid, kind))


def _fill_parent_contact(mid):
    """Fill a member's blank parent email/phone from a parent already
    in the pool: a parent account with the same name first, else an
    approved member's parent entry with the same name. Blank fields
    only — never overwriting what the sign-up itself provided."""
    m = q_one("SELECT parent_name, parent_email, parent_phone FROM members"
              " WHERE id=?", (mid,))
    if not m or not m["parent_name"]:
        return
    if m["parent_email"] and m["parent_phone"]:
        return
    want = _norm_name(m["parent_name"])
    src_email, src_phone = None, None
    for u in q_all("SELECT name, email, phone FROM users"
                   " WHERE role='parent'"):
        if _norm_name(u["name"]) == want:
            src_email, src_phone = u["email"], u["phone"]
            break
    if src_email is None and src_phone is None:
        for r in q_all("SELECT parent_name, parent_email, parent_phone"
                       " FROM members WHERE status='approved'"
                       " AND parent_name IS NOT NULL"):
            if _norm_name(r["parent_name"]) == want:
                src_email, src_phone = r["parent_email"], r["parent_phone"]
                break
    email = m["parent_email"] or src_email
    phone = m["parent_phone"] or src_phone
    if email != m["parent_email"] or phone != m["parent_phone"]:
        execute("UPDATE members SET parent_email=?, parent_phone=?"
                " WHERE id=?", (email, phone, mid))


def _auto_link_member(mid):
    """Link all existing accounts to a (newly approved) member by name."""
    m = q_one("SELECT id, first_name, last_name, parent_name FROM members"
              " WHERE id=?", (mid,))
    if not m:
        return
    for u in q_all("SELECT id, name FROM users"):
        for m2, kind in _link_candidates(u["name"], [m]):
            execute("INSERT OR IGNORE INTO user_members"
                    " (user_id, member_id, kind) VALUES (?,?,?)",
                    (u["id"], mid, kind))


def _create_temp_account(name, first, last, email, phone, role, temp_hash,
                         member_id, kind, whatsapp=None):
    """Create a team account from a sign-up temporary password. The
    account must change its password at first login, and the temp
    password is recorded in history so it can never be reused. Returns
    the new user id, or None if the email is already taken (the caller
    links that account instead — an existing password is never
    overwritten from a sign-up)."""
    try:
        uid = execute("INSERT INTO users (name, first_name, last_name,"
                      " email, phone, whatsapp, role, password_hash,"
                      " must_change_password) VALUES (?,?,?,?,?,?,?,?,1)",
                      (name, first, last, email, phone, whatsapp, role,
                       temp_hash))
    except sqlite3.IntegrityError:
        return None
    _record_password(uid, temp_hash)
    execute("INSERT OR IGNORE INTO user_members"
            " (user_id, member_id, kind) VALUES (?,?,?)",
            (uid, member_id, kind))
    return uid


def _auto_create_account_for_member(mid):
    """On roster approval, create the signer's team account from the
    temporary password stored at sign-up (if any). The signer's side is
    inferred from which contact email the application carries: a parent
    email means a parent account, otherwise a student account (the new
    sign-up flow sends exactly one side). Returns the user id created
    or linked, or None when there is nothing to create. The temp hash
    is cleared once used, so re-approving never creates a second
    account."""
    m = q_one("SELECT * FROM members WHERE id=?", (mid,))
    if not m or not m.get("temp_password_hash"):
        return None
    temp_hash = m["temp_password_hash"]
    parent_email = (m.get("parent_email") or "").strip()
    student_email = (m.get("student_email") or "").strip()
    # Signer side: a student signer's own email wins. A student
    # application also carries an enriched parent_email (from the
    # picked parent), so checking the parent side first would mistake
    # it for a parent-signed application and link the parent's account
    # instead of creating the student's. Parent-signed applications
    # never carry a student_email, so this order is deterministic.
    if student_email:
        email, kind = student_email.lower(), "student"
        name = f"{m['first_name']} {m['last_name']}"
        first, last, phone = m["first_name"], m["last_name"], \
            m.get("student_phone")
    elif parent_email:
        email, kind = parent_email.lower(), "parent"
        name = m.get("parent_name") or f"{m['first_name']} {m['last_name']}"
        parts = (m.get("parent_name") or "").split(None, 1)
        first = parts[0] if parts else m["first_name"]
        last = parts[1] if len(parts) > 1 else m["last_name"]
        phone = m.get("parent_phone")
    else:
        return None
    # The account role is parent/student, but the LINK kind is
    # parent/self — passing 'student' as a link kind would trip the
    # user_members CHECK and INSERT OR IGNORE would silently drop it.
    link_kind = "self" if kind == "student" else "parent"
    # A parent signer's WhatsApp rides along to the new account, and
    # fills a blank one on an existing account (never overwriting).
    wa = m.get("parent_whatsapp") if kind == "parent" else None
    existing = q_one("SELECT id FROM users WHERE lower(email)=?", (email,))
    if existing:
        uid = existing["id"]
        execute("INSERT OR IGNORE INTO user_members"
                " (user_id, member_id, kind) VALUES (?,?,?)",
                (uid, mid, link_kind))
        if wa:
            execute("UPDATE users SET whatsapp=? WHERE id=?"
                    " AND (whatsapp IS NULL OR whatsapp='')",
                    (wa, uid))
    else:
        uid = _create_temp_account(name, first, last, email, phone, kind,
                                   temp_hash, mid, link_kind, wa)
        if uid is None:
            # Lost a race with another approval: link the account that won.
            existing = q_one("SELECT id FROM users WHERE lower(email)=?",
                             (email,))
            if existing:
                uid = existing["id"]
                execute("INSERT OR IGNORE INTO user_members"
                        " (user_id, member_id, kind) VALUES (?,?,?)",
                        (uid, mid, link_kind))
                if wa:
                    execute("UPDATE users SET whatsapp=? WHERE id=?"
                            " AND (whatsapp IS NULL OR whatsapp='')",
                            (wa, uid))
    execute("UPDATE members SET temp_password_hash=NULL WHERE id=?", (mid,))
    return uid


def _self_rsvp_scope(u):
    """What the signed-in account may RSVP as: (student member id or None,
    member ids the account is a parent of). Read from the user_members
    link table — never from name matching, so renames and duplicate names
    cannot move or merge someone's permissions."""
    if not u:
        return None, set()
    rows = q_all("SELECT member_id, kind FROM user_members WHERE user_id=?",
                 (u["id"],))
    student_id = next((r["member_id"] for r in rows if r["kind"] == "self"),
                      None)
    parent_ids = {r["member_id"] for r in rows if r["kind"] == "parent"}
    return student_id, parent_ids


def _own_member_id(u):
    """The member record for the signed-in account, via its 'self' link."""
    return _self_rsvp_scope(u)[0] if u else None


def _event_driver_names(db, eid):
    """Normalized names of everyone driving for this event: carpool
    drivers, plus designated drivers of vans with passenger seats
    (a seatless van is tools-only, so its designee is not driving
    riders). Takes a raw db connection — callers inside _lock must
    not go through q_* (which re-locks)."""
    names = set()
    for r in db.execute("SELECT driver_name FROM carpools WHERE event_id=?",
                        (eid,)):
        if r["driver_name"]:
            names.add(_norm_name(r["driver_name"]))
    for r in db.execute(
            "SELECT u.name FROM team_vans v JOIN users u"
            " ON u.id = v.driver_user_id WHERE v.seats IS NOT NULL"
            " AND v.driver_user_id IS NOT NULL"):
        if r["name"]:
            names.add(_norm_name(r["name"]))
    return names


def _is_event_driver(db, eid, person_kind, person_name):
    """True if this person is driving for the event. Only parents
    drive, so a student name never matches, even if it coincides."""
    if person_kind != "parent" or not person_name:
        return False
    return _norm_name(person_name) in _event_driver_names(db, eid)


def _claim_matches(row, member_id, person_kind, person_name):
    if row["person_kind"] != person_kind:
        return False
    if (member_id and row["member_id"]
            and row["member_id"] == member_id):
        return True
    return bool(person_name and row["person_name"]
                and _norm_name(row["person_name"]) == _norm_name(person_name))


def _has_claimed_seat(db, eid, member_id, person_kind, person_name):
    """True if this person already holds a CLAIMED seat on any vehicle
    for the event — any carpool or any van. Waitlisted rows don't
    count: a waitlisted person has no seat yet and may still grab an
    open seat elsewhere."""
    for r in db.execute(
            "SELECT cc.member_id, cc.person_kind, cc.person_name"
            " FROM carpool_claims cc JOIN carpools c ON c.id = cc.carpool_id"
            " WHERE c.event_id=? AND cc.status='claimed'", (eid,)):
        if _claim_matches(r, member_id, person_kind, person_name):
            return True
    for r in db.execute(
            "SELECT member_id, person_kind, person_name FROM van_claims"
            " WHERE event_id=? AND status='claimed'", (eid,)):
        if _claim_matches(r, member_id, person_kind, person_name):
            return True
    return False


@app.route("/api/carpools", methods=["POST"])
def api_carpool_create():
    # Students claim seats; only parents/mentors/admins may define rides.
    me = current_user()
    if me["role"] == "student":
        return err("parents, mentors and admins only", 403)
    b = request.get_json(force=True)
    if not b.get("event_id"):
        return err("event_id required")
    try:
        seats = int(b.get("seats") or 0)
    except (TypeError, ValueError):
        return err("seats must be a number")
    if seats < 1:
        return err("seats required")
    # Driver resolution — the driver is always an account, never free
    # text, so the car stays editable by its owner:
    # - a parent posts as themselves: the driver is the session user
    #   (grayed out and auto-filled in the form); any driver_name in
    #   the request is ignored, so nobody can post as someone else.
    # - a mentor/admin picks a parent account from the free pool.
    if me["role"] == "parent":
        driver_uid, driver_name = me["id"], me["name"]
    else:
        drv = q_one("SELECT id, name, role FROM users WHERE id=?",
                    (b.get("driver_user_id"),)) if b.get("driver_user_id") else None
        if not drv or drv["role"] != "parent":
            return err("pick a parent account as the driver")
        driver_uid, driver_name = drv["id"], drv["name"]
    # A driver must be attending themselves (RSVP 'going'). The rule
    # used to check the typed driver name; now it checks the resolved
    # account's name — same discipline, applied to the driver.
    going_parents = {r["person_name"] for r in q_all(
        "SELECT person_name FROM rsvps WHERE event_id=? AND"
        " person_kind='parent' AND status='going'", (b["event_id"],))}
    if driver_name not in going_parents:
        return err("the driver must RSVP as attending for this event first")
    # One vehicle per driver per event: a parent already driving a
    # carpool can't post a second one, and a parent driving a team
    # van with seats can't also drive a carpool — the van would stop
    # being eligible for the event the moment the carpool appeared.
    # (The going check above already ran, so a seated van driver here
    # is an event-eligible van driver.)
    if q_one("SELECT id FROM carpools WHERE event_id=? AND"
             " driver_user_id=?", (b["event_id"], driver_uid)):
        return err("that parent is already driving a carpool for"
                   " this event")
    if q_one("SELECT id FROM team_vans WHERE driver_user_id=? AND"
             " seats IS NOT NULL", (driver_uid,)):
        return err("that parent is already driving a team van with"
                   " seats for this event")
    veh_in = b.get("vehicle") or {}
    vehicle = {k: str(veh_in.get(k) or "").strip()
               for k in ("plate", "color", "model", "make")
               if str(veh_in.get(k) or "").strip()}
    cid = execute(
        """INSERT INTO carpools (event_id, driver_name, driver_user_id,
           seats, depart_from, depart_time, return_info, notes, vehicle,
           sample)
           VALUES (?,?,?,?,?,?,?,?,?,0)""",
        (b["event_id"], driver_name, driver_uid, seats, b.get("depart_from"),
         b.get("depart_time"), b.get("return_info"), b.get("notes"),
         json.dumps(vehicle) if vehicle else None))
    return jsonify(q_one("SELECT * FROM carpools WHERE id=?", (cid,))), 201


@app.route("/api/carpools/<int:cid>", methods=["PATCH"])
def api_carpool_patch(cid):
    c = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    if not c:
        return err("carpool not found", 404)
    me = current_user()
    # Owner (the driver account) or a mentor/admin may edit. Old rows
    # with no driver account are mentor-only.
    if me["role"] not in MENTOR_ROLES and c.get("driver_user_id") != me["id"]:
        return err("only the driver or a mentor can edit this car", 403)
    b = request.get_json(force=True)
    sets, args = [], []
    if "seats" in b:
        try:
            seats = int(b["seats"])
        except (TypeError, ValueError):
            return err("seats must be a number")
        if seats < 1:
            return err("seats required")
        claimed = q_one("SELECT COUNT(*) n FROM carpool_claims"
                        " WHERE carpool_id=? AND status='claimed'",
                        (cid,))["n"]
        if seats < claimed:
            return err("seats can't go below the riders already claimed")
        sets.append("seats=?")
        args.append(seats)
    for col in ("depart_from", "depart_time", "return_info", "notes"):
        if col in b:
            sets.append(f"{col}=?")
            args.append(b[col])
    if "vehicle" in b:
        veh_in = b["vehicle"] or {}
        vehicle = {k: str(veh_in.get(k) or "").strip()
                   for k in ("plate", "color", "model", "make")
                   if str(veh_in.get(k) or "").strip()}
        sets.append("vehicle=?")
        args.append(json.dumps(vehicle) if vehicle else None)
    # Driver reassignment is mentor-only; a parent editing their own
    # car keeps themselves as driver (any driver field sent is ignored).
    if me["role"] in MENTOR_ROLES and b.get("driver_user_id"):
        drv = q_one("SELECT id, name, role FROM users WHERE id=?",
                    (b["driver_user_id"],))
        if not drv or drv["role"] != "parent":
            return err("pick a parent account as the driver")
        going_parents = {r["person_name"] for r in q_all(
            "SELECT person_name FROM rsvps WHERE event_id=? AND"
            " person_kind='parent' AND status='going'", (c["event_id"],))}
        if drv["name"] not in going_parents:
            return err("the driver must RSVP as attending for this event first")
        if drv["id"] != c.get("driver_user_id"):
            if q_one("SELECT id FROM carpools WHERE event_id=? AND"
                     " driver_user_id=? AND id!=?",
                     (c["event_id"], drv["id"], cid)):
                return err("that parent is already driving a carpool"
                           " for this event")
            if q_one("SELECT id FROM team_vans WHERE driver_user_id=?"
                     " AND seats IS NOT NULL", (drv["id"],)):
                return err("that parent is already driving a team van"
                           " with seats for this event")
        sets.append("driver_user_id=?")
        args.append(drv["id"])
        sets.append("driver_name=?")
        args.append(drv["name"])
    if not sets:
        return err("nothing to update")
    execute(f"UPDATE carpools SET {', '.join(sets)} WHERE id=?",
            (*args, cid))
    return jsonify(q_one("SELECT * FROM carpools WHERE id=?", (cid,)))


@app.route("/api/carpools/<int:cid>", methods=["DELETE"])
def api_carpool_delete(cid):
    c = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    if not c:
        return err("carpool not found", 404)
    me = current_user()
    if me["role"] not in MENTOR_ROLES and c.get("driver_user_id") != me["id"]:
        return err("only the driver or a mentor can remove this car", 403)
    with _lock:
        db = get_db()
        n = db.execute("DELETE FROM carpool_claims WHERE carpool_id=?",
                       (cid,)).rowcount
        # Tools riding in this car go back to the pool, not to a ghost.
        tu = db.execute("UPDATE tools SET vehicle_type=NULL, vehicle_id=NULL,"
                        " claimed_at=NULL WHERE vehicle_type='carpool'"
                        " AND vehicle_id=?", (cid,)).rowcount
        db.execute("DELETE FROM carpools WHERE id=?", (cid,))
        db.commit()
    return jsonify({"deleted": cid, "claims_removed": n,
                    "tools_unassigned": tu})


@app.route("/api/carpools/<int:cid>/claims", methods=["POST"])
def api_carpool_claim(cid):
    c = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    if not c:
        return err("carpool not found", 404)
    b = request.get_json(force=True)
    if not b.get("person_name"):
        return err("person_name required")
    if not is_attending(c["event_id"], b.get("member_id"), b.get("person_kind")):
        return err("only people attending this event can claim a seat"
                   " — RSVP as going first")
    with _lock:
        db = get_db()
        # One row per person per carpool: a second claim used to land in
        # the waitlist while the person already held a seat (or vice versa).
        if b.get("member_id"):
            dup = db.execute(
                "SELECT id FROM carpool_claims WHERE carpool_id=? AND"
                " member_id=? AND person_kind=?",
                (cid, b["member_id"], b.get("person_kind"))).fetchone()
        else:
            dup = db.execute(
                "SELECT id FROM carpool_claims WHERE carpool_id=? AND"
                " member_id IS NULL AND person_name=? AND person_kind=?",
                (cid, b["person_name"], b.get("person_kind"))).fetchone()
        if dup:
            return err("already on this ride — claimed or waitlisted", 409)
        # A driver can't also be a rider: not in their own car, and
        # not in anyone else's — they're already driving for the event.
        if _is_event_driver(db, c["event_id"], b.get("person_kind"),
                            b["person_name"]):
            return err("drivers can't claim a seat — they're driving"
                       " for this event", 403)
        # One seat per person per event, across every vehicle: a seat
        # already claimed on another carpool or a van blocks this one.
        if _has_claimed_seat(db, c["event_id"], b.get("member_id"),
                             b.get("person_kind"), b["person_name"]):
            return err("already has a seat for this event — on another"
                       " car or van", 409)
        taken = db.execute(
            "SELECT COUNT(*) n FROM carpool_claims"
            " WHERE carpool_id=? AND status='claimed'", (cid,)).fetchone()["n"]
        status = "claimed" if taken < c["seats"] else "waitlisted"
        cur = db.execute(
            "INSERT INTO carpool_claims (carpool_id, member_id, person_kind,"
            " person_name, status) VALUES (?,?,?,?,?)",
            (cid, b.get("member_id"), b.get("person_kind"), b["person_name"],
             status))
        db.commit()
        clid = cur.lastrowid
    return jsonify(q_one("SELECT * FROM carpool_claims WHERE id=?", (clid,))), 201


@app.route("/api/carpool_claims/<int:clid>", methods=["DELETE"])
def api_carpool_claim_delete(clid):
    cl = q_one("SELECT * FROM carpool_claims WHERE id=?", (clid,))
    if not cl:
        return err("claim not found", 404)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM carpool_claims WHERE id=?", (clid,))
        promoted = None
        if cl["status"] == "claimed":
            claimed_ids = {(r["member_id"], r["person_kind"]) for r in db.execute(
                "SELECT member_id, person_kind FROM carpool_claims"
                " WHERE carpool_id=? AND status='claimed'",
                (cl["carpool_id"],))}
            claimed_names = {(r["person_name"], r["person_kind"]) for r in db.execute(
                "SELECT person_name, person_kind FROM carpool_claims"
                " WHERE carpool_id=? AND status='claimed'",
                (cl["carpool_id"],))}
            ev_row = db.execute("SELECT event_id FROM carpools WHERE id=?",
                                (cl["carpool_id"],)).fetchone()
            eid = ev_row["event_id"] if ev_row else None
            for nxt in db.execute(
                    "SELECT * FROM carpool_claims WHERE carpool_id=? AND"
                    " status='waitlisted' ORDER BY created_at, id",
                    (cl["carpool_id"],)):
                if ((nxt["member_id"], nxt["person_kind"]) in claimed_ids
                        or (nxt["person_name"], nxt["person_kind"]) in claimed_names):
                    continue  # stale duplicate: never promote into a second seat
                if eid is not None and (
                        _is_event_driver(db, eid, nxt["person_kind"],
                                         nxt["person_name"])
                        or _has_claimed_seat(db, eid, nxt["member_id"],
                                             nxt["person_kind"],
                                             nxt["person_name"])):
                    continue  # driving, or already seated on another vehicle
                db.execute("UPDATE carpool_claims SET status='claimed' WHERE id=?",
                           (nxt["id"],))
                promoted = dict(nxt)
                break
        db.commit()
    return jsonify({"deleted": clid, "promoted": promoted})


@app.route("/api/tools", methods=["POST"])
@require_role("mentor", "admin")
def api_tool_create():
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("name"):
        return err("event_id and name required")
    tid = execute(
        "INSERT INTO tools (event_id, name, qty, notes, sample)"
        " VALUES (?,?,?,?,0)",
        (b["event_id"], b["name"], int(b.get("qty") or 1), b.get("notes")))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,))), 201


@app.route("/api/tools/<int:tid>", methods=["PATCH"])
@require_role("mentor", "admin")
def api_tool_patch(tid):
    t = q_one("SELECT * FROM tools WHERE id=?", (tid,))
    if not t:
        return err("tool not found", 404)
    b = request.get_json(force=True)
    sets, args = [], []
    if "name" in b:
        if not (b["name"] or "").strip():
            return err("name is required")
        sets.append("name=?")
        args.append(b["name"].strip())
    if "qty" in b:
        try:
            qty = int(b["qty"])
        except (TypeError, ValueError):
            return err("qty must be a number")
        if qty < 1:
            return err("qty must be 1 or more")
        sets.append("qty=?")
        args.append(qty)
    if "notes" in b:
        sets.append("notes=?")
        args.append(b["notes"])
    if not sets:
        return err("nothing to update")
    execute(f"UPDATE tools SET {', '.join(sets)} WHERE id=?",
            (*args, tid))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,)))


@app.route("/api/tools/<int:tid>", methods=["DELETE"])
@require_role("mentor", "admin")
def api_tool_delete(tid):
    if not q_one("SELECT * FROM tools WHERE id=?", (tid,)):
        return err("tool not found", 404)
    execute("DELETE FROM tools WHERE id=?", (tid,))
    return jsonify({"deleted": tid})


def _owns_vehicle(me, vehicle_type, vehicle_id):
    """True if this parent drives the vehicle: their own carpool, or a
    team van they are designated to drive. Mentors are handled by the
    caller, not here."""
    if vehicle_type == "carpool":
        c = q_one("SELECT driver_user_id FROM carpools WHERE id=?",
                  (vehicle_id,))
        return c is not None and c["driver_user_id"] == me["id"]
    if vehicle_type == "van":
        v = q_one("SELECT driver_user_id FROM team_vans WHERE id=?",
                  (vehicle_id,))
        return v is not None and v["driver_user_id"] == me["id"]
    return False


@app.route("/api/tools/<int:tid>/assign", methods=["POST"])
def api_tool_assign(tid):
    """Assign a tool to a vehicle going to the event: an event carpool
    or a team van, by id — never by driver name. Mentors may assign
    any vehicle; a parent may only load a vehicle they drive, and only
    a mentor may move a tool off someone else's vehicle. Students
    cannot assign."""
    t = q_one("SELECT * FROM tools WHERE id=?", (tid,))
    if not t:
        return err("tool not found", 404)
    me = current_user()
    if me["role"] == "student":
        return err("students can't assign tools", 403)
    b = request.get_json(force=True)
    vt, vid = b.get("vehicle_type"), b.get("vehicle_id")
    if vt == "carpool":
        veh = q_one("SELECT * FROM carpools WHERE id=?", (vid,))
        if not veh or veh["event_id"] != t["event_id"]:
            return err("that carpool is not going to this event")
    elif vt == "van":
        # Vans are team equipment: any van may haul for any event, at
        # mentor discretion. (Passenger rides are stricter — a van
        # takes riders only with a designated, RSVP'd driver.)
        veh = q_one("SELECT * FROM team_vans WHERE id=?", (vid,))
        if not veh:
            return err("team van not found")
    else:
        return err("vehicle_type must be carpool or van")
    if me["role"] not in MENTOR_ROLES:
        if t.get("vehicle_type") and not _owns_vehicle(
                me, t["vehicle_type"], t["vehicle_id"]):
            return err("only a mentor can move a tool off another"
                       " vehicle", 403)
        if not _owns_vehicle(me, vt, vid):
            return err("parents can only load a vehicle they drive", 403)
    execute("UPDATE tools SET vehicle_type=?, vehicle_id=?,"
            " claimed_at=datetime('now') WHERE id=?", (vt, vid, tid))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,)))


@app.route("/api/tools/<int:tid>/release", methods=["POST"])
def api_tool_release(tid):
    """Send a tool back to the pool. Mentors may release any tool; a
    parent only one on a vehicle they drive. Releasing an unassigned
    tool is a no-op success."""
    t = q_one("SELECT * FROM tools WHERE id=?", (tid,))
    if not t:
        return err("tool not found", 404)
    me = current_user()
    if me["role"] == "student":
        return err("students can't release tools", 403)
    if (t.get("vehicle_type") and me["role"] not in MENTOR_ROLES
            and not _owns_vehicle(me, t["vehicle_type"], t["vehicle_id"])):
        return err("only a mentor or the vehicle's driver can release"
                   " this tool", 403)
    execute("UPDATE tools SET vehicle_type=NULL, vehicle_id=NULL,"
            " claimed_at=NULL WHERE id=?", (tid,))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,)))


@app.route("/api/events/<int:eid>/tools.csv")
@require_role("mentor", "admin")
def api_tools_csv(eid):
    """Tools export: the same columns the tools import accepts, so a
    pool round-trips through a spreadsheet. Vehicle is the display
    name (carpool driver, or 'Team van X'), blank when unassigned."""
    if not q_one("SELECT * FROM events WHERE id=?", (eid,)):
        return err("event not found", 404)
    import csv
    import io
    tools = q_all("SELECT * FROM tools WHERE event_id=? ORDER BY id",
                  (eid,))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Qty", "Notes", "Vehicle"])
    for x in tools:
        veh = ""
        if x.get("vehicle_type") == "carpool":
            c = q_one("SELECT driver_name FROM carpools WHERE id=?",
                      (x["vehicle_id"],))
            veh = c["driver_name"] if c else ""
        elif x.get("vehicle_type") == "van":
            v = q_one("SELECT name FROM team_vans WHERE id=?",
                      (x["vehicle_id"],))
            veh = f"Team van {v['name']}" if v else ""
        w.writerow([x["name"], x["qty"], x["notes"] or "", veh])
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition":
                                       f"attachment; filename=tools-{eid}.csv"})


@app.route("/api/events/<int:eid>/tools/import", methods=["POST"])
@require_role("mentor", "admin")
def api_tools_import(eid):
    """Tools import: upsert by name (case-insensitive), never deletes.
    A vehicle name that matches an event carpool driver or a van
    assigns the row; an unmatched vehicle leaves the row unassigned
    and is reported. Only columns present in the file overwrite on
    update, so an export without a Notes column keeps existing notes.
    Single-step (unlike roster/events preview-confirm) because nothing
    here deletes — the summary is the confirmation record."""
    if not q_one("SELECT * FROM events WHERE id=?", (eid,)):
        return err("event not found", 404)
    f = request.files.get("file")
    if not f or not f.filename:
        return err("no file uploaded", 400)
    try:
        headers, rows = _csv_read(f)
    except ValueError as e:
        return err(str(e), 400)
    known = {"name", "qty", "quantity", "amount", "notes", "vehicle"}
    if not (set(headers) & known):
        return err("no recognized columns — is this the right file?"
                   " Export CSV gives you the template.", 400)
    car_by_name = {_norm_name(c["driver_name"]): c["id"] for c in q_all(
        "SELECT id, driver_name FROM carpools WHERE event_id=?", (eid,))}
    van_by_name = {_norm_name(v["name"]): v["id"] for v in q_all(
        "SELECT id, name FROM team_vans")}
    existing = {_norm_name(r["name"]): r for r in q_all(
        "SELECT * FROM tools WHERE event_id=?", (eid,))}
    added = updated = 0
    skipped = []
    unmatched_vehicles = []
    for line, row in rows:
        name = (row.get("name") or "").strip()
        if not name:
            skipped.append(f"line {line}: no name")
            continue
        qty = None
        if "qty" in headers or "quantity" in headers or "amount" in headers:
            raw = (row.get("qty") or row.get("quantity")
                   or row.get("amount") or "").strip()
            if raw:
                try:
                    qty = int(raw)
                except ValueError:
                    skipped.append(f"line {line} ({name}): bad qty")
                    continue
                if qty < 1:
                    skipped.append(f"line {line} ({name}): qty must be 1+")
                    continue
        vt = vid = None
        veh_raw = (row.get("vehicle") or "").strip() if "vehicle" in headers else ""
        if veh_raw:
            vname = veh_raw
            if vname.lower().startswith("team van "):
                vname = vname[len("team van "):].strip()
            if _norm_name(vname) in car_by_name:
                vt, vid = "carpool", car_by_name[_norm_name(vname)]
            elif _norm_name(vname) in van_by_name:
                vt, vid = "van", van_by_name[_norm_name(vname)]
            else:
                unmatched_vehicles.append(name)
        key = _norm_name(name)
        if key in existing:
            sets, args = [], []
            if qty is not None:
                sets.append("qty=?")
                args.append(qty)
            if "notes" in headers:
                sets.append("notes=?")
                args.append((row.get("notes") or "").strip())
            if vt:
                sets.append("vehicle_type=?")
                args.append(vt)
                sets.append("vehicle_id=?")
                args.append(vid)
                sets.append("claimed_at=datetime('now')")
            if sets:
                execute(f"UPDATE tools SET {', '.join(sets)} WHERE id=?",
                        (*args, existing[key]["id"]))
            updated += 1
        else:
            nid = execute(
                "INSERT INTO tools (event_id, name, qty, notes,"
                " vehicle_type, vehicle_id, sample) VALUES (?,?,?,?,?,?,0)",
                (eid, name, qty if qty is not None else 1,
                 (row.get("notes") or "").strip() if "notes" in headers else "",
                 vt, vid))
            existing[key] = {"id": nid}
            added += 1
    return jsonify({"added": added, "updated": updated,
                    "skipped": skipped,
                    "vehicles_unmatched": unmatched_vehicles})


@app.route("/api/team-vans", methods=["GET", "POST"])
def api_team_vans():
    if request.method == "GET":
        return jsonify(q_all("SELECT * FROM team_vans ORDER BY name"))
    denied = _mentor_denied()
    if denied:
        return denied
    b = request.get_json(force=True, silent=True) or {}
    if not (b.get("name") or "").strip():
        return err("name is required")
    driver_uid = None
    if b.get("driver_user_id"):
        drv = q_one("SELECT id, role FROM users WHERE id=?",
                    (b["driver_user_id"],))
        if not drv or drv["role"] != "parent":
            return err("the van driver must be a parent account")
        driver_uid = drv["id"]
    seats = None
    if b.get("seats") not in (None, ""):
        try:
            seats = int(b["seats"])
        except (TypeError, ValueError):
            return err("seats must be a number")
        if seats < 1:
            return err("seats must be 1 or more")
    vid = execute("INSERT INTO team_vans (name, notes, driver_user_id,"
                  " seats) VALUES (?,?,?,?)",
                  (b["name"].strip(), (b.get("notes") or "").strip(),
                   driver_uid, seats))
    return jsonify(q_one("SELECT * FROM team_vans WHERE id=?", (vid,))), 201


@app.route("/api/team-vans/<int:vid>", methods=["PATCH"])
@require_role("mentor", "admin")
def api_team_van_patch(vid):
    v = q_one("SELECT * FROM team_vans WHERE id=?", (vid,))
    if not v:
        return err("team van not found", 404)
    b = request.get_json(force=True)
    sets, args = [], []
    if "name" in b:
        if not (b["name"] or "").strip():
            return err("name is required")
        sets.append("name=?")
        args.append(b["name"].strip())
    if "notes" in b:
        sets.append("notes=?")
        args.append(b["notes"])
    if "driver_user_id" in b:
        if b["driver_user_id"] in (None, ""):
            sets.append("driver_user_id=?")
            args.append(None)
        else:
            drv = q_one("SELECT id, role FROM users WHERE id=?",
                        (b["driver_user_id"],))
            if not drv or drv["role"] != "parent":
                return err("the van driver must be a parent account")
            sets.append("driver_user_id=?")
            args.append(drv["id"])
    if "seats" in b:
        if b["seats"] in (None, ""):
            sets.append("seats=?")
            args.append(None)
        else:
            try:
                seats = int(b["seats"])
            except (TypeError, ValueError):
                return err("seats must be a number")
            if seats < 1:
                return err("seats must be 1 or more")
            sets.append("seats=?")
            args.append(seats)
    if not sets:
        return err("nothing to update")
    execute(f"UPDATE team_vans SET {', '.join(sets)} WHERE id=?",
            (*args, vid))
    return jsonify(q_one("SELECT * FROM team_vans WHERE id=?", (vid,)))


@app.route("/api/team-vans/<int:vid>", methods=["DELETE"])
@require_role("mentor", "admin")
def api_team_van_delete(vid):
    if not q_one("SELECT * FROM team_vans WHERE id=?", (vid,)):
        return err("team van not found", 404)
    with _lock:
        db = get_db()
        tu = db.execute("UPDATE tools SET vehicle_type=NULL, vehicle_id=NULL,"
                        " claimed_at=NULL WHERE vehicle_type='van'"
                        " AND vehicle_id=?", (vid,)).rowcount
        nc = db.execute("DELETE FROM van_claims WHERE van_id=?",
                        (vid,)).rowcount
        db.execute("DELETE FROM team_vans WHERE id=?", (vid,))
        db.commit()
    return jsonify({"deleted": vid, "tools_unassigned": tu,
                    "claims_removed": nc})


@app.route("/api/vans/<int:vid>/claims", methods=["POST"])
def api_van_claim(vid):
    """A student (or parent) rides in a team van for an event. The van
    takes riders only when it has seats AND a designated parent driver
    who RSVP'd going for this event — and that driver isn't already
    driving a carpool for the same event. Otherwise the van is
    tools-only for the event. Capacity, waitlist, and dedupe mirror
    carpool seats."""
    v = q_one("SELECT * FROM team_vans WHERE id=?", (vid,))
    if not v:
        return err("team van not found", 404)
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("person_name"):
        return err("event_id and person_name required")
    if not v.get("seats"):
        return err("this van doesn't take riders — set its seats first")
    drv = q_one("SELECT id, name FROM users WHERE id=?",
                (v.get("driver_user_id"),)) if v.get("driver_user_id") else None
    if not drv:
        return err("this van has no designated driver yet")
    going = {r["person_name"] for r in q_all(
        "SELECT person_name FROM rsvps WHERE event_id=? AND"
        " person_kind='parent' AND status='going'", (b["event_id"],))}
    if drv["name"] not in going:
        return err("the van's driver must RSVP as attending for this"
                   " event first")
    car_driver = q_one("SELECT id FROM carpools WHERE event_id=? AND"
                       " driver_user_id=?", (b["event_id"], drv["id"]))
    if car_driver:
        return err("the van's driver is already driving a carpool for"
                   " this event")
    if not is_attending(b["event_id"], b.get("member_id"), b.get("person_kind")):
        return err("only people attending this event can ride — RSVP"
                   " as going first")
    with _lock:
        db = get_db()
        if b.get("member_id"):
            dup = db.execute(
                "SELECT id FROM van_claims WHERE van_id=? AND event_id=?"
                " AND member_id=? AND person_kind=?",
                (vid, b["event_id"], b["member_id"],
                 b.get("person_kind"))).fetchone()
        else:
            dup = db.execute(
                "SELECT id FROM van_claims WHERE van_id=? AND event_id=?"
                " AND member_id IS NULL AND person_name=? AND person_kind=?",
                (vid, b["event_id"], b["person_name"],
                 b.get("person_kind"))).fetchone()
        if dup:
            return err("already riding in this van — claimed or waitlisted",
                       409)
        if _is_event_driver(db, b["event_id"], b.get("person_kind"),
                            b["person_name"]):
            return err("drivers can't claim a seat — they're driving"
                       " for this event", 403)
        if _has_claimed_seat(db, b["event_id"], b.get("member_id"),
                             b.get("person_kind"), b["person_name"]):
            return err("already has a seat for this event — on another"
                       " car or van", 409)
        taken = db.execute(
            "SELECT COUNT(*) n FROM van_claims WHERE van_id=? AND"
            " event_id=? AND status='claimed'",
            (vid, b["event_id"])).fetchone()["n"]
        status = "claimed" if taken < v["seats"] else "waitlisted"
        cur = db.execute(
            "INSERT INTO van_claims (van_id, event_id, member_id,"
            " person_kind, person_name, status) VALUES (?,?,?,?,?,?)",
            (vid, b["event_id"], b.get("member_id"), b.get("person_kind"),
             b["person_name"], status))
        db.commit()
        clid = cur.lastrowid
    return jsonify(q_one("SELECT * FROM van_claims WHERE id=?", (clid,))), 201


@app.route("/api/van_claims/<int:clid>", methods=["DELETE"])
def api_van_claim_delete(clid):
    cl = q_one("SELECT * FROM van_claims WHERE id=?", (clid,))
    if not cl:
        return err("claim not found", 404)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM van_claims WHERE id=?", (clid,))
        promoted = None
        if cl["status"] == "claimed":
            claimed_ids = {(r["member_id"], r["person_kind"]) for r in db.execute(
                "SELECT member_id, person_kind FROM van_claims"
                " WHERE van_id=? AND event_id=? AND status='claimed'",
                (cl["van_id"], cl["event_id"]))}
            claimed_names = {(r["person_name"], r["person_kind"]) for r in db.execute(
                "SELECT person_name, person_kind FROM van_claims"
                " WHERE van_id=? AND event_id=? AND status='claimed'",
                (cl["van_id"], cl["event_id"]))}
            for nxt in db.execute(
                    "SELECT * FROM van_claims WHERE van_id=? AND event_id=?"
                    " AND status='waitlisted' ORDER BY created_at, id",
                    (cl["van_id"], cl["event_id"])):
                if ((nxt["member_id"], nxt["person_kind"]) in claimed_ids
                        or (nxt["person_name"], nxt["person_kind"]) in claimed_names):
                    continue
                if (_is_event_driver(db, cl["event_id"], nxt["person_kind"],
                                     nxt["person_name"])
                        or _has_claimed_seat(db, cl["event_id"],
                                             nxt["member_id"],
                                             nxt["person_kind"],
                                             nxt["person_name"])):
                    continue  # driving, or already seated on another vehicle
                db.execute("UPDATE van_claims SET status='claimed' WHERE id=?",
                           (nxt["id"],))
                promoted = dict(nxt)
                break
        db.commit()
    return jsonify({"deleted": clid, "promoted": promoted})


@app.route("/api/hotels", methods=["POST"])
@require_role("mentor", "admin")
def api_hotel_create():
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("name"):
        return err("event_id and name required")
    with _lock:
        db = get_db()
        db.execute(
            """INSERT INTO hotels (event_id, name, address, check_in, check_out, notes)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(event_id) DO UPDATE SET name=excluded.name,
                 address=excluded.address, check_in=excluded.check_in,
                 check_out=excluded.check_out, notes=excluded.notes""",
            (b["event_id"], b["name"], b.get("address"), b.get("check_in"),
             b.get("check_out"), b.get("notes")))
        db.commit()
        hid = db.execute("SELECT id FROM hotels WHERE event_id=?",
                         (b["event_id"],)).fetchone()["id"]
    return jsonify(q_one("SELECT * FROM hotels WHERE id=?", (hid,))), 201


@app.route("/api/hotels/<int:hid>/rooms", methods=["POST"])
@require_role("mentor", "admin")
def api_room_create(hid):
    """Mentors add Room #1, #2, ... — the label is automatic. Beds are picked
    from the bed builder; capacity is derived: double/queen/king sleep 2,
    a sofa bed sleeps 1."""
    b = request.get_json(force=True, silent=True) or {}
    if not q_one("SELECT id FROM hotels WHERE id=?", (hid,)):
        return err("hotel not found", 404)
    fits = {"double": 2, "queen": 2, "king": 2, "sofa bed": 1}
    beds = b.get("beds") or []
    if not isinstance(beds, list) or any(t not in fits for t in beds):
        return err("beds must be a list of: double, queen, king, sofa bed")
    capacity = sum(fits[t] for t in beds)
    if capacity == 0:
        capacity = int(b.get("capacity") or 4)
    n = q_one("SELECT COUNT(*) n FROM rooms WHERE hotel_id=?", (hid,))["n"]
    label = (b.get("label") or "").strip() or f"Room #{n + 1}"
    rid = execute("INSERT INTO rooms (hotel_id, label, capacity, beds)"
                  " VALUES (?,?,?,?)",
                  (hid, label, capacity, json.dumps(beds)))
    return jsonify(q_one("SELECT * FROM rooms WHERE id=?", (rid,))), 201


@app.route("/api/rooms/<int:rid>", methods=["PUT"])
@require_role("mentor", "admin")
def api_room_update(rid):
    """After check-in, mentors record the hotel's actual room number."""
    b = request.get_json(force=True, silent=True) or {}
    if not q_one("SELECT id FROM rooms WHERE id=?", (rid,)):
        return err("room not found", 404)
    if "room_number" in b:
        execute("UPDATE rooms SET room_number=? WHERE id=?",
                ((b["room_number"] or "").strip() or None, rid))
    return jsonify(q_one("SELECT * FROM rooms WHERE id=?", (rid,)))


@app.route("/api/hotels/<int:hid>/requests", methods=["POST"])
def api_rooming_request(hid):
    """Rooming requests are made by students, for themselves only.
    Parents cannot file them; mentors may file on a student's behalf."""
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] == "parent":
        return err("rooming requests are made by students", 403)
    b = request.get_json(force=True)
    if not b.get("member_id"):
        return err("member_id required")
    if u["role"] == "student":
        own = _own_member_id(u)
        if not own:
            return err("your account is not linked to a student on the roster"
                       " — ask a mentor to check your account name", 403)
        if int(b["member_id"]) != own:
            return err("you can only request a room for yourself", 403)
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (hid,))
    if not hotel:
        return err("hotel not found", 404)
    eid = hotel["event_id"]
    if not is_attending(eid, b["member_id"], "student"):
        return err("only students attending this event can request a room"
                   " — RSVP as going first")
    requester = q_one("SELECT first_name, last_name FROM members WHERE id=?",
                      (b["member_id"],))
    requester_name = (requester["first_name"] + " " + requester["last_name"]) \
        if requester else ""
    attending_names = {r["person_name"] for r in q_all(
        "SELECT person_name FROM rsvps WHERE event_id=? AND"
        " person_kind='student' AND status IN ('going','partial')", (eid,))}
    for name in b.get("preferred_roommates") or []:
        if name not in attending_names:
            return err(f"{name} is not attending this event")
        if _norm_name(name) == _norm_name(requester_name):
            return err("you can't list yourself as your own roommate")
    with _lock:
        db = get_db()
        db.execute(
            """INSERT INTO rooming_requests (hotel_id, member_id, preferred_roommates,
               notes, status)
               VALUES (?,?,?,?,'pending')
               ON CONFLICT(hotel_id, member_id) DO UPDATE SET
                 preferred_roommates=excluded.preferred_roommates,
                 notes=excluded.notes""",
            (hid, b["member_id"], json.dumps(b.get("preferred_roommates") or []),
             b.get("notes")))
        db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/rooming-requests/<int:qid>", methods=["DELETE"])
def api_rooming_request_delete(qid):
    """Withdraw rule: while a request is pending, only the student it
    belongs to (or a mentor/admin) can withdraw it; once placed/finalized,
    only mentors/admins can remove it."""
    q = q_one("SELECT * FROM rooming_requests WHERE id=?", (qid,))
    if not q:
        return err("request not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if q["status"] == "placed":
        if u["role"] not in ("mentor", "admin"):
            return err("placed requests can only be removed by a mentor", 403)
    elif u["role"] not in ("mentor", "admin"):
        if _own_member_id(u) != q["member_id"]:
            return err("you can only withdraw your own request", 403)
    execute("DELETE FROM rooming_requests WHERE id=?", (qid,))
    return jsonify({"deleted": qid})


@app.route("/api/rooms/<int:rid>/occupants", methods=["POST"])
@require_role("mentor", "admin")
def api_room_place(rid):
    b = request.get_json(force=True)
    if not b.get("member_id"):
        return err("member_id required")
    rm = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not rm:
        return err("room not found", 404)
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (rm["hotel_id"],))
    if not is_attending(hotel["event_id"], b["member_id"], "student"):
        return err("only students attending this event can be placed"
                   " — RSVP as going first")
    occ = q_one("SELECT COUNT(*) n FROM room_occupants WHERE room_id=?", (rid,))["n"]
    if occ >= rm["capacity"]:
        return err("room is full", 409)
    with _lock:
        db = get_db()
        db.execute(
            "INSERT OR IGNORE INTO room_occupants (room_id, member_id) VALUES (?,?)",
            (rid, b["member_id"]))
        db.execute("UPDATE rooming_requests SET status='placed'"
                   " WHERE hotel_id=? AND member_id=?",
                   (rm["hotel_id"], b["member_id"]))
        db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/room_occupants/<int:oid>", methods=["DELETE"])
@require_role("mentor", "admin")
def api_room_unplace(oid):
    o = q_one("""SELECT o.*, r.hotel_id FROM room_occupants o
                 JOIN rooms r ON r.id = o.room_id WHERE o.id=?""", (oid,))
    if not o:
        return err("occupant not found", 404)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM room_occupants WHERE id=?", (oid,))
        db.execute("UPDATE rooming_requests SET status='pending'"
                   " WHERE hotel_id=? AND member_id=?",
                   (o["hotel_id"], o["member_id"]))
        db.commit()
    return jsonify({"deleted": oid})


@app.route("/api/rooms/<int:rid>/parent", methods=["POST", "DELETE"])
def api_room_parent(rid):
    """Room parent: the adult volunteer who checks the room in. Optional —
    senior rooms can go without. Only parents/mentors/admins may volunteer
    or remove; students are never allowed in this slot. The recorded name is
    always the family's parent name, taken server-side."""
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] not in ("parent", "mentor", "admin"):
        return err("parents, mentors and admins only", 403)
    room = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not room:
        return err("room not found", 404)
    if request.method == "DELETE":
        execute("UPDATE rooms SET parent_member_id=NULL, parent_name=NULL"
                " WHERE id=?", (rid,))
        return jsonify({"ok": True})
    b = request.get_json(force=True, silent=True) or {}
    m = q_one("SELECT id, parent_name FROM members WHERE id=?",
              (b.get("member_id"),)) if b.get("member_id") else None
    pname = ((m["parent_name"] if m else "") or "").strip()
    if not pname:
        return err("choose a family with a parent on record")
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (room["hotel_id"],))
    if not is_attending(hotel["event_id"], m["id"], "parent"):
        return err("room-parent volunteers must RSVP as attending"
                   " for this event first")
    execute("UPDATE rooms SET parent_member_id=?, parent_name=? WHERE id=?",
            (m["id"], pname, rid))
    return jsonify({"ok": True})


# ----------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
