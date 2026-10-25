# Bugs & Bug TODO — FRC Team App

Living log for reported bugs. Newest entries first in each section.
Format: **Reported** (who + what) → **Root cause** → **Fix** (commit).

## Open TODO

_None right now._

## Fixed

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
