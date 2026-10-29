-- FRC Team app schema (SQLite).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Identity: long-int userId. role IS the group
  -- (student|parent|mentor|admin); names split for reliable matching.
  name          TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  email         TEXT UNIQUE,
  phone         TEXT,
  whatsapp      TEXT,
  avatar        TEXT,              -- data URL (data:image/...;base64,...); NULL = initials
  role          TEXT NOT NULL DEFAULT 'student'
                CHECK (role IN ('student','parent','mentor','admin')),
  password_hash TEXT,              -- scrypt hash; NULL = no login yet
  totp_secret   TEXT,              -- Fernet-encrypted TOTP secret; NULL = no 2FA
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_backup_codes TEXT,          -- LEGACY: moved to totp_recovery_codes; NULL
  disabled      INTEGER NOT NULL DEFAULT 0,  -- mentor-disabled: cannot log in
  must_change_password INTEGER NOT NULL DEFAULT 0,  -- temp password: force reset at next login
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Identity links: which roster member(s) an account IS (self, for
-- students) or is the parent of (parent). This table — not name
-- matching — drives every ownership rule (RSVP, rooming, removal).
CREATE TABLE IF NOT EXISTS user_members (
  user_id   INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('self','parent')),
  PRIMARY KEY (user_id, member_id, kind)
);

-- One row per 2FA recovery code: persisted, atomically consumable, and
-- kept after use (used_at) as an audit trail.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  code_hash  TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, code_hash)
);

-- One-row-per-key metadata (migration markers, etc.).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  assigned_subteam  TEXT,
  temp_password_hash TEXT           -- scrypt hash from sign-up; NULL once used at approval
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
  season       TEXT,                 -- NULL = current season; set when archived
  end_date     TEXT,                 -- multi-day: last day, YYYY-MM-DD;
                                   -- NULL = single-day (date only)
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
-- day: the trip day checked in (YYYY-MM-DD); NULL on dateless events.
-- One check-in per person per day, so a 3-day trip credits each day.
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  person_kind TEXT NOT NULL DEFAULT 'student',
  person_name TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'mentor',  -- self | mentor
  verified    INTEGER NOT NULL DEFAULT 1,
  hours       REAL NOT NULL DEFAULT 0,
  day         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id, person_kind, day)
);

-- Days a partial RSVP covers (YYYY-MM-DD). Empty = unspecified partial,
-- which counts as attending every day (the pre-multi-day meaning of
-- partial). Going RSVPs need no rows: going = every day.
CREATE TABLE IF NOT EXISTS rsvp_days (
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  UNIQUE(rsvp_id, day)
);

-- Days a carpool runs (YYYY-MM-DD). Empty = runs every day of the trip.
CREATE TABLE IF NOT EXISTS carpool_days (
  carpool_id INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  UNIQUE(carpool_id, day)
);

-- Per-day van driver override: a different parent may drive the van on
-- a given trip day. Empty for a day = the van's designated driver.
CREATE TABLE IF NOT EXISTS van_day_drivers (
  van_id   INTEGER NOT NULL REFERENCES team_vans(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  driver_user_id INTEGER NOT NULL,
  UNIQUE(van_id, event_id, day)
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
  driver_user_id INTEGER,      -- the driver account (owner); NULL on old rows
  seats        INTEGER NOT NULL,
  depart_from  TEXT, depart_time TEXT, return_info TEXT, notes TEXT,
  vehicle      TEXT,               -- JSON {plate, color, model, make} (optional)
  sample       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carpool_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  carpool_id  INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  person_kind TEXT,
  person_name TEXT NOT NULL,
  status      TEXT NOT NULL,       -- claimed | waitlisted
  day         TEXT,                -- trip day (YYYY-MM-DD); NULL = all days
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  claimed_by  TEXT,                -- legacy display name; superseded by
                                   -- vehicle_type/vehicle_id below
  vehicle_type TEXT,               -- 'carpool' | 'van', NULL = unassigned
  vehicle_id  INTEGER,
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
  room_number TEXT,              -- actual room number, filled in after check-in
  beds      TEXT,                -- JSON list of bed types: double|queen|king|sofa bed
  parent_member_id INTEGER,  -- room parent (adult volunteer; students are under 18)
  parent_name      TEXT      -- denormalized display name, like RSVPs/check-ins
);

CREATE TABLE IF NOT EXISTS room_occupants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day        TEXT,  -- NULL = placed every day (legacy, pre-per-day rooms)
  placed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, member_id, day)
);

-- Days a room is allocated for: empty set = every day of the trip,
-- mirroring carpool_days. A room not needed on the first or last day
-- simply has no row for that day.
CREATE TABLE IF NOT EXISTS room_days (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day     TEXT NOT NULL, UNIQUE(room_id, day));

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

-- Mentor-posted announcements, newest first.
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team vans: mentor-managed haulers, usable for tool sign-up alongside
-- parent drivers.
CREATE TABLE IF NOT EXISTS team_vans (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  driver_user_id INTEGER,          -- designated parent driver (account)
  seats INTEGER                    -- passenger seats; NULL = tools-only
);

CREATE TABLE IF NOT EXISTS van_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  van_id      INTEGER NOT NULL REFERENCES team_vans(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  person_kind TEXT,
  person_name TEXT NOT NULL,
  status      TEXT NOT NULL,       -- claimed | waitlisted
  day         TEXT,                -- trip day (YYYY-MM-DD); NULL = all days
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link requests: a sign-up for an EXISTING student. The signer has no
-- account yet, so Confirm files a request here instead of linking at
-- once; a mentor approves (or declines) it from the Mentor Queue.
CREATE TABLE IF NOT EXISTS link_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_name  TEXT NOT NULL,
  requester_email TEXT NOT NULL DEFAULT '',
  requester_phone TEXT NOT NULL DEFAULT '',
  requester_kind  TEXT NOT NULL CHECK (requester_kind IN ('parent','student')),
  requester_whatsapp TEXT NOT NULL DEFAULT '',
  member_id       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined')),
  temp_password_hash TEXT,         -- sign-up temp password; NULL once used at approval
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Password history: every password a user has held (scrypt hashes).
-- A new password must not match any of them, so a temporary password
-- can never be reused — by the user, ever again.
CREATE TABLE IF NOT EXISTS password_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Account deletion requests: deleting is two-stage on purpose. A
-- mentor disables an account first; a second step files a request
-- here, and only an approval from the Mentor Queue deletes the row.
CREATE TABLE IF NOT EXISTS deletion_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  requested_by INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','declined')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
