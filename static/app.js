/* FRC Team Sign-Up — vanilla JS frontend talking to the Flask REST API. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {"Content-Type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith("/api/auth/")) {
    ME = null;
    applyNav();
    if ($("view-login").classList.contains("hidden")) showView("login");
  }
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}
const GET = (u) => api("GET", u);
const POST = (u, b) => api("POST", u, b);
const PATCH = (u, b) => api("PATCH", u, b);
const DEL = (u) => api("DELETE", u);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

let SUBTEAMS = [];
let rosterCache = [];   // approved members
let queueFilter = "pending";
let rosterSearch = "", rosterSubteam = "";
let eventFilter = "all", eventSearch = "";
let trackEventId = null, travelEventId = null;
let ME = null;          // logged-in user ({id,name,email,role}) or null
let SETUP = false;      // first run: no account has a password yet
const MENTOR = () => !!(ME && (ME.role === "mentor" || ME.role === "admin"));

/* Show only the nav this session may use; chip + logout when logged in. */
function applyNav() {
  document.querySelectorAll("#nav button").forEach((b) => {
    const v = b.dataset.view;
    let show;
    if (!ME) show = (v === "signup" || v === "login");
    else if (!MENTOR()) show = (v !== "queue" && v !== "roster" && v !== "login");
    else show = (v !== "login");
    b.classList.toggle("navhide", !show);
  });
  $("account-box").classList.toggle("navhide", !ME);
  if (ME) $("user-chip").textContent = ME.name + " \u00b7 " + ME.role;
}

/* ---------------- navigation ---------------- */
document.querySelectorAll("#nav button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});
function showView(name) {
  if (!ME && name !== "signup" && name !== "login") name = "login";
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  ({signup: renderSignup, queue: renderQueue, roster: renderRoster,
    events: renderEvents, tracking: renderTracking, travel: renderTravel,
    login: renderLogin})[name]();
}

/* ---------------- login ---------------- */
function renderLogin() {
  const v = $("view-login");
  if (ME) { showView("events"); return; }
  v.innerHTML = `
  <div class="login-wrap"><div class="card">
    <h2>${SETUP ? "Create the admin account" : "Log in"}</h2>
    <p class="sub">${SETUP
      ? "First run: create the first team account — it becomes the admin. You can add everyone else later from Mentor Queue \u2192 Team accounts."
      : "Mentors, parents and students log in here."}</p>
    <div class="err" id="lg-err"></div>
    ${SETUP ? '<div class="field"><label>Name</label><input id="lg-name"></div>' : ""}
    <div class="field"><label>Email</label><input id="lg-email" type="email" autocomplete="username"></div>
    <div class="field"><label>Password</label><input id="lg-pass" type="password" autocomplete="current-password"></div>
    <button class="btn" id="lg-go">${SETUP ? "Create account" : "Log in"}</button>
    ${SETUP ? "" : '<p class="sub" style="margin-top:16px">New to the team? <a href="#" id="lg-signup">Submit a sign-up application</a> — no account needed.</p>'}
  </div></div>`;
  $("lg-go").addEventListener("click", submitLogin);
  $("lg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitLogin(); });
  const link = $("lg-signup");
  if (link) link.addEventListener("click", (e) => { e.preventDefault(); showView("signup"); });
}

async function submitLogin() {
  const errBox = $("lg-err");
  errBox.textContent = "";
  try {
    const url = SETUP ? "/api/auth/setup" : "/api/auth/login";
    const body = SETUP
      ? {name: $("lg-name").value.trim(), email: $("lg-email").value.trim(), password: $("lg-pass").value}
      : {email: $("lg-email").value.trim(), password: $("lg-pass").value};
    ME = (await POST(url, body)).user;
    SETUP = false;
    applyNav();
    toast("Welcome, " + ME.name + ".");
    showView("events");
    refreshBadges();
  } catch (e) { errBox.textContent = e.message; }
}

async function doLogout() {
  await POST("/api/auth/logout").catch(() => {});
  ME = null;
  const me = await GET("/api/auth/me").catch(() => ({setup_required: false}));
  SETUP = !!me.setup_required;
  applyNav();
  showView("login");
}

async function refreshBadges() {
  try {
    if (MENTOR()) {
      const pending = await GET("/api/members?status=pending");
      const b = $("nav-pending");
      b.textContent = pending.length;
      b.classList.toggle("hidden", !pending.length);
    }
    const events = await GET("/api/events");
    let awaiting = 0;
    for (const e of events) {
      const t = await GET(`/api/events/${e.id}/travel`);
      if (t.hotel) awaiting += t.hotel.awaiting || 0;
    }
    const rb = $("nav-rooms");
    rb.textContent = awaiting;
    rb.classList.toggle("hidden", !awaiting);
  } catch (e) { /* badges are best-effort */ }
}

/* ---------------- sign-up form ---------------- */
function prefSelect(i) {
  const opts = ['<option value="">— pick —</option>'] +
    SUBTEAMS.map((s) => `<option>${esc(s.name)}</option>`).join("");
  return `<div class="field"><label>Preference ${i + 1}</label>
    <select id="pref${i}">${opts}</select></div>`;
}

/* Gray out subteams already picked in another preference slot, so the
   same subteam can't be ranked twice. Recomputed from scratch on change,
   which also re-enables a subteam when a slot is changed or cleared. */
function syncPrefs() {
  const picks = [0, 1, 2].map((i) => $("pref" + i).value);
  [0, 1, 2].forEach((i) => {
    const sel = $("pref" + i);
    [...sel.options].forEach((o) => {
      o.disabled = !!o.value && o.value !== sel.value && picks.includes(o.value);
    });
  });
}

async function renderSignup() {
  const v = $("view-signup");
  v.innerHTML = `
  <div class="card"><h2>Team Sign-Up</h2>
  <p class="sub">Applications go to the Mentor Queue for approval. Fields marked * are required.</p>
  <div class="err" id="su-err"></div>
  <h3>Student</h3>
  <div class="grid2">
    <div class="field"><label>First name *</label><input id="f-first"></div>
    <div class="field"><label>Last name *</label><input id="f-last"></div>
    <div class="field"><label>School</label><input id="f-school"></div>
    <div class="field"><label>Grade</label><input id="f-grade" placeholder="9"></div>
    <div class="field"><label>Experience</label><select id="f-exp">
      <option>Rookie</option><option>Returning</option><option>Veteran</option></select></div>
    <div class="field"><label>Student email</label><input id="f-semail" type="email"></div>
    <div class="field"><label>Student phone</label><input id="f-sphone"></div>
  </div>
  <h3>Parent / Guardian</h3>
  <div class="grid2">
    <div class="field"><label>Name *</label><input id="f-pname"></div>
    <div class="field"><label>Relationship</label><input id="f-rel" placeholder="Mother / Father / Guardian"></div>
    <div class="field"><label>Email</label><input id="f-pemail" type="email"></div>
    <div class="field"><label>Phone</label><input id="f-pphone"></div>
    <div class="field"><label>WhatsApp number <span class="hint">(if different from phone)</span></label>
      <input id="f-wa" placeholder="+1 (510) 555-0100"></div>
    <div class="field"><label>&nbsp;</label><label class="checkline">
      <input type="checkbox" id="f-waok"> Send me team updates on WhatsApp</label></div>
  </div>
  <h3>Emergency contact &amp; medical</h3>
  <div class="grid2">
    <div class="field"><label>Emergency contact name</label><input id="f-emname"></div>
    <div class="field"><label>Emergency contact phone</label><input id="f-emphone"></div>
  </div>
  <div class="field"><label>Medical notes</label>
    <textarea id="f-medical" placeholder="Allergies, inhaler, etc."></textarea></div>
  <h3>Subteam preferences (ranked top 3)</h3>
  <div class="grid3">${prefSelect(0)}${prefSelect(1)}${prefSelect(2)}</div>
  <h3>Subteam Discovery Chats</h3>
  <p class="sub">No-commitment exploration — pick chats to learn what each subteam does.
    Separate from your ranked preferences above.</p>
  <div class="chatgrid" id="f-chats"></div>
  <div class="field" style="margin-top:8px"><label>Discovery sessions</label>
    <select id="f-dsess"><option>Invite me</option><option>Chats only</option>
    <option>Already decided</option></select></div>
  <h3>Notes</h3>
  <div class="field"><textarea id="f-notes" placeholder="Anything the mentors should know?"></textarea></div>
  <h3>Agreements *</h3>
  <label class="checkline"><input type="checkbox" id="ag-conduct"> I agree to the team code of conduct.</label>
  <label class="checkline"><input type="checkbox" id="ag-safety"> I agree to follow all shop safety rules.</label>
  <label class="checkline"><input type="checkbox" id="ag-photo"> I consent to photos/video at team events.</label>
  <label class="checkline"><input type="checkbox" id="ag-dues"> I acknowledge team dues/fees.</label>
  <div class="row" style="margin-top:12px">
    <button class="btn" id="f-submit">Submit application</button>
    <button class="btn ghost" id="f-fill" type="button">Fill with example details</button>
  </div></div>`;
  $("f-chats").innerHTML = SUBTEAMS.map((s) => `
    <label class="chatcard"><input type="checkbox" value="${esc(s.name)}">
    <b>${esc(s.name)}</b><br><span class="sub">${esc(s.blurb)}</span></label>`).join("");
  document.querySelectorAll("#f-chats input").forEach((cb) =>
    cb.addEventListener("change", () =>
      cb.closest(".chatcard").classList.toggle("sel", cb.checked)));
  [0, 1, 2].forEach((i) => $("pref" + i).addEventListener("change", syncPrefs));
  syncPrefs();
  $("f-submit").addEventListener("click", submitApplication);
  $("f-fill").addEventListener("click", () => {
    const set = (id, v) => { $(id).value = v; };
    set("f-first", "Riley"); set("f-last", "Nguyen");
    set("f-school", "BASIS Independent Fremont"); set("f-grade", "9");
    $("f-exp").value = "Rookie";
    set("f-semail", "riley.nguyen@example.com");
    set("f-pname", "Minh Nguyen"); set("f-rel", "Father");
    set("f-pemail", "minh.nguyen@example.com"); set("f-pphone", "(510) 555-0174");
    set("f-wa", "+1 (510) 555-0174"); $("f-waok").checked = true;
    set("f-emname", "Minh Nguyen"); set("f-emphone", "(510) 555-0174");
    $("pref0").value = "Programming"; $("pref1").value = "Media"; $("pref2").value = "Outreach";
    syncPrefs();
    document.querySelectorAll("#f-chats input").forEach((cb) => {
      cb.checked = ["Programming", "Media", "Outreach"].includes(cb.value);
      cb.closest(".chatcard").classList.toggle("sel", cb.checked);
    });
    ["ag-conduct", "ag-safety", "ag-photo", "ag-dues"].forEach((id) => { $(id).checked = true; });
  });
}

async function submitApplication() {
  const val = (id) => $(id).value.trim();
  const errBox = $("su-err");
  errBox.textContent = "";
  const ag = {conduct: $("ag-conduct").checked, safety: $("ag-safety").checked,
              photo: $("ag-photo").checked, dues: $("ag-dues").checked};
  if (!val("f-first") || !val("f-last") || !val("f-pname"))
    return void (errBox.textContent = "Student first/last name and parent name are required.");
  if (!Object.values(ag).every(Boolean))
    return void (errBox.textContent = "All four agreements must be accepted.");
  const prefs = [...new Set([0, 1, 2].map((i) => $("pref" + i).value).filter(Boolean))];
  const chats = [...document.querySelectorAll("#f-chats input:checked")].map((c) => c.value);
  try {
    const m = await POST("/api/members", {
      first_name: val("f-first"), last_name: val("f-last"), school: val("f-school"),
      grade: val("f-grade"), experience: $("f-exp").value,
      student_email: val("f-semail"), student_phone: val("f-sphone"),
      parent_name: val("f-pname"), relationship: val("f-rel"),
      parent_email: val("f-pemail"), parent_phone: val("f-pphone"),
      parent_whatsapp: val("f-wa"), whatsapp_opt_in: $("f-waok").checked,
      em_name: val("f-emname"), em_phone: val("f-emphone"), medical: val("f-medical"),
      prefs, discovery_chats: chats, discovery_sessions: $("f-dsess").value,
      notes: val("f-notes"), agreements: ag,
    });
    toast(`Application ${m.code} submitted — pending mentor review.`);
    renderSignup();
    refreshBadges();
  } catch (e) { errBox.textContent = e.message; }
}

/* ---------------- mentor queue ---------------- */
const STATUS_PILL = {pending: "amber", approved: "green", waitlisted: "gray", declined: "red"};

async function renderQueue() {
  const v = $("view-queue");
  const members = await GET(`/api/members?status=${queueFilter}`);
  const counts = {};
  for (const s of ["pending", "approved", "waitlisted", "declined"])
    counts[s] = (await GET(`/api/members?status=${s}`)).length;
  v.innerHTML = `
  <div class="card"><h2>Mentor Queue</h2>
  <p class="sub">Review applications. Approving adds the student to the roster (and RSVPs).</p>
  <div class="row">
    ${["pending", "approved", "waitlisted", "declined"].map((s) =>
      `<button class="btn ${queueFilter === s ? "" : "ghost"} small"
        data-f="${s}">${s[0].toUpperCase() + s.slice(1)} (${counts[s]})</button>`).join("")}
    <span style="flex:1"></span>
    <button class="btn danger small" id="q-clear">Clear sample entries</button>
  </div></div>
  <div id="q-list">${members.map(queueCard).join("") || '<div class="card">Nothing here.</div>'}</div>
  <div class="card"><h3>Team accounts</h3>
    <p class="sub">Logins for mentors, parents and students \u2014 separate from sign-up applications. Only mentors/admins see this.</p>
    <div id="ac-list"><span class="sub">Loading\u2026</span></div>
    <div class="grid3" style="margin-top:12px">
      <div class="field"><label>Name</label><input id="ac-name"></div>
      <div class="field"><label>Email</label><input id="ac-email" type="email"></div>
      <div class="field"><label>Role</label><select id="ac-role">
        <option>student</option><option>parent</option><option>mentor</option><option>admin</option></select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Password <span class="hint">(8+ chars)</span></label><input id="ac-pass" type="password"></div>
      <div class="field"><label>&nbsp;</label><div class="row">
        <button class="btn small" id="ac-add">Create account</button>
        <button class="btn small ghost" id="ac-reset">Reset password</button>
      </div></div>
    </div>
    <p class="sub">Reset: put the account's email above, a new password, then hit Reset password.</p>
  </div>`;
  v.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => { queueFilter = b.dataset.f; renderQueue(); }));
  $("q-clear").addEventListener("click", async () => {
    if (!confirm("Delete all sample entries?")) return;
    const r = await DEL("/api/members/sample");
    toast(`Cleared ${r.cleared} sample entries.`);
    renderQueue(); refreshBadges();
  });
  v.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => queueAction(b)));
  renderAccounts();
}

async function renderAccounts() {
  const el = $("ac-list");
  if (!el) return;
  let users = [];
  try { users = await GET("/api/users"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load accounts.</span>'; return; }
  el.innerHTML = users.map((u) =>
    `<span class="pill ${(u.role === "mentor" || u.role === "admin") ? "amber" : "gray"}">${esc(u.name)} \u00b7 ${esc(u.role)}${u.has_password ? "" : " \u00b7 no login"}</span>`).join(" ")
    || '<span class="sub">No accounts yet.</span>';
  $("ac-add").onclick = async () => {
    try {
      await POST("/api/users", {name: $("ac-name").value.trim(),
        email: $("ac-email").value.trim(), role: $("ac-role").value,
        password: $("ac-pass").value});
      toast("Account created.");
      $("ac-name").value = $("ac-email").value = $("ac-pass").value = "";
      renderAccounts();
    } catch (e) { toast("Error: " + e.message); }
  };
  $("ac-reset").onclick = async () => {
    try {
      const email = $("ac-email").value.trim().toLowerCase();
      const u = users.find((x) => (x.email || "").toLowerCase() === email);
      if (!u) return toast("No account with that email.");
      if (!confirm("Reset password for " + u.name + " (" + u.email + ")?")) return;
      await POST("/api/users/" + u.id + "/password", {password: $("ac-pass").value});
      toast("Password reset for " + u.name + ".");
      $("ac-pass").value = "";
      renderAccounts();
    } catch (e) { toast("Error: " + e.message); }
  };
}

function queueCard(m) {
  const chats = (m.discovery_chats || []).map((c) =>
    `<span class="pill">${esc(c)}</span>`).join("");
  return `<div class="card">
    <div class="row"><b>${esc(m.first_name)} ${esc(m.last_name)}</b>
      <span class="pill ${STATUS_PILL[m.status]}">${m.status}</span>
      ${m.sample ? '<span class="pill gray">sample</span>' : ""}
      <span class="sub">${esc(m.code || "")} · submitted ${esc(m.submitted_at.slice(0, 10))}</span>
    </div>
    <div class="sub">${esc(m.school || "")} · Grade ${esc(m.grade || "")} · ${esc(m.experience || "")}
      ${m.assigned_subteam ? `· <b>${esc(m.assigned_subteam)}</b>` : ""}</div>
    ${chats ? `<div>Discovery chats: ${chats}</div>` : ""}
    ${m.parent_whatsapp ? `<div class="sub">Parent WhatsApp: ${esc(m.parent_whatsapp)}${m.whatsapp_opt_in ? " ✓ updates on" : ""}</div>` : ""}
    <details><summary>Full application</summary>
      <table>
      <tr><th>Student</th><td>${esc(m.student_email)} ${esc(m.student_phone)}</td></tr>
      <tr><th>Parent</th><td>${esc(m.parent_name)} (${esc(m.relationship)}) — ${esc(m.parent_email)} ${esc(m.parent_phone)}</td></tr>
      <tr><th>Emergency</th><td>${esc(m.em_name)} ${esc(m.em_phone)} ${esc(m.medical)}</td></tr>
      <tr><th>Ranked prefs</th><td>${esc((m.prefs || []).join(", "))}</td></tr>
      <tr><th>Discovery sessions</th><td>${esc(m.discovery_sessions || "")}</td></tr>
      <tr><th>Notes</th><td>${esc(m.notes)}</td></tr>
      </table>
    </details>
    <div class="row" style="margin-top:8px">
      <select id="sub-${m.id}">
        <option value="">Assign subteam…</option>
        ${SUBTEAMS.map((s) => `<option ${m.assigned_subteam === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
      </select>
      <button class="btn small ghost" data-act="subteam" data-id="${m.id}">Save</button>
      ${m.status === "pending" ? `
        <button class="btn small" data-act="approve" data-id="${m.id}">Approve</button>
        <button class="btn small ghost" data-act="waitlist" data-id="${m.id}">Waitlist</button>
        <button class="btn small danger" data-act="decline" data-id="${m.id}">Decline</button>` : `
        <button class="btn small ghost" data-act="reopen" data-id="${m.id}">Reopen</button>
        <button class="btn small ghost" data-act="welcome" data-id="${m.id}">Welcome message</button>`}
    </div>
    <div id="wel-${m.id}"></div>
  </div>`;
}

async function queueAction(b) {
  const id = b.dataset.id, act = b.dataset.act;
  try {
    if (act === "subteam") {
      await PATCH(`/api/members/${id}`, {assigned_subteam: $("sub-" + id).value});
      toast("Subteam saved.");
    } else if (act === "approve") {
      await PATCH(`/api/members/${id}`, {status: "approved"});
      toast("Approved — added to the roster.");
    } else if (act === "waitlist") {
      await PATCH(`/api/members/${id}`, {status: "waitlisted"});
      toast("Waitlisted.");
    } else if (act === "decline") {
      await PATCH(`/api/members/${id}`, {status: "declined"});
      toast("Declined.");
    } else if (act === "reopen") {
      await PATCH(`/api/members/${id}`, {status: "pending"});
      toast("Reopened.");
    } else if (act === "welcome") {
      const w = await GET(`/api/members/${id}/welcome`);
      $("wel-" + id).innerHTML =
        `<pre class="welcome">${esc(w.message)}</pre>
         <button class="btn small ghost" id="cp-${id}">Copy</button>`;
      $("cp-" + id).addEventListener("click", () => {
        navigator.clipboard.writeText(w.message).then(() => toast("Copied."));
      });
      return;
    }
    renderQueue(); refreshBadges();
  } catch (e) { toast("Error: " + e.message); }
}

/* ---------------- roster ---------------- */
async function renderRoster() {
  const v = $("view-roster");
  rosterCache = await GET("/api/roster");
  const subs = [...new Set(rosterCache.map((m) => m.assigned_subteam).filter(Boolean))];
  const rows = rosterCache.filter((m) => {
    const q = rosterSearch.toLowerCase();
    const hit = !q || `${m.first_name} ${m.last_name} ${m.school}`.toLowerCase().includes(q);
    return hit && (!rosterSubteam || m.assigned_subteam === rosterSubteam);
  });
  v.innerHTML = `
  <div class="card"><h2>Team Roster</h2>
  <p class="sub">${rosterCache.length} approved members</p>
  <div class="row">
    <input id="r-q" placeholder="Search…" value="${esc(rosterSearch)}" style="max-width:220px">
    <select id="r-sub"><option value="">All subteams</option>
      ${subs.map((s) => `<option ${rosterSubteam === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
    </select>
    <a class="btn ghost small" href="/api/roster.csv">Export CSV</a>
  </div></div>
  <div class="card"><table><tr><th>Code</th><th>Student</th><th>School</th><th>Subteam</th>
    <th>Parent</th><th>WhatsApp</th><th>Discovery</th></tr>
    ${rows.map((m) => `<tr><td>${esc(m.code)}</td>
      <td><b>${esc(m.first_name)} ${esc(m.last_name)}</b></td>
      <td>${esc(m.school)}</td><td>${esc(m.assigned_subteam || "—")}</td>
      <td>${esc(m.parent_name)}<br><span class="sub">${esc(m.parent_phone)}</span></td>
      <td>${esc(m.parent_whatsapp || "—")}${m.whatsapp_opt_in ? " ✓" : ""}</td>
      <td>${esc((m.discovery_chats || []).join(", "))}</td></tr>`).join("")}
  </table></div>`;
  $("r-q").addEventListener("input", (e) => { rosterSearch = e.target.value; renderRoster(); });
  $("r-sub").addEventListener("change", (e) => { rosterSubteam = e.target.value; renderRoster(); });
  const q = $("r-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
}

/* ---------------- events & RSVPs ---------------- */
function personOptions() {
  // approved members -> student + parent responder entries
  return rosterCache.flatMap((m) => [
    {member_id: m.id, kind: "student", name: `${m.first_name} ${m.last_name} (student)`},
    {member_id: m.id, kind: "parent", name: `${m.parent_name} (parent)`},
  ]);
}

async function loadPeople() {
  // Mentors get the full roster; everyone else the names-only directory.
  rosterCache = await GET(MENTOR() ? "/api/roster" : "/api/people");
}

async function renderEvents() {
  const v = $("view-events");
  await loadPeople();
  const events = await GET("/api/events");
  const list = events.filter((e) => {
    const q = eventSearch.toLowerCase();
    return (eventFilter === "all" || e.type === eventFilter) &&
      (!q || (e.title + e.location).toLowerCase().includes(q));
  });
  const cards = [];
  for (const e of list) cards.push(await eventCard(e));
  const types = ["meeting", "build", "competition", "outreach"];
  v.innerHTML = `
  <div class="card"><h2>Events &amp; RSVPs</h2>
  <p class="sub">Mentors create events. Students and parents RSVP; over-capacity events waitlist with auto-promote.</p>
  <h3 class="mo">Create event</h3>
  <div class="grid3 mo">
    <div class="field"><label>Title *</label><input id="e-title"></div>
    <div class="field"><label>Type</label><select id="e-type">
      ${types.map((t) => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></div>
    <div class="field"><label>Date</label><input id="e-date" type="date"></div>
    <div class="field"><label>Time</label><input id="e-time" placeholder="6:00 PM"></div>
    <div class="field"><label>Location</label><input id="e-loc"></div>
    <div class="field"><label>Capacity <span class="hint">(blank = unlimited)</span></label>
      <input id="e-cap" inputmode="numeric"></div>
    <div class="field"><label>RSVP deadline</label><input id="e-dead" type="date"></div>
  </div>
  <div class="field mo"><label>Notes</label><textarea id="e-notes"></textarea></div>
  <div class="row mo"><button class="btn" id="e-create">Create event</button>
    <button class="btn ghost" id="e-fill" type="button">Fill with an example event</button></div>
  </div>
  <div class="card"><div class="row">
    ${["all", ...types].map((t) =>
      `<button class="btn ${eventFilter === t ? "" : "ghost"} small" data-et="${t}">${t}</button>`).join("")}
    <input id="e-q" placeholder="Search…" value="${esc(eventSearch)}" style="max-width:200px">
  </div></div>
  <div id="ev-list">${cards.join("")}</div>`;
  v.querySelectorAll("[data-et]").forEach((b) =>
    b.addEventListener("click", () => { eventFilter = b.dataset.et; renderEvents(); }));
  $("e-q").addEventListener("input", (e) => { eventSearch = e.target.value; renderEvents(); });
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  const _ec = $("e-create"); if (_ec) _ec.addEventListener("click", createEvent);
  const _ef = $("e-fill"); if (_ef) _ef.addEventListener("click", () => {
    $("e-title").value = "Build Session — Intake Prototype"; $("e-type").value = "build";
    $("e-date").value = "2026-11-02"; $("e-time").value = "10:00 AM";
    $("e-loc").value = "School robotics lab, Room 12"; $("e-cap").value = "12";
  });
  v.querySelectorAll("[data-rsvp]").forEach((b) =>
    b.addEventListener("click", () => rsvpAction(b)));
  v.querySelectorAll("[data-unrsvp]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = await DEL(`/api/rsvps/${b.dataset.unrsvp}`);
      toast(r.promoted ? `Released — ${esc(r.promoted.person_name)} promoted from waitlist.` : "RSVP removed.");
      renderEvents();
    }));
  v.querySelectorAll("[data-delev]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this event and its RSVPs?")) return;
      await DEL(`/api/events/${b.dataset.delev}`);
      toast("Event deleted."); renderEvents();
    }));
}

async function createEvent() {
  const val = (id) => $(id).value.trim();
  if (!val("e-title")) return toast("Title is required.");
  try {
    await POST("/api/events", {title: val("e-title"), type: $("e-type").value,
      date: val("e-date"), time: val("e-time"), location: val("e-loc"),
      capacity: val("e-cap") ? parseInt(val("e-cap"), 10) : null,
      deadline: val("e-dead"), notes: val("e-notes")});
    toast("Event created."); renderEvents();
  } catch (e) { toast("Error: " + e.message); }
}

async function eventCard(e) {
  const d = await GET(`/api/events/${e.id}/rsvps`);
  const hc = d.headcounts;
  const closed = e.deadline && e.deadline < new Date().toISOString().slice(0, 10);
  const opts = personOptions().map((p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`).join("");
  const row = (r) => `<div class="row" style="margin:4px 0">
      <span class="pill ${r.status === "going" ? "green" : r.status === "waitlisted" ? "amber" : "gray"}">${r.status}</span>
      <span>${esc(r.person_name)} <span class="sub">(${r.person_kind})</span></span>
      <button class="btn small ghost" data-unrsvp="${r.id}">Remove</button></div>`;
  return `<div class="card">
    <div class="row"><b>${esc(e.title)}</b>
      <span class="pill">${esc(e.type)}</span>
      ${closed ? '<span class="pill red">RSVP closed</span>' : ""}
      <span style="flex:1"></span>
      <button class="btn small danger" data-delev="${e.id}">Delete</button></div>
    <div class="sub">${esc(e.date || "")} ${esc(e.time || "")} · ${esc(e.location || "")}
      ${e.capacity ? `· ${hc.going}/${e.capacity} going` : `· ${hc.going} going`}
      · ${hc.waitlisted} waitlisted · ${hc.cant} can't make it</div>
    ${e.notes ? `<div class="sub">${esc(e.notes)}</div>` : ""}
    ${closed ? "" : `<div class="row">
      <select id="rp-${e.id}">${opts}</select>
      <button class="btn small" data-rsvp="${e.id}" data-want="going">RSVP Going</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="cant">Can't make it</button>
    </div>`}
    <div style="margin-top:6px">${d.rsvps.map(row).join("") || '<span class="sub">No RSVPs yet.</span>'}</div>
  </div>`;
}

async function rsvpAction(b) {
  const sel = b.closest(".row").querySelector("select");
  const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
  try {
    const r = await POST(`/api/events/${b.dataset.rsvp}/rsvps`, {
      member_id: p.member_id, person_kind: p.kind, person_name: p.name.replace(/ \((student|parent)\)$/, ""),
      status: b.dataset.want,
    });
    toast(r.status === "waitlisted" ? "Event is full — added to the waitlist." : "RSVP saved.");
    renderEvents();
  } catch (e) { toast("Error: " + e.message); }
}

/* ---------------- tracking ---------------- */
async function renderTracking() {
  const v = $("view-tracking");
  await loadPeople();
  const events = await GET("/api/events");
  if (!trackEventId && events.length) trackEventId = events[0].id;
  const ev = events.find((e) => e.id === trackEventId);
  const att = ev ? await GET(`/api/events/${ev.id}/rsvps`) : {rsvps: []};
  const checked = ev ? await GET(`/api/events/${ev.id}/checkins`) : [];
  const byPerson = {};
  checked.forEach((c) => { byPerson[`${c.member_id}:${c.person_kind}`] = c; });
  const hours = await GET("/api/hours");
  const tasks = await GET("/api/tasks");
  const cols = [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]];
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const subProg = {};
  tasks.forEach((t) => {
    const s = t.subteam || "Unassigned";
    subProg[s] = subProg[s] || {done: 0, total: 0};
    subProg[s].total += 1;
    if (t.status === "done") subProg[s].done += 1;
  });
  const totV = hours.reduce((a, h) => a + (h.verified_hours || 0), 0);
  const totU = hours.reduce((a, h) => a + (h.unverified_hours || 0), 0);
  v.innerHTML = `
  <div class="card"><h2>Tracking</h2>
  <p class="sub">Check in from the RSVP list. Self check-ins stay unverified until a mentor confirms.</p>
  <div class="statgrid">
    <div class="stat"><div class="n">${totV}</div><div class="l">verified hours</div></div>
    <div class="stat"><div class="n">${totU}</div><div class="l">hours awaiting verify</div></div>
    <div class="stat"><div class="n">${checked.length}</div><div class="l">check-ins</div></div>
    <div class="stat"><div class="n">${doneCount}/${tasks.length}</div><div class="l">tasks done</div></div>
  </div></div>
  <div class="card"><h3>Attendance</h3>
  <div class="row"><select id="t-ev">
    ${events.map((e) => `<option value="${e.id}" ${e.id === trackEventId ? "selected" : ""}>${esc(e.title)} (${esc(e.date || "")})</option>`).join("")}
  </select>
  <span class="sub">Session hours:</span>
  <input id="t-hrs" type="number" min="0" step="0.5" value="${ev ? ev.session_hours : 2}" style="width:80px"></div>
  <div id="t-att" style="margin-top:8px">
  ${att.rsvps.filter((r) => r.status === "going").map((r) => {
    const c = byPerson[`${r.member_id}:${r.person_kind}`];
    const st = c ? (c.verified ? `<span class="pill green">verified · ${c.hours}h</span>`
                               : `<span class="pill amber">self check-in · unverified · ${c.hours}h</span>`)
                 : '<span class="pill gray">not checked in</span>';
    return `<div class="row" style="margin:6px 0"><span><b>${esc(r.person_name)}</b>
      <span class="sub">(${r.person_kind})</span></span> ${st}<span style="flex:1"></span>
      ${r.person_kind === "student" && !c ? `<button class="btn small ghost" data-ci="self" data-m="${r.member_id}" data-n="${esc(r.person_name)}">Self check-in</button>` : ""}
      ${!c && MENTOR() ? `<button class="btn small" data-ci="mentor" data-m="${r.member_id}" data-k="${r.person_kind}" data-n="${esc(r.person_name)}">Mentor check-in</button>` : ""}
      ${c && !c.verified && MENTOR() ? `<button class="btn small" data-verify="${c.id}">Verify</button>` : ""}
    </div>`;
  }).join("") || '<span class="sub">No "going" RSVPs for this event yet.</span>'}
  </div></div>
  <div class="card"><h3>Hours by student</h3>
  ${hours.map((h) => `<details><summary>${esc(h.first_name)} ${esc(h.last_name)} —
    <b>${h.verified_hours}h</b> verified${h.unverified_hours ? `, <span class="pill amber">${h.unverified_hours}h unverified</span>` : ""}</summary>
    <table><tr><th>Event</th><th>Date</th><th>Hours</th><th>Status</th></tr>
    ${h.breakdown.map((b) => `<tr><td>${esc(b.title)}</td><td>${esc(b.date || "")}</td>
      <td>${b.hours}</td><td>${b.verified ? "verified" : "unverified (" + esc(b.method) + ")"}</td></tr>`).join("")}
    </table></details>`).join("") || '<span class="sub">No hours logged yet.</span>'}
  </div>
  <div class="card"><h3>Task board</h3>
    <div class="row mo">
      <input id="tk-title" placeholder="Task title *" style="flex:2;min-width:180px">
      <select id="tk-sub"><option value="">Subteam…</option>
        ${SUBTEAMS.map((s) => `<option>${esc(s.name)}</option>`).join("")}</select>
      <input id="tk-who" placeholder="Assignee" style="max-width:150px">
      <input id="tk-due" type="date" style="max-width:150px">
      <button class="btn small" id="tk-add">Add task</button>
    </div>
    <div class="cols3" style="margin-top:10px">
    ${cols.map(([k, label]) => `<div class="col"><h4>${label}</h4>
      ${tasks.filter((t) => t.status === k).map((t) => `
        <div class="task"><div class="t">${esc(t.title)}</div>
        <div class="m">${esc(t.subteam || "")} ${esc(t.assignee || "")} ${esc(t.due_date || "")}</div>
        ${t.notes ? `<div class="m">${esc(t.notes)}</div>` : ""}
        <div class="row" style="margin-top:4px">
          ${k !== "todo" ? `<button class="btn small ghost" data-tmove="${t.id}" data-to="${k === "doing" ? "todo" : "doing"}">←</button>` : ""}
          ${k !== "done" ? `<button class="btn small ghost" data-tmove="${t.id}" data-to="${k === "todo" ? "doing" : "done"}">→</button>` : ""}
          <button class="btn small danger" data-tdel="${t.id}">✕</button>
        </div></div>`).join("")}
    </div>`).join("")}
    </div>
    <h3>Task completion by subteam</h3>
    ${Object.entries(subProg).map(([s, p]) => `
      <div>${esc(s)} — ${p.done}/${p.total}
      <div class="bar"><div style="width:${p.total ? Math.round(100 * p.done / p.total) : 0}%"></div></div></div>`).join("")}
  </div>`;
  $("t-ev").addEventListener("change", (e) => { trackEventId = parseInt(e.target.value, 10); renderTracking(); });
  v.querySelectorAll("[data-ci]").forEach((b) => b.addEventListener("click", async () => {
    const hours = parseFloat($("t-hrs").value) || 0;
    await POST("/api/checkins", {event_id: trackEventId, member_id: parseInt(b.dataset.m, 10),
      person_kind: b.dataset.k || "student", person_name: b.dataset.n,
      method: b.dataset.ci, hours});
    toast(b.dataset.ci === "self" ? "Self check-in recorded (unverified)." : "Checked in.");
    renderTracking();
  }));
  v.querySelectorAll("[data-verify]").forEach((b) => b.addEventListener("click", async () => {
    await PATCH(`/api/checkins/${b.dataset.verify}`, {verified: true});
    toast("Verified."); renderTracking();
  }));
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  const _tk = $("tk-add"); if (_tk) _tk.addEventListener("click", async () => {
    const t = $("tk-title").value.trim();
    if (!t) return toast("Task title is required.");
    await POST("/api/tasks", {title: t, subteam: $("tk-sub").value,
      assignee: $("tk-who").value.trim(), due_date: $("tk-due").value});
    toast("Task added."); renderTracking();
  });
  v.querySelectorAll("[data-tmove]").forEach((b) => b.addEventListener("click", async () => {
    await PATCH(`/api/tasks/${b.dataset.tmove}`, {status: b.dataset.to});
    renderTracking();
  }));
  v.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this task?")) return;
    await DEL(`/api/tasks/${b.dataset.tdel}`);
    renderTracking();
  }));
}

/* ---------------- travel & logistics ---------------- */
async function renderTravel() {
  const v = $("view-travel");
  await loadPeople();
  const events = await GET("/api/events");
  if (!travelEventId && events.length) travelEventId = events[0].id;
  if (!events.length) {
    $("view-travel").innerHTML =
      '<div class="card"><h2>Travel &amp; Logistics</h2><p class="sub">Create an event first.</p></div>';
    return;
  }
  const t = await GET(`/api/events/${travelEventId}/travel`);
  const ev = t.event;
  const people = personOptions();
  const popts = people.map((p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`).join("");
  const poptParents = people.filter((p) => p.kind === "parent").map((p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`).join("");
  const students = rosterCache.map((m) =>
    `<option value="${m.id}">${esc(m.first_name)} ${esc(m.last_name)}</option>`).join("");
  v.innerHTML = `
  <div class="card"><h2>Travel &amp; Logistics</h2>
  <p class="sub">Carpools, tool sign-up, and hotel assignments — organized per event.</p>
  <div class="row"><select id="tr-ev">
    ${events.map((e) => `<option value="${e.id}" ${e.id === travelEventId ? "selected" : ""}>${esc(e.title)}</option>`).join("")}
  </select></div></div>

  <div class="card"><h3>Carpools</h3>
  <div class="grid3">
    <div class="field"><label>Driver name *</label><input id="cp-driver"></div>
    <div class="field"><label>Seats *</label><input id="cp-seats" inputmode="numeric" placeholder="4"></div>
    <div class="field"><label>Departure point</label><input id="cp-from" placeholder="School lot"></div>
    <div class="field"><label>Departure time</label><input id="cp-dt" placeholder="Thu 3:30 PM"></div>
    <div class="field"><label>Return plan</label><input id="cp-ret" placeholder="Sun after finals"></div>
    <div class="field"><label>Notes</label><input id="cp-notes"></div>
  </div>
  <button class="btn small" id="cp-add">Post ride</button>
  <div id="cp-list" style="margin-top:10px">
  ${t.carpools.map((c) => `
    <div class="card"><div class="row"><b>${esc(c.driver_name)}</b>
      <span class="pill ${c.seats_open ? "green" : "red"}">${c.seats_open} of ${c.seats} seats open</span></div>
    <div class="sub">${esc(c.depart_from || "")} · ${esc(c.depart_time || "")} · Return: ${esc(c.return_info || "—")}</div>
    <div>Riders: ${c.claims.map((x) =>
      `<span class="pill">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="release">✕</a></span>`).join("") || '<span class="sub">none yet</span>'}</div>
    ${c.waitlist.length ? `<div>Waitlist: ${c.waitlist.map((x) =>
      `<span class="pill amber">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="remove">✕</a></span>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:6px"><select id="cps-${c.id}">${popts}</select>
      <button class="btn small" data-claim="${c.id}">Claim seat</button></div>
    </div>`).join("") || '<p class="sub">No carpools posted for this event yet.</p>'}
  </div></div>

  <div class="card"><h3>Tool sign-up</h3>
  <p class="sub">Mentors list what the event needs; anyone claims what they'll bring.</p>
  <div class="row mo">
    <input id="tl-name" placeholder="Tool or gear needed *" style="flex:2;min-width:160px">
    <input id="tl-qty" placeholder="Qty" inputmode="numeric" style="max-width:70px">
    <input id="tl-notes" placeholder="Notes" style="flex:1;min-width:120px">
    <button class="btn small" id="tl-add">Add</button>
  </div>
  <div style="margin-top:8px">
  ${t.tools.map((x) => `<div class="row" style="margin:6px 0">
    <span><b>${esc(x.name)}</b> <span class="sub">×${x.qty}</span></span>
    ${x.claimed_by ? `<span class="pill green">covered by ${esc(x.claimed_by)}</span>
      <button class="btn small ghost" data-tunclaim="${x.id}">Unclaim</button>`
    : `<select id="tls-${x.id}">${popts}</select>
      <button class="btn small" data-tclaim="${x.id}">Claim</button>`}
  </div>`).join("") || '<p class="sub">Nothing listed yet.</p>'}
  </div></div>

  <div class="card"><h3>Hotel assignments</h3>
  ${t.hotel ? hotelHTML(t.hotel, students, poptParents) : `
    <p class="sub">No hotel block for this event. Add one for remote tournaments:</p>
    <div class="grid3 mo">
      <div class="field"><label>Hotel name *</label><input id="h-name"></div>
      <div class="field"><label>Address</label><input id="h-addr"></div>
      <div class="field"><label>Check-in</label><input id="h-in" type="date"></div>
      <div class="field"><label>Check-out</label><input id="h-out" type="date"></div>
    </div>
    <div class="field mo"><label>Notes <span class="hint">(room block details)</span></label>
      <textarea id="h-notes"></textarea></div>
    <button class="btn small mo" id="h-add">Save hotel block</button>`}
  </div>`;
  $("tr-ev").addEventListener("change", (e) => { travelEventId = parseInt(e.target.value, 10); renderTravel(); });
  const hb = $("h-add");
  if (hb) hb.addEventListener("click", async () => {
    if (!$("h-name").value.trim()) return toast("Hotel name is required.");
    await POST("/api/hotels", {event_id: travelEventId, name: $("h-name").value.trim(),
      address: $("h-addr").value.trim(), check_in: $("h-in").value,
      check_out: $("h-out").value, notes: $("h-notes").value.trim()});
    toast("Hotel block saved."); renderTravel();
  });
  $("cp-add").addEventListener("click", async () => {
    if (!$("cp-driver").value.trim() || !$("cp-seats").value.trim())
      return toast("Driver name and seats are required.");
    await POST("/api/carpools", {event_id: travelEventId,
      driver_name: $("cp-driver").value.trim(), seats: parseInt($("cp-seats").value, 10),
      depart_from: $("cp-from").value.trim(), depart_time: $("cp-dt").value.trim(),
      return_info: $("cp-ret").value.trim(), notes: $("cp-notes").value.trim()});
    toast("Ride posted."); renderTravel();
  });
  v.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const p = JSON.parse($("cps-" + b.dataset.claim).value.replace(/&#39;/g, "'"));
    const r = await POST(`/api/carpools/${b.dataset.claim}/claims`, {
      member_id: p.member_id, person_kind: p.kind,
      person_name: p.name.replace(/ \((student|parent)\)$/, "")});
    toast(r.status === "waitlisted" ? "Car is full — added to the waitlist." : "Seat claimed.");
    renderTravel();
  }));
  v.querySelectorAll("[data-unclaim]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await DEL(`/api/carpool_claims/${a.dataset.unclaim}`);
    toast(r.promoted ? `${r.promoted.person_name} promoted from the waitlist.` : "Released.");
    renderTravel();
  }));
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  const _tl = $("tl-add"); if (_tl) _tl.addEventListener("click", async () => {
    if (!$("tl-name").value.trim()) return toast("Tool name is required.");
    await POST("/api/tools", {event_id: travelEventId, name: $("tl-name").value.trim(),
      qty: parseInt($("tl-qty").value, 10) || 1, notes: $("tl-notes").value.trim()});
    toast("Tool added."); renderTravel();
  });
  v.querySelectorAll("[data-tclaim]").forEach((b) => b.addEventListener("click", async () => {
    const p = JSON.parse($("tls-" + b.dataset.tclaim).value.replace(/&#39;/g, "'"));
    await POST(`/api/tools/${b.dataset.tclaim}/claim`,
      {claimed_by: p.name.replace(/ \((student|parent)\)$/, "")});
    toast("Claimed."); renderTravel();
  }));
  v.querySelectorAll("[data-tunclaim]").forEach((b) => b.addEventListener("click", async () => {
    await POST(`/api/tools/${b.dataset.tunclaim}/unclaim`);
    toast("Unclaimed."); renderTravel();
  }));
  v.querySelectorAll("[data-rvol]").forEach((b) => b.addEventListener("click", async () => {
    const sel = $("rp-" + b.dataset.rvol);
    if (!sel.value) return toast("Pick which parent is volunteering.");
    const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
    await POST(`/api/rooms/${b.dataset.rvol}/parent`,
      {member_id: p.member_id,
       person_name: p.name.replace(/ \((student|parent)\)$/, "")});
    toast("Room parent set — thank you for volunteering!");
    renderTravel();
  }));
  v.querySelectorAll("[data-rparentx]").forEach((b) => b.addEventListener("click", async () => {
    await DEL(`/api/rooms/${b.dataset.rparentx}/parent`);
    toast("Room parent removed.");
    renderTravel();
  }));
  const ra = $("rm-add");
  if (ra) ra.addEventListener("click", async () => {
    if (!$("rm-label").value.trim()) return toast("Room label is required.");
    await POST(`/api/hotels/${t.hotel.id}/rooms`, {label: $("rm-label").value.trim(),
      capacity: parseInt($("rm-cap").value, 10) || 4});
    toast("Room added."); renderTravel();
  });
  v.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", async () => {
    const mid = parseInt($("plc-" + b.dataset.place).value, 10);
    if (!mid) return toast("Pick a student to place.");
    try {
      await POST(`/api/rooms/${b.dataset.place}/occupants`, {member_id: mid});
      toast("Placed."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-unplace]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    await DEL(`/api/room_occupants/${a.dataset.unplace}`);
    toast("Removed from room."); renderTravel();
  }));
  const rq = $("rq-add");
  if (rq) rq.addEventListener("click", async () => {
    const mid = parseInt($("rq-who").value, 10);
    if (!mid) return toast("Pick a student.");
    await POST(`/api/hotels/${t.hotel.id}/requests`, {member_id: mid,
      preferred_roommates: $("rq-mates").value.split(",").map((s) => s.trim()).filter(Boolean),
      notes: $("rq-notes").value.trim()});
    toast("Rooming request saved."); renderTravel();
  });
}

function hotelHTML(h, students, poptParents) {
  const missing = h.rooms.filter((r) => !r.parent_name).length;
  return `
  <div class="sub"><b>${esc(h.name)}</b> · ${esc(h.address || "")} ·
    ${esc(h.check_in || "")} → ${esc(h.check_out || "")}</div>
  ${h.notes ? `<div class="sub">${esc(h.notes)}</div>` : ""}
  <h3>Rooms ${missing ? `<span class="pill amber">${missing} need${missing > 1 ? "" : "s"} a room parent</span>` : ""}</h3>
  <p class="sub">The block is already booked. Every room needs an adult <b>room parent</b> to check in — students are under 18. Parents: volunteer for a room below.</p>
  <div class="row mo"><input id="rm-label" placeholder="Room label *" style="max-width:200px">
    <input id="rm-cap" placeholder="Beds" inputmode="numeric" style="max-width:80px">
    <button class="btn small" id="rm-add">Add room</button></div>
  ${h.rooms.map((r) => {
    const occ = r.occupants.map((o) =>
      `<span class="pill">${esc(o.first_name)} ${esc(o.last_name)}${MENTOR() ? ` <a href="#" data-unplace="${o.id}" title="remove">\u2715</a>` : ""}</span>`).join("");
    return `<div class="card"><div class="row"><b>${esc(r.label)}</b>
      <span class="pill ${r.occupants.length >= r.capacity ? "red" : "green"}">
      ${r.occupants.length}/${r.capacity} beds</span></div>
      <div>${occ || '<span class="sub">empty</span>'}</div>
      <div class="row" style="margin-top:6px">
        ${r.parent_name
          ? `<span class="pill green">Room parent: ${esc(r.parent_name)}</span>
             <button class="btn small ghost" data-rparentx="${r.id}">Remove</button>`
          : `<span class="pill amber">Needs a room parent</span>`}
      </div>
      ${!r.parent_name ? `<div class="row" style="margin-top:6px">
        <select id="rp-${r.id}"><option value="">Volunteer as room parent…</option>${poptParents}</select>
        <button class="btn small" data-rvol="${r.id}">Volunteer</button></div>` : ""}
      <div class="row mo" style="margin-top:6px"><select id="plc-${r.id}">
        <option value="">Place a student…</option>${students}</select>
        <button class="btn small" data-place="${r.id}">Place</button></div></div>`;
  }).join("")}
  <h3>Rooming requests ${h.awaiting ? `<span class="pill amber">${h.awaiting} awaiting placement</span>` : ""}</h3>
  <div class="row"><select id="rq-who"><option value="">Student…</option>${students}</select>
    <input id="rq-mates" placeholder="Preferred roommates, comma-separated" style="flex:1;min-width:160px">
    <input id="rq-notes" placeholder="Notes" style="flex:1;min-width:120px">
    <button class="btn small" id="rq-add">Save request</button></div>
  <div style="margin-top:8px">
  ${h.requests.map((q) => `<div class="row" style="margin:4px 0">
    <span class="pill ${q.status === "placed" ? "green" : "amber"}">${q.status}</span>
    <b>${esc(q.first_name)} ${esc(q.last_name)}</b>
    <span class="sub">wants: ${esc((q.preferred_roommates || []).join(", ")) || "—"}</span>
    <span class="sub">${esc(q.notes || "")}</span></div>`).join("") || '<span class="sub">No requests yet.</span>'}
  </div>`;
}

/* ---------------- boot ---------------- */
(async function init() {
  try {
    SUBTEAMS = await GET("/api/subteams");
  } catch (e) {
    document.body.innerHTML = "<p style='padding:20px'>Could not reach the API at " +
      esc(location.origin) + ". Is the Flask server running?</p>";
    return;
  }
  let me = {user: null, setup_required: false};
  try { me = await GET("/api/auth/me"); } catch (e) { /* auth unreachable */ }
  ME = me.user;
  SETUP = !!me.setup_required;
  $("logout-btn").addEventListener("click", doLogout);
  const themeBtn = $("theme-btn");
  const applyTheme = (t) => {
    document.documentElement.setAttribute("data-theme", t);
    themeBtn.textContent = t === "light" ? "🌙 Dark" : "☀ Light";
    try { localStorage.setItem("frc-theme", t); } catch (e) { /* private mode */ }
  };
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur === "light" ? "dark" : "light");
  });
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
  applyNav();
  if (ME) {
    showView("events");
    refreshBadges();
  } else {
    showView("login");
  }
})();
