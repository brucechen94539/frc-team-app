# Bugs & Bug TODO — FRC Team App

Living log for reported bugs. Newest entries first in each section.
Format: **Reported** (who + what) → **Root cause** → **Fix** (commit).

## Open TODO

_None right now._

## Fixed

### 2026-10-25 — Event Delete button visible to students
- **Reported:** Bruce (screenshot) — a student account saw a red DELETE
  button on every event card, although deleting was already rejected
  server-side.
- **Root cause:** the event-card Delete button rendered for every role;
  only the event-creation form was hidden from non-mentors.
- **Fix:** the Delete button now renders only for mentors/admins, matching
  the server's existing role gate. (commit 26abb945)

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
