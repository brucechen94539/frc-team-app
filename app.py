"""Team 9470 CTRL-AL-DELETE FRC Team Portal — lightweight self-hosted app.

Stack: Flask + stdlib sqlite3. Accounts live in the users table with
scrypt-hashed passwords; login state is a signed session cookie (see README).

Run:  pip install -r requirements.txt && python app.py
Env:  DB=<path>   SQLite file (default: data.db next to this file)
      DB=:memory: ephemeral in-memory mode (data lost on restart)
      PORT=<port>  default 5000
"""
import base64
import functools
import hashlib
import hmac
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


def _migrate(db):
    """Additive migrations for databases created before these columns."""
    room_cols = {r[1] for r in db.execute("PRAGMA table_info(rooms)")}
    car_cols = {r[1] for r in db.execute("PRAGMA table_info(carpools)")}
    user_cols = {r[1] for r in db.execute("PRAGMA table_info(users)")}
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
        if "totp_secret" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT")
        if "totp_enabled" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_enabled INTEGER"
                       " NOT NULL DEFAULT 0")
        if "totp_backup_codes" not in user_cols:
            db.execute("ALTER TABLE users ADD COLUMN totp_backup_codes TEXT")
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
PUBLIC_API = {("GET", "/api/subteams"), ("POST", "/api/members")}
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
    if not current_user():
        return err("login required", 401)
    return None


def _public_user(u):
    return {k: u[k] for k in ("id", "name", "email", "role")}


@app.route("/api/auth/me")
def api_auth_me():
    u = current_user()
    return jsonify({"user": _public_user(u) if u else None,
                    "setup_required": setup_required()})


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    b = request.get_json(force=True, silent=True) or {}
    email = (b.get("email") or "").strip().lower()
    u = q_one("SELECT * FROM users WHERE lower(email)=?", (email,))
    if (not u or not u["password_hash"] or
            not check_password_hash(u["password_hash"], b.get("password") or "")):
        return err("invalid email or password", 401)
    session.clear()
    if u.get("totp_enabled"):
        # password passed, but the session stays half-open until the code
        session["pending_uid"] = u["id"]
        return jsonify({"need_2fa": True})
    session["uid"] = u["id"]
    return jsonify({"user": _public_user(u)})


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
    if existing:
        execute("UPDATE users SET name=?, password_hash=? WHERE id=?",
                (name, generate_password_hash(pw), existing["id"]))
        uid = existing["id"]
    else:
        uid = execute("INSERT INTO users (name, email, role, password_hash)"
                      " VALUES (?,?,?,?)",
                      (name, email, "admin", generate_password_hash(pw)))
    session.clear()
    session["uid"] = uid
    return jsonify({"user": _public_user(q_one(
        "SELECT id, name, email, role FROM users WHERE id=?", (uid,)))}), 201


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
    execute("UPDATE users SET password_hash=? WHERE id=?",
            (generate_password_hash(new), u["id"]))
    return jsonify({"ok": True})


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
    codes = full.get("totp_backup_codes") or []
    if isinstance(codes, str):
        try:
            codes = json.loads(codes)
        except ValueError:
            codes = []
    return jsonify({"enabled": bool(full.get("totp_enabled")),
                    "backup_codes_remaining": len(codes)})


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
    execute("UPDATE users SET totp_secret=?, totp_enabled=0,"
            " totp_backup_codes=NULL WHERE id=?", (token, u["id"]))
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
    execute("UPDATE users SET totp_enabled=1, totp_backup_codes=? WHERE id=?",
            (json.dumps([_hash_code(c.replace("-", "")) for c in codes]),
             u["id"]))
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
    execute("UPDATE users SET totp_secret=NULL, totp_enabled=0,"
            " totp_backup_codes=NULL WHERE id=?", (u["id"],))
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
    execute("UPDATE users SET totp_backup_codes=? WHERE id=?",
            (json.dumps([_hash_code(c.replace("-", "")) for c in codes]),
             u["id"]))
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
        # code with or without its dash both work; consumed on use
        codes = full.get("totp_backup_codes") or []
        if isinstance(codes, str):
            try:
                codes = json.loads(codes)
            except ValueError:
                codes = []
        digest = _hash_code(code.replace(" ", "").replace("-", "").upper())
        if digest in codes:
            codes.remove(digest)
            execute("UPDATE users SET totp_backup_codes=? WHERE id=?",
                    (json.dumps(codes), uid))
            ok = True
    if not ok:
        _totp_fail(uid)
        return err("that code did not match", 401)
    _totp_clear(uid)
    session.clear()
    session["uid"] = uid
    return jsonify({"user": _public_user(q_one(
        "SELECT id, name, email, role FROM users WHERE id=?", (uid,)))})


@app.route("/api/auth/totp-reset", methods=["POST"])
@require_role("mentor", "admin")
def api_totp_reset():
    """Mentor safety valve: clear a user's 2FA (e.g. lost phone)."""
    b = request.get_json(force=True, silent=True) or {}
    if not b.get("user_id"):
        return err("user_id required")
    if not q_one("SELECT id FROM users WHERE id=?", (b["user_id"],)):
        return err("user not found", 404)
    execute("UPDATE users SET totp_secret=NULL, totp_enabled=0,"
            " totp_backup_codes=NULL WHERE id=?", (b["user_id"],))
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


@app.route("/api/users", methods=["GET", "POST"])
def api_users():
    denied = _mentor_denied()
    if denied:
        return denied
    if request.method == "GET":
        return jsonify(q_all(
            "SELECT id, name, email, phone, role, created_at,"
            " (password_hash IS NOT NULL) AS has_password,"
            " (totp_enabled IS NOT NULL AND totp_enabled != 0) AS totp_enabled"
            " FROM users ORDER BY name"))
    b = request.get_json(force=True)
    if not b.get("name") or b.get("role") not in (
            "student", "parent", "mentor", "admin"):
        return err("name and a valid role (student|parent|mentor|admin) required")
    pw = b.get("password") or ""
    if pw and len(pw) < 8:
        return err("password must be 8+ characters")
    try:
        uid = execute(
            "INSERT INTO users (name, email, phone, role, password_hash)"
            " VALUES (?,?,?,?,?)",
            (b["name"], b.get("email"), b.get("phone"), b["role"],
             generate_password_hash(pw) if pw else None))
    except sqlite3.IntegrityError:
        return err("a user with that email already exists")
    return jsonify(q_one("SELECT id, name, email, phone, role, created_at"
                         " FROM users WHERE id=?", (uid,))), 201


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
    execute("UPDATE users SET password_hash=? WHERE id=?",
            (generate_password_hash(pw), uid))
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
    for f in ("first_name", "last_name", "parent_name"):
        if not b.get(f):
            return err(f"{f} is required")
    ag = b.get("agreements") or {}
    if not all(ag.get(k) for k in ("conduct", "safety", "photo", "dues")):
        return err("all four agreements must be accepted")
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
        return jsonify({"deleted": mid})
    b = request.get_json(force=True)
    sets, args = [], []
    if "status" in b:
        if b["status"] not in ("pending", "approved", "waitlisted", "declined"):
            return err("bad status")
        sets.append("status=?")
        args.append(b["status"])
    if "assigned_subteam" in b:
        sets.append("assigned_subteam=?")
        args.append(b["assigned_subteam"])
    if sets:
        args.append(mid)
        execute(f"UPDATE members SET {', '.join(sets)} WHERE id=?", args)
    return jsonify(q_one("SELECT * FROM members WHERE id=?", (mid,)))


@app.route("/api/members/sample", methods=["DELETE"])
@require_role("mentor", "admin")
def api_members_clear_samples():
    with _lock:
        db = get_db()
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
        return jsonify(q_all("SELECT * FROM events ORDER BY date, id"))
    b = request.get_json(force=True)
    if not b.get("title"):
        return err("title is required")
    defaults = {"meeting": 2, "build": 4, "competition": 8, "outreach": 3}
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


@app.route("/api/events/<int:eid>", methods=["DELETE"])
@require_role("mentor", "admin")
def api_event_delete(eid):
    execute("DELETE FROM events WHERE id=?", (eid,))
    return jsonify({"deleted": eid})


def _occupancy_count(eid):
    """Spots taken: going + partial both occupy a place at the event."""
    r = q_one("SELECT COUNT(*) c FROM rsvps WHERE event_id=?"
              " AND status IN ('going','partial')", (eid,))
    return r["c"]


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
    want = b.get("status", "going")
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
        mine = ((r["person_name"] or "").strip().lower()
                == (u["name"] or "").strip().lower())
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


@app.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "POST":
        denied = _mentor_denied()
        if denied:
            return denied
    if request.method == "GET":
        return jsonify(q_all("SELECT * FROM tasks ORDER BY id"))
    b = request.get_json(force=True)
    if not b.get("title"):
        return err("title is required")
    tid = execute(
        "INSERT INTO tasks (title, subteam, assignee, due_date, notes, status, sample)"
        " VALUES (?,?,?,?,?,'todo',0)",
        (b["title"], b.get("subteam"), b.get("assignee"), b.get("due_date"),
         b.get("notes")))
    return jsonify(q_one("SELECT * FROM tasks WHERE id=?", (tid,))), 201


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
    sets, args = [], []
    for f in ("title", "subteam", "assignee", "due_date", "notes"):
        if f in b:
            sets.append(f"{f}=?")
            args.append(b[f])
    if "status" in b:
        if b["status"] not in ("todo", "doing", "done"):
            return err("bad status")
        sets.append("status=?")
        args.append(b["status"])
    if sets:
        args.append(tid)
        execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id=?", args)
    return jsonify(q_one("SELECT * FROM tasks WHERE id=?", (tid,)))


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
    return jsonify({"event": ev, "carpools": carpools, "tools": tools,
                    "hotel": hotel, "attendees": attendees})


def is_attending(eid, member_id, kind):
    """Attending = an RSVP with status 'going' or 'partial' for this event."""
    if not member_id:
        return False
    return q_one("SELECT id FROM rsvps WHERE event_id=? AND member_id=?"
                 " AND person_kind=? AND status IN ('going','partial')",
                 (eid, member_id, kind)) is not None


@app.route("/api/carpools", methods=["POST"])
def api_carpool_create():
    # Students claim seats; only parents/mentors/admins may define rides.
    if current_user()["role"] == "student":
        return err("parents, mentors and admins only", 403)
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("driver_name"):
        return err("event_id and driver_name required")
    if not b.get("seats"):
        return err("seats required")
    # A parent offering a ride must be attending themselves (RSVP 'going');
    # mentors/admins may also post team vehicles or coordinate rides.
    if current_user()["role"] == "parent":
        going_parents = {r["person_name"] for r in q_all(
            "SELECT person_name FROM rsvps WHERE event_id=? AND"
            " person_kind='parent' AND status='going'", (b["event_id"],))}
        if b["driver_name"].strip() not in going_parents:
            return err("the driver must RSVP as attending for this event first")
    veh_in = b.get("vehicle") or {}
    vehicle = {k: str(veh_in.get(k) or "").strip()
               for k in ("plate", "color", "model", "make")
               if str(veh_in.get(k) or "").strip()}
    cid = execute(
        """INSERT INTO carpools (event_id, driver_name, seats, depart_from,
           depart_time, return_info, notes, vehicle, sample)
           VALUES (?,?,?,?,?,?,?,?,0)""",
        (b["event_id"], b["driver_name"], int(b["seats"]), b.get("depart_from"),
         b.get("depart_time"), b.get("return_info"), b.get("notes"),
         json.dumps(vehicle) if vehicle else None))
    return jsonify(q_one("SELECT * FROM carpools WHERE id=?", (cid,))), 201


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
    taken = q_one("SELECT COUNT(*) n FROM carpool_claims"
                  " WHERE carpool_id=? AND status='claimed'", (cid,))["n"]
    status = "claimed" if taken < c["seats"] else "waitlisted"
    clid = execute(
        "INSERT INTO carpool_claims (carpool_id, member_id, person_kind,"
        " person_name, status) VALUES (?,?,?,?,?)",
        (cid, b.get("member_id"), b.get("person_kind"), b["person_name"], status))
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
            nxt = db.execute(
                "SELECT * FROM carpool_claims WHERE carpool_id=? AND status='waitlisted'"
                " ORDER BY created_at, id LIMIT 1", (cl["carpool_id"],)).fetchone()
            if nxt:
                db.execute("UPDATE carpool_claims SET status='claimed' WHERE id=?",
                           (nxt["id"],))
                promoted = dict(nxt)
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


@app.route("/api/tools/<int:tid>/claim", methods=["POST"])
def api_tool_claim(tid):
    b = request.get_json(force=True)
    if not b.get("claimed_by"):
        return err("claimed_by required")
    execute("UPDATE tools SET claimed_by=?, claimed_at=datetime('now') WHERE id=?",
            (b["claimed_by"], tid))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,)))


@app.route("/api/tools/<int:tid>/unclaim", methods=["POST"])
def api_tool_unclaim(tid):
    execute("UPDATE tools SET claimed_by=NULL, claimed_at=NULL WHERE id=?", (tid,))
    return jsonify(q_one("SELECT * FROM tools WHERE id=?", (tid,)))


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
    b = request.get_json(force=True)
    if not b.get("member_id"):
        return err("member_id required")
    hotel = q_one("SELECT * FROM hotels WHERE id=?", (hid,))
    if not hotel:
        return err("hotel not found", 404)
    eid = hotel["event_id"]
    if not is_attending(eid, b["member_id"], "student"):
        return err("only students attending this event can request a room"
                   " — RSVP as going first")
    going_names = {r["person_name"] for r in q_all(
        "SELECT person_name FROM rsvps WHERE event_id=? AND"
        " person_kind='student' AND status='going'", (eid,))}
    for name in b.get("preferred_roommates") or []:
        if name not in going_names:
            return err(f"{name} is not attending this event")
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
    """Withdraw rule: while a request is pending, the student can withdraw
    it (any signed-in user acting for them); once placed/finalized, only
    mentors/admins can remove it."""
    q = q_one("SELECT * FROM rooming_requests WHERE id=?", (qid,))
    if not q:
        return err("request not found", 404)
    if q["status"] == "placed":
        u = current_user()
        if not u or u["role"] not in ("mentor", "admin"):
            return err("placed requests can only be removed by a mentor", 403)
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
