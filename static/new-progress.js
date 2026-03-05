const form = document.getElementById("post-form");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("screenshots");
const selectedMediaList = document.getElementById("selected-media-list");
const streakCounterEl = document.getElementById("streak-counter");
const streakValueEl = document.getElementById("streak-value");
const selectedFiles = [];
const previewObjectUrls = [];

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(size >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function clearPreviewObjectUrls() {
  while (previewObjectUrls.length) {
    const url = previewObjectUrls.pop();
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

function escapeText(text) {
  return (window.App && typeof window.App.escapeHtml === "function")
    ? window.App.escapeHtml(text)
    : String(text || "");
}

function inferMediaKind(file) {
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  const name = String(file.name || "").toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(name)) return "image";
  if (/\.(mp4|mov|m4v|webm|ogg|ogv)$/.test(name)) return "video";
  return "other";
}

function filePreviewMarkup(file) {
  const kind = inferMediaKind(file);
  if (kind === "other") {
    return `<div class="selected-media-thumb-fallback">${escapeText((file.name || "?").slice(0, 2).toUpperCase())}</div>`;
  }
  const objectUrl = URL.createObjectURL(file);
  previewObjectUrls.push(objectUrl);
  if (kind === "video") {
    return `<video class="selected-media-thumb-video" src="${objectUrl}" controls muted playsinline preload="metadata"></video>`;
  }
  return `<img class="selected-media-thumb-image" src="${objectUrl}" alt="${escapeText(file.name || "file")}" />`;
}

function renderSelectedFiles() {
  clearPreviewObjectUrls();
  if (!selectedFiles.length) {
    selectedMediaList.innerHTML = `<p class="selected-media-empty">No files selected yet.</p>`;
    return;
  }

  selectedMediaList.innerHTML = `
    <p class="selected-media-title">Selected files (${selectedFiles.length})</p>
    <div class="selected-media-items">
      ${selectedFiles
        .map(
          (file, index) => `
            <div class="selected-media-item">
              <div class="selected-media-thumb">
                ${filePreviewMarkup(file)}
              </div>
              <div class="selected-media-meta">
                <span class="selected-media-name" title="${escapeText(file.name)}">${escapeText(file.name)}</span>
                <span class="selected-media-size">${formatFileSize(file.size)}</span>
              </div>
              <button type="button" class="selected-media-remove" data-index="${index}" aria-label="Remove ${file.name}">Remove</button>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderStreakState(count) {
  if (!streakCounterEl || !streakValueEl) return;
  const value = Math.max(0, Number(count) || 0);
  streakValueEl.textContent = String(value);
  const isActive = value > 0;
  streakCounterEl.classList.toggle("streak-active", isActive);
  streakCounterEl.classList.toggle("streak-broken", !isActive);
}

function triggerStreakBurst() {
  if (!streakValueEl || typeof window.confetti !== "function") return;
  const rect = streakValueEl.getBoundingClientRect();
  const origin = {
    x: (rect.left + rect.width / 2) / window.innerWidth,
    y: (rect.top + rect.height / 2) / window.innerHeight,
  };
  window.confetti({
    particleCount: 90,
    spread: 78,
    startVelocity: 42,
    scalar: 0.9,
    ticks: 180,
    origin,
  });
  window.confetti({
    particleCount: 44,
    spread: 120,
    startVelocity: 28,
    scalar: 0.72,
    origin,
  });
}

if (!App.requireAuth()) {
  // redirected
}

const user = App.getAuthUser();
if (user) {
  statusEl.textContent = `Posting as @${user.username}`;
  renderStreakState(user.current_streak || 0);
} else {
  renderStreakState(0);
}

renderSelectedFiles();

fileInput.addEventListener("change", () => {
  const incoming = Array.from(fileInput.files || []);
  if (!incoming.length) return;

  const existing = new Set(selectedFiles.map(fileKey));
  for (const file of incoming) {
    const key = fileKey(file);
    if (!existing.has(key)) {
      selectedFiles.push(file);
      existing.add(key);
    }
  }
  renderSelectedFiles();
  fileInput.value = "";
});

selectedMediaList.addEventListener("click", (event) => {
  const btn = event.target.closest(".selected-media-remove");
  if (!btn) return;
  const index = Number(btn.dataset.index);
  if (Number.isNaN(index) || index < 0 || index >= selectedFiles.length) return;
  selectedFiles.splice(index, 1);
  renderSelectedFiles();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitBtn = form.querySelector("button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Publishing...";
  }
  const formData = new FormData();
  formData.append("goal_title", document.getElementById("goal-title").value.trim());
  formData.append("caption", document.getElementById("caption").value.trim());
  formData.append("day_experience", document.getElementById("day-experience").value.trim());
  formData.append("timezone_offset_minutes", String(new Date().getTimezoneOffset()));

  for (const file of selectedFiles) {
    formData.append("screenshots", file);
  }

  try {
    const result = await App.api("/api/posts", { method: "POST", body: formData });
    form.reset();
    selectedFiles.length = 0;
    renderSelectedFiles();
    const streakCount = Number(result?.new_streak_count) || 0;
    const streakJustIncreased = Boolean(result?.streak_just_increased);
    renderStreakState(streakCount);
    if (streakJustIncreased) {
      triggerStreakBurst();
    }
    const existingUser = App.getAuthUser();
    if (existingUser) {
      App.setAuth(App.getToken(), { ...existingUser, current_streak: streakCount });
    }
    statusEl.textContent = streakJustIncreased
      ? `Progress posted. Streak up to ${streakCount}.`
      : `Progress posted. Current streak: ${streakCount}.`;
    try {
      if (result && result.id) {
        sessionStorage.setItem("stepnix_just_posted", JSON.stringify(result));
      }
    } catch {
      // ignore storage errors
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Publish";
    }
    window.location.href = "/community-feed?posted=1";
  } catch (error) {
    statusEl.textContent = error.message;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Publish";
    }
  }
});
