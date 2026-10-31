/* Team 9470 Ctrl-Alt-Defeat FRC Team Portal — vanilla JS frontend talking to the Flask REST API. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const normName = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
// Lists built from member/RSVP rows can carry one person twice
// (remove + re-create cycles leave two approved rows for one name).
// Pickers must show each person once: first row wins (roster order
// is lowest id first, so the original survives the dedupe).
function dedupePeople(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

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
let teamAcctsOpen = false;
let rosterSearch = "", rosterSubteam = "";
let eventFilter = "all", eventSearch = "";
let eventCalMode = false, eventCalCursor = "";
// Create-zone open state survives re-renders (filter/search keystrokes
// rebuild the view); creation itself resets them to collapsed.
let evCreateOpen = false, anCreateOpen = false;
// Duplicate from Events hands the copied event to Queue's create
// form (the form lives here now, not in Events).
let pendingDupev = null;
let openRsvpLists = new Set();  // event ids whose RSVP list is expanded
let toolsListCollapsed = false;  // Tool sign-up list in Travel, across renders
let trackEventId = null, travelEventId = null;
let trackDay = null;  // selected Tracking trip day (YYYY-MM-DD)
let openTravelDays = new Set(), openTravelDaysEvent = null;  // Travel day sections left open
let postRideOpen = false, postRideOpenEvent = null;  // Post a ride form open state
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
// Self-only seats and beds (mirrors _may_act_for server-side): a
// student only themself; a parent only themself as a rider (kind
// "parent" — a parent's own rider row carries their linked child's
// member_id, so the gate is on kind, not the link; a "student" row
// is the child's, never the parent's). Name-only rows (member_id
// null, legacy) match by the caller's own account name, or — for a
// parent's own rider row — by the roster parent_name recorded on a
// linked child. Children sign up through their own student
// accounts, or a mentor does it for them.
const ownSeat = (x) => {
  if (!ME) return false;
  if (ME.role === "student")
    return (ME.links || []).some((l) => l.kind === "self" && l.member_id === x.member_id)
      || (x.member_id == null && x.person_kind === "student" && normName(x.person_name) === normName(ME.name));
  if (ME.role === "parent") {
    if (x.person_kind !== "parent") return false;
    if (x.member_id != null)
      return (ME.links || []).some((l) => l.kind === "parent" && l.member_id === x.member_id);
    return normName(x.person_name) === normName(ME.name)
      || (ME.links || []).some((l) => l.kind === "parent" && normName(l.parent_name) === normName(x.person_name));
  }
  return false;
};
// Mentor-only assignments: only mentors release seats and beds.
// Regular users see no ✕ on any pill — their assignment UI is gone.
const canReleaseSeat = (x) => MENTOR();

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
/* RSVP confirm: every RSVP button click — first filing or a later
   update — asks "Confirmed with <answer>?" with YES/NO, so a
   mistap never lands an RSVP by accident. YES runs the original
   RSVP action; NO changes nothing. */
let pendingRsvpBtn = null;
const RSVP_LABELS = {going: "Going", maybe: "Maybe", partial: "Partial (multi-day)", cant: "Can't make it"};
function openRsvpConfirm(b) {
  pendingRsvpBtn = b;
  const t = $("rsvp-confirm-text");
  if (t) t.textContent = `Confirmed with ${RSVP_LABELS[b.dataset.want] || b.dataset.want}?`;
  const m = $("rsvp-modal");
  if (m) m.classList.add("open");
}
function closeRsvpModal() {
  pendingRsvpBtn = null;
  const m = $("rsvp-modal");
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeAvatarMenu(); closeLogoutModal(); closeQrModal(); closeRsvpModal(); closePwModal(); close2faModal(); closeDelModal(); closePartReview(); } });
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
const _rsvpModal = $("rsvp-modal");
if (_rsvpModal) _rsvpModal.addEventListener("click", (e) => { if (e.target === _rsvpModal) closeRsvpModal(); });
const _partReviewModal = $("part-review-modal");
if (_partReviewModal) _partReviewModal.addEventListener("click", (e) => { if (e.target === _partReviewModal) closePartReview(); });
const _rsvpYes = $("rsvp-yes");
if (_rsvpYes) _rsvpYes.addEventListener("click", () => { const b = pendingRsvpBtn; closeRsvpModal(); if (b) rsvpAction(b); });
const _rsvpNo = $("rsvp-no");
if (_rsvpNo) _rsvpNo.addEventListener("click", closeRsvpModal);
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
  closePartReview();
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
    parts: renderParts,
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
  const fam = (u.links || [])[0] || {};
  const hasLinks = (u.links || []).length > 0;
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
      ${hasLinks ? `<div class="field"><label>Parent name</label><input id="pf-pname" value="${esc(fam.parent_name || "")}"></div>
      <div class="field"><label>Relationship</label><input id="pf-rel" value="${esc(fam.relationship || "")}"></div>
      <div class="field"><label>Parent phone</label><input id="pf-pphone" value="${esc(fam.parent_phone || "")}"></div>
      <div class="field"><label>Parent WhatsApp</label><input id="pf-pwa" value="${esc(fam.parent_whatsapp || "")}"></div>
      <div class="field"><label>Parent email</label><input id="pf-pemail" value="${esc(fam.parent_email || "")}"></div>` : ""}
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
    [["pf-pname", "parent_name"], ["pf-rel", "relationship"],
     ["pf-pphone", "parent_phone"], ["pf-pwa", "parent_whatsapp"],
     ["pf-pemail", "parent_email"]].forEach(([id, key]) => {
      const el = $(id); if (el) body[key] = el.value;
    });
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
  const anCount = (await GET("/api/announcements").catch(() => [])).length;
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
  <div class="card"><h3><button class="btn small ghost" id="ac-toggle">${teamAcctsOpen ? "▾" : "▸"}</button> Team accounts</h3>
  <div id="ac-body" class="${teamAcctsOpen ? "" : "hidden"}">
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
      <div class="field"><label>Password <span class="hint">(8+ chars, prefilled)</span></label><input id="ac-pass" type="password" value="test1234!"></div>
      <div class="field"><label>&nbsp;</label><div class="row">
        <button class="btn small" id="ac-add">Create account</button>
      </div></div>
    </div>
    <p class="sub">Reset password and Reset 2FA are per-row buttons in the table above.</p>
  </div></div>
  <div class="card"><h3>Duplicate cleanup</h3>
    <p class="sub">Remove + re-create cycles leave two approved rows or two accounts for one person, and the lists show the name twice. Pick the row to keep per group: merging re-points RSVPs, seats, rooms, check-ins and links to it, then deletes the other rows (the survivor's own record fields are kept; rows that would collide after re-pointing are dropped and counted). A duplicate account whose driving collides with the survivor's is skipped with a reason.</p>
    <div id="dup-list"><span class="sub">Loading…</span></div>
  </div>
  <div class="card mo"><h3>Post announcement</h3>
    <p class="sub">Shown to everyone on the Events page. At most 3 announcements at a time.</p>
    <div class="create-zone ${anCreateOpen ? "" : "collapsed"}" id="an-create-zone">
      <button class="create-toggle" type="button" data-zone="an"><span class="ct-plus">${anCreateOpen ? "－" : "＋"}</span> Post announcement</button>
      <div class="create-body">
        <div class="field"><label>Title</label><input id="an-title"></div>
        <div class="field"><label>Message</label><textarea id="an-body"></textarea></div>
        <button class="btn small" id="an-post"${anCount >= 3 ? " disabled" : ""}>Post announcement</button>
      </div>
    </div>
    <p class="sub">${anCount >= 3 ? "3 of 3 announcements — delete one to post another." : `${anCount} of 3 announcements.`}</p>
  </div>
  <div class="card mo"><h3>Create event</h3>
    <div class="create-zone ${evCreateOpen ? "" : "collapsed"}" id="ev-create-zone">
      <button class="create-toggle" type="button" data-zone="ev"><span class="ct-plus">${evCreateOpen ? "－" : "＋"}</span> Create event <span class="sub">Meeting, build, competition, outreach, or club</span></button>
      <div class="create-body">
        <div class="grid3">
          <div class="field"><label>Title *</label><input id="e-title" value="${pendingDupev ? esc(pendingDupev.title) : ""}"></div>
          <div class="field"><label>Type</label><select id="e-type">
            ${["meeting", "build", "competition", "outreach", "club"].map((t) => `<option value="${t}"${pendingDupev && pendingDupev.type === t ? " selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></div>
          <div class="field"><label>Date</label><input id="e-date" type="date"></div>
          <div class="field"><label><input id="e-multi" type="checkbox"> Multiple days</label><span class="hint">check for multi-day trips</span></div>
          <div class="field" id="e-end-wrap" style="display:none"><label>End date</label><input id="e-end" type="date"></div>
          <div class="field"><label>Time</label><input id="e-time" placeholder="6:00 PM" value="${pendingDupev ? esc(pendingDupev.time || "") : ""}"></div>
          <div class="field"><label>Location</label><input id="e-loc" value="${pendingDupev ? esc(pendingDupev.location || "") : ""}"></div>
          <div class="field"><label>Capacity <span class="hint">(blank = unlimited)</span></label>
            <input id="e-cap" inputmode="numeric" value="${pendingDupev && pendingDupev.capacity !== null && pendingDupev.capacity !== undefined ? pendingDupev.capacity : ""}"></div>
          <div class="field"><label>RSVP deadline</label><input id="e-dead" type="date"></div>
          <div class="field"><label>Repeat weekly <span class="hint">(weeks, 1 = once, max 12)</span></label>
            <input id="e-repeat" inputmode="numeric" value="1"></div>
        </div>
        <div class="row" style="gap:16px;flex-wrap:wrap"><span class="sub">Travel &amp; Logistics shows only what the event needs:</span>
          <label><input id="e-need-hotel" type="checkbox" checked> Hotel rooms needed</label>
          <label><input id="e-need-rides" type="checkbox" checked> Carpool rides needed</label>
          <label><input id="e-need-tools" type="checkbox" checked> Tools / robots needed</label></div>
        <div class="field"><label>Notes</label><textarea id="e-notes">${pendingDupev ? esc(pendingDupev.notes || "") : ""}</textarea></div>
        <div class="row"><button class="btn" id="e-create">Create event</button>
          <button class="btn ghost" id="e-fill" type="button">Fill with an example event</button>
          <button class="btn ghost" id="e-workshop" type="button">Use workshop address</button></div>
        <p class="sub hidden" id="e-clubnote">Club meets Mondays 4:00–5:05 PM and is only for BASIS Independent Fremont students.</p>
      </div>
    </div>
  </div>`;
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  v.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => { queueFilter = b.dataset.f; renderQueue(); }));
  // Team accounts is collapsed by default; the toggle survives
  // re-renders via the module flag, like the create zones.
  const _act = $("ac-toggle");
  if (_act) _act.addEventListener("click", () => { teamAcctsOpen = !teamAcctsOpen; renderQueue(); });
  // Creation forms live in Queue now (moved from Events): the
  // toggle button is the title row — clicking it expands or
  // collapses the form, and the open state survives re-renders.
  v.querySelectorAll(".create-toggle").forEach((b) =>
    b.addEventListener("click", () => {
      const zone = b.closest(".create-zone");
      const open = !zone.classList.toggle("collapsed");
      if (b.dataset.zone === "ev") evCreateOpen = open; else anCreateOpen = open;
      b.querySelector(".ct-plus").textContent = open ? "－" : "＋";
    }));
  const anPost = $("an-post");
  if (anPost) anPost.addEventListener("click", async () => {
    const title = $("an-title").value.trim();
    if (!title) { toast("Title is required."); return; }
    try {
      await POST("/api/announcements", {title, body: $("an-body").value.trim()});
      $("an-title").value = ""; $("an-body").value = "";
      toast("Announcement posted.");
      anCreateOpen = false;
      renderQueue();
    } catch (err) { toast("Error: " + err.message); }
  });
  const _ec = $("e-create"); if (_ec) _ec.addEventListener("click", createEvent);
  const _ef = $("e-fill"); if (_ef) _ef.addEventListener("click", () => {
    $("e-title").value = "Build Session — Intake Prototype"; $("e-type").value = "build";
    $("e-date").value = "2026-11-02"; $("e-time").value = "10:00 AM";
    $("e-loc").value = "4285 Santa Monica Terrace, Fremont, CA 94539"; $("e-cap").value = "12";
  });
  const _ew = $("e-workshop"); if (_ew) _ew.addEventListener("click", () => {
    $("e-loc").value = "4285 Santa Monica Terrace, Fremont, CA 94539";
  });
  // Multi-day toggle: the end date only shows (and only counts)
  // when the event spans more than one day.
  const _em = $("e-multi"); if (_em) _em.addEventListener("change", () => {
    $("e-end-wrap").style.display = _em.checked ? "" : "none";
    if (!_em.checked) $("e-end").value = "";
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
  // A duplicate handed over from Events: the form rendered prefilled
  // above (and open); scroll to it, then clear so later re-renders
  // don't re-prefill.
  if (pendingDupev) {
    const z = $("ev-create-zone");
    if (z) z.scrollIntoView();
    pendingDupev = null;
  }
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
  renderDupCleanup();
}

async function renderDupCleanup() {
  const el = $("dup-list");
  if (!el) return;
  let d;
  try { d = await GET("/api/admin/duplicates"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load duplicates.</span>'; return; }
  const groups = [...(d.members || []).map((g) => ({...g, kind: "member"})),
    ...(d.users || []).map((g) => ({...g, kind: "user"}))];
  if (!groups.length) {
    el.innerHTML = '<span class="sub">No duplicates found — each approved member and account name appears once.</span>';
    return;
  }
  el.innerHTML = groups.map((g, gi) => {
    const rows = g.rows.map((r) => {
      const detail = g.kind === "member"
        ? `${esc(r.code)} · ${esc(r.school || "")} · grade ${esc(r.grade || "")} · ${esc(r.subteam || "no subteam")} · parent ${esc(r.parent_name || "")} · ${r.rsvps} RSVPs · ${r.placements} beds · ${r.claims} seats · ${r.checkins} check-ins · ${r.links} links`
        : `${esc(r.email)} · ${esc(r.role)}${r.disabled ? " · disabled" : ""}${r.has_password ? "" : " · no password"}${r.totp ? " · 2FA on" : ""} · ${r.links} links · ${r.carpools} cars`;
      return `<label class="row" style="margin:4px 0"><input type="radio" name="dup-${gi}" value="${r.id}"${r.id === g.suggested ? " checked" : ""}>
        <span><b>${esc(r.name)}</b> <span class="sub">${detail}</span></span></label>`;
    }).join("");
    return `<div class="card" style="margin-top:8px"><b>${esc(g.name)}</b>
      <span class="pill amber">${g.kind === "member" ? "member" : "account"}</span>
      <span class="sub">Pick the row to keep — the rest merge into it and are deleted.</span>
      ${rows}
      <button class="btn small danger" data-dup-merge="${gi}">Merge into selected</button></div>`;
  }).join("");
  el.querySelectorAll("[data-dup-merge]").forEach((b) =>
    b.addEventListener("click", async () => {
      const gi = +b.dataset.dupMerge;
      const g = groups[gi];
      const sel = el.querySelector(`input[name="dup-${gi}"]:checked`);
      if (!sel) return toast("Pick a row to keep first.");
      const surv = +sel.value;
      const dupes = g.rows.map((r) => r.id).filter((id) => id !== surv);
      if (!dupes.length) return toast("Nothing to merge.");
      if (!confirm(`Merge ${g.rows.length - 1} duplicate row(s) for ${g.name} into the selected row? The other rows will be deleted.`)) return;
      try {
        const r = await POST("/api/admin/duplicates/merge",
          {merges: [{kind: g.kind, survivor_id: surv, dupe_ids: dupes}]});
        const res = r.results[0];
        const dropped = Object.entries(res.dropped || {}).filter(([, n]) => n)
          .map(([k, n]) => `${n} ${k}`).join(", ");
        const skipped = (res.skipped || []).map((s) => `row ${s.dupe_id}: ${s.reasons.join("; ")}`).join(" | ");
        toast(`Merged ${res.merged.length} row(s) for ${g.name}${dropped ? ` (dropped ${dropped})` : ""}${skipped ? ` — skipped: ${skipped}` : ""}.`);
        renderQueue();
      } catch (e) { toast("Error: " + e.message); }
    }));
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
        <td>${esc(u.whatsapp || "—")}</td>
        <td data-rolecell="${u.id}"><span class="pill ${(u.role === "mentor" || u.role === "admin") ? "amber" : "gray"}">${esc(u.role)}</span>${u.disabled ? ' <span class="pill red">disabled</span>' : ""}</td>
        <td>${esc(m ? (m.school || "") : "")}</td>
        <td>${esc(m ? (m.grade || "") : "")}</td>
        <td>${esc(m ? (m.assigned_subteam || "") : "")}</td>
        <td ${relEditable ? `class="rel-cell" data-rel="${u.id}" title="Click to edit" style="cursor:pointer"` : ""}>${rel ? esc(rel) : '<span class="sub">—</span>'}</td>
        <td><div class="row" style="flex-wrap:nowrap">
          <button class="btn small ghost" data-pw="${u.id}">Reset password</button>
          <button class="btn small ghost" data-faid="${u.id}">Reset 2FA${u.totp_enabled ? "" : " (off)"}</button>
          <button class="btn small ghost" data-dis="${u.id}" ${(u.id === (ME && ME.id) && !u.disabled) ? "disabled title=\"You cannot disable your own account\"" : ""}>${u.disabled ? "Enable" : "Disable"}</button>
          <button class="btn small ghost" data-del="${u.id}" ${u.disabled ? "" : "disabled title=\"Disable the account first\""}>Delete</button>
          <button class="btn small ghost" data-roledit="${u.id}" ${(u.id === (ME && ME.id)) ? "disabled title=\"You cannot change your own role\"" : ""}>Edit role</button>
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
  // Role is edited inline via its Edit button: the Member type cell
  // swaps for a role select (admin offered only to admins) with
  // Save/Cancel; an unchanged pick just re-renders, no request.
  el.querySelectorAll("[data-roledit]").forEach((b) =>
    b.addEventListener("click", () => {
      const uid = +b.dataset.roledit;
      const u = users.find((x) => x.id === uid);
      const cell = el.querySelector(`[data-rolecell="${uid}"]`);
      if (!u || !cell || cell.querySelector("select")) return;
      const roles = ["student", "parent", "mentor"];
      if (ME && ME.role === "admin") roles.push("admin");
      if (!roles.includes(u.role)) roles.push(u.role);
      cell.innerHTML = `<select class="role-sel">${roles.map((r) =>
        `<option value="${r}"${r === u.role ? " selected" : ""}>${r}</option>`).join("")}</select>
        <button class="btn small" data-role-save>Save</button>
        <button class="btn small ghost" data-role-cancel>Cancel</button>`;
      cell.querySelector("[data-role-cancel]").addEventListener("click", () => renderAccounts());
      cell.querySelector("[data-role-save]").addEventListener("click", async () => {
        const role = cell.querySelector("select").value;
        if (role === u.role) return renderAccounts();
        try {
          await PATCH(`/api/users/${uid}`, {role});
          toast(`Role updated to ${role} for ${u.name}.`);
          renderAccounts();
        } catch (e) { toast("Error: " + e.message); }
      });
    }));
  // WhatsApp is click-to-edit: click a cell to swap it for an input
  // with Save (Enter saves too, Escape cancels back to the table).
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
        = $("ac-phone").value = $("ac-whatsapp").value = "";
      $("ac-pass").value = "test1234!";
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
  // A name on two approved rows (remove + re-create leftovers) gets a
  // marker pointing at the fix — the roster itself keeps showing
  // every row, since it is the record the cleanup merges.
  const nameCounts = {};
  rosterCache.forEach((m) => {
    const k = normName(`${m.first_name} ${m.last_name}`);
    nameCounts[k] = (nameCounts[k] || 0) + 1;
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
      <td><b>${esc(m.first_name)} ${esc(m.last_name)}</b>${nameCounts[normName(`${m.first_name} ${m.last_name}`)] > 1 ? ' <span class="pill amber">duplicate</span>' : ""}</td>
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
  // approved members -> student + parent responder entries. Two
  // approved rows for one child collapse to the first (lowest id);
  // one parent of several children gets a "parent of <child>" label
  // per child, so those entries stay distinguishable instead of
  // collapsing into one identical label.
  const entries = dedupePeople(rosterCache.flatMap((m) => [
    {member_id: m.id, kind: "student", name: `${m.first_name} ${m.last_name} (student)`},
    {member_id: m.id, kind: "parent", name: `${m.parent_name} (parent)`,
     _child: `${m.first_name} ${m.last_name}`, _parent: m.parent_name},
  ]), (p) => p.kind === "student" ? `student:${normName(p.name)}`
    : `parent:${normName(p._parent)}:${normName(p._child)}`);
  const parentCounts = {};
  entries.filter((p) => p.kind === "parent").forEach((p) => {
    parentCounts[normName(p._parent)] = (parentCounts[normName(p._parent)] || 0) + 1;
  });
  return entries.map((p) => p.kind === "parent"
    && parentCounts[normName(p._parent)] > 1
    ? {member_id: p.member_id, kind: p.kind, name: p.name,
       label: `${p._parent} (parent of ${p._child.split(" ")[0]})`}
    : {member_id: p.member_id, kind: p.kind, name: p.name});
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
    // Two links to duplicate rows for one child collapse to one
    // option (first link wins); distinct children keep their
    // "parent of <child>" labels.
    const plinks = dedupePeople(ME.links.filter((l) => l.kind === "parent"),
      (l) => normName(l.member_name));
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
  const ppl = dedupePeople(parents.map((mid) => rosterCache.find((x) => x.id === mid))
    .filter(Boolean), (m) => normName(m.parent_name));
  ppl.forEach((m) => {
    opts.push({member_id: m.id, kind: "parent", name: `${m.parent_name} (parent)`,
      label: ppl.length > 1 ? `${m.parent_name} (parent of ${m.first_name})` : undefined});
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
function eventCalendarHtml(list, myRsvps) {
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
  // The viewer's own attending RSVPs, grouped by event: an empty day
  // list covers every day of the event (going, or partial with no
  // picks), mirroring the server's attendance rule.
  const mine = new Map();
  for (const r of (myRsvps || [])) {
    if (r.status !== "going" && r.status !== "partial") continue;
    if (!mine.has(r.event_id)) mine.set(r.event_id, []);
    mine.get(r.event_id).push(new Set(r.days || []));
  }
  const covers = (e, ds) =>
    (mine.get(e.id) || []).some((dset) => dset.size === 0 || dset.has(ds));
  const cells = [];
  let anyMark = false;
  for (let i = 0; i < startDay; i++) cells.push(`<div class="cal-cell empty"></div>`);
  for (let d = 1; d <= days; d++) {
    const ds = `${cur}-${String(d).padStart(2, "0")}`;
    const evs = byDay[ds] || [];
    const today = ds === now.toISOString().slice(0, 10) ? " today" : "";
    const rsvpd = evs.some((e) => covers(e, ds));
    if (rsvpd) anyMark = true;
    cells.push(`<div class="cal-cell${today}${rsvpd ? " rsvpd" : ""}"><span class="cal-day"${rsvpd ? ` title="You RSVP'd for an event this day"` : ""}>${d}</span>
      ${evs.slice(0, 3).map((e) => `<a href="#ev-card-${e.id}" class="cal-ev">${esc(e.title)}</a>`).join("")}
      ${evs.length > 3 ? `<span class="sub">+${evs.length - 3} more</span>` : ""}</div>`);
  }
  return `<div class="row" style="margin-top:14px">
    <button class="btn small ghost" data-calnav="-1">‹ Prev</button>
    <b style="flex:1;text-align:center">${label}</b>
    <button class="btn small ghost" data-calnav="0">Today</button>
    <button class="btn small ghost" data-calnav="1">Next ›</button>
  </div>
  <div class="cal-grid">
    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-head">${d}</div>`).join("")}
    ${cells.join("")}
  </div>
  ${anyMark ? `<p class="sub" style="margin-top:8px"><span style="color:var(--accent-text)">●</span> Blue date = you or your student RSVP'd going / partial for an event that day.</p>` : ""}</div>`;
}

async function renderEvents() {
  const v = $("view-events");
  await loadPeople();
  const events = await GET("/api/events");
  const list = events.filter((e) => {
    const q = eventSearch.toLowerCase();
    // NOTE: closed events stay visible to everyone (2026-10-30).
    // A past deadline freezes the RSVP controls (disabled picker
    // and buttons, "RSVPs are frozen" note, disabled Remove) but
    // the card itself never leaves the list — regular users still
    // see the event, its headcounts, and its RSVP list. Mentors
    // additionally get the Archive button on closed cards.
    return (eventFilter === "all" || e.type === eventFilter) &&
      (!q || (e.title + e.location).toLowerCase().includes(q));
  });
  const cards = [];
  for (const e of list) cards.push(await eventCard(e));
  const types = ["meeting", "build", "competition", "outreach", "club"];
  v.innerHTML = `
  <div class="card an-card"><h2>Announcements</h2>
    <div id="an-list"><span class="sub">Loading…</span></div>
  </div>
  <div class="card"><h2>Events &amp; RSVPs</h2>
  <p class="sub">Mentors create events from Mentor Queue. Students and parents RSVP for themselves; mentors can RSVP for anyone. Over-capacity events waitlist with auto-promote.</p>
  <div class="row mo">
    <a class="btn ghost small" href="/api/events.csv">Export CSV</a>
    <button class="btn ghost small" id="e-import">Import CSV</button>
    <button class="btn ghost small" id="e-archive">Archive season…</button>
  </div>
  <div id="e-import-panel" class="mo hidden"></div>
  <div class="row" style="margin-top:14px">
    ${["all", ...types].map((t) =>
      `<button class="btn ${eventFilter === t ? "" : "ghost"} small" data-et="${t}">${t}</button>`).join("")}
    <input id="e-q" placeholder="Search…" value="${esc(eventSearch)}" style="max-width:200px">
    <button class="btn small ${eventCalMode ? "ghost" : ""}" id="ev-list-view">List</button>
    <button class="btn small ${eventCalMode ? "" : "ghost"}" id="ev-cal-view">Calendar</button>
  </div>
  ${eventCalMode ? eventCalendarHtml(list, await GET("/api/my-rsvps").catch(() => [])) : ""}
  </div>
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
  v.querySelectorAll("[data-rsvp]").forEach((b) =>
    b.addEventListener("click", () => openRsvpConfirm(b)));
  // Partial-day gating: on a multi-day card, Going / Maybe / Can't
  // make it only make sense with every day picked. While any day is
  // unchecked, only Partial (multi-day) stays enabled, so a partial
  // day pick can never land as a full 'going' on the logistics
  // board. Single-day cards have no day boxes and are unaffected.
  const syncRsvpButtons = (card) => {
    // A frozen (past-deadline) card never re-enables its buttons.
    if (card.querySelector("[data-frozen]")) return;
    const boxes = [...card.querySelectorAll("input.rp-day")];
    if (!boxes.length) return;
    const all = boxes.every((x) => x.checked);
    card.querySelectorAll("button[data-rsvp]").forEach((btn) => {
      const partial = btn.dataset.want === "partial";
      btn.disabled = !all && !partial;
      btn.title = (!all && !partial) ? "Check every day to enable this — or use Partial (multi-day)." : "";
    });
  };
  v.querySelectorAll("input.rp-day").forEach((box) =>
    box.addEventListener("change", () => syncRsvpButtons(box.closest(".card"))));
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
  v.querySelectorAll("[data-archev]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Archive this event? No updates will be allowed until it is unarchived.")) return;
      try { await PATCH(`/api/events/${b.dataset.archev}`, {archived: 1}); toast("Event archived."); renderEvents(); }
      catch (e) { toast("Error: " + e.message); }
    }));
  v.querySelectorAll("[data-unarchev]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await PATCH(`/api/events/${b.dataset.unarchev}`, {archived: 0}); toast("Event unarchived."); renderEvents(); }
      catch (e) { toast("Error: " + e.message); }
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
      // The create form lives in Queue now: hand the copy over and
      // open it there (dates cleared — pick a new date and save).
      pendingDupev = e;
      evCreateOpen = true;
      toast("Copied — pick a new date and save.");
      showView("queue");
    }));
  v.querySelectorAll("[data-editev]").forEach((b) =>
    b.addEventListener("click", () =>
      v.querySelector(`#ef-${b.dataset.editev}`).classList.toggle("hidden")));
  v.querySelectorAll(".ef-multi").forEach((cb) =>
    cb.addEventListener("change", () => {
      const f = cb.closest('[id^="ef-"]');
      const wrap = f && f.querySelector(".ef-end-wrap");
      if (wrap) wrap.style.display = cb.checked ? "" : "none";
      if (!cb.checked && f) f.querySelector(".ef-end").value = "";
    }));
  v.querySelectorAll("[data-cancelev]").forEach((b) =>
    b.addEventListener("click", () =>
      v.querySelector(`#ef-${b.dataset.cancelev}`).classList.add("hidden")));
  v.querySelectorAll("[data-saveev]").forEach((b) =>
    b.addEventListener("click", async () => {
      const f = v.querySelector(`#ef-${b.dataset.saveev}`);
      const q = (sel) => f.querySelector(sel).value;
      const qc = (sel) => f.querySelector(sel).checked;
      try {
        await PATCH(`/api/events/${b.dataset.saveev}`, {title: q(".ef-title").trim(),
          type: q(".ef-type"), date: q(".ef-date").trim(),
          end_date: qc(".ef-multi") ? q(".ef-end").trim() : "",
          time: q(".ef-time").trim(), location: q(".ef-loc").trim(),
          capacity: q(".ef-cap").trim(), deadline: q(".ef-dead").trim(),
          session_hours: q(".ef-hours").trim(), notes: q(".ef-notes").trim(),
          needs_hotel: qc(".ef-need-hotel") ? 1 : 0,
          needs_rides: qc(".ef-need-rides") ? 1 : 0,
          needs_tools: qc(".ef-need-tools") ? 1 : 0});
        toast("Event updated."); renderEvents();
      } catch (err) { toast("Error: " + err.message); }
    }));
}

async function createEvent() {
  const val = (id) => $(id).value.trim();
  if (!val("e-title")) return toast("Title is required.");
  const multiDay = $("e-multi") && $("e-multi").checked;
  if (multiDay && !val("e-end")) return toast("Pick an end date for a multi-day event.");
  const base = {title: val("e-title"), type: $("e-type").value,
    date: val("e-date"), end_date: multiDay ? val("e-end") : "", time: val("e-time"),
    location: val("e-loc"),
    capacity: val("e-cap") ? parseInt(val("e-cap"), 10) : null,
    deadline: val("e-dead"), notes: val("e-notes"),
    needs_hotel: $("e-need-hotel").checked ? 1 : 0,
    needs_rides: $("e-need-rides").checked ? 1 : 0,
    needs_tools: $("e-need-tools").checked ? 1 : 0};
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
    evCreateOpen = false;  // back to the collapsed form
    if (currentView === "queue") renderQueue(); else renderEvents();
  } catch (e) { toast("Error: " + e.message); }
}

// RSVP closed = deadline passed (local date, same rule the server
// uses for Archive). Local, not UTC: the server judges by its own
// local date, so a UTC comparison would freeze buttons hours early
// on PDT evenings, when UTC has already ticked to the next day.
// Non-mentors never see closed cards (renderEvents filters them);
// mentors/admins see them with an Archive button.
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function eventClosed(e) {
  return !!(e.deadline && e.deadline < todayLocal());
}

async function eventCard(e, ro = false) {
  const d = await GET(`/api/events/${e.id}/rsvps`);
  const hc = d.headcounts;
  const closed = eventClosed(e);
  const archived = !!e.archived;
  // Mentors can join events and RSVP for themselves, not just file
  // for members: their own entry leads the picker. It is a name-only
  // RSVP (member_id null, adult "parent" kind — mentors hold no
  // roster row), filed under their account name; the server dedupes
  // name-only RSVPs by normalized name, so re-filing updates it.
  const pickerOpts = MENTOR()
    ? [{member_id: null, kind: "parent", name: ME.name,
        label: `${ME.name} (mentor — you)`}, ...personOptions()]
    : selfRSVPOptions();
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
  else if (archived) pickerRow = `<p class="sub">Archived — updates disabled. Unarchive to make changes.</p>`;
  else if (clubBlocked) pickerRow = `<p class="sub">Club events are only for BASIS Independent Fremont students.</p>`;
  else if (pickerOpts.length) pickerRow = `<div class="row"${closed ? ' data-frozen="1"' : ""}>
      <select id="rp-${e.id}"${closed ? " disabled" : ""}>${opts}</select>
      <button class="btn small" data-rsvp="${e.id}" data-want="going"${closed ? " disabled" : ""}>RSVP Going</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="maybe"${closed ? " disabled" : ""}>Maybe</button>
      ${eventDays(e).length > 1 ? `<button class="btn small ghost" data-rsvp="${e.id}" data-want="partial"${closed ? " disabled" : ""}>Partial (multi-day)</button>` : ""}
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="cant"${closed ? " disabled" : ""}>Can't make it</button>
    </div>${eventDays(e).length > 1 ? `<div class="row" style="margin-top:6px"><span class="sub">Partial days:</span>
      ${eventDays(e).map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="rp-day" data-day="${ds}" checked${closed ? " disabled" : ""}> ${dayLabel(ds)}</label>`).join("")}
      <span class="sub">(all checked = every day; only used for Partial — unchecking a day leaves only Partial enabled)</span></div>` : ""}
    ${closed ? `<p class="sub">RSVP deadline has passed — RSVPs are frozen.</p>` : ""}`;
  else pickerRow = `<p class="sub">We couldn't match your account to the roster, so you can't RSVP — ask a mentor to check your account name.</p>`;
  const scope = selfScope();
  const row = (r) => {
    const pill = r.status === "going" ? "green" : r.status === "waitlisted" ? "amber"
      : r.status === "maybe" ? "blue" : r.status === "partial" ? "steel" : "gray";
    // List labels read as attendance, not raw codes: going = full
    // trip, can't make it = rejected from the trip.
    const label = r.status === "going" ? "full" : r.status === "cant" ? "rejected" : r.status;
    const canRemove = !ro && (MENTOR() || (ME
      && ((r.person_kind === "student" && r.member_id === scope.student)
        || (r.person_kind === "parent" && scope.parents.includes(r.member_id)))));
    return `<div class="row" style="margin:4px 0">
      <span class="pill ${pill}">${label}</span>
      <span>${esc(r.person_name)} <span class="sub">(${r.person_kind})</span></span>
      ${r.status === "partial" && r.days && r.days.length && eventDays(e).length > 1
        ? `<span class="sub">${r.days.map(dayLabel).join(", ")}</span>` : ""}
      ${canRemove ? `<button class="btn small ghost" data-unrsvp="${r.id}"${closed ? " disabled" : ""}>Remove</button>` : ""}</div>`;
  };
  return `<div class="card" id="ev-card-${e.id}">
    <div class="row"><b>${esc(e.title)}</b>
      <span class="pill">${esc(e.type)}</span>
      ${e.season ? `<span class="pill gray">${esc(e.season)}</span>` : ""}
      ${archived ? '<span class="pill amber">Archived</span>' : closed ? '<span class="pill red">RSVP closed</span>' : ""}
      <span style="flex:1"></span>
      ${ro ? "" : `<a class="btn small ghost" href="/api/events/${e.id}.ics">Add to calendar</a>
      ${MENTOR() ? `<button class="btn small ghost" data-dupev="${e.id}">Duplicate</button>${archived ? "" : `<button class="btn small ghost" data-editev="${e.id}">Edit</button><button class="btn small danger" data-delev="${e.id}">Delete</button>`}${archived ? `<button class="btn small ghost" data-unarchev="${e.id}">Unarchive</button>` : closed ? `<button class="btn small ghost" data-archev="${e.id}">Archive</button>` : ""}` : ""}`}</div>
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
        <div class="field ef-end-wrap" style="${e.end_date ? "" : "display:none"}"><label>End date</label><input class="ef-end" type="date" value="${esc(e.end_date || "")}"></div>
        <div class="field"><label>Time</label><input class="ef-time" value="${esc(e.time || "")}"></div>
        <div class="field"><label>Location</label><input class="ef-loc" value="${esc(e.location || "")}"></div>
        <div class="field"><label>Capacity <span class="hint">(blank = unlimited)</span></label><input class="ef-cap" inputmode="numeric" value="${e.capacity === null || e.capacity === undefined ? "" : e.capacity}"></div>
        <div class="field"><label>RSVP deadline</label><input class="ef-dead" type="date" value="${esc(e.deadline || "")}"></div>
        <div class="field"><label>Session hours</label><input class="ef-hours" inputmode="decimal" value="${e.session_hours === null || e.session_hours === undefined ? "" : e.session_hours}"></div>
      </div>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <label><input class="ef-multi" type="checkbox" ${e.end_date ? "checked" : ""}> Multiple days</label>
        <label><input class="ef-need-hotel" type="checkbox" ${e.needs_hotel === 0 ? "" : "checked"}> Hotel rooms needed</label>
        <label><input class="ef-need-rides" type="checkbox" ${e.needs_rides === 0 ? "" : "checked"}> Carpool rides needed</label>
        <label><input class="ef-need-tools" type="checkbox" ${e.needs_tools === 0 ? "" : "checked"}> Tools / robots needed</label></div>
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
  const palette = ["#dbeafe", "#dcefe3", "#dde8fb", "#e0f2fe", "#f1f5f9", "#e0f2f1"];
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
  // Mentor driver dropdown: parent accounts, for posting a ride on
  // a parent's behalf. Parents never see it (and never fetch it).
  const parentUsers = MENTOR()
    ? (await GET("/api/users").catch(() => [])).filter((u) => u.role === "parent")
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    : [];
  if (!events.some((e) => e.id === travelEventId)) travelEventId = events.length ? events[0].id : null;
  if (!events.length) {
    $("view-travel").innerHTML =
      '<div class="card"><h2>Travel &amp; Logistics</h2><p class="sub">Create an event first.</p></div>';
    return;
  }
  // Day tables: rides are grouped by trip day, one collapsible
  // section per day, each with a carpool table and a rooms table.
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
  // Event "needs" flags: only an explicit 0 opts a section out —
  // old rows and old clients carry no flags and keep everything,
  // as before. The travel payload's event row carries them; the
  // events list row is the fallback.
  const evNeeds = t.event || ev0 || {};
  const needsHotel = evNeeds.needs_hotel !== 0;
  const needsRides = evNeeds.needs_rides !== 0;
  const needsTools = evNeeds.needs_tools !== 0;
  const ev = t.event;
  // Day-section open state: Day 1 open, the rest closed; reset when
  // the picked event changes. Toggling a section flips visibility
  // only — it never re-renders, so in-progress forms survive.
  if (openTravelDaysEvent !== travelEventId) {
    openTravelDaysEvent = travelEventId;
    openTravelDays = new Set(multi ? [evDays[0]] : []);
  }

  const allDayCars = dayPayloads.flatMap((d) => d.t.carpools || []);
  const optJSON = (p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`;
  // Seat picker filter, per day: a rider choice excludes everyone
  // driving that day (a carpool driver — including the driver
  // of the very row being filled) and everyone already holding a
  // CLAIMED seat on any vehicle that day. The row's own waitlist is
  // passed in as well, so a waitlisted rider isn't offered their own
  // ride twice; a person waitlisted elsewhere can still grab an open
  // seat here (they hold no seat yet), and the server skips them on
  // promotion if they have since been seated elsewhere.
  const cleanAttName = (p) => p.name.replace(/ \((student|parent)\)$/, "");
  const claimOptsForDay = (dp, ownRows) => {
    const driverNames = new Set(
      dp.t.carpools.map((c) => normName(c.driver_name)));
    // No claimed-elsewhere exclusion: a rider already seated on
    // another vehicle for this day stays offered here, and claiming
    // them MOVES their seat (the server deletes the old row, with
    // waitlist promotion, and inserts the new one). Only this
    // vehicle's own rows stay excluded, below.
    const own = new Set();
    (ownRows || []).forEach((x) => {
      own.add(`${x.member_id}:${x.person_kind}`);
      own.add(`${normName(x.person_name)}:${x.person_kind}`);
    });
    const attPeople = dedupePeople(dp.t.attendees || [],
      (a) => `${a.person_kind}:${normName(a.person_name)}`).map((a) => ({member_id: a.member_id,
      kind: a.person_kind, name: `${a.person_name} (${a.person_kind})`}));
    // Non-mentors only ever see their own seat in the picker: a
    // student themself, a parent themself as a parent rider (the
    // parent's own rider row carries their linked child's id, so
    // the parent entry is keyed by it with kind "parent").
    const ownPeople = new Set();
    if (ME && ME.role === "student")
      (ME.links || []).filter((l) => l.kind === "self").forEach((l) => ownPeople.add(`${l.member_id}:student`));
    if (ME && ME.role === "parent")
      (ME.links || []).filter((l) => l.kind === "parent").forEach((l) => { ownPeople.add(`${l.member_id}:parent`); });
    return attPeople.filter((p) => {
      const idKey = `${p.member_id}:${p.kind}`;
      const nameKey = `${normName(cleanAttName(p))}:${p.kind}`;
      if (!MENTOR() && !ownPeople.has(idKey)) return false;
      if (p.kind === "parent" && driverNames.has(normName(cleanAttName(p)))) return false;
      if (own.has(idKey) || own.has(nameKey)) return false;
      return true;
    }).map(optJSON).join("");
  };
  // Hotel rooms are per-trip, not per-day: the hotel section (place
  // dropdown, room status gaps) uses everyone attending the trip,
  // not just one day's riders.
  // Mentor vehicle dropdown for a tool row: event carpools, with
  // the row's current vehicle preselected. Tools are
  // per-trip, so the dropdown uses every car in the trip
  // (all_carpools), not just the ones running on one day.
  const allCars = t.all_carpools || allDayCars;
  const vehOptsFor = (x) => {
    const cur = x.vehicle_type ? `${x.vehicle_type}:${x.vehicle_id}` : "";
    const opts = [
      ...allCars.map((c) => ({v: `carpool:${c.id}`, l: `${c.driver_name}'s car`}))];
    return opts.map((o) => `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${esc(o.l)}</option>`).join("");
  };
  // One table row per car. Driver cell carries everything a rider
  // needs at a glance: driver, vehicle (visible make/model/color,
  // plate only as a hover tooltip), departure, return, notes.
  const carRow = (dp, c) => {
    const dayKey = dp.day || "all";
    const riders = c.claims.map((x) =>
      `<span class="pill">${esc(x.person_name)}${canReleaseSeat(x) ? ` <a href="#" data-unclaim="${x.id}" title="release">✕</a>` : ""}</span>`).join("")
      || '<span class="sub">none yet</span>';
    const wait = c.waitlist.length ? `<div style="margin-top:4px">Waitlist: ${c.waitlist.map((x) =>
      `<span class="pill amber">${esc(x.person_name)}${canReleaseSeat(x) ? ` <a href="#" data-unclaim="${x.id}" title="remove">✕</a>` : ""}</span>`).join("")}</div>` : "";
    const cpsOpts = claimOptsForDay(dp, [...c.claims, ...c.waitlist]);
    // Mentor-only assignments: regular users see no picker at all.
    const claimCell = !MENTOR()
      ? `<span class="sub">Riders are assigned by a mentor.</span>`
      : (cpsOpts
        ? `<div class="row"><select id="cps-${c.id}-${dayKey}"><option value="">Place rider…</option>${cpsOpts}</select>
          <button class="btn small" data-claim="${c.id}" data-claimday="${dp.day || ""}">Claim seat</button></div>`
        : `<span class="sub">Everyone attending is already driving or seated on another ride.</span>`);
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
  const ridesTables = (dp) => {
    return `
    <h4>Carpools</h4>
    ${dp.t.carpools.length
      ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Car / Driver</th><th>Riders</th><th>Seats</th><th>Actions</th></tr></thead><tbody>${dp.t.carpools.map((c) => carRow(dp, c)).join("")}</tbody></table></div>`
      : '<p class="sub">No carpools posted for this day yet.</p>'}`;
  };
  // Per-day room place options: students attending that day who
  // don't already hold a room that day (any room). The rooms table
  // for a day lists only the rooms allocated for it, with that
  // day's occupants and per-day capacity.
  const placeOptsForDay = (dp) => {
    // No placed exclusion: a person already placed in another room
    // for this day stays offered here, and placing them MOVES their
    // bed (the server deletes the old row and inserts the new one;
    // same-room re-place stays a server no-op).
    let list = dedupePeople((dp.t.attendees || []).filter((a) => a.person_kind === "student"),
      (a) => normName(a.person_name));
    // Only mentors ever see this picker (canPlace above), so it
    // offers everyone attending that day: students by member_id,
    // and parents by name. Parents hold no roster row, so a parent
    // is filed as a name-only occupant (like a mentor placing
    // themself) — without this, parents would have no bed at all
    // now that the room-parent role is gone.
    const opts = list.map((a) => `<option value="${a.member_id}">${esc(a.person_name)}</option>`).join("");
    const meName = MENTOR() ? normName(ME.name) : null;
    const parentOpts = dedupePeople((dp.t.attendees || []).filter((a) => a.person_kind === "parent" && normName(a.person_name) !== meName),
      (a) => normName(a.person_name))
      .map((a) => `<option value="parent:${esc(a.person_name)}">${esc(a.person_name)} (parent)</option>`).join("");
    // A mentor attending this day can pick a room for themself: the
    // "self" value files a name-only placement (mentors hold no
    // roster row), and the server checks their own RSVP for the day.
    if (MENTOR() && (dp.t.attendees || []).some((a) => a.person_kind === "parent" && normName(a.person_name) === normName(ME.name))) {
      return `<option value="self">${esc(ME.name)} (mentor — you)</option>` + opts + parentOpts;
    }
    return opts + parentOpts;
  };
  const roomsDaySection = (dp) => `
    <h4>Rooms</h4>
    ${roomsTableHTML(t.hotel, dp.day, placeOptsForDay(dp), {editableNumber: false, showEdit: true})}
    ${roomGapHTML(t.hotel, dp.t.attendees, dp.day)}`;
  const daySection = (dp, idx) => {
    // Day sections only carry what the event needs: rides tables
    // when rides are needed, rooms tables when a hotel is needed
    // and a block exists. A day with neither renders nothing.
    const body = `${needsRides ? ridesTables(dp) : ""}${needsHotel && t.hotel ? roomsDaySection(dp) : ""}`;
    if (!body) return "";
    return `
  <div class="card"><h3><button class="btn small ghost" data-tdaysec="${dp.day}">${openTravelDays.has(dp.day) ? "▾" : "▸"}</button> Day ${idx + 1} · ${dayLabel(dp.day)}</h3>
  <div id="tday-body-${dp.day}" class="${openTravelDays.has(dp.day) ? "" : "hidden"}">${body}</div></div>`;
  };
  // Post a ride: one vehicle per driver per event, collapsed by
  // default, and gone entirely once the caller already registered
  // a car for this event — the form never reappears after
  // registration; the Fleet card below is where the registered
  // vehicle is edited or removed. The server enforces the same
  // rules; t.me is its word on both.
  if (postRideOpenEvent !== travelEventId) {
    postRideOpenEvent = travelEventId;
    postRideOpen = false;
  }
  const myCar = (t.all_carpools || []).find((c) => c.driver_user_id === ME.id);
  const canPost = ME.role !== "student" && !myCar;
  const postRideCard = !canPost ? "" : `
  <div class="card"><h3 id="cp-toggle" style="cursor:pointer">Post a ride <span class="sub">${postRideOpen ? "▲ hide form" : "▼ show form"}</span></h3>
  <div id="cp-form-wrap" class="${postRideOpen ? "" : "hidden"}">
  ${multi ? `<div class="row" style="margin-bottom:8px"><span class="sub">Days this car runs:</span>
    ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="cp-day" data-day="${ds}" checked> ${dayLabel(ds)}</label>`).join("")}
    <span class="sub">(all checked = every day)</span></div>` : ""}
  <div class="grid3">
    <div class="field"><label>Driver</label>${MENTOR()
      ? `<select id="cp-driver"><option value="">Myself (${esc(ME.name)})</option>${parentUsers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select><span class="hint">Pick a parent to post their car, or yourself</span>`
      : `<input id="cp-driver" disabled value="${esc(ME.name)}"><span class="hint">You, auto-filled</span>`}</div>
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
  <button class="btn small" id="cp-add">Post ride</button></div></div>`;
  // Logistics status: one row per RSVP'd person (students first,
  // then parents, alphabetical), one column per trip day. Each day
  // cell carries two round, non-clickable indicators: Hotel (green
  // = placed in a room running that day;
  // red = still needs a room) and Ride (green = driving or holding
  // a claimed seat that day; red = still needs a ride). A day the
  // person doesn't attend (a partial RSVP not covering that day)
  // shows both pills gray — "not participating", not a gap to
  // fill. The hotel indicator is a dash only when the event has
  // no hotel block at all. Each row's name carries its RSVP basis
  // ("going" or "partial · <days>") so a surprising color traces
  // to its record; a person with several RSVP rows shows each
  // distinct basis.
  const statusTableHTML = () => {
    const tableDays = evDays.length ? evDays : [dayPayloads[0].day];
    const dpFor = (ds) => dayPayloads.find((d) => d.day === ds) || dayPayloads[0];
    const attNames = (ds) => new Set((dpFor(ds).t.attendees || []).map((a) => normName(a.person_name)));
    const rideNames = (ds) => {
      const dp = dpFor(ds).t, s = new Set();
      (dp.carpools || []).forEach((c) => {
        if (c.driver_name) s.add(normName(c.driver_name));
        (c.claims || []).forEach((x) => s.add(normName(x.person_name)));
      });
      return s;
    };
    const hotelNames = (ds) => {
      const s = new Set();
      if (!t.hotel) return s;
      (t.hotel.rooms || []).forEach((rm) => {
        if (!roomRunsDay(rm, ds)) return;
        (rm.occupants || []).forEach((o) => {
          if (occMatchesDay(o, ds)) s.add(normName(o.person_name || `${o.first_name} ${o.last_name}`));
        });
      });
      return s;
    };
    const basisOf = (a) => a.status === "partial" && a.days && a.days.length
      ? `partial · ${a.days.map(dayLabel).join(", ")}` : (a.status || "");
    const byName = new Map();
    (t.all_attendees || []).forEach((a) => {
      const k = normName(a.person_name);
      const basis = basisOf(a);
      if (!byName.has(k)) byName.set(k, {name: a.person_name, kind: a.person_kind, bases: basis ? [basis] : []});
      else {
        if (a.person_kind === "student") byName.get(k).kind = "student";
        if (basis && !byName.get(k).bases.includes(basis)) byName.get(k).bases.push(basis);
      }
    });
    const rows = [...byName.values()].sort((a, b) =>
      (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === "student" ? -1 : 1)));
    const hotelLine = t.hotel
      ? `<b>${esc(t.hotel.name)}</b>${t.hotel.address ? ` · ${esc(t.hotel.address)}` : ""}${(t.hotel.check_in && t.hotel.check_out) ? ` · ${esc(t.hotel.check_in)} → ${esc(t.hotel.check_out)}` : (evDays.length > 1 ? ` · ${evDays[0]} → ${evDays[evDays.length - 1]}` : (evDays[0] ? ` · ${evDays[0]}` : ""))}`
      : "No hotel block for this event.";
    return `<div class="card"><h3>Logistics status</h3>
    <p class="sub">${hotelLine}</p>
    <p class="sub">Green = assigned for that day, red = still needed, gray = not attending that day, — = not needed or no hotel block.</p>
    <div style="overflow-x:auto"><table class="acct"><thead><tr><th>Person</th>${tableDays.map((ds, i) => `<th>Day ${i + 1}${ds ? `<div class="sub">${dayLabel(ds)}</div>` : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.kind === "parent" ? ` <span class="sub">(parent)</span>` : ""}${r.bases.length ? `<div class="sub">${esc(r.bases.join("; "))}</div>` : ""}</td>${tableDays.map((ds) => {
      if (!attNames(ds).has(normName(r.name))) return `<td><span class="pill gray">Hotel</span> <span class="pill gray">Ride</span></td>`;
      const hotel = (!needsHotel || !t.hotel) ? `<span class="sub">—</span>`
        : `<span class="pill ${hotelNames(ds).has(normName(r.name)) ? "green" : "red"}">Hotel</span>`;
      const ride = !needsRides ? `<span class="sub">—</span>`
        : `<span class="pill ${rideNames(ds).has(normName(r.name)) ? "green" : "red"}">Ride</span>`;
      return `<td>${hotel} ${ride}</td>`;
    }).join("")}</tr>`).join("") || `<tr><td colspan="${tableDays.length + 1}"><span class="sub">Nobody RSVP'd yet.</span></td></tr>`}</tbody></table></div></div>`;
  };
  // Logistics tables 2 and 3: read-only holistic views under the
  // status table, visible to everyone, with no actions. Table 2 is
  // one row per vehicle per day it runs — driver, tools loaded in
  // that vehicle (tools are per-trip, so the same tools show on
  // every day the vehicle runs), and riders seated that day
  // (claimed seats only; waitlisted people are not riders yet).
  // Vehicle numbers are stable across days (first-seen order in
  // the trip). Table 3 is one row per room per day it is allocated
  // for — capacity as x/y and that day's occupants.
  const logisticsDayCell = (ds, di) => `<b>Day ${di + 1}</b>${ds ? `<div class="sub">${dayLabel(ds)}</div>` : ""}`;
  const logisticsCarsHTML = () => {
    const tableDays = evDays.length ? evDays : [dayPayloads[0].day];
    const dpFor = (ds) => dayPayloads.find((d) => d.day === ds) || dayPayloads[0];
    const tripTools = dayPayloads[0].t.tools || [];
    const numOf = new Map();
    tableDays.forEach((ds) => (dpFor(ds).t.carpools || []).forEach((c) => {
      if (!numOf.has(c.id)) numOf.set(c.id, numOf.size + 1);
    }));
    const rows = [];
    tableDays.forEach((ds, di) => {
      const dayCars = (dpFor(ds).t.carpools || []);
      dayCars.forEach((c, ci) => {
        rows.push({ds, di, num: numOf.get(c.id), c,
          tools: tripTools.filter((x) => x.vehicle_type === "carpool" && x.vehicle_id === c.id),
          riders: (c.claims || []).map((x) => x.person_name),
          span: ci === 0 ? dayCars.length : 0});
      });
    });
    return `<div class="card"><h3>Cars, riders &amp; tools</h3>
    <p class="sub">One row per vehicle per day it runs.</p>
    ${rows.length ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Day</th><th>Vehicle</th><th>Driver</th><th>Tools / robots</th><th>Riders</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="lday-${r.di % 2 === 0 ? "odd" : "even"}">${r.span ? `<td rowspan="${r.span}">${logisticsDayCell(r.ds, r.di)}</td>` : ""}
      <td><b>Vehicle ${r.num}</b>${vehicleLine(r.c.vehicle)}</td>
      <td><b>${esc(r.c.driver_name)}</b></td>
      <td>${r.tools.length ? r.tools.map((x) => `<div>${esc(x.name)}${x.qty > 1 ? ` ×${x.qty}` : ""}</div>`).join("") : '<span class="sub">—</span>'}</td>
      <td>${r.riders.length ? r.riders.map((n) => `<div>${esc(n)}</div>`).join("") : '<span class="sub">—</span>'}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="sub">No vehicles posted for this event yet.</p>`}</div>`;
  };
  const logisticsRoomsHTML = () => {
    if (!t.hotel) return `<div class="card"><h3>Hotel rooms</h3><p class="sub">No hotel block for this event.</p></div>`;
    const tableDays = evDays.length ? evDays : [dayPayloads[0].day];
    const rows = [];
    tableDays.forEach((ds, di) => {
      const dayRooms = (t.hotel.rooms || []).filter((r) => roomRunsDay(r, ds));
      dayRooms.forEach((r, ri) => {
        rows.push({ds, di, r, occ: (r.occupants || []).filter((o) => occMatchesDay(o, ds)),
          span: ri === 0 ? dayRooms.length : 0});
      });
    });
    return `<div class="card"><h3>Hotel rooms</h3>
    <p class="sub">One row per room per day it is allocated for.</p>
    ${rows.length ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Day</th><th>Room</th><th>Capacity</th><th>Occupants</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="lday-${r.di % 2 === 0 ? "odd" : "even"}">${r.span ? `<td rowspan="${r.span}">${logisticsDayCell(r.ds, r.di)}</td>` : ""}
      <td><b>${esc(r.r.label)}</b>${r.r.room_number ? `<div class="sub">room #${esc(r.r.room_number)}</div>` : ""}</td>
      <td><span class="pill ${r.occ.length >= r.r.capacity ? "red" : "green"}">${r.occ.length}/${r.r.capacity}</span></td>
      <td>${r.occ.length ? r.occ.map((o) => `<div>${esc(o.person_name || [o.first_name, o.last_name].filter(Boolean).join(" "))}</div>`).join("") : '<span class="sub">—</span>'}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="sub">No rooms allocated for this event yet.</p>`}</div>`;
  };
  // Fleet for Carpool: every car registered for this event, visible
  // to everyone. Edit / Remove belong to the driver (or a mentor);
  // riders are the union of claimed seats across the trip days.
  const fleetHTML = () => {
    const cars = t.all_carpools || [];
    const ridersOf = (cid) => {
      const names = [];
      dayPayloads.forEach((dp) => (dp.t.carpools || []).forEach((c) => {
        if (c.id !== cid) return;
        (c.claims || []).forEach((x) => { if (!names.includes(x.person_name)) names.push(x.person_name); });
      }));
      return names;
    };
    return `<div class="card"><h3>Fleet for Carpool</h3>
    <p class="sub">Every car registered for this event — visible to everyone. Only the driver (or a mentor) can edit or remove a vehicle.</p>
    ${cars.length ? `<div style="overflow-x:auto"><table class="acct"><thead><tr><th>Driver</th><th>Vehicle</th><th>Days</th><th>Seats</th><th>Riders</th><th>Actions</th></tr></thead>
    <tbody>${cars.map((c) => {
      const riders = ridersOf(c.id);
      const acts = (MENTOR() || c.driver_user_id === ME.id)
        ? `<button class="btn small ghost" data-fledit="${c.id}">Edit</button><button class="btn small ghost" data-fldel="${c.id}">Remove</button>` : "";
      return `<tr id="fl-row-${c.id}"><td><b>${esc(c.driver_name)}</b></td>
      <td>${vehicleLine(c.vehicle)}<div class="sub">${esc(c.depart_from || "")} · ${esc(c.depart_time || "")} · Return: ${esc(c.return_info || "—")}</div>${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ""}</td>
      <td>${multi ? (c.days && c.days.length ? c.days.map(dayLabel).join(", ") : "every day") : "This event"}</td>
      <td>${c.seats} seats</td>
      <td>${riders.map((n) => `<span class="pill">${esc(n)}</span>`).join(" ") || '<span class="sub">none yet</span>'}</td>
      <td>${acts || '<span class="sub">—</span>'}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<p class="sub">No cars registered yet.</p>`}</div>`;
  };
  const toolsCardHTML = () => `<div class="card"><h3>Tool sign-up</h3>
  <p class="sub">Mentors list what the event needs; tools ride in event carpools. Every tool starts unassigned until a mentor or its vehicle's driver confirms it.</p>
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
    // the pool (no vehicle), green once it rides in a car. A
    // vehicle id pointing at a deleted vehicle counts as unassigned.
    let veh = '<span class="pill red">Unassigned</span>';
    if (x.vehicle_type === "carpool") {
      const c = allCars.find((c) => c.id === x.vehicle_id);
      veh = c ? `<span class="pill green">${esc(c.driver_name)}'s car</span>${vehicleLine(c.vehicle)}` : '<span class="pill red">Unassigned</span>';
    }
    // Actions: mentors assign anywhere + manage the pool; parents
    // only their own vehicles (assign unassigned, release their own);
    // students read-only.
    let acts = "";
    const ownVehicles = [
      ...allCars.filter((c) => c.driver_user_id === ME.id)
        .map((c) => ({type: "carpool", id: c.id, label: `${c.driver_name}'s car`}))];
    const ownsThis = !!x.vehicle_type && ownVehicles.some((o) => o.type === x.vehicle_type && o.id === x.vehicle_id);
    if (MENTOR()) {
      const opts = vehOptsFor(x);
      acts += opts
        ? `<select id="tls-${x.id}">${opts}</select><button class="btn small" data-tassign="${x.id}">${x.vehicle_type ? "Move" : "Assign"}</button>`
        : `<span class="sub">No haulers yet — post a carpool ride above.</span>`;
      if (x.vehicle_type) acts += ` <button class="btn small ghost" data-trelease="${x.id}">Release</button>`;
      acts += ` <button class="btn small ghost" data-tedit="${x.id}">Edit</button><button class="btn small ghost" data-tdel="${x.id}">Delete</button>`;
    } else if (ME.role === "parent") {
      if (!x.vehicle_type && ownVehicles.length === 1) {
        const o = ownVehicles[0];
        acts += `<button class="btn small" data-tassign-own="${x.id}" data-tvt="${o.type}" data-tvid="${o.id}">Load in my car</button>`;
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
  </div>`;
  v.innerHTML = `
  <div class="card"><h2>Travel &amp; Logistics</h2>
  ${(() => {
    const dayParts = [];
    if (needsRides) dayParts.push("rides");
    if (needsHotel) dayParts.push("rooms");
    const blurb = multi
      ? `${dayParts.length ? `Each trip day expands to its own ${dayParts.join(" and ")} tables.` : ""}${needsTools ? " Tools are for the whole trip." : ""}`.trim()
      : [needsRides ? "Carpools" : null, needsTools ? "tool sign-up" : null, needsHotel ? "hotel assignments" : null].filter(Boolean).join(", ");
    return blurb ? `<p class="sub">${multi ? blurb : `${blurb} — organized per event.`}</p>` : "";
  })()}
  <div class="bubbles">${events.map((e) => `<button class="bubble ${e.id === travelEventId ? "active" : ""}" data-ev="${e.id}">${esc(e.title)}</button>`).join("")}</div>
  ${multi && (needsRides || needsHotel) ? `<div class="row" style="margin-top:8px"><button class="btn small ghost" id="td-expand-all">Expand all days</button><button class="btn small ghost" id="td-collapse-all">Collapse all days</button></div>` : ""}</div>

  ${statusTableHTML()}
  ${needsRides ? logisticsCarsHTML() : ""}
  ${needsHotel ? logisticsRoomsHTML() : ""}
  ${needsRides ? fleetHTML() : ""}
  ${needsRides ? postRideCard : ""}

  ${multi
    ? dayPayloads.map((dp, i) => daySection(dp, i)).join("")
    : (needsRides ? `<div class="card"><h3>Carpools</h3>${ridesTables(dayPayloads[0])}</div>` : "")}

  ${needsTools ? toolsCardHTML() : ""}

  ${needsHotel && (t.hotel || multi) && MENTOR() ? `<div class="card"><h3>Hotel assignments</h3>
  ${t.hotel ? (multi
    ? hotelTopHTML(t.hotel, {evDays})
    : hotelHTML(t.hotel, {day: dayPayloads[0].day, dayAttendees: dayPayloads[0].t.attendees, placeOpts: placeOptsForDay(dayPayloads[0])})) : `
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
  </div>` : ""}
  ${needsHotel && !MENTOR() && t.hotel && !multi ? `<div class="card"><h3>Hotel assignments</h3>
  ${roomsTableHTML(t.hotel, dayPayloads[0].day, placeOptsForDay(dayPayloads[0]), {editableNumber: true, showEdit: false})}
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
  // Post a ride toggle: collapsed by default; toggling flips
  // visibility only, so an in-progress form survives.
  const cpt = $("cp-toggle");
  if (cpt) cpt.addEventListener("click", () => {
    postRideOpen = !postRideOpen;
    const w = $("cp-form-wrap");
    if (w) w.classList.toggle("hidden", !postRideOpen);
    const lbl = cpt.querySelector("span");
    if (lbl) lbl.textContent = postRideOpen ? "▲ hide form" : "▼ show form";
  });
  const cpAdd = $("cp-add");
  if (cpAdd) cpAdd.addEventListener("click", async () => {
    const seats = parseInt($("cp-seats").value, 10);
    if (!seats || seats < 1) return toast("Seats are required.");
    const body = {event_id: travelEventId, seats,
      depart_from: $("cp-from").value.trim(), depart_time: $("cp-dt").value.trim(),
      return_info: $("cp-ret").value.trim(), notes: $("cp-notes").value.trim(),
      vehicle: {plate: $("cp-vplate").value.trim(), color: $("cp-vcolor").value.trim(),
        make: $("cp-vmake").value.trim(), model: $("cp-vmodel").value.trim()}};
    // Mentors/admins may post for a parent chosen in the driver
    // dropdown; everyone else drives their own car (the server
    // enforces both rules, including the driver's RSVP attendance).
    const drvSel = $("cp-driver");
    if (drvSel && drvSel.tagName === "SELECT" && drvSel.value) {
      body.driver_user_id = parseInt(drvSel.value, 10);
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
  // pre-filled form row under that day's table row; the driver is
  // fixed at registration and shows as static text.
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
    // The driver is fixed at registration — static text, never a
    // dropdown: nobody reassigns a car to another driver.
    const driverField = () =>
      `<div class="field"><label>Driver name</label><input disabled value="${esc(c.driver_name)}"></div>`;
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
    $("ep-cancel-" + c.id).addEventListener("click", () => tr.remove());
    $("ep-save-" + c.id).addEventListener("click", async () => {
      const seats = parseInt($("ep-seats-" + c.id).value, 10);
      if (!seats || seats < 1) return toast("Seats are required.");
      const body = {seats,
        depart_from: $("ep-from-" + c.id).value.trim(), depart_time: $("ep-dt-" + c.id).value.trim(),
        return_info: $("ep-ret-" + c.id).value.trim(), notes: $("ep-notes-" + c.id).value.trim(),
        vehicle: {plate: $("ep-vplate-" + c.id).value.trim(), color: $("ep-vcolor-" + c.id).value.trim(),
          make: $("ep-vmake-" + c.id).value.trim(), model: $("ep-vmodel-" + c.id).value.trim()}};

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
  // Fleet edit / remove: the driver-owner or a mentor. Edit inserts
  // a pre-filled form row under the fleet row (driver fixed, days
  // editable); remove confirms, like the day-table remove.
  v.querySelectorAll("[data-fledit]").forEach((b) => b.addEventListener("click", () => {
    const c = (t.all_carpools || []).find((x) => x.id === +b.dataset.fledit);
    if (!c) return;
    const row = $("fl-row-" + c.id);
    if (!row) return;
    const prev = $("fl-edit-" + c.id);
    if (prev) prev.remove();
    const veh = c.vehicle || {};
    const tr = document.createElement("tr");
    tr.id = "fl-edit-" + c.id;
    tr.innerHTML = `<td colspan="6"><div class="grid3">
      <div class="field"><label>Driver name</label><input disabled value="${esc(c.driver_name)}"></div>
      <div class="field"><label>Seats *</label><input id="fl-seats-${c.id}" inputmode="numeric" value="${c.seats}"></div>
      <div class="field"><label>Departure point</label><input id="fl-from-${c.id}" value="${esc(c.depart_from || "")}"></div>
      <div class="field"><label>Departure time</label><input id="fl-dt-${c.id}" value="${esc(c.depart_time || "")}"></div>
      <div class="field"><label>Return plan</label><input id="fl-ret-${c.id}" value="${esc(c.return_info || "")}"></div>
      <div class="field"><label>Notes</label><input id="fl-notes-${c.id}" value="${esc(c.notes || "")}"></div>
      <div class="field"><label>License plate</label><input id="fl-vplate-${c.id}" value="${esc(veh.plate || "")}"></div>
      <div class="field"><label>Color</label><input id="fl-vcolor-${c.id}" value="${esc(veh.color || "")}"></div>
      <div class="field"><label>Make</label><input id="fl-vmake-${c.id}" value="${esc(veh.make || "")}"></div>
      <div class="field"><label>Model</label><input id="fl-vmodel-${c.id}" value="${esc(veh.model || "")}"></div>
    </div>
    ${multi ? `<div class="row" style="margin-top:6px"><span class="sub">Days this car runs:</span>
      ${evDays.map((ds) => `<label class="sub" style="margin-right:8px"><input type="checkbox" class="fl-day" data-day="${ds}"${!c.days || !c.days.length || c.days.includes(ds) ? " checked" : ""}> ${dayLabel(ds)}</label>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:6px"><button class="btn small" id="fl-save-${c.id}">Save</button><button class="btn small ghost" id="fl-cancel-${c.id}">Cancel</button></div></td>`;
    row.after(tr);
    $("fl-cancel-" + c.id).addEventListener("click", () => tr.remove());
    $("fl-save-" + c.id).addEventListener("click", async () => {
      const seats = parseInt($("fl-seats-" + c.id).value, 10);
      if (!seats || seats < 1) return toast("Seats are required.");
      const body = {seats,
        depart_from: $("fl-from-" + c.id).value.trim(), depart_time: $("fl-dt-" + c.id).value.trim(),
        return_info: $("fl-ret-" + c.id).value.trim(), notes: $("fl-notes-" + c.id).value.trim(),
        vehicle: {plate: $("fl-vplate-" + c.id).value.trim(), color: $("fl-vcolor-" + c.id).value.trim(),
          make: $("fl-vmake-" + c.id).value.trim(), model: $("fl-vmodel-" + c.id).value.trim()}};
      const flBoxes = [...tr.querySelectorAll("input.fl-day")];
      if (flBoxes.length) {
        const days = flBoxes.filter((x) => x.checked).map((x) => x.dataset.day);
        if (!days.length) return toast("Pick at least one day for the ride.");
        body.days = days;
      }
      try {
        await PATCH(`/api/carpools/${c.id}`, body);
        toast("Ride updated."); renderTravel();
      } catch (e) { toast("Error: " + e.message); }
    });
  }));
  v.querySelectorAll("[data-fldel]").forEach((b) => b.addEventListener("click", async () => {
    const c = (t.all_carpools || []).find((x) => x.id === +b.dataset.fldel);
    if (!c) return;
    const riderNames = new Set();
    dayPayloads.forEach((dp) => (dp.t.carpools || []).forEach((cc) => {
      if (cc.id !== c.id) return;
      (cc.claims || []).forEach((x) => riderNames.add(x.person_name));
      (cc.waitlist || []).forEach((x) => riderNames.add(x.person_name));
    }));
    if (!confirm(`Remove this car from the pool?${riderNames.size ? ` ${riderNames.size} rider(s) will be released.` : ""}`)) return;
    try {
      const r = await DEL(`/api/carpools/${c.id}`);
      toast(r.tools_unassigned ? `Car removed from the pool; ${r.tools_unassigned} tool(s) back in the pool.` : "Car removed from the pool."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const day = b.dataset.claimday || null;
    const sel = $("cps-" + b.dataset.claim + "-" + (day || "all"));
    if (!sel) return;
    if (!sel.value) return toast("Pick a rider to place.");
    const p = JSON.parse(sel.value.replace(/&#39;/g, "'"));
    try {
      const r = await POST(`/api/carpools/${b.dataset.claim}/claims`, {
        member_id: p.member_id, person_kind: p.kind, day,
        person_name: p.name.replace(/ \((student|parent)\)$/, "")});
      toast(r.status === "waitlisted" ? "Car is full — added to the waitlist." : (r.moved ? "Seat moved." : "Seat claimed."));
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
    tr.innerHTML = `<td colspan="3"><div class="row"><span class="sub">Days this room is allocated for:</span>
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
    const selfPlace = sel.value === "self";
    const parentPlace = sel.value.startsWith("parent:");
    const mid = (selfPlace || parentPlace) ? null : parseInt(sel.value, 10);
    if (!selfPlace && !parentPlace && !mid) return toast("Pick an occupant to place.");
    try {
      const r = await POST(`/api/rooms/${b.dataset.place}/occupants`,
        selfPlace ? {member_id: null, person_name: ME.name, day}
        : parentPlace ? {member_id: null, person_name: sel.value.slice("parent:".length), day}
                  : {member_id: mid, day});
      toast(r.moved ? "Moved to this room." : "Placed."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-unplace]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    await DEL(`/api/room_occupants/${a.dataset.unplace}`);
    toast("Removed from room."); renderTravel();
  }));
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
  // Everyone attending that day can hold a bed now — students by
  // member row, parents by name-only row — so the gap line lists
  // every unplaced attendee, not just students.
  const people = dedupePeople((dayAttendees || []).filter((a) => a.person_kind === "student" || a.person_kind === "parent"),
    (a) => normName(a.person_name));
  const placed = placedIdsForDay(h, day);
  // Name-aware like the place picker: a duplicate row must not list
  // its person as needing a room when the other row is placed.
  // Name-only occupants (mentors, placed parents) carry person_name,
  // not first/last names.
  const placedNames = new Set();
  (h.rooms || []).forEach((r) => {
    if (!roomRunsDay(r, day)) return;
    (r.occupants || []).forEach((o) => {
      if (occMatchesDay(o, day)) placedNames.add(normName(o.person_name || `${o.first_name} ${o.last_name}`));
    });
  });
  // A parent row's member_id is their child's id — the child's bed
  // is not the parent's bed — so parent rows match by name only.
  const isPlaced = (a) => a.person_kind === "parent"
    ? placedNames.has(normName(a.person_name))
    : (placed.has(a.member_id) || placedNames.has(normName(a.person_name)));
  const needs = people.filter((a) => !isPlaced(a));
  return `<p class="sub">Needs a room: ${needs.length ? needs.map((a) => esc(a.person_name)).join(", ") : "everyone has a room."}</p>`;
}
function roomsTableHTML(h, day, placeOpts, opts) {
  const dayKey = day || "all";
  const rooms = (h.rooms || []).filter((r) => roomRunsDay(r, day));
  if (!(h.rooms || []).length) return '<p class="sub">No rooms yet — add one above.</p>';
  if (!rooms.length) return '<p class="sub">No rooms allocated for this day yet.</p>';
  return `<div style="overflow-x:auto"><table class="acct" style="margin-top:8px"><thead><tr><th>Room</th><th>Occupants</th><th>Actions</th></tr></thead><tbody>
  ${rooms.map((r) => {
    const occ = (r.occupants || []).filter((o) => occMatchesDay(o, day));
    const occPills = occ.map((o) => {
      // Name-only occupants (a mentor placed themself) carry
      // person_name; member rows carry first/last names.
      const oname = o.person_name || [o.first_name, o.last_name].filter(Boolean).join(" ");
      return `<span class="pill">${esc(oname)}${canReleaseSeat({member_id: o.member_id, person_kind: "student"}) ? ` <a href="#" data-unplace="${o.id}" title="remove">\u2715</a>` : ""}</span>`;
    }).join("");
    const editCell = (opts.showEdit && MENTOR()) ? `<div class="row" style="margin-top:4px"><button class="btn small ghost" data-roomedit="${r.id}" data-roomday="${day || ""}">Edit</button></div>` : "";
    // Placement is mentors only.
    const canPlace = MENTOR();
    const placeCell = canPlace ? `<div class="row"><select id="plc-${r.id}-${dayKey}">
        <option value="">Place occupant…</option>${placeOpts}</select>
        <button class="btn small" data-place="${r.id}" data-placeday="${day || ""}">Place</button></div>`
      : `<span class="sub">Placement is by a mentor.</span>`;
    return `<tr id="rm-row-${r.id}-${dayKey}"><td><b>${esc(r.label)}</b>
      ${r.room_number ? `<div class="sub">room #${esc(r.room_number)}</div>` : ""}
      ${opts.editableNumber && MENTOR() ? `<input class="mini" id="rn-${r.id}" value="${esc(r.room_number || "")}" placeholder="actual room #" style="max-width:120px">` : ""}
      <div><span class="pill ${occ.length >= r.capacity ? "red" : "green"}">${occ.length}/${r.capacity} occupied</span></div>
      ${bedSummary(r.beds) ? `<div class="sub">${esc(bedSummary(r.beds))}</div>` : ""}
      ${opts.showEdit ? `<div class="sub">Runs: ${(r.days && r.days.length ? r.days.map(dayLabel).join(", ") : "every day")}</div>` : ""}</td>
      <td>${occPills || '<span class="sub">empty</span>'}</td>
      <td>${placeCell}${editCell}</td></tr>`;
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
function hotelHeaderHTML(h) {
  return `
  <div class="sub"><b>${esc(h.name)}</b> · ${esc(h.address || "")} ·
    ${esc(h.check_in || "")} → ${esc(h.check_out || "")}</div>
  ${h.notes ? `<div class="sub">${esc(h.notes)}</div>` : ""}`;
}
// Single-day hotel card: header + gap lines + add-room form + rooms
// table, all for the trip's one day.
function hotelHTML(h, args) {
  return `${hotelHeaderHTML(h)}
  <h3>Room status</h3>
  <p class="sub">Who still needs a room for this trip. Placed members show in the table below.</p>
  ${roomGapHTML(h, args.dayAttendees, args.day)}
  <h3>Rooms</h3>
  <p class="sub">The block is already booked.</p>
  ${addRoomFormHTML(false, [])}
  ${roomsTableHTML(h, args.day, args.placeOpts, {editableNumber: true, showEdit: false})}
`;
}
// Multi-day hotel card: block info + add-room form (with day picks).
// The rooms tables live in the day sections,
// not here — a room allocated for specific days belongs to those
// days' tables.
function hotelTopHTML(h, args) {
  return `${hotelHeaderHTML(h)}
  <h3>Rooms</h3>
  <p class="sub">The block is already booked.</p>
  ${addRoomFormHTML(true, args.evDays)}
`;
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
// ---- Parts & purchasing (mentor-managed, robot building) ----
// Flow (settled 2026-10-30): student picks from the catalog (or files
// free-text when the part isn't there) -> pending mentor approval ->
// mentor links an existing catalog part or records a new one, then
// approves -> fulfillment is gated on the reference.
let partsData = { parts: [], reqs: [], batches: [] };
let editingPartId = null;
let reviewReqId = null;
let reviewMode = "review";

const PART_PILL = (s) => s === "received" ? "green" : s === "denied" ? "red" : s === "pending" ? "steel" : "blue";
const BATCH_PILL = (s) => s === "received" ? "green" : s === "ordered" ? "blue" : "steel";
const REIMB_LABEL = { not_submitted: "Not submitted", submitted: "Submitted", reimbursed: "Reimbursed" };

function partLinkHTML(p) {
  if (!p || !p.order_link) return "";
  return ` <a href="${esc(p.order_link)}" target="_blank" rel="noopener">Order link ↗</a>`;
}

function partOptionsHTML(parts, selectedId, includeNew) {
  let out = `<option value="">— Not in catalog —</option>`;
  for (const p of parts) {
    const sel = selectedId === p.id ? " selected" : "";
    const sku = p.sku ? " (" + esc(p.sku) + ")" : "";
    out += `<option value="${p.id}"${sel}>${esc(p.name)}${sku}</option>`;
  }
  if (includeNew) out += `<option value="__new__">＋ Record a new catalog part…</option>`;
  return out;
}

function subsystemOptionsHTML(parts) {
  const toks = new Set();
  for (const p of parts) {
    for (const t of (p.subsystems || "").split("/")) {
      const v = t.trim();
      if (v) toks.add(v);
    }
  }
  let out = `<option value="">All subsystems</option>`;
  for (const t of [...toks].sort()) out += `<option value="${esc(t)}">${esc(t)}</option>`;
  return out;
}

function partRowHTML(p) {
  const cost = p.cost_each == null ? "—" : "$" + Number(p.cost_each).toFixed(2);
  const mentorBtns = MENTOR() ? ` <button class="btn small ghost" data-editpart="${p.id}">Edit</button> <button class="btn small danger" data-delpart="${p.id}">Delete</button>` : "";
  return `<tr data-sub="${esc(p.subsystems || "")}">
    <td>${esc(p.name)}${partLinkHTML(p)}</td>
    <td>${esc(p.sku || "—")}</td>
    <td>${esc(p.vendor || "—")}</td>
    <td>${cost}</td>
    <td>${p.on_hand || 0}</td>
    <td>${esc(p.subsystems || "—")}</td>
    <td>${p.request_count || 0}</td>
    <td><button class="btn small" data-reqpart="${p.id}">Request this</button>${mentorBtns}</td>
  </tr>`;
}

function reqRowHTML(r) {
  const part = r.part;
  let partCell = esc(r.part_name);
  if (part) {
    partCell = esc(part.name) + `<span class="sub">${part.sku ? esc(part.sku) : ""}${partLinkHTML(part)}</span>`;
    if (r.part_name !== part.name) partCell += `<div class="sub">as requested: ${esc(r.part_name)}</div>`;
  }
  let specCell = "—";
  if (r.spec) specCell = r.spec.startsWith("http") ? `<a href="${esc(r.spec)}" target="_blank" rel="noopener">Spec ↗</a>` : esc(r.spec);
  let acts = "";
  if (MENTOR()) {
    if (r.status === "pending") acts += `<button class="btn small" data-review="${r.id}">Review</button> `;
    if (r.status === "approved") {
      acts += `<button class="btn small ghost" data-statusact="${r.id}:assigned">Assign</button> `;
      if (r.method === "Order") acts += `<button class="btn small ghost" data-statusact="${r.id}:ordered">Mark ordered</button> `;
      else acts += `<button class="btn small ghost" data-statusact="${r.id}:received">Mark received</button> `;
    }
    if (r.status === "assigned") {
      if (r.method === "Order") acts += `<button class="btn small ghost" data-statusact="${r.id}:ordered">Mark ordered</button> `;
      else acts += `<button class="btn small ghost" data-statusact="${r.id}:received">Mark received</button> `;
    }
    if (r.status === "ordered") acts += `<button class="btn small ghost" data-statusact="${r.id}:received">Mark received</button> `;
    if (["pending", "approved", "denied"].includes(r.status)) acts += `<button class="btn small danger" data-delreq="${r.id}">Delete</button> `;
    if (r.status !== "pending") acts += `<button class="btn small ghost" data-editreq="${r.id}">Edit</button>`;
  }
  const needs = r.needs_catalog ? ` <span class="pill steel">Needs catalog entry</span>` : "";
  const reviewNote = r.review_note ? `<div class="sub">Review: ${esc(r.review_note)}</div>` : "";
  return `<tr data-status="${r.status}" data-needs="${r.needs_catalog ? 1 : 0}">
    <td>${partCell}</td>
    <td>${specCell}</td>
    <td>${r.qty}</td>
    <td>${esc(r.method)}</td>
    <td>${esc(r.requester_name || "—")}</td>
    <td>${esc(r.responsible || "—")}</td>
    <td><span class="pill ${PART_PILL(r.status)}">${r.status}</span>${needs}</td>
    <td>${esc(r.deliver_to || "—")}</td>
    <td>${esc(r.est_delivery || "—")}</td>
    <td>${esc(r.notes || "")}${reviewNote}</td>
    <td>${acts || "—"}</td>
  </tr>`;
}

function batchLineHTML(m, draft, bid) {
  const part = m.part;
  const cost = part && part.cost_each != null ? "$" + Number(part.cost_each).toFixed(2) : "—";
  const total = m.line_total != null ? "$" + Number(m.line_total).toFixed(2) : "—";
  const rm = draft ? ` <button class="btn small ghost" data-rmline="${m.id}" data-rmbatch="${bid}">Remove</button>` : "";
  return `<tr><td>${part ? esc(part.name) + partLinkHTML(part) : esc(m.part_name)}</td>
    <td>${m.qty}</td><td>${cost}</td><td>${total}</td>
    <td><span class="pill ${PART_PILL(m.status)}">${m.status}</span></td><td>${rm}</td></tr>`;
}

function invoiceLineHTML(f) {
  const link = MENTOR() ? `<a href="/api/invoices/${f.id}/file">${esc(f.filename)}</a>` : esc(f.filename);
  const del = MENTOR() ? ` <button class="btn small danger" data-delinv="${f.id}">Delete</button>` : "";
  const note = f.note ? " — " + esc(f.note) : "";
  const kb = f.size_bytes != null ? " (" + Math.round(f.size_bytes / 1024) + " KB)" : "";
  return `<div>${link}<span class="sub">${kb}${note}</span>${del}</div>`;
}

function batchAddOptionsHTML(b) {
  const eligible = partsData.reqs.filter((r) => r.method === "Order" && (r.status === "approved" || r.status === "assigned") && !r.batch_id && r.part && (r.part.vendor || "").toLowerCase() === (b.vendor || "").toLowerCase());
  let out = `<option value="">— pick an approved request —</option>`;
  for (const r of eligible) {
    const label = esc(r.part.name) + " ×" + r.qty + " — " + esc(r.requester_name || "");
    out += `<option value="${r.id}">${label}</option>`;
  }
  return out;
}

function batchCardHTML(b) {
  const lines = b.members.map((m) => batchLineHTML(m, b.status === "draft", b.id)).join("");
  const linesBlock = lines || `<tr><td colspan="6">No lines yet.</td></tr>`;
  const invs = b.invoices.map(invoiceLineHTML).join("");
  const reimb = MENTOR()
    ? `<select data-reimb="${b.id}"><option value="not_submitted"${b.reimbursement === "not_submitted" ? " selected" : ""}>Not submitted</option><option value="submitted"${b.reimbursement === "submitted" ? " selected" : ""}>Submitted</option><option value="reimbursed"${b.reimbursement === "reimbursed" ? " selected" : ""}>Reimbursed</option></select>`
    : esc(REIMB_LABEL[b.reimbursement] || b.reimbursement);
  const draftCtrls = b.status === "draft" ? `<div class="row"><div class="field"><label>Add an approved request</label><select id="pb-add-${b.id}">${batchAddOptionsHTML(b)}</select></div><button class="btn small" data-addline="${b.id}">Add line</button></div>
    <div class="row"><div class="field"><label>Confirmation number</label><input id="pb-conf-${b.id}" type="text"></div><button class="btn small" data-markordered="${b.id}">Mark ordered</button><button class="btn small danger" data-delbatch="${b.id}">Delete batch</button></div>` : "";
  const recvCtrl = b.status === "ordered" ? `<div class="row"><button class="btn small" data-markreceived="${b.id}">Mark received</button></div>` : "";
  const invForm = b.status !== "draft" ? `<div class="row mo"><div class="field"><label>Invoice file (PDF or image, 25MB max)</label><input id="pb-file-${b.id}" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif"></div><div class="field"><label>Note</label><input id="pb-note-${b.id}" type="text"></div><button class="btn small" data-upinv="${b.id}">Upload invoice</button></div>` : "";
  const unpriced = b.unpriced_lines ? `<span class="sub"> + ${b.unpriced_lines} line(s) without a catalog price, not in the total</span>` : "";
  const invHead = invs ? `<div><b>Invoices</b></div>` : "";
  const conf = b.confirmation_no ? `Confirmation: ${esc(b.confirmation_no)} · ` : "";
  const notes = b.notes ? ` · ${esc(b.notes)}` : "";
  return `<div class="card">
    <h3>${esc(b.vendor)} <span class="pill ${BATCH_PILL(b.status)}">${b.status}</span></h3>
    <p class="sub">${conf}Reimbursement: ${reimb}${notes}</p>
    <table><tr><th>Part</th><th>Qty</th><th>Each</th><th>Line total</th><th>Status</th><th></th></tr>${linesBlock}</table>
    <p><b>Total: $${b.total.toFixed(2)}</b>${unpriced}</p>
    <p><a href="/api/order-batches/${b.id}/quick-order.csv">Quick Order CSV</a></p>
    ${draftCtrls}${recvCtrl}${invForm}
    ${invHead}${invs}
  </div>`;
}

function partsStatsHTML(parts, reqs, batches) {
  const pending = reqs.filter((r) => r.status === "pending").length;
  const needs = reqs.filter((r) => r.needs_catalog).length;
  const awaiting = reqs.filter((r) => r.status === "approved" || r.status === "assigned").length;
  const inTransit = reqs.filter((r) => r.status === "ordered").length;
  const bySub = {};
  let unpriced = 0;
  for (const r of reqs) {
    if (!["approved", "assigned", "ordered", "received"].includes(r.status)) continue;
    if (!r.part || r.part.cost_each == null) { unpriced++; continue; }
    const k = r.major_component || "Unsorted";
    bySub[k] = (bySub[k] || 0) + r.part.cost_each * r.qty;
  }
  let subLines = "";
  for (const k of Object.keys(bySub).sort()) subLines += `<div>${esc(k)}: $${bySub[k].toFixed(2)}</div>`;
  const subBlock = subLines || `<p class="sub">Nothing committed yet.</p>`;
  let venLines = "";
  for (const b of batches) venLines += `<div>${esc(b.vendor)}: $${b.total.toFixed(2)} (${b.status})</div>`;
  const venBlock = venLines || `<p class="sub">No batches yet.</p>`;
  const unpricedNote = unpriced ? ` (${unpriced} request(s) without a catalog price, excluded)` : "";
  return `<div class="card"><h3>Planning</h3>
    <p>${pending} pending approval · ${needs} needing a catalog entry · ${awaiting} approved, awaiting fulfillment · ${inTransit} ordered, awaiting receipt</p>
    <p><b>Committed spend by subsystem</b>${unpricedNote}</p>
    ${subBlock}
    <p><b>Batch totals by vendor</b></p>
    ${venBlock}
  </div>`;
}

async function renderParts() {
  const v = $("view-parts");
  let parts, reqs, batches;
  try {
    const res = await Promise.all([GET("/api/parts"), GET("/api/part-requests"), GET("/api/order-batches")]);
    parts = res[0]; reqs = res[1]; batches = res[2];
  } catch (e) {
    toast("Error: " + e.message);
    return;
  }
  partsData = { parts, reqs, batches };
  const catalogRows = parts.map(partRowHTML).join("");
  const reqRows = reqs.map(reqRowHTML).join("");
  const batchCards = batches.map(batchCardHTML).join("");
  const meName = ME ? ME.name : "";
  const emptyCatalogNote = parts.length ? "" : `<p class="sub">The catalog is empty — mentors add parts below or import the team's order sheet (Export CSV gives you the template).</p>`;
  const emptyBatchNote = batches.length ? "" : `<p class="sub">No batches yet — mentors create one per vendor from approved requests.</p>`;
  v.innerHTML = `<h2>Parts &amp; Purchasing</h2>
  <p class="sub">Robot build parts: pick from the catalog, request what you need, mentors approve and order by vendor. Invoices live with their batch.</p>
  ${partsStatsHTML(parts, reqs, batches)}
  <div class="card"><h3>Catalog</h3>
    <div class="row"><div class="field"><label>Search</label><input id="pc-search" type="text" placeholder="Part name, SKU, vendor"></div>
    <div class="field"><label>Subsystem</label><select id="pc-sub">${subsystemOptionsHTML(parts)}</select></div></div>
    <table id="pc-table"><tr><th>Part</th><th>SKU</th><th>Vendor</th><th>Cost each</th><th>On hand</th><th>Subsystems</th><th>Requests</th><th></th></tr>${catalogRows}</table>
    ${emptyCatalogNote}
  </div>
  <div class="card mo"><h3 id="pc-form-title">Add a catalog part</h3>
    <div class="row"><div class="field"><label>Part name</label><input id="pc-name" type="text"></div>
    <div class="field"><label>SKU / part number</label><input id="pc-sku" type="text"></div></div>
    <div class="row"><div class="field"><label>Vendor</label><input id="pc-vendor" type="text" placeholder="Blank = derived from the link"></div>
    <div class="field"><label>Order link</label><input id="pc-link" type="text"></div></div>
    <div class="row"><div class="field"><label>Cost each</label><input id="pc-cost" type="number" min="0" step="0.01"></div>
    <div class="field"><label>On hand</label><input id="pc-onhand" type="number" min="0" step="1"></div></div>
    <div class="row"><div class="field"><label>Subsystems</label><input id="pc-subsystems" type="text" placeholder="e.g. Turret / Drivebase"></div>
    <div class="field"><label>Notes</label><input id="pc-notes" type="text"></div></div>
    <div class="row"><button class="btn" id="pc-part-submit">Add part</button><button class="btn ghost hidden" id="pc-cancel-edit">Cancel edit</button></div>
    <div class="row"><a href="/api/parts/export">Export CSV</a></div>
    <div class="row"><div class="field"><label>Import catalog CSV</label><input id="pc-import-file" type="file" accept=".csv"></div><button class="btn small" id="pc-import-btn">Import</button></div>
    <p class="sub">Import upserts by vendor + SKU (or vendor + name without a SKU) and never deletes.</p>
  </div>
  <div class="card" id="pf-form-card"><h3>Request a part</h3>
    <div class="field"><label>Catalog part</label><select id="pf-part">${partOptionsHTML(parts, null, false)}</select></div>
    <div id="pf-picked" class="hidden"><p class="sub" id="pf-picked-line"></p></div>
    <div id="pf-free">
      <div class="field"><label>Part name</label><input id="pf-name" type="text" placeholder="As you would describe it"></div>
      <div class="field"><label>Spec (STL file or vendor URL)</label><input id="pf-spec" type="text"></div>
    </div>
    <div class="row"><div class="field"><label>Qty</label><input id="pf-qty" type="number" min="1" value="1"></div>
    <div class="field"><label>Method</label><select id="pf-method"><option>Order</option><option>3d print</option><option>CNC</option></select></div></div>
    <div class="row"><div class="field"><label>Major component</label><input id="pf-comp" type="text" placeholder="e.g. Shooter"></div>
    <div class="field"><label>Deliver to</label><input id="pf-deliver" type="text" value="${esc(meName)}"></div></div>
    <div class="row"><div class="field"><label>Est. delivery</label><input id="pf-est" type="date"></div>
    <div class="field"><label>Notes</label><input id="pf-notes" type="text"></div></div>
    <button class="btn" id="pf-submit">File request</button>
    <p class="sub">Picking from the catalog files the request against that part. Not in the catalog? Describe it above and a mentor records it before approval.</p>
  </div>
  <div class="card"><h3>Requests</h3>
    <div class="row" id="pf-filters">
      <button class="btn small" data-reqfilter="all">All</button>
      <button class="btn small ghost" data-reqfilter="pending">Pending</button>
      <button class="btn small ghost" data-reqfilter="needs">Needs catalog</button>
      <button class="btn small ghost" data-reqfilter="approved">Approved</button>
      <button class="btn small ghost" data-reqfilter="assigned">Assigned</button>
      <button class="btn small ghost" data-reqfilter="ordered">Ordered</button>
      <button class="btn small ghost" data-reqfilter="received">Received</button>
      <button class="btn small ghost" data-reqfilter="denied">Denied</button>
    </div>
    <table id="pf-req-table"><tr><th>Part</th><th>Spec</th><th>Qty</th><th>Method</th><th>Request by</th><th>Responsible</th><th>Status</th><th>Deliver to</th><th>Est. delivery</th><th>Notes</th><th></th></tr>${reqRows}</table>
  </div>
  <div class="card mo"><h3>New order batch</h3>
    <div class="row"><div class="field"><label>Vendor</label><input id="pb-vendor" type="text" placeholder="e.g. WCP"></div>
    <div class="field"><label>Notes</label><input id="pb-notes" type="text"></div></div>
    <button class="btn" id="pb-create-btn">Create batch</button>
    <p class="sub">A batch groups one vendor's approved requests: quick links, a Quick Order CSV, a confirmation number, and its invoices.</p>
  </div>
  ${emptyBatchNote}
  ${batchCards}`;
  if (!MENTOR()) v.querySelectorAll(".mo").forEach((e) => e.remove());
  bindPartsView(v);
}

function filterCatalog() {
  const v = $("view-parts");
  const q = (v.querySelector("#pc-search").value || "").toLowerCase();
  const sub = v.querySelector("#pc-sub").value || "";
  v.querySelectorAll("#pc-table tr").forEach((row) => {
    if (!("sub" in row.dataset)) return;
    const okQ = !q || row.textContent.toLowerCase().includes(q);
    const okS = !sub || (row.dataset.sub || "").includes(sub);
    row.style.display = okQ && okS ? "" : "none";
  });
}

function filterReqRows(filter) {
  const v = $("view-parts");
  v.querySelectorAll("#pf-req-table tr").forEach((row) => {
    if (!("status" in row.dataset)) return;
    let show = true;
    if (filter === "needs") show = row.dataset.needs === "1";
    else if (filter !== "all") show = row.dataset.status === filter;
    row.style.display = show ? "" : "none";
  });
  v.querySelectorAll("[data-reqfilter]").forEach((b) => {
    const on = b.dataset.reqfilter === filter;
    b.classList.toggle("btn", true);
    b.classList.toggle("ghost", !on);
  });
}

function syncRequestForm() {
  const v = $("view-parts");
  const sel = v.querySelector("#pf-part");
  const picked = v.querySelector("#pf-picked");
  const free = v.querySelector("#pf-free");
  if (!sel) return;
  if (sel.value) {
    const p = partsData.parts.find((x) => String(x.id) === sel.value);
    if (p) {
      const cost = p.cost_each == null ? "no recorded cost" : "$" + Number(p.cost_each).toFixed(2) + " each";
      const link = p.order_link ? ` — <a href="${esc(p.order_link)}" target="_blank" rel="noopener">Order link ↗</a>` : "";
      const skuPart = p.sku ? " (" + esc(p.sku) + ")" : "";
      v.querySelector("#pf-picked-line").innerHTML = "From the catalog: " + esc(p.name) + skuPart + " · " + cost + link;
    }
    picked.classList.remove("hidden");
    free.classList.add("hidden");
  } else {
    picked.classList.add("hidden");
    free.classList.remove("hidden");
  }
}
function bindPartsView(v) {
  const q = (sel) => v.querySelector(sel);
  const qa = (sel) => [...v.querySelectorAll(sel)];
  const val = (sel) => { const el = q(sel); return el ? el.value.trim() : ""; };

  const search = q("#pc-search");
  if (search) search.addEventListener("input", filterCatalog);
  const sub = q("#pc-sub");
  if (sub) sub.addEventListener("change", filterCatalog);

  const pfPart = q("#pf-part");
  if (pfPart) pfPart.addEventListener("change", syncRequestForm);

  const pfSubmit = q("#pf-submit");
  if (pfSubmit) pfSubmit.addEventListener("click", async () => {
    const partId = q("#pf-part").value;
    const body = {
      qty: parseInt(q("#pf-qty").value || "1", 10),
      method: q("#pf-method").value,
      major_component: val("#pf-comp"),
      deliver_to: val("#pf-deliver"),
      est_delivery: val("#pf-est"),
      notes: val("#pf-notes"),
    };
    if (partId) body.part_id = parseInt(partId, 10);
    else {
      body.part_name = val("#pf-name");
      body.spec = val("#pf-spec");
      if (!body.part_name) { toast("Name the part or pick one from the catalog."); return; }
    }
    try {
      await POST("/api/part-requests", body);
      toast("Request filed — pending mentor approval.");
      renderParts();
    } catch (e) { toast("Error: " + e.message); }
  });

  qa("[data-reqpart]").forEach((b) => b.addEventListener("click", () => {
    const sel = q("#pf-part");
    sel.value = b.dataset.reqpart;
    syncRequestForm();
    const card = q("#pf-form-card");
    if (card) card.scrollIntoView();
  }));

  qa("[data-reqfilter]").forEach((b) => b.addEventListener("click", () => filterReqRows(b.dataset.reqfilter)));

  const resetPartForm = () => {
    editingPartId = null;
    ["#pc-name", "#pc-sku", "#pc-vendor", "#pc-link", "#pc-cost", "#pc-subsystems", "#pc-onhand", "#pc-notes"].forEach((s) => { const el = q(s); if (el) el.value = ""; });
    const t = q("#pc-form-title"); if (t) t.textContent = "Add a catalog part";
    const sb = q("#pc-part-submit"); if (sb) sb.textContent = "Add part";
    const cb = q("#pc-cancel-edit"); if (cb) cb.classList.add("hidden");
  };
  qa("[data-editpart]").forEach((b) => b.addEventListener("click", () => {
    const p = partsData.parts.find((x) => String(x.id) === b.dataset.editpart);
    if (!p) return;
    editingPartId = p.id;
    const set = (s, v2) => { const el = q(s); if (el) el.value = v2; };
    set("#pc-name", p.name); set("#pc-sku", p.sku || ""); set("#pc-vendor", p.vendor || "");
    set("#pc-link", p.order_link || ""); set("#pc-cost", p.cost_each == null ? "" : p.cost_each);
    set("#pc-subsystems", p.subsystems || ""); set("#pc-onhand", p.on_hand || 0); set("#pc-notes", p.notes || "");
    const t = q("#pc-form-title"); if (t) t.textContent = "Edit catalog part";
    const sb = q("#pc-part-submit"); if (sb) sb.textContent = "Save changes";
    const cb = q("#pc-cancel-edit"); if (cb) cb.classList.remove("hidden");
  }));
  const cancelEdit = q("#pc-cancel-edit");
  if (cancelEdit) cancelEdit.addEventListener("click", resetPartForm);
  const partSubmit = q("#pc-part-submit");
  if (partSubmit) partSubmit.addEventListener("click", async () => {
    const body = {
      name: val("#pc-name"), sku: val("#pc-sku"), vendor: val("#pc-vendor"),
      order_link: val("#pc-link"), cost_each: val("#pc-cost"),
      subsystems: val("#pc-subsystems"), on_hand: val("#pc-onhand"), notes: val("#pc-notes"),
    };
    if (!body.name) { toast("Part name is required."); return; }
    try {
      if (editingPartId) { await PATCH("/api/parts/" + editingPartId, body); toast("Part updated."); }
      else { await POST("/api/parts", body); toast("Part added to the catalog."); }
      resetPartForm();
      renderParts();
    } catch (e) { toast("Error: " + e.message); }
  });
  qa("[data-delpart]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this catalog part?")) return;
    try { await DEL("/api/parts/" + b.dataset.delpart); toast("Part deleted."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  const importBtn = q("#pc-import-btn");
  if (importBtn) importBtn.addEventListener("click", async () => {
    const file = q("#pc-import-file").files[0];
    if (!file) { toast("Choose a CSV file first."); return; }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/parts/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      const sk = data.skipped.length ? ", " + data.skipped.length + " skipped" : "";
      toast("Import: " + data.added + " added, " + data.updated + " updated" + sk + ".");
      renderParts();
    } catch (e) { toast("Error: " + e.message); }
  });

  qa("[data-review]").forEach((b) => b.addEventListener("click", () => openPartReview(parseInt(b.dataset.review, 10), "review")));
  qa("[data-editreq]").forEach((b) => b.addEventListener("click", () => openPartReview(parseInt(b.dataset.editreq, 10), "edit")));
  qa("[data-statusact]").forEach((b) => b.addEventListener("click", async () => {
    const sp = b.dataset.statusact.split(":");
    try { await PATCH("/api/part-requests/" + sp[0], { status: sp[1] }); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-delreq]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this request?")) return;
    try { await DEL("/api/part-requests/" + b.dataset.delreq); toast("Request deleted."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));

  const batchCreate = q("#pb-create-btn");
  if (batchCreate) batchCreate.addEventListener("click", async () => {
    const vendor = val("#pb-vendor");
    if (!vendor) { toast("Vendor is required."); return; }
    try { await POST("/api/order-batches", { vendor, notes: val("#pb-notes") }); toast("Batch created."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  });
  qa("[data-addline]").forEach((b) => b.addEventListener("click", async () => {
    const bid = b.dataset.addline;
    const rid = q("#pb-add-" + bid).value;
    if (!rid) { toast("Pick a request to add."); return; }
    try { await POST("/api/order-batches/" + bid + "/requests", { request_id: parseInt(rid, 10) }); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-rmline]").forEach((b) => b.addEventListener("click", async () => {
    try { await DEL("/api/order-batches/" + b.dataset.rmbatch + "/requests/" + b.dataset.rmline); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-markordered]").forEach((b) => b.addEventListener("click", async () => {
    const bid = b.dataset.markordered;
    const conf = val("#pb-conf-" + bid);
    if (!conf) { toast("Enter the confirmation number first."); return; }
    try { await PATCH("/api/order-batches/" + bid, { status: "ordered", confirmation_no: conf }); toast("Batch ordered."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-markreceived]").forEach((b) => b.addEventListener("click", async () => {
    try { await PATCH("/api/order-batches/" + b.dataset.markreceived, { status: "received" }); toast("Batch received."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-delbatch]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this draft batch? Its lines go back to approved.")) return;
    try { await DEL("/api/order-batches/" + b.dataset.delbatch); toast("Batch deleted."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-reimb]").forEach((s) => s.addEventListener("change", async () => {
    try { await PATCH("/api/order-batches/" + s.dataset.reimb, { reimbursement: s.value }); toast("Reimbursement updated."); }
    catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-upinv]").forEach((b) => b.addEventListener("click", async () => {
    const bid = b.dataset.upinv;
    const file = q("#pb-file-" + bid).files[0];
    if (!file) { toast("Choose an invoice file first."); return; }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("note", val("#pb-note-" + bid));
    try {
      const res = await fetch("/api/order-batches/" + bid + "/invoices", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      toast("Invoice uploaded.");
      renderParts();
    } catch (e) { toast("Error: " + e.message); }
  }));
  qa("[data-delinv]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this invoice?")) return;
    try { await DEL("/api/invoices/" + b.dataset.delinv); toast("Invoice deleted."); renderParts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
}

function openPartReview(id, mode) {
  const r = partsData.reqs.find((x) => x.id === id);
  if (!r) return;
  reviewReqId = id;
  reviewMode = mode;
  const title = $("part-review-title");
  if (title) title.textContent = (mode === "review" ? "Review request: " : "Edit request: ") + r.part_name;
  const sel = $("pr-part");
  if (sel) sel.innerHTML = partOptionsHTML(partsData.parts, r.part_id, true);
  const setVal = (el, v2) => { const e = $(el); if (e) e.value = v2; };
  setVal("pr-qty", r.qty);
  setVal("pr-responsible", r.responsible || "");
  setVal("pr-deliver", r.deliver_to || "");
  setVal("pr-est", r.est_delivery || "");
  setVal("pr-notes", r.notes || "");
  setVal("pr-note", r.review_note || "");
  const np = $("pr-newpart");
  if (np) np.classList.add("hidden");
  const toggleField = (el, show) => { const e = $(el); if (e && e.closest) { const f = e.closest(".field"); if (f) f.classList.toggle("hidden", !show); } };
  toggleField("pr-qty", mode === "edit");
  toggleField("pr-deliver", mode === "edit");
  toggleField("pr-est", mode === "edit");
  toggleField("pr-notes", mode === "edit");
  const ap = $("pr-approve"); if (ap) ap.classList.toggle("hidden", mode !== "review");
  const dn = $("pr-deny"); if (dn) dn.classList.toggle("hidden", mode !== "review");
  const sv = $("pr-save"); if (sv) sv.classList.toggle("hidden", mode !== "edit");
  const m = $("part-review-modal");
  if (m) m.classList.add("open");
}

function closePartReview() {
  const m = $("part-review-modal");
  if (m) m.classList.remove("open");
}

const _prPartSel = $("pr-part");
if (_prPartSel) _prPartSel.addEventListener("change", () => {
  const np = $("pr-newpart");
  if (np) np.classList.toggle("hidden", _prPartSel.value !== "__new__");
});
const _prApprove = $("pr-approve");
if (_prApprove) _prApprove.addEventListener("click", async () => {
  const r = partsData.reqs.find((x) => x.id === reviewReqId);
  if (!r) return;
  const sel = $("pr-part").value;
  const body = { action: "approve", responsible: $("pr-responsible").value.trim(), review_note: $("pr-note").value.trim() };
  if (sel === "__new__") {
    const name = $("pr-np-name").value.trim();
    if (!name) { toast("Name the new catalog part first."); return; }
    body.new_part = { name, sku: $("pr-np-sku").value.trim(), vendor: $("pr-np-vendor").value.trim(), order_link: $("pr-np-link").value.trim(), cost_each: $("pr-np-cost").value.trim() };
  } else if (sel) body.part_id = parseInt(sel, 10);
  if (r.method === "Order" && !body.part_id && !body.new_part) { toast("Link a catalog part first — or record it below."); return; }
  try { await POST("/api/part-requests/" + reviewReqId + "/review", body); closePartReview(); toast("Request approved."); renderParts(); }
  catch (e) { toast("Error: " + e.message); }
});
const _prDeny = $("pr-deny");
if (_prDeny) _prDeny.addEventListener("click", async () => {
  try { await POST("/api/part-requests/" + reviewReqId + "/review", { action: "deny", review_note: $("pr-note").value.trim() }); closePartReview(); toast("Request denied."); renderParts(); }
  catch (e) { toast("Error: " + e.message); }
});
const _prSave = $("pr-save");
if (_prSave) _prSave.addEventListener("click", async () => {
  const sel = $("pr-part").value;
  let partId = null;
  if (sel === "__new__") {
    const name = $("pr-np-name").value.trim();
    if (!name) { toast("Name the new catalog part first."); return; }
    try {
      const p = await POST("/api/parts", { name, sku: $("pr-np-sku").value.trim(), vendor: $("pr-np-vendor").value.trim(), order_link: $("pr-np-link").value.trim(), cost_each: $("pr-np-cost").value.trim() });
      partId = p.id;
    } catch (e) { toast("Error: " + e.message); return; }
  } else if (sel) partId = parseInt(sel, 10);
  const body = {
    part_id: partId,
    qty: parseInt($("pr-qty").value || "1", 10),
    responsible: $("pr-responsible").value.trim(),
    deliver_to: $("pr-deliver").value.trim(),
    est_delivery: $("pr-est").value.trim(),
    notes: $("pr-notes").value.trim(),
    review_note: $("pr-note").value.trim(),
  };
  try { await PATCH("/api/part-requests/" + reviewReqId, body); closePartReview(); toast("Request updated."); renderParts(); }
  catch (e) { toast("Error: " + e.message); }
});
const _prClose = $("pr-close");
if (_prClose) _prClose.addEventListener("click", closePartReview);
