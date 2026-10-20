-- FRC Team app schema (SQLite).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'student'
                CHECK (role IN ('student','parent','mentor','admin')),
  password_hash TEXT,              -- scrypt hash; NULL = no login yet
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team sign-up applications. status: pending | approved | waitlisted | declined
CREATE TABLE IF NOT EXISTS members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE,   -- human-friendly, e.g. FRC-101
  status            TEXT NOT NULL DEFAULT 'pending',
  submitted_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sample            INTEGER NOT NULL DEFAULT 0,
  first_name        TEXT, last_name TEXT,
  school            TEXT, grade TEXT, experience TEXT,
  student_email     TEXT, student_phone TEXT,
  parent_name       TEXT, relationship TEXT,
  parent_email      TEXT, parent_phone TEXT,
  parent_whatsapp   TEXT,
  whatsapp_opt_in   INTEGER NOT NULL DEFAULT 0,
  em_name           TEXT, em_phone TEXT, medical TEXT,
  prefs             TEXT,            -- JSON array, ranked top-3 subteams
  discovery_chats   TEXT,            -- JSON array of subteam chat picks
  discovery_sessions TEXT,
  notes             TEXT,
  agreements        TEXT,            -- JSON {conduct,safety,photo,dues}
  assigned_subteam  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL,       -- meeting | build | competition | outreach
  date         TEXT, time TEXT, location TEXT,
  capacity     INTEGER,              -- NULL = unlimited
  deadline     TEXT,                 -- RSVP deadline, YYYY-MM-DD
  session_hours REAL,               -- default hours credited per check-in
  notes        TEXT,
  sample       INTEGER NOT NULL DEFAULT 0
);

-- RSVP by a student or parent for an event. status: going | waitlisted | cant
CREATE TABLE IF NOT EXISTS rsvps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  person_kind TEXT NOT NULL,        -- student | parent
  person_name TEXT NOT NULL,
  status      TEXT NOT NULL,        -- going | waitlisted | cant
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id, person_kind)
);

-- Attendance check-ins. verified=0 for self check-ins until a mentor confirms.
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  person_kind TEXT NOT NULL DEFAULT 'student',
  person_name TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'mentor',  -- self | mentor
  verified    INTEGER NOT NULL DEFAULT 1,
  hours       REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id, person_kind)
);

CREATE TABLE IF NOT EXISTS tasks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  subteam   TEXT, assignee TEXT, due_date TEXT, notes TEXT,
  status    TEXT NOT NULL DEFAULT 'todo',  -- todo | doing | done
  sample    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carpools (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  driver_name  TEXT NOT NULL,
  seats        INTEGER NOT NULL,
  depart_from  TEXT, depart_time TEXT, return_info TEXT, notes TEXT,
  sample       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carpool_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  carpool_id  INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  person_kind TEXT,
  person_name TEXT NOT NULL,
  status      TEXT NOT NULL,       -- claimed | waitlisted
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  claimed_by  TEXT,                -- NULL = unclaimed
  claimed_at  TEXT,
  sample      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hotels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL, address TEXT,
  check_in   TEXT, check_out TEXT, notes TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id  INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  capacity  INTEGER NOT NULL DEFAULT 4,
  parent_member_id INTEGER,  -- room parent (adult volunteer; students are under 18)
  parent_name      TEXT      -- denormalized display name, like RSVPs/check-ins
);

CREATE TABLE IF NOT EXISTS room_occupants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  placed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, member_id)
);

-- One replaceable rooming request per student per hotel.
CREATE TABLE IF NOT EXISTS rooming_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id            INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  member_id           INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  preferred_roommates TEXT,       -- JSON array of names
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | placed
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hotel_id, member_id)
);
