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
        if "archived" not in event_cols:
            db.execute("ALTER TABLE events ADD COLUMN archived INTEGER"
                       " NOT NULL DEFAULT 0")
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
        # 2026-10-29: multi-day trips. Additive columns first, then
        # the new day tables, then the checkins rebuild: the old
        # UNIQUE(event, member, kind) would block a second day's
        # check-in, so old tables are rebuilt with
        # UNIQUE(event, member, kind, day), data preserved. Fresh
        # DBs already have the day column from schema.sql, so the
        # rebuild (guarded on the missing column) never runs there.
        if "end_date" not in event_cols:
            db.execute("ALTER TABLE events ADD COLUMN end_date TEXT")
        for tbl, col in (("carpool_claims", "day"),
                         ("van_claims", "day")):
            cols = {r[1] for r in db.execute(
                f"PRAGMA table_info({tbl})")}
            if col not in cols:
                db.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS rsvp_days (
            rsvp_id INTEGER NOT NULL REFERENCES rsvps(id)
                ON DELETE CASCADE,
            day TEXT NOT NULL, UNIQUE(rsvp_id, day))""")
        db.execute("""CREATE TABLE IF NOT EXISTS carpool_days (
            carpool_id INTEGER NOT NULL REFERENCES carpools(id)
                ON DELETE CASCADE,
            day TEXT NOT NULL, UNIQUE(carpool_id, day))""")
        db.execute("""CREATE TABLE IF NOT EXISTS van_day_drivers (
            van_id INTEGER NOT NULL REFERENCES team_vans(id)
                ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id)
                ON DELETE CASCADE,
            day TEXT NOT NULL, driver_user_id INTEGER NOT NULL,
            UNIQUE(van_id, event_id, day))""")
        check_cols = {r[1] for r in db.execute(
            "PRAGMA table_info(checkins)")}
        if check_cols and "day" not in check_cols:
            db.execute("ALTER TABLE checkins RENAME TO checkins_old")
            db.execute("""CREATE TABLE checkins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES events(id)
                    ON DELETE CASCADE,
                member_id INTEGER NOT NULL REFERENCES members(id)
                    ON DELETE CASCADE,
                person_kind TEXT NOT NULL DEFAULT 'student',
                person_name TEXT NOT NULL,
                method TEXT NOT NULL DEFAULT 'mentor',
                verified INTEGER NOT NULL DEFAULT 1,
                hours REAL NOT NULL DEFAULT 0,
                day TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(event_id, member_id, person_kind, day))""")
            db.execute("""INSERT INTO checkins (id, event_id, member_id,
                person_kind, person_name, method, verified, hours,
                created_at) SELECT id, event_id, member_id, person_kind,
                person_name, method, verified, hours, created_at
                FROM checkins_old""")
            db.execute("DROP TABLE checkins_old")
        # 2026-10-29: rooms go per-day like carpools. room_days holds
        # the days a room is allocated for (empty = every day); the
        # occupants table gains a day column and its UNIQUE widens
        # to (room, member, day), so one student can sleep in
        # different rooms on different nights. Old tables are
        # rebuilt with data preserved (day NULL = every day, the
        # legacy meaning). Fresh DBs already have the new shape
        # from schema.sql, so the rebuild (guarded on the missing
        # column) never runs there.
        db.execute("""CREATE TABLE IF NOT EXISTS room_days (
            room_id INTEGER NOT NULL REFERENCES rooms(id)
                ON DELETE CASCADE,
            day TEXT NOT NULL, UNIQUE(room_id, day))""")
        occ_cols = {r[1] for r in db.execute(
            "PRAGMA table_info(room_occupants)")}
        if occ_cols and "day" not in occ_cols:
            db.execute("ALTER TABLE room_occupants"
                       " RENAME TO room_occupants_old")
            db.execute("""CREATE TABLE room_occupants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL REFERENCES rooms(id)
                    ON DELETE CASCADE,
                member_id INTEGER NOT NULL REFERENCES members(id)
                    ON DELETE CASCADE,
                day TEXT,
                placed_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(room_id, member_id, day))""")
            db.execute("""INSERT INTO room_occupants
                (id, room_id, member_id, placed_at)
                SELECT id, room_id, member_id, placed_at
                FROM room_occupants_old""")
            db.execute("DROP TABLE room_occupants_old")
        # Name-only occupants (a mentor placing themself) need a
        # person_name column, and member_id must be nullable for
        # them — SQLite can't relax NOT NULL in place, so rebuild
        # once. Runs after the day rebuild above, so the old table
        # always has a day column by now.
        occ_cols = {r[1] for r in db.execute(
            "PRAGMA table_info(room_occupants)")}
        if occ_cols and "person_name" not in occ_cols:
            db.execute("ALTER TABLE room_occupants"
                       " RENAME TO room_occupants_old")
            db.execute("""CREATE TABLE room_occupants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL REFERENCES rooms(id)
                    ON DELETE CASCADE,
                member_id INTEGER REFERENCES members(id)
                    ON DELETE SET NULL,
                day TEXT,
                person_name TEXT,
                placed_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(room_id, member_id, day))""")
            db.execute("""INSERT INTO room_occupants
                (id, room_id, member_id, day, placed_at)
                SELECT id, room_id, member_id, day, placed_at
                FROM room_occupants_old""")
            db.execute("DROP TABLE room_occupants_old")
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


def _event_archived(eid):
    """True when the event is frozen by Archive. Missing events read
    as not archived — the endpoint itself reports the 404."""
    if not eid:
        return False
    ev = q_one("SELECT archived FROM events WHERE id=?", (eid,))
    return bool(ev) and bool(ev["archived"])


@app.before_request
def _archive_gate():
    """An archived event accepts no updates — not from parents,
    students, or mentors. Runs after the auth gate; reads only, so
    GETs, event creation, and the archive toggle itself pass through.
    Team vans are global (only their per-day, per-event driver
    overrides are event-scoped), and season archiving excludes frozen
    events in its own query."""
    if request.method == "GET" or not request.path.startswith("/api/"):
        return None
    p = request.path
    parts = [x for x in p.split("/") if x]
    if len(parts) < 2 or parts[0] != "api":
        return None
    b = request.get_json(force=True, silent=True) or {}
    eid = None
    # The archive toggle itself: PATCH /api/events/<id> with ONLY
    # {archived} — the endpoint owns its closed-only rule.
    if (request.method == "PATCH" and len(parts) == 3
            and parts[1] == "events" and parts[2].isdigit()
            and set(b.keys()) == {"archived"}):
        return None
    if parts[1] == "events" and len(parts) >= 3 and parts[2].isdigit():
        eid = int(parts[2])
    elif parts[1] == "rsvps" and len(parts) == 3 and parts[2].isdigit():
        r = q_one("SELECT event_id FROM rsvps WHERE id=?", (parts[2],))
        eid = r["event_id"] if r else None
    elif parts[1] == "checkins" and len(parts) == 3 and parts[2].isdigit():
        c = q_one("SELECT event_id FROM checkins WHERE id=?", (parts[2],))
        eid = c["event_id"] if c else None
    elif parts[1] == "checkins" and len(parts) == 2:
        eid = b.get("event_id")
    elif parts[1] == "carpools" and len(parts) == 2:
        eid = b.get("event_id")
    elif parts[1] == "carpools" and len(parts) >= 3 and parts[2].isdigit():
        c = q_one("SELECT event_id FROM carpools WHERE id=?", (parts[2],))
        eid = c["event_id"] if c else None
    elif parts[1] == "carpool_claims" and len(parts) == 3 \
            and parts[2].isdigit():
        c = q_one("SELECT cp.event_id FROM carpool_claims cc"
                  " JOIN carpools cp ON cp.id=cc.carpool_id"
                  " WHERE cc.id=?", (parts[2],))
        eid = c["event_id"] if c else None
    elif parts[1] == "tools" and len(parts) == 2:
        eid = b.get("event_id")
    elif parts[1] == "tools" and len(parts) >= 3 and parts[2].isdigit():
        t = q_one("SELECT event_id FROM tools WHERE id=?", (parts[2],))
        eid = t["event_id"] if t else None
    elif parts[1] == "vans" and len(parts) >= 3 and parts[2].isdigit():
        eid = b.get("event_id")
    elif parts[1] == "van_claims" and len(parts) == 3 \
            and parts[2].isdigit():
        c = q_one("SELECT event_id FROM van_claims WHERE id=?", (parts[2],))
        eid = c["event_id"] if c else None
    elif parts[1] == "hotels" and len(parts) == 2:
        eid = b.get("event_id")
    elif parts[1] == "hotels" and len(parts) >= 3 and parts[2].isdigit():
        h = q_one("SELECT event_id FROM hotels WHERE id=?", (parts[2],))
        eid = h["event_id"] if h else None
    elif parts[1] == "rooming-requests" and len(parts) == 3 \
            and parts[2].isdigit():
        q = q_one("SELECT h.event_id FROM rooming_requests r"
                  " JOIN hotels h ON h.id=r.hotel_id WHERE r.id=?",
                  (parts[2],))
        eid = q["event_id"] if q else None
    elif parts[1] == "rooms" and len(parts) >= 3 and parts[2].isdigit():
        r = q_one("SELECT h.event_id FROM rooms rm"
                  " JOIN hotels h ON h.id=rm.hotel_id WHERE rm.id=?",
                  (parts[2],))
        eid = r["event_id"] if r else None
    elif parts[1] == "room_occupants" and len(parts) == 3 \
            and parts[2].isdigit():
        o = q_one("SELECT h.event_id FROM room_occupants oc"
                  " JOIN rooms rm ON rm.id=oc.room_id"
                  " JOIN hotels h ON h.id=rm.hotel_id WHERE oc.id=?",
                  (parts[2],))
        eid = o["event_id"] if o else None
    if eid is not None and _event_archived(eid):
        return err("this event is archived — unarchive it to make"
                   " changes", 403)
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
    # Identity links ride along on every auth-shaped user object, so
    # the frontend's ME always knows who the caller may act for. The
    # login/verify responses used to omit them, which left every
    # own-only picker empty in the browser until something happened
    # to re-fetch /api/auth/me — the server rules were right, but
    # the UI silently showed parents and students nothing to pick.
    d["links"] = _user_links_map([u["id"]]).get(u["id"], [])
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
    """Mentor edit of an account: WhatsApp (inline in the Team
    accounts table; empty clears it) and member type (role).
    Role guards: never your own row; only admins grant the admin
    role or change an admin's role; changing the last enabled
    mentor/admin to a non-mentor role is refused. Links are
    untouched — role is permission, not identity — and a parent
    newly made mentor without 2FA hits the existing
    mandatory-mentor-2FA gate until they set it up."""
    u = q_one("SELECT id, role FROM users WHERE id=?", (uid,))
    if not u:
        return err("user not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    wa = None
    wa_set = False
    if "whatsapp" in b:
        wa = b.get("whatsapp")
        if wa is not None and not isinstance(wa, str):
            return err("whatsapp must be text")
        wa = (wa or "").strip() or None
        wa_set = True
    new_role = None
    role_set = False
    if "role" in b:
        new_role = b.get("role")
        if new_role not in ("student", "parent", "mentor", "admin"):
            return err("role must be student, parent, mentor or admin")
        me = current_user()
        if me and me["id"] == uid:
            return err("you cannot change your own role", 400)
        if new_role == "admin" and (not me or me["role"] != "admin"):
            return err("only an admin can grant the admin role", 403)
        if u["role"] == "admin" and (not me or me["role"] != "admin"):
            return err("only an admin can change an admin's role", 403)
        if (u["role"] in MENTOR_ROLES
                and new_role not in MENTOR_ROLES):
            remaining = q_one("SELECT COUNT(*) AS n FROM users"
                              " WHERE role IN ('mentor','admin')"
                              " AND (disabled IS NULL OR disabled=0)"
                              " AND id!=?", (uid,))["n"]
            if remaining == 0:
                return err("cannot change the role of the last"
                           " mentor/admin", 400)
        role_set = True
    if not wa_set and not role_set:
        return err("nothing to update")
    out = {"ok": True}
    if wa_set:
        execute("UPDATE users SET whatsapp=? WHERE id=?", (wa, uid))
        out["whatsapp"] = wa
    if role_set:
        execute("UPDATE users SET role=? WHERE id=?", (new_role, uid))
        out["role"] = new_role
    return jsonify(out)


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
# Duplicate cleanup: remove + re-create cycles leave two approved rows
# or two accounts for one person, and the lists then show the name
# twice. Scan first, merge on an explicit survivor choice: the merge
# re-points every reference to the survivor, drops only the rows that
# would collide after re-pointing (same event+kind RSVP, same room+day
# bed, same day seat, same hotel request, same link), and deletes the
# duplicate rows. A duplicate account whose carpool/van driving
# collides with the survivor's is skipped with a reason — merging
# those would break the one-vehicle-per-driver rules.
# ----------------------------------------------------------------------------

def _dupe_groups():
    """{members: [...], users: [...]}: same normalized name, 2+ rows.
    Members: approved rows only (those are the ones lists show).
    Users: every account row. Each group names a suggested survivor:
    members -> lowest id (the original); users -> enabled with a
    password first, then lowest id."""
    groups = {"members": [], "users": []}
    by_name = {}
    for m in q_all("SELECT * FROM members WHERE status='approved'"
                   " ORDER BY id"):
        by_name.setdefault(_norm_name(m["first_name"] + m["last_name"]),
                           []).append(m)
    for rows in by_name.values():
        if len(rows) < 2:
            continue
        out_rows = []
        for m in rows:
            out_rows.append({
                "id": m["id"], "code": m["code"],
                "name": f"{m['first_name']} {m['last_name']}".strip(),
                "school": m["school"], "grade": m["grade"],
                "subteam": m["assigned_subteam"],
                "parent_name": m["parent_name"],
                "rsvps": q_one("SELECT COUNT(*) AS n FROM rsvps"
                               " WHERE member_id=?", (m["id"],))["n"],
                "placements": q_one("SELECT COUNT(*) AS n FROM room_occupants"
                                    " WHERE member_id=?", (m["id"],))["n"],
                "claims": q_one("SELECT COUNT(*) AS n FROM carpool_claims"
                                " WHERE member_id=?", (m["id"],))["n"]
                + q_one("SELECT COUNT(*) AS n FROM van_claims"
                        " WHERE member_id=?", (m["id"],))["n"],
                "checkins": q_one("SELECT COUNT(*) AS n FROM checkins"
                                  " WHERE member_id=?", (m["id"],))["n"],
                "links": q_one("SELECT COUNT(*) AS n FROM user_members"
                               " WHERE member_id=?", (m["id"],))["n"]})
        groups["members"].append({
            "name": out_rows[0]["name"], "rows": out_rows,
            "suggested": min(r["id"] for r in out_rows)})
    by_name = {}
    for u in q_all("SELECT * FROM users ORDER BY id"):
        by_name.setdefault(_norm_name(u["name"]), []).append(u)
    for rows in by_name.values():
        if len(rows) < 2:
            continue
        out_rows = []
        for u in rows:
            out_rows.append({
                "id": u["id"], "name": u["name"], "email": u["email"],
                "role": u["role"], "disabled": bool(u["disabled"]),
                "has_password": bool(u["password_hash"]),
                "totp": bool(u["totp_enabled"]),
                "links": q_one("SELECT COUNT(*) AS n FROM user_members"
                               " WHERE user_id=?", (u["id"],))["n"],
                "carpools": q_one("SELECT COUNT(*) AS n FROM carpools"
                                  " WHERE driver_user_id=?", (u["id"],))["n"],
                "vans": q_one("SELECT COUNT(*) AS n FROM team_vans"
                              " WHERE driver_user_id=?", (u["id"],))["n"]})
        sug = sorted(out_rows,
                     key=lambda r: (r["disabled"], not r["has_password"],
                                    r["id"]))[0]["id"]
        groups["users"].append({
            "name": out_rows[0]["name"], "rows": out_rows,
            "suggested": sug})
    return groups


def _merge_member(surv, dupes):
    """Fold dupe member rows into the survivor; returns
    (merged_ids, dropped_counts)."""
    dropped = {"rsvps": 0, "checkins": 0, "carpool_claims": 0,
               "van_claims": 0, "room_occupants": 0,
               "rooming_requests": 0, "links": 0}
    merged = []
    for d in dupes:
        for r in q_all("SELECT * FROM rsvps WHERE member_id=?", (d,)):
            if q_one("SELECT id FROM rsvps WHERE member_id=? AND event_id=?"
                     " AND person_kind=?",
                     (surv, r["event_id"], r["person_kind"])):
                execute("DELETE FROM rsvps WHERE id=?", (r["id"],))
                dropped["rsvps"] += 1
            else:
                execute("UPDATE rsvps SET member_id=? WHERE id=?",
                        (surv, r["id"]))
        for c in q_all("SELECT * FROM checkins WHERE member_id=?", (d,)):
            if q_one("SELECT id FROM checkins WHERE member_id=?"
                     " AND event_id=? AND person_kind=? AND day=?",
                     (surv, c["event_id"], c["person_kind"], c["day"])):
                execute("DELETE FROM checkins WHERE id=?", (c["id"],))
                dropped["checkins"] += 1
            else:
                execute("UPDATE checkins SET member_id=? WHERE id=?",
                        (surv, c["id"]))

        def _repoint_rows(table, join, event_col, surv_rows):
            # Re-point the dupe's rows, dropping any that would
            # collide with a survivor row: same event + kind +
            # overlapping day. NULL day = every day, so it overlaps
            # any dated row. Re-pointed rows join surv_rows as they
            # land, so two dupe rows can't both survive a clash.
            # Returns how many were dropped.
            dropped_n = 0
            for cl in q_all(f"SELECT cc.*, {event_col} AS event_id FROM"
                            f" {table} cc {join} WHERE cc.member_id=?",
                            (d,)):
                clash = any(s["event_id"] == cl["event_id"]
                            and s["person_kind"] == cl["person_kind"]
                            and (s["day"] is None or cl["day"] is None
                                 or s["day"] == cl["day"])
                            for s in surv_rows)
                if clash:
                    execute(f"DELETE FROM {table} WHERE id=?", (cl["id"],))
                    dropped_n += 1
                else:
                    execute(f"UPDATE {table} SET member_id=? WHERE id=?",
                            (surv, cl["id"]))
                    surv_rows.append({"event_id": cl["event_id"],
                                      "person_kind": cl["person_kind"],
                                      "day": cl["day"]})
            return dropped_n

        surv_car = q_all("SELECT cc.*, cp.event_id AS event_id FROM"
                         " carpool_claims cc JOIN carpools cp"
                         " ON cp.id=cc.carpool_id WHERE cc.member_id=?",
                         (surv,))
        dropped["carpool_claims"] += _repoint_rows(
            "carpool_claims", "JOIN carpools cp ON cp.id=cc.carpool_id",
            "cp.event_id", surv_car)
        surv_van = q_all("SELECT * FROM van_claims WHERE member_id=?",
                         (surv,))
        dropped["van_claims"] += _repoint_rows(
            "van_claims", "", "event_id", surv_van)
        surv_rooms = q_all("SELECT room_id, day FROM room_occupants"
                           " WHERE member_id=?", (surv,))
        for o in q_all("SELECT * FROM room_occupants WHERE member_id=?",
                       (d,)):
            clash = any(s["room_id"] == o["room_id"]
                        and (s["day"] is None or o["day"] is None
                             or s["day"] == o["day"])
                        for s in surv_rooms)
            if clash:
                execute("DELETE FROM room_occupants WHERE id=?", (o["id"],))
                dropped["room_occupants"] += 1
            else:
                execute("UPDATE room_occupants SET member_id=? WHERE id=?",
                        (surv, o["id"]))
                surv_rooms.append({"room_id": o["room_id"],
                                   "day": o["day"]})
        for rq in q_all("SELECT * FROM rooming_requests WHERE member_id=?",
                        (d,)):
            if q_one("SELECT id FROM rooming_requests WHERE member_id=?"
                     " AND hotel_id=?", (surv, rq["hotel_id"])):
                execute("DELETE FROM rooming_requests WHERE id=?",
                        (rq["id"],))
                dropped["rooming_requests"] += 1
            else:
                execute("UPDATE rooming_requests SET member_id=? WHERE id=?",
                        (surv, rq["id"]))
        execute("UPDATE rooms SET parent_member_id=? WHERE parent_member_id=?",
                (surv, d))
        execute("UPDATE link_requests SET member_id=? WHERE member_id=?",
                (surv, d))
        for l in q_all("SELECT * FROM user_members WHERE member_id=?", (d,)):
            if q_one("SELECT * FROM user_members WHERE user_id=?"
                     " AND member_id=? AND kind=?",
                     (l["user_id"], surv, l["kind"])):
                execute("DELETE FROM user_members WHERE user_id=?"
                        " AND member_id=? AND kind=?",
                        (l["user_id"], d, l["kind"]))
                dropped["links"] += 1
            else:
                execute("UPDATE user_members SET member_id=? WHERE user_id=?"
                        " AND member_id=? AND kind=?",
                        (surv, l["user_id"], d, l["kind"]))
        execute("DELETE FROM members WHERE id=?", (d,))
        merged.append(d)
    return merged, dropped


def _user_merge_blockers(surv, d):
    """Why dupe account d can't fold into survivor surv (vehicle
    rules would break). Empty list = safe to merge."""
    reasons = []
    for c in q_all("SELECT * FROM carpools WHERE driver_user_id=?", (d,)):
        if q_one("SELECT id FROM carpools WHERE driver_user_id=?"
                 " AND event_id=?", (surv, c["event_id"])):
            ev = q_one("SELECT title FROM events WHERE id=?",
                       (c["event_id"],))
            reasons.append("both drive a carpool for "
                           f"{ev['title'] if ev else 'the same event'}")
            break
    for v in q_all("SELECT * FROM team_vans WHERE driver_user_id=?"
                   " AND seats IS NOT NULL", (d,)):
        if q_one("SELECT id FROM team_vans WHERE driver_user_id=?"
                 " AND seats IS NOT NULL AND id!=?", (surv, v["id"])):
            reasons.append("both are designated drivers of seated vans")
            break
    for dd in q_all("SELECT * FROM van_day_drivers WHERE driver_user_id=?",
                    (d,)):
        if q_one("SELECT id FROM van_day_drivers WHERE driver_user_id=?"
                 " AND event_id=? AND day=? AND van_id!=?",
                 (surv, dd["event_id"], dd["day"], dd["van_id"])):
            reasons.append("both drive different vans on the same day")
            break
    return reasons


def _merge_user(surv, d):
    for l in q_all("SELECT * FROM user_members WHERE user_id=?", (d,)):
        if q_one("SELECT * FROM user_members WHERE user_id=?"
                 " AND member_id=? AND kind=?",
                 (surv, l["member_id"], l["kind"])):
            execute("DELETE FROM user_members WHERE user_id=?"
                    " AND member_id=? AND kind=?",
                    (d, l["member_id"], l["kind"]))
        else:
            execute("UPDATE user_members SET user_id=? WHERE user_id=?"
                    " AND member_id=? AND kind=?",
                    (surv, d, l["member_id"], l["kind"]))
    execute("UPDATE carpools SET driver_user_id=? WHERE driver_user_id=?",
            (surv, d))
    execute("UPDATE team_vans SET driver_user_id=? WHERE driver_user_id=?",
            (surv, d))
    execute("UPDATE van_day_drivers SET driver_user_id=?"
            " WHERE driver_user_id=?", (surv, d))
    execute("DELETE FROM password_history WHERE user_id=?", (d,))
    execute("DELETE FROM totp_recovery_codes WHERE user_id=?", (d,))
    execute("DELETE FROM deletion_requests WHERE user_id=? OR requested_by=?",
            (d, d))
    execute("DELETE FROM users WHERE id=?", (d,))


@app.route("/api/admin/duplicates")
@require_role("mentor", "admin")
def api_duplicates():
    return jsonify(_dupe_groups())


@app.route("/api/admin/duplicates/merge", methods=["POST"])
@require_role("mentor", "admin")
def api_duplicates_merge():
    """Merge duplicate groups on explicit survivor choice. Every
    survivor + dupe must sit in one group from the current scan, so
    this endpoint can never delete an arbitrary row — only rows the
    scan itself grouped. Vehicle-colliding account dupes are skipped
    per dupe with a reason; other groups still merge."""
    b = request.get_json(force=True, silent=True) or {}
    merges = b.get("merges") or []
    if not isinstance(merges, list) or not merges:
        return err("merges is required")
    groups = _dupe_groups()
    index = {}
    for g in groups["members"]:
        for r in g["rows"]:
            index[("member", r["id"])] = g
    for g in groups["users"]:
        for r in g["rows"]:
            index[("user", r["id"])] = g
    seen = set()
    for m in merges:
        kind = m.get("kind")
        surv = m.get("survivor_id")
        dupes = m.get("dupe_ids") or []
        if kind not in ("member", "user") or not isinstance(surv, int) \
                or not dupes or not all(isinstance(d, int) for d in dupes) \
                or surv in dupes:
            return err("bad merge request")
        g = index.get((kind, surv))
        if not g or any(index.get((kind, d)) is not g for d in dupes):
            return err("survivor and dupes must be one duplicate group")
        if surv in seen or any(d in seen for d in dupes):
            return err("a row can only merge once per request")
        seen.add(surv)
        seen.update(dupes)
    results = []
    for m in merges:
        kind, surv, dupes = m["kind"], m["survivor_id"], m["dupe_ids"]
        g = index[(kind, surv)]
        if kind == "member":
            merged, dropped = _merge_member(surv, dupes)
            results.append({"kind": kind, "name": g["name"],
                            "survivor_id": surv, "merged": merged,
                            "dropped": dropped, "skipped": []})
        else:
            merged, skipped = [], []
            for d in dupes:
                reasons = _user_merge_blockers(surv, d)
                if reasons:
                    skipped.append({"dupe_id": d, "reasons": reasons})
                    continue
                _merge_user(surv, d)
                merged.append(d)
            results.append({"kind": kind, "name": g["name"],
                            "survivor_id": surv, "merged": merged,
                            "dropped": {}, "skipped": skipped})
    return jsonify({"results": results})


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
    end_s = (b.get("end_date") or "").strip() or None
    range_err = _validate_event_range(b.get("date"), end_s)
    if range_err:
        return err(range_err)
    defaults = {"meeting": 2, "build": 4, "competition": 8, "outreach": 3,
                "club": 1}
    eid = execute(
        """INSERT INTO events (title, type, date, time, location, capacity,
           deadline, session_hours, notes, end_date, sample)
           VALUES (?,?,?,?,?,?,?,?,?,?,0)""",
        (b["title"], b.get("type", "meeting"), b.get("date"), b.get("time"),
         b.get("location"), b.get("capacity"), b.get("deadline"),
         b.get("session_hours", defaults.get(b.get("type", "meeting"), 2)),
         b.get("notes"), end_s))
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
        # Multi-day: the all-day end is the day AFTER end_date.
        d_end = _parse_ymd(ev.get("end_date")) or d0
        start = (f"DTSTART;VALUE=DATE:{d0.strftime('%Y%m%d')}",
                 "DTEND;VALUE=DATE:"
                 + (d_end + datetime.timedelta(days=1)).strftime("%Y%m%d"))
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
    # Season archiving is a different archive from the freeze: frozen
    # events keep their state and are never swept into a season.
    with _lock:
        db = get_db()
        n = db.execute("UPDATE events SET season=? WHERE season IS NULL"
                       " AND (archived IS NULL OR archived=0)",
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
    # Frozen events keep their season too: restoring a season must
    # not rewrite a frozen event's record.
    with _lock:
        db = get_db()
        n = db.execute("UPDATE events SET season=NULL WHERE season=?"
                       " AND (archived IS NULL OR archived=0)",
                       (season,)).rowcount
        db.commit()
    return jsonify({"restored": n, "season": season})


@app.route("/api/events/<int:eid>", methods=["PATCH", "DELETE"])
@require_role("mentor", "admin")
def api_event(eid):
    ev = q_one("SELECT * FROM events WHERE id=?", (eid,))
    if not ev:
        return err("event not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    # Archiving is its own action: the toggle travels alone, and only
    # a closed RSVP can be frozen (the button only appears there).
    # Unarchiving is always allowed; every other change to a frozen
    # event is refused here as well as by the archive gate.
    if "archived" in b:
        if set(b.keys()) != {"archived"}:
            return err("change archived on its own")
        want = b["archived"]
        if want not in (0, 1, True, False):
            return err("archived must be 0 or 1")
        want = 1 if want else 0
        if want == 1 and not (ev["deadline"]
                              and ev["deadline"]
                              < datetime.date.today().isoformat()):
            return err("only events with a closed RSVP can be archived")
        execute("UPDATE events SET archived=? WHERE id=?", (want, eid))
        return jsonify(q_one("SELECT * FROM events WHERE id=?", (eid,)))
    if ev["archived"]:
        return err("event is archived — unarchive it first", 403)
    if request.method == "DELETE":
        execute("DELETE FROM events WHERE id=?", (eid,))
        return jsonify({"deleted": eid})
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
    for col in ("date", "deadline", "end_date"):
        if col in b:
            raw = (b[col] or "").strip() or None
            if raw:
                try:
                    datetime.datetime.strptime(raw, "%Y-%m-%d")
                except ValueError:
                    return err(f"{col} must be YYYY-MM-DD")
            sets.append(f"{col}=?")
            args.append(raw)
    # Validate the combined range, not just each field alone: a new
    # end_date must still be >= the (possibly unchanged) start date.
    new_date = b.get("date", ev["date"])
    new_end = b.get("end_date", ev.get("end_date"))
    range_err = _validate_event_range(
        (new_date or "").strip() if isinstance(new_date, str) else new_date,
        (new_end or "").strip() if isinstance(new_end, str) else new_end)
    if range_err:
        return err(range_err)
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
        # Per-day picks for partial RSVPs (empty = unspecified partial,
        # which attends every day). The UI shows them on multi-day
        # events; the travel payload uses them to filter attendees.
        with _lock:
            db = get_db()
            days_map = _rsvp_days_map(db, eid)
        for r in rsvps:
            r["days"] = sorted(days_map.get(r["id"], set()))
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
    # Per-day picks: only meaningful for partial on a multi-day
    # event, but the server accepts and stores them whenever they
    # are sent (attendance logic ignores stored days for 'going').
    # An empty list means unspecified partial = every day.
    event_days = _event_days(ev)
    days_in, days_err = _validate_days_input(b.get("days"), event_days)
    if days_err:
        return err(days_err)
    status = want
    if want in ("going", "partial") and ev["capacity"]:
        # Capacity is per DAY, not per event: a partial attending
        # only Day 1 must not occupy a Day 3 spot. Going covers
        # every day; partial covers its picked days, or every day
        # when unspecified. If any covered day is full, the whole
        # RSVP waitlists (waitlisting is per RSVP, not per day).
        # The filer themself is excluded, so re-filing a going
        # RSVP at exact capacity doesn't spuriously waitlist.
        covered = event_days if (want == "going" or not days_in) \
            else days_in
        if not covered:
            covered = [None]
        with _lock:
            db = get_db()
            days_map = _rsvp_days_map(db, eid)
            full = False
            for day in covered:
                n = 0
                for r in db.execute(
                        "SELECT id, member_id, person_kind, person_name,"
                        " status FROM rsvps"
                        " WHERE event_id=? AND status IN ('going','partial')",
                        (eid,)):
                    # The filer themself is excluded. For name-only
                    # rows (member_id NULL) that means the same
                    # normalized name — excluding every NULL row of
                    # the kind would under-count other name-only
                    # filers toward capacity.
                    if r["person_kind"] == b["person_kind"] and (
                            (b.get("member_id") is not None
                             and r["member_id"] == b.get("member_id"))
                            or (b.get("member_id") is None
                                and r["member_id"] is None
                                and _norm_name(r["person_name"])
                                == _norm_name(b.get("person_name")))):
                        continue
                    if _attends_day(r["status"],
                                    days_map.get(r["id"], set()),
                                    day, event_days):
                        n += 1
                if n >= ev["capacity"]:
                    full = True
                    break
        if full:
            status = "waitlisted"
    with _lock:
        db = get_db()
        if b.get("member_id") is None:
            # SQLite UNIQUE treats NULLs as distinct, so the
            # ON CONFLICT clause below never fires for name-only
            # rows (e.g. a mentor's own RSVP): every re-file would
            # add a duplicate row instead of updating the old one,
            # and the follow-up SELECT would fetch the oldest row
            # of the kind, not the filer's. Match by normalized
            # name within (event, kind) instead.
            existing = None
            for cand in db.execute(
                    "SELECT id, person_name FROM rsvps WHERE event_id=?"
                    " AND member_id IS NULL AND person_kind=?",
                    (eid, b["person_kind"])):
                if _norm_name(cand["person_name"]) \
                        == _norm_name(b.get("person_name")):
                    existing = cand
                    break
            if existing is not None:
                db.execute(
                    "UPDATE rsvps SET person_name=?, status=?,"
                    " created_at=datetime('now') WHERE id=?",
                    (b["person_name"], status, existing["id"]))
            else:
                db.execute(
                    "INSERT INTO rsvps (event_id, member_id, person_kind,"
                    " person_name, status) VALUES (?,?,?,?,?)",
                    (eid, None, b["person_kind"], b["person_name"], status))
        else:
            db.execute(
                """INSERT INTO rsvps (event_id, member_id, person_kind, person_name, status)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(event_id, member_id, person_kind)
                   DO UPDATE SET person_name=excluded.person_name, status=excluded.status,
                                 created_at=datetime('now')""",
                (eid, b.get("member_id"), b["person_kind"], b["person_name"], status))
        db.commit()
        if b.get("member_id") is None:
            r = None
            for cand in db.execute(
                    "SELECT * FROM rsvps WHERE event_id=? AND member_id"
                    " IS NULL AND person_kind=?",
                    (eid, b["person_kind"])):
                if _norm_name(cand["person_name"]) \
                        == _norm_name(b.get("person_name")):
                    r = cand
                    break
        else:
            r = db.execute(
                "SELECT * FROM rsvps WHERE event_id=? AND member_id=?"
                " AND person_kind=?",
                (eid, b["member_id"], b["person_kind"])).fetchone()
        # Only replace the day set when the client sent one — a
        # going re-file without days must not wipe a partial's
        # earlier picks, and a status-only change keeps them too.
        if days_in is not None and r:
            db.execute("DELETE FROM rsvp_days WHERE rsvp_id=?", (r["id"],))
            for d in days_in:
                db.execute("INSERT OR IGNORE INTO rsvp_days (rsvp_id, day)"
                           " VALUES (?,?)", (r["id"], d))
            db.commit()
            r = dict(r)
            r["days"] = sorted(days_in)
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


@app.route("/api/my-rsvps")
def api_my_rsvps():
    """The signed-in account's own RSVPs, for the calendar's RSVP'd-day
    marks: one row per RSVP in link scope (own student record + children
    a parent is linked to), plus name-matched rows for legacy name-only
    records. Days come from rsvp_days; an empty list means the RSVP
    covers every day of the event (going, or partial with no picks).
    The frontend marks going/partial days only."""
    u = current_user()
    if not u:
        return err("login required", 401)
    student_id, parent_ids = _self_rsvp_scope(u)
    ids = set(parent_ids)
    if student_id:
        ids.add(student_id)
    uname = _norm_name(u["name"])
    days = {}
    for d in q_all("SELECT rsvp_id, day FROM rsvp_days"):
        days.setdefault(d["rsvp_id"], []).append(d["day"])
    out = []
    for r in q_all("SELECT id, event_id, status, member_id, person_name"
                   " FROM rsvps"):
        if r["member_id"] in ids or _norm_name(r["person_name"]) == uname:
            out.append({"event_id": r["event_id"], "status": r["status"],
                        "days": sorted(days.get(r["id"], []))})
    return jsonify(out)


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
    # Per-day check-ins: a multi-day trip credits each day
    # separately, so the day is part of the check-in's identity.
    # Multi-day events require an explicit day; single-day events
    # default to their one date, dateless events to NULL. The
    # upsert is explicit (not ON CONFLICT) because NULL days on
    # dateless events would never conflict in SQLite's UNIQUE.
    ev = q_one("SELECT * FROM events WHERE id=?", (b["event_id"],))
    if not ev:
        return err("event not found", 404)
    event_days = _event_days(ev)
    day_in = (b.get("day") or "").strip() or None
    if len(event_days) > 1:
        if not day_in:
            return err("day is required for multi-day events")
        if day_in not in event_days:
            return err("day is not part of this event")
        day = day_in
    elif len(event_days) == 1:
        if day_in and day_in != event_days[0]:
            return err("day is not part of this event")
        day = event_days[0]
    else:
        day = None
    kind = b.get("person_kind", "student")
    with _lock:
        db = get_db()
        if day is None:
            existing = db.execute(
                "SELECT id FROM checkins WHERE event_id=? AND member_id=?"
                " AND person_kind=? AND day IS NULL",
                (b["event_id"], b["member_id"], kind)).fetchone()
        else:
            existing = db.execute(
                "SELECT id FROM checkins WHERE event_id=? AND member_id=?"
                " AND person_kind=? AND day=?",
                (b["event_id"], b["member_id"], kind, day)).fetchone()
        if existing:
            db.execute(
                "UPDATE checkins SET person_name=?, method=?, verified=?,"
                " hours=? WHERE id=?",
                (b["person_name"], method, verified, hours, existing["id"]))
        else:
            db.execute(
                "INSERT INTO checkins (event_id, member_id, person_kind,"
                " person_name, method, verified, hours, day)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (b["event_id"], b["member_id"], kind, b["person_name"],
                 method, verified, hours, day))
        db.commit()
    return jsonify({"ok": True, "verified": bool(verified), "day": day}), 201


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
    day = request.args.get("day")
    if day:
        # Pre-multi-day check-ins have day NULL: they belong to the
        # event's (single) day, so they show on the start-date tab
        # and nowhere else — otherwise upgrading would hide them.
        ev = q_one("SELECT date FROM events WHERE id=?", (eid,))
        if ev and ev.get("date") == day:
            return jsonify(q_all(
                "SELECT * FROM checkins WHERE event_id=? AND"
                " (day=? OR day IS NULL) ORDER BY id", (eid, day)))
        return jsonify(q_all(
            "SELECT * FROM checkins WHERE event_id=? AND day=? ORDER BY id",
            (eid, day)))
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
            """SELECT c.event_id, e.title, e.date, c.day, c.hours, c.verified, c.method
               FROM checkins c JOIN events e ON e.id = c.event_id
               WHERE c.member_id=? ORDER BY e.date, c.day""", (r["member_id"],))
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
    # The day this payload is FOR: ?day=, else the trip's first day,
    # else None for dateless events. Rides, seats, drivers, and the
    # attendees are all per-day; tools are per-trip and ignore it.
    # Hotel rooms carry their days and every occupant row (with its
    # day) so the frontend can build per-day rooms tables. Without
    # a day, a multi-day payload defaults to Day 1 rather than
    # mixing days incoherently.
    event_days = _event_days(ev)
    day = request.args.get("day")
    if day:
        if day not in event_days:
            return err("day is not part of this event")
    elif event_days:
        day = event_days[0]
    with _lock:
        db = get_db()
        rsvp_days = _rsvp_days_map(db, eid)
        carpool_days = _carpool_days_map(db, eid)
        van_overrides = _van_day_drivers_map(db, eid)
    all_carpools = q_all("SELECT * FROM carpools WHERE event_id=? ORDER BY id",
                         (eid,))
    for c in all_carpools:
        c["days"] = sorted(carpool_days.get(c["id"], set()))
        claims = q_all("SELECT * FROM carpool_claims WHERE carpool_id=?"
                       " ORDER BY created_at, id", (c["id"],))
        claims = [x for x in claims
                  if _claim_day_matches(x.get("day"), day)]
        c["claims"] = [x for x in claims if x["status"] == "claimed"]
        c["waitlist"] = [x for x in claims if x["status"] == "waitlisted"]
        c["seats_open"] = max(0, c["seats"] - len(c["claims"]))
    # Carpools shown are only the ones running on this day; the
    # full list goes out as all_carpools for the (per-trip) tools
    # section, which must not lose a car that runs another day.
    carpools = [c for c in all_carpools
                if _carpool_runs_day(carpool_days, c["id"], day)]
    # Team vans going to this event on this day: seats set, a driver
    # for this day (per-day override, else designated) who is
    # attending that day (going, or partial covering the day on a
    # multi-day event), and that driver not already driving a
    # carpool that day. Driverless or seatless vans stay tools-only
    # and never appear here.
    car_driver_uids = {c["driver_user_id"] for c in carpools
                       if c.get("driver_user_id")}
    event_vans = []
    for v in q_all("SELECT * FROM team_vans ORDER BY name"):
        if not v.get("seats"):
            continue
        day_driver = _van_driver_for_day(v, eid, day, van_overrides)
        if not day_driver:
            continue
        if day_driver in car_driver_uids:
            continue
        drv = q_one("SELECT name FROM users WHERE id=?", (day_driver,))
        if not drv:
            continue
        with _lock:
            db = get_db()
            attends = _parent_attends_day(db, eid, drv["name"], day,
                                          event_days)
        if not attends:
            continue
        claims = q_all("SELECT * FROM van_claims WHERE van_id=? AND"
                       " event_id=? ORDER BY created_at, id",
                       (v["id"], eid))
        claims = [x for x in claims
                  if _claim_day_matches(x.get("day"), day)]
        v["designated_driver_user_id"] = v.get("driver_user_id")
        v["driver_user_id"] = day_driver
        v["day_driver_override"] = bool(
            day is not None and (v["id"], day) in van_overrides)
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
        with _lock:
            db = get_db()
            room_days = _room_days_map(db, hotel["id"])
        for rm in rooms:
            # Days this room is allocated for (empty = every day),
            # and every occupant row with its day — the frontend
            # filters both per day, since rooms are day tables now
            # like carpools. Occupants are NOT day-filtered here:
            # a day table needs its own day's rows, and the payload
            # is small.
            rm["days"] = sorted(room_days.get(rm["id"], set()))
            rm["occupants"] = q_all(
                """SELECT o.id, o.member_id, o.day, o.person_name,
                   m.first_name, m.last_name
                   FROM room_occupants o LEFT JOIN members m
                   ON m.id = o.member_id
                   WHERE o.room_id=? ORDER BY o.id""", (rm["id"],))
        hotel["rooms"] = rooms
        reqs = q_all(
            """SELECT r.*, m.first_name, m.last_name
               FROM rooming_requests r JOIN members m ON m.id = r.member_id
               WHERE r.hotel_id=? ORDER BY r.created_at, r.id""", (hotel["id"],))
        hotel["requests"] = reqs
        hotel["awaiting"] = sum(1 for x in reqs if x["status"] == "pending")
    # attendees = attending ON THIS DAY (rides, ride status, seat
    # pickers). all_attendees = attending the trip at all (hotel
    # rooms and room status are per-trip, not per-day, so they must
    # not lose a student who only attends another day).
    all_rsvps = q_all(
        "SELECT id, member_id, person_kind, person_name, status FROM rsvps"
        " WHERE event_id=? AND status IN ('going','partial')"
        " ORDER BY person_name", (eid,))
    # Status + covered days ride along so the Logistics status table
    # can show each row's RSVP basis ("going" vs "partial · Sun
    # 11/22, Mon 11/23"): a "wrong status" complaint is then
    # self-diagnosing — the row itself says which record drives it.
    all_attendees = [{"member_id": r["member_id"],
                      "person_kind": r["person_kind"],
                      "person_name": r["person_name"],
                      "status": r["status"],
                      "days": sorted(rsvp_days.get(r["id"], set()))}
                     for r in all_rsvps]
    attendees = [a for a, r in zip(all_attendees, all_rsvps)
                 if _attends_day(r["status"],
                                 rsvp_days.get(r["id"], set()),
                                 day, event_days)]
    parent_names = sorted({m["parent_name"] for m in q_all(
        "SELECT parent_name FROM members WHERE parent_name IS NOT NULL"
        " AND parent_name != ''") if m["parent_name"]})
    # Who the caller is for the Fleet / Post Ride rules: their own
    # registered car (one per driver per event) and whether they
    # drive a team van on any day of this event. The frontend hides
    # the Post Ride form on this; the server enforces it regardless.
    me = current_user()
    me_info = None
    if me:
        my_car = q_one("SELECT id FROM carpools WHERE event_id=? AND"
                       " driver_user_id=?", (eid, me["id"]))
        van_driver = False
        for v in q_all("SELECT * FROM team_vans WHERE seats IS NOT NULL"):
            for d in (event_days or [None]):
                if _van_driver_for_day(v, eid, d, van_overrides) == me["id"]:
                    van_driver = True
        me_info = {"carpool_id": my_car["id"] if my_car else None,
                   "van_driver": van_driver}
    return jsonify({"event": ev, "carpools": carpools, "tools": tools,
                    "parent_names": parent_names, "event_vans": event_vans,
                    "hotel": hotel, "attendees": attendees,
                    "all_attendees": all_attendees,
                    "all_carpools": all_carpools,
                    "days": event_days, "day": day, "me": me_info})


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


def _may_act_for(u, member_id, person_kind, person_name=None):
    """Self-only rule for seats and beds: mentors/admins may act for
    anyone; everyone else only for themself. A student acts only
    for their own student row; a parent acts only for their own
    rider row (kind 'parent' — a parent's own rider row carries
    their linked child's member_id, so the gate is on kind, not the
    link; a 'student' row is the child's, never the parent's).
    Name-only rows (member_id None, legacy) match by the caller's
    own account name, or — for a parent's own rider row — by the
    roster parent_name recorded on a linked child. Children sign up
    through their own student accounts, or a mentor does it for
    them. This is the server enforcement behind every
    claim/place/release button: the pickers are filtered too, but a
    crafted request can't seat or unseat someone else's student."""
    if not u:
        return False
    if u["role"] in ("mentor", "admin"):
        return True
    student_id, parent_ids = _self_rsvp_scope(u)
    if member_id is not None:
        try:
            member_id = int(member_id)
        except (TypeError, ValueError):
            return False
        if u["role"] == "student":
            return person_kind == "student" and member_id == student_id
        if u["role"] == "parent":
            return person_kind == "parent" and member_id in parent_ids
        return False
    if person_name:
        if _norm_name(person_name) == _norm_name(u["name"]):
            if u["role"] == "student":
                return person_kind == "student"
            if u["role"] == "parent":
                return person_kind == "parent"
        if u["role"] == "parent" and person_kind == "parent":
            # A parent's own rider row filed under the roster
            # parent_name, which may differ from the account name.
            for row in q_all(
                    "SELECT m.parent_name FROM user_members um"
                    " JOIN members m ON m.id = um.member_id"
                    " WHERE um.user_id=? AND um.kind='parent'",
                    (u["id"],)):
                if _norm_name(person_name) == _norm_name(
                        row["parent_name"] or ""):
                    return True
    return False


def _claim_matches(row, member_id, person_kind, person_name):
    if row["person_kind"] != person_kind:
        return False
    if (member_id and row["member_id"]
            and row["member_id"] == member_id):
        return True
    return bool(person_name and row["person_name"]
                and _norm_name(row["person_name"]) == _norm_name(person_name))


# ----------------------------------------------------------------------------
# Multi-day trips: every per-day rule lives here. An event's days are
# [date .. end_date] inclusive, or [date] when end_date is empty, or
# [] when the event has no date at all (day=None then means the whole
# event, which is the pre-multi-day behavior). NULL/empty day sets
# mean "all days": a carpool with no carpool_days rows runs every day,
# a claim with day NULL holds a seat every day, and a partial RSVP
# with no rsvp_days rows attends every day. New rows always get a
# concrete day when the event has days, so NULL only survives from
# pre-multi-day data — and every helper treats NULL as all-days, so
# old data keeps working untouched.
# ----------------------------------------------------------------------------
def _parse_ymd(s):
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _event_days(ev):
    """Sorted YYYY-MM-DD days for an event (empty if dateless)."""
    if not ev or not ev.get("date"):
        return []
    d0 = _parse_ymd(ev["date"])
    if not d0:
        return []
    d1 = _parse_ymd(ev.get("end_date")) if ev.get("end_date") else d0
    if not d1 or d1 < d0:
        return [ev["date"]]
    days = []
    d = d0
    while d <= d1 and len(days) <= 31:
        days.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return days


def _validate_event_range(date_s, end_s):
    """Error string for a bad (date, end_date) pair, else None."""
    if end_s:
        d0, d1 = _parse_ymd(date_s), _parse_ymd(end_s)
        if not d1:
            return "end_date must be YYYY-MM-DD"
        if d0 and d1 < d0:
            return "end_date can't be before the start date"
        if d0 and (d1 - d0).days > 30:
            return "multi-day events are at most 31 days"
    return None


def _validate_days_input(days_in, event_days):
    """Clean a client-supplied day list: deduped, sorted, subset of
    the event's days. Returns (days, error): days is None when the
    client sent nothing (meaning all days), [] when they sent an
    empty list (also all days), or the cleaned list."""
    if days_in is None:
        return None, None
    if not isinstance(days_in, list):
        return None, "days must be a list of dates"
    cleaned = sorted({str(d) for d in days_in if str(d).strip()})
    if not event_days:
        if cleaned:
            return None, "this event has no days to pick from"
        return [], None
    bad = [d for d in cleaned if d not in event_days]
    if bad:
        return None, f"day {bad[0]} is not part of this event"
    return cleaned, None


def _attends_day(status, stored_days, day, event_days):
    """Does an RSVP with this status + stored day set attend `day`?
    day=None means the whole event (pre-multi-day callers). Going =
    every day. Partial with no stored days = every day (legacy
    meaning). Otherwise the day must be in the stored set."""
    if status not in ("going", "partial"):
        return False
    if day is None:
        return True
    if event_days and day not in event_days:
        return False
    if status == "going":
        return True
    if not stored_days:
        return True
    return day in stored_days


def _rsvp_days_map(db, eid):
    """rsvp_id -> set of days, for one event's RSVPs."""
    out = {}
    for r in db.execute(
            "SELECT rd.rsvp_id, rd.day FROM rsvp_days rd"
            " JOIN rsvps r ON r.id = rd.rsvp_id WHERE r.event_id=?",
            (eid,)):
        out.setdefault(r["rsvp_id"], set()).add(r["day"])
    return out


def _carpool_days_map(db, eid):
    """carpool_id -> set of days (empty set = runs every day)."""
    out = {}
    for c in db.execute("SELECT id FROM carpools WHERE event_id=?",
                        (eid,)):
        out[c["id"]] = set()
    for r in db.execute(
            "SELECT cd.carpool_id, cd.day FROM carpool_days cd"
            " JOIN carpools c ON c.id = cd.carpool_id"
            " WHERE c.event_id=?", (eid,)):
        out.setdefault(r["carpool_id"], set()).add(r["day"])
    return out


def _carpool_runs_day(days_map, cid, day):
    if day is None:
        return True
    days = days_map.get(cid)
    if days is None:
        return True
    return not days or day in days


def _room_days_map(db, hid):
    """room_id -> set of days (empty set = allocated every day)."""
    out = {}
    for r in db.execute("SELECT id FROM rooms WHERE hotel_id=?",
                        (hid,)):
        out[r["id"]] = set()
    for r in db.execute(
            "SELECT rd.room_id, rd.day FROM room_days rd"
            " JOIN rooms r ON r.id = rd.room_id"
            " WHERE r.hotel_id=?", (hid,)):
        out.setdefault(r["room_id"], set()).add(r["day"])
    return out


def _room_runs_day(days_map, rid, day):
    """Mirror of _carpool_runs_day, for rooms."""
    if day is None:
        return True
    days = days_map.get(rid)
    if days is None:
        return True
    return not days or day in days


def _occupant_day_matches(occ_day, day):
    """An occupant row covers `day` when it is an all-days row
    (NULL) or its day equals it. day=None matches every row."""
    if day is None:
        return True
    return occ_day is None or occ_day == day


def _days_overlap(days_a, days_b, event_days):
    """Do two day sets overlap? An empty set means every day, and
    an empty event_days (dateless) means the whole event overlaps."""
    if not event_days:
        return True
    set_a = set(days_a) if days_a else set(event_days)
    set_b = set(days_b) if days_b else set(event_days)
    return bool(set_a & set_b)


def _van_day_drivers_map(db, eid):
    """(van_id, day) -> driver_user_id override for this event."""
    return {(r["van_id"], r["day"]): r["driver_user_id"]
            for r in db.execute(
                "SELECT van_id, day, driver_user_id FROM van_day_drivers"
                " WHERE event_id=?", (eid,))}


def _van_driver_for_day(van, eid, day, overrides):
    """The van's driver for a trip day: the per-day override if one
    exists, else the designated driver. Returns a user id or None.
    Accepts both dict rows (q_*) and raw sqlite Rows."""
    try:
        designated = van.get("driver_user_id")
    except AttributeError:
        designated = van["driver_user_id"]
    if day is not None and overrides is not None:
        ov = overrides.get((van["id"], day))
        if ov:
            return ov
    return designated


def _parent_attends_day(db, eid, parent_name, day, event_days):
    """A parent RSVP (going, or partial covering the day on a
    multi-day event) with this name, for driver eligibility. On a
    single-day event only 'going' counts — the old rule, unchanged."""
    multi = len(event_days) > 1
    days_map = _rsvp_days_map(db, eid)
    for r in db.execute(
            "SELECT id, person_name, status FROM rsvps WHERE event_id=?"
            " AND person_kind='parent'", (eid,)):
        if _norm_name(r["person_name"]) != _norm_name(parent_name):
            continue
        if r["status"] == "going":
            return True
        if multi and r["status"] == "partial" and _attends_day(
                "partial", days_map.get(r["id"], set()), day, event_days):
            return True
    return False


def _event_driver_names_day(db, eid, day, event_days):
    """Normalized names of everyone driving on `day`: carpool
    drivers whose car runs that day, plus drivers of seated vans
    for that day (override or designated). day=None = whole event
    (the old _event_driver_names behavior, kept for callers that
    don't pass a day)."""
    names = set()
    days_map = _carpool_days_map(db, eid) if day is not None else {}
    for r in db.execute("SELECT id, driver_name FROM carpools"
                        " WHERE event_id=?", (eid,)):
        if r["driver_name"] and (day is None or _carpool_runs_day(
                days_map, r["id"], day)):
            names.add(_norm_name(r["driver_name"]))
    overrides = _van_day_drivers_map(db, eid) if day is not None else {}
    for v in db.execute("SELECT id, driver_user_id FROM team_vans"
                        " WHERE seats IS NOT NULL"
                        " AND driver_user_id IS NOT NULL"):
        drv = _van_driver_for_day(v, eid, day, overrides) if day is not None \
            else v["driver_user_id"]
        if not drv:
            continue
        u = db.execute("SELECT name FROM users WHERE id=?",
                       (drv,)).fetchone()
        if u and u["name"]:
            names.add(_norm_name(u["name"]))
    return names


def _is_driver_day(db, eid, day, event_days, person_kind, person_name):
    """True if this person is driving on `day`. Only parents drive,
    so a student name never matches, even if it coincides."""
    if person_kind != "parent" or not person_name:
        return False
    return _norm_name(person_name) in _event_driver_names_day(
        db, eid, day, event_days)


def _claim_day_matches(claim_day, day):
    """A claim row covers `day` when it is an all-days row (NULL) or
    its day equals it. day=None (dateless/single-day legacy callers)
    matches every row."""
    if day is None:
        return True
    return claim_day is None or claim_day == day


def _has_claimed_seat_day(db, eid, member_id, person_kind, person_name,
                          day):
    """One seat per person per DAY, across every vehicle: a claimed
    seat on any carpool or van covering that day blocks another
    claim for the same day. A seat on a different day does not."""
    for r in db.execute(
            "SELECT cc.member_id, cc.person_kind, cc.person_name, cc.day"
            " FROM carpool_claims cc JOIN carpools c ON c.id = cc.carpool_id"
            " WHERE c.event_id=? AND cc.status='claimed'", (eid,)):
        if _claim_day_matches(r["day"], day) and _claim_matches(
                r, member_id, person_kind, person_name):
            return True
    for r in db.execute(
            "SELECT member_id, person_kind, person_name, day FROM van_claims"
            " WHERE event_id=? AND status='claimed'", (eid,)):
        if _claim_day_matches(r["day"], day) and _claim_matches(
                r, member_id, person_kind, person_name):
            return True
    return False


def _move_claims_db(db, eid, member_id, person_kind, person_name, day,
                    event_days):
    """Re-assign (move) a rider's seat: delete the person's existing
    claimed/waitlisted rows covering `day` on every vehicle, so the
    caller can insert the new claim right after, in the same lock,
    making the move atomic. A freed claimed seat promotes that
    vehicle's first eligible waitlisted rider, exactly like a
    release. Returns True when anything moved. Same-vehicle
    duplicates are rejected before this runs, so every row removed
    here sits on another vehicle."""
    moved = False
    for row in db.execute(
            "SELECT cc.* FROM carpool_claims cc JOIN carpools c"
            " ON c.id = cc.carpool_id WHERE c.event_id=?", (eid,)):
        if _claim_day_matches(row["day"], day) and _claim_matches(
                row, member_id, person_kind, person_name):
            db.execute("DELETE FROM carpool_claims WHERE id=?",
                       (row["id"],))
            moved = True
            if row["status"] == "claimed":
                _promote_waitlist_db(db, "carpool", row["carpool_id"],
                                     eid, row["day"], event_days)
    for row in db.execute(
            "SELECT * FROM van_claims WHERE event_id=?", (eid,)):
        if _claim_day_matches(row["day"], day) and _claim_matches(
                row, member_id, person_kind, person_name):
            db.execute("DELETE FROM van_claims WHERE id=?", (row["id"],))
            moved = True
            if row["status"] == "claimed":
                _promote_waitlist_db(db, "van", row["van_id"],
                                     eid, row["day"], event_days)
    return moved


def _claimed_count_day(db, table, id_col, vid, day):
    """Claimed seats on one vehicle for one day (NULL-day rows count
    on every day)."""
    rows = db.execute(
        f"SELECT day FROM {table} WHERE {id_col}=? AND status='claimed'",
        (vid,)).fetchall()
    return sum(1 for r in rows if _claim_day_matches(r["day"], day))


def _promote_waitlist_db(db, vehicle_type, vid, eid, deleted_day,
                         event_days):
    """Promote waitlisted riders after a claimed seat is freed.
    Same-day buckets only: freeing a Day-1 seat promotes a Day-1
    waitlist row, never a Day-3 one. A freed all-days (NULL) seat
    promotes the first all-days waitlist row if there is one (it
    fills every day); otherwise one row per event day. A candidate
    is skipped if they have since become a driver for that day or
    been seated elsewhere for that day. Returns the promoted row
    dict, or a list of them for the all-days case, or None. Takes a
    raw db connection — callers inside _lock must not go through
    q_* (which re-locks)."""
    if vehicle_type == "carpool":
        tbl, id_col = "carpool_claims", "carpool_id"
    else:
        tbl, id_col = "van_claims", "van_id"

    def waitlisted(day):
        sql = (f"SELECT * FROM {tbl} WHERE {id_col}=? AND"
               " status='waitlisted'")
        args = [vid]
        if vehicle_type == "van":
            # Van claims are keyed by (van, event): never promote a
            # waitlist row from a different event into this one.
            sql += " AND event_id=?"
            args.append(eid)
        if day is None:
            sql += " AND day IS NULL"
        else:
            sql += " AND day=?"
            args.append(day)
        return [dict(r) for r in db.execute(sql, args).fetchall()]

    def eligible(nxt, day):
        if _is_driver_day(db, eid, day, event_days, nxt["person_kind"],
                          nxt["person_name"]):
            return False
        return not _has_claimed_seat_day(
            db, eid, nxt["member_id"], nxt["person_kind"],
            nxt["person_name"], day)

    def promote_one(day):
        for nxt in waitlisted(day):
            if eligible(nxt, day):
                db.execute(f"UPDATE {tbl} SET status='claimed' WHERE id=?",
                           (nxt["id"],))
                return dict(nxt)
        return None

    if deleted_day is not None:
        return promote_one(deleted_day)
    # All-days seat freed: an all-days waitlist row fills every day.
    p = promote_one(None)
    if p:
        return p
    promoted = []
    for day in event_days:
        p = promote_one(day)
        if p:
            promoted.append(p)
    return promoted or None


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
    # Driver resolution — one vehicle per driver per event, and the
    # driver is always the session user: mentors post their own
    # vehicle too, and posting for another parent is disabled.
    if b.get("driver_user_id") and b.get("driver_user_id") != me["id"]:
        return err("you can only post your own vehicle", 403)
    driver_uid, driver_name = me["id"], me["name"]
    ev = q_one("SELECT * FROM events WHERE id=?", (b["event_id"],))
    if not ev:
        return err("event not found", 404)
    event_days = _event_days(ev)
    days_in, days_err = _validate_days_input(b.get("days"), event_days)
    if days_err:
        return err(days_err)
    run_days = days_in if days_in else event_days
    # A driver must be attending on every day the car runs: 'going',
    # or (multi-day only) a partial covering that day. Mentors skip
    # this check: staff attendance isn't tracked via parent RSVPs,
    # and a mentor driving their own car is attending by definition.
    if me["role"] not in MENTOR_ROLES:
        with _lock:
            db = get_db()
            for d in (run_days or [None]):
                if not _parent_attends_day(db, b["event_id"], driver_name,
                                           d, event_days):
                    return err("the driver must RSVP as attending for"
                               " every day the car runs")
    # One vehicle per driver per EVENT: a driver who already
    # registered a car for this event can't post a second one, even
    # for different days — they edit the registered vehicle instead.
    # Likewise a driver tied to a team van on ANY day of the event
    # can't also register a carpool: one driver, one vehicle.
    with _lock:
        db = get_db()
        if db.execute(
                "SELECT id FROM carpools WHERE event_id=?"
                " AND driver_user_id=?",
                (b["event_id"], driver_uid)).fetchone():
            return err("you already registered a vehicle for this event",
                       409)
        van_overrides = _van_day_drivers_map(db, b["event_id"])
        for v in db.execute(
                "SELECT id, driver_user_id FROM team_vans"
                " WHERE seats IS NOT NULL"):
            for d in (event_days or [None]):
                if _van_driver_for_day(v, b["event_id"], d,
                                       van_overrides) == driver_uid:
                    return err("that parent is already driving a team"
                               " van for this event")
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
    if days_in:
        for d in days_in:
            execute("INSERT OR IGNORE INTO carpool_days (carpool_id, day)"
                    " VALUES (?,?)", (cid, d))
    out = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    out["days"] = sorted(days_in) if days_in else []
    return jsonify(out), 201


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
    ev = q_one("SELECT * FROM events WHERE id=?", (c["event_id"],))
    event_days = _event_days(ev) if ev else []
    # Days the car runs can be edited like any other field: an empty
    # list (or omitting days) means every day.
    new_days = None
    if "days" in b:
        new_days, days_err = _validate_days_input(b["days"], event_days)
        if days_err:
            return err(days_err)
    if "seats" in b:
        try:
            seats = int(b["seats"])
        except (TypeError, ValueError):
            return err("seats must be a number")
        if seats < 1:
            return err("seats required")
        # Seats are per-day capacity, so the floor is the busiest
        # day's claimed count (all-days rows count on every day),
        # not the total across days.
        with _lock:
            db = get_db()
            rows = db.execute(
                "SELECT day FROM carpool_claims WHERE carpool_id=?"
                " AND status='claimed'", (cid,)).fetchall()
        busiest = 0
        for d in (event_days or [None]):
            busiest = max(busiest, sum(
                1 for r in rows if _claim_day_matches(r["day"], d)))
        if seats < busiest:
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
    # The driver is fixed at registration: nobody (mentor included)
    # can reassign a car to another driver — remove the vehicle and
    # register a new one instead. Changing the days re-checks the
    # driver against the new days, so a car can't be moved onto a
    # day its driver doesn't attend or already drives a van on.
    # Mentors skip the RSVP check, as in POST.
    if b.get("driver_user_id") and b.get("driver_user_id") != c.get("driver_user_id"):
        return err("the driver can't be changed", 400)
    if new_days is not None:
        check_days = new_days if new_days else event_days
        with _lock:
            db = get_db()
            if me["role"] not in MENTOR_ROLES:
                for d in (check_days or [None]):
                    if not _parent_attends_day(db, c["event_id"],
                                               c["driver_name"], d, event_days):
                        return err("the driver must RSVP as attending for"
                                   " every day the car runs")
            if c.get("driver_user_id"):
                van_overrides = _van_day_drivers_map(db, c["event_id"])
                for v in db.execute(
                        "SELECT id, driver_user_id FROM team_vans"
                        " WHERE seats IS NOT NULL"):
                    for d in (check_days or [None]):
                        if _van_driver_for_day(v, c["event_id"], d,
                                               van_overrides) == c["driver_user_id"]:
                            return err("the driver is already driving a team"
                                       " van on one of those days")
    if not sets and new_days is None:
        return err("nothing to update")
    if sets:
        execute(f"UPDATE carpools SET {', '.join(sets)} WHERE id=?",
                (*args, cid))
    if new_days is not None:
        with _lock:
            db = get_db()
            db.execute("DELETE FROM carpool_days WHERE carpool_id=?",
                       (cid,))
            for d in new_days:
                db.execute("INSERT OR IGNORE INTO carpool_days"
                           " (carpool_id, day) VALUES (?,?)", (cid, d))
            db.commit()
    out = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    out["days"] = sorted(new_days) if new_days is not None else None
    if out["days"] is None:
        with _lock:
            db = get_db()
            out["days"] = sorted({r["day"] for r in db.execute(
                "SELECT day FROM carpool_days WHERE carpool_id=?",
                (cid,))})
    return jsonify(out)


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
        db.execute("DELETE FROM carpool_days WHERE carpool_id=?", (cid,))
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
    u = current_user()
    if not u:
        return err("login required", 401)
    if not _may_act_for(u, b.get("member_id"), b.get("person_kind"),
                        b.get("person_name")):
        return err("you can only claim a seat for yourself", 403)
    ev = q_one("SELECT * FROM events WHERE id=?", (c["event_id"],))
    event_days = _event_days(ev) if ev else []
    # The day claimed: required on multi-day events (a seat is
    # per-day), defaulted to the one date on single-day events.
    day_in = (b.get("day") or "").strip() or None
    if len(event_days) > 1:
        if not day_in:
            return err("day is required for multi-day events"
                       " — pick a day")
        if day_in not in event_days:
            return err("day is not part of this event")
        day = day_in
    elif len(event_days) == 1:
        if day_in and day_in != event_days[0]:
            return err("day is not part of this event")
        day = event_days[0]
    else:
        day = None
    with _lock:
        db = get_db()
        if not _carpool_runs_day(_carpool_days_map(db, c["event_id"]),
                                 cid, day):
            return err("this car isn't running on that day", 400)
        # Attending ON THAT DAY, not just the trip: a partial
        # attending only Day 3 can't claim a Day 1 seat.
        days_map = _rsvp_days_map(db, c["event_id"])
        rsvp = db.execute(
            "SELECT id, status FROM rsvps WHERE event_id=? AND member_id"
            + (" IS NULL" if b.get("member_id") is None else "=?")
            + " AND person_kind=?",
            tuple([c["event_id"]]
                  + ([] if b.get("member_id") is None else [b["member_id"]])
                  + [b.get("person_kind")])).fetchone()
        if not rsvp or not _attends_day(rsvp["status"],
                                        days_map.get(rsvp["id"], set()),
                                        day, event_days):
            return err("only people attending on that day can claim a"
                       " seat — RSVP for that day first")
        # One row per person per carpool per day: a second claim used
        # to land in the waitlist while the person already held a
        # seat (or vice versa). A row for another day doesn't count.
        if b.get("member_id"):
            dup = db.execute(
                "SELECT id, day FROM carpool_claims WHERE carpool_id=? AND"
                " member_id=? AND person_kind=?",
                (cid, b["member_id"], b.get("person_kind"))).fetchall()
        else:
            dup = db.execute(
                "SELECT id, day FROM carpool_claims WHERE carpool_id=? AND"
                " member_id IS NULL AND person_name=? AND person_kind=?",
                (cid, b["person_name"], b.get("person_kind"))).fetchall()
        if any(_claim_day_matches(r["day"], day) for r in dup):
            return err("already on this ride — claimed or waitlisted", 409)
        # A driver can't also be a rider on a day they're driving:
        # not in their own car, and not in anyone else's.
        if _is_driver_day(db, c["event_id"], day, event_days,
                          b.get("person_kind"), b["person_name"]):
            return err("drivers can't claim a seat on a day they're"
                       " driving", 403)
        # Re-assign (move): claiming on another vehicle for the same
        # day moves the rider instead of 409ing — except a move from
        # a confirmed seat into a full vehicle, which would silently
        # downgrade the seat to a waitlist spot, so that keeps the
        # old seat and 409s.
        taken = _claimed_count_day(db, "carpool_claims", "carpool_id",
                                   cid, day)
        if taken >= c["seats"] and _has_claimed_seat_day(
                db, c["event_id"], b.get("member_id"), b.get("person_kind"),
                b.get("person_name"), day):
            return err("that ride is full for that day — your current"
                       " seat is kept", 409)
        moved = _move_claims_db(db, c["event_id"], b.get("member_id"),
                                b.get("person_kind"), b.get("person_name"),
                                day, event_days)
        status = "claimed" if taken < c["seats"] else "waitlisted"
        cur = db.execute(
            "INSERT INTO carpool_claims (carpool_id, member_id, person_kind,"
            " person_name, status, day) VALUES (?,?,?,?,?,?)",
            (cid, b.get("member_id"), b.get("person_kind"), b["person_name"],
             status, day))
        db.commit()
        clid = cur.lastrowid
    d = dict(q_one("SELECT * FROM carpool_claims WHERE id=?", (clid,)))
    d["moved"] = moved
    return jsonify(d), 201


@app.route("/api/carpool_claims/<int:clid>", methods=["DELETE"])
def api_carpool_claim_delete(clid):
    cl = q_one("SELECT * FROM carpool_claims WHERE id=?", (clid,))
    if not cl:
        return err("claim not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if not _may_act_for(u, cl["member_id"], cl["person_kind"],
                        cl["person_name"]):
        return err("you can only release your own seat", 403)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM carpool_claims WHERE id=?", (clid,))
        promoted = None
        if cl["status"] == "claimed":
            ev_row = db.execute("SELECT event_id FROM carpools WHERE id=?",
                                (cl["carpool_id"],)).fetchone()
            eid = ev_row["event_id"] if ev_row else None
            if eid is not None:
                ev = db.execute("SELECT * FROM events WHERE id=?",
                                (eid,)).fetchone()
                event_days = _event_days(dict(ev)) if ev else []
                promoted = _promote_waitlist_db(
                    db, "carpool", cl["carpool_id"], eid,
                    cl.get("day"), event_days)
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
    """True if this parent drives the vehicle: their own carpool, or
    a team van they are designated to drive — or drive on any day
    of any event via a per-day override. Mentors are handled by the
    caller, not here."""
    if vehicle_type == "carpool":
        c = q_one("SELECT driver_user_id FROM carpools WHERE id=?",
                  (vehicle_id,))
        return c is not None and c["driver_user_id"] == me["id"]
    if vehicle_type == "van":
        v = q_one("SELECT driver_user_id FROM team_vans WHERE id=?",
                  (vehicle_id,))
        if v is not None and v["driver_user_id"] == me["id"]:
            return True
        return q_one("SELECT driver_user_id FROM van_day_drivers"
                     " WHERE van_id=? AND driver_user_id=?",
                     (vehicle_id, me["id"])) is not None
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
        # One driver, one vehicle: a parent designated on another
        # seated van can't drive this one too (seatless vans are
        # tools-only, not driving, so they don't count).
        clash = q_one("SELECT name FROM team_vans WHERE driver_user_id=?"
                      " AND seats IS NOT NULL", (drv["id"],))
        if clash:
            return err(f"that parent is already the driver of team van"
                       f" {clash['name']}", 409)
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
            clash = q_one("SELECT name FROM team_vans WHERE driver_user_id=?"
                          " AND seats IS NOT NULL AND id != ?",
                          (drv["id"], vid))
            if clash:
                return err(f"that parent is already the driver of team van"
                           f" {clash['name']}", 409)
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
        db.execute("DELETE FROM van_day_drivers WHERE van_id=?", (vid,))
        db.execute("DELETE FROM team_vans WHERE id=?", (vid,))
        db.commit()
    return jsonify({"deleted": vid, "tools_unassigned": tu,
                    "claims_removed": nc})


@app.route("/api/vans/<int:vid>/claims", methods=["POST"])
def api_van_claim(vid):
    """A student (or parent) rides in a team van for an event on one
    day. The van takes riders only when it has seats AND a driver
    for that day (per-day override, else designated) who is
    attending that day — and that driver isn't already driving a
    carpool that day. Otherwise the van is tools-only for that day.
    Capacity, waitlist, and dedupe mirror carpool seats, per day."""
    v = q_one("SELECT * FROM team_vans WHERE id=?", (vid,))
    if not v:
        return err("team van not found", 404)
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("person_name"):
        return err("event_id and person_name required")
    u = current_user()
    if not u:
        return err("login required", 401)
    if not _may_act_for(u, b.get("member_id"), b.get("person_kind"),
                        b.get("person_name")):
        return err("you can only claim a seat for yourself", 403)
    if not v.get("seats"):
        return err("this van doesn't take riders — set its seats first")
    ev = q_one("SELECT * FROM events WHERE id=?", (b["event_id"],))
    if not ev:
        return err("event not found", 404)
    event_days = _event_days(ev)
    day_in = (b.get("day") or "").strip() or None
    if len(event_days) > 1:
        if not day_in:
            return err("day is required for multi-day events"
                       " — pick a day")
        if day_in not in event_days:
            return err("day is not part of this event")
        day = day_in
    elif len(event_days) == 1:
        if day_in and day_in != event_days[0]:
            return err("day is not part of this event")
        day = event_days[0]
    else:
        day = None
    with _lock:
        db = get_db()
        day_driver = _van_driver_for_day(
            v, b["event_id"], day, _van_day_drivers_map(db, b["event_id"]))
        if not day_driver:
            return err("this van has no driver for that day yet")
        drv = db.execute("SELECT id, name FROM users WHERE id=?",
                         (day_driver,)).fetchone()
        if not drv:
            return err("this van has no driver for that day yet")
        if not _parent_attends_day(db, b["event_id"], drv["name"], day,
                                   event_days):
            return err("the van's driver must RSVP as attending for"
                       " that day first")
        car_days = _carpool_days_map(db, b["event_id"])
        for c in db.execute(
                "SELECT id FROM carpools WHERE event_id=? AND"
                " driver_user_id=?", (b["event_id"], drv["id"])):
            if _carpool_runs_day(car_days, c["id"], day):
                return err("the van's driver is already driving a"
                           " carpool on that day")
        days_map = _rsvp_days_map(db, b["event_id"])
        rsvp = db.execute(
            "SELECT id, status FROM rsvps WHERE event_id=? AND member_id"
            + (" IS NULL" if b.get("member_id") is None else "=?")
            + " AND person_kind=?",
            tuple([b["event_id"]]
                  + ([] if b.get("member_id") is None else [b["member_id"]])
                  + [b.get("person_kind")])).fetchone()
        if not rsvp or not _attends_day(rsvp["status"],
                                        days_map.get(rsvp["id"], set()),
                                        day, event_days):
            return err("only people attending on that day can ride"
                       " — RSVP for that day first")
        if b.get("member_id"):
            dup = db.execute(
                "SELECT id, day FROM van_claims WHERE van_id=? AND event_id=?"
                " AND member_id=? AND person_kind=?",
                (vid, b["event_id"], b["member_id"],
                 b.get("person_kind"))).fetchall()
        else:
            dup = db.execute(
                "SELECT id, day FROM van_claims WHERE van_id=? AND event_id=?"
                " AND member_id IS NULL AND person_name=? AND person_kind=?",
                (vid, b["event_id"], b["person_name"],
                 b.get("person_kind"))).fetchall()
        if any(_claim_day_matches(r["day"], day) for r in dup):
            return err("already riding in this van — claimed or waitlisted",
                       409)
        if _is_driver_day(db, b["event_id"], day, event_days,
                          b.get("person_kind"), b["person_name"]):
            return err("drivers can't claim a seat on a day they're"
                       " driving", 403)
        # Re-assign (move), mirroring carpools: claiming on another
        # vehicle for the same day moves the rider instead of 409ing,
        # except a move from a confirmed seat into a full vehicle,
        # which keeps the old seat and 409s.
        # Van capacity is per (van, event, day), scoped to this event.
        taken = sum(1 for r in db.execute(
            "SELECT day FROM van_claims WHERE van_id=? AND event_id=?"
            " AND status='claimed'", (vid, b["event_id"])).fetchall()
            if _claim_day_matches(r["day"], day))
        if taken >= v["seats"] and _has_claimed_seat_day(
                db, b["event_id"], b.get("member_id"), b.get("person_kind"),
                b.get("person_name"), day):
            return err("that ride is full for that day — your current"
                       " seat is kept", 409)
        moved = _move_claims_db(db, b["event_id"], b.get("member_id"),
                                b.get("person_kind"), b.get("person_name"),
                                day, event_days)
        status = "claimed" if taken < v["seats"] else "waitlisted"
        cur = db.execute(
            "INSERT INTO van_claims (van_id, event_id, member_id,"
            " person_kind, person_name, status, day) VALUES (?,?,?,?,?,?,?)",
            (vid, b["event_id"], b.get("member_id"), b.get("person_kind"),
             b["person_name"], status, day))
        db.commit()
        clid = cur.lastrowid
    d = dict(q_one("SELECT * FROM van_claims WHERE id=?", (clid,)))
    d["moved"] = moved
    return jsonify(d), 201


@app.route("/api/van_claims/<int:clid>", methods=["DELETE"])
def api_van_claim_delete(clid):
    cl = q_one("SELECT * FROM van_claims WHERE id=?", (clid,))
    if not cl:
        return err("claim not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if not _may_act_for(u, cl["member_id"], cl["person_kind"],
                        cl["person_name"]):
        return err("you can only release your own seat", 403)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM van_claims WHERE id=?", (clid,))
        promoted = None
        if cl["status"] == "claimed":
            ev = db.execute("SELECT * FROM events WHERE id=?",
                            (cl["event_id"],)).fetchone()
            event_days = _event_days(dict(ev)) if ev else []
            promoted = _promote_waitlist_db(
                db, "van", cl["van_id"], cl["event_id"],
                cl.get("day"), event_days)
        db.commit()
    return jsonify({"deleted": clid, "promoted": promoted})


@app.route("/api/vans/<int:vid>/day-driver", methods=["POST"])
@require_role("mentor", "admin")
def api_van_day_driver(vid):
    """Per-day van driver override for one event: a different parent
    may drive the van on a given trip day. driver_user_id null (or
    empty) clears the override back to the designated driver. The
    override stays permissive about RSVPs — a mentor can set it
    before RSVPs are filed — but a parent already driving that day
    (a carpool, or another van) is rejected; van eligibility for
    that day still requires the day driver to be attending that
    day."""
    v = q_one("SELECT * FROM team_vans WHERE id=?", (vid,))
    if not v:
        return err("team van not found", 404)
    b = request.get_json(force=True, silent=True) or {}
    ev = q_one("SELECT * FROM events WHERE id=?", (b.get("event_id"),))
    if not ev:
        return err("event not found", 404)
    event_days = _event_days(ev)
    day = (b.get("day") or "").strip() or None
    if not day or day not in event_days:
        return err("day is not part of this event")
    drv_uid = b.get("driver_user_id")
    if drv_uid:
        drv = q_one("SELECT id, role FROM users WHERE id=?", (drv_uid,))
        if not drv or drv["role"] != "parent":
            return err("pick a parent account as the day driver")
        with _lock:
            db = get_db()
            # One driver, one vehicle, per day: the override stays
            # permissive about RSVPs (a mentor may set it before
            # RSVPs are filed), but a parent already driving that
            # day — a carpool, or another van — is a hard conflict.
            car_days = _carpool_days_map(db, ev["id"])
            for c in db.execute("SELECT id FROM carpools WHERE event_id=?"
                                " AND driver_user_id=?", (ev["id"], drv_uid)):
                if _carpool_runs_day(car_days, c["id"], day):
                    return err("that parent is already driving a carpool"
                               " on that day", 409)
            overrides = _van_day_drivers_map(db, ev["id"])
            for v in db.execute("SELECT * FROM team_vans WHERE seats"
                                " IS NOT NULL AND id != ?", (vid,)):
                if _van_driver_for_day(v, ev["id"], day, overrides) == drv_uid:
                    return err("that parent is already driving another"
                               " team van on that day", 409)
            db.execute(
                """INSERT INTO van_day_drivers (van_id, event_id, day,
                   driver_user_id) VALUES (?,?,?,?)
                   ON CONFLICT(van_id, event_id, day) DO UPDATE SET
                     driver_user_id=excluded.driver_user_id""",
                (vid, ev["id"], day, drv_uid))
            db.commit()
    else:
        execute("DELETE FROM van_day_drivers WHERE van_id=? AND event_id=?"
                " AND day=?", (vid, ev["id"], day))
    return jsonify({"van_id": vid, "event_id": ev["id"], "day": day,
                    "driver_user_id": drv_uid or None})


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
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (hid,))
    if not hotel:
        return err("hotel not found", 404)
    fits = {"double": 2, "queen": 2, "king": 2, "sofa bed": 1}
    beds = b.get("beds") or []
    if not isinstance(beds, list) or any(t not in fits for t in beds):
        return err("beds must be a list of: double, queen, king, sofa bed")
    capacity = sum(fits[t] for t in beds)
    if capacity == 0:
        capacity = int(b.get("capacity") or 4)
    # Days this room is allocated for: a room not needed on the
    # first or last day simply has no row for that day. No days key
    # (or an empty list) means every day, like carpools.
    ev = q_one("SELECT * FROM events WHERE id=?", (hotel["event_id"],))
    event_days = _event_days(ev) if ev else []
    days, days_err = _validate_days_input(b.get("days"), event_days)
    if days_err:
        return err(days_err)
    n = q_one("SELECT COUNT(*) n FROM rooms WHERE hotel_id=?", (hid,))["n"]
    label = (b.get("label") or "").strip() or f"Room #{n + 1}"
    rid = execute("INSERT INTO rooms (hotel_id, label, capacity, beds)"
                  " VALUES (?,?,?,?)",
                  (hid, label, capacity, json.dumps(beds)))
    if days:
        with _lock:
            db = get_db()
            for d in days:
                db.execute("INSERT OR IGNORE INTO room_days (room_id, day)"
                           " VALUES (?,?)", (rid, d))
            db.commit()
    return jsonify(q_one("SELECT * FROM rooms WHERE id=?", (rid,))), 201


@app.route("/api/rooms/<int:rid>", methods=["PUT"])
@require_role("mentor", "admin")
def api_room_update(rid):
    """After check-in, mentors record the hotel's actual room number.
    Mentors also change which days the room is allocated for here:
    the day set is replaced wholesale when "days" is sent. Occupant
    rows on days that drop out are NOT deleted — they are hidden
    (a room that doesn't run a day shows no occupants for it) and
    reappear if the day is added back; removing a student from a
    day is the occupant's ✕, not a day change."""
    b = request.get_json(force=True, silent=True) or {}
    rm = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not rm:
        return err("room not found", 404)
    if "room_number" in b:
        execute("UPDATE rooms SET room_number=? WHERE id=?",
                ((b["room_number"] or "").strip() or None, rid))
    if "days" in b:
        hotel = q_one("SELECT * FROM hotels WHERE id=?", (rm["hotel_id"],))
        ev = q_one("SELECT * FROM events WHERE id=?",
                   (hotel["event_id"],)) if hotel else None
        event_days = _event_days(ev) if ev else []
        days, days_err = _validate_days_input(b.get("days"), event_days)
        if days_err:
            return err(days_err)
        with _lock:
            db = get_db()
            db.execute("DELETE FROM room_days WHERE room_id=?", (rid,))
            for d in (days or []):
                db.execute("INSERT OR IGNORE INTO room_days (room_id, day)"
                           " VALUES (?,?)", (rid, d))
            db.commit()
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
def api_room_place(rid):
    """Place a student in a room FOR ONE DAY, like a carpool seat:
    the day is required on multi-day events, defaulted to the one
    date on single-day events. Capacity is per day, the room must
    be allocated for that day, the student must attend that day,
    and a student sleeps in at most one room per day. Placing in
    the same room for the same day twice is a no-op, not an error
    (the old INSERT OR IGNORE behavior). A room parent takes a bed:
    an assigned parent counts 1 against capacity that day.
    Placement is mentors/admins for anyone; parents and students
    place nobody — students file a rooming request, and a mentor
    places them. Placing in
    another room for the same day RE-ASSIGNS (moves) the bed instead
    of 409ing. A mentor placing themself has no roster row: member_id
    is null and the caller's own name rides along instead, recorded
    as a name-only occupant row."""
    b = request.get_json(force=True)
    rm = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not rm:
        return err("room not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] == "student":
        return err("students can't place themselves in a room — file a"
                   " rooming request, or ask a mentor or your parent",
                   403)
    self_place = b.get("member_id") is None
    if self_place:
        if u["role"] not in ("mentor", "admin") or not b.get("person_name") \
                or _norm_name(b.get("person_name")) != _norm_name(u["name"]):
            return err("member_id required — mentors place themselves"
                       " by name", 400)
    elif u["role"] == "parent" and not _may_act_for(
            u, b["member_id"], "student"):
        return err("only mentors place students in rooms", 403)
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (rm["hotel_id"],))
    ev = q_one("SELECT * FROM events WHERE id=?", (hotel["event_id"],))
    event_days = _event_days(ev) if ev else []
    # Day resolution, mirroring carpool claims exactly.
    day_in = (b.get("day") or "").strip() or None
    if len(event_days) > 1:
        if not day_in:
            return err("day is required for multi-day events"
                       " — pick a day")
        if day_in not in event_days:
            return err("day is not part of this event")
        day = day_in
    elif len(event_days) == 1:
        if day_in and day_in != event_days[0]:
            return err("day is not part of this event")
        day = event_days[0]
    else:
        day = None
    with _lock:
        db = get_db()
        if not _room_runs_day(_room_days_map(db, rm["hotel_id"]),
                              rid, day):
            return err("this room isn't allocated for that day", 400)
        # Attending ON THAT DAY, not just the trip: a partial
        # attending only Day 3 can't be placed on Day 1.
        days_map = _rsvp_days_map(db, hotel["event_id"])
        if self_place:
            # The mentor's own RSVP is name-only (parent kind, null
            # member): match it by normalized name.
            rsvp = None
            for cand in db.execute(
                    "SELECT id, status, person_name FROM rsvps"
                    " WHERE event_id=? AND member_id IS NULL"
                    " AND person_kind='parent'", (hotel["event_id"],)):
                if _norm_name(cand["person_name"]) \
                        == _norm_name(b.get("person_name")):
                    rsvp = cand
                    break
        else:
            rsvp = db.execute(
                "SELECT id, status FROM rsvps WHERE event_id=? AND member_id=?"
                " AND person_kind='student'",
                (hotel["event_id"], b["member_id"])).fetchone()
        if not rsvp or not _attends_day(rsvp["status"],
                                        days_map.get(rsvp["id"], set()),
                                        day, event_days):
            return err("only people attending on that day can be placed"
                       " — RSVP for that day first")
        # Who is being placed, for matching existing placements:
        # the member row, or — for a mentor placing themself — the
        # name-only row. Matching by normalized name too means a
        # duplicate roster row for the same student moves instead
        # of double-placing them.
        if self_place:
            my_name = _norm_name(b.get("person_name"))
        else:
            mrow = db.execute(
                "SELECT first_name, last_name FROM members WHERE id=?",
                (b["member_id"],)).fetchone()
            my_name = _norm_name(
                f"{mrow['first_name']} {mrow['last_name']}") if mrow else None

        def _is_mine(r):
            if self_place:
                return r["member_id"] is None and r["person_name"] \
                    and _norm_name(r["person_name"]) == my_name
            if r["member_id"] is not None \
                    and r["member_id"] == b["member_id"]:
                return True
            return bool(my_name and r["member_id"] is not None
                        and r["first_name"]
                        and _norm_name(
                            f"{r['first_name']} {r['last_name']}") == my_name)

        placed = db.execute(
            """SELECT o.id, o.room_id, o.day, o.member_id, o.person_name,
               m.first_name, m.last_name FROM room_occupants o
               JOIN rooms r ON r.id = o.room_id
               LEFT JOIN members m ON m.id = o.member_id
               WHERE r.hotel_id=?""", (rm["hotel_id"],)).fetchall()
        # Already placed for this day? Same room = no-op; another
        # room = re-assign (move), handled below after the capacity
        # check so a move into a full room keeps the old bed.
        if any(_is_mine(r) and r["room_id"] == rid
               and _occupant_day_matches(r["day"], day) for r in placed):
            return jsonify({"ok": True}), 201
        occ = db.execute(
            "SELECT day FROM room_occupants WHERE room_id=?",
            (rid,)).fetchall()
        # A room parent takes a bed: the parent's spot counts
        # against capacity every day the room runs, so a 4-bed room
        # with a parent assigned holds at most 3 students that day.
        # (Re-read inside the lock: the parent may have changed
        # since the room row was fetched above.)
        parent_takes = 1 if db.execute(
            "SELECT parent_name FROM rooms WHERE id=?",
            (rid,)).fetchone()["parent_name"] else 0
        if sum(1 for r in occ
               if _occupant_day_matches(r["day"], day)) \
                + parent_takes >= rm["capacity"]:
            return err("room is full for that day", 409)
        # Move: free the old bed(s) for this day first, then insert.
        # Capacity was checked above, so a move into a full room
        # already 409'd with the old bed intact.
        moved = False
        for r in placed:
            if _is_mine(r) and r["room_id"] != rid \
                    and _occupant_day_matches(r["day"], day):
                db.execute("DELETE FROM room_occupants WHERE id=?",
                           (r["id"],))
                moved = True
        db.execute(
            "INSERT INTO room_occupants (room_id, member_id, day, person_name)"
            " VALUES (?,?,?,?)",
            (rid, b.get("member_id"), day,
             b.get("person_name") if self_place else None))
        if b.get("member_id") is not None:
            db.execute("UPDATE rooming_requests SET status='placed'"
                       " WHERE hotel_id=? AND member_id=?",
                       (rm["hotel_id"], b["member_id"]))
        db.commit()
    return jsonify({"ok": True, "moved": moved}), 201


@app.route("/api/room_occupants/<int:oid>", methods=["DELETE"])
def api_room_unplace(oid):
    """Remove an occupant: mentors/admins anyone; anyone else only
    themself (a student their own bed, a mentor their own
    name-only bed). Anyone else gets 403 — the ✕ on another
    student's pill is never a live action."""
    o = q_one("""SELECT o.*, r.hotel_id FROM room_occupants o
                 JOIN rooms r ON r.id = o.room_id WHERE o.id=?""", (oid,))
    if not o:
        return err("occupant not found", 404)
    u = current_user()
    if not u:
        return err("login required", 401)
    if not _may_act_for(u, o["member_id"], "student", o["person_name"]):
        return err("you can only remove yourself from a room", 403)
    with _lock:
        db = get_db()
        db.execute("DELETE FROM room_occupants WHERE id=?", (oid,))
        # Per-day placements: the request goes back to pending only
        # when the student holds no room on any day anymore — removing
        # one night must not un-place their other nights.
        left = db.execute(
            """SELECT COUNT(*) n FROM room_occupants o
               JOIN rooms r ON r.id = o.room_id
               WHERE r.hotel_id=? AND o.member_id=?""",
            (o["hotel_id"], o["member_id"])).fetchone()["n"]
        if not left:
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
    always the family's parent name, taken server-side. A parent may only
    volunteer (or remove) THEMSELVES — never another parent: a parent
    caller's member must be one of their own user_members 'parent'
    links, resolved server-side from the session, never from a picker
    value. Mentors/admins may assign any family."""
    u = current_user()
    if not u:
        return err("login required", 401)
    if u["role"] not in ("parent", "mentor", "admin"):
        return err("parents, mentors and admins only", 403)
    room = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not room:
        return err("room not found", 404)
    _, parent_ids = _self_rsvp_scope(u)
    if request.method == "DELETE":
        if u["role"] == "parent":
            # Own assignment only: by linked member id, or — for
            # legacy rows with no parent_member_id recorded — by
            # matching the room parent's name to a linked member's
            # parent_name.
            own_names = {_norm_name(r["parent_name"]) for r in q_all(
                "SELECT parent_name FROM members WHERE id IN (%s)"
                % ",".join("?" * len(parent_ids)), tuple(parent_ids))} \
                if parent_ids else set()
            if room.get("parent_member_id") not in parent_ids and \
                    _norm_name(room.get("parent_name")) not in own_names:
                return err("you can only remove your own room-parent"
                           " assignment", 403)
        execute("UPDATE rooms SET parent_member_id=NULL, parent_name=NULL"
                " WHERE id=?", (rid,))
        return jsonify({"ok": True})
    b = request.get_json(force=True, silent=True) or {}
    if u["role"] == "parent":
        if b.get("member_id"):
            if int(b["member_id"]) not in parent_ids:
                return err("you can only volunteer yourself as room"
                           " parent — you can't volunteer another parent",
                           403)
        else:
            # No member picked (the parent UI has no picker): resolve
            # to the caller's own first linked member row.
            if not parent_ids:
                return err("your account isn't linked to a student on"
                           " the roster — ask a mentor to check your"
                           " account name", 403)
            b["member_id"] = sorted(parent_ids)[0]
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
