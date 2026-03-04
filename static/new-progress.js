const form = document.getElementById("post-form");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("screenshots");
const selectedMediaList = document.getElementById("selected-media-list");
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

if (!App.requireAuth()) {
  // redirected
}

const user = App.getAuthUser();
if (user) {
  statusEl.textContent = `Posting as @${user.username}`;
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

  for (const file of selectedFiles) {
    formData.append("screenshots", file);
  }

  try {
    await App.api("/api/posts", { method: "POST", body: formData });
    form.reset();
    selectedFiles.length = 0;
    renderSelectedFiles();
    statusEl.textContent = "Progress posted.";
    window.location.href = "/community-feed";
  } catch (error) {
    statusEl.textContent = error.message;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Publish";
    }
  }
});
