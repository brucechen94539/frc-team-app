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
- Role rules are enforced on the server, not just hidden in the UI.
  Non-mentors see a names-only people directory (no contact details).
- Event **Delete** buttons are shown to mentors/admins only (the server
  already rejected others; the button no longer appears for them at all).

## Two-factor authentication (TOTP, opt-in)

- Any user can opt in from the **Security** tab: scan the QR code with
  **Google Authenticator or Apple Passwords** (both use the standard TOTP
  protocol, so one implementation serves both) or enter the key by hand,
  then confirm with a code from the app.
- Login becomes two steps for users with 2FA on: password first, then the
  6-digit code (or a recovery code). The session stays half-open until
  the code verifies. Codes accept ±1 time step for clock skew.
- Scanning the QR code alone does **not** turn 2FA on — it stays off,
  and login remains password-only, until the confirm code is verified
  with Verify & enable. Clicking setup again generates a fresh secret,
  so scan the QR shown that time.
- **Recovery codes:** 8 one-time codes shown once at setup (regenerable
  with a current code); each works once and is consumed on use.
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
- **Students and parents** can RSVP **for themselves only** — the picker
  shows just their own entry (a parent with several children gets one
  entry per child, labeled by child). **Only mentors/admins can RSVP for
  someone else** (override). The server enforces it: a non-mentor RSVP
  for anyone else is rejected, matched by member linkage (student record
  or parent_name), with loose name matching so 'zanderchen' matches
  'Zander Chen'. Statuses: going / maybe / partial / can't make it /
  waitlisted. **Partial** is for multi-day events such as tournaments,
  when someone attends only part of the event.
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
  list; legacy single assignees migrate to one-person lists). An "Only
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
  rejected.
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
