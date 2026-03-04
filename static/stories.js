const storyForm = document.getElementById("story-form");
const storyMedia = document.getElementById("story-media");
const storyStatus = document.getElementById("story-status");
const storyPreviewMedia = document.getElementById("story-preview-media");
const storyPreviewOverlay = document.getElementById("story-preview-overlay");
const storyEmptyState = document.getElementById("story-empty-state");
const storyAddBtn = document.getElementById("story-add-btn");
const storyPostBtn = document.getElementById("story-post-btn");
const storyCaption = document.getElementById("story-caption");
const storyStickerPalette = document.getElementById("story-sticker-palette");
const storyQueue = document.getElementById("story-queue");
const storyMoreBtn = document.getElementById("story-more-btn");
const storyMoreMenu = document.getElementById("story-more-menu");
const storyAddMenuBtn = document.getElementById("story-add-menu-btn");
const storyRemoveMenuBtn = document.getElementById("story-remove-menu-btn");
const storyItemCounter = document.getElementById("story-item-counter");
const storyRemoveStickerBtn = document.getElementById("story-remove-sticker-btn");
const storyClearStickersBtn = document.getElementById("story-clear-stickers-btn");
const tabButtons = Array.from(document.querySelectorAll(".story-tab-btn"));
const tabPanels = {
  caption: document.getElementById("story-panel-caption"),
  sticker: document.getElementById("story-panel-sticker"),
};
const storyEditor = document.getElementById("story-editor");

if (!App.requireAuth()) {
  // redirected
}

const me = App.getAuthUser();
if (me) {
  storyStatus.textContent = `Posting as @${me.username}`;
}

const PREMIUM_STICKERS = [
  "🔥", "✨", "🚀", "💪", "🏆", "✅", "📈", "🎯", "⭐", "💯", "👏", "🎉",
  "🧠", "💡", "📚", "🧑‍💻", "☕", "🗓️", "📝", "📌", "🚧", "👑", "💎", "🌟",
  "🏁", "⚡", "🫡", "🙌", "🤝", "🫶", "❤️", "💙", "🖤", "😊", "😎", "🥳",
];

const storyItems = [];
let activeIndex = -1;
let activeTab = "caption";
let dragState = null;

function fileIdentity(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function isVideoFile(file) {
  return (file?.type || "").startsWith("video/");
}

function buildStoryCaption(item) {
  return (item.caption || "").trim();
}

function openPicker() {
  storyMedia.click();
}

function getActiveItem() {
  if (activeIndex < 0 || activeIndex >= storyItems.length) return null;
  return storyItems[activeIndex];
}

function nextStickerId(item) {
  let maxId = 0;
  (item.stickers || []).forEach((sticker) => {
    maxId = Math.max(maxId, Number(sticker.id) || 0);
  });
  return maxId + 1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setControlsDisabled(disabled) {
  const active = getActiveItem();
  storyMedia.disabled = disabled;
  storyAddBtn.disabled = disabled;
  storyPostBtn.disabled = disabled || !storyItems.length;
  storyCaption.disabled = disabled || !active;
  storyMoreBtn.disabled = disabled || !storyItems.length;
  storyAddMenuBtn.disabled = disabled;
  storyRemoveMenuBtn.disabled = disabled || activeIndex < 0;
  storyRemoveStickerBtn.disabled = disabled || !active || !active.selectedStickerId;
  storyClearStickersBtn.disabled = disabled || !active || !(active.stickers || []).length;

  tabButtons.forEach((btn) => {
    btn.disabled = disabled || !active;
  });
  storyStickerPalette.querySelectorAll("button").forEach((btn) => {
    btn.disabled = disabled || !active;
  });
}

function renderTabs() {
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === activeTab;
    btn.classList.toggle("is-active", isActive);
  });
  Object.entries(tabPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== activeTab);
  });
}

function renderStickerPalette() {
  const active = getActiveItem();
  const selectedText = active?.selectedStickerId
    ? (active.stickers || []).find((st) => st.id === active.selectedStickerId)?.text || ""
    : "";
  storyStickerPalette.querySelectorAll("button[data-sticker]").forEach((btn) => {
    btn.classList.toggle("is-active", !!selectedText && btn.dataset.sticker === selectedText);
  });
}

function renderQueue() {
  if (!storyItems.length) {
    storyQueue.innerHTML = "";
    return;
  }
  storyQueue.innerHTML = storyItems
    .map((item, index) => {
      const thumb = item.type === "video"
        ? `<video src="${item.previewUrl}" muted playsinline preload="metadata"></video>`
        : `<img src="${item.previewUrl}" alt="${item.file.name}" />`;
      return `
        <button type="button" class="story-queue-chip ${index === activeIndex ? "is-active" : ""}" data-index="${index}" aria-label="Story item ${index + 1}">
          ${thumb}
        </button>
      `;
    })
    .join("");
}

function renderStickers() {
  const active = getActiveItem();
  storyPreviewOverlay.innerHTML = "";
  if (!active || !(active.stickers || []).length) {
    storyPreviewOverlay.classList.add("hidden");
    return;
  }

  active.stickers.forEach((sticker) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `story-preview-sticker-item ${active.selectedStickerId === sticker.id ? "is-selected" : ""}`;
    button.dataset.stickerId = String(sticker.id);
    button.style.left = `${clamp(Number(sticker.x) || 50, 0, 100)}%`;
    button.style.top = `${clamp(Number(sticker.y) || 50, 0, 100)}%`;
    button.style.setProperty("--sticker-scale", String(clamp(Number(sticker.scale) || 1, 0.5, 2.5)));
    button.style.setProperty("--sticker-rotate", `${clamp(Number(sticker.rotate) || 0, -180, 180)}deg`);
    button.innerHTML = `<span>${sticker.text}</span>`;
    storyPreviewOverlay.appendChild(button);
  });

  storyPreviewOverlay.classList.remove("hidden");
}

function renderPreview() {
  const active = getActiveItem();
  storyPreviewMedia.innerHTML = "";

  if (!active) {
    storyEmptyState.classList.remove("hidden");
    storyEditor.classList.add("hidden");
    storyMoreBtn.classList.add("hidden");
    storyMoreMenu.classList.add("hidden");
    storyItemCounter.textContent = "";
    storyCaption.value = "";
    storyPreviewOverlay.classList.add("hidden");
    renderStickerPalette();
    setControlsDisabled(false);
    return;
  }

  storyEmptyState.classList.add("hidden");
  storyEditor.classList.remove("hidden");
  storyMoreBtn.classList.remove("hidden");
  storyItemCounter.textContent = `${activeIndex + 1}/${storyItems.length}`;

  if (active.type === "video") {
    const video = document.createElement("video");
    video.src = active.previewUrl;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    video.className = "story-preview-video";
    storyPreviewMedia.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = active.previewUrl;
    img.alt = active.file.name;
    img.className = "story-preview-image";
    storyPreviewMedia.appendChild(img);
  }

  storyCaption.value = active.caption || "";
  renderStickers();
  renderStickerPalette();
  setControlsDisabled(false);
}

function syncComposer() {
  renderTabs();
  renderQueue();
  renderPreview();
  storyPostBtn.disabled = !storyItems.length;
}

function selectIndex(index) {
  if (index < 0 || index >= storyItems.length) return;
  activeIndex = index;
  syncComposer();
}

function addStoryFiles(files) {
  if (!files.length) return;
  const existing = new Set(storyItems.map((item) => fileIdentity(item.file)));
  files.forEach((file) => {
    const key = fileIdentity(file);
    if (existing.has(key)) return;
    storyItems.push({
      file,
      type: isVideoFile(file) ? "video" : "image",
      previewUrl: URL.createObjectURL(file),
      caption: "",
      stickers: [],
      selectedStickerId: null,
    });
    existing.add(key);
  });
  if (activeIndex < 0 && storyItems.length) activeIndex = 0;
  syncComposer();
}

function removeActiveItem() {
  if (activeIndex < 0 || activeIndex >= storyItems.length) return;
  const [removed] = storyItems.splice(activeIndex, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  if (!storyItems.length) {
    activeIndex = -1;
  } else if (activeIndex >= storyItems.length) {
    activeIndex = storyItems.length - 1;
  }
  syncComposer();
}

function addStickerToActive(stickerText) {
  const active = getActiveItem();
  if (!active || !stickerText) return;
  const sticker = {
    id: nextStickerId(active),
    text: stickerText,
    x: 50,
    y: 44,
    scale: 1,
    rotate: 0,
  };
  active.stickers.push(sticker);
  active.selectedStickerId = sticker.id;
  renderStickers();
  renderStickerPalette();
  setControlsDisabled(false);
}

function removeSelectedSticker() {
  const active = getActiveItem();
  if (!active || !active.selectedStickerId) return;
  active.stickers = (active.stickers || []).filter((sticker) => sticker.id !== active.selectedStickerId);
  active.selectedStickerId = active.stickers[0]?.id || null;
  renderStickers();
  renderStickerPalette();
  setControlsDisabled(false);
}

function clearAllStickers() {
  const active = getActiveItem();
  if (!active) return;
  active.stickers = [];
  active.selectedStickerId = null;
  renderStickers();
  renderStickerPalette();
  setControlsDisabled(false);
}

function setStickerPosition(stickerId, clientX, clientY) {
  const active = getActiveItem();
  if (!active) return;
  const sticker = (active.stickers || []).find((item) => item.id === stickerId);
  if (!sticker) return;
  const rect = storyPreviewOverlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = ((clientX - rect.left) / rect.width) * 100;
  const y = ((clientY - rect.top) / rect.height) * 100;
  sticker.x = Math.round(clamp(x, 4, 96) * 100) / 100;
  sticker.y = Math.round(clamp(y, 4, 96) * 100) / 100;
}

function renderStickerPaletteButtons() {
  storyStickerPalette.innerHTML = PREMIUM_STICKERS.map((sticker) => (
    `<button type="button" data-sticker="${sticker}" aria-label="Add sticker ${sticker}">${sticker}</button>`
  )).join("");
}

storyAddBtn.addEventListener("click", openPicker);
storyAddMenuBtn.addEventListener("click", () => {
  storyMoreMenu.classList.add("hidden");
  openPicker();
});
storyRemoveMenuBtn.addEventListener("click", () => {
  storyMoreMenu.classList.add("hidden");
  removeActiveItem();
});

storyMoreBtn.addEventListener("click", () => {
  storyMoreMenu.classList.toggle("hidden");
});

document.addEventListener("click", (event) => {
  if (!storyMoreMenu.classList.contains("hidden")) {
    const inside = event.target.closest(".story-more-wrap");
    if (!inside) storyMoreMenu.classList.add("hidden");
  }
});

storyMedia.addEventListener("change", () => {
  addStoryFiles(Array.from(storyMedia.files || []));
  storyMedia.value = "";
});

storyQueue.addEventListener("click", (event) => {
  const chip = event.target.closest(".story-queue-chip");
  if (!chip) return;
  const index = Number(chip.dataset.index);
  if (Number.isNaN(index)) return;
  selectIndex(index);
});

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab || "caption";
    renderTabs();
  });
});

storyCaption.addEventListener("input", () => {
  const active = getActiveItem();
  if (!active) return;
  active.caption = storyCaption.value.trim();
});

storyStickerPalette.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sticker]");
  if (!button) return;
  addStickerToActive(button.dataset.sticker || "");
});

storyRemoveStickerBtn.addEventListener("click", removeSelectedSticker);
storyClearStickersBtn.addEventListener("click", clearAllStickers);

storyPreviewOverlay.addEventListener("pointerdown", (event) => {
  const node = event.target.closest(".story-preview-sticker-item");
  if (!node) {
    const active = getActiveItem();
    if (active) {
      active.selectedStickerId = null;
      renderStickers();
      renderStickerPalette();
      setControlsDisabled(false);
    }
    return;
  }

  const stickerId = Number(node.dataset.stickerId);
  if (Number.isNaN(stickerId)) return;
  const active = getActiveItem();
  if (!active) return;
  active.selectedStickerId = stickerId;
  renderStickerPalette();
  setControlsDisabled(false);

  dragState = { stickerId };
  node.setPointerCapture(event.pointerId);
  setStickerPosition(stickerId, event.clientX, event.clientY);
  renderStickers();
});

storyPreviewOverlay.addEventListener("pointermove", (event) => {
  if (!dragState) return;
  setStickerPosition(dragState.stickerId, event.clientX, event.clientY);
  renderStickers();
});

function stopDrag() {
  dragState = null;
}

storyPreviewOverlay.addEventListener("pointerup", stopDrag);
storyPreviewOverlay.addEventListener("pointercancel", stopDrag);
storyPreviewOverlay.addEventListener("pointerleave", stopDrag);

storyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!storyItems.length) {
    storyStatus.textContent = "Please add at least one story item.";
    return;
  }

  setControlsDisabled(true);
  storyStatus.textContent = `Posting ${storyItems.length} story item(s)...`;
  try {
    for (let i = 0; i < storyItems.length; i += 1) {
      const item = storyItems[i];
      const formData = new FormData();
      formData.append("story_media", item.file);
      formData.append("caption", buildStoryCaption(item));
      formData.append("sticker_data", JSON.stringify(item.stickers || []));
      await App.api("/api/stories", { method: "POST", body: formData });
      storyStatus.textContent = `Posted ${i + 1}/${storyItems.length}...`;
    }
    window.location.href = "/community-feed";
  } catch (error) {
    storyStatus.textContent = error.message;
    setControlsDisabled(false);
  }
});

renderStickerPaletteButtons();
syncComposer();
