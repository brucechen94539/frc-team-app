# Feature Requirements — FRC Team App

The central source of truth for how the app is supposed to behave.
Update this file whenever a feature rule changes. (Defects are tracked
separately in [BUGS.md](BUGS.md); setup/run instructions are in the README.)

**Key definition — "attending":** a person counts as attending an event
when their RSVP for that event has status **going**. `maybe`, `waitlisted`,
and `declined` do not count as attending.

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
- **Students and parents** can RSVP; statuses: going / maybe / declined /
  waitlisted.
- When an event is full, new "going" RSVPs join the waitlist and are
  auto-promoted as spots open.
- Event pickers in the UI are **bubbles** (chips), not dropdowns: the picked
  event is highlighted and the sections below update to that event.

## Attendance & task tracking

- Check-in has **two paths**: mentors mark attendance, and students can
  self check-in. A self check-in is unverified until a mentor confirms it.
- The app tracks hours per student and a task board; mentors create tasks
  and mark them done. A dashboard summarizes attendance and hours.

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

### Tools & equipment

- Mentors list the tools/gear an event needs; anyone signed in can claim
  what they'll bring and unclaim it.

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
- **Families request** rooming (student + preferred roommates, chosen from
  attending students); **mentors finalize** by placing students into rooms.
- Only students attending the event can request a room, be listed as a
  preferred roommate, or be placed in a room.
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
