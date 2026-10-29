/* Team 9470 Ctrl-Alt-Defeat FRC Team Portal — vanilla JS frontend talking to the Flask REST API. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const normName = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");

// Tap-to-toggle chip groups: the phone-friendly replacement for
// <select multiple>. Ctrl/Cmd-click doesn't exist on touch screens, and
// parents mostly use phones — so multi-picks are buttons that toggle
// their .active state, in the same bubble style as the event selectors.
function chipButton(value, label) {
  return `<button type="button" class="bubble" data-val="${esc(value)}" aria-pressed="false">${esc(label)}</button>`;
}
function bindChipButtons(container) {
  container.querySelectorAll(".bubble").forEach((b) => {
    if (b._chipBound) return;
    b._chipBound = true;
    b.addEventListener("click", () => {
      b.classList.toggle("active");
      b.setAttribute("aria-pressed", b.classList.contains("active"));
    });
  });
}
function bindChips(view) {
  view.querySelectorAll(".chipgroup").forEach(bindChipButtons);
}
function chipValues(id) {
  const el = $(id);
  if (!el) return [];
  return [...el.querySelectorAll(".bubble.active")].map((b) => b.dataset.val);
}

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
let eventCalMode = false, eventCalCursor = "";
let openRsvpLists = new Set();  // event ids whose RSVP list is expanded
let toolsListCollapsed = false;  // Tool sign-up list in Travel, across renders
let trackEventId = null, travelEventId = null;
let trackDay = null;  // selected Tracking trip day (YYYY-MM-DD)
let openTravelDays = new Set(), openTravelDaysEvent = null;  // Travel day sections left open
let currentView = "events";

/* Multi-day trips: an event's days are [date .. end_date] inclusive,
   or [date] for a single-day event, or [] when dateless. Day math is
   done on calendar dates (no timezone shifts): a YYYY-MM-DD string
   is parsed as local year/month/day. */
function eventDays(e) {
  if (!e || !e.date) return [];
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const d0 = parse(e.date);
  if (isNaN(d0)) return [];
  let d1 = d0;
  if (e.end_date) { const p = parse(e.end_date); if (!isNaN(p) && p >= d0) d1 = p; }
  const days = [];
  for (let dt = new Date(d0); dt <= d1 && days.length <= 31; dt.setDate(dt.getDate() + 1)) days.push(fmt(dt));
  return days;
}
const dayLabel = (ds) => {
  if (!ds) return "";
  const [y, m, d] = ds.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(y, m - 1, d).getDay()];
  return `${wd} ${m}/${d}`;
};
const eventDateLabel = (e) => {
  const days = eventDays(e);
  if (!days.length) return "";
  if (days.length === 1) return days[0];
  return `${days[0]} – ${days[days.length - 1]}`;
};
/* Sticky session: remember the tab + event so a reload returns the user to
   exactly where they were working. Cleared on logout. */
const savePlace = () => {
  if (!ME) return;
  try { localStorage.setItem("frc-place", JSON.stringify(
    {view: currentView, track: trackEventId, travel: travelEventId})); } catch (e) {}
};
const readPlace = () => {
  try { return JSON.parse(localStorage.getItem("frc-place") || "null"); } catch (e) { return null; }
};
let pendingBeds = [];  // bed builder state for the room being composed
let ME = null;          // logged-in user ({id,name,email,role}) or null
let ME_AVATAR = null;   // logged-in user's photo data URL, or null for initials
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
  $("menu-btn").classList.toggle("navhide", !ME);
  closeMenu();
  renderHeaderAvatar();
}

/* ---------------- avatars ---------------- */
// Photo when the account has one, name initials on a deterministic
// pastel otherwise (same initials/colors as the assignee chips).
function avatarHTML(name, cls) {
  if (ME_AVATAR) return `<span class="avatar ${cls}"><img src="${ME_AVATAR}" alt=""></span>`;
  return `<span class="avatar ${cls}" style="background:${chipColor(name)};color:#222">${esc(initials(name))}</span>`;
}
function renderHeaderAvatar() {
  const el = $("user-avatar");
  if (!el) return;
  el.innerHTML = ME ? avatarHTML(ME.name, "avatar-sm") : "";
  el.style.display = ME ? "" : "none";
  // The name pill is gone; the name + role survive as a hover tooltip.
  if (ME) el.title = ME.name + " \u00b7 " + ME.role;
}
async function loadAvatar() {
  ME_AVATAR = null;
  if (!ME) return;
  try { ME_AVATAR = (await GET("/api/auth/avatar")).avatar || null; }
  catch (e) { /* no photo yet — initials */ }
  renderHeaderAvatar();
}
// Resize to at most 256px on the device before upload, so the stored
// data URL stays tens of KB instead of a multi-MB camera photo.
function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- navigation ---------------- */
function closeMenu() {
  $("nav").classList.remove("open");
  $("menu-btn").setAttribute("aria-expanded", "false");
}

/* Avatar overlay: the account's quick surface. General (name, contact,
   and — for a student — school and grade), Security (2FA status,
   password change, and a way into the full Security tab), and Logout
   with a YES/NO confirm instead of an instant exit. The header avatar
   is the only entry point; the full Profile view stays one tap away
   inside it. */
function closeAvatarMenu() {
  const am = $("avatar-menu");
  if (am) am.classList.add("hidden");
}
function toggleAvatarMenu() {
  const am = $("avatar-menu");
  if (!am) { showView("profile"); return; }  // old saved page: fall back
  if (!ME) return;
  if (!am.classList.contains("hidden")) { closeAvatarMenu(); return; }
  closeMenu();
  renderAvatarMenu();
  am.classList.remove("hidden");
}
/* Avatar menu: just links. General and Security navigate to their
   pages; Log Out collapses this menu and opens a separate confirm
   popup instead of exiting on the spot. */
function renderAvatarMenu() {
  const am = $("avatar-menu");
  if (!am || !ME) return;
  am.innerHTML = `
  <button class="menu-link" id="am-general">General</button>
  <button class="menu-link" id="am-security">Security</button>
  <button class="menu-link" id="am-logout">Log Out</button>`;
  $("am-general").addEventListener("click", () => showView("profile"));
  $("am-security").addEventListener("click", () => showView("security"));
  $("am-logout").addEventListener("click", () => { closeAvatarMenu(); openLogoutModal(); });
}
function openLogoutModal() {
  const m = $("logout-modal");
  if (m) m.classList.add("open");
}
function closeLogoutModal() {
  const m = $("logout-modal");
  if (m) m.classList.remove("open");
}
function openQrModal() {
  const m = $("qr-modal");
  if (m) m.classList.add("open");
}
function closeQrModal() {
  const m = $("qr-modal");
  if (m) m.classList.remove("open");
}
/* Team-account resets: per-row modals (password form, 2FA confirm). */
let pwUid = null, pwName = "", faUid = null, faName = "", delUid = null, delName = "";
function openPwModal(uid, name) {
  pwUid = uid; pwName = name;
  $("pw-title").textContent = `Reset password for ${name}`;
  $("pw-new").value = ""; $("pw-new2").value = ""; $("pw-err").textContent = "";
  $("pw-modal").classList.add("open");
}
function closePwModal() {
  $("pw-modal").classList.remove("open");
}
function open2faModal(uid, name) {
  faUid = uid; faName = name;
  $("2fa-title").textContent = `Reset 2FA for ${name}?`;
  $("2fa-modal").classList.add("open");
}
function close2faModal() {
  $("2fa-modal").classList.remove("open");
}
/* Deletion requests: per-row confirm modal (the request goes to the
   mentor queue; only an approval there deletes the account). */
function openDelModal(uid, name) {
  delUid = uid; delName = name;
  $("del-title").textContent = `Request deletion of ${name}?`;
  $("del-modal").classList.add("open");
}
function closeDelModal() {
  $("del-modal").classList.remove("open");
}
/* A scanned #checkin-<id> link jumps to Tracking with that event
   selected (used at boot and after login, so a logged-out scan still
   lands right). Consumes the hash so later reloads use sticky place. */
function goCheckinQR() {
  const qr = location.hash.match(/^#checkin-(\d+)$/);
  if (!qr) return false;
  trackEventId = parseInt(qr[1], 10);
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  showView("tracking");
  return true;
}
document.querySelectorAll("#nav button").forEach((b) => {
  b.addEventListener("click", () => { showView(b.dataset.view); closeMenu(); });
});
const _ua = $("user-avatar");
if (_ua) _ua.addEventListener("click", (e) => { e.stopPropagation(); toggleAvatarMenu(); });
$("menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeAvatarMenu();
  const open = $("nav").classList.toggle("open");
  $("menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => {
  if ($("nav").classList.contains("open") &&
      !e.target.closest("#nav") && !e.target.closest("#menu-btn")) closeMenu();
  const am = $("avatar-menu");
  if (am && !am.classList.contains("hidden") &&
      !e.target.closest("#avatar-menu") && !e.target.closest("#user-avatar")) closeAvatarMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeAvatarMenu(); closeLogoutModal(); closeQrModal(); closePwModal(); close2faModal(); closeDelModal(); } });
const _loYes = $("lo-yes");
if (_loYes) _loYes.addEventListener("click", () => doLogout());
const _loNo = $("lo-no");
if (_loNo) _loNo.addEventListener("click", closeLogoutModal);
const _loModal = $("logout-modal");
if (_loModal) _loModal.addEventListener("click", (e) => { if (e.target === _loModal) closeLogoutModal(); });
const _qrModal = $("qr-modal");
if (_qrModal) _qrModal.addEventListener("click", (e) => { if (e.target === _qrModal) closeQrModal(); });
const _qrClose = $("qr-close");
if (_qrClose) _qrClose.addEventListener("click", closeQrModal);
const _pwModal = $("pw-modal");
if (_pwModal) _pwModal.addEventListener("click", (e) => { if (e.target === _pwModal) closePwModal(); });
const _pwCancel = $("pw-cancel");
if (_pwCancel) _pwCancel.addEventListener("click", closePwModal);
const _pwSave = $("pw-save");
if (_pwSave) _pwSave.addEventListener("click", async () => {
  const pw = $("pw-new").value, pw2 = $("pw-new2").value;
  const errBox = $("pw-err");
  errBox.textContent = "";
  if (pw.length < 8) { errBox.textContent = "Password must be 8+ characters."; return; }
  if (pw !== pw2) { errBox.textContent = "Passwords do not match."; return; }
  try {
    await POST(`/api/users/${pwUid}/password`, {password: pw});
    toast(`Password reset for ${pwName}.`);
    closePwModal(); renderAccounts();
  } catch (e) { errBox.textContent = e.message; }
});
const _faModal = $("2fa-modal");
if (_faModal) _faModal.addEventListener("click", (e) => { if (e.target === _faModal) close2faModal(); });
const _faNo = $("2fa-no");
if (_faNo) _faNo.addEventListener("click", close2faModal);
const _faYes = $("2fa-yes");
if (_faYes) _faYes.addEventListener("click", async () => {
  try {
    await POST("/api/auth/totp-reset", {user_id: faUid});
    toast(`2FA reset for ${faName}.`);
    close2faModal(); renderAccounts();
  } catch (e) { toast("Error: " + e.message); }
});
const _delModal = $("del-modal");
if (_delModal) _delModal.addEventListener("click", (e) => { if (e.target === _delModal) closeDelModal(); });
const _delNo = $("del-no");
if (_delNo) _delNo.addEventListener("click", closeDelModal);
const _delYes = $("del-yes");
if (_delYes) _delYes.addEventListener("click", async () => {
  try {
    const r = await POST("/api/deletion-requests", {user_id: delUid});
    toast(r.duplicate ? "A deletion request for that account is already waiting."
                       : "Deletion request sent to the mentor queue.");
    closeDelModal(); renderDeletionRequests();
  } catch (e) { toast("Error: " + e.message); }
});
function showView(name) {
  closeAvatarMenu();
  closeLogoutModal();
  closeQrModal();
  closePwModal();
  close2faModal();
  closeDelModal();
  // A temporary password comes first: nothing else is reachable until
  // the user sets their own (the server enforces the same rule).
  if (ME && ME.must_change_password && name !== "password-change" && name !== "login")
    name = "password-change";
  // Mentors/admins without 2FA are held on Security until they set it
  // up (the server enforces the same rule on every API route).
  if (ME && ME.requires_2fa && name !== "security" && name !== "login" && name !== "signup")
    name = "security";
  if (!ME && name !== "signup" && name !== "login") name = "login";
  currentView = name;
  savePlace();
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  const _views = {signup: renderSignup, queue: renderQueue, roster: renderRoster,
    events: renderEvents, tracking: renderTracking, tasks: renderTasks, travel: renderTravel,
    security: renderSecurity, profile: renderProfile, login: renderLogin,
    "password-change": renderPasswordChange};
  // Unknown view (e.g. a newer nav button with an older script) falls
  // back to Events instead of throwing and leaving a blank page.
  (_views[name] || _views.events)();
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
    <div class="row">
      <button class="btn" id="lg-go">${SETUP ? "Create account" : "Log in"}</button>
      ${SETUP ? "" : '<button class="btn ghost" id="lg-gosignup">Sign Up</button>'}
    </div>
  </div></div>`;
  $("lg-go").addEventListener("click", submitLogin);
  $("lg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitLogin(); });
  const su = $("lg-gosignup");
  if (su) su.addEventListener("click", () => showView("signup"));
}

async function submitLogin() {
  const errBox = $("lg-err");
  errBox.textContent = "";
  try {
    const url = SETUP ? "/api/auth/setup" : "/api/auth/login";
    const body = SETUP
      ? {name: $("lg-name").value.trim(), email: $("lg-email").value.trim(), password: $("lg-pass").value}
      : {email: $("lg-email").value.trim(), password: $("lg-pass").value};
    const res = await POST(url, body);
    if (res.need_2fa) { render2FAStep(); return; }
    ME = res.user;
    SETUP = false;
    await loadAvatar();
    applyNav();
    toast("Welcome, " + ME.name + ".");
    if (!goCheckinQR()) showView("events");
    refreshBadges();
  } catch (e) { errBox.textContent = e.message; }
}

function render2FAStep() {
  const v = $("view-login");
  v.innerHTML = `
  <div class="login-wrap"><div class="card">
    <h2>Two-factor check</h2>
    <p class="sub">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
    <div class="err" id="lg-err"></div>
    <div class="field"><label>Code</label><input id="lg-code" inputmode="numeric" autocomplete="one-time-code"></div>
    <button class="btn" id="lg-verify">Verify</button>
  </div></div>`;
  const go = async () => {
    const errBox = $("lg-err"); errBox.textContent = "";
    try {
      ME = (await POST("/api/auth/verify-2fa", {code: $("lg-code").value.trim()})).user;
      await loadAvatar();
      applyNav();
      toast("Welcome, " + ME.name + ".");
      if (!goCheckinQR()) showView("events");
      refreshBadges();
    } catch (e) { errBox.textContent = e.message; }
  };
  $("lg-verify").addEventListener("click", go);
  $("lg-code").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("lg-code").focus();
}

/* ---------------- profile ---------------- */
async function renderProfile() {
  const v = $("view-profile");
  let me;
  try { me = await GET("/api/auth/me"); }
  catch (e) { v.innerHTML = `<div class="card"><p class="sub">Could not load your profile.</p></div>`; return; }
  const u = me.user;
  if (!u) { showView("login"); return; }
  const links = (u.links || []).map((l) => {
    let subs = l.assigned_subteam || "";
    if (!subs && l.prefs) {
      try { subs = (Array.isArray(l.prefs) ? l.prefs : JSON.parse(l.prefs)).join(", "); }
      catch (e) {}
    }
    return `<div class="sub">${esc(l.member_name)} · ${esc(l.kind === "self" ? "you" : "your child")}${l.school ? ` · ${esc(l.school)}` : ""}${subs ? ` · ${esc(subs)}` : ""}</div>`;
  }).join("") || `<div class="sub">No roster links yet — links form automatically when a mentor approves your sign-up or creates your account.</div>`;
  // Same first-word/rest split the server backfill uses, for accounts
  // whose name parts are still null (e.g. the setup account).
  const nameParts = (u.name || "").trim().split(/\s+/);
  const firstName = u.first_name ?? nameParts[0] ?? "";
  const lastName = u.last_name ?? nameParts.slice(1).join(" ") ?? "";
  const selfLink = (u.links || []).find((l) => l.kind === "self");
  const student = u.role === "student" && selfLink;
  v.innerHTML = `
  <div class="card"><h2>Profile</h2>
    <div class="row" style="align-items:center;gap:16px">
      <span id="pf-avatar">${avatarHTML(u.name, "avatar-lg")}</span>
      <div>
        <div style="font-size:20px;font-weight:700">${esc(u.name)}</div>
        <div class="sub">${esc(u.role)} · ${esc(u.email)}</div>
        ${u.member_since ? `<div class="sub">Member since ${esc(u.member_since.slice(0, 10))}</div>` : ""}
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <label class="btn ghost" style="cursor:pointer">Upload photo
        <input id="pf-file" type="file" accept="image/*" hidden></label>
      ${ME_AVATAR ? `<button class="btn ghost" id="pf-remove">Remove photo</button>` : ""}
    </div>
    <p class="sub">Photos are resized to 256px on your device before upload and stored with your account. Without a photo, your initials show instead.</p>
  </div>
  <div class="card"><h3>General</h3>
    <div class="grid3">
      <div class="field"><label>First name</label><input id="pf-first" value="${esc(firstName)}"></div>
      <div class="field"><label>Last name</label><input id="pf-last" value="${esc(lastName)}"></div>
      <div class="field"><label>Phone</label><input id="pf-phone" value="${esc(u.phone || "")}"></div>
      <div class="field"><label>WhatsApp</label><input id="pf-wa" value="${esc(u.whatsapp || "")}"></div>
      ${student ? `<div class="field"><label>School</label><input id="pf-school" value="${esc(selfLink.school || "")}"></div>
      <div class="field"><label>Grade</label><input id="pf-grade" value="${esc(selfLink.grade || "")}"></div>` : ""}
      <div class="field"><label>Email (login — ask a mentor to change it)</label><input value="${esc(u.email)}" disabled></div>
    </div>
    <button class="btn" id="pf-save">Save</button>
    <h3 style="margin-top:16px">Team &amp; school</h3>
    ${links}
  </div>`;
  $("pf-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!f.type.startsWith("image/")) { toast("Please pick an image file."); return; }
    try {
      const url = await resizeAvatar(f);
      await POST("/api/auth/avatar", {avatar: url});
      ME_AVATAR = url; renderHeaderAvatar(); renderProfile();
      toast("Photo updated.");
    } catch (err) { toast("Error: " + err.message); }
  });
  const rm = $("pf-remove");
  if (rm) rm.addEventListener("click", async () => {
    try {
      await DEL("/api/auth/avatar");
      ME_AVATAR = null; renderHeaderAvatar(); renderProfile();
      toast("Photo removed — showing initials.");
    } catch (err) { toast("Error: " + err.message); }
  });
  $("pf-save").addEventListener("click", async () => {
    const body = {first_name: $("pf-first").value, last_name: $("pf-last").value,
      phone: $("pf-phone").value, whatsapp: $("pf-wa").value};
    const schoolEl = $("pf-school"), gradeEl = $("pf-grade");
    if (schoolEl) body.school = schoolEl.value;
    if (gradeEl) body.grade = gradeEl.value;
    try {
      await POST("/api/auth/profile", body);
      ME = (await GET("/api/auth/me")).user;
      renderHeaderAvatar();
      renderProfile();
      toast("Profile saved.");
    } catch (err) { toast("Error: " + err.message); }
  });
}

/* Password change lives on the Security tab, not the Profile page:
   same payload as before (current/new, plus code when 2FA is on). */
function securityPasswordCard(enabled) {
  return `
  <div class="card"><h2>Password</h2>
    <div class="field" style="max-width:320px"><label>Current password</label><input id="sc-cur" type="password" autocomplete="current-password"></div>
    <div class="field" style="max-width:320px"><label>New password (8+ characters)</label><input id="sc-new" type="password" autocomplete="new-password"></div>
    <div class="field" style="max-width:320px"><label>Confirm new password</label><input id="sc-new2" type="password" autocomplete="new-password"></div>
    ${enabled ? `<div class="field" style="max-width:320px"><label>Authenticator code (required to change password)</label><input id="sc-code" inputmode="numeric" autocomplete="one-time-code"></div>` : ""}
    <button class="btn" id="sc-pw">Change password</button>
  </div>`;
}
function bindSecurityPassword() {
  const btn = $("sc-pw");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const cur = $("sc-cur").value, nw = $("sc-new").value, nw2 = $("sc-new2").value;
    if (nw !== nw2) { toast("New passwords don't match."); return; }
    if (nw.length < 8) { toast("New password must be 8+ characters."); return; }
    const body = {current: cur, new: nw};
    const codeEl = $("sc-code");
    if (codeEl) body.code = codeEl.value;
    try {
      await POST("/api/auth/password", body);
      $("sc-cur").value = $("sc-new").value = $("sc-new2").value = "";
      if (codeEl) codeEl.value = "";
      toast("Password changed.");
    } catch (err) { toast("Error: " + err.message); }
  });
}

async function renderSecurity() {
  const v = $("view-security");
  let st;
  try { st = await GET("/api/auth/totp-status"); }
  catch (e) { v.innerHTML = `<div class="card"><p class="sub">Could not load security settings.</p></div>`; return; }
  if (!st.enabled) {
    v.innerHTML = `
    ${ME && ME.requires_2fa ? `<div class="card"><p><b>Mentor accounts must set up two-factor authentication.</b> Other sections stay locked until you finish setup below.</p></div>` : ""}
    <div class="card"><h2>Two-factor authentication</h2>
      <p class="sub">Add a second step to your login with an authenticator app
      (Google Authenticator or Apple Passwords). Scan the QR code, then enter
      the 6-digit code to confirm. Save your recovery codes somewhere safe —
      they are the only way back in if you lose your phone.</p>
      <button class="btn" id="t-setup">Set up authenticator app</button>
      <div id="t-setup-area" style="margin-top:12px"></div>
    </div>
    ${securityPasswordCard(false)}`;
    bindSecurityPassword();
    $("t-setup").addEventListener("click", async () => {
      try {
        const s = await POST("/api/auth/totp-setup", {});
        $("t-setup-area").innerHTML = `
          ${s.qr_svg
            ? `<div class="sub">Scan this with your authenticator app, or enter the key by hand:</div>
               <div style="background:#fff;padding:12px;border-radius:12px;max-width:220px">${s.qr_svg}</div>`
            : `<div class="sub">QR codes are unavailable on this server — enter the key by hand in your authenticator app instead.</div>`}
          <div class="field" style="max-width:320px"><label>Manual key</label>
            <input value="${esc(s.secret)}" readonly onclick="this.select()"></div>
          <div class="field" style="max-width:200px"><label>Code from the app</label>
            <input id="t-code" inputmode="numeric" autocomplete="one-time-code"></div>
          <button class="btn" id="t-verify">Verify &amp; enable</button>
          <div id="t-verify-out" style="margin-top:12px"></div>`;
        $("t-verify").addEventListener("click", async () => {
          try {
            const r = await POST("/api/auth/totp-verify", {code: $("t-code").value.trim()});
            $("t-verify-out").innerHTML = `
              <p class="sub"><b>Two-factor authentication is on.</b> Save these recovery codes
              somewhere safe — each works once, and they are shown only this one time:</p>
              <div class="row" style="flex-wrap:wrap;gap:6px">${r.backup_codes.map((c) =>
                `<span class="pill">${esc(c)}</span>`).join("")}</div>
              <button class="btn" id="t-done" style="margin-top:12px">Done — I saved them</button>`;
            $("t-done").addEventListener("click", async () => {
              ME = (await GET("/api/auth/me")).user;
              renderSecurity();
            });
          } catch (e) { toast("Error: " + e.message); }
        });
      } catch (e) { toast("Error: " + e.message); }
    });
    return;
  }
  v.innerHTML = `
  <div class="card"><h2>Two-factor authentication</h2>
    <p><span class="pill green">ON</span>
    <span class="sub">${st.backup_codes_remaining} recovery codes left.</span></p>
    <p class="sub">Disabling or regenerating codes needs a current code from your app.
    Lost your phone? Ask a mentor to reset your 2FA from Team accounts.</p>
    <div class="field" style="max-width:200px"><label>Current code</label>
      <input id="t-code" inputmode="numeric" autocomplete="one-time-code"></div>
    <div class="row">
      <button class="btn ghost" id="t-disable">Disable 2FA</button>
      <button class="btn ghost" id="t-regen">Regenerate recovery codes</button>
    </div>
    <div id="t-out" style="margin-top:12px"></div>
  </div>
  ${securityPasswordCard(true)}`;
  bindSecurityPassword();
  $("t-disable").addEventListener("click", async () => {
    try {
      await POST("/api/auth/totp-disable", {code: $("t-code").value.trim()});
      ME = (await GET("/api/auth/me")).user;
      toast("Two-factor authentication disabled."); renderSecurity();
    } catch (e) { toast("Error: " + e.message); }
  });
  $("t-regen").addEventListener("click", async () => {
    try {
      const r = await POST("/api/auth/totp-regenerate", {code: $("t-code").value.trim()});
      $("t-out").innerHTML = `<p class="sub">New recovery codes (old ones no longer work):</p>
        <div class="row" style="flex-wrap:wrap;gap:6px">${r.backup_codes.map((c) =>
          `<span class="pill">${esc(c)}</span>`).join("")}</div>`;
    } catch (e) { toast("Error: " + e.message); }
  });
}

async function doLogout() {
  await POST("/api/auth/logout").catch(() => {});
  try { localStorage.removeItem("frc-place"); } catch (e) {}
  ME = null;
  ME_AVATAR = null;
  const me = await GET("/api/auth/me").catch(() => ({setup_required: false}));
  SETUP = !!me.setup_required;
  applyNav();
  showView("login");
}

async function refreshBadges() {
  // Badges live on nav buttons that only logged-in users see. Without
  // this guard, a logged-out call (e.g. after a public sign-up submit)
  // hits a login-gated route, gets a 401, and api() redirects the
  // visitor off the sign-up page to login.
  if (!ME) return;
  try {
    if (MENTOR()) {
      const pending = await GET("/api/members?status=pending");
      const b = $("nav-pending");
      b.textContent = pending.length;
      b.classList.toggle("hidden", !pending.length);
    }
    const rb = $("nav-rooms");
    if (ME && ME.role === "parent") { rb.classList.add("hidden"); return; }
    const events = await GET("/api/events");
    let awaiting = 0;
    for (const e of events) {
      const t = await GET(`/api/events/${e.id}/travel`);
      if (!t.hotel) continue;
      if (MENTOR()) awaiting += t.hotel.awaiting || 0;
      else awaiting += (t.hotel.requests || []).filter((q) =>
        q.status === "pending" && ME
        && normName(q.first_name + " " + q.last_name) === normName(ME.name)).length;
    }
    rb.textContent = awaiting;
    rb.classList.toggle("hidden", !awaiting);
  } catch (e) { /* badges are best-effort */ }
}

/* ---------------- forced password change ---------------- */
function renderPasswordChange() {
  const v = $("view-password-change");
  v.innerHTML = `
  <div class="login-wrap"><div class="card">
    <h2>Set your own password</h2>
    <p class="sub">You are logging in with a temporary password. Set a new one before using the team portal — you can't reuse a previous password.</p>
    <div class="err" id="pc-err"></div>
    <div class="field"><label>Current (temporary) password</label><input id="pc-cur" type="password"></div>
    <div class="field"><label>New password <span class="hint">(8+ chars)</span></label><input id="pc-new" type="password"></div>
    <div class="field"><label>Re-enter new password</label><input id="pc-new2" type="password"></div>
    <button class="btn" id="pc-save">Save new password</button>
  </div></div>`;
  $("pc-save").addEventListener("click", async () => {
    const errBox = $("pc-err");
    errBox.textContent = "";
    const cur = $("pc-cur").value, nw = $("pc-new").value, nw2 = $("pc-new2").value;
    if (nw.length < 8) return void (errBox.textContent = "New password must be 8+ characters.");
    if (nw !== nw2) return void (errBox.textContent = "New passwords do not match.");
    try {
      await POST("/api/auth/force-password-change", {current: cur, new: nw});
      const res = await GET("/api/auth/me");
      ME = res.user;
      applyNav();
      toast("Password updated — welcome in.");
      showView("events");
    } catch (e) { errBox.textContent = e.message; }
  });
}

/* ---------------- sign-up form ---------------- */
async function renderSignup() {
  const v = $("view-signup");
  v.innerHTML = `
  <div class="card"><h2>Team Sign-Up</h2>
  <p class="sub">Already have an account? <a href="#" id="su-login">Log in</a></p>
  <div class="err" id="su-err"></div>
  <div class="field"><label>I am signing up as</label><div class="row">
    <label class="checkline"><input type="radio" name="su-role" value="parent" checked> Parent / Guardian</label>
    <label class="checkline"><input type="radio" name="su-role" value="student"> Student</label>
  </div></div>
  <div class="field"><label>Is the student already on the team?</label><div class="row">
    <label class="checkline"><input type="radio" name="su-student" value="existing"> Yes — pick them below</label>
    <label class="checkline"><input type="radio" name="su-student" value="new" checked> No — new to the team</label>
  </div></div>
  <h3>Your contact info</h3>
  <div class="grid2">
    <div class="field"><label>Your full name *</label><input id="su-name"></div>
    <div class="field"><label>Your email *</label><input id="su-email" type="email"></div>
    <div class="field"><label>Your phone</label><input id="su-phone"></div>
    <div class="field" id="su-wa-wrap"><label>WhatsApp <span class="hint">(optional, parents)</span></label><input id="su-whatsapp"></div>
  </div>
  <h3>Temporary password</h3>
  <p class="sub">Used for your new account when a mentor approves. You'll set your own password at first login — and you can never reuse this one. If you already have an account, it is ignored.</p>
  <div class="grid2">
    <div class="field"><label>Temporary password *</label><input id="su-temp" type="password"></div>
    <div class="field"><label>Re-enter to confirm *</label><input id="su-temp2" type="password"></div>
  </div>
  <div id="su-existing" style="display:none">
    <h3>Pick the student</h3>
    <div class="field"><label>Existing student *</label><select id="su-member"><option value="">Loading students…</option></select></div>
    <p class="sub">This sends a link request to the mentor queue. A mentor approves it, and the account is then linked to that student.</p>
    <div class="row" style="margin-top:12px"><button class="btn" id="su-confirm">Confirm link request</button></div>
  </div>
  <div id="su-new">
    <h3>New student</h3>
    <div class="field"><label>Student's full name *</label><input id="su-student-name" placeholder="First Last"></div>
    <p class="sub">Just the name for now — this goes to the mentor queue, and a mentor completes the details and the linkage.</p>
    <div id="su-parent-wrap">
      <h4>Parent (optional)</h4>
      <div class="grid2">
        <div class="field"><label>Pick an existing parent</label><select id="su-parent-pick"><option value="">—</option></select></div>
        <div class="field"><label>Or enter a parent's name</label><input id="su-parent-name"></div>
      </div>
      <p class="sub">If the parent is already on the team, pick them above and their contact comes along. Otherwise type a name and a mentor completes it.</p>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn" id="su-submit">Submit to mentor queue</button></div>
  </div></div>`;
  const syncBranch = () => {
    const ex = document.querySelector('input[name="su-student"]:checked').value === "existing";
    $("su-existing").style.display = ex ? "" : "none";
    $("su-new").style.display = ex ? "none" : "";
  };
  document.querySelectorAll('input[name="su-student"]').forEach((r) =>
    r.addEventListener("change", syncBranch));
  syncBranch();
  // WhatsApp is a parent field: students never see it, and switching
  // to Student clears anything typed as a parent so it can't leak
  // into a student sign-up. The Parent block is the mirror: only
  // student sign-ups see it (it lives inside the New branch, so the
  // Existing branch never shows it either).
  const syncSuWa = () => {
    const par = document.querySelector('input[name="su-role"]:checked').value === "parent";
    $("su-wa-wrap").style.display = par ? "" : "none";
    if (!par) $("su-whatsapp").value = "";
    $("su-parent-wrap").style.display = par ? "none" : "";
    if (par) { $("su-parent-pick").value = ""; $("su-parent-name").value = ""; }
  };
  document.querySelectorAll('input[name="su-role"]').forEach((r) =>
    r.addEventListener("change", syncSuWa));
  syncSuWa();
  try {
    const parents = await GET("/api/parent-names");
    $("su-parent-pick").innerHTML = `<option value="">—</option>` +
      parents.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  } catch (e) { /* picker stays empty; typing a name still works */ }
  try {
    const names = await GET("/api/roster-names");
    $("su-member").innerHTML = names.length
      ? `<option value="">Pick a student…</option>` +
        names.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("")
      : `<option value="">No students on the roster yet</option>`;
  } catch (e) { $("su-member").innerHTML = `<option value="">Could not load students</option>`; }
  $("su-login").addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
  $("su-confirm").addEventListener("click", submitLinkRequest);
  $("su-submit").addEventListener("click", submitNameOnly);
}

function suContact() {
  // Shared sign-up validation: returns {name, email, phone, temp} or
  // sets the error and returns null. The email is required because it
  // becomes the new account's login; the temporary password is required
  // because approval creates the account from it.
  const errBox = $("su-err");
  errBox.textContent = "";
  const name = $("su-name").value.trim();
  const email = $("su-email").value.trim();
  const temp = $("su-temp").value, temp2 = $("su-temp2").value;
  if (!name) { errBox.textContent = "Your full name is required."; return null; }
  if (!email || !email.includes("@")) { errBox.textContent = "Your email is required for the new account."; return null; }
  if (temp.length < 8) { errBox.textContent = "Temporary password must be 8+ characters."; return null; }
  if (temp !== temp2) { errBox.textContent = "Temporary passwords do not match."; return null; }
  return {name, email, phone: $("su-phone").value.trim(), temp,
          whatsapp: $("su-whatsapp").value.trim()};
}

async function submitLinkRequest() {
  const errBox = $("su-err");
  const c = suContact();
  if (!c) return;
  const role = document.querySelector('input[name="su-role"]:checked').value;
  const mid = $("su-member").value;
  if (!mid) return void (errBox.textContent = "Pick an existing student.");
  try {
    const r = await POST("/api/link-requests", {
      requester_name: c.name, requester_email: c.email,
      requester_phone: c.phone, requester_kind: role,
      member_id: +mid, temp_password: c.temp,
      whatsapp: role === "parent" ? c.whatsapp : ""});
    toast(r.duplicate ? "That link request is already waiting for a mentor."
                       : "Link request sent — waiting for a mentor to approve it.");
    renderSignup();
    refreshBadges();
  } catch (e) { errBox.textContent = e.message; }
}

const NAME_ONLY_NOTE = "Name-only sign-up — mentor to complete details and linkage.";

async function submitNameOnly() {
  const errBox = $("su-err");
  const c = suContact();
  if (!c) return;
  const role = document.querySelector('input[name="su-role"]:checked').value;
  const full = $("su-student-name").value.trim();
  const sp = full.indexOf(" ");
  if (sp < 0 || !full.slice(sp + 1).trim())
    return void (errBox.textContent = "The student's full name (first and last) is required.");
  const first = full.slice(0, sp), last = full.slice(sp + 1).trim();
  const body = {first_name: first, last_name: last, notes: NAME_ONLY_NOTE,
                temp_password: c.temp};
  if (role === "parent") {
    body.parent_name = c.name; body.parent_email = c.email;
    body.parent_phone = c.phone; body.parent_whatsapp = c.whatsapp;
  } else {
    body.student_email = c.email; body.student_phone = c.phone;
    // Pick wins over typing: the picked parent's contact is filled in
    // server-side from the match.
    const pick = $("su-parent-pick").value;
    const typed = $("su-parent-name").value.trim();
    if (pick || typed) body.parent_name = pick || typed;
  }
  try {
    const m = await POST("/api/members", body);
    toast(`Application ${m.code} submitted — pending mentor review.`);
    renderSignup();
    refreshBadges();
  } catch (e) { errBox.textContent = e.message; }
}


/* ---------------- mentor queue ---------------- */
const STATUS_PILL = {pending: "amber", approved: "green", waitlisted: "gray", declined: "red", archived: "gray"};

async function renderQueue() {
  const v = $("view-queue");
  const members = await GET(`/api/members?status=${queueFilter}`);
  const counts = {};
  for (const s of ["pending", "approved", "waitlisted", "declined", "archived"])
    counts[s] = (await GET(`/api/members?status=${s}`)).length;
  v.innerHTML = `
  <div class="card"><h2>Mentor Queue</h2>
  <p class="sub">Review applications. Approving adds the student to the roster (and RSVPs).</p>
  <div class="row">
    ${["pending", "approved", "waitlisted", "declined", "archived"].map((s) =>
      `<button class="btn ${queueFilter === s ? "" : "ghost"} small"
        data-f="${s}">${s[0].toUpperCase() + s.slice(1)} (${counts[s]})</button>`).join("")}
    <span style="flex:1"></span>
    <a class="btn ghost small" href="/api/backup">Download backup</a>
    <button class="btn danger small" id="q-clear">Clear sample entries</button>
  </div></div>
  ${queueFilter === "pending" && members.length ? `<div class="card"><div class="row">
    <label><input type="checkbox" id="q-select-all"> Select all</label>
    <button class="btn small" id="q-approve-sel">Approve selected</button>
    <button class="btn small ghost" id="q-approve-all">Approve all pending</button>
    <span class="sub" id="q-sel-count"></span>
  </div></div>` : ""}
  <div id="q-list">${members.map(queueCard).join("") || '<div class="card">Nothing here.</div>'}</div>
  <div class="card"><h3>Link requests</h3>
    <p class="sub">Sign-ups for existing students — approve to link the requester to that student, decline to drop the request.</p>
    <div id="lr-list"><span class="sub">Loading…</span></div>
  </div>
  <div class="card"><h3>Account deletion requests</h3>
    <p class="sub">Disabled accounts awaiting final deletion — approve to delete the account for good, decline to keep it disabled.</p>
    <div id="dr-list"><span class="sub">Loading…</span></div>
  </div>
  <div class="card"><h3>Team accounts</h3>
    <p class="sub">Logins for mentors, parents and students \u2014 separate from sign-up applications. Only mentors/admins see this.</p>
    <div id="ac-list"><span class="sub">Loading\u2026</span></div>
    <div class="grid3" style="margin-top:12px">
      <div class="field"><label>First name</label><input id="ac-first"></div>
      <div class="field"><label>Last name</label><input id="ac-last"></div>
      <div class="field"><label>Email</label><input id="ac-email" type="email"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Role</label><select id="ac-role">
        <option>student</option><option>parent</option><option>mentor</option><option>admin</option></select></div>
      <div class="field"><label>Phone</label><input id="ac-phone"></div>
      <div class="field"><label>WhatsApp</label><input id="ac-whatsapp"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Password <span class="hint">(8+ chars)</span></label><input id="ac-pass" type="password"></div>
      <div class="field"><label>&nbsp;</label><div class="row">
        <button class="btn small" id="ac-add">Create account</button>
      </div></div>
    </div>
    <p class="sub">Reset password and Reset 2FA are per-row buttons in the table above.</p>
  </div>`;
  v.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => { queueFilter = b.dataset.f; renderQueue(); }));
  $("q-clear").addEventListener("click", async () => {
    if (!confirm("Delete all sample entries?")) return;
    const r = await DEL("/api/members/sample");
    toast(`Cleared ${r.cleared} sample entries.`);
    renderQueue(); refreshBadges();
  });
  const selAll = $("q-select-all");
  if (selAll) {
    const boxes = () => [...v.querySelectorAll(".q-bulk")];
    const updateCount = () => {
      const n = boxes().filter((c) => c.checked).length;
      const lbl = $("q-sel-count");
      if (lbl) lbl.textContent = n ? `${n} selected` : "";
      const btn = $("q-approve-sel");
      if (btn) btn.textContent = `Approve selected${n ? ` (${n})` : ""}`;
    };
    selAll.addEventListener("change", () => {
      boxes().forEach((c) => { c.checked = selAll.checked; });
      updateCount();
    });
    boxes().forEach((c) => c.addEventListener("change", updateCount));
    const approveIds = async (ids) => {
      if (!ids.length) { toast("Nothing selected."); return; }
      try {
        const r = await POST("/api/members/bulk-approve", {member_ids: ids});
        toast(`Approved ${r.approved}.`);
        renderQueue(); refreshBadges();
      } catch (err) { toast("Error: " + err.message); }
    };
    $("q-approve-sel").addEventListener("click", () =>
      approveIds(boxes().filter((c) => c.checked)
        .map((c) => parseInt(c.dataset.bulkId, 10))));
    $("q-approve-all").addEventListener("click", () =>
      approveIds(boxes().map((c) => parseInt(c.dataset.bulkId, 10))));
  }
  v.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => queueAction(b)));
  renderAccounts();
  renderLinkRequests();
  renderDeletionRequests();
}

async function renderDeletionRequests() {
  const el = $("dr-list");
  if (!el) return;
  let reqs = [];
  try { reqs = await GET("/api/deletion-requests"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load deletion requests.</span>'; return; }
  el.innerHTML = reqs.map((r) => `<div class="row" style="margin:4px 0;flex-wrap:wrap">
    <span><b>${esc(r.target_name || "deleted user")}</b> (${esc(r.target_role || "")} · ${esc(r.target_email || "")})</span>
    <span class="sub">requested by ${esc(r.requester_name || "a mentor")}</span>
    <span style="flex:1"></span>
    <button class="btn small danger" data-dr-approve="${r.id}">Delete for good</button>
    <button class="btn small ghost" data-dr-decline="${r.id}">Decline</button>
  </div>`).join("") || '<span class="sub">No pending deletion requests.</span>';
  el.querySelectorAll("[data-dr-approve]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await POST(`/api/deletion-requests/${b.dataset.drApprove}/approve`, {});
        toast("Account deleted.");
        renderDeletionRequests(); renderAccounts();
      } catch (e) { toast("Error: " + e.message); }
    }));
  el.querySelectorAll("[data-dr-decline]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await POST(`/api/deletion-requests/${b.dataset.drDecline}/decline`, {}); toast("Deletion request declined."); renderDeletionRequests(); }
      catch (e) { toast("Error: " + e.message); }
    }));
}

async function renderLinkRequests() {
  const el = $("lr-list");
  if (!el) return;
  let reqs = [];
  try { reqs = await GET("/api/link-requests"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load link requests.</span>'; return; }
  el.innerHTML = reqs.map((r) => `<div class="row" style="margin:4px 0;flex-wrap:wrap">
    <span><b>${esc(r.requester_name)}</b> (${esc(r.requester_kind)}) → <b>${esc(r.member_name)}</b></span>
    <span class="sub">${esc(r.requester_email)} ${esc(r.requester_phone)}</span>
    <span style="flex:1"></span>
    <button class="btn small" data-lr-approve="${r.id}">Approve</button>
    <button class="btn small ghost" data-lr-decline="${r.id}">Decline</button>
  </div>`).join("") || '<span class="sub">No pending link requests.</span>';
  el.querySelectorAll("[data-lr-approve]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await POST(`/api/link-requests/${b.dataset.lrApprove}/approve`, {});
        toast(`Link approved${r.linked_user ? " — account linked." : " — recorded for a future account."}`);
        renderLinkRequests(); renderAccounts();
      } catch (e) { toast("Error: " + e.message); }
    }));
  el.querySelectorAll("[data-lr-decline]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await POST(`/api/link-requests/${b.dataset.lrDecline}/decline`, {}); toast("Link request declined."); renderLinkRequests(); }
      catch (e) { toast("Error: " + e.message); }
    }));
}

async function renderAccounts() {
  const el = $("ac-list");
  if (!el) return;
  let users = [];
  try { users = await GET("/api/users"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load accounts.</span>'; return; }
  // Relationship is read-only now: links are created automatically at
  // signup approval and account creation, never managed by hand.
  // A self link reads as "child of <member's parent>"; a parent link
  // reads as "parent of <member>". School / grade / team come from the
  // linked roster member: the self link first, else the first parent
  // link (the child).
  const relOf = (u) => (u.links || []).map((l) => {
    if (l.kind === "parent") return `parent of ${l.member_name}`;
    if (l.kind === "self") {
      // Linked parent accounts first (the relationship editor's
      // picks); the member's parent_name string is the fallback.
      const ps = (l.linked_parents || []).map((p) => p.name);
      if (ps.length) return `child of ${ps.join(", ")}`;
      return l.parent_name ? `child of ${l.parent_name}` : `self (${l.member_name})`;
    }
    return `${l.kind} of ${l.member_name}`;
  });
  const memberOf = (u) => {
    const links = u.links || [];
    return links.find((l) => l.kind === "self") || links[0] || null;
  };
  el.innerHTML = `<div style="overflow-x:auto"><table class="acct">
    <thead><tr><th>First name</th><th>Last name</th><th>Username</th><th>Email</th>
    <th>Phone #</th><th>WhatsApp</th><th>Member type</th><th>School</th><th>Grade</th><th>Team</th>
    <th>Relationship to other member</th><th>Actions</th></tr></thead>
    <tbody>${users.map((u) => {
      const m = memberOf(u);
      const rel = relOf(u).join(", ");
      // Editable only where there is a roster side to edit: a parent
      // picks students, a student with a roster member picks parents.
      // Mentor/admin rows stay read-only.
      const relEditable = u.role === "parent" ||
        (u.role === "student" && (u.links || []).some((l) => l.kind === "self"));
      return `<tr>
        <td>${esc(u.first_name || "")}</td>
        <td>${esc(u.last_name || "")}</td>
        <td>${esc(u.name || "")}</td>
        <td>${esc(u.email || "")}</td>
        <td>${esc(u.phone || "")}</td>
        <td class="wa-cell" data-wa="${u.id}" title="Click to edit" style="cursor:pointer">${esc(u.whatsapp || "—")}</td>
        <td><span class="pill ${(u.role === "mentor" || u.role === "admin") ? "amber" : "gray"}">${esc(u.role)}</span>${u.disabled ? ' <span class="pill red">disabled</span>' : ""}</td>
        <td>${esc(m ? (m.school || "") : "")}</td>
        <td>${esc(m ? (m.grade || "") : "")}</td>
        <td>${esc(m ? (m.assigned_subteam || "") : "")}</td>
        <td ${relEditable ? `class="rel-cell" data-rel="${u.id}" title="Click to edit" style="cursor:pointer"` : ""}>${rel ? esc(rel) : '<span class="sub">—</span>'}</td>
        <td><div class="row" style="flex-wrap:nowrap">
          <button class="btn small ghost" data-pw="${u.id}">Reset password</button>
          <button class="btn small ghost" data-faid="${u.id}">Reset 2FA${u.totp_enabled ? "" : " (off)"}</button>
          <button class="btn small ghost" data-dis="${u.id}" ${(u.id === (ME && ME.id) && !u.disabled) ? "disabled title=\"You cannot disable your own account\"" : ""}>${u.disabled ? "Enable" : "Disable"}</button>
          <button class="btn small ghost" data-del="${u.id}" ${u.disabled ? "" : "disabled title=\"Disable the account first\""}>Delete</button>
        </div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="11"><span class="sub">No accounts yet.</span></td></tr>`}
    </tbody></table></div>`;
  el.querySelectorAll("[data-pw]").forEach((b) =>
    b.addEventListener("click", () => {
      const u = users.find((x) => x.id === +b.dataset.pw);
      if (u) openPwModal(u.id, u.name);
    }));
  el.querySelectorAll("[data-faid]").forEach((b) =>
    b.addEventListener("click", () => {
      const u = users.find((x) => x.id === +b.dataset.faid);
      if (u) open2faModal(u.id, u.name);
    }));
  el.querySelectorAll("[data-dis]").forEach((b) =>
    b.addEventListener("click", async () => {
      const u = users.find((x) => x.id === +b.dataset.dis);
      if (!u) return;
      try {
        await POST(`/api/users/${u.id}/${u.disabled ? "enable" : "disable"}`, {});
        toast(u.disabled ? `Account enabled for ${u.name}.` : `Account disabled for ${u.name}.`);
        renderAccounts();
      } catch (e) { toast("Error: " + e.message); }
    }));
  el.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const u = users.find((x) => x.id === +b.dataset.del);
      if (u) openDelModal(u.id, u.name);
    }));
  // WhatsApp is click-to-edit: click a cell to swap it for an input
  // with Save (Enter saves too, Escape cancels back to the table).
  el.querySelectorAll("[data-wa]").forEach((cell) =>
    cell.addEventListener("click", () => {
      if (cell.querySelector("input")) return;
      const uid = +cell.dataset.wa;
      const cur = users.find((x) => x.id === uid)?.whatsapp || "";
      cell.innerHTML = `<input class="wa-in" value="${esc(cur)}" style="min-width:120px"> <button class="btn small" data-wa-save>Save</button>`;
      const inp = cell.querySelector("input");
      inp.focus(); inp.select();
      const save = async () => {
        try {
          await PATCH(`/api/users/${uid}`, {whatsapp: inp.value.trim()});
          toast("WhatsApp updated.");
          renderAccounts();
        } catch (e) { toast("Error: " + e.message); }
      };
      cell.querySelector("[data-wa-save]").addEventListener("click", (e) => { e.stopPropagation(); save(); });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") renderAccounts();
      });
    }));
  // Relationship editor: tap-to-toggle chips, both ways around the
  // same parent links. A parent picks roster students; a student
  // picks parent accounts for their roster member. Saving sets the
  // exact set (anything unpicked is unlinked), and the other side's
  // row updates on re-render.
  el.querySelectorAll("[data-rel]").forEach((cell) =>
    cell.addEventListener("click", async () => {
      if (cell.querySelector(".rel-edit") || cell.dataset.relBusy) return;
      cell.dataset.relBusy = "1";
      const uid = +cell.dataset.rel;
      const u = users.find((x) => x.id === uid);
      if (!u) return;
      let cands = [], selected = new Set(), emptyMsg = "", saveBody = null;
      if (u.role === "parent") {
        try {
          const roster = await GET("/api/roster");
          cands = roster.map((m) => ({id: m.id, name: `${m.first_name} ${m.last_name}`.trim()}));
        } catch (e) { delete cell.dataset.relBusy; toast("Error: " + e.message); return; }
        selected = new Set((u.links || []).filter((l) => l.kind === "parent").map((l) => l.member_id));
        emptyMsg = "No students on the roster yet.";
        saveBody = (ids) => ({member_ids: ids});
      } else {
        const self = (u.links || []).find((l) => l.kind === "self");
        if (!self) { delete cell.dataset.relBusy; toast("That student has no roster member linked yet."); return; }
        cands = users.filter((x) => x.role === "parent").map((x) => ({id: x.id, name: x.name}));
        selected = new Set((self.linked_parents || []).map((p) => p.id));
        emptyMsg = "No parent accounts yet — create one in the form below first.";
        saveBody = (ids) => ({parent_ids: ids});
      }
      cell.innerHTML = `<div class="rel-edit">
        <div class="row rel-chips" style="flex-wrap:wrap">${cands.length ? cands.map((c) =>
          `<button type="button" class="bubble${selected.has(c.id) ? " active" : ""}" data-val="${c.id}">${esc(c.name)}</button>`).join("") : `<span class="sub">${emptyMsg}</span>`}</div>
        <div class="row" style="margin-top:6px"><button class="btn small" data-rel-save>Save</button><button class="btn small ghost" data-rel-cancel>Cancel</button></div>
      </div>`;
      const chips = cell.querySelector(".rel-chips");
      if (chips) chips.addEventListener("click", (e) => {
        const b = e.target.closest(".bubble");
        if (b) b.classList.toggle("active");
      });
      cell.querySelector("[data-rel-cancel]").addEventListener("click", (e) => { e.stopPropagation(); renderAccounts(); });
      cell.querySelector("[data-rel-save]").addEventListener("click", async (e) => {
        e.stopPropagation();
        const ids = [...cell.querySelectorAll(".bubble.active")].map((b) => +b.dataset.val);
        try {
          await POST(`/api/users/${uid}/relationships`, saveBody(ids));
          toast("Relationship updated.");
          renderAccounts();
        } catch (err) { toast("Error: " + err.message); }
      });
    }));
  $("ac-add").onclick = async () => {
    try {
      await POST("/api/users", {first_name: $("ac-first").value.trim(),
        last_name: $("ac-last").value.trim(),
        email: $("ac-email").value.trim(), role: $("ac-role").value,
        phone: $("ac-phone").value.trim(),
        whatsapp: $("ac-whatsapp").value.trim(),
        password: $("ac-pass").value});
      toast("Account created.");
      $("ac-first").value = $("ac-last").value = $("ac-email").value
        = $("ac-phone").value = $("ac-whatsapp").value = $("ac-pass").value = "";
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
      ${m.notes && m.notes.includes("Name-only sign-up") ? '<span class="pill amber">name-only</span>' : ""}
      <span class="sub">${esc(m.code || "")} · submitted ${esc(m.submitted_at.slice(0, 10))}</span>
    </div>
    <div class="sub">${esc(m.school || "")} · Grade ${esc(m.grade || "")} · ${esc(m.experience || "")}
      ${m.assigned_subteam ? `· <b>${esc(m.assigned_subteam)}</b>` : ""}</div>
    ${chats ? `<div>Discovery chats: ${chats}</div>` : ""}
    ${m.parent_whatsapp ? `<div class="sub">Parent WhatsApp: ${esc(m.parent_whatsapp)}${m.whatsapp_opt_in ? " ✓ updates on" : ""}</div>` : ""}
    <details><summary>Full application</summary>
      <table>
      <tr><th>Student</th><td>${esc(m.student_email)} ${esc(m.student_phone)}</td></tr>
      <tr><th>Parent</th><td>${esc(m.parent_name)} (${esc(m.relationship)}) — ${esc(m.parent_email)} ${esc(m.parent_phone)}${m.parent_whatsapp ? ` · WhatsApp ${esc(m.parent_whatsapp)}` : ""}</td></tr>
      <tr><th>Emergency</th><td>${esc(m.em_name)} ${esc(m.em_phone)} ${esc(m.medical)}</td></tr>
      <tr><th>Ranked prefs</th><td>${esc((m.prefs || []).join(", "))}</td></tr>
      <tr><th>Discovery sessions</th><td>${esc(m.discovery_sessions || "")}</td></tr>
      <tr><th>Notes</th><td>${esc(m.notes)}</td></tr>
      </table>
    </details>
    <div class="row" style="margin-top:8px">
      ${m.status === "pending" ? `<input type="checkbox" class="q-bulk" data-bulk-id="${m.id}" title="Select for bulk approve">` : ""}
      <select id="sub-${m.id}">
        <option value="">Assign subteam…</option>
        ${SUBTEAMS.map((s) => `<option ${m.assigned_subteam === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
      </select>
      <button class="btn small ghost" data-act="subteam" data-id="${m.id}">Save</button>
      ${m.status === "pending" ? `
        <button class="btn small" data-act="approve" data-id="${m.id}">Approve</button>
        <button class="btn small ghost" data-act="waitlist" data-id="${m.id}">Waitlist</button>
        <button class="btn small danger" data-act="decline" data-id="${m.id}">Decline</button>` : m.status === "archived" ? `
        <button class="btn small" data-act="approve" data-id="${m.id}">Approve</button>
        <button class="btn small ghost" data-act="waitlist" data-id="${m.id}">Waitlist</button>
        <button class="btn small danger" data-act="decline" data-id="${m.id}">Decline</button>
        <button class="btn small ghost" data-act="reopen" data-id="${m.id}">Reopen</button>` : `
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
/* Shared CSV import panel: file -> preview (no writes) -> confirm.
   kind is "roster" or "events". The panel renders the file picker,
   the preview table with per-row problems, the confirm button, and
   the result report. Previewed rows are echoed back for confirm. */
function bindCsvImport(panel, kind) {
  if (!panel) return;
  const up = kind;
  panel.innerHTML = `
  <div class="row" style="margin-top:10px">
    <input type="file" id="csv-file-${kind}" accept=".csv,text/csv">
    <button class="btn small" id="csv-prev-${kind}">Preview</button>
  </div>
  <p class="sub">Upload a CSV in the export format (Export CSV gives you the template). Rows match by Code: a matching code updates, a new or blank code creates. New members start pending in the Mentor Queue. Nothing is written until you confirm.</p>
  <div id="csv-preview-${kind}"></div>
  <div id="csv-result-${kind}"></div>`;
  let previewed = null;
  panel.querySelector(`#csv-prev-${kind}`).addEventListener("click", async () => {
    const file = panel.querySelector(`#csv-file-${kind}`).files[0];
    if (!file) { toast("Choose a CSV file first."); return; }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/${up}/import/preview`, {method: "POST", body: fd});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      previewed = data;
      const s = data.summary;
      const shown = data.rows.slice(0, 200);
      const bad = data.rows.filter((r) => r.errors.length);
      panel.querySelector(`#csv-preview-${kind}`).innerHTML = `
      <p><b>Preview:</b> ${s.total} rows — ${s.create} to create, ${s.update} to update, ${s.error_rows} with errors${data.rows.length > 200 ? " (showing first 200)" : ""}.</p>
      ${bad.length ? `<div class="err">${bad.map((r) => `Row ${r.line}: ${esc(r.errors.join("; "))}`).join("<br>")}</div>` : ""}
      <table><tr><th>Row</th><th>Action</th><th>Name / Title</th><th>Problems</th></tr>
      ${shown.map((r) => `<tr><td>${r.line}</td><td>${r.action}</td><td>${esc(kind === "roster" ? `${r.data.first_name} ${r.data.last_name}`.trim() : r.data.title)}</td><td>${r.errors.length ? esc(r.errors.join("; ")) : "—"}</td></tr>`).join("")}</table>
      ${s.valid ? `<div class="row" style="margin-top:10px"><button class="btn" id="csv-confirm-${kind}">Import ${s.valid} row${s.valid === 1 ? "" : "s"}</button></div>` : `<p class="sub">Nothing valid to import — fix the errors and preview again.</p>`}`;
      const cb = panel.querySelector(`#csv-confirm-${kind}`);
      if (cb) cb.addEventListener("click", async () => {
        try {
          const rows = previewed.rows.filter((r) => !r.errors.length);
          const res2 = await fetch(`/api/${up}/import/confirm`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({rows})});
          const out = await res2.json();
          if (!res2.ok) throw new Error(out.error || "Import failed");
          const resultHtml = `
          <p><b>Imported:</b> ${out.created} created, ${out.updated} updated, ${out.skipped.length} skipped.</p>
          ${out.skipped.length ? `<div class="err">${out.skipped.map((s2) => `Row ${s2.line}: ${esc(s2.errors.join("; "))}`).join("<br>")}</div>` : ""}`;
          // Re-render first (it rebuilds the panel), then show the
          // result in the fresh panel so it survives the re-render.
          if (kind === "roster") await renderRoster(); else await renderEvents();
          const np = $(kind === "roster" ? "r-import-panel" : "e-import-panel");
          if (np) {
            np.classList.remove("hidden");
            np.querySelector(`#csv-result-${kind}`).innerHTML = resultHtml;
          }
        } catch (err) { toast("Error: " + err.message); }
      });
    } catch (err) { toast("Error: " + err.message); }
  });
}

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
    <button class="btn ghost small" id="r-import">Import CSV</button>
  </div>
  <div id="r-import-panel" class="hidden"></div></div>
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
  $("r-import").addEventListener("click", () => $("r-import-panel").classList.toggle("hidden"));
  bindCsvImport($("r-import-panel"), "roster");
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

/* What the signed-in account may RSVP as: own student record and/or the
   members they are a parent of. Mentors bypass this (override). */
function selfScope() {
  if (!ME) return {student: null, parents: []};
  // Identity links from /api/auth/me are authoritative. Name matching
  // is only a fallback for accounts with no links yet (a name the
  // backfill couldn't match; links form automatically at signup
  // approval or account creation).
  if (ME.links && ME.links.length) {
    const self = ME.links.find((l) => l.kind === "self");
    return {student: self ? self.member_id : null,
      parents: ME.links.filter((l) => l.kind === "parent")
        .map((l) => l.member_id)};
  }
  const me = normName(ME.name);
  const student = rosterCache.find((m) =>
    normName(m.first_name + " " + m.last_name) === me);
  const parents = rosterCache.filter((m) =>
    m.parent_name && normName(m.parent_name) === me).map((m) => m.id);
  return {student: student ? student.id : null, parents};
}
function selfRSVPOptions() {
  const {student, parents} = selfScope();
  const opts = [];
  if (ME.links && ME.links.length) {
    const self = ME.links.find((l) => l.kind === "self");
    if (self) opts.push({member_id: self.member_id, kind: "student",
      name: `${self.member_name} (student)`});
    const plinks = ME.links.filter((l) => l.kind === "parent");
    plinks.forEach((l) => {
      const first = (l.member_name || "").split(" ")[0];
      opts.push({member_id: l.member_id, kind: "parent",
        name: `${ME.name} (parent)`,
        label: plinks.length > 1 ? `${ME.name} (parent of ${first})` : undefined});
    });
    return opts;
  }
  if (student) {
    const m = rosterCache.find((x) => x.id === student);
    if (m) opts.push({member_id: student, kind: "student",
      name: `${m.first_name} ${m.last_name} (student)`});
  }
  parents.forEach((mid) => {
    const m = rosterCache.find((x) => x.id === mid);
    if (!m) return;
    opts.push({member_id: mid, kind: "parent", name: `${m.parent_name} (parent)`,
      label: parents.length > 1 ? `${m.parent_name} (parent of ${m.first_name})` : undefined});
  });
  return opts;
}

async function loadPeople() {
  // Mentors get the full roster; everyone else the names-only directory.
  rosterCache = await GET(MENTOR() ? "/api/roster" : "/api/people");
}

async function renderAnnouncements() {
  const el = $("an-list");
  if (!el) return;
  let list = [];
  try { list = await GET("/api/announcements"); } catch (e) {
    el.innerHTML = '<span class="sub">Could not load announcements.</span>';
    return;
  }
  el.innerHTML = list.map((a) => `
    <div style="margin:8px 0">
      <b>${esc(a.title)}</b>
      <span class="sub"> · ${esc(a.author || "")} · ${(a.created_at || "").slice(0, 10)}</span>
      ${MENTOR() ? `<button class="btn small ghost" data-delan="${a.id}">Delete</button>` : ""}
      <div>${esc(a.body)}</div>
    </div>`).join("") || '<span class="sub">No announcements yet.</span>';
  el.querySelectorAll("[data-delan]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this announcement?")) return;
      await DEL(`/api/announcements/${b.dataset.delan}`);
      renderAnnouncements();
    }));
}

/* Month grid over the filtered events: an overview above the list.
   Clicking a title jumps to that event's card below. */
function eventCalendarHtml(list) {
  const now = new Date();
  const cur = eventCalCursor ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [y, m] = cur.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startDay = first.getDay();
  const days = new Date(y, m, 0).getDate();
  const label = first.toLocaleString(undefined, {month: "long", year: "numeric"});
  const byDay = {};
  for (const e of list) {
    // Multi-day events appear on every day of the trip, not just Day 1.
    for (const ds of eventDays(e)) {
      if (!ds.startsWith(cur)) continue;
      (byDay[ds] = byDay[ds] || []).push(e);
    }
  }
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(`<div class="cal-cell empty"></div>`);
  for (let d = 1; d <= days; d++) {
    const ds = `${cur}-${String(d).padStart(2, "0")}`;
    const evs = byDay[ds] || [];
    const today = ds === now.toISOString().slice(0, 10) ? " today" : "";
    cells.push(`<div class="cal-cell${today}"><b>${d}</b>
      ${evs.slice(0, 3).map((e) => `<a href="#ev-card-${e.id}" class="cal-ev">${esc(e.title)}</a>`).join("")}
      ${evs.length > 3 ? `<span class="sub">+${evs.length - 3} more</span>` : ""}</div>`);
  }
  return `<div class="card"><div class="row">
    <button class="btn small ghost" data-calnav="-1">‹ Prev</button>
    <b style="flex:1;text-align:center">${label}</b>
    <button class="btn small ghost" data-calnav="0">Today</button>
    <button class="btn small ghost" data-calnav="1">Next ›</button>
  </div>
  <div class="cal-grid">
    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-head">${d}</div>`).join("")}
    ${cells.join("")}
  </div></div>`;
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
  const types = ["meeting", "build", "competition", "outreach", "club"];
  v.innerHTML = `
  <div class="card"><h2>Announcements</h2>
    <div id="an-list"><span class="sub">Loading…</span></div>
    <div class="mo" style="margin-top:12px">
      <div class="field"><label>Title</label><input id="an-title"></div>
      <div class="field"><label>Message</label><textarea id="an-body"></textarea></div>
      <button class="btn small" id="an-post">Post announcement</button>
    </div>
  </div>
  <div class="card"><h2>Events &amp; RSVPs</h2>
  <p class="sub">Mentors create events. Students and parents RSVP for themselves; mentors can RSVP for anyone. Over-capacity events waitlist with auto-promote.</p>
  <h3 class="mo">Create event</h3>
  <div class="grid3 mo">
    <div class="field"><label>Title *</label><input id="e-title"></div>
    <div class="field"><label>Type</label><select id="e-type">
      ${types.map((t) => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></div>
    <div class="field"><label>Date</label><input id="e-date" type="date"></div>
    <div class="field"><label>End date <span class="hint">(multi-day trips)</span></label><input id="e-end" type="date"></div>
    <div class="field"><label>Time</label><input id="e-time" placeholder="6:00 PM"></div>
    <div class="field"><label>Location</label><input id="e-loc"></div>
    <div class="field"><label>Capacity <span class="hint">(blank = unlimited)</span></label>
      <input id="e-cap" inputmode="numeric"></div>
    <div class="field"><label>RSVP deadline</label><input id="e-dead" type="date"></div>
    <div class="field"><label>Repeat weekly <span class="hint">(weeks, 1 = once, max 12)</span></label>
      <input id="e-repeat" inputmode="numeric" value="1"></div>
  </div>
  <div class="field mo"><label>Notes</label><textarea id="e-notes"></textarea></div>
  <div class="row mo"><button class="btn" id="e-create">Create event</button>
    <button class="btn ghost" id="e-fill" type="button">Fill with an example event</button>
    <button class="btn ghost" id="e-workshop" type="button">Use workshop address</button></div>
  <p class="sub mo hidden" id="e-clubnote">Club meets Mondays 4:00–5:05 PM and is only for BASIS Independent Fremont students.</p>
  <div class="row mo">
    <a class="btn ghost small" href="/api/events.csv">Export CSV</a>
    <button class="btn ghost small" id="e-import">Import CSV</button>
    <button class="btn ghost small" id="e-archive">Archive season…</button>
  </div>
  <div id="e-import-panel" class="mo hidden"></div>
  </div>
  <div class="card"><div class="row">
    ${["all", ...types].map((t) =>
      `<button class="btn ${eventFilter === t ? "" : "ghost"} small" data-et="${t}">${t}</button>`).join("")}
    <input id="e-q" placeholder="Search…" value="${esc(eventSearch)}" style="max-width:200px">
    <button class="btn small ghost" id="ev-expand-all">Expand all</button>
    <button class="btn small ghost" id="ev-collapse-all">Collapse all</button>
    <button class="btn small ${eventCalMode ? "ghost" : ""}" id="ev-list-view">List</button>
    <button class="btn small ${eventCalMode ? "" : "ghost"}" id="ev-cal-view">Calendar</button>
  </div></div>
  ${eventCalMode ? eventCalendarHtml(list) : ""}
  <div id="ev-list">${cards.join("")}</div>
  <div class="card"><button class="btn small ghost" id="ev-arch-toggle">Show archived seasons</button>
  <div id="ev-arch" class="hidden" style="margin-top:10px"></div></div>`;
  v.querySelectorAll("[data-et]").forEach((b) =>
    b.addEventListener("click", () => { eventFilter = b.dataset.et; renderEvents(); }));
  $("e-q").addEventListener("input", (e) => { eventSearch = e.target.value; renderEvents(); });
  const lv = $("ev-list-view"), cv = $("ev-cal-view");
  if (lv) lv.addEventListener("click", () => { eventCalMode = false; renderEvents(); });
  if (cv) cv.addEventListener("click", () => { eventCalMode = true; renderEvents(); });
  v.querySelectorAll("[data-calnav]").forEach((b) =>
    b.addEventListener("click", () => {
      const step = parseInt(b.dataset.calnav, 10);
      const now = new Date();
      const base = eventCalCursor ||
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      if (step === 0) { eventCalCursor = ""; }
      else {
        const [y, m] = base.split("-").map(Number);
        const d = new Date(y, m - 1 + step, 1);
        eventCalCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }
      renderEvents();
    }));
  renderAnnouncements();
  const anPost = $("an-post");
  if (anPost) anPost.addEventListener("click", async () => {
    const title = $("an-title").value.trim();
    if (!title) { toast("Title is required."); return; }
    try {
      await POST("/api/announcements", {title, body: $("an-body").value.trim()});
      $("an-title").value = ""; $("an-body").value = "";
      toast("Announcement posted."); renderAnnouncements();
    } catch (err) { toast("Error: " + err.message); }
  });
  const eImp = $("e-import");
  if (eImp) eImp.addEventListener("click", () => $("e-import-panel").classList.toggle("hidden"));
  bindCsvImport($("e-import-panel"), "events");
  const eArch = $("e-archive");
  if (eArch) eArch.addEventListener("click", async () => {
    const name = prompt("Season name, e.g. 2025-26 (all current events will be archived under it):");
    if (!name || !name.trim()) return;
    try {
      const r = await POST("/api/events/archive-season", {season: name.trim()});
      toast(`Archived ${r.archived} events under ${r.season}.`);
      renderEvents();
    } catch (err) { toast("Error: " + err.message); }
  });
  const archT = $("ev-arch-toggle");
  if (archT) archT.addEventListener("click", async () => {
    const box = $("ev-arch");
    const opening = box.classList.contains("hidden");
    box.classList.toggle("hidden");
    archT.textContent = opening ? "Hide archived seasons" : "Show archived seasons";
    if (!opening || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    try {
      const arch = await GET("/api/events?season=archived");
      if (!arch.length) { box.innerHTML = '<p class="sub">No archived seasons yet.</p>'; return; }
      const groups = {};
      for (const e of arch) (groups[e.season || ""] = groups[e.season || ""] || []).push(e);
      let html = "";
      for (const [season, evs] of Object.entries(groups)) {
        const cards2 = [];
        for (const e of evs) cards2.push(await eventCard(e, true));
        html += `<h3>${esc(season)} <span class="sub">(${evs.length} events, read-only)</span>
          ${MENTOR() ? `<button class="btn small ghost" data-unarch="${esc(season)}">Restore season to current</button>` : ""}</h3>
          ${cards2.join("")}`;
      }
      box.innerHTML = html;
      box.querySelectorAll("[data-unarch]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm(`Restore the ${b.dataset.unarch} season to the current lists?`)) return;
          await POST("/api/events/unarchive-season", {season: b.dataset.unarch});
          toast("Season restored."); renderEvents();
        }));
    } catch (err) { box.innerHTML = `<p class="sub">Could not load archive: ${esc(err.message)}</p>`; }
  });
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  const _ec = $("e-create"); if (_ec) _ec.addEventListener("click", createEvent);
  const _ef = $("e-fill"); if (_ef) _ef.addEventListener("click", () => {
    $("e-title").value = "Build Session — Intake Prototype"; $("e-type").value = "build";
    $("e-date").value = "2026-11-02"; $("e-time").value = "10:00 AM";
    $("e-loc").value = "4285 Santa Monica Terrace, Fremont, CA 94539"; $("e-cap").value = "12";
  });
  const _ew = $("e-workshop"); if (_ew) _ew.addEventListener("click", () => {
    $("e-loc").value = "4285 Santa Monica Terrace, Fremont, CA 94539";
  });
  // Club defaults: Mondays 4:00 PM, only when the mentor hasn't typed
  // anything yet; the note reminds them of the BIF-only rule.
  const _et = $("e-type"); if (_et) _et.addEventListener("change", () => {
    const note = $("e-clubnote");
    const isClub = _et.value === "club";
    if (note) note.classList.toggle("hidden", !isClub);
    if (!isClub) return;
    if (!$("e-time").value) $("e-time").value = "4:00 PM";
    if (!$("e-date").value) {
      const d = new Date();
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
      const pad = (n) => String(n).padStart(2, "0");
      $("e-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  });
  const setRsvpList = (id, open) => {
    const el = $("rl-" + id);
    if (!el) return;
    el.classList.toggle("hidden", !open);
    if (open) openRsvpLists.add(id); else openRsvpLists.delete(id);
    const b = v.querySelector(`[data-expand="${id}"]`);
    if (b) b.textContent = open ? "Collapse list" : `Expand list (${b.dataset.count})`;
  };
  v.querySelectorAll("[data-expand]").forEach((b) =>
    b.addEventListener("click", () => setRsvpList(parseInt(b.dataset.expand, 10),
      $("rl-" + b.dataset.expand).classList.contains("hidden"))));
  const ea = $("ev-expand-all");
  if (ea) ea.addEventListener("click", () =>
    v.querySelectorAll("[data-expand]").forEach((b) =>
      setRsvpList(parseInt(b.dataset.expand, 10), true)));
  const ca = $("ev-collapse-all");
  if (ca) ca.addEventListener("click", () =>
    v.querySelectorAll("[data-expand]").forEach((b) =>
      setRsvpList(parseInt(b.dataset.expand, 10), false)));
  v.querySelectorAll("[data-rsvp]").forEach((b) =>
    b.addEventListener("click", () => rsvpAction(b)));
  v.querySelectorAll("[data-unrsvp]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await DEL(`/api/rsvps/${b.dataset.unrsvp}`);
        toast(r.promoted ? `Released — ${esc(r.promoted.person_name)} promoted from waitlist.` : "RSVP removed.");
        renderEvents();
      } catch (e) { toast("Error: " + e.message); }
    }));
  v.querySelectorAll("[data-delev]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this event and its RSVPs?")) return;
      await DEL(`/api/events/${b.dataset.delev}`);
      toast("Event deleted."); renderEvents();
    }));
  v.querySelectorAll("[data-qr]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await GET(`/api/events/${b.dataset.qr}/checkin-qr`);
        $("qr-title").textContent = `Check-in QR — ${r.title}`;
        $("qr-body").innerHTML = r.qr_svg;
        $("qr-url").textContent = r.url;
        openQrModal();
      } catch (err) { toast("Error: " + err.message); }
    }));
  v.querySelectorAll("[data-dupev]").forEach((b) =>
    b.addEventListener("click", () => {
      const e = list.find((x) => x.id === parseInt(b.dataset.dupev, 10));
      if (!e) return;
      $("e-title").value = e.title;
      $("e-type").value = e.type;
      $("e-time").value = e.time || "";
      $("e-loc").value = e.location || "";
      $("e-cap").value = e.capacity === null || e.capacity === undefined ? "" : e.capacity;
      $("e-notes").value = e.notes || "";
      $("e-date").value = "";
      $("e-end").value = "";
      $("e-dead").value = "";
      $("e-title").scrollIntoView();
      toast("Copied — pick a new date and save.");
    }));
  v.querySelectorAll("[data-editev]").forEach((b) =>
    b.addEventListener("click", () =>
      v.querySelector(`#ef-${b.dataset.editev}`).classList.toggle("hidden")));
  v.querySelectorAll("[data-cancelev]").forEach((b) =>
    b.addEventListener("click", () =>
      v.querySelector(`#ef-${b.dataset.cancelev}`).classList.add("hidden")));
  v.querySelectorAll("[data-saveev]").forEach((b) =>
    b.addEventListener("click", async () => {
      const f = v.querySelector(`#ef-${b.dataset.saveev}`);
      const q = (sel) => f.querySelector(sel).value;
      try {
        await PATCH(`/api/events/${b.dataset.saveev}`, {title: q(".ef-title").trim(),
          type: q(".ef-type"), date: q(".ef-date").trim(),
          end_date: q(".ef-end").trim(),
          time: q(".ef-time").trim(), location: q(".ef-loc").trim(),
          capacity: q(".ef-cap").trim(), deadline: q(".ef-dead").trim(),
          session_hours: q(".ef-hours").trim(), notes: q(".ef-notes").trim()});
        toast("Event updated."); renderEvents();
      } catch (err) { toast("Error: " + err.message); }
    }));
}

async function createEvent() {
  const val = (id) => $(id).value.trim();
  if (!val("e-title")) return toast("Title is required.");
  const base = {title: val("e-title"), type: $("e-type").value,
    date: val("e-date"), end_date: val("e-end"), time: val("e-time"),
    location: val("e-loc"),
    capacity: val("e-cap") ? parseInt(val("e-cap"), 10) : null,
    deadline: val("e-dead"), notes: val("e-notes")};
  // Weekly repeat: pure calendar math (UTC) so timezones can't shift
  // the day; the deadline shifts with the event. Dateless events
  // ignore repeat — a series without dates is meaningless.
  const addWeeks = (ds, w) => {
    if (!ds) return "";
    const [y, m, d] = ds.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + w * 7)).toISOString().slice(0, 10);
  };
  try {
    await POST("/api/events", base);
    let weeks = parseInt(val("e-repeat") || "1", 10);
    if (isNaN(weeks) || weeks < 1) weeks = 1;
    if (weeks > 12) weeks = 12;
    if (weeks > 1 && base.date) {
      for (let w = 1; w < weeks; w++) {
        await POST("/api/events", {...base,
          date: addWeeks(base.date, w),
          end_date: addWeeks(base.end_date, w),
          deadline: addWeeks(base.deadline, w)});
      }
    }
    toast(weeks > 1 && base.date ? `Created ${weeks} weekly events.` : "Event created.");
    renderEvents();
  } catch (e) { toast("Error: " + e.message); }
}

async function eventCard(e, ro = false) {
  const d = await GET(`/api/events/${e.id}/rsvps`);
  const hc = d.headcounts;
  const closed = e.deadline && e.deadline < new Date().toISOString().slice(0, 10);
  const pickerOpts = MENTOR() ? personOptions() : selfRSVPOptions();
  const opts = pickerOpts.map((p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.label || p.name)}</option>`).join("");
  // Closed events hide the picker — except for mentors, whose override
  // is how a late RSVP gets filed (the server enforces the same rule).
  // Club events hide the picker for non-BIF accounts (ME.bif comes from
  // /api/auth/me; undefined right after login means the server is the
  // only gate, which still rejects with a clear message).
  const clubBlocked = e.type === "club" && !MENTOR() && ME && ME.bif === false;
  let pickerRow;
  if (ro) pickerRow = "";
  else if (clubBlocked) pickerRow = `<p class="sub">Club events are only for BASIS Independent Fremont students.</p>`;
  else if (closed && !MENTOR()) pickerRow = "";
  else if (pickerOpts.length) pickerRow = `<div class="row">
      <select id="rp-${e.id}">${opts}</select>
      <button class="btn small" data-rsvp="${e.id}" data-want="going">RSVP Going</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="maybe">Maybe</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="partial">Partial (multi-day)</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="cant">Can't make it</button>
    </div>${eventDays(e).length > 1 ? `<div class="row" style="margin-top:6px"><span class="sub">Partial days:</span>
      ${eventDays(e).map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="rp-day" data-day="${ds}" checked> ${dayLabel(ds)}</label>`).join("")}
      <span class="sub">(all checked = every day; only used for Partial)</span></div>` : ""}
    ${closed ? `<p class="sub">Deadline passed — mentor override: you can still RSVP for others.</p>` : ""}`;
  else pickerRow = `<p class="sub">We couldn't match your account to the roster, so you can't RSVP — ask a mentor to check your account name.</p>`;
  const scope = selfScope();
  const row = (r) => {
    const pill = r.status === "going" ? "green" : r.status === "waitlisted" ? "amber"
      : r.status === "maybe" ? "blue" : r.status === "partial" ? "purple" : "gray";
    const canRemove = !ro && (MENTOR() || (ME
      && ((r.person_kind === "student" && r.member_id === scope.student)
        || (r.person_kind === "parent" && scope.parents.includes(r.member_id)))));
    return `<div class="row" style="margin:4px 0">
      <span class="pill ${pill}">${r.status}</span>
      <span>${esc(r.person_name)} <span class="sub">(${r.person_kind})</span></span>
      ${r.status === "partial" && r.days && r.days.length && eventDays(e).length > 1
        ? `<span class="sub">${r.days.map(dayLabel).join(", ")}</span>` : ""}
      ${canRemove ? `<button class="btn small ghost" data-unrsvp="${r.id}">Remove</button>` : ""}</div>`;
  };
  return `<div class="card" id="ev-card-${e.id}">
    <div class="row"><b>${esc(e.title)}</b>
      <span class="pill">${esc(e.type)}</span>
      ${e.season ? `<span class="pill gray">${esc(e.season)}</span>` : ""}
      ${closed ? '<span class="pill red">RSVP closed</span>' : ""}
      <span style="flex:1"></span>
      ${ro ? "" : `<a class="btn small ghost" href="/api/events/${e.id}.ics">Add to calendar</a>
      ${MENTOR() ? `<button class="btn small ghost" data-qr="${e.id}">Check-in QR</button><button class="btn small ghost" data-dupev="${e.id}">Duplicate</button><button class="btn small ghost" data-editev="${e.id}">Edit</button><button class="btn small danger" data-delev="${e.id}">Delete</button>` : ""}`}</div>
    <div class="sub">${esc(eventDateLabel(e) || "")} ${esc(e.time || "")} · ${esc(e.location || "")}
      ${e.capacity ? `· ${hc.going}/${e.capacity} going` : `· ${hc.going} going`}
      · ${hc.maybe} maybe · ${hc.partial} partial
      · ${hc.waitlisted} waitlisted · ${hc.cant} can't make it</div>
    ${e.notes ? `<div class="sub">${esc(e.notes)}</div>` : ""}
    ${e.type === "club" ? `<div class="sub">Club — BASIS Independent Fremont students only · Mondays 4:00–5:05 PM.</div>` : ""}
    ${MENTOR() && !ro ? `<div id="ef-${e.id}" class="hidden" style="margin-top:10px">
      <div class="grid3">
        <div class="field"><label>Title *</label><input class="ef-title" value="${esc(e.title)}"></div>
        <div class="field"><label>Type</label><select class="ef-type">
          ${["meeting", "build", "competition", "outreach", "club"].map((t) => `<option value="${t}" ${e.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="field"><label>Date</label><input class="ef-date" type="date" value="${esc(e.date || "")}"></div>
        <div class="field"><label>End date <span class="hint">(multi-day)</span></label><input class="ef-end" type="date" value="${esc(e.end_date || "")}"></div>
        <div class="field"><label>Time</label><input class="ef-time" value="${esc(e.time || "")}"></div>
        <div class="field"><label>Location</label><input class="ef-loc" value="${esc(e.location || "")}"></div>
        <div class="field"><label>Capacity <span class="hint">(blank = unlimited)</span></label><input class="ef-cap" inputmode="numeric" value="${e.capacity === null || e.capacity === undefined ? "" : e.capacity}"></div>
        <div class="field"><label>RSVP deadline</label><input class="ef-dead" type="date" value="${esc(e.deadline || "")}"></div>
        <div class="field"><label>Session hours</label><input class="ef-hours" inputmode="decimal" value="${e.session_hours === null || e.session_hours === undefined ? "" : e.session_hours}"></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="ef-notes">${esc(e.notes || "")}</textarea></div>
      <div class="row"><button class="btn small" data-saveev="${e.id}">Save changes</button>
        <button class="btn small ghost" data-cancelev="${e.id}">Cancel</button></div>
    </div>` : ""}
    ${pickerRow}
    ${d.rsvps.length ? `<div class="row" style="margin-top:6px"><button class="btn small ghost" data-expand="${e.id}" data-count="${d.rsvps.length}">${openRsvpLists.has(e.id) ? "Collapse list" : `Expand list (${d.rsvps.length})`}</button></div>` : ""}
    <div id="rl-${e.id}" style="margin-top:6px" class="${openRsvpLists.has(e.id) ? "" : "hidden"}">${d.rsvps.map(row).join("") || '<span class="sub">No RSVPs yet.</span>'}</div>
  </div>`;
}

async function rsvpAction(b) {
  const card = b.closest(".card");
  const sel = b.closest(".row").querySelector("select");
  const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
  const body = {
    member_id: p.member_id, person_kind: p.kind, person_name: p.name.replace(/ \((student|parent)\)$/, ""),
    status: b.dataset.want,
  };
  // Multi-day: Partial carries the checked days; Going covers every
  // day, so it sends none. Unchecking every day is a mistake, not a
  // valid pick.
  if (b.dataset.want === "partial" && card) {
    const boxes = [...card.querySelectorAll("input.rp-day")];
    if (boxes.length) {
      const days = boxes.filter((x) => x.checked).map((x) => x.dataset.day);
      if (!days.length) return toast("Pick at least one day for Partial.");
      body.days = days;
    }
  }
  try {
    const r = await POST(`/api/events/${b.dataset.rsvp}/rsvps`, body);
    toast(r.status === "waitlisted" ? "Event is full — added to the waitlist." : "RSVP saved.");
    renderEvents();
  } catch (e) { toast("Error: " + e.message); }
}

/* ---------------- tracking ---------------- */
async function renderTracking() {
  const v = $("view-tracking");
  await loadPeople();
  const events = await GET("/api/events");
  if (!events.some((e) => e.id === trackEventId)) trackEventId = events.length ? events[0].id : null;
  const ev = events.find((e) => e.id === trackEventId);
  const evDays = ev ? eventDays(ev) : [];
  if (!evDays.includes(trackDay)) trackDay = evDays.length ? evDays[0] : null;
  const att = ev ? await GET(`/api/events/${ev.id}/rsvps`) : {rsvps: []};
  const checked = ev ? await GET(`/api/events/${ev.id}/checkins${trackDay ? `?day=${trackDay}` : ""}`) : [];
  const byPerson = {};
  checked.forEach((c) => { byPerson[`${c.member_id}:${c.person_kind}`] = c; });
  const hours = await GET("/api/hours");
  const totV = hours.reduce((a, h) => a + (h.verified_hours || 0), 0);
  const totU = hours.reduce((a, h) => a + (h.unverified_hours || 0), 0);
  v.innerHTML = `
  <div class="card"><h2>Tracking</h2>
  <p class="sub">Check in from the RSVP list. Self check-ins stay unverified until a mentor confirms.</p>
  <div class="statgrid">
    <div class="stat"><div class="n">${totV}</div><div class="l">verified hours</div></div>
    <div class="stat"><div class="n">${totU}</div><div class="l">hours awaiting verify</div></div>
    <div class="stat"><div class="n">${checked.length}</div><div class="l">check-ins</div></div>
  </div>
  <div class="row mo" style="margin-top:10px"><a class="btn ghost small" href="/api/hours.csv">Export hours CSV</a></div></div>
  <div class="card"><h3>Attendance</h3>
  <div class="bubbles">${events.map((e) => `<button class="bubble ${e.id === trackEventId ? "active" : ""}" data-tev="${e.id}">${esc(e.title)} (${esc(eventDateLabel(e) || "")})</button>`).join("")}</div>
  ${evDays.length > 1 ? `<div class="bubbles" style="margin-top:8px">${evDays.map((ds) => `<button class="bubble ${ds === trackDay ? "active" : ""}" data-tday="${ds}">${dayLabel(ds)}</button>`).join("")}</div>` : ""}
  <div class="row" style="margin-top:8px"><span class="sub">Session hours:</span>
  <input id="t-hrs" type="number" min="0" step="0.5" value="${ev ? ev.session_hours : 2}" style="width:80px"></div>
  <div id="t-att" style="margin-top:8px">
  ${att.rsvps.filter((r) => (r.status === "going" || r.status === "partial")
    && (!trackDay || r.status === "going" || !r.days || !r.days.length || r.days.includes(trackDay))).map((r) => {
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
  }).join("") || '<span class="sub">No going or partial RSVPs for this event yet.</span>'}
  </div></div>
  <div class="card"><h3>Hours by student</h3>
  ${hours.map((h) => `<details><summary>${esc(h.first_name)} ${esc(h.last_name)} —
    <b>${h.verified_hours}h</b> verified${h.unverified_hours ? `, <span class="pill amber">${h.unverified_hours}h unverified</span>` : ""}</summary>
    <table><tr><th>Event</th><th>Date</th><th>Hours</th><th>Status</th></tr>
    ${h.breakdown.map((b) => `<tr><td>${esc(b.title)}</td><td>${esc(b.day || b.date || "")}</td>
      <td>${b.hours}</td><td>${b.verified ? "verified" : "unverified (" + esc(b.method) + ")"}</td></tr>`).join("")}
    </table></details>`).join("") || '<span class="sub">No hours logged yet.</span>'}
  </div>
`;
  v.querySelectorAll("[data-tev]").forEach((b) => b.addEventListener("click", () => {
    trackEventId = parseInt(b.dataset.tev, 10); savePlace(); renderTracking();
  }));
  v.querySelectorAll("[data-tday]").forEach((b) => b.addEventListener("click", () => {
    trackDay = b.dataset.tday; renderTracking();
  }));
  v.querySelectorAll("[data-ci]").forEach((b) => b.addEventListener("click", async () => {
    const hours = parseFloat($("t-hrs").value) || 0;
    await POST("/api/checkins", {event_id: trackEventId, member_id: parseInt(b.dataset.m, 10),
      person_kind: b.dataset.k || "student", person_name: b.dataset.n,
      method: b.dataset.ci, hours, day: trackDay});
    toast(b.dataset.ci === "self" ? "Self check-in recorded (unverified)." : "Checked in.");
    renderTracking();
  }));
  v.querySelectorAll("[data-verify]").forEach((b) => b.addEventListener("click", async () => {
    await PATCH(`/api/checkins/${b.dataset.verify}`, {verified: true});
    toast("Verified."); renderTracking();
  }));
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
}

/* ---------------- task board (Kanban) ---------------- */
let tasksOnlyMine = false, tasksAssignee = "", tasksSubteam = "", tasksPeriod = "all",
  tasksShowArchived = false;
const chipColor = (name) => {
  const palette = ["#fde8d7", "#dcefe3", "#dde8fb", "#f3e4f7", "#fdf3c4", "#e0f2f1"];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
};
const initials = (name) => String(name).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const duePill = (d) => {
  if (!d) return "";
  const today = new Date().toISOString().slice(0, 10);
  if (d < today) return `<span class="pill red">due ${esc(d)}</span>`;
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  if (d <= week) return `<span class="pill amber">due ${esc(d)}</span>`;
  return `<span class="pill gray">due ${esc(d)}</span>`;
};
const inPeriod = (d) => {
  if (tasksPeriod === "all" || !d) return true;  // undated tasks always show
  const now = new Date();
  if (tasksPeriod === "month") return d.slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const q = Math.floor(now.getMonth() / 3);
  return d.slice(0, 7) >= `${now.getFullYear()}-${String(q * 3 + 1).padStart(2, "0")}`
    && d.slice(0, 7) <= `${now.getFullYear()}-${String(q * 3 + 3).padStart(2, "0")}`;
};

async function renderTasks() {
  const v = $("view-tasks");
  await loadPeople();
  const tasks = await GET("/api/tasks");
  const students = personOptions().filter((p) => p.kind === "student");
  const allAssignees = [...new Set(tasks.flatMap((t) => t.assignees || []))].sort();
  const me = ME ? normName(ME.name) : "";
  const open = tasks.filter((t) => !t.archived);
  const doneCount = open.filter((t) => t.status === "done").length;
  const archCount = tasks.filter((t) => t.archived).length;
  const subProg = {};
  open.forEach((t) => {
    const s = t.subteam || "Unassigned";
    subProg[s] = subProg[s] || {done: 0, total: 0};
    subProg[s].total += 1;
    if (t.status === "done") subProg[s].done += 1;
  });
  const list = tasks.filter((t) => {
    if (!tasksShowArchived && t.archived) return false;
    if (tasksOnlyMine && !(t.assignees || []).some((a) => normName(a) === me)) return false;
    if (tasksAssignee && !(t.assignees || []).includes(tasksAssignee)) return false;
    if (tasksSubteam && t.subteam !== tasksSubteam) return false;
    if (!inPeriod(t.due_date)) return false;
    return true;
  });
  const cols = [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]];
  if (tasksShowArchived) cols.push(["archived", "Archived"]);
  const card = (t, k) => {
    const chips = (t.assignees || []).map((a) =>
      `<span class="pill" style="background:${chipColor(a)}" title="${esc(a)}">${esc(initials(a))} ${esc(a.split(" ")[0])}</span>`).join(" ");
    return `<div class="task"><div class="t">${esc(t.title)}</div>
      <div class="row" style="margin:4px 0;flex-wrap:wrap">${chips || '<span class="pill gray">Unassigned</span>'}</div>
      <div class="m">${esc(t.subteam || "")} ${duePill(t.due_date)}</div>
      ${t.notes ? `<div class="m">${esc(t.notes)}</div>` : ""}
      <div class="row" style="margin-top:4px">
        ${k === "archived" ? ""
          : `${k !== "todo" ? `<button class="btn small ghost" data-tmove="${t.id}" data-to="${k === "doing" ? "todo" : "doing"}">←</button>` : ""}
             ${k !== "done" ? `<button class="btn small ghost" data-tmove="${t.id}" data-to="${k === "todo" ? "doing" : "done"}">→</button>` : ""}`}
        ${MENTOR() ? (k === "archived"
          ? `<button class="btn small" data-trestore="${t.id}">Restore</button>`
          : `<button class="btn small ghost" data-tarch="${t.id}">Archive</button>`) : ""}
        ${MENTOR() ? `<button class="btn small danger" data-tdel="${t.id}">✕</button>` : ""}
      </div></div>`;
  };
  v.innerHTML = `
  <div class="card"><h2>Task Board</h2>
  <p class="sub">Team-wide Kanban. Mentors create tasks and appoint students; anyone moves cards along. Archived tasks stay out of the way until restored.</p>
  <div class="statgrid">
    <div class="stat"><div class="n">${doneCount}/${open.length}</div><div class="l">tasks done</div></div>
    <div class="stat"><div class="n">${archCount}</div><div class="l">archived</div></div>
  </div></div>
  <div class="card mo"><div class="row">
    <input id="tk-title" placeholder="Task title *" style="flex:2;min-width:180px">
    <select id="tk-sub"><option value="">Subteam…</option>
      ${SUBTEAMS.map((s) => `<option>${esc(s.name)}</option>`).join("")}</select>
    <div class="bubbles chipgroup" id="tk-who" title="Tap students to appoint them" style="min-width:160px;max-height:120px;overflow-y:auto">
      ${students.map((p) => chipButton(p.name.replace(/ \((student|parent)\)$/, ""), p.name)).join("")}</div>
    <input id="tk-due" type="date" style="max-width:150px">
    <button class="btn small" id="tk-add">Add task</button>
  </div></div>
  <div class="card"><div class="row" style="flex-wrap:wrap">
    <button class="btn small ${tasksOnlyMine ? "" : "ghost"}" id="tk-mine">Only mine</button>
    <select id="tk-fwho"><option value="">All assignees</option>
      ${allAssignees.map((a) => `<option ${a === tasksAssignee ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
    <select id="tk-fsub"><option value="">All subteams</option>
      ${SUBTEAMS.map((s) => `<option ${s.name === tasksSubteam ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
    <select id="tk-fper">
      <option value="all" ${tasksPeriod === "all" ? "selected" : ""}>All time</option>
      <option value="month" ${tasksPeriod === "month" ? "selected" : ""}>This month</option>
      <option value="quarter" ${tasksPeriod === "quarter" ? "selected" : ""}>This quarter</option>
    </select>
    <button class="btn small ${tasksShowArchived ? "" : "ghost"}" id="tk-arch">${tasksShowArchived ? "Hide archived" : "Show archived"}</button>
  </div></div>
  <div class="cols3" style="margin-top:10px">
  ${cols.map(([k, label]) => `<div class="col"><h4>${label}</h4>
    ${list.filter((t) => k === "archived" ? t.archived : (!t.archived && t.status === k)).map((t) => card(t, k)).join("") || '<span class="sub">Empty.</span>'}
  </div>`).join("")}
  </div>
  <div class="card"><h3>Task completion by subteam</h3>
  ${Object.entries(subProg).map(([s, p]) => `
    <div>${esc(s)} — ${p.done}/${p.total}
    <div class="bar"><div style="width:${p.total ? Math.round(100 * p.done / p.total) : 0}%"></div></div></div>`).join("") || '<span class="sub">No open tasks yet.</span>'}
  </div>`;
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  bindChips(v);
  const _tk = $("tk-add"); if (_tk) _tk.addEventListener("click", async () => {
    const t = $("tk-title").value.trim();
    if (!t) return toast("Task title is required.");
    await POST("/api/tasks", {title: t, subteam: $("tk-sub").value,
      assignees: chipValues("tk-who"),
      due_date: $("tk-due").value});
    toast("Task added."); renderTasks();
  });
  $("tk-mine").addEventListener("click", () => { tasksOnlyMine = !tasksOnlyMine; renderTasks(); });
  $("tk-fwho").addEventListener("change", (e) => { tasksAssignee = e.target.value; renderTasks(); });
  $("tk-fsub").addEventListener("change", (e) => { tasksSubteam = e.target.value; renderTasks(); });
  $("tk-fper").addEventListener("change", (e) => { tasksPeriod = e.target.value; renderTasks(); });
  $("tk-arch").addEventListener("click", () => { tasksShowArchived = !tasksShowArchived; renderTasks(); });
  v.querySelectorAll("[data-tmove]").forEach((b) => b.addEventListener("click", async () => {
    await PATCH(`/api/tasks/${b.dataset.tmove}`, {status: b.dataset.to});
    renderTasks();
  }));
  v.querySelectorAll("[data-tarch]").forEach((b) => b.addEventListener("click", async () => {
    try { await PATCH(`/api/tasks/${b.dataset.tarch}`, {archived: 1}); toast("Archived."); }
    catch (e) { toast("Error: " + e.message); }
    renderTasks();
  }));
  v.querySelectorAll("[data-trestore]").forEach((b) => b.addEventListener("click", async () => {
    try { await PATCH(`/api/tasks/${b.dataset.trestore}`, {archived: 0}); toast("Restored."); }
    catch (e) { toast("Error: " + e.message); }
    renderTasks();
  }));
  v.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this task?")) return;
    await DEL(`/api/tasks/${b.dataset.tdel}`);
    renderTasks();
  }));
}

/* ---------------- travel & logistics ---------------- */
async function renderTravel() {
  const v = $("view-travel");
  await loadPeople();
  const events = await GET("/api/events");
  if (!events.some((e) => e.id === travelEventId)) travelEventId = events.length ? events[0].id : null;
  if (!events.length) {
    $("view-travel").innerHTML =
      '<div class="card"><h2>Travel &amp; Logistics</h2><p class="sub">Create an event first.</p></div>';
    return;
  }
  // Day tables: rides are grouped by trip day, one collapsible
  // section per day, each with a carpool table and a van table.
  // The travel payload is per day, so one fetch per day; tools,
  // hotel, all_carpools, and all_attendees are per-trip and identical
  // in every payload, so the first payload carries them.
  const ev0 = events.find((e) => e.id === travelEventId);
  const evDays = ev0 ? eventDays(ev0) : [];
  const multi = evDays.length > 1;
  const dayPayloads = [];
  if (multi) {
    const parts = await Promise.all(evDays.map((ds) =>
      GET(`/api/events/${travelEventId}/travel?day=${ds}`)));
    parts.forEach((p, i) => dayPayloads.push({day: evDays[i], t: p}));
  } else {
    const p = await GET(`/api/events/${travelEventId}/travel`);
    dayPayloads.push({day: p.day || evDays[0] || null, t: p});
  }
  const t = dayPayloads[0].t;
  const ev = t.event;
  // Day-section open state: Day 1 open, the rest closed; reset when
  // the picked event changes. Toggling a section flips visibility
  // only — it never re-renders, so in-progress forms survive.
  if (openTravelDaysEvent !== travelEventId) {
    openTravelDaysEvent = travelEventId;
    openTravelDays = new Set(multi ? [evDays[0]] : []);
  }
  const dayCars = (ds) => (dayPayloads.find((d) => d.day === ds) || {}).t?.carpools || [];
  const dayVans = (ds) => (dayPayloads.find((d) => d.day === ds) || {}).t?.event_vans || [];
  const allDayCars = dayPayloads.flatMap((d) => d.t.carpools || []);
  const allDayVans = dayPayloads.flatMap((d) => d.t.event_vans || []);
  // Mentor driver pool, per set of days: parent accounts (not
  // disabled) not already driving a carpool or an eligible van on
  // any of those days. Parents never see it — their driver is
  // themselves, auto-filled and grayed out below. allUsers is kept
  // for the van driver dropdowns (a van's driver is a global
  // designation, not per-event).
  let allUsers = [];
  if (MENTOR()) allUsers = await GET("/api/users").catch(() => []);
  const poolForDays = (days) => {
    const taken = new Set();
    days.forEach((ds) => {
      dayCars(ds).forEach((c) => taken.add(c.driver_user_id));
      dayVans(ds).forEach((vv) => taken.add(vv.driver_user_id));
    });
    return allUsers.filter((u) => u.role === "parent" && !u.disabled && !taken.has(u.id));
  };
  const poolOptsFor = (days, keepId) => {
    const opts = poolForDays(days);
    if (keepId && !opts.some((u) => u.id === keepId)) {
      const cur = allUsers.find((u) => u.id === keepId);
      if (cur) opts.unshift(cur);
    }
    return opts.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
  };
  // Days the signed-in parent already drives on (car or van) — used
  // for the Post Ride note, which updates as day boxes change.
  const myDrivingDays = (evDays.length ? evDays : [dayPayloads[0].day]).filter((ds) =>
    dayCars(ds).some((c) => c.driver_user_id === ME.id)
    || dayVans(ds).some((vv) => vv.driver_user_id === ME.id));
  const vanDriverOpts = allUsers.filter((u) => u.role === "parent" && !u.disabled)
    .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
  const vans = await GET("/api/team-vans").catch(() => []);
  const optJSON = (p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`;
  // Seat picker filter, per day: a rider choice excludes everyone
  // driving that day (carpool or van driver — including the driver
  // of the very row being filled) and everyone already holding a
  // CLAIMED seat on any vehicle that day. The row's own waitlist is
  // passed in as well, so a waitlisted rider isn't offered their own
  // ride twice; a person waitlisted elsewhere can still grab an open
  // seat here (they hold no seat yet), and the server skips them on
  // promotion if they have since been seated elsewhere.
  const cleanAttName = (p) => p.name.replace(/ \((student|parent)\)$/, "");
  const claimOptsForDay = (dp, ownRows) => {
    const driverNames = new Set([
      ...dp.t.carpools.map((c) => normName(c.driver_name)),
      ...dp.t.event_vans.map((v) => normName(v.driver_name))]);
    const claimed = new Set();
    const collect = (claims) => (claims || []).forEach((x) => {
      claimed.add(`${x.member_id}:${x.person_kind}`);
      claimed.add(`${normName(x.person_name)}:${x.person_kind}`);
    });
    dp.t.carpools.forEach((c) => collect(c.claims));
    dp.t.event_vans.forEach((v) => collect(v.claims));
    const own = new Set();
    (ownRows || []).forEach((x) => {
      own.add(`${x.member_id}:${x.person_kind}`);
      own.add(`${normName(x.person_name)}:${x.person_kind}`);
    });
    const attPeople = (dp.t.attendees || []).map((a) => ({member_id: a.member_id,
      kind: a.person_kind, name: `${a.person_name} (${a.person_kind})`}));
    return attPeople.filter((p) => {
      const idKey = `${p.member_id}:${p.kind}`;
      const nameKey = `${normName(cleanAttName(p))}:${p.kind}`;
      if (p.kind === "parent" && driverNames.has(normName(cleanAttName(p)))) return false;
      if (claimed.has(idKey) || claimed.has(nameKey)) return false;
      if (own.has(idKey) || own.has(nameKey)) return false;
      return true;
    }).map(optJSON).join("");
  };
  // Ride status per attendee for one day (RSVP going/partial):
  // claimed on a carpool or van, driving, or still needing a ride.
  // Waitlisted counts as needing a ride — no seat yet. The status
  // panes are gone; only the gap (needs a ride) is shown now, under
  // each day's tables.
  const onRide = (claims, a) => (claims || []).some((x) =>
    (x.member_id && x.member_id === a.member_id && x.person_kind === a.person_kind) ||
    (normName(x.person_name) === normName(a.person_name) && x.person_kind === a.person_kind));
  const rideStatusFor = (dp, a) => {
    for (const c of dp.t.carpools || [])
      if (onRide(c.claims, a)) return `ride on ${c.driver_name}'s car`;
    for (const vv of dp.t.event_vans || [])
      if (onRide(vv.claims, a)) return `ride in team van ${vv.name}`;
    if ((dp.t.carpools || []).some((c) => normName(c.driver_name) === normName(a.person_name))) return "driving";
    if ((dp.t.event_vans || []).some((vv) => normName(vv.driver_name) === normName(a.person_name))) return "driving";
    return "needs ride";
  };
  const needsRideFor = (dp) => (dp.t.attendees || []).filter((a) => rideStatusFor(dp, a) === "needs ride");
  // Hotel rooms are per-trip, not per-day: the hotel section (place
  // dropdown, room-parent volunteers, room status gaps) uses everyone
  // attending the trip, not just one day's riders.
  const allAtt = t.all_attendees || t.attendees || [];
  const allAttStudents = allAtt.filter((a) => a.person_kind === "student");
  const allStudents = allAttStudents.map((a) =>
    `<option value="${a.member_id}">${esc(a.person_name)}</option>`).join("");
  const allStudentNames = allAttStudents.map((a) =>
    chipButton(a.person_name, a.person_name)).join("");
  const allAttParents = allAtt.filter((a) => a.person_kind === "parent").map((a) =>
    ({member_id: a.member_id, kind: "parent", name: `${a.person_name} (parent)`})).map(optJSON).join("");
  // Mentor vehicle dropdown for a tool row: event carpools + team
  // vans, with the row's current vehicle preselected. Tools are
  // per-trip, so the dropdown uses every car in the trip
  // (all_carpools), not just the ones running on one day.
  const allCars = t.all_carpools || allDayCars;
  const vehOptsFor = (x) => {
    const cur = x.vehicle_type ? `${x.vehicle_type}:${x.vehicle_id}` : "";
    const opts = [
      ...allCars.map((c) => ({v: `carpool:${c.id}`, l: `${c.driver_name}'s car`})),
      ...vans.map((vv) => ({v: `van:${vv.id}`, l: `\u{1F69A} Team van: ${vv.name}`}))];
    return opts.map((o) => `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${esc(o.l)}</option>`).join("");
  };
  // One table row per car. Driver cell carries everything a rider
  // needs at a glance: driver, vehicle (visible make/model/color,
  // plate only as a hover tooltip), departure, return, notes.
  const carRow = (dp, c) => {
    const dayKey = dp.day || "all";
    const riders = c.claims.map((x) =>
      `<span class="pill">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="release">✕</a></span>`).join("")
      || '<span class="sub">none yet</span>';
    const wait = c.waitlist.length ? `<div style="margin-top:4px">Waitlist: ${c.waitlist.map((x) =>
      `<span class="pill amber">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="remove">✕</a></span>`).join("")}</div>` : "";
    const cpsOpts = claimOptsForDay(dp, [...c.claims, ...c.waitlist]);
    const claimCell = cpsOpts
      ? `<div class="row"><select id="cps-${c.id}-${dayKey}">${cpsOpts}</select>
        <button class="btn small" data-claim="${c.id}" data-claimday="${dp.day || ""}">Claim seat</button></div>`
      : `<span class="sub">Everyone attending is already driving or seated on another ride.</span>`;
    const editCell = (MENTOR() || c.driver_user_id === ME.id)
      ? `<div class="row" style="margin-top:4px"><button class="btn small ghost" data-cpedit="${c.id}" data-cpday="${dp.day || ""}">Edit</button><button class="btn small ghost" data-cpdel="${c.id}" data-cpday="${dp.day || ""}">Remove</button></div>` : "";
    return `<tr id="cp-row-${c.id}-${dayKey}"><td><b>${esc(c.driver_name)}</b>${vehicleLine(c.vehicle)}
      <div class="sub">${esc(c.depart_from || "")} · ${esc(c.depart_time || "")} · Return: ${esc(c.return_info || "—")}</div>
      ${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ""}
      ${multi ? `<div class="sub">Runs: ${(c.days && c.days.length ? c.days.map(dayLabel).join(", ") : "every day")}</div>` : ""}</td>
      <td>${riders}${wait}</td>
      <td><span class="pill ${c.seats_open ? "green" : "red"}">${c.seats_open} of ${c.seats} open</span></td>
      <td>${claimCell}${editCell}</td></tr>`;
  };
  const vanRow = (dp, vv) => {
    const dayKey = dp.day || "all";
    const riders = vv.claims.map((x) =>
      `<span class="pill">${esc(x.person_name)} <a href="#" data-vunclaim="${x.id}" title="release">✕</a></span>`).join("")
      || '<span class="sub">none yet</span>';
    const wait = vv.waitlist.length ? `<div style="margin-top:4px">Waitlist: ${vv.waitlist.map((x) =>
      `<span class="pill amber">${esc(x.person_name)} <a href="#" data-vunclaim="${x.id}" title="remove">✕</a></span>`).join("")}</div>` : "";
    const vpsOpts = claimOptsForDay(dp, [...vv.claims, ...vv.waitlist]);
    const claimCell = vpsOpts
      ? `<div class="row"><select id="vps-${vv.id}-${dayKey}">${vpsOpts}</select>
        <button class="btn small" data-vclaim="${vv.id}" data-vday="${dp.day || ""}">Claim seat</button></div>`
      : `<span class="sub">Everyone attending is already driving or seated on another ride.</span>`;
    const dayDriverCell = (MENTOR() && multi) ? (() => {
      const designated = allUsers.find((u) => u.id === vv.designated_driver_user_id);
      const opts = allUsers.filter((u) => u.role === "parent" && !u.disabled)
        .map((u) => `<option value="${u.id}"${vv.day_driver_override && u.id === vv.driver_user_id ? " selected" : ""}>${esc(u.name)}</option>`).join("");
      return `<div class="row" style="margin-top:4px"><span class="sub">Driver for ${dayLabel(dp.day)}:</span>
        <select id="vd-${vv.id}-${dayKey}"><option value=""${!vv.day_driver_override ? " selected" : ""}>Designated: ${esc(designated ? designated.name : "none")}</option>${opts}</select>
        <button class="btn small" data-vdaydriver="${vv.id}" data-vday="${dp.day || ""}">Set day driver</button></div>`;
    })() : "";
    return `<tr id="vr-row-${vv.id}-${dayKey}"><td><b>\u{1F69A} Team van ${esc(vv.name)}</b>
      <div class="sub">driven by ${esc(vv.driver_name)}${vv.day_driver_override ? " (day driver)" : ""}</div></td>
      <td>${riders}${wait}</td>
      <td><span class="pill ${vv.seats_open ? "green" : "red"}">${vv.seats_open} of ${vv.seats} open</span></td>
      <td>${claimCell}${dayDriverCell}</td></tr>`;
  };
  const ridesTables = (dp) => {
    const needs = needsRideFor(dp);
    const needsLine = (dp.t.attendees || []).length
      ? (needs.length
        ? `<p class="sub">Needs a ride: ${needs.map((a) => esc(a.person_name)).join(", ")}</p>`
        : `<p class="sub">Everyone has a ride for this day.</p>`)
      : `<p class="sub">Nobody RSVP'd yet.</p>`;
    return `
    <h4>Carpools</h4>
    ${dp.t.carpools.length
      ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Car / Driver</th><th>Riders</th><th>Seats</th><th>Actions</th></tr></thead><tbody>${dp.t.carpools.map((c) => carRow(dp, c)).join("")}</tbody></table></div>`
      : '<p class="sub">No carpools posted for this day yet.</p>'}
    <h4>Team van rides</h4>
    <p class="sub">A van takes riders only with seats set and a driver attending that day who isn't driving a carpool that day.</p>
    ${dp.t.event_vans.length
      ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Van / Driver</th><th>Riders</th><th>Seats</th><th>Actions</th></tr></thead><tbody>${dp.t.event_vans.map((vv) => vanRow(dp, vv)).join("")}</tbody></table></div>`
      : '<p class="sub">No team vans going to this day yet — designate a driver who RSVP\'d going, and set the van\'s seats.</p>'}
    ${needsLine}`;
  };
  // Per-day room place options: students attending that day who
  // don't already hold a room that day (any room). The rooms table
  // for a day lists only the rooms allocated for it, with that
  // day's occupants and per-day capacity.
  const placeOptsForDay = (dp) => {
    const placed = placedIdsForDay(t.hotel, dp.day);
    return (dp.t.attendees || []).filter((a) => a.person_kind === "student" && !placed.has(a.member_id))
      .map((a) => `<option value="${a.member_id}">${esc(a.person_name)}</option>`).join("");
  };
  const roomsDaySection = (dp) => `
    <h4>Rooms</h4>
    ${roomsTableHTML(t.hotel, dp.day, placeOptsForDay(dp), allAttParents, {editableNumber: false, showEdit: true})}
    ${roomGapHTML(t.hotel, dp.t.attendees, dp.day)}`;
  const daySection = (dp, idx) => `
  <div class="card"><h3><button class="btn small ghost" data-tdaysec="${dp.day}">${openTravelDays.has(dp.day) ? "▾" : "▸"}</button> Day ${idx + 1} · ${dayLabel(dp.day)}</h3>
  <div id="tday-body-${dp.day}" class="${openTravelDays.has(dp.day) ? "" : "hidden"}">${ridesTables(dp)}${t.hotel ? roomsDaySection(dp) : ""}</div></div>`;
  // Post Ride lives in its own card now (trip-level, not per-day):
  // the days the car runs are picked with checkboxes, and the driver
  // pool + the already-driving note refresh as those boxes change,
  // so a parent driving Day 1 only can still post a Day-3-only ride.
  const postRideCard = (ME.role === "student" ? "" : `
  <div class="card"><h3>Post a ride</h3>
  <p class="sub" id="cp-driving-note"></p>
  <div id="cp-form-wrap">
  ${multi ? `<div class="row" style="margin-bottom:8px"><span class="sub">Days this car runs:</span>
    ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="cp-day" data-day="${ds}" checked> ${dayLabel(ds)}</label>`).join("")}
    <span class="sub">(all checked = every day)</span></div>` : ""}
  <div class="grid3">
    ${MENTOR()
      ? `<div class="field"><label>Driver name *</label><select id="cp-driver-sel"></select></div>`
      : `<div class="field"><label>Driver name</label><input id="cp-driver" disabled value="${esc(ME.name)}"><span class="hint">You, auto-filled</span></div>`}
    <div class="field"><label>Seats *</label><input id="cp-seats" inputmode="numeric" placeholder="4"></div>
    <div class="field"><label>Departure point</label><input id="cp-from" placeholder="School lot"></div>
    <div class="field"><label>Departure time</label><input id="cp-dt" placeholder="Thu 3:30 PM"></div>
    <div class="field"><label>Return plan</label><input id="cp-ret" placeholder="Sun after finals"></div>
    <div class="field"><label>Notes</label><input id="cp-notes"></div>
    <div class="field"><label>License plate <span class="hint">(optional)</span></label><input id="cp-vplate"></div>
    <div class="field"><label>Color <span class="hint">(optional)</span></label><input id="cp-vcolor"></div>
    <div class="field"><label>Make <span class="hint">(optional)</span></label><input id="cp-vmake" placeholder="Honda"></div>
    <div class="field"><label>Model <span class="hint">(optional)</span></label><input id="cp-vmodel" placeholder="Odyssey"></div>
  </div>
  <p class="sub hidden" id="cp-nopool">No parents available to assign — every parent account is already driving a car or a van on the picked days, or no parent accounts exist yet.</p>
  <button class="btn small" id="cp-add">Post ride</button></div></div>`);
  v.innerHTML = `
  <div class="card"><h2>Travel &amp; Logistics</h2>
  <p class="sub">${multi ? "Each trip day expands to its own rides and rooms tables. Tools are for the whole trip." : "Carpools, tool sign-up, and hotel assignments — organized per event."}</p>
  <div class="bubbles">${events.map((e) => `<button class="bubble ${e.id === travelEventId ? "active" : ""}" data-ev="${e.id}">${esc(e.title)}</button>`).join("")}</div>
  ${multi ? `<div class="row" style="margin-top:8px"><button class="btn small ghost" id="td-expand-all">Expand all days</button><button class="btn small ghost" id="td-collapse-all">Collapse all days</button></div>` : ""}</div>

  ${postRideCard}

  ${multi
    ? dayPayloads.map((dp, i) => daySection(dp, i)).join("")
    : `<div class="card"><h3>Carpools</h3>${ridesTables(dayPayloads[0])}</div>`}

  <div class="card"><h3>Team vans</h3>
  <p class="sub">Team-owned vans can haul tools too, alongside parent drivers. A van takes student riders only with a designated parent driver and seats set — the driver must RSVP going for each event the van serves.</p>
  <div class="row mo">
    <input id="tv-name" placeholder="Van name *" style="flex:1;min-width:160px">
    <input id="tv-notes" placeholder="Notes (keys…)" style="flex:1;min-width:120px">
    <select id="tv-driver" style="flex:1;min-width:160px"><option value="">Driver: none yet</option>${vanDriverOpts}</select>
    <input id="tv-seats" placeholder="Seats" inputmode="numeric" style="max-width:70px">
    <button class="btn small" id="tv-add">Add van</button>
  </div>
  <div style="margin-top:8px">
  ${vans.map((vn) => {
    const dn = (allUsers.find((u) => u.id === vn.driver_user_id) || {}).name
      || (allDayVans.find((vv) => vv.id === vn.id) || {}).driver_name || "";
    return `<div class="row" id="tv-row-${vn.id}" style="margin:6px 0"><span><b>${esc(vn.name)}</b>${vn.notes ? ` <span class="sub">${esc(vn.notes)}</span>` : ""}${dn ? ` <span class="sub">driven by ${esc(dn)}</span>` : ""}${vn.seats ? ` <span class="pill">${vn.seats} seats</span>` : ` <span class="sub">tools-only</span>`}</span>
    ${MENTOR() ? `<button class="btn small ghost" data-tvedit="${vn.id}">Edit</button><button class="btn small ghost" data-tvdel="${vn.id}">Delete</button>` : ""}</div>`;
  }).join("") || '<p class="sub">No team vans yet.</p>'}
  </div></div>

  <div class="card"><h3>Tool sign-up</h3>
  <p class="sub">Mentors list what the event needs; tools ride in event carpools and team vans. Every tool starts unassigned until a mentor or its vehicle's driver confirms it.</p>
  <div class="row mo">
    <input id="tl-name" placeholder="Tool or gear needed *" style="flex:2;min-width:160px">
    <input id="tl-qty" placeholder="Qty" inputmode="numeric" style="max-width:70px">
    <input id="tl-notes" placeholder="Notes" style="flex:1;min-width:120px">
    <button class="btn small" id="tl-add">Add</button>
  </div>
  <div class="row mo" style="margin-top:6px">
    <a class="btn small ghost" href="/api/events/${travelEventId}/tools.csv">Export CSV</a>
    <input type="file" id="tl-import-file" accept=".csv" style="max-width:220px">
    <button class="btn small ghost" id="tl-import">Import CSV</button>
  </div>
  <div class="row" style="margin-top:6px">
    <button class="btn small ghost" id="tl-expand-all">Expand all</button>
    <button class="btn small ghost" id="tl-collapse-all">Collapse all</button>
    <span class="sub">${t.tools.length} tool(s)</span>
  </div>
  <div id="tl-list" class="${toolsListCollapsed ? "hidden" : ""}">
  ${t.tools.length ? `<div style="overflow-x:auto"><table class="acct" style="margin-top:8px"><thead><tr><th>Tool</th><th>Amount</th><th>Vehicle</th><th>Actions</th></tr></thead>
  <tbody>${t.tools.map((x) => {
    // Assignment status, at a glance: red when the tool is still in
    // the pool (no vehicle), green once it rides in a car or van. A
    // vehicle id pointing at a deleted vehicle counts as unassigned.
    let veh = '<span class="pill red">Unassigned</span>';
    if (x.vehicle_type === "carpool") {
      const c = allCars.find((c) => c.id === x.vehicle_id);
      veh = c ? `<span class="pill green">${esc(c.driver_name)}'s car</span>${vehicleLine(c.vehicle)}` : '<span class="pill red">Unassigned</span>';
    } else if (x.vehicle_type === "van") {
      const vv = vans.find((vv) => vv.id === x.vehicle_id);
      veh = vv ? `<span class="pill green">\u{1F69A} Team van ${esc(vv.name)}</span>` : '<span class="pill red">Unassigned</span>';
    }
    // Actions: mentors assign anywhere + manage the pool; parents
    // only their own vehicles (assign unassigned, release their own);
    // students read-only.
    let acts = "";
    const ownVehicles = [
      ...allCars.filter((c) => c.driver_user_id === ME.id)
        .map((c) => ({type: "carpool", id: c.id, label: `${c.driver_name}'s car`})),
      ...vans.filter((vv) => vv.driver_user_id === ME.id)
        .map((vv) => ({type: "van", id: vv.id, label: `Team van ${vv.name}`}))];
    const ownsThis = !!x.vehicle_type && ownVehicles.some((o) => o.type === x.vehicle_type && o.id === x.vehicle_id);
    if (MENTOR()) {
      const opts = vehOptsFor(x);
      acts += opts
        ? `<select id="tls-${x.id}">${opts}</select><button class="btn small" data-tassign="${x.id}">${x.vehicle_type ? "Move" : "Assign"}</button>`
        : `<span class="sub">No haulers yet — post a carpool ride above or add a team van above.</span>`;
      if (x.vehicle_type) acts += ` <button class="btn small ghost" data-trelease="${x.id}">Release</button>`;
      acts += ` <button class="btn small ghost" data-tedit="${x.id}">Edit</button><button class="btn small ghost" data-tdel="${x.id}">Delete</button>`;
    } else if (ME.role === "parent") {
      if (!x.vehicle_type && ownVehicles.length === 1) {
        const o = ownVehicles[0];
        acts += `<button class="btn small" data-tassign-own="${x.id}" data-tvt="${o.type}" data-tvid="${o.id}">Load in my ${o.type === "van" ? "van" : "car"}</button>`;
      } else if (!x.vehicle_type && ownVehicles.length > 1) {
        acts += `<select id="tls-${x.id}">${ownVehicles.map((o) => `<option value="${o.type}:${o.id}">${esc(o.label)}</option>`).join("")}</select><button class="btn small" data-tassign="${x.id}">Assign</button>`;
      } else if (ownsThis) {
        acts += `<button class="btn small ghost" data-trelease="${x.id}">Release</button>`;
      }
    }
    return `<tr id="tl-row-${x.id}"><td><b>${esc(x.name)}</b>${x.notes ? `<div class="sub">${esc(x.notes)}</div>` : ""}</td><td>\u00d7${x.qty}</td><td>${veh}</td><td>${acts || '<span class="sub">—</span>'}</td></tr>`;
  }).join("")}</tbody></table></div>` : '<p class="sub">Nothing listed yet.</p>'}
  </div>
  <p id="tl-collapsed-note" class="sub ${toolsListCollapsed && t.tools.length ? "" : "hidden"}" style="margin-top:8px">Tool list collapsed — ${t.tools.length} tool(s) hidden.</p>
  </div>

  ${(t.hotel || multi) ? `<div class="card"><h3>Hotel assignments</h3>
  ${t.hotel ? (multi
    ? hotelTopHTML(t.hotel, {evDays, parentOpts: allAttParents, rqWhoOpts: allStudents, studentNames: allStudentNames, attStudents: allAttStudents})
    : hotelHTML(t.hotel, {day: dayPayloads[0].day, dayAttendees: dayPayloads[0].t.attendees, placeOpts: placeOptsForDay(dayPayloads[0]), parentOpts: allAttParents, rqWhoOpts: allStudents, studentNames: allStudentNames, attStudents: allAttStudents})) : `
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
  </div>` : ""}`;
  v.querySelectorAll("[data-ev]").forEach((b) => b.addEventListener("click", () => {
    travelEventId = parseInt(b.dataset.ev, 10); savePlace(); pendingBeds = []; renderTravel();
  }));
  // Day-section toggles: flip visibility only, never re-render.
  const setDaySection = (ds, open) => {
    if (open) openTravelDays.add(ds); else openTravelDays.delete(ds);
    const body = $("tday-body-" + ds);
    if (body) body.classList.toggle("hidden", !open);
    const btn = v.querySelector(`[data-tdaysec="${ds}"]`);
    if (btn) btn.textContent = open ? "▾" : "▸";
  };
  v.querySelectorAll("[data-tdaysec]").forEach((b) => b.addEventListener("click", () => {
    setDaySection(b.dataset.tdaysec, !openTravelDays.has(b.dataset.tdaysec));
  }));
  const _tde = $("td-expand-all");
  if (_tde) _tde.addEventListener("click", () => evDays.forEach((ds) => setDaySection(ds, true)));
  const _tdc = $("td-collapse-all");
  if (_tdc) _tdc.addEventListener("click", () => evDays.forEach((ds) => setDaySection(ds, false)));
  const hb = $("h-add");
  if (hb) hb.addEventListener("click", async () => {
    if (!$("h-name").value.trim()) return toast("Hotel name is required.");
    await POST("/api/hotels", {event_id: travelEventId, name: $("h-name").value.trim(),
      address: $("h-addr").value.trim(), check_in: $("h-in").value,
      check_out: $("h-out").value, notes: $("h-notes").value.trim()});
    toast("Hotel block saved."); renderTravel();
  });
  // Post Ride state: the driver pool (mentors) and the already-driving
  // note (parents) follow the checked days, so a Day-1 driver can
  // still post for Day 3 by unchecking Day 1.
  const refreshPostRide = () => {
    const dayBoxes = [...document.querySelectorAll("input.cp-day")];
    const days = dayBoxes.length
      ? dayBoxes.filter((x) => x.checked).map((x) => x.dataset.day)
      : (evDays.length ? evDays : [dayPayloads[0].day]);
    if (MENTOR()) {
      const sel = $("cp-driver-sel");
      if (sel) {
        const keep = sel.value ? +sel.value : null;
        sel.innerHTML = poolOptsFor(days, keep) || '<option value="">No available parents</option>';
        if (keep && [...sel.options].some((o) => +o.value === keep)) sel.value = String(keep);
        const nopool = $("cp-nopool");
        if (nopool) nopool.classList.toggle("hidden", !!poolForDays(days).length);
      }
    } else if (ME.role === "parent") {
      const mine = myDrivingDays.filter((ds) => days.includes(ds));
      const note = $("cp-driving-note"), wrap = $("cp-form-wrap");
      if (!days.length) {
        if (note) note.textContent = "Pick at least one day for the ride.";
        if (wrap) wrap.classList.add("hidden");
      } else if (mine.length === days.length) {
        if (note) note.textContent = `You're already driving for ${days.length > 1 ? "these days" : "this day"}${mine.length ? ` (${mine.map(dayLabel).join(", ")})` : ""} — so you can't post another ride for them.`;
        if (wrap) wrap.classList.add("hidden");
      } else {
        if (note) note.textContent = mine.length
          ? `You're already driving on ${mine.map(dayLabel).join(", ")} — posting with ${mine.length > 1 ? "those days" : "that day"} checked will fail; uncheck ${mine.length > 1 ? "them" : "it"} to post for the other days.`
          : "";
        if (wrap) wrap.classList.remove("hidden");
      }
    }
  };
  document.querySelectorAll("input.cp-day").forEach((box) =>
    box.addEventListener("change", refreshPostRide));
  refreshPostRide();
  const cpAdd = $("cp-add");
  if (cpAdd) cpAdd.addEventListener("click", async () => {
    const seats = parseInt($("cp-seats").value, 10);
    if (!seats || seats < 1) return toast("Seats are required.");
    const body = {event_id: travelEventId, seats,
      depart_from: $("cp-from").value.trim(), depart_time: $("cp-dt").value.trim(),
      return_info: $("cp-ret").value.trim(), notes: $("cp-notes").value.trim(),
      vehicle: {plate: $("cp-vplate").value.trim(), color: $("cp-vcolor").value.trim(),
        make: $("cp-vmake").value.trim(), model: $("cp-vmodel").value.trim()}};
    // Parents post as themselves (the server fills the driver from
    // the session); mentors pick a parent from the free pool.
    if (MENTOR()) {
      const duid = $("cp-driver-sel") ? $("cp-driver-sel").value : "";
      if (!duid) return toast("Pick a driver from the parent pool.");
      body.driver_user_id = +duid;
    }
    // Multi-day: the checked days are the days this car runs; all
    // checked (the default) means every day.
    const dayBoxes = [...document.querySelectorAll("input.cp-day")];
    if (dayBoxes.length) {
      const days = dayBoxes.filter((x) => x.checked).map((x) => x.dataset.day);
      if (!days.length) return toast("Pick at least one day for the ride.");
      body.days = days;
    }
    try {
      await POST("/api/carpools", body);
      toast("Ride posted."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  // Edit / remove a car: the driver-owner or a mentor. Edit inserts a
  // pre-filled form row under that day's table row (driver grayed out
  // for a parent owner, pool dropdown for a mentor, current driver
  // kept selectable); the pool follows the form's day boxes, like
  // Post Ride above.
  v.querySelectorAll("[data-cpedit]").forEach((b) => b.addEventListener("click", () => {
    const day = b.dataset.cpday || "";
    const c = allDayCars.find((x) => x.id === +b.dataset.cpedit);
    if (!c) return;
    const row = $("cp-row-" + c.id + "-" + (day ? dayPayloads.find((d) => d.day === day)?.day || "all" : "all"))
      || document.querySelector(`[id^="cp-row-${c.id}-"]`);
    if (!row) return;
    const prev = $("cp-edit-" + c.id);
    if (prev) prev.remove();
    const veh = c.vehicle || {};
    const tr = document.createElement("tr");
    tr.id = "cp-edit-" + c.id;
    const driverField = () => MENTOR()
      ? `<div class="field"><label>Driver name *</label><select id="ep-driver-${c.id}"></select></div>`
      : `<div class="field"><label>Driver name</label><input id="ep-driver-${c.id}" disabled value="${esc(c.driver_name)}"></div>`;
    tr.innerHTML = `<td colspan="4"><div class="grid3">
      ${driverField()}
      <div class="field"><label>Seats *</label><input id="ep-seats-${c.id}" inputmode="numeric" value="${c.seats}"></div>
      <div class="field"><label>Departure point</label><input id="ep-from-${c.id}" value="${esc(c.depart_from || "")}"></div>
      <div class="field"><label>Departure time</label><input id="ep-dt-${c.id}" value="${esc(c.depart_time || "")}"></div>
      <div class="field"><label>Return plan</label><input id="ep-ret-${c.id}" value="${esc(c.return_info || "")}"></div>
      <div class="field"><label>Notes</label><input id="ep-notes-${c.id}" value="${esc(c.notes || "")}"></div>
      <div class="field"><label>License plate</label><input id="ep-vplate-${c.id}" value="${esc(veh.plate || "")}"></div>
      <div class="field"><label>Color</label><input id="ep-vcolor-${c.id}" value="${esc(veh.color || "")}"></div>
      <div class="field"><label>Make</label><input id="ep-vmake-${c.id}" value="${esc(veh.make || "")}"></div>
      <div class="field"><label>Model</label><input id="ep-vmodel-${c.id}" value="${esc(veh.model || "")}"></div>
    </div>
    ${multi ? `<div class="row" style="margin-top:6px"><span class="sub">Days this car runs:</span>
      ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="ep-day" data-day="${ds}"${!c.days || !c.days.length || c.days.includes(ds) ? " checked" : ""}> ${dayLabel(ds)}</label>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:6px"><button class="btn small" id="ep-save-${c.id}">Save</button><button class="btn small ghost" id="ep-cancel-${c.id}">Cancel</button></div></td>`;
    row.after(tr);
    const refreshEditPool = () => {
      if (!MENTOR()) return;
      const sel = $("ep-driver-" + c.id);
      if (!sel) return;
      const boxes = [...tr.querySelectorAll("input.ep-day")];
      const days = boxes.length ? boxes.filter((x) => x.checked).map((x) => x.dataset.day) : evDays;
      const keep = sel.value ? +sel.value : c.driver_user_id;
      sel.innerHTML = poolOptsFor(days, c.driver_user_id);
      if ([...sel.options].some((o) => +o.value === keep)) sel.value = String(keep);
    };
    refreshEditPool();
    tr.querySelectorAll("input.ep-day").forEach((box) =>
      box.addEventListener("change", refreshEditPool));
    $("ep-cancel-" + c.id).addEventListener("click", () => tr.remove());
    $("ep-save-" + c.id).addEventListener("click", async () => {
      const seats = parseInt($("ep-seats-" + c.id).value, 10);
      if (!seats || seats < 1) return toast("Seats are required.");
      const body = {seats,
        depart_from: $("ep-from-" + c.id).value.trim(), depart_time: $("ep-dt-" + c.id).value.trim(),
        return_info: $("ep-ret-" + c.id).value.trim(), notes: $("ep-notes-" + c.id).value.trim(),
        vehicle: {plate: $("ep-vplate-" + c.id).value.trim(), color: $("ep-vcolor-" + c.id).value.trim(),
          make: $("ep-vmake-" + c.id).value.trim(), model: $("ep-vmodel-" + c.id).value.trim()}};
      if (MENTOR()) {
        const duid = $("ep-driver-" + c.id).value;
        if (duid) body.driver_user_id = +duid;
      }
      const epBoxes = [...tr.querySelectorAll("input.ep-day")];
      if (epBoxes.length) {
        const days = epBoxes.filter((x) => x.checked).map((x) => x.dataset.day);
        if (!days.length) return toast("Pick at least one day for the ride.");
        body.days = days;
      }
      try {
        await PATCH(`/api/carpools/${c.id}`, body);
        toast("Ride updated."); renderTravel();
      } catch (e) { toast("Error: " + e.message); }
    });
  }));
  v.querySelectorAll("[data-cpdel]").forEach((b) => b.addEventListener("click", async () => {
    const c = allDayCars.find((x) => x.id === +b.dataset.cpdel);
    if (!c) return;
    const riders = (c.claims || []).length + (c.waitlist || []).length;
    if (!confirm(`Remove this car from the pool?${riders ? ` ${riders} rider(s) will be released.` : ""}`)) return;
    try {
      const r = await DEL(`/api/carpools/${c.id}`);
      toast(r.tools_unassigned ? `Car removed from the pool; ${r.tools_unassigned} tool(s) back in the pool.` : "Car removed from the pool."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const day = b.dataset.claimday || null;
    const sel = $("cps-" + b.dataset.claim + "-" + (day || "all"));
    if (!sel) return;
    const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
    try {
      const r = await POST(`/api/carpools/${b.dataset.claim}/claims`, {
        member_id: p.member_id, person_kind: p.kind, day,
        person_name: p.name.replace(/ \((student|parent)\)$/, "")});
      toast(r.status === "waitlisted" ? "Car is full — added to the waitlist." : "Seat claimed.");
      renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-unclaim]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await DEL(`/api/carpool_claims/${a.dataset.unclaim}`);
    toast(r.promoted ? `${r.promoted.person_name} promoted from the waitlist.` : "Released.");
    renderTravel();
  }));
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  // Tool list collapse, mirroring the Events RSVP lists: the state
  // lives in toolsListCollapsed so it survives renderTravel (e.g.
  // after adding a tool), and the toggle only flips visibility —
  // it never re-renders, so an in-progress edit or import file
  // selection is not lost.
  const setToolsList = (open) => {
    toolsListCollapsed = !open;
    const list = $("tl-list"), note = $("tl-collapsed-note");
    if (list) list.classList.toggle("hidden", !open);
    if (note) note.classList.toggle("hidden", open);
  };
  const _tle = $("tl-expand-all");
  if (_tle) _tle.addEventListener("click", () => setToolsList(true));
  const _tlc = $("tl-collapse-all");
  if (_tlc) _tlc.addEventListener("click", () => setToolsList(false));
  const _tl = $("tl-add"); if (_tl) _tl.addEventListener("click", async () => {
    if (!$("tl-name").value.trim()) return toast("Tool name is required.");
    await POST("/api/tools", {event_id: travelEventId, name: $("tl-name").value.trim(),
      qty: parseInt($("tl-qty").value, 10) || 1, notes: $("tl-notes").value.trim()});
    toast("Tool added."); renderTravel();
  });
  // Tool assignments: mentors pick any vehicle, parents only their
  // own. The server enforces ownership; the buttons just don't offer
  // what the caller can't do.
  const parseVeh = (s) => {
    const [type, id] = (s || "").split(":");
    return {vehicle_type: type, vehicle_id: +id};
  };
  v.querySelectorAll("[data-tassign]").forEach((b) => b.addEventListener("click", async () => {
    const sel = $("tls-" + b.dataset.tassign);
    if (!sel || !sel.value) return toast("Pick a vehicle.");
    try {
      await POST(`/api/tools/${b.dataset.tassign}/assign`, parseVeh(sel.value));
      toast("Tool assigned."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-tassign-own]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await POST(`/api/tools/${b.dataset.tassignOwn}/assign`,
        {vehicle_type: b.dataset.tvt, vehicle_id: +b.dataset.tvid});
      toast("Tool assigned."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-trelease]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await POST(`/api/tools/${b.dataset.trelease}/release`);
      toast("Tool back in the pool."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-tedit]").forEach((b) => b.addEventListener("click", () => {
    const x = (t.tools || []).find((y) => y.id === +b.dataset.tedit);
    if (!x) return;
    const row = $("tl-row-" + x.id);
    row.innerHTML = `<td><input id="te-name-${x.id}" value="${esc(x.name)}"></td>
      <td><input id="te-qty-${x.id}" inputmode="numeric" value="${x.qty}" style="max-width:60px"></td>
      <td><input id="te-notes-${x.id}" value="${esc(x.notes || "")}"></td>
      <td><button class="btn small" id="te-save-${x.id}">Save</button><button class="btn small ghost" id="te-cancel-${x.id}">Cancel</button></td>`;
    $("te-cancel-" + x.id).addEventListener("click", () => renderTravel());
    $("te-save-" + x.id).addEventListener("click", async () => {
      const qty = parseInt($("te-qty-" + x.id).value, 10);
      if (!$("te-name-" + x.id).value.trim() || !qty || qty < 1) return toast("Name and qty (1+) are required.");
      try {
        await PATCH(`/api/tools/${x.id}`, {name: $("te-name-" + x.id).value.trim(), qty, notes: $("te-notes-" + x.id).value.trim()});
        toast("Tool updated."); renderTravel();
      } catch (e) { toast("Error: " + e.message); }
    });
  }));
  v.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this tool from the pool?")) return;
    try {
      await DEL(`/api/tools/${b.dataset.tdel}`);
      toast("Tool deleted."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  const tlImport = $("tl-import");
  if (tlImport) tlImport.addEventListener("click", async () => {
    const file = $("tl-import-file").files[0];
    if (!file) return toast("Choose a CSV file first.");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/events/${travelEventId}/tools/import`, {method: "POST", body: fd, credentials: "same-origin"});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "import failed");
      let msg = `Tools imported: ${data.added} added, ${data.updated} updated.`;
      if (data.skipped.length) msg += ` Skipped: ${data.skipped.slice(0, 3).join("; ")}${data.skipped.length > 3 ? ` (+${data.skipped.length - 3} more)` : ""}`;
      if (data.vehicles_unmatched.length) msg += ` Vehicles not found (left unassigned): ${data.vehicles_unmatched.slice(0, 3).join(", ")}`;
      toast(msg); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  // Team van rides: claim a seat / release, mirroring carpool seats.
  // Each row is day-scoped: the claim and the day driver carry the
  // row's day, since a van's riders and driver differ per day.
  v.querySelectorAll("[data-vclaim]").forEach((b) => b.addEventListener("click", async () => {
    const day = b.dataset.vday || null;
    const sel = $("vps-" + b.dataset.vclaim + "-" + (day || "all"));
    if (!sel) return;
    const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
    try {
      const r = await POST(`/api/vans/${b.dataset.vclaim}/claims`, {
        event_id: travelEventId, member_id: p.member_id, person_kind: p.kind,
        day,
        person_name: p.name.replace(/ \((student|parent)\)$/, "")});
      toast(r.status === "waitlisted" ? "Van is full — added to the waitlist." : "Seat claimed.");
      renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-vunclaim]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await DEL(`/api/van_claims/${a.dataset.vunclaim}`);
    toast(r.promoted ? `${r.promoted.person_name} promoted from the waitlist.` : "Released.");
    renderTravel();
  }));
  // Per-day van driver: mentors pick a different parent to drive the
  // van on that day, or back to the designated driver (blank).
  v.querySelectorAll("[data-vdaydriver]").forEach((b) => b.addEventListener("click", async () => {
    const day = b.dataset.vday || null;
    const sel = $("vd-" + b.dataset.vdaydriver + "-" + (day || "all"));
    try {
      await POST(`/api/vans/${b.dataset.vdaydriver}/day-driver`, {
        event_id: travelEventId, day,
        driver_user_id: sel.value ? +sel.value : null});
      toast("Day driver saved."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  const tvAdd = $("tv-add");
  if (tvAdd) tvAdd.addEventListener("click", async () => {
    const name = $("tv-name").value.trim();
    if (!name) { toast("Van name is required."); return; }
    const seats = parseInt($("tv-seats").value, 10);
    try {
      await POST("/api/team-vans", {name, notes: $("tv-notes").value.trim(),
        driver_user_id: $("tv-driver").value ? +$("tv-driver").value : null,
        seats: seats || null});
      toast("Van added."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  v.querySelectorAll("[data-tvedit]").forEach((b) => b.addEventListener("click", () => {
    const vn = vans.find((y) => y.id === +b.dataset.tvedit);
    if (!vn) return;
    const row = $("tv-row-" + vn.id);
    // Keep the current driver selectable even if they left the pool
    // (e.g. disabled since) — otherwise saving would silently clear them.
    let drvOpts = vanDriverOpts;
    const curDrv = allUsers.find((u) => u.id === vn.driver_user_id);
    if (curDrv) {
      if (drvOpts.includes(`value="${curDrv.id}"`))
        drvOpts = drvOpts.replace(`value="${curDrv.id}"`, `value="${curDrv.id}" selected`);
      else
        drvOpts = `<option value="${curDrv.id}" selected>${esc(curDrv.name)}</option>` + drvOpts;
    }
    row.innerHTML = `<span style="flex:1"><input id="tve-name-${vn.id}" value="${esc(vn.name)}" style="min-width:120px">
      <input id="tve-notes-${vn.id}" value="${esc(vn.notes || "")}" style="min-width:120px">
      <select id="tve-driver-${vn.id}"><option value="">Driver: none yet</option>${drvOpts}</select>
      <input id="tve-seats-${vn.id}" inputmode="numeric" value="${vn.seats || ""}" placeholder="Seats" style="max-width:70px"></span>
      <button class="btn small" id="tve-save-${vn.id}">Save</button><button class="btn small ghost" id="tve-cancel-${vn.id}">Cancel</button>`;
    $("tve-cancel-" + vn.id).addEventListener("click", () => renderTravel());
    $("tve-save-" + vn.id).addEventListener("click", async () => {
      const seats = parseInt($("tve-seats-" + vn.id).value, 10);
      if (!$("tve-name-" + vn.id).value.trim()) return toast("Van name is required.");
      try {
        await PATCH(`/api/team-vans/${vn.id}`, {name: $("tve-name-" + vn.id).value.trim(),
          notes: $("tve-notes-" + vn.id).value.trim(),
          driver_user_id: $("tve-driver-" + vn.id).value ? +$("tve-driver-" + vn.id).value : null,
          seats: seats || null});
        toast("Van updated."); renderTravel();
      } catch (e) { toast("Error: " + e.message); }
    });
  }));
  v.querySelectorAll("[data-tvdel]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this team van? Its tools go back to the pool and its riders are released.")) return;
      const r = await DEL(`/api/team-vans/${b.dataset.tvdel}`);
      toast(`Van deleted.${r.tools_unassigned ? ` ${r.tools_unassigned} tool(s) back in the pool.` : ""}${r.claims_removed ? ` ${r.claims_removed} rider(s) released.` : ""}`); renderTravel();
    }));
  v.querySelectorAll("[data-rvol]").forEach((b) => b.addEventListener("click", async () => {
    // Room parents are per room, but the volunteer select is
    // day-scoped (one rooms table per day) — read that day's select.
    const day = b.dataset.rvolday || null;
    const sel = $("rp-" + b.dataset.rvol + "-" + (day || "all"));
    if (!sel || !sel.value) return toast("Pick which parent is volunteering.");
    const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
    try {
      await POST(`/api/rooms/${b.dataset.rvol}/parent`, {member_id: p.member_id});
      toast("Room parent set — thank you for volunteering!");
      renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-reqdel]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await DEL(`/api/rooming-requests/${b.dataset.reqdel}`);
      toast("Request removed."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-rparentx]").forEach((b) => b.addEventListener("click", async () => {
    await DEL(`/api/rooms/${b.dataset.rparentx}/parent`);
    toast("Room parent removed.");
    renderTravel();
  }));
  const paintBeds = () => {
    const bl = $("bed-list");
    if (!bl) return;
    const total = pendingBeds.reduce((s, t) => s + (t === "sofa bed" ? 1 : 2), 0);
    bl.innerHTML = pendingBeds.map((t, i) =>
      `<span class="pill">${esc(t)} <a href="#" data-bedrm="${i}" title="remove">✕</a></span>`).join("")
      + (pendingBeds.length ? ` <span class="sub">sleeps ${total}</span>` : "");
    bl.querySelectorAll("[data-bedrm]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      pendingBeds.splice(parseInt(a.dataset.bedrm, 10), 1);
      paintBeds();
    }));
  };
  const bedAdd = $("bed-add");
  if (bedAdd) { bedAdd.addEventListener("click", () => {
    pendingBeds.push($("bed-type").value); paintBeds();
  }); paintBeds(); }
  const ra = $("rm-add");
  if (ra) ra.addEventListener("click", async () => {
    // Multi-day: the checked rm-day boxes are the days this room
    // is allocated for; all checked (the default) means every day.
    const dayBoxes = [...document.querySelectorAll("input.rm-day")];
    const body = {beds: pendingBeds};
    if (dayBoxes.length) {
      const days = dayBoxes.filter((x) => x.checked).map((x) => x.dataset.day);
      if (!days.length) return toast("Pick at least one day for the room.");
      body.days = days;
    }
    try {
      const r = await POST(`/api/hotels/${t.hotel.id}/rooms`, body);
      pendingBeds = [];
      toast(`${r.label} added.`); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  v.querySelectorAll("[id^='rn-']").forEach((inp) => inp.addEventListener("change", async () => {
    const r = await fetch(`/api/rooms/${inp.id.slice(3)}`, {method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({room_number: inp.value.trim()})});
    if (r.ok) { toast("Room number saved."); renderTravel(); }
    else toast("Error: could not save the room number.");
  }));
  // Edit a room's allocation (mentor): a form row under that day's
  // table row with day checkboxes (pre-checked from the room's
  // days, empty = all checked) and the actual room number. Saving
  // replaces the day set; occupant rows on dropped days are hidden,
  // not deleted, and reappear if the day is added back.
  v.querySelectorAll("[data-roomedit]").forEach((b) => b.addEventListener("click", () => {
    const day = b.dataset.roomday || "";
    const r = (t.hotel.rooms || []).find((x) => x.id === +b.dataset.roomedit);
    if (!r) return;
    const row = $("rm-row-" + r.id + "-" + (day || "all"))
      || document.querySelector(`[id^="rm-row-${r.id}-"]`);
    if (!row) return;
    const prev = $("rm-edit-" + r.id);
    if (prev) prev.remove();
    const tr = document.createElement("tr");
    tr.id = "rm-edit-" + r.id;
    tr.innerHTML = `<td colspan="4"><div class="row"><span class="sub">Days this room is allocated for:</span>
      ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="re-day" data-day="${ds}"${!r.days || !r.days.length || r.days.includes(ds) ? " checked" : ""}> ${dayLabel(ds)}</label>`).join("")}</div>
    <div class="row" style="margin-top:6px"><span class="sub">Actual room #:</span>
      <input id="re-rn-${r.id}" value="${esc(r.room_number || "")}" placeholder="actual room #" style="max-width:120px">
      <button class="btn small" id="re-save-${r.id}">Save</button><button class="btn small ghost" id="re-cancel-${r.id}">Cancel</button></div></td>`;
    row.after(tr);
    $("re-cancel-" + r.id).addEventListener("click", () => tr.remove());
    $("re-save-" + r.id).addEventListener("click", async () => {
      const boxes = [...tr.querySelectorAll("input.re-day")];
      const days = boxes.filter((x) => x.checked).map((x) => x.dataset.day);
      if (!days.length) return toast("Pick at least one day for the room.");
      try {
        const resp = await fetch(`/api/rooms/${r.id}`, {method: "PUT",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({room_number: $("re-rn-" + r.id).value.trim(), days})});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "update failed");
        toast("Room updated."); renderTravel();
      } catch (e) { toast("Error: " + e.message); }
    });
  }));
  v.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", async () => {
    // Placement is per day: the select is day-scoped, and the day
    // travels with the POST so the server can check that day's
    // attendance, allocation, and capacity.
    const day = b.dataset.placeday || null;
    const sel = $("plc-" + b.dataset.place + "-" + (day || "all"));
    if (!sel) return;
    const mid = parseInt(sel.value, 10);
    if (!mid) return toast("Pick a student to place.");
    try {
      await POST(`/api/rooms/${b.dataset.place}/occupants`, {member_id: mid, day});
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
    const selfInput = $("rq-who-self");
    const mid = selfInput ? parseInt(selfInput.value, 10)
      : parseInt($("rq-who").value, 10);
    if (!mid) return toast("Pick a student.");
    try {
      await POST(`/api/hotels/${t.hotel.id}/requests`, {member_id: mid,
        preferred_roommates: chipValues("rq-mates"),
        notes: $("rq-notes").value.trim()});
      toast("Rooming request saved."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  const whoSel = $("rq-who");
  if (whoSel) whoSel.addEventListener("change", () => {
    const mid = parseInt(whoSel.value, 10);
    const mates = $("rq-mates");
    if (!mates) return;
    const kept = chipValues("rq-mates");
    mates.innerHTML = (allAttStudents || [])
      .filter((a) => a.member_id !== mid)
      .map((a) => chipButton(a.person_name, a.person_name)).join("");
    mates.querySelectorAll(".bubble").forEach((b) => {
      if (kept.includes(b.dataset.val)) {
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
      }
    });
    bindChipButtons(mates);
  });
  bindChips(v);
}

function vehicleTip(v) {
  if (!v) return "";
  const parts = [];
  if (v.plate) parts.push("Plate " + v.plate);
  if (v.color) parts.push(v.color);
  const mm = [v.make, v.model].filter(Boolean).join(" ");
  if (mm) parts.push(mm);
  return parts.join(" · ");
}

// Vehicle detail, tooltip-wise: what a rider needs to decide (make,
// model, color) is visible text; only the license plate — the least
// decision-relevant detail — hides behind a hover tooltip, so nothing
// essential is hover-only (and nothing is lost on phones, where hover
// doesn't exist).
function vehicleLine(v) {
  if (!v) return "";
  const mm = [v.make, v.model].filter(Boolean).join(" ");
  const vis = [v.color, mm].filter(Boolean).join(" · ");
  if (!vis && !v.plate) return "";
  const tip = v.plate ? ` title="Plate ${esc(v.plate)}"` : "";
  return `<div class="sub"${tip}>\u{1F697} ${esc(vis || "vehicle")}</div>`;
}

function bedSummary(beds) {
  if (!beds || !beds.length) return "";
  const counts = {};
  beds.forEach((b) => { counts[b] = (counts[b] || 0) + 1; });
  return Object.entries(counts).map(([t, n]) =>
    `${n} ${t}${n > 1 ? "s" : ""}`).join(" · ");
}

// Per-day rooms, mirroring the carpool day rules: a room runs the
// days in its room_days set (empty = every day), and an occupant row
// covers its day, or every day when its day is NULL (legacy rows).
function roomRunsDay(rm, day) {
  if (day === null || day === undefined) return true;
  const days = rm.days || [];
  return !days.length || days.includes(day);
}
function occMatchesDay(o, day) {
  if (day === null || day === undefined) return true;
  return o.day === null || o.day === undefined || o.day === day;
}
function placedIdsForDay(h, day) {
  const ids = new Set();
  (h.rooms || []).forEach((r) => {
    if (!roomRunsDay(r, day)) return;
    (r.occupants || []).forEach((o) => {
      if (occMatchesDay(o, day)) ids.add(o.member_id);
    });
  });
  return ids;
}
function roomGapHTML(h, dayAttendees, day) {
  const students = (dayAttendees || []).filter((a) => a.person_kind === "student");
  const placed = placedIdsForDay(h, day);
  const pendingReq = (mid) => (h.requests || []).find((q) =>
    q.member_id === mid && q.status === "pending");
  const needs = students.filter((a) => !placed.has(a.member_id) && !pendingReq(a.member_id));
  const awaiting = students.filter((a) => !placed.has(a.member_id) && pendingReq(a.member_id));
  return `<p class="sub">Needs a room: ${needs.length ? needs.map((a) => esc(a.person_name)).join(", ") : "everyone has a room."}</p>
  <p class="sub">Requested — awaiting placement: ${awaiting.length ? awaiting.map((a) => esc(a.person_name)).join(", ") : "none."}</p>`;
}
function roomsTableHTML(h, day, placeOpts, parentOpts, opts) {
  const canVol = ME && ME.role !== "student";
  const dayKey = day || "all";
  const rooms = (h.rooms || []).filter((r) => roomRunsDay(r, day));
  if (!(h.rooms || []).length) return '<p class="sub">No rooms yet — add one above.</p>';
  if (!rooms.length) return '<p class="sub">No rooms allocated for this day yet.</p>';
  return `<div style="overflow-x:auto"><table class="acct" style="margin-top:8px"><thead><tr><th>Room</th><th>Occupants</th><th>Room parent</th><th>Actions</th></tr></thead><tbody>
  ${rooms.map((r) => {
    const occ = (r.occupants || []).filter((o) => occMatchesDay(o, day));
    const occPills = occ.map((o) =>
      `<span class="pill">${esc(o.first_name)} ${esc(o.last_name)}${MENTOR() ? ` <a href="#" data-unplace="${o.id}" title="remove">\u2715</a>` : ""}</span>`).join("");
    const parentCell = r.parent_name
      ? `<span class="pill green">Room parent: ${esc(r.parent_name)}</span>
         ${canVol ? `<button class="btn small ghost" data-rparentx="${r.id}">Remove</button>` : ""}`
      : `<span class="pill gray">No room parent (optional)</span>`;
    const volCell = (!r.parent_name && canVol) ? `<div class="row" style="margin-top:4px">
      <select id="rp-${r.id}-${dayKey}"><option value="">Volunteer as room parent…</option>${parentOpts}</select>
      <button class="btn small" data-rvol="${r.id}" data-rvolday="${day || ""}">Volunteer</button></div>` : "";
    const editCell = (opts.showEdit && MENTOR()) ? `<div class="row" style="margin-top:4px"><button class="btn small ghost" data-roomedit="${r.id}" data-roomday="${day || ""}">Edit</button></div>` : "";
    return `<tr id="rm-row-${r.id}-${dayKey}"><td><b>${esc(r.label)}</b>
      ${r.room_number ? `<div class="sub">room #${esc(r.room_number)}</div>` : ""}
      ${opts.editableNumber && MENTOR() ? `<input class="mini" id="rn-${r.id}" value="${esc(r.room_number || "")}" placeholder="actual room #" style="max-width:120px">` : ""}
      <div><span class="pill ${occ.length >= r.capacity ? "red" : "green"}">${occ.length}/${r.capacity} beds</span></div>
      ${bedSummary(r.beds) ? `<div class="sub">${esc(bedSummary(r.beds))}</div>` : ""}
      ${opts.showEdit ? `<div class="sub">Runs: ${(r.days && r.days.length ? r.days.map(dayLabel).join(", ") : "every day")}</div>` : ""}</td>
      <td>${occPills || '<span class="sub">empty</span>'}</td>
      <td>${parentCell}</td>
      <td><div class="row mo"><select id="plc-${r.id}-${dayKey}">
        <option value="">Place a student…</option>${placeOpts}</select>
        <button class="btn small" data-place="${r.id}" data-placeday="${day || ""}">Place</button></div>${volCell}${editCell}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
// Add-room form (bed builder + Add room). On a multi-day trip it
// also picks the days the room is allocated for — a room not needed
// on the first or last day just unchecks it. The form lives in the
// trip-level hotel card; placement happens in the day tables.
function addRoomFormHTML(multi, evDays) {
  return `<div class="row mo" style="flex-wrap:wrap;gap:8px;align-items:center">
    <select id="bed-type">
      <option value="queen">Queen · sleeps 2</option>
      <option value="double">Double · sleeps 2</option>
      <option value="king">King · sleeps 2</option>
      <option value="sofa bed">Sofa bed · sleeps 1</option>
    </select>
    <button class="btn small" id="bed-add">Add bed</button>
    <span id="bed-list"></span>
    <button class="btn small" id="rm-add">Add room</button>
    <span class="sub">Rooms are numbered automatically (Room #1, #2, …).</span></div>
  ${multi ? `<div class="row" style="margin-top:6px"><span class="sub">Days this room is allocated for:</span>
    ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="rm-day" data-day="${ds}" checked> ${dayLabel(ds)}</label>`).join("")}
    <span class="sub">(all checked = every day)</span></div>` : ""}`;
}
function roomingHTML(h, rqWhoOpts, studentNames, attStudents) {
  // Rooming requests are a student feature: a student files for themself
  // only (never appears in their own pickers); parents don't see the
  // module at all — they take part as room parents, above.
  const selfStudent = ME && ME.role === "student"
    ? (attStudents || []).find((a) => normName(a.person_name) === normName(ME.name))
    : null;
  const visibleReqs = MENTOR() ? h.requests
    : ME && ME.role === "student"
      ? h.requests.filter((q) => selfStudent && q.member_id === selfStudent.member_id)
      : h.requests;
  const pendingReqs = visibleReqs.filter((q) => q.status === "pending").length;
  const matesExclSelf = (attStudents || [])
    .filter((a) => !selfStudent || a.member_id !== selfStudent.member_id)
    .map((a) => chipButton(a.person_name, a.person_name)).join("");
  if (ME.role === "parent") return "";
  return `
  <h3>Rooming requests ${pendingReqs ? `<span class="pill amber">${pendingReqs} awaiting placement</span>` : ""}</h3>
  <p class="sub">A student requests to stay with other students — only for yourself, and you can't pick yourself as a roommate.</p>
  ${ME.role === "student"
    ? selfStudent
      ? `<div class="row"><span class="sub">Requesting as <b>${esc(selfStudent.person_name)}</b></span>
        <input type="hidden" id="rq-who-self" value="${selfStudent.member_id}">
        <div class="bubbles chipgroup" id="rq-mates" title="Tap preferred roommates" style="flex:1;min-width:160px;max-height:120px;overflow-y:auto">${matesExclSelf}</div>
        <input id="rq-notes" placeholder="Notes" style="flex:1;min-width:120px">
        <button class="btn small" id="rq-add">Save request</button></div>`
      : `<p class="sub">We couldn't match your account to an attending student, so you can't file a request — ask a mentor to check your account name.</p>`
    : `<div class="row"><select id="rq-who"><option value="">Student…</option>${rqWhoOpts}</select>
      <div class="bubbles chipgroup" id="rq-mates" title="Tap preferred roommates" style="flex:1;min-width:160px;max-height:120px;overflow-y:auto">${studentNames}</div>
      <input id="rq-notes" placeholder="Notes" style="flex:1;min-width:120px">
      <button class="btn small" id="rq-add">Save request</button></div>`}
  <div style="margin-top:8px">
  ${visibleReqs.map((q) => `<div class="row" style="margin:4px 0">
    <span class="pill ${q.status === "placed" ? "green" : "amber"}">${q.status}</span>
    <b>${esc(q.first_name)} ${esc(q.last_name)}</b>
    <span class="sub">wants: ${esc((q.preferred_roommates || []).join(", ")) || "—"}</span>
    <span class="sub">${esc(q.notes || "")}</span>
    ${q.status === "pending" || MENTOR()
      ? `<button class="btn small ghost" data-reqdel="${q.id}">${MENTOR() ? "Remove" : "Withdraw"}</button>` : ""}
    </div>`).join("") || '<span class="sub">No requests yet.</span>'}
  </div>`;
}
function hotelHeaderHTML(h) {
  return `
  <div class="sub"><b>${esc(h.name)}</b> · ${esc(h.address || "")} ·
    ${esc(h.check_in || "")} → ${esc(h.check_out || "")}</div>
  ${h.notes ? `<div class="sub">${esc(h.notes)}</div>` : ""}`;
}
// Single-day hotel card: header + gap lines + add-room form + rooms
// table + rooming requests, all for the trip's one day.
function hotelHTML(h, args) {
  return `${hotelHeaderHTML(h)}
  <h3>Room status</h3>
  <p class="sub">Who still needs a room for this trip, and whose request is still awaiting placement. Placed students and room parents show in the table below.</p>
  ${roomGapHTML(h, args.dayAttendees, args.day)}
  <h3>Rooms</h3>
  <p class="sub">The block is already booked. A room can have an adult <b>room parent</b> to check in, since students under 18 can't check in themselves — optional; senior rooms often go without. Parents can volunteer for a room below.</p>
  ${addRoomFormHTML(false, [])}
  ${roomsTableHTML(h, args.day, args.placeOpts, args.parentOpts, {editableNumber: true, showEdit: false})}
  ${roomingHTML(h, args.rqWhoOpts, args.studentNames, args.attStudents)}`;
}
// Multi-day hotel card: block info + add-room form (with day picks)
// + rooming requests. The rooms tables live in the day sections,
// not here — a room allocated for specific days belongs to those
// days' tables.
function hotelTopHTML(h, args) {
  return `${hotelHeaderHTML(h)}
  <h3>Rooms</h3>
  <p class="sub">The block is already booked. A room can have an adult <b>room parent</b> to check in, since students under 18 can't check in themselves — optional; senior rooms often go without. Parents can volunteer for a room below.</p>
  ${addRoomFormHTML(true, args.evDays)}
  ${roomingHTML(h, args.rqWhoOpts, args.studentNames, args.attStudents)}`;
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
  if (ME) await loadAvatar();
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
    const place = readPlace();
    if (place) {
      if (place.travel) travelEventId = place.travel;
      if (place.track) trackEventId = place.track;
    }
    const btn = place && document.querySelector(`#nav button[data-view="${place.view}"]`);
    // Profile and Security live outside the menu now (avatar and the
    // Profile card's button), but a reloaded tab should still return
    // to them instead of falling back to Events.
    const offMenu = place && (place.view === "profile" || place.view === "security");
    if (!goCheckinQR()) showView(btn && !btn.classList.contains("navhide") ? place.view : (offMenu ? place.view : "events"));
    refreshBadges();
  } else {
    showView("login");
  }
})();
