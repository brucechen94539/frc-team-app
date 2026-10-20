"""FRC Team Sign-Up — lightweight self-hosted app.

Stack: Flask + stdlib sqlite3. No auth in this build (see README);
users.password_hash is stubbed NULL for the future auth step.

Run:  pip install -r requirements.txt && python app.py
Env:  DB=<path>   SQLite file (default: data.db next to this file)
      DB=:memory: ephemeral in-memory mode (data lost on restart)
      PORT=<port>  default 5000
"""
import json
import os
import sqlite3
import threading

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB", os.path.join(BASE_DIR, "data.db"))

app = Flask(__name__, static_folder="static", static_url_path="/static")

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
    from seed import seed
    with _lock:
        seeded = seed(db)
    if seeded:
        print("Seeded sample data.")


def row(d):
    """sqlite3.Row -> plain dict, parsing JSON columns."""
    d = dict(d)
    for k in ("prefs", "discovery_chats", "agreements", "preferred_roommates"):
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
    if request.method == "GET":
        return jsonify(q_all("SELECT id, name, email, phone, role, created_at"
                             " FROM users ORDER BY name"))
    b = request.get_json(force=True)
    if not b.get("name") or b.get("role") not in (
            "student", "parent", "mentor", "admin"):
        return err("name and a valid role (student|parent|mentor|admin) required")
    # password_hash deliberately NOT settable here — no auth in this build.
    uid = execute("INSERT INTO users (name, email, phone, role) VALUES (?,?,?,?)",
                  (b["name"], b.get("email"), b.get("phone"), b["role"]))
    return jsonify(q_one("SELECT id, name, email, phone, role, created_at"
                         " FROM users WHERE id=?", (uid,))), 201


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
def api_members_clear_samples():
    with _lock:
        db = get_db()
        n = db.execute("DELETE FROM members WHERE sample=1").rowcount
        db.commit()
    return jsonify({"cleared": n})


@app.route("/api/members/<int:mid>/welcome")
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
def api_roster():
    return jsonify(q_all("SELECT * FROM members WHERE status='approved'"
                         " ORDER BY last_name, first_name"))


@app.route("/api/roster.csv")
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
def api_event_delete(eid):
    execute("DELETE FROM events WHERE id=?", (eid,))
    return jsonify({"deleted": eid})


def _going_count(eid):
    r = q_one("SELECT COUNT(*) c FROM rsvps WHERE event_id=? AND status='going'",
              (eid,))
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
                "waitlisted": sum(1 for r in rsvps if r["status"] == "waitlisted"),
                "cant": sum(1 for r in rsvps if r["status"] == "cant"),
            },
        })
    b = request.get_json(force=True)
    if b.get("person_kind") not in ("student", "parent") or not b.get("person_name"):
        return err("person_kind (student|parent) and person_name required")
    want = b.get("status", "going")
    status = want
    if want == "going" and ev["capacity"] and _going_count(eid) >= ev["capacity"]:
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
    with _lock:
        db = get_db()
        db.execute("DELETE FROM rsvps WHERE id=?", (rid,))
        promoted = None
        if r["status"] == "going":
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
    return jsonify({"event": ev, "carpools": carpools, "tools": tools,
                    "hotel": hotel})


@app.route("/api/carpools", methods=["POST"])
def api_carpool_create():
    b = request.get_json(force=True)
    if not b.get("event_id") or not b.get("driver_name"):
        return err("event_id and driver_name required")
    if not b.get("seats"):
        return err("seats required")
    cid = execute(
        """INSERT INTO carpools (event_id, driver_name, seats, depart_from,
           depart_time, return_info, notes, sample)
           VALUES (?,?,?,?,?,?,?,0)""",
        (b["event_id"], b["driver_name"], int(b["seats"]), b.get("depart_from"),
         b.get("depart_time"), b.get("return_info"), b.get("notes")))
    return jsonify(q_one("SELECT * FROM carpools WHERE id=?", (cid,))), 201


@app.route("/api/carpools/<int:cid>/claims", methods=["POST"])
def api_carpool_claim(cid):
    c = q_one("SELECT * FROM carpools WHERE id=?", (cid,))
    if not c:
        return err("carpool not found", 404)
    b = request.get_json(force=True)
    if not b.get("person_name"):
        return err("person_name required")
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
def api_room_create(hid):
    b = request.get_json(force=True)
    if not b.get("label"):
        return err("label required")
    rid = execute("INSERT INTO rooms (hotel_id, label, capacity) VALUES (?,?,?)",
                  (hid, b["label"], int(b.get("capacity") or 4)))
    return jsonify(q_one("SELECT * FROM rooms WHERE id=?", (rid,))), 201


@app.route("/api/hotels/<int:hid>/requests", methods=["POST"])
def api_rooming_request(hid):
    b = request.get_json(force=True)
    if not b.get("member_id"):
        return err("member_id required")
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


@app.route("/api/rooms/<int:rid>/occupants", methods=["POST"])
def api_room_place(rid):
    b = request.get_json(force=True)
    if not b.get("member_id"):
        return err("member_id required")
    rm = q_one("SELECT * FROM rooms WHERE id=?", (rid,))
    if not rm:
        return err("room not found", 404)
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


# ----------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
