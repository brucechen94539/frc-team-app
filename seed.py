"""Seed the database with labeled sample data mirroring the prototype."""
import json

SUBTEAMS = ["Build", "Programming", "Electrical", "Design / CAD",
            "Strategy", "Outreach", "Media", "Operations"]

SUBTEAM_BLURBS = {
    "Build": "Design and fabricate the robot's mechanisms — cutting, drilling, assembly.",
    "Programming": "Code the robot in Java: drive control, autonomous routines, sensors.",
    "Electrical": "Wire power distribution, label every circuit, keep the robot alive.",
    "Design / CAD": "Model parts and assemblies in CAD before anything gets cut.",
    "Strategy": "Scout opponents, plan match strategy, run drive-team decisions.",
    "Outreach": "Sponsors, STEM nights, award submissions — the team's public face.",
    "Media": "Photos, video, socials — document the season as it happens.",
    "Operations": "Logistics, travel planning, inventory — keep the team running.",
}

MEMBERS = [
    dict(code="FRC-101", status="pending", first_name="Maya", last_name="Chen",
         school="BASIS Independent Fremont", grade="9", experience="Rookie",
         student_email="maya.chen@example.com", student_phone="",
         parent_name="Li Wei Chen", relationship="Father",
         parent_email="lw.chen@example.com", parent_phone="(510) 555-0142",
         parent_whatsapp="+1 (510) 555-0142", whatsapp_opt_in=1,
         em_name="Li Wei Chen", em_phone="(510) 555-0142", medical="",
         prefs=["Programming", "Design / CAD", "Strategy"],
         discovery_chats=["Programming", "Strategy"], discovery_sessions="Invite me",
         notes="Did FTC last year — programmed in Java and drove the robot at two competitions.",
         agreements={"conduct": True, "safety": True, "photo": True, "dues": True},
         assigned_subteam=""),
    dict(code="FRC-102", status="pending", first_name="Jordan", last_name="Reyes",
         school="Mission San Jose High", grade="11", experience="Returning",
         student_email="j.reyes@example.com", student_phone="(510) 555-0198",
         parent_name="Maria Reyes", relationship="Mother",
         parent_email="maria.reyes@example.com", parent_phone="(510) 555-0117",
         parent_whatsapp="", whatsapp_opt_in=0,
         em_name="Maria Reyes", em_phone="(510) 555-0117",
         medical="Peanut allergy — EpiPen in backpack.",
         prefs=["Build", "Electrical", "Operations"],
         discovery_chats=["Build"], discovery_sessions="Chats only",
         notes="Returning from last season's build crew. Comfortable with the bandsaw and mill after training.",
         agreements={"conduct": True, "safety": True, "photo": False, "dues": True},
         assigned_subteam=""),
    dict(code="FRC-103", status="pending", first_name="Priya", last_name="Nair",
         school="Washington High School", grade="10", experience="Rookie",
         student_email="priya.nair@example.com", student_phone="",
         parent_name="Anil Nair", relationship="Father",
         parent_email="anil.nair@example.com", parent_phone="(510) 555-0163",
         parent_whatsapp="+1 (510) 555-0163", whatsapp_opt_in=1,
         em_name="Sunita Nair", em_phone="(510) 555-0129", medical="",
         prefs=["Outreach", "Media", "Strategy"],
         discovery_chats=["Outreach", "Media", "Strategy", "Design / CAD"],
         discovery_sessions="Invite me",
         notes="Runs her school's STEM club Instagram. Interested in sponsor outreach and impact award writing.",
         agreements={"conduct": True, "safety": True, "photo": True, "dues": True},
         assigned_subteam=""),
    dict(code="FRC-104", status="approved", first_name="Sam", last_name="Okafor",
         school="American High School", grade="12", experience="Veteran",
         student_email="sam.okafor@example.com", student_phone="(510) 555-0130",
         parent_name="Grace Okafor", relationship="Mother",
         parent_email="grace.okafor@example.com", parent_phone="(510) 555-0155",
         parent_whatsapp="+1 (510) 555-0155", whatsapp_opt_in=1,
         em_name="Grace Okafor", em_phone="(510) 555-0155", medical="",
         prefs=["Electrical", "Build", "Programming"],
         discovery_chats=[], discovery_sessions="Already decided",
         notes="Third season. Led wiring and pneumatics on last year's robot; happy to mentor rookies.",
         agreements={"conduct": True, "safety": True, "photo": True, "dues": True},
         assigned_subteam="Electrical"),
    dict(code="FRC-105", status="approved", first_name="Alex", last_name="Kim",
         school="Irvington High School", grade="10", experience="Returning",
         student_email="alex.kim@example.com", student_phone="",
         parent_name="Daniel Kim", relationship="Father",
         parent_email="daniel.kim@example.com", parent_phone="(510) 555-0181",
         parent_whatsapp="", whatsapp_opt_in=0,
         em_name="Daniel Kim", em_phone="(510) 555-0181",
         medical="Asthma — inhaler in bag.",
         prefs=["Design / CAD", "Build", "Strategy"],
         discovery_chats=["Design / CAD"], discovery_sessions="Chats only",
         notes="SolidWorks certified at school. Modeled last season's intake arm.",
         agreements={"conduct": True, "safety": True, "photo": True, "dues": True},
         assigned_subteam="Design / CAD"),
    dict(code="FRC-106", status="waitlisted", first_name="Taylor", last_name="Brooks",
         school="John F. Kennedy High", grade="9", experience="Rookie",
         student_email="t.brooks@example.com", student_phone="",
         parent_name="Jamie Brooks", relationship="Guardian",
         parent_email="jamie.brooks@example.com", parent_phone="(510) 555-0106",
         parent_whatsapp="+1 (510) 555-0106", whatsapp_opt_in=1,
         em_name="Jamie Brooks", em_phone="(510) 555-0106", medical="",
         prefs=["Build", "Programming", "Media"],
         discovery_chats=["Build", "Programming", "Media", "Outreach"],
         discovery_sessions="Invite me",
         notes="New to robotics; excited about everything. Applied after the club fair.",
         agreements={"conduct": True, "safety": True, "photo": False, "dues": True},
         assigned_subteam=""),
]

EVENTS = [
    dict(code="EVT-201", title="All-Hands Meeting — Season Kickoff & Safety Review",
         type="meeting", date="2026-10-24", time="6:00 PM",
         location="BASIS Independent Fremont — Robotics Lab", capacity=40,
         deadline="2026-10-23", session_hours=2,
         notes="Safety forms due. Parents welcome — season calendar, dues, and travel overview in the first 30 minutes."),
    dict(code="EVT-202", title="Build Session — Drivetrain Assembly",
         type="build", date="2026-10-26", time="10:00 AM",
         location="4285 Santa Monica Terrace, Fremont, CA 94539", capacity=12,
         deadline="2026-10-25", session_hours=4,
         notes="Build, Electrical, and Design / CAD priority. Bring safety glasses; no lunch provided — bring your own."),
    dict(code="EVT-203", title="Outreach — STEM Night Demo at the Library",
         type="outreach", date="2026-11-06", time="5:30 PM",
         location="Fremont Main Library, Community Room", capacity=15,
         deadline="2026-11-05", session_hours=3,
         notes="Demo robots for the community. Outreach and Media subteams lead."),
    dict(code="EVT-204", title="Competition — Offseason Scrimmage (Day Trip)",
         type="competition", date="2026-11-14", time="7:00 AM",
         location="Meet at school lot — bus to host school", capacity=25,
         deadline="2026-11-13", session_hours=8,
         notes="One-day scrimmage. Carpools organized in Travel & Logistics."),
    dict(code="EVT-205", title="Competition — Regional Tournament, Sacramento (Remote)",
         type="competition", date="2026-11-20", time="7:00 AM",
         location="UC Davis Pavilion — carpools leave the school lot Thu afternoon",
         capacity=30, deadline="2026-11-12", session_hours=8,
         notes="Remote tournament: three nights in Davis. Carpools, pit tool sign-ups, and hotel room assignments for this event live in the Travel & Logistics tab."),
    dict(code="EVT-206", title="Club — Weekly Robotics Club",
         type="club", date="2026-11-09", time="4:00 PM",
         location="BASIS Independent Fremont", capacity=30,
         deadline="2026-11-08", session_hours=1,
         notes="Weekly club meeting for BASIS Independent Fremont students. Mondays 4:00–5:05 PM."),
]

# (event_code, member_code, person_kind, status)
RSVPS = [
    ("EVT-201", "FRC-104", "student", "going"),
    ("EVT-201", "FRC-104", "parent", "going"),
    ("EVT-201", "FRC-105", "student", "going"),
    ("EVT-202", "FRC-104", "student", "going"),
    ("EVT-202", "FRC-105", "student", "going"),
    ("EVT-202", "FRC-105", "parent", "cant"),
    ("EVT-204", "FRC-104", "parent", "going"),
    ("EVT-204", "FRC-105", "student", "going"),
    ("EVT-204", "FRC-106", "student", "partial"),
    ("EVT-205", "FRC-104", "student", "going"),
    ("EVT-205", "FRC-104", "parent", "going"),
    ("EVT-205", "FRC-105", "student", "going"),
]

# (event_code, member_code, person_kind, method, verified, hours)
CHECKINS = [
    ("EVT-201", "FRC-104", "student", "mentor", 1, 2),
    ("EVT-201", "FRC-104", "parent", "mentor", 1, 2),
    ("EVT-201", "FRC-105", "student", "self", 0, 2),
    ("EVT-202", "FRC-104", "student", "mentor", 1, 4),
]

TASKS = [
    dict(title="Assemble drivetrain gearboxes", subteam="Build", assignee="Sam Okafor",
         due_date="2026-10-26", notes="Two gearboxes; grease and loctite before mounting.",
         status="doing"),
    dict(title="Wire power distribution board and label every circuit", subteam="Electrical",
         assignee="Sam Okafor", due_date="2026-10-28",
         notes="Follow last season's labeling scheme so debugging stays fast.", status="todo"),
    dict(title="CAD intake arm — v2 with lighter linkage", subteam="Design / CAD",
         assignee="Alex Kim", due_date="2026-10-30",
         notes="Target: 15% lighter than v1 without losing stiffness.", status="doing"),
    dict(title="Test autonomous path following on practice field", subteam="Programming",
         assignee="Alex Kim", due_date="2026-11-02",
         notes="Needs the practice field booked and a charged spare battery.", status="todo"),
    dict(title="Draft sponsor outreach email for fall drive", subteam="Outreach",
         assignee="", due_date="2026-10-25",
         notes="Reuse last year's letter; update the season calendar dates.", status="done"),
]

CARPOOLS = [
    dict(event="EVT-204", driver_name="Grace Okafor", seats=3,
         depart_from="School lot — Bay 2", depart_time="6:30 AM",
         return_info="Leaves the venue at 5:30 PM",
         notes="Room for one robot cart in the back.",
         riders=[("FRC-105", "student")]),
    dict(event="EVT-205", driver_name="Daniel Kim", seats=4,
         depart_from="School lot — main gate", depart_time="Thu 3:30 PM",
         return_info="Returns Sunday after finals, ~7 PM",
         vehicle={"plate": "8XYZ421", "color": "Silver",
                  "model": "Odyssey", "make": "Honda"},
         notes="Driving up Thursday for Friday load-in.",
         riders=[("FRC-104", "student")]),
]

TOOLS = [
    dict(event="EVT-204", name="Spare batteries + charger", qty=2,
         notes="Two charged batteries minimum for the pit.", claimed_by="Daniel Kim"),
    dict(event="EVT-204", name="Pit tool kit — wrenches & socket set", qty=1,
         notes="The red rolling kit from the lab.", claimed_by=None),
    dict(event="EVT-204", name="Folding pit table", qty=1, notes="",
         claimed_by="Grace Okafor"),
    dict(event="EVT-205", name="Robot cart + tie-downs", qty=1,
         notes="For the Thursday load-in.", claimed_by=None),
    dict(event="EVT-205", name="Extension cords & power strips (set)", qty=2,
         notes="Pit power for chargers and laptops.", claimed_by="Grace Okafor"),
]

HOTEL = dict(event="EVT-205", name="SpringHill Suites — Davis",
             address="3250 Chiles Rd, Davis, CA",
             check_in="2026-11-19", check_out="2026-11-22",
             notes="Team block: rooms held under “FRC Fremont” until Nov 5. Breakfast included; bus parking in the rear lot.")

ROOMS = [dict(label="Room #1", capacity=4, beds=["queen", "queen"],
              room_number="2147", occupants=["FRC-104"])]

ROOMING_REQUESTS = [
    dict(member="FRC-104", roommates=["Alex Kim"],
         notes="Early risers — Sam is on the drive team for 7 AM practice."),
    dict(member="FRC-105", roommates=["Sam Okafor"], notes=""),
]


def person_name(member, kind):
    if kind == "student":
        return f"{member['first_name']} {member['last_name']}"
    return member["parent_name"]


def seed(conn):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM members")
    if cur.fetchone()[0]:
        return False  # already seeded
    member_ids = {}
    for m in MEMBERS:
        cur.execute(
            """INSERT INTO members (code, status, sample, first_name, last_name, school,
               grade, experience, student_email, student_phone, parent_name, relationship,
               parent_email, parent_phone, parent_whatsapp, whatsapp_opt_in, em_name,
               em_phone, medical, prefs, discovery_chats, discovery_sessions, notes,
               agreements, assigned_subteam)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (m["code"], m["status"], 1, m["first_name"], m["last_name"], m["school"],
             m["grade"], m["experience"], m["student_email"], m["student_phone"],
             m["parent_name"], m["relationship"], m["parent_email"], m["parent_phone"],
             m["parent_whatsapp"], m["whatsapp_opt_in"], m["em_name"], m["em_phone"],
             m["medical"], json.dumps(m["prefs"]), json.dumps(m["discovery_chats"]),
             m["discovery_sessions"], m["notes"], json.dumps(m["agreements"]),
             m["assigned_subteam"]))
        member_ids[m["code"]] = cur.lastrowid
    event_ids = {}
    for e in EVENTS:
        cur.execute(
            """INSERT INTO events (code, title, type, date, time, location, capacity,
               deadline, session_hours, notes, sample)
               VALUES (?,?,?,?,?,?,?,?,?,?,1)""",
            (e["code"], e["title"], e["type"], e["date"], e["time"], e["location"],
             e["capacity"], e["deadline"], e["session_hours"], e["notes"]))
        event_ids[e["code"]] = cur.lastrowid
    member_by_code = {m["code"]: m for m in MEMBERS}
    for ev_code, mem_code, kind, status in RSVPS:
        cur.execute(
            "INSERT INTO rsvps (event_id, member_id, person_kind, person_name, status)"
            " VALUES (?,?,?,?,?)",
            (event_ids[ev_code], member_ids[mem_code], kind,
             person_name(member_by_code[mem_code], kind), status))
    for ev_code, mem_code, kind, method, verified, hours in CHECKINS:
        cur.execute(
            "INSERT INTO checkins (event_id, member_id, person_kind, person_name,"
            " method, verified, hours) VALUES (?,?,?,?,?,?,?)",
            (event_ids[ev_code], member_ids[mem_code], kind,
             person_name(member_by_code[mem_code], kind), method, verified, hours))
    for t in TASKS:
        cur.execute(
            "INSERT INTO tasks (title, subteam, assignee, assignees, due_date,"
            " notes, status, sample)"
            " VALUES (?,?,?,?,?,?,?,1)",
            (t["title"], t["subteam"], t["assignee"],
             json.dumps([t["assignee"]]) if t["assignee"] else json.dumps([]),
             t["due_date"], t["notes"], t["status"]))
    for c in CARPOOLS:
        cur.execute(
            "INSERT INTO carpools (event_id, driver_name, seats, depart_from,"
            " depart_time, return_info, notes, vehicle, sample)"
            " VALUES (?,?,?,?,?,?,?,?,1)",
            (event_ids[c["event"]], c["driver_name"], c["seats"], c["depart_from"],
             c["depart_time"], c["return_info"], c["notes"],
             json.dumps(c["vehicle"]) if c.get("vehicle") else None))
        cpid = cur.lastrowid
        for mem_code, kind in c["riders"]:
            cur.execute(
                "INSERT INTO carpool_claims (carpool_id, member_id, person_kind,"
                " person_name, status) VALUES (?,?,?,?, 'claimed')",
                (cpid, member_ids[mem_code], kind,
                 person_name(member_by_code[mem_code], kind)))
    for t in TOOLS:
        cur.execute(
            "INSERT INTO tools (event_id, name, qty, notes, claimed_by, claimed_at, sample)"
            " VALUES (?,?,?,?,?,?,1)",
            (event_ids[t["event"]], t["name"], t["qty"], t["notes"], t["claimed_by"],
             "2026-10-19" if t["claimed_by"] else None))
    cur.execute(
        "INSERT INTO hotels (event_id, name, address, check_in, check_out, notes)"
        " VALUES (?,?,?,?,?,?)",
        (event_ids[HOTEL["event"]], HOTEL["name"], HOTEL["address"],
         HOTEL["check_in"], HOTEL["check_out"], HOTEL["notes"]))
    hotel_id = cur.lastrowid
    for r in ROOMS:
        cur.execute("INSERT INTO rooms (hotel_id, label, capacity, beds, room_number)"
                    " VALUES (?,?,?,?,?)",
                    (hotel_id, r["label"], r["capacity"],
                     json.dumps(r.get("beds") or []), r.get("room_number")))
        room_id = cur.lastrowid
        for mem_code in r["occupants"]:
            cur.execute("INSERT INTO room_occupants (room_id, member_id) VALUES (?,?)",
                        (room_id, member_ids[mem_code]))
        # sample room parent: the first occupant's parent volunteers as room parent
        if r["occupants"]:
            pm = cur.execute("SELECT id, parent_name FROM members WHERE code=?",
                             (r["occupants"][0],)).fetchone()
            if pm:
                cur.execute("UPDATE rooms SET parent_member_id=?, parent_name=?"
                            " WHERE id=?", (pm[0], pm[1], room_id))
    for rq in ROOMING_REQUESTS:
        mid = member_ids[rq["member"]]
        placed = cur.execute(
            "SELECT 1 FROM room_occupants WHERE member_id=?", (mid,)).fetchone()
        cur.execute(
            "INSERT INTO rooming_requests (hotel_id, member_id, preferred_roommates,"
            " notes, status) VALUES (?,?,?,?,?)",
            (hotel_id, mid, json.dumps(rq["roommates"]), rq["notes"],
             "placed" if placed else "pending"))
    # admin account without a password — first-run setup assigns it (see README)
    cur.execute(
        "INSERT INTO users (name, email, role) VALUES (?,?,?)",
        ("Team Admin", "admin@example.com", "admin"))
    conn.commit()
    return True
