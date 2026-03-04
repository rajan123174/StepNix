const openBtn = document.getElementById("open-delete-account-modal");
const modal = document.getElementById("delete-account-modal");
const closeBtn = document.getElementById("delete-account-close");
const backdrop = modal?.querySelector(".delete-account-backdrop");
const statusEl = document.getElementById("delete-account-status");
const editProfileForm = document.getElementById("settings-edit-profile-form");
const editProfileStatusEl = document.getElementById("settings-edit-profile-status");
const settingsAvatarEl = document.getElementById("settings-profile-avatar");
const settingsAvatarEditBtn = document.getElementById("settings-avatar-edit-btn");
const settingsPhotoInput = document.getElementById("settings-profile-photo-input");
const settingsUsernameInput = document.getElementById("settings-username-input");
const settingsFullnameInput = document.getElementById("settings-fullname-input");
const settingsGenderInput = document.getElementById("settings-gender-input");
const settingsBioInput = document.getElementById("settings-bio-input");
const settingsSaveBtn = document.getElementById("settings-edit-profile-save-btn");
const dashboardStatusEl = document.getElementById("account-dashboard-status");
const dashboardTotalViewsEl = document.getElementById("dashboard-total-views");
const dashboardViews30El = document.getElementById("dashboard-views-30d");
const dashboardUniqueEl = document.getElementById("dashboard-unique-viewers");
const dashboardGenderMatrixEl = document.getElementById("dashboard-gender-matrix");
const dashboardViewersListEl = document.getElementById("dashboard-viewers-list");
const securityMessageSeenToggle = document.getElementById("security-message-seen-toggle");
const securityMessageSeenStatus = document.getElementById("security-message-seen-status");
const securityStorySearch = document.getElementById("security-story-search");
const securityStoryList = document.getElementById("security-story-list");
const securityStorySaveBtn = document.getElementById("security-story-save-btn");
const securityStoryStatus = document.getElementById("security-story-status");
const securityProfileSearch = document.getElementById("security-profile-search");
const securityProfileList = document.getElementById("security-profile-list");
const securityProfileSaveBtn = document.getElementById("security-profile-save-btn");
const securityProfileStatus = document.getElementById("security-profile-status");
const securityBlockSearch = document.getElementById("security-block-search");
const securityBlockList = document.getElementById("security-block-list");
const securityPasswordSendOtpBtn = document.getElementById("security-password-send-otp-btn");
const securityPasswordOtpInput = document.getElementById("security-password-otp-input");
const securityPasswordNewInput = document.getElementById("security-password-new-input");
const securityPasswordConfirmInput = document.getElementById("security-password-confirm-input");
const securityPasswordContinueBtn = document.getElementById("security-password-continue-btn");
const securityPasswordStatus = document.getElementById("security-password-status");
const securityEmailSendOtpBtn = document.getElementById("security-email-send-otp-btn");
const securityEmailOtpInput = document.getElementById("security-email-otp-input");
const securityEmailNewInput = document.getElementById("security-email-new-input");
const securityEmailConfirmInput = document.getElementById("security-email-confirm-input");
const securityEmailContinueBtn = document.getElementById("security-email-continue-btn");
const securityEmailStatus = document.getElementById("security-email-status");
const themeLightBtn = document.getElementById("theme-light-btn");
const themeDarkBtn = document.getElementById("theme-dark-btn");
const themeModeStatus = document.getElementById("theme-mode-status");
const initialForm = document.getElementById("delete-account-initial-form");
const initialOtpInput = document.getElementById("delete-account-initial-otp");
const reasonInput = document.getElementById("delete-account-reason");
const confirmStep = document.getElementById("delete-account-confirm-step");
const confirmOtpInput = document.getElementById("delete-account-confirm-otp");
const finalDeleteBtn = document.getElementById("delete-account-final-btn");
const settingsMenuBtns = Array.from(document.querySelectorAll(".settings-menu-btn"));
const settingsPanes = Array.from(document.querySelectorAll(".settings-pane"));

let confirmVerified = false;
let confirmVerifyInProgress = false;
let dashboardLoaded = false;
let securityLoaded = false;
let securityNetworkUsers = [];
let hiddenStoryIds = new Set();
let hiddenProfileIds = new Set();
let blockedIds = new Set();
let passwordOtpVerified = false;
let emailOtpVerified = false;

if (!App.requireAuth()) {
  // redirected
}

function activateSettingsPane(targetId) {
  settingsMenuBtns.forEach((btn) => {
    const isActive = btn.getAttribute("data-settings-target") === targetId;
    btn.classList.toggle("is-active", isActive);
  });
  settingsPanes.forEach((pane) => {
    const isActive = pane.id === targetId;
    pane.classList.toggle("hidden", !isActive);
    pane.classList.toggle("is-active", isActive);
  });
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || "";
}

function setEditProfileStatus(text, tone = "neutral") {
  if (!editProfileStatusEl) return;
  editProfileStatusEl.textContent = text || "";
  editProfileStatusEl.classList.remove("status-error", "status-success");
  if (tone === "error") editProfileStatusEl.classList.add("status-error");
  if (tone === "success") editProfileStatusEl.classList.add("status-success");
}

function normalizeOtpInput(inputEl) {
  if (!inputEl) return;
  inputEl.value = inputEl.value.replace(/\D/g, "").slice(0, 6);
}

function setSecurityStatus(el, text, tone = "neutral") {
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("status-error", "status-success");
  if (tone === "error") el.classList.add("status-error");
  if (tone === "success") el.classList.add("status-success");
}

function setThemeStatus(text, tone = "neutral") {
  if (!themeModeStatus) return;
  themeModeStatus.textContent = text || "";
  themeModeStatus.classList.remove("status-error", "status-success");
  if (tone === "error") themeModeStatus.classList.add("status-error");
  if (tone === "success") themeModeStatus.classList.add("status-success");
}

function syncThemeButtons() {
  const current = window.App?.getTheme ? window.App.getTheme() : "light";
  themeLightBtn?.classList.toggle("is-active", current === "light");
  themeDarkBtn?.classList.toggle("is-active", current === "dark");
}

function setSecurityStatusTimed(el, text, tone = "neutral", timeoutMs = 2000) {
  if (!el) return;
  setSecurityStatus(el, text, tone);
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  el.dataset.statusMarker = marker;
  window.setTimeout(() => {
    if (el.dataset.statusMarker !== marker) return;
    setSecurityStatus(el, "", "neutral");
  }, timeoutMs);
}

function normalizeDigitsInput(inputEl) {
  if (!inputEl) return "";
  inputEl.value = inputEl.value.replace(/\D/g, "").slice(0, 6);
  return inputEl.value;
}

function applyMeToSettingsForm(user) {
  if (!user) return;
  if (settingsAvatarEl) settingsAvatarEl.src = user.profile_photo_url || "/static/default-avatar.svg";
  if (settingsUsernameInput) settingsUsernameInput.value = user.username || "";
  if (settingsFullnameInput) settingsFullnameInput.value = user.full_name || "";
  if (settingsGenderInput) settingsGenderInput.value = user.gender || "prefer_not_to_say";
  if (settingsBioInput) settingsBioInput.value = user.bio || "";
}

function renderDashboard(data) {
  if (dashboardTotalViewsEl) dashboardTotalViewsEl.textContent = String(data?.total_views || 0);
  if (dashboardViews30El) dashboardViews30El.textContent = String(data?.views_last_30_days || 0);
  if (dashboardUniqueEl) dashboardUniqueEl.textContent = String(data?.unique_viewers || 0);

  if (dashboardGenderMatrixEl) {
    const rows = Array.isArray(data?.gender_ratio) ? data.gender_ratio : [];
    dashboardGenderMatrixEl.innerHTML = "";
    rows.forEach((row) => {
      const item = document.createElement("div");
      item.className = "dashboard-gender-row";
      item.innerHTML = `
        <div class="dashboard-gender-label">${row.label}</div>
        <div class="dashboard-gender-track">
          <div class="dashboard-gender-fill" style="width:${Math.max(0, Math.min(100, Number(row.percent) || 0))}%"></div>
        </div>
        <div class="dashboard-gender-value">${row.percent}% (${row.count})</div>
      `;
      dashboardGenderMatrixEl.appendChild(item);
    });
    if (!rows.length) {
      dashboardGenderMatrixEl.innerHTML = "<p class='notice'>No viewer data yet.</p>";
    }
  }

  if (dashboardViewersListEl) {
    const viewers = Array.isArray(data?.recent_viewers) ? data.recent_viewers : [];
    dashboardViewersListEl.innerHTML = "";
    viewers.forEach((viewer) => {
      const row = document.createElement("a");
      row.className = "dashboard-viewer-row";
      row.href = `/user/${viewer.id}`;
      const date = viewer.last_viewed_at ? new Date(viewer.last_viewed_at) : null;
      row.innerHTML = `
        <img src="${viewer.profile_photo_url || "/static/default-avatar.svg"}" alt="${viewer.username}" />
        <div class="dashboard-viewer-meta">
          <strong>${viewer.full_name}</strong>
          <small>@${viewer.username}</small>
        </div>
        <div class="dashboard-viewer-extra">
          <small>${viewer.gender === "male" ? "Male" : (viewer.gender === "female" ? "Female" : "Prefer not to say")}</small>
          <small>${viewer.view_count} view${viewer.view_count > 1 ? "s" : ""}</small>
          <small>${date ? date.toLocaleString() : ""}</small>
        </div>
      `;
      dashboardViewersListEl.appendChild(row);
    });
    if (!viewers.length) {
      dashboardViewersListEl.innerHTML = "<p class='notice'>No one has viewed your profile yet.</p>";
    }
  }
}

async function loadAccountDashboard(force = false) {
  if (dashboardLoaded && !force) return;
  if (dashboardStatusEl) dashboardStatusEl.textContent = "Loading dashboard...";
  try {
    const data = await App.api("/api/settings/account/dashboard");
    renderDashboard(data);
    dashboardLoaded = true;
    if (dashboardStatusEl) dashboardStatusEl.textContent = "Dashboard updated.";
  } catch (error) {
    if (dashboardStatusEl) dashboardStatusEl.textContent = error.message;
  }
}

function filteredUsers(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return securityNetworkUsers;
  return securityNetworkUsers.filter((user) => {
    const uname = String(user.username || "").toLowerCase();
    const fname = String(user.full_name || "").toLowerCase();
    return uname.includes(q) || fname.includes(q) || String(user.id || "").includes(q);
  });
}

function renderSecurityStoryList() {
  if (!securityStoryList) return;
  const users = filteredUsers(securityStorySearch?.value || "");
  securityStoryList.innerHTML = "";
  if (!users.length) {
    securityStoryList.innerHTML = "<p class='notice'>No users found.</p>";
    return;
  }
  users.forEach((user) => {
    const row = document.createElement("label");
    row.className = "security-user-row";
    row.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <span class="security-user-meta">
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
      </span>
      <input class="row-check" type="checkbox" ${hiddenStoryIds.has(user.id) ? "checked" : ""} />
    `;
    const checkbox = row.querySelector("input");
    checkbox?.addEventListener("change", () => {
      if (checkbox.checked) hiddenStoryIds.add(user.id);
      else hiddenStoryIds.delete(user.id);
    });
    securityStoryList.appendChild(row);
  });
}

function renderSecurityProfileList() {
  if (!securityProfileList) return;
  const users = filteredUsers(securityProfileSearch?.value || "");
  securityProfileList.innerHTML = "";
  if (!users.length) {
    securityProfileList.innerHTML = "<p class='notice'>No users found.</p>";
    return;
  }
  users.forEach((user) => {
    const row = document.createElement("label");
    row.className = "security-user-row";
    row.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <span class="security-user-meta">
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
      </span>
      <input class="row-check" type="checkbox" ${hiddenProfileIds.has(user.id) ? "checked" : ""} />
    `;
    const checkbox = row.querySelector("input");
    checkbox?.addEventListener("change", () => {
      if (checkbox.checked) hiddenProfileIds.add(user.id);
      else hiddenProfileIds.delete(user.id);
    });
    securityProfileList.appendChild(row);
  });
}

function renderSecurityBlockList() {
  if (!securityBlockList) return;
  const users = filteredUsers(securityBlockSearch?.value || "");
  securityBlockList.innerHTML = "";
  if (!users.length) {
    securityBlockList.innerHTML = "<p class='notice'>No users found.</p>";
    return;
  }
  users.forEach((user) => {
    const isBlocked = blockedIds.has(user.id);
    const row = document.createElement("div");
    row.className = "security-user-row";
    row.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <span class="security-user-meta">
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
      </span>
      <button type="button" class="security-block-btn ${isBlocked ? "is-blocked" : ""}">${isBlocked ? "Unblock" : "Block"}</button>
    `;
    const btn = row.querySelector("button");
    btn?.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const body = new URLSearchParams({
          target_user_id: String(user.id),
          blocked: isBlocked ? "0" : "1",
        });
        await App.api("/api/settings/security/block-user", { method: "POST", body });
        if (isBlocked) blockedIds.delete(user.id);
        else blockedIds.add(user.id);
        renderSecurityBlockList();
      } catch (error) {
        setSecurityStatus(securityMessageSeenStatus, error.message, "error");
        btn.disabled = false;
      }
    });
    securityBlockList.appendChild(row);
  });
}

async function loadSecurityPane(force = false) {
  if (securityLoaded && !force) return;
  try {
    const [state, users] = await Promise.all([
      App.api("/api/settings/security/state"),
      App.api("/api/settings/security/network-users"),
    ]);
    securityNetworkUsers = Array.isArray(users) ? users : [];
    hiddenStoryIds = new Set(state?.hidden_story_user_ids || []);
    hiddenProfileIds = new Set(state?.hidden_profile_user_ids || []);
    blockedIds = new Set(state?.blocked_user_ids || []);
    if (securityMessageSeenToggle) {
      securityMessageSeenToggle.checked = !!state?.show_message_seen;
    }
    renderSecurityStoryList();
    renderSecurityProfileList();
    renderSecurityBlockList();
    securityLoaded = true;
    setSecurityStatus(securityMessageSeenStatus, "Security and privacy loaded.", "success");
  } catch (error) {
    setSecurityStatus(securityMessageSeenStatus, error.message, "error");
  }
}

async function loadSettingsProfileForm() {
  try {
    const me = await App.api("/api/auth/me");
    App.setAuth(App.getToken(), me);
    applyMeToSettingsForm(me);
  } catch (error) {
    setEditProfileStatus(error.message, "error");
  }
}

async function uploadSettingsProfilePhoto(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("profile_photo", file);
  setEditProfileStatus("Uploading profile photo...");
  try {
    const updated = await App.api("/api/me/photo", {
      method: "POST",
      body: formData,
    });
    App.setAuth(App.getToken(), updated);
    applyMeToSettingsForm(updated);
    setEditProfileStatus("Profile photo updated.", "success");
  } catch (error) {
    setEditProfileStatus(error.message, "error");
  } finally {
    if (settingsPhotoInput) settingsPhotoInput.value = "";
  }
}

function resetModalState() {
  confirmVerified = false;
  confirmVerifyInProgress = false;
  initialForm?.classList.remove("hidden");
  confirmStep?.classList.add("hidden");
  finalDeleteBtn?.classList.add("hidden");
  if (initialOtpInput) initialOtpInput.value = "";
  if (reasonInput) reasonInput.value = "";
  if (confirmOtpInput) confirmOtpInput.value = "";
}

function closeModal() {
  if (!modal) return;
  modal.classList.add("hidden");
  resetModalState();
}

async function sendInitialOtp() {
  const result = await App.api("/api/settings/account/delete/send-initial-otp", { method: "POST" });
  setStatus(result?.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result?.detail || "OTP sent."));
}

async function openModal() {
  if (!modal) return;
  modal.classList.remove("hidden");
  resetModalState();
  setStatus("Sending OTP to your registered email...");
  try {
    await sendInitialOtp();
  } catch (error) {
    setStatus(error.message);
  }
}

async function verifyConfirmOtpIfReady() {
  const otp = confirmOtpInput?.value.trim() || "";
  if (!/^\d{6}$/.test(otp) || confirmVerifyInProgress) return;
  confirmVerifyInProgress = true;
  setStatus("Verifying reconfirmation OTP...");
  try {
    const body = new URLSearchParams({ otp });
    const result = await App.api("/api/settings/account/delete/verify-confirm", { method: "POST", body });
    confirmVerified = true;
    finalDeleteBtn?.classList.remove("hidden");
    setStatus(result?.detail || "OTP verified. You can permanently delete account now.");
  } catch (error) {
    confirmVerified = false;
    finalDeleteBtn?.classList.add("hidden");
    setStatus(error.message);
  } finally {
    confirmVerifyInProgress = false;
  }
}

openBtn?.addEventListener("click", () => {
  openModal().catch((error) => setStatus(error.message));
});

settingsMenuBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-settings-target");
    if (!target) return;
    activateSettingsPane(target);
    if (target === "settings-panel-dashboard") {
      loadAccountDashboard().catch(() => {});
    }
    if (target === "settings-panel-security") {
      loadSecurityPane().catch(() => {});
    }
  });
});

closeBtn?.addEventListener("click", closeModal);
backdrop?.addEventListener("click", closeModal);

initialOtpInput?.addEventListener("input", () => normalizeOtpInput(initialOtpInput));
confirmOtpInput?.addEventListener("input", () => {
  normalizeOtpInput(confirmOtpInput);
  confirmVerified = false;
  finalDeleteBtn?.classList.add("hidden");
  verifyConfirmOtpIfReady().catch(() => {});
});
confirmOtpInput?.addEventListener("paste", () => {
  setTimeout(() => {
    normalizeOtpInput(confirmOtpInput);
    verifyConfirmOtpIfReady().catch(() => {});
  }, 0);
});

initialForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const otp = initialOtpInput?.value.trim() || "";
  const reason = reasonInput?.value.trim() || "";
  if (!/^\d{6}$/.test(otp)) {
    setStatus("Enter first OTP (6 digits).");
    return;
  }
  if (reason.length < 5) {
    setStatus("Please enter reason (minimum 5 characters).");
    return;
  }
  const continueBtn = document.getElementById("delete-account-continue");
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.textContent = "Processing...";
  }
  try {
    const body = new URLSearchParams({ otp, reason });
    const result = await App.api("/api/settings/account/delete/verify-initial", { method: "POST", body });
    initialForm.classList.add("hidden");
    confirmStep?.classList.remove("hidden");
    setStatus(result?.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result?.detail || "Reconfirmation OTP sent."));
  } catch (error) {
    setStatus(error.message);
  } finally {
    if (continueBtn) {
      continueBtn.disabled = false;
      continueBtn.textContent = "Continue";
    }
  }
});

finalDeleteBtn?.addEventListener("click", async () => {
  if (!confirmVerified) {
    setStatus("Verify reconfirmation OTP first.");
    return;
  }
  finalDeleteBtn.disabled = true;
  finalDeleteBtn.textContent = "Deleting...";
  try {
    const result = await App.api("/api/settings/account/delete/confirm", { method: "POST" });
    setStatus(result?.detail || "Account deleted permanently.");
    App.clearAuth();
    window.location.href = "/create-profile";
  } catch (error) {
    setStatus(error.message);
    finalDeleteBtn.disabled = false;
    finalDeleteBtn.textContent = "Delete account permanently";
  }
});

settingsAvatarEditBtn?.addEventListener("click", () => settingsPhotoInput?.click());

settingsPhotoInput?.addEventListener("change", async () => {
  const [file] = settingsPhotoInput.files || [];
  await uploadSettingsProfilePhoto(file);
});

editProfileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = settingsUsernameInput?.value.trim().toLowerCase() || "";
  const fullName = settingsFullnameInput?.value.trim() || "";
  const gender = settingsGenderInput?.value || "";
  const bio = settingsBioInput?.value || "";
  if (!username || !fullName || !gender) {
    setEditProfileStatus("Username, full name, and gender are required.", "error");
    return;
  }
  if (settingsSaveBtn) {
    settingsSaveBtn.disabled = true;
    settingsSaveBtn.textContent = "Saving...";
  }
  try {
    const body = new URLSearchParams({
      username,
      full_name: fullName,
      gender,
      bio,
    });
    const updated = await App.api("/api/me/profile/update", {
      method: "POST",
      body,
    });
    App.setAuth(App.getToken(), updated);
    applyMeToSettingsForm(updated);
    setEditProfileStatus("Profile updated successfully.", "success");
  } catch (error) {
    setEditProfileStatus(error.message, "error");
  } finally {
    if (settingsSaveBtn) {
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = "Save profile changes";
    }
  }
});

loadSettingsProfileForm().catch(() => {});
syncThemeButtons();

window.addEventListener("theme:changed", () => {
  syncThemeButtons();
});

themeLightBtn?.addEventListener("click", () => {
  if (!window.App?.setTheme) return;
  window.App.setTheme("light");
  syncThemeButtons();
  setThemeStatus("Light mode enabled.", "success");
});

themeDarkBtn?.addEventListener("click", () => {
  if (!window.App?.setTheme) return;
  window.App.setTheme("dark");
  syncThemeButtons();
  setThemeStatus("Dark mode enabled.", "success");
});

securityStorySearch?.addEventListener("input", renderSecurityStoryList);
securityProfileSearch?.addEventListener("input", renderSecurityProfileList);
securityBlockSearch?.addEventListener("input", renderSecurityBlockList);

securityMessageSeenToggle?.addEventListener("change", async () => {
  const body = new URLSearchParams({ enabled: securityMessageSeenToggle.checked ? "1" : "0" });
  try {
    const result = await App.api("/api/settings/security/message-seen", { method: "POST", body });
    setSecurityStatus(securityMessageSeenStatus, result?.detail || "Saved.", "success");
  } catch (error) {
    securityMessageSeenToggle.checked = !securityMessageSeenToggle.checked;
    setSecurityStatus(securityMessageSeenStatus, error.message, "error");
  }
});

securityStorySaveBtn?.addEventListener("click", async () => {
  securityStorySaveBtn.disabled = true;
  const body = new URLSearchParams({ target_user_ids: Array.from(hiddenStoryIds).join(",") });
  try {
    const result = await App.api("/api/settings/security/story-visibility", { method: "POST", body });
    hiddenStoryIds = new Set(result?.hidden_story_user_ids || []);
    setSecurityStatusTimed(securityStoryStatus, "Changes updated.", "success", 2000);
    renderSecurityStoryList();
  } catch (error) {
    setSecurityStatus(securityStoryStatus, error.message, "error");
  } finally {
    securityStorySaveBtn.disabled = false;
  }
});

securityProfileSaveBtn?.addEventListener("click", async () => {
  securityProfileSaveBtn.disabled = true;
  const body = new URLSearchParams({ target_user_ids: Array.from(hiddenProfileIds).join(",") });
  try {
    const result = await App.api("/api/settings/security/profile-visibility", { method: "POST", body });
    hiddenProfileIds = new Set(result?.hidden_profile_user_ids || []);
    setSecurityStatusTimed(securityProfileStatus, "Changes updated.", "success", 2000);
    renderSecurityProfileList();
  } catch (error) {
    setSecurityStatus(securityProfileStatus, error.message, "error");
  } finally {
    securityProfileSaveBtn.disabled = false;
  }
});

securityPasswordSendOtpBtn?.addEventListener("click", async () => {
  securityPasswordSendOtpBtn.disabled = true;
  passwordOtpVerified = false;
  try {
    const result = await App.api("/api/settings/security/password/send-otp", { method: "POST" });
    setSecurityStatus(
      securityPasswordStatus,
      result?.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result?.detail || "OTP sent."),
      "success"
    );
  } catch (error) {
    setSecurityStatus(securityPasswordStatus, error.message, "error");
  } finally {
    securityPasswordSendOtpBtn.disabled = false;
  }
});

async function verifyPasswordOtpIfReady() {
  const otp = normalizeDigitsInput(securityPasswordOtpInput);
  if (!/^\d{6}$/.test(otp) || passwordOtpVerified) return;
  try {
    const body = new URLSearchParams({ otp });
    const result = await App.api("/api/settings/security/password/verify-otp", { method: "POST", body });
    passwordOtpVerified = true;
    setSecurityStatus(securityPasswordStatus, result?.detail || "OTP verified.", "success");
  } catch (error) {
    passwordOtpVerified = false;
    setSecurityStatus(securityPasswordStatus, error.message, "error");
  }
}

securityPasswordOtpInput?.addEventListener("input", () => {
  passwordOtpVerified = false;
  verifyPasswordOtpIfReady().catch(() => {});
});

securityPasswordContinueBtn?.addEventListener("click", async () => {
  if (!passwordOtpVerified) {
    setSecurityStatus(securityPasswordStatus, "Enter OTP and wait for auto verification.", "error");
    return;
  }
  const newPassword = securityPasswordNewInput?.value || "";
  const confirmPassword = securityPasswordConfirmInput?.value || "";
  securityPasswordContinueBtn.disabled = true;
  try {
    const body = new URLSearchParams({ new_password: newPassword, confirm_password: confirmPassword });
    const result = await App.api("/api/settings/security/password/confirm", { method: "POST", body });
    setSecurityStatus(securityPasswordStatus, result?.detail || "Password changed.", "success");
    if (securityPasswordOtpInput) securityPasswordOtpInput.value = "";
    if (securityPasswordNewInput) securityPasswordNewInput.value = "";
    if (securityPasswordConfirmInput) securityPasswordConfirmInput.value = "";
    passwordOtpVerified = false;
  } catch (error) {
    setSecurityStatus(securityPasswordStatus, error.message, "error");
  } finally {
    securityPasswordContinueBtn.disabled = false;
  }
});

securityEmailSendOtpBtn?.addEventListener("click", async () => {
  securityEmailSendOtpBtn.disabled = true;
  emailOtpVerified = false;
  try {
    const result = await App.api("/api/settings/security/email/send-otp", { method: "POST" });
    setSecurityStatus(
      securityEmailStatus,
      result?.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result?.detail || "OTP sent."),
      "success"
    );
  } catch (error) {
    setSecurityStatus(securityEmailStatus, error.message, "error");
  } finally {
    securityEmailSendOtpBtn.disabled = false;
  }
});

async function verifyEmailOtpIfReady() {
  const otp = normalizeDigitsInput(securityEmailOtpInput);
  if (!/^\d{6}$/.test(otp) || emailOtpVerified) return;
  try {
    const body = new URLSearchParams({ otp });
    const result = await App.api("/api/settings/security/email/verify-otp", { method: "POST", body });
    emailOtpVerified = true;
    setSecurityStatus(securityEmailStatus, result?.detail || "OTP verified.", "success");
  } catch (error) {
    emailOtpVerified = false;
    setSecurityStatus(securityEmailStatus, error.message, "error");
  }
}

securityEmailOtpInput?.addEventListener("input", () => {
  emailOtpVerified = false;
  verifyEmailOtpIfReady().catch(() => {});
});

securityEmailContinueBtn?.addEventListener("click", async () => {
  if (!emailOtpVerified) {
    setSecurityStatus(securityEmailStatus, "Enter OTP and wait for auto verification.", "error");
    return;
  }
  securityEmailContinueBtn.disabled = true;
  try {
    const body = new URLSearchParams({
      new_email: securityEmailNewInput?.value.trim().toLowerCase() || "",
      confirm_email: securityEmailConfirmInput?.value.trim().toLowerCase() || "",
    });
    const result = await App.api("/api/settings/security/email/confirm", { method: "POST", body });
    const me = App.getAuthUser();
    if (me) App.setAuth(App.getToken(), { ...me, email: result?.email || me.email });
    setSecurityStatus(securityEmailStatus, result?.detail || "Email updated.", "success");
    if (securityEmailOtpInput) securityEmailOtpInput.value = "";
    if (securityEmailNewInput) securityEmailNewInput.value = "";
    if (securityEmailConfirmInput) securityEmailConfirmInput.value = "";
    emailOtpVerified = false;
  } catch (error) {
    setSecurityStatus(securityEmailStatus, error.message, "error");
  } finally {
    securityEmailContinueBtn.disabled = false;
  }
});
