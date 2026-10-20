# FRC Team Sign-Up — lightweight self-hosted app

A small Flask + SQLite web app for an FRC robotics team: team sign-ups with
mentor approval, event RSVPs, attendance/hours tracking, a task board, carpools,
tool sign-up, and hotel room assignments. Deliberately lightweight — a stepping
stone between the static prototype and a production server.

**No authentication in this build.** Anyone who can reach the server can use
every feature (including the mentor queue). The `users` table already has a
`role` column (`student`/`parent`/`mentor`/`admin`) and a nullable
`password_hash` column stubbed for the future auth step. Do not expose this to
the open internet without adding auth first.

## Run it

```bash
cd frc-team-app
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000. The SQLite database is created as `data.db` on
first run and seeded with labeled sample data (clear samples from the Mentor
Queue view).

Environment variables:

| Var   | Default      | Notes                                            |
|-------|--------------|--------------------------------------------------|
| `DB`  | `data.db`    | SQLite file path, or `:memory:` for ephemeral mode |
| `PORT`| `5000`       | Listen port                                      |

```bash
DB=:memory: python app.py   # nothing is saved; fresh seed every restart
DB=/srv/frc/team.db python app.py
```

## What's inside

- `app.py` — Flask app + JSON REST API (see "API" below), serves the frontend
  same-origin (no CORS). Single shared SQLite connection + lock: fine for one
  process serving a team; a production server would use a real pool.
- `schema.sql` — all tables.
- `seed.py` — sample members, events, RSVPs, check-ins, tasks, carpools,
  tools, hotel block, rooms, and rooming requests mirroring the prototype.
- `static/` — vanilla-JS single-page frontend (`index.html`, `app.js`,
  `style.css`).

## API (JSON)

- `GET/POST /api/members` · `GET/PATCH/DELETE /api/members/<id>`
  (PATCH: `{status, assigned_subteam}`)
- `DELETE /api/members/sample` — clear sample entries
- `GET /api/members/<id>/welcome` — copyable welcome message
- `GET /api/roster` · `GET /api/roster.csv`
- `GET/POST /api/events` · `DELETE /api/events/<id>`
- `GET/POST /api/events/<id>/rsvps` (server enforces capacity → waitlist)
- `DELETE /api/rsvps/<id>` (auto-promotes oldest waitlisted)
- `POST /api/checkins` (`{event_id, member_id, person_kind, person_name, method, hours}`;
  `method=self` lands unverified) · `PATCH /api/checkins/<id>` (`{verified}`)
- `GET /api/events/<id>/checkins` · `GET /api/hours`
- `GET/POST /api/tasks` · `PATCH/DELETE /api/tasks/<id>`
- `GET /api/events/<id>/travel` — carpools + tools + hotel block in one call
- `POST /api/carpools` · `POST /api/carpools/<id>/claims` ·
  `DELETE /api/carpool_claims/<id>` (auto-promote)
- `POST /api/tools` · `POST /api/tools/<id>/claim` · `POST /api/tools/<id>/unclaim`
- `POST /api/hotels` (upsert per event) · `POST /api/hotels/<id>/rooms`
- `POST /api/hotels/<id>/requests` (upsert per student; families' rooming requests)
- `POST /api/rooms/<id>/occupants` (mentor places; flips request to `placed`)
- `DELETE /api/room_occupants/<id>`
- `GET /api/subteams` · `GET/POST /api/users`

## Hosting notes

- **Cheapest real option:** a small VPS (a few dollars/month), run
  `python app.py` behind a reverse proxy, or just `flask run` for a trial.
  Back up `data.db` regularly — it's a single file.
- **Private team access without opening ports:** run it on a machine on the
  team's [Tailscale](https://tailscale.com) network and share the tailnet
  address — no public exposure at all.
- **LAN-only:** `python app.py` binds `0.0.0.0`; teammates on the same Wi-Fi
  can open `http://<your-ip>:5000`.
- Before any internet exposure: add authentication (hash passwords with
  argon2id/bcrypt into `users.password_hash`, enforce `users.role`
  server-side), put it behind HTTPS, and rate-limit logins.

## Roadmap (not built yet)

Auth + roles, WhatsApp OTP via the Business Cloud API, Discord OAuth login,
WhatsApp announcement pushes, email notifications.
