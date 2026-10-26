# Feature Requirements — FRC Team App

The central source of truth for how the app is supposed to behave.
Update this file whenever a feature rule changes. (Defects are tracked
separately in [BUGS.md](BUGS.md); setup/run instructions are in the README.)

**Key definition — "attending":** a person counts as attending an event
when their RSVP for that event has status **going** or **partial**
(partial = attending part of a multi-day event). `maybe`, `waitlisted`,
and `can't make it` do not count as attending.

## Accounts & roles

- Roles: **student**, **parent**, **mentor**, **admin** (admin = mentor powers).
- The landing page is the login screen. Only the fresh team sign-up form is
  public; everything else requires a login.
- Passwords are stored as scrypt hashes in SQLite; login uses a signed
  session cookie.
- First run: if no account has a password, the login page offers one-time
  admin-account creation.
- Mentors/admins create and reset team accounts (Mentor Queue → Team accounts).
- **Identity model:** each account has a long-int userId, first/last
  name, email (unique), phone, WhatsApp, password hash, OTP fields,
  and a **group** — its role (student/parent/mentor/admin). Accounts
  link to roster members through a `user_members` table: kind `self`
  (the student's own record) or `parent` (their children's records).
  **Every ownership rule (RSVP, rooming, removal) reads this table,
  never names** — so renames and duplicate names can't move or merge
  someone's permissions. Links are created three ways: a one-time
  backfill by name when the table first appears (tracked by a marker
  row, so a mentor's manual unlink survives restarts), automatically
  when an account is created, and automatically when a member is
  approved. Mentors can fix any link by hand in Team accounts
  (Link/Unlink per account). Name matching survives only as the
  link-creation heuristic, plus a fallback for accounts with no links
  yet.
- Role rules are enforced on the server, not just hidden in the UI.
  Non-mentors see a names-only people directory (no contact details).
- Event **Delete** buttons are shown to mentors/admins only (the server
  already rejected others; the button no longer appears for them at all).

## Profile & avatars

- Every account has a **Profile** view (via the avatar overlay's View
  full profile, all roles; no menu entry) with three cards:
  **Profile** (avatar + name + role + email + member since),
  **General** (editable phone and WhatsApp; email is read-only since it
  is the login identity; linked roster entries with kind, school, and
  subteam — assigned subteam, else ranked preferences), and **Security**
  (change password with the current password plus, when 2FA is on, a
  current authenticator code or unused recovery code; 2FA status; and a
  button into the full two-factor setup/reset tab).
- **Avatars are backend-backed, not browser-local.** Photos live in a
  `users.avatar` column as a data URL (fresh DBs get the column from
  `schema.sql`; older DBs gain it from `_migrate`). The frontend resizes
  to at most 256px JPEG on the device before upload, so a stored photo
  is tens of KB. Without a photo, the account shows **first/last-name
  initials** on a deterministic pastel circle (same initials/colors as
  the assignee chips). The header shows only the avatar, at the upper
  right (no name pill; hovering the avatar shows name and role), and
  tapping it opens the **avatar overlay**: **General** (first/last
  name, phone, WhatsApp; a student also gets school and grade for
  their own roster record), **Security** (2FA status, password change,
  button into the full Security tab), and **Logout** with a YES/NO
  confirm — never an instant exit. There is no header logout button;
  logout lives only in the overlay. The full Profile view is one tap
  inside the overlay (View full profile).
- **Avatar API (all self-only by construction — the routes take no user
  id, they act on the logged-in account):** `GET/POST/DELETE
  /api/auth/avatar`. Uploads must be PNG, JPEG, GIF, or WebP data URLs
  under 500KB with valid base64, else 400; logged-out requests get 401.
  `GET /api/users/<uid>/avatar` serves another account's photo to its
  owner or a mentor/admin, 403 for anyone else, 404 when no photo.
  `POST /api/auth/profile` updates phone, WhatsApp, first/last name
  (the display name is recomputed from them), and — for the caller's
  own roster record — school and grade (ignored when the account has
  no self link); absent keys keep their value; email in the body is
  ignored.
- **Role checks for this round (retest after any refactor):** own upload
  200 and round-trips; another student's photo 403, mentor's 200; own
  delete 200 then 404; contact edit updates phone/WhatsApp but never
  email; first/last edit updates the display name; a student's
  school/grade edit updates only their own roster record, and
  school/grade without a self link are ignored; password change with
  the right current password 200 (new login works, old login 401),
  wrong current password 403; with 2FA on, missing code 403, wrong code
  403, right code 200, recovery code 200 and spent on use; logged-out
  upload 401; non-image and oversized uploads 400; pre-avatar DB gains
  the column on boot.

## Two-factor authentication (TOTP, opt-in)

- Any user can opt in from the **Security** tab: scan the QR code with
  **Google Authenticator or Apple Passwords** (both use the standard TOTP
  protocol, so one implementation serves both) or enter the key by hand,
  then confirm with a code from the app.
- Login becomes two steps for users with 2FA on: password first, then the
  6-digit code (or a recovery code). The session stays half-open until
  the code verifies. Codes accept ±1 time step for clock skew.
- **Password change also requires the second factor when 2FA is on:**
  the current password plus a current authenticator code (or an unused
  recovery code, consumed on use) — a stolen password alone cannot lock
  the owner out. Same 5-failure 10-minute throttle as login, checked
  after the new-password length rule so a recovery code is never spent
  on a request that would fail anyway. Without 2FA, password change
  works exactly as before (no code needed).
- Scanning the QR code alone does **not** turn 2FA on — it stays off,
  and login remains password-only, until the confirm code is verified
  with Verify & enable. Clicking setup again generates a fresh secret,
  so scan the QR shown that time.
- **Recovery codes:** 8 one-time codes shown once at setup (regenerable
  with a current code); each works once and is consumed on use.
  Codes are stored as **one row per code** in `totp_recovery_codes`
  (sha256 hashes only, never the codes themselves): consuming a code
  is a single atomic update, so a code can never be spent twice even
  by two simultaneous logins, and spent codes stay on file with a
  timestamp as an audit trail. The Security tab shows how many codes
  remain.
- If the `qrcode` package is missing for the Python running the server,
  setup still works via the manual key (both authenticator apps accept
  typed keys); the QR code simply isn't shown. Install with
  `python3 -m pip install -r requirements.txt` (same interpreter that
  runs the app) and restart to get QR codes back.
- The QR SVG is normalized for HTML embedding (see BUGS.md 2026-10-25):
  plain `<rect>` elements plus a viewBox, so it renders when inserted
  via innerHTML.
- Secrets are **encrypted at rest** with a key derived from the app secret;
  recovery-code hashes are stored, never the codes themselves.
- **Lockout safety valve:** 5 failed codes lock 2FA attempts for 10
  minutes; a mentor/admin can reset any user's 2FA from Team accounts
  (lost phone), returning them to password-only login.
- 2FA is opt-in per user; it can be made mandatory for roles later.

## Team sign-ups

- Public application form: student info, parent/guardian info including a
  **WhatsApp number + opt-in** for WhatsApp updates, agreements.
- Students rank their **top-3 subteam preferences** out of 8 subteams; the
  same subteam cannot be picked twice.
- Every application goes to the **mentor approval queue**; a mentor approves,
  waitlists, or declines each one. Approved students join the roster.
- New students are offered optional **Subteam Discovery Chats** with subteam
  captains.

## Events & RSVPs

- Mentors/admins create events (title, type, date/time, location, capacity).
  Event types: meeting, build, competition, outreach, **club**.
- **Club** is a weekly event for **BASIS Independent Fremont (BIF) students
  only**, meeting **Mondays 4:00–5:05 PM** (1 session hour). Picking the Club
  type pre-fills 4:00 PM and the next Monday when those fields are empty,
  and every Club card carries a "BIF students only · Mondays 4:00–5:05 PM"
  note. The server enforces the school rule: a non-mentor RSVP for a
  member whose school is not BASIS Independent Fremont is rejected with a
  403; non-BIF accounts see no RSVP picker on Club events, just the rule.
  Mentors/admins keep their override (e.g. to file while a member's school
  record is fixed). A BIF student is identified by the linked roster
  member's school field, and `/api/auth/me` reports the account's `bif`
  flag (true if any linked member attends BIF).
- **Workshop location: 4285 Santa Monica Terrace, Fremont, CA 94539.**
  Build sessions meet there; the event form has a "Use workshop address"
  button that fills it into the location field, and the example-event
  filler uses it too.
- **Build and workshop sessions do not provide lunch** — bring your own.
  (The seed build session's note says so.)
- **Students and parents** can RSVP **for themselves only** — the picker
  shows just their own entry (a parent with several children gets one
  entry per child, labeled by child). **Only mentors/admins can RSVP for
  someone else** (override). The server enforces it: a non-mentor RSVP
  for anyone else is rejected, matched by member linkage (student record
  or parent_name), with loose name matching so 'zanderchen' matches
  'Zander Chen'. Statuses: going / maybe / partial / can't make it /
  waitlisted. **Partial** is for multi-day events such as tournaments,
  when someone attends only part of the event.
- **RSVP deadlines are enforced on the server, not just by hiding the
  buttons:** once an event's deadline passes, non-mentors get a 403
  filing an RSVP (the UI hides their picker and shows an "RSVP closed"
  pill). Mentors/admins still see the picker on closed events with a
  "mentor override" note and may file late RSVPs. Releasing a seat
  (removing an RSVP) stays allowed after the deadline, since it only
  frees a spot for the waitlist.
- When an event is full, new "going" or "partial" RSVPs join the waitlist
  and are auto-promoted as spots open; going + partial both count toward
  capacity.
- **RSVP removal:** students and parents can only remove **their own**
  RSVP (same member-linkage matching as filing); only mentors/admins can
  remove anyone else's. Deleting a going/partial RSVP promotes the first
  waitlisted person.
- **Long RSVP lists:** each event's RSVP list starts collapsed behind an
  "Expand list (N)" button, and the Events module has "Expand all" /
  "Collapse all" buttons. Expanded state survives re-renders within the
  session.
- Event pickers in the UI are **bubbles** (chips), not dropdowns: the picked
  event is highlighted and the sections below update to that event.

## Attendance tracking

- Check-in has **two paths**: mentors mark attendance, and students can
  self check-in. A self check-in is unverified until a mentor confirms it.
- The app tracks hours per student; a dashboard summarizes attendance
  and hours.

## Task Board (Kanban, team-wide)

- The Task Board is its **own module**, separate from Tracking: Tracking
  is per-event attendance, while tasks are team-wide (no event scope).
- Columns: **To do / In progress / Done**. Mentors create tasks (title,
  subteam, due date); anyone moves cards along; deleting stays
  mentor-only.
- **User-focused cards:** assignees lead the card as colored initial
  chips with names. A task may appoint **several students** (stored as a
  list; legacy single assignees migrate to one-person lists), picked
  with **tap-to-toggle chips** — not a Ctrl/Cmd-click multi-select,
  which doesn't work on phones. An "Only
  mine" toggle filters the board to the signed-in user's cards, and
  assignee/subteam dropdowns filter further.
- **Declutter:** mentors can **Archive** a card (archived tasks leave
  the columns; a "Show archived" toggle reveals an Archived column with
  Restore). Archive/restore is mentor-only on the server; a card's
  status is preserved through archiving. A **period filter** (All time /
  This month / This quarter) filters by due date; undated tasks always
  show.

## Travel & logistics (per event)

All assignment lists in this tab are **attendance-driven**: they are pulled
dynamically from the event's attendees (RSVP = going). People who have not
RSVP'd as attending do not appear and cannot be assigned, on the server as
well as in the UI.

### Carpools

- Only **parents, mentors, and admins** can define a ride (driver name,
  seats, departure point/time, return plan). Students cannot post rides.
- A **parent** offering a ride must be attending themselves: the driver
  named on the ride must have a parent RSVP = going for that event.
  Mentors/admins may also post team vehicles or coordinate rides.
- Anyone attending can claim a seat; claims beyond capacity go to the
  carpool waitlist and auto-promote when a seat is released.
- Drivers may optionally add vehicle details — **license plate, color,
  make, model** — shown on the ride card as a hover tooltip so riders can
  spot the car.
- **One row per person per carpool:** a person already claimed or
  waitlisted on a ride cannot claim it again (409). Releasing a seat
  promotes the first waitlisted person who doesn't already hold a seat.
  Databases with pre-existing duplicates are collapsed on server boot
  (earliest claimed row kept, else earliest waitlisted row).

### Tools & equipment

### Tools & equipment

- Mentors list the tools/gear an event needs. Tools are **hauled by parent
  drivers**: the claim picker lists only the event's parent drivers with
  their cars (driver + vehicle detail), never students. A claimed tool
  shows as "loaded in <driver>'s car" with the vehicle tooltip. Anyone
  signed in can claim a tool for a driver and unclaim it.

### Hotels & room parents

- The room block is **already booked** by the team; the app only organizes
  who sleeps where.
- Mentors add rooms as **Room #1, #2, #3, …** (numbered automatically).
  After check-in, a mentor can record the hotel's **actual room number**
  on the room; it displays next to the Room #.
- Each room is composed with a **bed builder**: pick a bed type
  (double / queen / king / sofa bed) and "Add bed" to add another, as many
  as the room has. Capacity is derived from the beds: double, queen, and
  king sleep **2** each; a sofa bed sleeps **1** (e.g. 2 queens + 1 sofa
  bed = sleeps 5).
### Rooming requests

- **Families request** rooming (student + preferred roommates, chosen from
  attending students); **mentors finalize** by placing students into rooms.
- Only students attending the event can request a room, be listed as a
  preferred roommate, or be placed in a room. Preferred roommates may be
  'going' or 'partial' attendees.
- **A student requests only for themself:** the form shows "Requesting as
  <you>" with no student picker, and the student never appears in their
  own roommate picker (mentors filing on a student's behalf get the same
  exclusion once they pick the student). The server enforces it: a
  student filing for anyone else, or listing themself as a roommate, is
  rejected. Preferred roommates are picked with **tap-to-toggle
  chips**, not a Ctrl/Cmd-click multi-select, so the form works on
  phones.
- **Parents don't see the rooming-request module at all** — they take part
  as room parents instead. Students see only their own requests; mentors
  see everyone's, for placement.
- **Withdrawal:** a student can withdraw their own rooming request while it
  is **pending**. Once it is **placed/finalized**, only a mentor/admin can
  remove it.
- **Room parent** (optional): an adult volunteer who checks a room in,
  because students under 18 can't check into hotels themselves. Senior
  rooms may go without one — a room is never blocked for lacking one.
- Only parents/mentors/admins can volunteer or remove a room parent;
  students can never be room parents. Volunteering additionally requires
  the parent to be **attending** (parent RSVP = going for that event).
- The room parent recorded is always the family's parent, taken from the
  member record server-side.

## Data & hosting

- Self-hosted Flask + SQLite app; no external services required.
- One database file (`data.db` by default, `DB` env var overrides);
  schema migrations for new columns run automatically at startup.

### Sticky session

- Reloading the page returns the user to the tab and event they were on
  (e.g. Travel & Logistics on the Sacramento event), saved in the
  browser's local storage. A saved event that no longer exists falls
  back to the first event; logging out clears the saved place.
