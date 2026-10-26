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
let openRsvpLists = new Set();  // event ids whose RSVP list is expanded
let trackEventId = null, travelEventId = null;
let currentView = "events";
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeAvatarMenu(); closeLogoutModal(); } });
const _loYes = $("lo-yes");
if (_loYes) _loYes.addEventListener("click", () => doLogout());
const _loNo = $("lo-no");
if (_loNo) _loNo.addEventListener("click", closeLogoutModal);
const _loModal = $("logout-modal");
if (_loModal) _loModal.addEventListener("click", (e) => { if (e.target === _loModal) closeLogoutModal(); });
function showView(name) {
  closeAvatarMenu();
  closeLogoutModal();
  if (!ME && name !== "signup" && name !== "login") name = "login";
  currentView = name;
  savePlace();
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  const _views = {signup: renderSignup, queue: renderQueue, roster: renderRoster,
    events: renderEvents, tracking: renderTracking, tasks: renderTasks, travel: renderTravel,
    security: renderSecurity, profile: renderProfile, login: renderLogin};
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
    showView("events");
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
      showView("events");
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
  let totp = null;
  try { totp = await GET("/api/auth/totp-status"); } catch (e) {}
  const links = (u.links || []).map((l) => {
    let subs = l.assigned_subteam || "";
    if (!subs && l.prefs) {
      try { subs = (Array.isArray(l.prefs) ? l.prefs : JSON.parse(l.prefs)).join(", "); }
      catch (e) {}
    }
    return `<div class="sub">${esc(l.member_name)} · ${esc(l.kind === "self" ? "you" : "your child")}${l.school ? ` · ${esc(l.school)}` : ""}${subs ? ` · ${esc(subs)}` : ""}</div>`;
  }).join("") || `<div class="sub">No roster links yet — a mentor can link this account in Team accounts.</div>`;
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
  </div>
  <div class="card"><h3>Security</h3>
    <div class="field" style="max-width:320px"><label>Current password</label><input id="pf-cur" type="password" autocomplete="current-password"></div>
    <div class="field" style="max-width:320px"><label>New password (8+ characters)</label><input id="pf-new" type="password" autocomplete="new-password"></div>
    <div class="field" style="max-width:320px"><label>Confirm new password</label><input id="pf-new2" type="password" autocomplete="new-password"></div>
    ${totp && totp.enabled ? `<div class="field" style="max-width:320px"><label>Authenticator code (required to change password)</label><input id="pf-code" inputmode="numeric" autocomplete="one-time-code"></div>` : ""}
    <button class="btn" id="pf-pw">Change password</button>
    <div style="margin-top:16px">
      <p><span class="pill ${totp && totp.enabled ? "green" : ""}">Two-factor: ${totp && totp.enabled ? "ON" : "OFF"}</span>
      ${totp && totp.enabled ? `<span class="sub">${totp.backup_codes_remaining} recovery codes left.</span>` : ""}</p>
      <button class="btn ghost" id="pf-2fa">Manage two-factor authentication</button>
    </div>
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
  $("pf-pw").addEventListener("click", async () => {
    const cur = $("pf-cur").value, nw = $("pf-new").value, nw2 = $("pf-new2").value;
    if (nw !== nw2) { toast("New passwords don't match."); return; }
    if (nw.length < 8) { toast("New password must be 8+ characters."); return; }
    const body = {current: cur, new: nw};
    const codeEl = $("pf-code");
    if (codeEl) body.code = codeEl.value;
    try {
      await POST("/api/auth/password", body);
      $("pf-cur").value = $("pf-new").value = $("pf-new2").value = "";
      if (codeEl) codeEl.value = "";
      toast("Password changed.");
    } catch (err) { toast("Error: " + err.message); }
  });
  $("pf-2fa").addEventListener("click", () => showView("security"));
}

async function renderSecurity() {
  const v = $("view-security");
  let st;
  try { st = await GET("/api/auth/totp-status"); }
  catch (e) { v.innerHTML = `<div class="card"><p class="sub">Could not load security settings.</p></div>`; return; }
  if (!st.enabled) {
    v.innerHTML = `
    <div class="card"><h2>Two-factor authentication</h2>
      <p class="sub">Add a second step to your login with an authenticator app
      (Google Authenticator or Apple Passwords). Scan the QR code, then enter
      the 6-digit code to confirm. Save your recovery codes somewhere safe —
      they are the only way back in if you lose your phone.</p>
      <button class="btn" id="t-setup">Set up authenticator app</button>
      <div id="t-setup-area" style="margin-top:12px"></div>
    </div>`;
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
            $("t-done").addEventListener("click", renderSecurity);
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
  </div>`;
  $("t-disable").addEventListener("click", async () => {
    try {
      await POST("/api/auth/totp-disable", {code: $("t-code").value.trim()});
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
  <p class="sub">Already have an account? <a href="#" id="su-login">Log in</a></p>
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
  $("su-login").addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
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
        <button class="btn small ghost" id="ac-reset">Reset password</button>
        <button class="btn small ghost" id="ac-reset2fa">Reset 2FA</button>
      </div></div>
    </div>
    <p class="sub">Reset: put the account's email above, a new password, then hit Reset password. Reset 2FA clears that account's authenticator setup (lost phone).</p>
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
  let people = [];
  try { users = await GET("/api/users"); }
  catch (e) { el.innerHTML = '<span class="sub">Could not load accounts.</span>'; return; }
  try { people = await GET("/api/people"); } catch (e) { people = []; }
  const peopleOpts = people.map((p) =>
    `<option value="${p.id}">${esc(p.first_name)} ${esc(p.last_name)}</option>`).join("");
  el.innerHTML = users.map((u) => {
    const links = (u.links || []).map((l) =>
      `<span class="pill gray">${esc(l.member_name)} · ${l.kind} <button class="btn small ghost" data-unlink="${u.id}" data-member="${l.member_id}" data-kind="${l.kind}" style="margin-left:6px">Unlink</button></span>`).join(" ");
    return `<div class="row" style="margin:4px 0;flex-wrap:wrap">
      <span class="pill ${(u.role === "mentor" || u.role === "admin") ? "amber" : "gray"}">${esc(u.name)} · ${esc(u.role)}${u.has_password ? "" : " · no login"}${u.totp_enabled ? " · 🔒 2FA" : ""}${u.phone ? ` · ${esc(u.phone)}` : ""}${u.whatsapp ? ` · WhatsApp ${esc(u.whatsapp)}` : ""}</span>
      ${links || '<span class="sub">No roster links.</span>'}
      <select class="link-member" data-user="${u.id}"><option value="">Link a roster member…</option>${peopleOpts}</select>
      <select class="link-kind" data-user="${u.id}"><option value="self">as self</option><option value="parent">as parent</option></select>
      <button class="btn small ghost" data-link="${u.id}">Link</button>
    </div>`;
  }).join("") || '<span class="sub">No accounts yet.</span>';
  el.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", async () => {
    const uid = b.dataset.link;
    const mid = el.querySelector(`.link-member[data-user="${uid}"]`).value;
    const kind = el.querySelector(`.link-kind[data-user="${uid}"]`).value;
    if (!mid) return toast("Pick a roster member first.");
    try { await POST(`/api/users/${uid}/links`, {member_id: +mid, kind}); toast("Linked."); renderAccounts(); }
    catch (e) { toast("Error: " + e.message); }
  }));
  el.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("DELETE", `/api/users/${b.dataset.unlink}/links`, {member_id: +b.dataset.member, kind: b.dataset.kind}); toast("Unlinked."); renderAccounts(); }
    catch (e) { toast("Error: " + e.message); }
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
  $("ac-reset2fa").onclick = async () => {
    try {
      const email = $("ac-email").value.trim().toLowerCase();
      const u = users.find((x) => (x.email || "").toLowerCase() === email);
      if (!u) return toast("No account with that email.");
      if (!confirm("Reset two-factor authentication for " + u.name + " (" + u.email + ")? They will log in with just a password until they set it up again.")) return;
      await POST("/api/auth/totp-reset", {user_id: u.id});
      toast("2FA reset for " + u.name + ".");
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

/* What the signed-in account may RSVP as: own student record and/or the
   members they are a parent of. Mentors bypass this (override). */
function selfScope() {
  if (!ME) return {student: null, parents: []};
  // Identity links from /api/auth/me are authoritative. Name matching
  // is only a fallback for accounts with no links yet (a name the
  // backfill couldn't match — a mentor fixes it in Team accounts).
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
  <div class="card"><h2>Events &amp; RSVPs</h2>
  <p class="sub">Mentors create events. Students and parents RSVP for themselves; mentors can RSVP for anyone. Over-capacity events waitlist with auto-promote.</p>
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
    <button class="btn ghost" id="e-fill" type="button">Fill with an example event</button>
    <button class="btn ghost" id="e-workshop" type="button">Use workshop address</button></div>
  <p class="sub mo hidden" id="e-clubnote">Club meets Mondays 4:00–5:05 PM and is only for BASIS Independent Fremont students.</p>
  </div>
  <div class="card"><div class="row">
    ${["all", ...types].map((t) =>
      `<button class="btn ${eventFilter === t ? "" : "ghost"} small" data-et="${t}">${t}</button>`).join("")}
    <input id="e-q" placeholder="Search…" value="${esc(eventSearch)}" style="max-width:200px">
    <button class="btn small ghost" id="ev-expand-all">Expand all</button>
    <button class="btn small ghost" id="ev-collapse-all">Collapse all</button>
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
  if (clubBlocked) pickerRow = `<p class="sub">Club events are only for BASIS Independent Fremont students.</p>`;
  else if (closed && !MENTOR()) pickerRow = "";
  else if (pickerOpts.length) pickerRow = `<div class="row">
      <select id="rp-${e.id}">${opts}</select>
      <button class="btn small" data-rsvp="${e.id}" data-want="going">RSVP Going</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="maybe">Maybe</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="partial">Partial (multi-day)</button>
      <button class="btn small ghost" data-rsvp="${e.id}" data-want="cant">Can't make it</button>
    </div>${closed ? `<p class="sub">Deadline passed — mentor override: you can still RSVP for others.</p>` : ""}`;
  else pickerRow = `<p class="sub">We couldn't match your account to the roster, so you can't RSVP — ask a mentor to check your account name.</p>`;
  const scope = selfScope();
  const row = (r) => {
    const pill = r.status === "going" ? "green" : r.status === "waitlisted" ? "amber"
      : r.status === "maybe" ? "blue" : r.status === "partial" ? "purple" : "gray";
    const canRemove = MENTOR() || (ME
      && ((r.person_kind === "student" && r.member_id === scope.student)
        || (r.person_kind === "parent" && scope.parents.includes(r.member_id))));
    return `<div class="row" style="margin:4px 0">
      <span class="pill ${pill}">${r.status}</span>
      <span>${esc(r.person_name)} <span class="sub">(${r.person_kind})</span></span>
      ${canRemove ? `<button class="btn small ghost" data-unrsvp="${r.id}">Remove</button>` : ""}</div>`;
  };
  return `<div class="card">
    <div class="row"><b>${esc(e.title)}</b>
      <span class="pill">${esc(e.type)}</span>
      ${closed ? '<span class="pill red">RSVP closed</span>' : ""}
      <span style="flex:1"></span>
      ${MENTOR() ? `<button class="btn small danger" data-delev="${e.id}">Delete</button>` : ""}</div>
    <div class="sub">${esc(e.date || "")} ${esc(e.time || "")} · ${esc(e.location || "")}
      ${e.capacity ? `· ${hc.going}/${e.capacity} going` : `· ${hc.going} going`}
      · ${hc.maybe} maybe · ${hc.partial} partial
      · ${hc.waitlisted} waitlisted · ${hc.cant} can't make it</div>
    ${e.notes ? `<div class="sub">${esc(e.notes)}</div>` : ""}
    ${e.type === "club" ? `<div class="sub">Club — BASIS Independent Fremont students only · Mondays 4:00–5:05 PM.</div>` : ""}
    ${pickerRow}
    ${d.rsvps.length ? `<div class="row" style="margin-top:6px"><button class="btn small ghost" data-expand="${e.id}" data-count="${d.rsvps.length}">${openRsvpLists.has(e.id) ? "Collapse list" : `Expand list (${d.rsvps.length})`}</button></div>` : ""}
    <div id="rl-${e.id}" style="margin-top:6px" class="${openRsvpLists.has(e.id) ? "" : "hidden"}">${d.rsvps.map(row).join("") || '<span class="sub">No RSVPs yet.</span>'}</div>
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
  if (!events.some((e) => e.id === trackEventId)) trackEventId = events.length ? events[0].id : null;
  const ev = events.find((e) => e.id === trackEventId);
  const att = ev ? await GET(`/api/events/${ev.id}/rsvps`) : {rsvps: []};
  const checked = ev ? await GET(`/api/events/${ev.id}/checkins`) : [];
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
  </div></div>
  <div class="card"><h3>Attendance</h3>
  <div class="bubbles">${events.map((e) => `<button class="bubble ${e.id === trackEventId ? "active" : ""}" data-tev="${e.id}">${esc(e.title)} (${esc(e.date || "")})</button>`).join("")}</div>
  <div class="row" style="margin-top:8px"><span class="sub">Session hours:</span>
  <input id="t-hrs" type="number" min="0" step="0.5" value="${ev ? ev.session_hours : 2}" style="width:80px"></div>
  <div id="t-att" style="margin-top:8px">
  ${att.rsvps.filter((r) => r.status === "going" || r.status === "partial").map((r) => {
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
    ${h.breakdown.map((b) => `<tr><td>${esc(b.title)}</td><td>${esc(b.date || "")}</td>
      <td>${b.hours}</td><td>${b.verified ? "verified" : "unverified (" + esc(b.method) + ")"}</td></tr>`).join("")}
    </table></details>`).join("") || '<span class="sub">No hours logged yet.</span>'}
  </div>
`;
  v.querySelectorAll("[data-tev]").forEach((b) => b.addEventListener("click", () => {
    trackEventId = parseInt(b.dataset.tev, 10); savePlace(); renderTracking();
  }));
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
  const t = await GET(`/api/events/${travelEventId}/travel`);
  const ev = t.event;
  const people = personOptions();
  const popts = people.map((p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`).join("");
  // Travel lists pull dynamically from this event's attendees (RSVP going/partial).
  const attPeople = (t.attendees || []).map((a) => ({member_id: a.member_id,
    kind: a.person_kind, name: `${a.person_name} (${a.person_kind})`}));
  const optJSON = (p) =>
    `<option value='${JSON.stringify(p).replace(/'/g, "&#39;")}'>${esc(p.name)}</option>`;
  const attOpts = attPeople.map(optJSON).join("");
  const attParents = attPeople.filter((p) => p.kind === "parent").map(optJSON).join("");
  const attStudents = (t.attendees || []).filter((a) => a.person_kind === "student");
  const knownParents = new Set([
    ...(t.attendees || []).filter((a) => a.person_kind === "parent")
      .map((a) => normName(a.person_name)),
    ...(t.parent_names || []).map((n) => normName(n))]);
  const parentDrivers = (t.carpools || []).filter((c) =>
    knownParents.has(normName(c.driver_name)));
  const driverOpts = parentDrivers.map((c) => {
    const v = vehicleTip(c.vehicle);
    return `<option value="${esc(c.driver_name)}">${esc(v ? `${c.driver_name} · ${v}` : c.driver_name)}</option>`;
  }).join("");
  const students = attStudents.map((a) =>
    `<option value="${a.member_id}">${esc(a.person_name)}</option>`).join("");
  const studentNames = attStudents.map((a) =>
    chipButton(a.person_name, a.person_name)).join("");
  v.innerHTML = `
  <div class="card"><h2>Travel &amp; Logistics</h2>
  <p class="sub">Carpools, tool sign-up, and hotel assignments — organized per event.</p>
  <div class="bubbles">${events.map((e) => `<button class="bubble ${e.id === travelEventId ? "active" : ""}" data-ev="${e.id}">${esc(e.title)}</button>`).join("")}</div></div>

  <div class="card"><h3>Carpools</h3>
  ${ME.role !== "student" ? `
  <div class="grid3">
    <div class="field"><label>Driver name *</label><input id="cp-driver"></div>
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
  <button class="btn small" id="cp-add">Post ride</button>` : ""}
  <div id="cp-list" style="margin-top:10px">
  ${t.carpools.map((c) => `
    <div class="card"><div class="row"><b>${esc(c.driver_name)}</b>
      ${vehicleTip(c.vehicle) ? `<span class="pill" title="${esc(vehicleTip(c.vehicle))}">\u{1F697} vehicle</span>` : ""}
      <span class="pill ${c.seats_open ? "green" : "red"}">${c.seats_open} of ${c.seats} seats open</span></div>
    <div class="sub">${esc(c.depart_from || "")} · ${esc(c.depart_time || "")} · Return: ${esc(c.return_info || "—")}</div>
    <div>Riders: ${c.claims.map((x) =>
      `<span class="pill">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="release">✕</a></span>`).join("") || '<span class="sub">none yet</span>'}</div>
    ${c.waitlist.length ? `<div>Waitlist: ${c.waitlist.map((x) =>
      `<span class="pill amber">${esc(x.person_name)} <a href="#" data-unclaim="${x.id}" title="remove">✕</a></span>`).join("")}</div>` : ""}
    ${(() => {
      const onRide = new Set();
      [...c.claims, ...c.waitlist].forEach((x) => {
        onRide.add(`${x.member_id}:${x.person_kind}`);
        onRide.add(`${normName(x.person_name)}:${x.person_kind}`);
      });
      const cpsOpts = attPeople.filter((p) =>
        !onRide.has(`${p.member_id}:${p.kind}`)
        && !onRide.has(`${normName(p.name.replace(/ \((student|parent)\)$/, ""))}:${p.kind}`)).map(optJSON).join("");
      return cpsOpts
        ? `<div class="row" style="margin-top:6px"><select id="cps-${c.id}">${cpsOpts}</select>
      <button class="btn small" data-claim="${c.id}">Claim seat</button></div>`
        : `<div class="sub" style="margin-top:6px">Everyone attending is already on this ride.</div>`;
    })()}
    </div>`).join("") || '<p class="sub">No carpools posted for this event yet.</p>'}
  </div></div>

  <div class="card"><h3>Tool sign-up</h3>
  <p class="sub">Mentors list what the event needs; parent drivers claim what they'll haul in their cars.</p>
  <div class="row mo">
    <input id="tl-name" placeholder="Tool or gear needed *" style="flex:2;min-width:160px">
    <input id="tl-qty" placeholder="Qty" inputmode="numeric" style="max-width:70px">
    <input id="tl-notes" placeholder="Notes" style="flex:1;min-width:120px">
    <button class="btn small" id="tl-add">Add</button>
  </div>
  <div style="margin-top:8px">
  ${t.tools.map((x) => {
    const driver = (t.carpools || []).find((c) => normName(c.driver_name) === normName(x.claimed_by));
    const veh = driver ? vehicleTip(driver.vehicle) : "";
    return `<div class="row" style="margin:6px 0">
    <span><b>${esc(x.name)}</b> <span class="sub">×${x.qty}</span></span>
    ${x.claimed_by ? `<span class="pill green">\u{1F697} loaded in ${esc(x.claimed_by)}'s car</span>
      ${veh ? `<span class="pill" title="${esc(veh)}">\u{1F697} vehicle</span>` : ""}
      <button class="btn small ghost" data-tunclaim="${x.id}">Unclaim</button>`
    : driverOpts ? `<select id="tls-${x.id}">${driverOpts}</select>
      <button class="btn small" data-tclaim="${x.id}">Claim</button>`
    : `<span class="sub">No parent drivers with carpools for this event yet — post a ride in Carpools first.</span>`}
  </div>`;}).join("") || '<p class="sub">Nothing listed yet.</p>'}
  </div></div>

  <div class="card"><h3>Hotel assignments</h3>
  ${t.hotel ? hotelHTML(t.hotel, students, attParents, studentNames, attStudents) : `
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
  v.querySelectorAll("[data-ev]").forEach((b) => b.addEventListener("click", () => {
    travelEventId = parseInt(b.dataset.ev, 10); savePlace(); pendingBeds = []; renderTravel();
  }));
  const hb = $("h-add");
  if (hb) hb.addEventListener("click", async () => {
    if (!$("h-name").value.trim()) return toast("Hotel name is required.");
    await POST("/api/hotels", {event_id: travelEventId, name: $("h-name").value.trim(),
      address: $("h-addr").value.trim(), check_in: $("h-in").value,
      check_out: $("h-out").value, notes: $("h-notes").value.trim()});
    toast("Hotel block saved."); renderTravel();
  });
  const cpAdd = $("cp-add");
  if (cpAdd) cpAdd.addEventListener("click", async () => {
    if (!$("cp-driver").value.trim() || !$("cp-seats").value.trim())
      return toast("Driver name and seats are required.");
    try {
      await POST("/api/carpools", {event_id: travelEventId,
        driver_name: $("cp-driver").value.trim(), seats: parseInt($("cp-seats").value, 10),
        depart_from: $("cp-from").value.trim(), depart_time: $("cp-dt").value.trim(),
        return_info: $("cp-ret").value.trim(), notes: $("cp-notes").value.trim(),
        vehicle: {plate: $("cp-vplate").value.trim(), color: $("cp-vcolor").value.trim(),
          make: $("cp-vmake").value.trim(), model: $("cp-vmodel").value.trim()}});
      toast("Ride posted."); renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  });
  v.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const p = JSON.parse($("cps-" + b.dataset.claim).value.replace(/&#39;/g, "'"));
    try {
      const r = await POST(`/api/carpools/${b.dataset.claim}/claims`, {
        member_id: p.member_id, person_kind: p.kind,
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
  const _tl = $("tl-add"); if (_tl) _tl.addEventListener("click", async () => {
    if (!$("tl-name").value.trim()) return toast("Tool name is required.");
    await POST("/api/tools", {event_id: travelEventId, name: $("tl-name").value.trim(),
      qty: parseInt($("tl-qty").value, 10) || 1, notes: $("tl-notes").value.trim()});
    toast("Tool added."); renderTravel();
  });
  v.querySelectorAll("[data-tclaim]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await POST(`/api/tools/${b.dataset.tclaim}/claim`,
        {claimed_by: $("tls-" + b.dataset.tclaim).value});
      toast("Loaded — thank you for hauling!");
      renderTravel();
    } catch (e) { toast("Error: " + e.message); }
  }));
  v.querySelectorAll("[data-tunclaim]").forEach((b) => b.addEventListener("click", async () => {
    await POST(`/api/tools/${b.dataset.tunclaim}/unclaim`);
    toast("Unclaimed."); renderTravel();
  }));
  v.querySelectorAll("[data-rvol]").forEach((b) => b.addEventListener("click", async () => {
    const sel = $("rp-" + b.dataset.rvol);
    if (!sel.value) return toast("Pick which parent is volunteering.");
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
    try {
      const r = await POST(`/api/hotels/${t.hotel.id}/rooms`, {beds: pendingBeds});
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
    mates.innerHTML = (attStudents || [])
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

function bedSummary(beds) {
  if (!beds || !beds.length) return "";
  const counts = {};
  beds.forEach((b) => { counts[b] = (counts[b] || 0) + 1; });
  return Object.entries(counts).map(([t, n]) =>
    `${n} ${t}${n > 1 ? "s" : ""}`).join(" · ");
}

function hotelHTML(h, students, poptParents, studentNames, attStudents) {
  const canVol = ME && ME.role !== "student";
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
  const roomingBlock = ME.role === "parent" ? "" : `
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
    : `<div class="row"><select id="rq-who"><option value="">Student…</option>${students}</select>
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
  return `
  <div class="sub"><b>${esc(h.name)}</b> · ${esc(h.address || "")} ·
    ${esc(h.check_in || "")} → ${esc(h.check_out || "")}</div>
  ${h.notes ? `<div class="sub">${esc(h.notes)}</div>` : ""}
  <h3>Rooms</h3>
  <p class="sub">The block is already booked. A room can have an adult <b>room parent</b> to check in, since students under 18 can't check in themselves — optional; senior rooms often go without. Parents can volunteer for a room below.</p>
  <div class="row mo" style="flex-wrap:wrap;gap:8px;align-items:center">
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
  ${h.rooms.map((r) => {
    const occ = r.occupants.map((o) =>
      `<span class="pill">${esc(o.first_name)} ${esc(o.last_name)}${MENTOR() ? ` <a href="#" data-unplace="${o.id}" title="remove">\u2715</a>` : ""}</span>`).join("");
    return `<div class="card"><div class="row"><b>${esc(r.label)}</b>
      ${r.room_number ? `<span class="sub">room #${esc(r.room_number)}</span>` : ""}
      ${MENTOR() ? `<input class="mini" id="rn-${r.id}" value="${esc(r.room_number || "")}" placeholder="actual room #" style="max-width:120px">` : ""}
      <span class="pill ${r.occupants.length >= r.capacity ? "red" : "green"}">
      ${r.occupants.length}/${r.capacity} beds</span></div>
      ${bedSummary(r.beds) ? `<div class="sub">${esc(bedSummary(r.beds))}</div>` : ""}
      <div>${occ || '<span class="sub">empty</span>'}</div>
      <div class="row" style="margin-top:6px">
        ${r.parent_name
          ? `<span class="pill green">Room parent: ${esc(r.parent_name)}</span>
             ${canVol ? `<button class="btn small ghost" data-rparentx="${r.id}">Remove</button>` : ""}`
          : `<span class="pill gray">No room parent (optional)</span>`}
      </div>
      ${!r.parent_name && canVol ? `<div class="row" style="margin-top:6px">
        <select id="rp-${r.id}"><option value="">Volunteer as room parent…</option>${poptParents}</select>
        <button class="btn small" data-rvol="${r.id}">Volunteer</button></div>` : ""}
      <div class="row mo" style="margin-top:6px"><select id="plc-${r.id}">
        <option value="">Place a student…</option>${students}</select>
        <button class="btn small" data-place="${r.id}">Place</button></div></div>`;
  }).join("")}
  ${roomingBlock}`;
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
    showView(btn && !btn.classList.contains("navhide") ? place.view : (offMenu ? place.view : "events"));
    refreshBadges();
  } else {
    showView("login");
  }
})();
