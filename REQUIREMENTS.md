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
  The accounts list is a table: first/last name, username (the account's
  display name), email, phone, member type (the role), school, grade, team
  (the linked roster member's subteam), and relationship to other members
  derived from the links — a parent link reads "parent of <student>", a
  self link reads "child of <parent>". School, grade, and team come from
  the linked member: the self link first, else the first parent link.
  Each row has Reset password (an overlay form: new password + confirm)
  and Reset 2FA (an overlay Yes/No confirm) buttons.
- **WhatsApp column (display-only):** the accounts table has a
  WhatsApp column next to Phone #, but mentors no longer edit it
  there — phone and WhatsApp are self-service, edited by the
  account owner in Profile (`POST /api/auth/profile`). A mentor
  sending WhatsApp via `PATCH /api/users/<id>` has it ignored;
  the endpoint takes role only. The create-account form still
  sets an initial WhatsApp when the mentor creates the account.
- **Relationship editor:** the Relationship column is click-to-edit
  for student and parent rows (mentor/admin rows stay read-only).
  Clicking opens tap-to-toggle chips: a parent picks roster students
  ("parent of …"), a student picks parent accounts ("child of …"),
  multiple picks allowed both ways. Saving sets the exact set —
  anything unpicked is unlinked — via
  `POST /api/users/<id>/relationships` (mentor-only). Both sides edit
  the same parent links, so setting "parent of" from a parent's row
  automatically shows as "child of" on the student's row, and vice
  versa. A student's "child of" reads from linked parent accounts
  first, falling back to the member's parent_name string. A student
  with no roster member linked yet can't be edited until a sign-up
  approval links one. (This edits account↔member links only. The
  roster's family fields — parent name, relationship, parent contact
  — are not edited here; members edit those themselves in Profile.)
- **Temporary passwords and forced reset:** any password set by someone
  else — a sign-up temporary password, a mentor-created account's
  password, or a mentor reset — marks the account `must_change_password`.
  At next login the user is held on a Set-your-own-password view (current
  temporary password + new + confirm) and the server closes every
  non-auth API route until the change succeeds; only then does the app
  open. A `password_history` table records every password the account
  has held, and a user-chosen change is rejected if it matches any of
  them — so a temporary password can never be reused, by that account,
  ever again. Mentor resets record the new hash but skip the reuse
  check (the mentor's explicit action may re-issue a known password).
- **Disable and Delete:** each account row has Disable/Enable and
  Delete. Disabling blocks login (a live session dies on its next
  request) and archives the account's OWN roster entry (self link) to
  status `archived`; children's records are untouched by a parent's
  disable. Re-enabling restores login only — the roster entry stays
  archived until a mentor moves it. Delete is two-stage: it requires
  the account to be disabled first, then files a deletion request in
  the Mentor Queue, and only an approval there deletes the account row
  (plus its links, password history, and recovery codes). The roster
  entries stay archived, so a mistaken deletion is recoverable by
  re-approving the member. Guards: nobody can disable or
  deletion-request their own account, and the last enabled mentor/admin
  cannot be disabled.
- **Member type Edit:** each account row has an Edit role button
  (disabled on your own row) that swaps the Member type cell for a
  role select (student / parent / mentor, plus admin for admin
  callers) with Save/Cancel; saving patches the role
  (`PATCH /api/users/<id> {role}`, mentor-only). Guards mirror
  Disable: never your own role; only admins grant the admin role or
  change an admin's role; changing the last enabled mentor/admin to
  a non-mentor role is refused. A role change touches no links —
  role is permission, not identity — and a parent newly made mentor
  without 2FA hits the existing mandatory-mentor-2FA gate until they
  set 2FA up.
- **Archived members:** `archived` is a member status alongside
  pending/approved/waitlisted/declined, with its own Mentor Queue filter.
  Archived members are off the roster (not in approved lists, pickers,
  or the public roster names) until a mentor moves them to another
  stage from the queue card (Approve, Waitlist, Decline, or Reopen to
  pending). Their RSVPs and carpool claims stay in place, so
  re-approval restores them.
- **Identity model:** each account has a long-int userId, first/last
  name, email (unique), phone, WhatsApp, password hash, OTP fields,
  and a **group** — its role (student/parent/mentor/admin). Accounts
  link to roster members through a `user_members` table: kind `self`
  (the student's own record) or `parent` (their children's records).
  **Every ownership rule (RSVP, rooming, removal) reads this table,
  never names** — so renames and duplicate names can't move or merge
  someone's permissions. Links are created two ways: automatically
  when an account is created, and automatically when a member is
  approved (plus the one-time name backfill from when the table first
  appeared). There is no manual Link/Unlink UI: the relationship is
  shown read-only in the accounts table, and the link endpoints are
  gone. Name matching survives only as the link-creation heuristic,
  plus a fallback for accounts with no links yet. Seat and bed
  assignment is the exception: since the 2026-10-30 cleanup it is
  mentor-only and reads no ownership — see Travel & logistics.
- Role rules are enforced on the server, not just hidden in the UI.
  Non-mentors see a names-only people directory (no contact details).
- Event **Delete** buttons are shown to mentors/admins only (the server
  already rejected others; the button no longer appears for them at all).

## Profile & avatars

- Every account has a **Profile** view (via the avatar menu's General
  link, all roles; no menu entry) with two cards:
  **Profile** (avatar + name + role + email + member since) and
  **General** (editable first/last name, phone, and WhatsApp; a student
  also edits school and grade on their own roster record; any linked
  member edits the family fields — parent name, relationship, parent
  phone, parent WhatsApp, parent email — on their linked roster
  records, and a parent's edit applies to all their children's
  records; email is read-only since it is the login identity;
  linked roster entries with kind, school, and subteam — assigned
  subteam, else ranked preferences). Password change and two-factor
  management live on the **Security** tab, not on the Profile page.
- **Avatars are backend-backed, not browser-local.** Photos live in a
  `users.avatar` column as a data URL (fresh DBs get the column from
  `schema.sql`; older DBs gain it from `_migrate`). The frontend resizes
  to at most 256px JPEG on the device before upload, so a stored photo
  is tens of KB. Without a photo, the account shows **first/last-name
  initials** on a deterministic pastel circle (same initials/colors as
  the assignee chips). The header shows only the avatar, at the upper
  right (no name pill; hovering the avatar shows name and role), and
  tapping it opens a small menu of just three links: **General** goes
  to the Profile view (whose General card edits first/last name,
  phone, WhatsApp — and, for a student, school and grade on their own
  roster record), **Security** goes to the Security tab, and
  **Log Out** collapses the menu and opens a separate popup asking
  "Logout?" with YES/NO — never an instant exit. There is no header
  logout button; logout lives only behind that popup. The menu holds
  no forms; it only links onward.
- **Avatar API (all self-only by construction — the routes take no user
  id, they act on the logged-in account):** `GET/POST/DELETE
  /api/auth/avatar`. Uploads must be PNG, JPEG, GIF, or WebP data URLs
  under 500KB with valid base64, else 400; logged-out requests get 401.
  `GET /api/users/<uid>/avatar` serves another account's photo to its
  owner or a mentor/admin, 403 for anyone else, 404 when no photo.
  `POST /api/auth/profile` updates phone, WhatsApp, first/last name
  (the display name is recomputed from them); school and grade on
  the caller's own roster record (ignored when the account has no
  self link); and the family fields — parent name, relationship,
  parent phone, parent WhatsApp, parent email — on every roster
  record the account is linked to (self and parent links alike);
  absent keys keep their value; email in the body is ignored.
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
  the column on boot. Family-field edits land on every linked
  record (a parent's edit updates all their children's rows); a
  mentor's member PATCH ignores basic-info fields, and a mentor's
  user PATCH ignores WhatsApp.

## Two-factor authentication (TOTP; opt-in for students/parents, required for mentors/admins)

- **Mentor/admin accounts must have 2FA on.** Until a mentor sets it up,
  the server closes every non-auth API route for them (403 "two-factor
  setup required") and the UI holds them on the Security tab; setup
  itself lives under `/api/auth/`, so a held mentor can always reach it.
  Students and parents stay opt-in. `/api/auth/me` reports `requires_2fa`.
- Any user can opt in from the **Security** tab: scan the QR code with
  **Google Authenticator or Apple Passwords** (both use the standard TOTP
  protocol, so one implementation serves both) or enter the key by hand,
  then confirm with a code from the app. The Security tab also holds
  **password change** (current password, new password, confirm).
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

- The sign-up form starts with two choices: **I am signing up as**
  (Parent / Student) and **is the student already on the team?**
  (Existing / New). Your contact info (name, email, phone) is shared
  across both branches.
- **Existing student:** a dropdown lists the approved roster
  (`GET /api/roster-names`, public, names only — no contact details),
  and Confirm files a **link request** (`POST /api/link-requests`,
  public) that waits in the Mentor Queue. A mentor approves or declines
  it from the Link requests card. Approving links the requester to the
  student at once if they already have an account (matched by email);
  a parent requester also fills the member's blank parent contact
  fields, so a later account creation auto-links by name. A pending
  request for the same person + student is the same request (no
  duplicates from double-clicks). Listing and deciding link requests
  is mentor/admin-only (`GET /api/link-requests`,
  `POST /api/link-requests/<id>/approve|decline`).
- **New student:** only the student's full name is collected. That
  files a name-only application in the Mentor Queue (marked
  "name-only", with a note saying the mentor completes it); the mentor
  does the final linkage — filling in details and approving the
  student onto the roster, after which account auto-linking works by
  name as usual. Intake requires only first + last name
  (`POST /api/members` no longer requires a parent name or agreements).
- **Temporary password:** both branches collect a Temporary password
  + Re-enter to confirm (8+ chars, must match), and the signer's email
  is required — it becomes the new account's login. The password is
  stored only as a scrypt hash on the application (or link request)
  until approval. When the member is approved (or the link request is
  approved), a team account is created automatically from that email
  and temporary password — parent signers get parent accounts, student
  signers get student accounts — unless an account for that email
  already exists, in which case it is linked and its password is never
  overwritten from a sign-up. The temp hash is cleared once used, so
  re-approving never creates a second account. **Parent WhatsApp:**
  the parent branch has an optional WhatsApp field; it lands on the
  member's parent contact (shown in the queue card's Full application),
  fills a blank parent WhatsApp on link approval, and rides along to
  the new parent account (or fills a blank one on an existing account).
- **Student's parent (optional):** the student New branch has a Parent
  block: a dropdown of parents already in the pool
  (`GET /api/parent-names`, public, names-only — parent accounts plus
  the parent names on approved roster members, deduped) plus a
  free-text name field. Pick wins over typing. On intake, a named
  parent already in the pool brings their contact along: the server
  fills blank parent email/phone from the matching parent account
  (else an approved member's parent entry), never overwriting what
  the sign-up provided. On approval, the usual name matching links
  the parent account to the member. The Existing branch has no Parent
  block — that member's parent info is already on the record.
- Every application goes to the **mentor approval queue**; a mentor approves,
  waitlists, or declines each one. Approved students join the roster.
  **Bulk approve** covers the import case: on the pending filter, mentors
  tick members (or Select all) and approve them in one call
  (`POST /api/members/bulk-approve`); only still-pending members change,
  and each approval runs the same account auto-link as a single approval.

## CSV export & import (roster and events)

- Mentors/admins can **export** the roster (`GET /api/roster.csv`,
  approved members) and events (`GET /api/events.csv`) as CSV, and
  **import** CSVs back in from the Roster and Events views — so a list
  built in a spreadsheet, or last year's export, loads without retyping
  it in the UI. Export gives you the template.
- Import is always **preview, then confirm**: the preview parses and
  validates every row and writes nothing; confirm re-validates and
  applies. Rows with errors are listed and skipped, never half-written.
  Files are UTF-8 CSV, 1MB / 2000 rows max; a file with no recognized
  columns is rejected outright.
- Rows match existing records by **Code**: a matching code updates that
  record, a new or blank code creates one (auto code `FRC-`/`EVT-`
  numbering, as usual). New members start **pending** in the Mentor
  Queue; new events are live at once, like mentor-created ones. On
  update, only columns present in the file overwrite, and a blank cell
  in a present column clears that field — except session hours, where
  blank keeps the old value.
- Roster import requires first + last name (a combined Student column
  is split the same way the server backfill splits names); subteam must
  be one of the 8, emails must contain `@`, WhatsApp updates is
  yes/no, discovery chats are comma-separated. Event import requires a
  title; type must be meeting/build/competition/outreach/club; dates
  and deadlines are YYYY-MM-DD; time looks like `6:00 PM` or `18:00`;
  capacity is a whole number (blank = unlimited); blank session hours
  on a new event take the per-type default.
- Import is mentor/admin-only on the server (logged-out 401, other
  roles 403) and the Import buttons are mentor-only in the UI, matching
  the export buttons.
- The events export carries a **Season** column, and event import accepts
  it: importing a season value archives the event under it (blank =
  current season), so a season round-trips through export/import.

## Events & RSVPs

- Mentors/admins create events (title, type, date/time, location, capacity).
  Event types: meeting, build, competition, outreach, **club**.
- Mentors/admins **edit events in place**: an Edit button on each event
  card opens a prefilled form (title, type, date, time, location,
  capacity, deadline, session hours, notes); saving calls
  `PATCH /api/events/<id>`, validated like creation (type in the 5,
  dates YYYY-MM-DD, capacity a whole number 0+, hours a number 0+).
  Clearing session hours keeps the old value (hours must never go NULL,
  or check-in credit breaks); lowering capacity below current occupancy
  leaves existing RSVPs in place, and new "going" answers waitlist.
- **Duplicate** copies an event into the create form (title, type, time,
  location, capacity, notes) with the date and deadline blank, so the
  mentor picks a new date and saves. **Repeat weekly** on the create form
  (1–12 weeks) creates one event per week at +7-day intervals, shifting
  the deadline with the event; it only applies when a date is set.
- **Creation reads differently from display:** the announcement form
  and the event create form live in shaded **create zones** (secondary
  surface + indigo left bar) instead of looking like another card, and
  both start collapsed behind a toggle title ("＋ Create event",
  "＋ Post announcement" — the toggle button is the title row).
  Clicking expands the form; creating collapses it again (events via
  the view re-render, announcements directly). An open zone stays open
  across filter/search re-renders. Export CSV, Import CSV, and Archive
  season stay visible outside the event create zone, and non-mentors
  never see the zones (they are mentor-only blocks).
- The Events view has a **List / Calendar** toggle: the calendar is a
  month grid (Sunday-first, prev/next/Today) over the filtered events,
  and clicking a title jumps to that event's card below. Every event card
  has an **Add to calendar** link (`GET /api/events/<id>.ics`): timed
  events use the event time and session hours for the duration, events
  with a date but no parsable time become all-day events, and dateless
  events are rejected (400).
- **Calendar titles wrap, columns stay equal:** event titles in
  calendar cells wrap onto multiple lines (`overflow-wrap: break-word`)
  instead of truncating with an ellipsis, and the grid uses
  `minmax(0, 1fr)` columns with `min-width: 0` cells, so all seven
  columns keep the same width no matter how long a title is.
- **Calendar marks your RSVP'd days:** a day whose date number sits in
  a filled indigo circle means you (or your student, for a parent)
  RSVP'd going or partial covering that day — going covers every day
  of the event, partial covers only its picked days (an unspecified
  partial covers every day, matching the attendance rule). Maybe,
  waitlisted, and can't-make-it RSVPs do not mark. The data comes from
  `GET /api/my-rsvps` (the signed-in account's RSVPs in link scope,
  with day picks; mentors without linked members see no marks), and a
  legend under the grid explains the mark whenever any day is marked.
- **Seasons:** events carry a `season` (NULL = current season). The main
  lists — Events, Tracking and Travel pickers — show current-season
  events only. Mentors close a season with **Archive season…** (a name
  like `2025-26`), which labels every current event and moves it out of
  the main lists; the **Show archived seasons** section lists archived
  events grouped by season as read-only cards (RSVP lists visible, no
  RSVP/edit/delete actions), and **Restore season to current** brings a
  season back. `GET /api/events?season=archived|all` serves the archive
  and the full list; the default is current only.
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
  someone else** (override). **Mentors can also join events and RSVP
  for themselves:** their picker leads with a "(mentor — you)" entry
  that files a name-only RSVP under their account name (mentors hold
  no roster row), and re-filing updates that row instead of adding a
  duplicate — name-only RSVPs dedupe by normalized name within
  (event, kind), including their partial day picks. The server enforces it: a non-mentor RSVP
  for anyone else is rejected, matched by member linkage (student record
  or parent_name), with loose name matching so 'zanderchen' matches
  'Zander Chen'. **The name itself is also checked:** the scope check
  used to pin only member_id + kind, so a parent linked to one child
  could file a going RSVP under another parent's name — and that fake
  name would then count as a going parent for driver eligibility,
  ride status, and headcounts. Now a non-mentor's supplied name must
  match (case/space-insensitively) the roster record for that
  member/kind or their own account name, or the RSVP is rejected
  with a 403 instead of being silently corrected; the account-name
  allowance covers relationship-linked parents whose recorded
  parent_name differs from their account name. Statuses: going /
  maybe / partial / can't make it / waitlisted.
- **Multi-day trips (per-day linkage):** an event has an optional
  **end_date** (max 31 days); its days are date .. end_date, and the
  calendar shows the trip on every day. **Partial** now carries the
  days it covers (day checkboxes in the picker, all checked by
  default; an unspecified partial still means every day, as before).
  **Going** covers every day. While any day is unchecked, only
  **Partial (multi-day)** stays enabled — Going / Maybe / Can't
  make it are disabled until every day is checked again — so a
  partial day pick can never land as a full 'going' on the
  logistics board. The per-event RSVP list reads as attendance,
  not raw codes: going shows **full**, maybe shows **maybe**,
  partial shows **partial**, and can't make it shows **rejected**
  (waitlisted unchanged). Event capacity is checked **per day**:
  a partial attending only Day 1 does not occupy a Day 3 spot, and
  if any covered day is full the whole RSVP waitlists.
- **Per-day rides and rooms:** Travel shows one **collapsible
  section per trip day** (Day 1 open, the rest closed, with
  Expand/Collapse all), each with a **carpool table** and a
  **rooms table** for that day; Tracking keeps day tabs. Tools stay
  per-trip. A carpool lists the days it runs (default every day);
  a mentor assigns **one seat per person per day** across every car,
  so riding Car A out Day 1 and Car B back Day 3 is allowed and a
  same-day seat elsewhere blocks a second assignment that day. A
  driver must be attending on every day their car runs — 'going',
  or (multi-day only) a partial covering that day — and a driver on
  Day 1 may ride as a passenger on Day 3 if they aren't driving that
  day. Waitlist promotion is per-day: freeing a Day 1 seat promotes
  a Day 1 waitlist row, never a Day 3 one. Check-ins are **per person
  per day**, so a 3-day trip credits each day separately (the day is
  required on multi-day events). NULL/empty day sets mean "all days"
  throughout, so pre-multi-day data (single-day events, old claims
  and check-ins) keeps working untouched.
- **Day tables (Travel layout):** a carpool table row is one car —
  Car/Driver (driver, vehicle make/model/color, departure, return,
  notes), Riders (claimed + waitlisted), Seats (open/total),
  Actions (mentor's assign picker, Edit/Remove). A rooms table row
  is one room — Room (label, actual room number, beds, per-day
  capacity), Occupants for that day, Actions (place picker, Edit
  for mentors). Below each day's rooms table, a **gap line** lists
  only who still **needs a room** that day (waitlisted counts as
  needing one); ride gaps live only in the Logistics status table
  above, and placed riders, drivers, and placed students are not
  repeated.
  **Tooltips are used sparingly:** vehicle make/model/color are
  visible text and only the license plate hides behind a hover
  tooltip, so nothing decision-relevant is hover-only.
  **Single-day events** get one carpool table and one rooms table
  with no day sections, and **no hotel section at all** unless a
  hotel block already exists — a day trip needs no rooms.
- **Per-day rooms:** like carpools, a room is **allocated for
  specific days** — mentors pick the days when adding a room (all
  checked = every day) and can change them later with Edit, so a
  room not needed on the first or last day simply doesn't appear
  in that day's table. **Placement is per day, like a carpool
  seat:** the day is required on multi-day events, the room must
  be allocated for that day, the person must attend that day,
  capacity counts that day's occupants only, and a person sleeps
  in at most one room per day (placing in the same room for the
  same day twice is a no-op). A person may sleep in different
  rooms on different nights. Dropping a day from a room hides that
  day's placements (they reappear if the day is added back);
  removing an occupant from a day is the occupant's ✕, mentors
  only. Old placements
  (no day recorded) mean every day, so pre-existing rooms keep
  working untouched. **Who can be placed:** every attendee for
  that day — students by roster row, and attending parents by
  name (name-only occupant rows, like a mentor placing themself),
  since parents hold no roster row and the room-parent role is
  gone; a parent's RSVP row (filed under the parent's name) is
  what establishes the parent's attendance, not the child's. The
  "Needs a room" gap line and the status table's Hotel pill match
  parents by name, so a placed parent shows as housed and stops
  listing as needing a room.
- **RSVP deadlines are enforced on the server, not just by hiding the
  buttons:** once an event's deadline passes, non-mentors get a 403
  filing an RSVP (the UI hides their picker and shows an "RSVP closed"
  pill). Mentors/admins still see the picker on closed events with a
  "mentor override" note and may file late RSVPs. Releasing a seat
  (removing an RSVP) stays allowed after the deadline, since it only
  frees a spot for the waitlist.
- **Closed events leave the regular user's Events view:** once an
  event's RSVP is closed, its card is hidden from students and parents
  entirely; mentors/admins keep seeing it. Travel & Logistics and
  Tracking are unaffected — a trip whose RSVP closed still needs its
  rides, rooms, and attendance visible.
- **Archive (freeze) for closed events:** a closed event's card carries
  an **Archive** button for mentors/admins. Archiving sets
  `events.archived` and freezes the event: every event-scoped write is
  refused server-side (edits, delete, RSVPs, carpools and claims, vans
  and day-drivers, hotels, rooms, occupants, room parents, rooming
  requests, tools, tool assignments, check-ins, and the tools CSV
  import) with "this event is archived — unarchive it to make
  changes"; reads (including Travel) keep working. An archived card
  shows an **Archived** pill, hides Edit/Delete and the RSVP picker,
  and offers **Unarchive**, which restores all writes. Only a closed
  RSVP can be archived, and archiving travels alone in its PATCH
  (`PATCH /api/events/<id> {archived: 1}`); a non-mentor archiving
  attempt is refused. This freeze is distinct from **season
  archiving**: season archive/restore skip frozen events entirely, so
  a frozen event is never swept into a season or restored out of one.
  Duplicate cleanup (below) is a data-cleanup operation, not an event
  update, so it still runs on archived events.
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

## Announcements

- Mentors/admins post **announcements** (title + message) from a card at
  the top of the Events page — the view everyone lands on. All logged-in
  users read them, newest first, with the posting mentor's name and date;
  mentors can delete them. Posting and deleting are mentor/admin-only on
  the server (`GET|POST /api/announcements`, `DELETE /api/announcements/<id>`).

## Attendance tracking

- Check-in has **two paths**: mentors mark attendance, and students can
  self check-in. A self check-in is unverified until a mentor confirms it.
- The app tracks hours per student; a dashboard summarizes attendance
  and hours.
- **Check-in QR:** each event card (mentors) has a Check-in QR button
  showing a QR code for that event (`GET /api/events/<id>/checkin-qr`,
  mentor/admin-only). Scanning it opens the app and jumps straight to
  Tracking with that event selected — the link survives the login flow,
  so a logged-out scan lands on Tracking after signing in, and the hash
  is consumed so later reloads use the sticky place instead. Phones must
  reach the server (same network as the self-hosted Mac) and be logged in.
- **Hours export:** mentors can download a per-student hours summary
  (`GET /api/hours.csv`, mentor/admin-only) for award submissions and
  service-hour verification: one row per approved roster member with
  verified, unverified, and total hours plus check-in count; students
  with no check-ins still list, at 0.

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

## Travel & logistics (per event, per day on multi-day trips)

All assignment lists in this tab are **attendance-driven**: they are pulled
dynamically from the event's attendees (RSVP = going or partial). People who have not
RSVP'd as attending do not appear and cannot be assigned, on the server as
well as in the UI. On a multi-day trip the ride and room lists are per day
(see the multi-day bullets under Events & RSVPs); tools stay per-trip.

### Carpools

- Only **parents, mentors, and admins** can define a ride (driver,
  seats, departure point/time, return plan). Students cannot post rides.
- **The driver is always an account, never free text**
  (`carpools.driver_user_id`). **Everyone posts only their own
  vehicle** — the Driver name field is grayed out and auto-filled
  with the session user's name, and the server 403s any
  `driver_user_id` that isn't the caller. Posting for another parent
  (the old mentor driver pool) is disabled.
- A **driver must be attending themselves**: a parent driver's account
  name must have a parent RSVP = going for that event (or a partial
  covering every day the car runs, on multi-day events).
  Mentors/admins are exempt — staff attendance isn't tracked via
  parent RSVPs, and a mentor driving their own car is attending by
  definition.
- **One vehicle per driver per event:** posting a vehicle is a
  one-time action per event, with checkboxes for the days the car
  runs. A driver who already registered a car for the event can't
  post a second one (409), even for different days — they edit the
  registered vehicle instead.
- **Post a ride is collapsed by default** (click the header to show
  the form) and **disappears entirely once the caller has registered
  a vehicle for the event** — no form, no warning note, so nothing
  invites a post that would fail. The form returns if the vehicle
  is removed. The travel payload carries a `me` field (`carpool_id`)
  so the frontend hides the form on the server's word; the server
  enforces the same rules.
- **Fleet for Carpool:** a universal viewable section right below the
  Travel & Logistics header (per selected event) listing every
  registered car — driver, vehicle (visible make/model/color, plate
  as a hover tooltip), days it runs, seats, riders (union of claimed
  seats across the trip days). **Edit and Remove belong to the
  driver (or a mentor/admin)** — nobody else sees them. Editing
  changes seats, details, and days, never the driver.
- **Logistics status:** a table right below the Travel & Logistics
  header (per selected event, all roles) with one row per RSVP'd
  person (students first, then parents, alphabetical) and one column
  per trip day (Day N + date). Each day cell carries two round,
  non-clickable indicators: **Hotel** (green = placed in a room
  running that day; red = still needs a room) and **Ride** (green
  = driving or holding a claimed seat that day — driving counts
  as a ride; red = still needs a ride). A day
  the person doesn't attend (a partial RSVP not covering that day)
  shows both pills **gray** — "not participating", not a gap to
  fill. The hotel indicator is a dash only when the event has no
  hotel block. Each row's name carries its RSVP basis ("going", or
  "partial · Sun 11/22, Mon 11/23" — a person with several RSVP rows
  shows each distinct basis), so a surprising color traces to its
  record instead of needing a one-off investigation. The card's
  header line shows the hotel block as
  `Name · address · check-in → check-out` (event dates when block
  dates are empty).
- **Hotel assignments card is mentor-only:** the trip-level card
  (block info, Add room) renders only for mentors/admins. The rooms
  tables themselves stay visible to everyone — day-section rooms
  tables on multi-day events, and a rooms-only card on single-day
  events with a block — but read-only: placement is mentor-only,
  so non-mentors see occupants without any place or remove action.
- **One seat per person per event, across every car:** a driver
  can never claim a seat (not their own car, not anyone else's —
  they're already driving), and a person already holding a claimed
  seat on any car is not offered on any other ride's picker and is
  rejected server-side (403 for a driver, 409 for an already-seated
  rider). A person merely waitlisted on one ride may
  still take an open seat on another; if they do, waitlist promotion
  on the first ride skips them (and promotes the next rider) rather
  than seating them twice.
- **Edit and remove:** the driver-owner or a mentor/admin can edit a
  ride later (seats, departure point/time, return plan, notes, plate,
  color, make, model, days) or remove the car from the pool. Editing
  keeps the riders; removing a car releases its claims and waitlist
  with it. **The driver is fixed at registration and can never be
  changed** — not even by a mentor (server 400s a driver change);
  changing the days re-checks the driver against the new days (must
  attend them). Seats can't be lowered
  below the riders already claimed.
- **Mentor-only seats (2026-10-30 cleanup, reversing the self-only
  round):** only mentors/admins assign seats — a mentor picks any
  attendee for a day from that day's attendee pool. Students and
  parents have no claim picker and no release action: the Actions
  cell notes "Riders are assigned by a mentor", and the server
  403s any non-mentor claim or release (the old `_may_act_for`
  self-only gate stays in place behind the mentor check, so a
  future relaxation reuses it). Claims beyond capacity go to the
  carpool waitlist and auto-promote when a seat is released.
  Room placement is mentor-only the same way — the server refuses
  every non-mentor place/unplace, including a parent placing their
  own child, which the old self-only gate used to allow. The two
  mentor pickers carry parallel prompts: "Place rider…" for
  carpool seats, "Place occupant…" for room beds (the carpool
  prompt starts unselected, so claiming requires picking a rider
  first).
- Drivers may optionally add vehicle details — **license plate, color,
  make, model** — shown on the ride card as a hover tooltip so riders can
  spot the car.
- **One row per person per carpool:** a person already claimed or
  waitlisted on a ride cannot claim it again (409). Releasing a seat
  promotes the first waitlisted person who doesn't already hold a seat
  on any vehicle or drive for the event (see the one-seat-per-event
  rule above).
- **Re-assigning a seat moves it:** claiming a rider on another
  vehicle for the same day moves their seat there instead of 409ing
  — the old row is deleted (a freed confirmed seat promotes that
  vehicle's first eligible waitlisted rider, exactly like a
  release) and the new claim is inserted atomically, so the pickers
  keep offering already-seated riders on other vehicles. The one
  exception: moving from a confirmed seat into a full vehicle 409s
  and keeps the old seat, so a re-assign can never silently
  downgrade a confirmed seat to a waitlist spot.
- **Claiming requires that day's RSVP, by name for name-only rows:**
  a seat claim (carpool) checks the claimant's RSVP for the
  claimed day — going, or a partial covering it. Name-only claims
  match a name-only RSVP by normalized name; the old lookup took
  the first name-only row of the kind, so a claim for someone not
  in the event could ride on another name-only filer's attendance.
  Databases with pre-existing duplicates are collapsed on server boot
  (earliest claimed row kept, else earliest waitlisted row).
- **Clean slate (2026-10-28):** when the driver-account model shipped,
  every posted ride and claim was wiped once at boot (marker-gated, so
  rides posted after the wipe are never touched) to avoid mixing old
  free-text drivers with the new account drivers.

### Tools & equipment

- **Tools pool (mentors only):** mentors list the tools/gear an event
  needs. The pool renders as a table — **Name, Amount, Vehicle** —
  with notes under the name. Mentors add, edit (name/qty/notes), and
  delete rows. Every tool starts **unassigned** until a mentor or its
  vehicle's driver confirms it.
- **Assignment is by vehicle id, not driver name**
  (`tools.vehicle_type` + `vehicle_id`). A tool stays with the *car*
  when a mentor reassigns the car's driver, and deleting a car sends
  its tools back to the pool (reported in the delete response)
  instead of leaving them pointed at a ghost. Old name-based
  assignments were migrated once at boot (carpool driver for the
  event first, else van name; unmatched names — including every
  carpool wiped by the driver-account clean slate — fell back to
  unassigned). Since the 2026-10-30 cleanup, new assignments are
  carpools only: legacy 'van' rows still exist in the database
  (dormant backend) and show as Unassigned in the UI.
- **Who can assign/release:** mentors may assign any tool to any
  event carpool, and release or move any tool. A parent may only
  load a vehicle they drive — their own carpool — and may only
  release a tool from their own vehicle; moving a tool off someone
  else's vehicle is a mentor's job. Students see the table
  read-only (they used to see Claim buttons, and claim/unclaim had
  no permission checks at all).
- **One row = one vehicle, whole quantity.** Splitting a quantity
  across vehicles means two rows (e.g. ×6 and ×4).
- **Assignment status at a glance:** the Vehicle column shows a red
  **Unassigned** pill while a tool is still in the pool and a green
  pill naming its car once assigned (a vehicle id pointing at a
  deleted vehicle counts as unassigned).
- **Collapse all / Expand all:** the Tool sign-up list has Expand
  all and Collapse all buttons, mirroring the Events RSVP lists.
  Collapsing hides the table and shows a "Tool list collapsed — N
  tool(s) hidden" note; the Add tool form and CSV import/export stay
  visible, and the collapsed state survives re-renders (e.g. after
  adding a tool) until expanded again.
- **CSV backup/import (mentors only):** `GET /api/events/<id>/tools.csv`
  exports Name, Qty, Notes, Vehicle (carpool driver name, or
  "Team van X", blank when unassigned) — the same columns the import
  accepts. `POST /api/events/<id>/tools/import` upserts by name
  (case-insensitive) and never deletes: new rows are added, existing
  rows get qty/notes updated, and a vehicle name that matches an event
  carpool driver or a van assigns the row — an unmatched vehicle
  leaves the row unassigned and is reported, along with skipped rows.
  Only columns present in the file overwrite on update. Single-step
  (unlike the roster/events preview-confirm flow) because nothing
  here deletes; the summary is the confirmation record.
- **Team vans — removed from the UI (2026-10-30 cleanup):** tools
  and robots now ship in parents' cars, so the van list, van ride
  tables, per-day driver overrides, and van options in the tool
  picker are gone from Travel. The backend endpoints, tables, and
  server rules (designated drivers, day drivers, van claims,
  waitlists) remain untouched and dormant, so existing data and
  old clients don't break — tools that pointed at vans show as
  Unassigned, and van riders show as needing a ride until a
  mentor seats them in a car.
- **Ride gaps live in the Logistics status table:** the day
  sections no longer carry a needs-a-ride line — the status table
  above shows each person's ride gap per day (red Ride pill).
  Waitlisted riders count as needing a ride (no seat yet). 'Needs
  ride' means not on any posted ride; a parent driving themselves
  without posting a carpool still shows as needing one.
- **Logistics status has two more read-only tables (2026-10-30):**
  under the per-person status table, **Cars, riders & tools** —
  one row per vehicle per day it runs (Day | Vehicle | Driver |
  Tools / robots | Riders), with stable per-trip vehicle numbers,
  tools loaded in that vehicle (tools are per-trip, so the same
  tools show on every day the vehicle runs), and claimed riders
  seated that day (waitlisted are not riders yet; unassigned tools
  appear in no vehicle's row) — and **Hotel rooms** — one row per
  room per day it is allocated for (Day | Room | Capacity x/y |
  Occupants), including empty rooms. Both are visible to everyone
  and carry no actions; events with no vehicles or no hotel block
  show a note instead of rows.
- **Tables 2/3 day presentation (2026-10-30):** the Day cell is
  one entry per day, not repeated per row — it spans all of that
  day's rows (rowspan) and appears only on the day's first row.
  Each day's rows share one band shade so the day reads as a
  group: odd days lean further from the card base than even days
  (dark theme: 50% lighter on odd days, 25% lighter on even days;
  light theme: 50% darker on odd days, 25% darker on even days).
- **Event "needs" flags (2026-10-30):** creating an event offers
  three checked-by-default checkboxes — Hotel rooms needed,
  Carpool rides needed, Tools / robots needed — stored as
  `needs_hotel` / `needs_rides` / `needs_tools` on the event and
  editable in the event Edit form. Travel & Logistics shows only
  what the event needs: hotel sections (hotel card, rooms tables
  in day sections, Hotel rooms table) only when hotel is needed,
  carpool sections (day-section carpool tables, Cars table, Fleet,
  Post a ride) only when rides are needed, the Tool sign-up card
  only when tools are needed. The status table shows a dash for
  an unneeded category instead of a red pill, and the Travel
  header text lists only the needed sections. Old events default
  to all three needed, so nothing disappears on existing events.
  The API does not block creating a car, hotel, or tool for an
  unneeded category — the sections are only hidden in the UI.
- **Multiple-days checkbox (2026-10-30):** the event create and
  Edit forms carry a "Multiple days" checkbox; the End date field
  only shows (and only counts) when it is checked. Unchecking
  clears the end date, so a multi-day event reverts to
  single-day. The checkbox is form UX only — multi-day itself is
  still derived from `end_date`.

### Hotels

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
- **No room-parent role anymore (2026-10-30 cleanup):** rooms hold
  students, attending parents (by name, since the 2026-10-30
  follow-up opened placement to every attendee for the day), and
  attending mentors. There is no volunteer button, no mentor
  picker, no Room parent column, and no bed counted for a parent
  as a role — capacity is beds only. The backend
  columns, endpoints, and server rules (one room per parent per
  night, attendance checks) remain untouched and dormant.
### Rooming requests — removed from the UI (2026-10-30 cleanup)

- Rooming requests (a student + preferred roommates, chosen from
  attending students) are gone entirely: no request form, no
  "awaiting placement" line, no request management. Placement is
  mentor-only from the day's attendee pool, so no request step is
  needed. The backend endpoint and table remain untouched and
  dormant.
- **Mentor-only beds:** only mentors/admins place or remove
  occupants, for anyone; students and parents have no place or
  remove action. Placement is per day from that day's attendee
  pool; capacity is per day; one room per person per day; placing
  in another room for the same day moves the bed; a move into a
  full room 409s with the old bed intact.
- Only attending students (going, or a partial covering the day)
  can be placed in a room.
- **Re-assigning a bed moves it:** placing a student in another
  room for the same day moves their bed there instead of 409ing,
  and the pickers keep offering already-placed students on other
  rooms. A move into a full room 409s with the old bed intact.
- **Mentors can pick a room for themselves:** a mentor attending
  a trip gets a "(mentor — you)" entry in each day's place picker,
  filing a name-only occupant row (mentors hold no roster row)
  after the server checks their own RSVP for that day; the pill
  shows their name, and they remove it with the same ✕. Existing
  databases migrate the occupants table once at boot (nullable
  member + person_name column) without losing rows.

## Data & hosting

- Self-hosted Flask + SQLite app; no external services required.
- One database file (`data.db` by default, `DB` env var overrides);
  schema migrations for new columns run automatically at startup.
- Mentors/admins can download a **full database backup** from the Mentor
  Queue (`GET /api/backup`): the server copies the live database with
  SQLite's online backup API under the app lock, so the snapshot is
  consistent even while the server runs, and serves it as
  `frc-team-app-backup-YYYYMMDD.db`. Restoring is copying the file back
  over `data.db` while the server is stopped.
- **Duplicate cleanup (Mentor Queue card):** removing and re-creating
  accounts used to leave two approved member rows (or two user rows)
  for one person, and every picker showed the name twice. The queue's
  **Duplicate cleanup** card scans for them (`GET /api/admin/duplicates`,
  mentor/admin only): approved members grouped by normalized name and
  users grouped by normalized name, each group with a suggested
  survivor (lowest member id; for accounts, enabled with a password
  first) pre-checked as a radio, plus a detail line (code, school,
  grade, subteam, parent, and counts of RSVPs, beds, seats, check-ins,
  links for members; email, role, disabled/password/2FA state, links,
  cars, vans for accounts). **Merge into selected**
  (`POST /api/admin/duplicates/merge`) re-points the dupe's rows onto
  the survivor — RSVPs, check-ins, carpool and van claims, room
  occupants, rooming requests, room parents, link requests, and user
  links — and drops the ones that collide with a row the survivor
  already has (same event + kind, same room + overlapping day, same
  check-in day, same hotel request), reporting the dropped counts; the
  survivor's own record fields are kept. Account merges are skipped
  per dupe with a reason when both accounts drive a carpool for the
  same event or hold conflicting van designations/day-drivers (the
  surviving account is untouched and the dupe row stays). The whole
  request is validated up front against a fresh scan — a survivor or
  dupe outside the group, or a row merged twice, fails the entire
  request with nothing applied. The scan covers approved members and
  users only; pending/declined/archived member dupes are out of scope
  (decline them from the queue as before). The Team accounts list
  itself is not deduped (emails distinguish rows); the merge tool
  handles true dupes.
- **Picker/list dedupe:** every name picker and list collapses
  duplicate rows by normalized name before rendering — the RSVP person
  picker, the self-RSVP options, carpool seat pickers, room
  placement pickers (placed exclusion is name-aware too), the Travel
  attendee lists, and the room gap lines — so a duplicate row can
  never double-book or double-count while it still exists. The roster
  itself still shows every row (it is the record the cleanup merges),
  with an amber **duplicate** pill on any name that appears more than
  once.

### Sticky session

- Reloading the page returns the user to the tab and event they were on
  (e.g. Travel & Logistics on the Sacramento event), saved in the
  browser's local storage. A saved event that no longer exists falls
  back to the first event; logging out clears the saved place.
