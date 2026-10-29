# Bugs & Bug TODO — FRC Team App

Living log for reported bugs. Newest entries first in each section.
Format: **Reported** (who + what) → **Root cause** → **Fix** (commit).

## Open TODO

_None right now._

## Fixed

### Duplicate members/accounts after remove-and-recreate (2026-10-29, commit da92cb2b)

**Reported** (Bruce): after removing and re-creating users, lists showed
dupes — Joe Blow, Zander Chen, and so on. **Root cause:** deleting an
account archives only its self-linked members, so re-creating and
re-approving a person left two approved member rows (and a disabled
old account next to the new one), and every picker rendered each row.
**Fix:** a Mentor Queue **Duplicate cleanup** card (`GET
/api/admin/duplicates` + `POST /api/admin/duplicates/merge`) that scans
approved members and users by normalized name, suggests a survivor per
group, and merges with conflict-aware re-pointing (colliding RSVPs,
placements, claims, check-ins, and requests are dropped and counted;
vehicle-colliding account dupes are skipped with a reason; the whole
request validates against a fresh scan first). Pickers and lists dedupe
by name in the meantime, and the roster marks dupes with an amber
**duplicate** pill. Verified: 19 API checks (merge drops, re-points,
blocks, validation) + 8 browser checks (card merge flow, picker once,
roster marker) + fleet suite re-run green.

### Room-parent volunteering, parent bed, and own-only seats/beds (2026-10-29)
- **Reported:** Bruce — three reports in one thread: (1) a parent
  should not be allowed to volunteer as room parent for any other
  parent; (2) when a room parent is assigned, it takes away at least
  1 spot; (3) students and parents should not be able to remove
  occupants except for themselves — with the clarification that a
  parent IS allowed to add/remove their own student in a carpool or
  hotel room.
- **Root cause:** (1) the room-parent POST took any member_id from
  the picker and recorded that family's parent name, with no check
  that a parent caller was volunteering themself. (2) room capacity
  counted only student occupants; the assigned parent slept in the
  room for free. (3) carpool and van claim POSTs and DELETEs had no
  ownership check at all — anyone logged in could claim a seat for,
  or release the seat of, anyone (the ✕ on every rider pill
  rendered for every role), while room place/unplace were
  mentor-only, so parents couldn't manage even their own child.
  Two follow-on gaps surfaced while fixing: the login/verify
  responses omitted the identity links, so the browser's own-only
  pickers saw an empty link set and offered nobody; and the rooms
  place cell carried the `.mo` class, which Travel strips for
  non-mentors, so parents never saw the place select at all.
- **Fix:** one own-only rule (`_may_act_for`, server-side, link
  based) now gates every seat and bed: mentors/admins act for
  anyone; students act only for themselves; parents act only for
  their own linked children (or themselves as parent riders).
  Room-parent POST/DELETE: a parent caller resolves to their own
  linked member (a foreign member_id is 403); the parent UI has no
  picker, just a self-volunteer button. Room capacity counts an
  assigned parent as 1 bed every day the room runs (pill counts it,
  with a tooltip). Room place opened to parents for their own
  student (students still place nobody; they file rooming
  requests); room unplace, carpool/van claim, and carpool/van
  release all enforce the same rule. `_public_user` now attaches
  links on every auth response, and the rooms place cell no longer
  uses `.mo`. Verified by API (52 checks: all three bugs, the
  parent-own-student allowance, and the mentor path) and browser
  (13 checks: parent/student/mentor pickers and ✕ visibility,
  including placing and removing one's own student in the UI).
  (commit 5765701f)

### RSVP spoofing via the name field (2026-10-28)
- **Reported:** Bruce — RSVP should limit to self, with an error
  when spoofing happens.
- **Root cause:** the RSVP scope check pinned only member_id +
  kind. It never looked at person_name, so a parent linked to one
  child could file a going RSVP under another parent's name — and
  that fake name then counted as a going parent for driver
  eligibility (going_parents is name-matched), ride status, and
  headcounts. A student could likewise overwrite their own row's
  name with someone else's, since the upsert rewrites person_name.
  The UI picker only ever offered own entries, so this was only
  reachable by a forged request — but the server is the gate that
  matters.
- **Fix:** for non-mentors, the supplied name must now match
  (case/space-insensitively) the roster record for that member/kind
  or the signer's own account name, or the request is rejected
  with a 403 ("that name doesn't match your roster record or
  account — you can only RSVP as yourself") instead of being
  silently corrected. The account-name allowance covers
  relationship-linked parents whose recorded parent_name differs
  from their account name. Mentor/admin override is unchanged:
  mentors can still file for anyone under any name. Verified by
  API: a parent spoofing another parent's name and a student
  spoofing another student's name both get 403 with no row
  created/changed, legit RSVPs (including a loose case/space
  variant) still succeed, and the mentor override still files.
   (commit 0581180d)

### Tool sign-up list: collapse/expand all + red/green assignment status (2026-10-28)
- **Reported:** Bruce — "make collapse all/expand all for Tool
  sign-up list" and "tools show red color when not assigned to
  vehicle, green when assigned".
- **Fix:** the Tool sign-up card in Travel now has Expand all /
  Collapse all buttons (same pattern as the Events RSVP lists):
  collapsing hides the table, shows a "Tool list collapsed — N
  tool(s) hidden" note, keeps the Add tool form and CSV
  import/export visible, and survives re-renders until expanded
  again. The Vehicle column is now a status pill: red
  "Unassigned" while a tool is in the pool, green with the car
  driver's name or van name once assigned (a stale vehicle id
  counts as unassigned). Verified in Chromium: collapse hides the
  table and shows the note, expand restores it, the collapsed state
  survives a re-render, and an unassigned tool shows a red pill
  while an assigned one shows green.
  (commit deed08ea)

### Seat picker offered drivers and already-seated riders; Post Ride pool ignored van drivers (2026-10-28)
- **Reported:** Bruce (screenshot) — on Jessica Ting's car card, the
  Claim seat dropdown offered Jessica herself (the driver), and a
  rider already seated on one ride still appeared in every other
  ride's picker; a van that had become available with seats did not
  change the Post Ride driver pool.
- **Root cause:** each card's picker filtered only that vehicle's own
  claims/waitlist, so drivers and riders seated on other vehicles
  stayed in the list; the mentor driver pool filtered only carpool
  drivers, never van drivers; and the server had no cross-vehicle
  guard at all — a forged claim could seat a driver or double-seat a
  rider, and a carpool posted for a van driver silently knocked that
  van out of the event (the travel endpoint hides a van whose driver
  is also driving a carpool).
- **Fix:** one seat per person per event, across every vehicle, in
  the UI and on the server. The seat pickers (carpool and van) now
  exclude everyone driving for the event (carpool or van driver,
  including the card's own driver) and everyone already holding a
  claimed seat on any car or van; a person waitlisted on one ride
  can still grab an open seat on another (they hold no seat yet).
  The Post Ride pool is recomputed from each render's travel data
  and now also excludes eligible van drivers, and a parent already
  driving a car or van for the event sees a note instead of the Post
  Ride form. Server-side: claiming as a driver is 403, claiming
  while already seated elsewhere is 409, posting (or reassigning)
  a carpool to a parent already driving a carpool or a seated van
  for the event is rejected, and waitlist promotion skips riders
  who have since become drivers or been seated elsewhere (verified:
  a waitlisted rider who took a van seat was skipped and the next
  rider promoted). Verified by API and in Chromium: a car card whose
  driver, van driver, and two riders were all taken offered only the
  one unseated attendee, and the Post Ride pool showed no available
  parents while both parent accounts were driving.
  (commit d4177151)

### Logged-out sign-up submit yanked the visitor to the login page (2026-10-26)
- **Symptom:** after submitting a sign-up (link request or name-only
  application) as a logged-out visitor, the page jumped to login
  instead of staying on the sign-up form.
- **Root cause:** both submit handlers call `refreshBadges()`, which
  fetched `/api/events` unconditionally. Logged out, that returns 401,
  and the shared `api()` helper redirects to login on any non-auth 401
  — even though badge fetching is best-effort and badges only exist on
  nav buttons that logged-in users see. The old full-application form
  had the same latent bug (it also called `refreshBadges()`).
- **Fix:** `refreshBadges()` returns early when there is no logged-in
  user (`!ME`). Logged-in behavior is unchanged (badges still refresh
  after login and after queue actions). Verified in the browser: a
  logged-out link request and name-only submit both stay on the
  sign-up form.
  (commit 8f739d6d)

### Build session still said lunch is provided, on an existing database (2026-10-25)
- **Symptom:** the Build Session card still read "lunch provided for
  full-day crew" even after the wording round, on Bruce's own database.
- **Root cause:** the wording round fixed only the seed note, and seed
  data only lands in fresh databases. Existing events keep whatever
  notes were stored when they were created, and there is no UI to edit
  an event's notes.
- **Fix:** `_migrate` now rewrites that exact phrase to "no lunch
  provided — bring your own" in any stored event note, on every boot.
  Idempotent (the match disappears after the rewrite) and scoped to
  the exact phrase — other notes, including other lunch mentions, are
  untouched. Verified on a test database with all three cases.
  (commit f462428e)

### Operation toast had wrong contrast (2026-10-25)
- **Symptom:** the bottom operation bubble was hard to read.
- **Root cause:** the toast background was hardcoded to dark slate
  (`#182032`) while its text followed the theme variable: in light
  mode that is dark text on a dark bubble (measured ~1.2:1, nearly
  invisible), and in dark mode the bubble blended into the dark cards
  behind it.
- **Fix:** theme-aware toast background (`--toastbg`: lighter slate in
  dark mode, white in light mode). Measured after the fix: 12.3:1 in
  dark mode, 16.4:1 in light mode, and the bubble now stands out from
  the cards behind it. (commit f462428e)

### Blank page, no login: stale cached page + new script killed all JS (2026-10-25)
- **Symptom:** header rendered but the main area was empty — no login
  form, no working button. The page title still showed the pre-rename
  team name even though `git log` showed the latest commit, and the
  server log showed 304 for `/`, `style.css`, and `app.js` on every
  reload, so reloading changed nothing.
- **Root cause (two parts):** (1) the browser reused a cached
  pre-avatar `index.html` while running the current `app.js`; the
  avatar round's top-level `$("user-avatar").addEventListener(...)`
  ran against a page without that element, threw at script load, and
  no boot code ever ran — so no view rendered at all. Reproduced
  exactly: old HTML + new JS gives "Cannot read properties of null
  (reading 'addEventListener')", no login form, empty main. (2)
  Flask's default 12-hour static cache meant the browser could keep
  serving yesterday's page for hours after a pull, and plain reloads
  kept revalidating into 304s instead of fetching fresh files.
- **Fix:** guard the header-avatar binding (skipped when the element
  is absent), make `showView` fall back to Events for an unknown view
  instead of throwing, and set `SEND_FILE_MAX_AGE_DEFAULT = 0` so the
  dev server sends `Cache-Control: no-cache, max-age=0` (a 304 then
  only means the file truly hasn't changed). Re-ran the skew
  reproduction with the fix: no errors, login works, Events reached.
  (commit a8d0d361)

### RSVP deadline was UI-only: late RSVPs still accepted (2026-10-25)
- **Symptom:** after an event's deadline, the RSVP buttons disappeared,
  but the endpoint still accepted a filed RSVP — anyone could post one
  past the deadline.
- **Root cause:** `POST /api/events/<eid>/rsvps` never checked the
  event's deadline; only the frontend hid the picker.
- **Fix:** the server rejects non-mentor RSVPs once the deadline passes
  (403, same UTC-date rule the UI uses); mentors/admins keep an
  override and now see the picker on closed events with an override
  note, so the override is actually usable. Removing an RSVP stays
  allowed after the deadline (it only frees a spot). (commit 04f6f22e)

### Link backfill never ran: table-existence check defeated by init order (2026-10-25)
- **Symptom (caught in pre-push testing, never shipped):** after
  migrating an old database, the `user_members` table stayed empty —
  no account linked to any roster member.
- **Root cause:** the one-time backfill was gated on the link table
  not existing yet, but `init_db` runs `schema.sql` (which creates the
  table) before `_migrate` runs, so the gate was always false.
- **Fix:** the backfill is gated on a marker row in a new `meta`
  table (`iam_links_backfilled`) instead. Verified on a migrated old
  database: links, opt-in WhatsApp fill, and marker all land, and a
  mentor's unlink survives a restart. (commit 04f6f22e)

### RSVP: any user could RSVP for anyone else (2026-10-25)
- **Symptom:** logged in as a student, Zander could pick "Bruce Chen
  (parent)" in the RSVP picker and RSVP for him.
- **Root cause:** `POST /api/events/<eid>/rsvps` had no ownership check
  at all, and the picker listed every person. The removal check also used
  exact name matching, so an account like 'zanderchen' could not remove
  its own 'Zander Chen' RSVP.
- **Fix:** non-mentors may RSVP only for themselves — students for their
  own student record, parents for their own children (member linkage via
  parent_name, loose name matching); mentors/admins keep the full picker
  as override. Removal uses the same linkage. The picker for non-mentors
  shows only their own entries (a parent with several children gets one
  labeled entry per child); unlinked accounts get a "ask a mentor"
  note instead of buttons. (commit 3e5677f8)

### Bare `hidden` class hid nothing (2026-10-25)
- **Symptom:** the new collapsible RSVP lists rendered expanded despite
  carrying class "hidden".
- **Root cause:** style.css only defined `.badge.hidden` and
  `.view.hidden` — a plain `hidden` class on any other element had no
  rule, so it stayed visible.
- **Fix:** added a global `.hidden{display:none}` rule. Every `hidden`
  use in the app means invisible, so no other element is affected.

### Carpool: same person in Riders and Waitlist at once (2026-10-24)
- **Symptom:** Sam Okafor appeared under both Riders and Waitlist on the
  same car (screenshot: Daniel Kim's car, 0 of 4 seats open).
- **Root cause:** `POST /api/carpools/<cid>/claims` never checked for an
  existing row — claiming twice created a second row, which landed in the
  waitlist once the car was full (or a second claimed seat while seats
  were open). Promotion also picked the first waitlisted row blindly.
- **Fix:** the claim endpoint rejects a second row for the same person on
  the same carpool (409, under lock); promotion skips waitlisted people
  who already hold a claimed seat; server boot collapses pre-existing
  duplicates (earliest claimed kept, else earliest waitlisted); and the
  seat picker no longer offers people already on the ride or waitlist. (commit 429815d6)

### Rooming requests: anyone could withdraw anyone's pending request, and a student could pick themself as roommate (2026-10-24)
- **Symptom:** the rooming form let any signed-in user file for any student and list the requester as their own roommate, and the pending-request delete had no ownership check — any user could withdraw anyone else's pending request (the UI showed Withdraw on every pending row).
- **Root cause:** `POST /api/hotels/<hid>/requests` had no role check at all, and `DELETE /api/rooming-requests/<qid>` only gated the placed state; pending deletes were open to all.
- **Fix:** students file for themselves only (account matched to a member by normalized name, so 'zanderchen' matches 'Zander Chen'), parents get 403, mentors may file on behalf; preferred roommates must be attending (going or partial) students and may not include the requester; pending deletes are owner-or-mentor only. Frontend: students see "Requesting as <you>" with no student picker and no self in the roommate picker, students see only their own requests, parents don't see the module, and the rooms badge counts per role (mentors all pending, students own pending, parents none). (commit 0fe96719)

### 2026-10-25 — Event Delete button visible to students
- **Reported:** Bruce (screenshot) — a student account saw a red DELETE
  button on every event card, although deleting was already rejected
  server-side.
- **Root cause:** the event-card Delete button rendered for every role;
  only the event-creation form was hidden from non-mentors.
- **Fix:** the Delete button now renders only for mentors/admins, matching
  the server's existing role gate. (commit 26abb945)

### 2026-10-25 — "QR code support is not installed" on 2FA setup
- **Reported:** Bruce — "Set up authenticator app" failed with a 503 for
  both mentor and parent accounts.
- **Root cause:** the setup endpoint returned 503 whenever the `qrcode`
  package wasn't importable by the Python running the server — most
  likely `pip install` landed in a different interpreter than the one
  running `app.py`, or the server wasn't restarted after installing.
- **Fix:** setup no longer hard-fails without `qrcode`: it returns the
  manual key and the UI offers key entry instead of a QR code, so
  enrollment works either way. A missing `cryptography` package now
  reports the exact fix (`python3 -m pip install -r requirements.txt`,
  then restart) instead of a bare error. (commit e8703091)

### 2026-10-25 — QR code renders as a blank box
- **Reported:** Bruce (screenshot) — after installing the package, setup
  showed the manual key but the QR area was an empty white box.
- **Root cause:** `qrcode`'s SVG factory emits `<svg:rect>` elements.
  Inserted into the page via innerHTML, browsers don't recognize the
  prefixed tags as SVG shapes, so nothing draws.
- **Fix:** the server normalizes the SVG before sending it — plain
  `<rect>` elements, no `svg:` prefixes, millimetre coordinates converted
  to a viewBox so the code scales to its container. Verified with a real
  Chromium render: the old markup stays blank, the normalized markup
  draws a crisp QR code. (commit 70c532f7)

### 2026-10-19 — Students could define carpool rides
- **Reported:** Bruce — a logged-in student saw the full "post a ride" form (driver name, seats, departure point/time, return plan, notes) in Travel & Logistics; students should only see the sign-up options and pick which car/parent to go with.
- **Root cause:** `POST /api/carpools` had no role check, and the ride form rendered for every role.
- **Fix:** Ride form hidden for `student` accounts; server returns 403 for students on `POST /api/carpools`. Parents/mentors/admins can still post rides; students can still claim seats. (commit c52d438f)

### 2026-10-19 — Student could volunteer as room parent (and showed as room parent)
- **Reported:** Bruce — a student could pick a parent from the room-parent volunteer list, but the student ended up showing as the room parent.
- **Root cause:** the volunteer flow was open to every logged-in user and the room-parent name was stored verbatim from the browser.
- **Fix:** Volunteering (and the UI) gated to parents/mentors/admins — students get 403. The server now writes the family's `parent_name` from the member record, so a student name can never land in the slot. Room parent is also optional per room (no mandatory warnings). (commit 46de19cd)

### 2026-10-19 — Ranked subteam picker allowed duplicate picks
- **Reported:** Bruce — the sign-up form let the same subteam be picked in more than one preference slot.
- **Root cause:** the three preference dropdowns didn't exclude already-picked subteams.
- **Fix:** Already-picked subteams are grayed out (disabled) in the other dropdowns, re-enabled when a pick changes/clears, plus submit-time dedupe. (commit 13556748)
