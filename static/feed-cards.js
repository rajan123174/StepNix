function isVideoMedia(url) {
  if (!url) return false;
  const clean = String(url).split("?")[0].toLowerCase();
  return [".mp4", ".mov", ".m4v", ".webm"].some((ext) => clean.endsWith(ext));
}

function formatPostDateTime(isoValue) {
  const date = new Date(isoValue);
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / dayMs);

  let relative = "today";
  if (days === 1) relative = "yesterday";
  else if (days < 7) relative = `${days} days ago`;
  else if (days < 30) relative = `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? "s" : ""} ago`;
  else if (days < 365) relative = `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
  else relative = `${Math.floor(days / 365)} year${Math.floor(days / 365) > 1 ? "s" : ""} ago`;

  const absolute = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);

  return { absolute, relative };
}

function renderPostMediaElement(url, cssClass, alt) {
  if (isVideoMedia(url)) {
    return `<video class="${cssClass}" src="${url}" preload="metadata" muted playsinline></video>`;
  }
  return `<img class="${cssClass}" src="${url}" alt="${alt}" />`;
}

function attachHoverLoopPlayback(video, resetOnLeave = true) {
  if (!video || video.tagName !== "VIDEO") return;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  let isHovering = false;
  const play = () => {
    isHovering = true;
    void video.play().catch(() => {});
  };
  const pause = () => {
    isHovering = false;
    video.pause();
    if (resetOnLeave) {
      try {
        video.currentTime = 0;
      } catch {
        // Some browsers may block setting currentTime before metadata.
      }
    }
  };
  video.addEventListener("mouseenter", play);
  video.addEventListener("mouseleave", pause);
  video.addEventListener("focus", play);
  video.addEventListener("blur", pause);
  video.addEventListener("ended", () => {
    if (isHovering && video.loop) {
      void video.play().catch(() => {});
    }
  });
}

function ensurePostImageModal() {
  let modal = document.getElementById("post-image-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "post-image-modal";
  modal.className = "post-image-modal hidden";
  modal.innerHTML = `
    <div class="post-image-backdrop"></div>
    <div class="post-image-content">
      <button id="post-image-prev" class="post-image-nav prev" type="button" aria-label="Previous image">‹</button>
      <img id="post-image-preview" src="" alt="Post Image" />
      <video id="post-video-preview" class="hidden" controls playsinline preload="metadata"></video>
      <button id="post-image-next" class="post-image-nav next" type="button" aria-label="Next image">›</button>
      <small id="post-image-count" class="post-image-count"></small>
      <button id="post-image-close" class="alt" type="button">Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.classList.add("hidden");
  const prev = () => {
    if (postGalleryImages.length <= 1) return;
    postGalleryIndex = (postGalleryIndex - 1 + postGalleryImages.length) % postGalleryImages.length;
    renderPostImageModal();
  };
  const next = () => {
    if (postGalleryImages.length <= 1) return;
    postGalleryIndex = (postGalleryIndex + 1) % postGalleryImages.length;
    renderPostImageModal();
  };
  modal.querySelector(".post-image-backdrop").addEventListener("click", close);
  modal.querySelector("#post-image-close").addEventListener("click", close);
  modal.querySelector("#post-image-prev").addEventListener("click", prev);
  modal.querySelector("#post-image-next").addEventListener("click", next);
  return modal;
}

let postGalleryImages = [];
let postGalleryIndex = 0;

function renderPostImageModal() {
  const modal = ensurePostImageModal();
  const preview = modal.querySelector("#post-image-preview");
  const videoPreview = modal.querySelector("#post-video-preview");
  const prevBtn = modal.querySelector("#post-image-prev");
  const nextBtn = modal.querySelector("#post-image-next");
  const countEl = modal.querySelector("#post-image-count");
  const total = postGalleryImages.length;
  if (!total) return;
  const currentSrc = postGalleryImages[postGalleryIndex];
  const showVideo = isVideoMedia(currentSrc);
  preview.classList.toggle("hidden", showVideo);
  videoPreview.classList.toggle("hidden", !showVideo);
  if (showVideo) {
    preview.removeAttribute("src");
    videoPreview.src = currentSrc;
    videoPreview.currentTime = 0;
    void videoPreview.play().catch(() => {});
  } else {
    videoPreview.pause();
    videoPreview.removeAttribute("src");
    preview.src = currentSrc;
  }
  countEl.textContent = `${postGalleryIndex + 1} / ${total}`;
  const many = total > 1;
  prevBtn.classList.toggle("hidden", !many);
  nextBtn.classList.toggle("hidden", !many);
}

function openPostImageGallery(images, startIndex = 0) {
  postGalleryImages = Array.isArray(images) ? images.filter(Boolean) : [];
  if (!postGalleryImages.length) return;
  postGalleryIndex = Math.max(0, Math.min(startIndex, postGalleryImages.length - 1));
  const modal = ensurePostImageModal();
  renderPostImageModal();
  modal.classList.remove("hidden");
}

function openPostImage(src) {
  openPostImageGallery([src], 0);
}

function ensurePostLikersModal() {
  let modal = document.getElementById("post-likers-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "post-likers-modal";
  modal.className = "follow-list-modal hidden";
  modal.innerHTML = `
    <div class="follow-list-backdrop"></div>
    <div class="follow-list-content">
      <div class="follow-list-head">
        <h3 id="post-likers-title">Liked By</h3>
        <button id="post-likers-close" class="follow-list-close-x" type="button" aria-label="Close">✕</button>
      </div>
      <div id="post-likers-list" class="user-results"></div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.classList.add("hidden");
  modal.querySelector(".follow-list-backdrop").addEventListener("click", close);
  modal.querySelector("#post-likers-close").addEventListener("click", close);
  return modal;
}

async function openPostLikers(postId) {
  const modal = ensurePostLikersModal();
  const list = modal.querySelector("#post-likers-list");
  list.innerHTML = "<p class='notice'>Loading...</p>";
  modal.classList.remove("hidden");
  try {
    const users = await App.api(`/api/posts/${postId}/likes/users`);
    if (!users.length) {
      list.innerHTML = "<p class='notice'>No likes yet.</p>";
      return;
    }
    list.innerHTML = users
      .map(
        (user) => `
          <button type="button" class="user-result-card post-liker-card" data-user-id="${user.id}">
            <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
            <div class="user-result-meta">
              <strong>${user.full_name}</strong>
              <small>@${user.username}</small>
            </div>
          </button>
        `
      )
      .join("");
    list.querySelectorAll(".post-liker-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const userId = btn.dataset.userId;
        if (!userId) return;
        modal.classList.add("hidden");
        window.location.href = `/user/${userId}`;
      });
    });
  } catch (error) {
    list.innerHTML = `<p class='notice'>${error.message}</p>`;
  }
}

function shareDeviceId() {
  let id = localStorage.getItem("chatDeviceId");
  if (!id) {
    id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem("chatDeviceId", id);
  }
  return id;
}

function shareChatHeaders() {
  const headers = new Headers();
  const chatToken = localStorage.getItem("chatToken") || "";
  if (chatToken) headers.set("X-Chat-Token", chatToken);
  headers.set("X-Device-Id", shareDeviceId());
  const authToken = App.getToken();
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  return headers;
}

async function shareChatApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  shareChatHeaders().forEach((value, key) => headers.set(key, value));
  const target = window.App?.resolveApiUrl ? window.App.resolveApiUrl(path) : path;
  const response = await fetch(target, { ...options, headers });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(async () => ({ detail: (await response.text().catch(() => "")).trim() || `Request failed (${response.status})` }));
    throw new Error(error.detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function ensurePostShareModal() {
  let modal = document.getElementById("post-share-chat-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "post-share-chat-modal";
  modal.className = "share-chat-modal hidden";
  modal.innerHTML = `
    <div class="share-chat-backdrop"></div>
    <div class="share-chat-content">
      <div class="share-chat-head">
        <h3>Share To Message</h3>
        <button id="post-share-chat-close" class="follow-list-close-x" type="button" aria-label="Close">✕</button>
      </div>
      <div id="post-share-chat-preview" class="share-chat-preview"></div>
      <div id="post-share-external-apps" class="share-apps share-chat-external-apps"></div>
      <input id="post-share-chat-search" class="follow-list-search" type="search" placeholder="Search followers/following..." />
      <p id="post-share-chat-status" class="notice"></p>
      <div id="post-share-chat-list" class="share-chat-list"></div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.classList.add("hidden");
  modal.querySelector(".share-chat-backdrop").addEventListener("click", close);
  modal.querySelector("#post-share-chat-close").addEventListener("click", close);
  return modal;
}

let shareSearchTimer = null;

function renderShareRecipientRows(listEl, users, post) {
  if (!users.length) {
    listEl.innerHTML = "<p class='notice'>No users found in your followers/following network.</p>";
    return;
  }
  listEl.innerHTML = users
    .map(
      (user) => `
        <div class="share-chat-row" data-user-id="${user.id}">
          <div class="share-chat-user">
            <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
            <div>
              <strong>${user.full_name}</strong>
              <small>@${user.username}</small>
            </div>
          </div>
          <button class="share-chat-send-btn" type="button" aria-label="Send post to @${user.username}">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 11.5L21 3l-8.5 18-2.4-6.1L3 11.5z"></path>
              <path d="M10.1 14.9L21 3"></path>
            </svg>
          </button>
          <span class="share-chat-sent-text hidden">Shared</span>
        </div>
      `
    )
    .join("");

  listEl.querySelectorAll(".share-chat-row").forEach((row) => {
    const btn = row.querySelector(".share-chat-send-btn");
    const sentText = row.querySelector(".share-chat-sent-text");
    btn?.addEventListener("click", async () => {
      const userId = Number(row.dataset.userId || 0);
      if (!userId) return;
      btn.disabled = true;
      try {
        await shareChatApi(`/api/chat/messages/${userId}`, {
          method: "POST",
          body: new URLSearchParams({ content: `[[STEPNIX_SHARE_POST:${post.id}]]` }),
        });
        row.classList.add("is-shared");
        sentText?.classList.remove("hidden");
        if (window.App && typeof window.App.playActionBurst === "function") {
          window.App.playActionBurst(row.querySelector("img"), "✓");
        }
      } catch (error) {
        alert(error.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderSharePostPreview(modal, post) {
  const preview = modal.querySelector("#post-share-chat-preview");
  const thumb = post.screenshots?.[0] || "";
  const thumbHtml = thumb
    ? (isVideoMedia(thumb)
      ? `<video src="${thumb}" muted playsinline preload="metadata"></video>`
      : `<img src="${thumb}" alt="${post.goal_title}" />`)
    : `<div class="share-chat-preview-fallback">No media</div>`;
  preview.innerHTML = `
    <div class="share-chat-preview-card">
      ${thumbHtml}
      <div>
        <strong>${post.goal_title || "StepNix post"}</strong>
        <small>@${post.author?.username || "user"}</small>
      </div>
    </div>
  `;
}

function renderExternalShareApps(modal, post) {
  const wrap = modal.querySelector("#post-share-external-apps");
  if (!wrap) return;
  const postUrl = `${window.location.origin}/post/${post.id}`;
  const logoUrl = `${window.location.origin}/static/stepnix-logo.svg?v=3`;
  const shareText = `StepNix Post: ${post.goal_title}\n${post.caption ? `${post.caption}\n` : ""}Logo: ${logoUrl}\nOpen: ${postUrl}`;
  const encodedText = encodeURIComponent(shareText);
  const encodedUrl = encodeURIComponent(postUrl);
  const gmailBody = encodeURIComponent(`${shareText}\n\nLogin/Register to view this post on StepNix.`);
  wrap.innerHTML = `
    <a class="share-app-btn whatsapp" target="_blank" rel="noopener noreferrer" href="https://wa.me/?text=${encodedText}" aria-label="Share on WhatsApp">
      <svg class="share-app-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M20.52 3.48A11.9 11.9 0 0 0 12.04 0C5.45 0 .1 5.35.1 11.94c0 2.1.55 4.16 1.6 5.98L0 24l6.23-1.63a11.9 11.9 0 0 0 5.7 1.45h.01c6.59 0 11.95-5.35 11.95-11.94 0-3.19-1.24-6.18-3.37-8.4Zm-8.57 18.3h-.01a9.9 9.9 0 0 1-5.03-1.37l-.36-.22-3.7.97.99-3.61-.23-.37a9.9 9.9 0 0 1-1.53-5.24C2.08 6.47 6.6 1.95 12.05 1.95c2.65 0 5.15 1.03 7.02 2.9a9.88 9.88 0 0 1 2.88 7.03c0 5.46-4.54 9.9-10 9.9Zm5.43-7.42c-.3-.15-1.76-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.64.07-.3-.15-1.24-.46-2.36-1.47-.87-.78-1.46-1.75-1.63-2.05-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.6-.91-2.2-.24-.56-.49-.49-.67-.5h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5s1.06 2.9 1.2 3.1c.15.2 2.08 3.18 5.04 4.45.7.3 1.25.48 1.68.62.7.22 1.33.19 1.83.12.56-.08 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35Z"/>
      </svg>
    </a>
    <a class="share-app-btn instagram" target="_blank" rel="noopener noreferrer" href="https://www.instagram.com/direct/inbox/" aria-label="Share on Instagram messages" data-tooltip="Link will be copied. Paste in Instagram messages." data-instagram-share="1" data-share-text="${encodedText}">
      <svg class="share-app-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5" ry="5" fill="none" stroke="currentColor" stroke-width="2"/>
        <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/>
        <circle cx="17.3" cy="6.8" r="1.2" fill="currentColor"/>
      </svg>
    </a>
    <a class="share-app-btn linkedin" target="_blank" rel="noopener noreferrer" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}" aria-label="Share on LinkedIn">
      <svg class="share-app-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M20.45 20.45h-3.56v-5.58c0-1.33-.03-3.05-1.86-3.05-1.86 0-2.14 1.45-2.14 2.95v5.68H9.33V9h3.42v1.56h.05c.48-.9 1.63-1.86 3.35-1.86 3.58 0 4.24 2.36 4.24 5.43v6.32ZM5.31 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.1 20.45H3.5V9H7.1v11.45Z"/>
      </svg>
    </a>
    <a class="share-app-btn facebook" target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" aria-label="Share on Facebook">
      <svg class="share-app-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M13.75 21v-7.7h2.6l.39-3h-2.99V8.4c0-.87.24-1.46 1.49-1.46H17V4.25c-.3-.04-1.35-.13-2.57-.13-2.54 0-4.28 1.55-4.28 4.39v1.79H7.29v3h2.86V21h3.6Z"/>
      </svg>
    </a>
    <a class="share-app-btn gmail" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(`StepNix shared post: ${post.goal_title}`)}&body=${gmailBody}" aria-label="Share on Gmail">
      <svg class="share-app-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M2.5 6.75 12 13.6l9.5-6.85V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2.5 18V6.75Z"/>
        <path fill="#fff" d="M2.5 6.25A1.75 1.75 0 0 1 4.25 4.5h15.5A1.75 1.75 0 0 1 21.5 6.25V7L12 13.7 2.5 7v-.75Z"/>
      </svg>
    </a>
  `;

  const igBtn = wrap.querySelector("[data-instagram-share='1']");
  igBtn?.addEventListener("click", async () => {
    const raw = decodeURIComponent(igBtn.getAttribute("data-share-text") || "");
    try {
      await navigator.clipboard.writeText(raw);
      const status = modal.querySelector("#post-share-chat-status");
      if (status) status.textContent = "Opened Instagram messages. Post link copied, paste in DM.";
    } catch {
      // No-op if clipboard is blocked; user can still copy manually.
    }
  });
}

async function openPostShareModal(post) {
  const modal = ensurePostShareModal();
  const listEl = modal.querySelector("#post-share-chat-list");
  const statusEl = modal.querySelector("#post-share-chat-status");
  const searchEl = modal.querySelector("#post-share-chat-search");

  renderSharePostPreview(modal, post);
  renderExternalShareApps(modal, post);
  searchEl.value = "";
  statusEl.textContent = "Loading recent chats...";
  listEl.innerHTML = "<p class='notice'>Loading...</p>";
  modal.classList.remove("hidden");

  const loadRecipients = async (query = "") => {
    try {
      const rows = await shareChatApi(`/api/chat/share-recipients?query=${encodeURIComponent(query)}`);
      statusEl.textContent = query.trim()
        ? "Search results from your followers/following."
        : "Recent chats first from your followers/following.";
      renderShareRecipientRows(listEl, rows || [], post);
    } catch (error) {
      const text = String(error.message || "");
      if (text.includes("Chat login required") || text.includes("Chat session")) {
        statusEl.textContent = "Login to chat service first, then share this post.";
        listEl.innerHTML = `
          <button type="button" class="share-chat-login-btn">Open Chats Login</button>
        `;
        listEl.querySelector(".share-chat-login-btn")?.addEventListener("click", () => {
          window.location.href = "/chats";
        });
        return;
      }
      statusEl.textContent = text;
      listEl.innerHTML = "<p class='notice'>Unable to load users right now.</p>";
    }
  };

  await loadRecipients("");

  searchEl.oninput = () => {
    if (shareSearchTimer) clearTimeout(shareSearchTimer);
    shareSearchTimer = setTimeout(() => {
      loadRecipients(searchEl.value || "").catch(() => {});
    }, 180);
  };
}

function createPostCard(post, onUpdated) {
  const animate = (el, icon) => {
    if (window.App && typeof window.App.playActionBurst === "function") {
      window.App.playActionBurst(el, icon);
    }
  };

  const wrapper = document.createElement("article");
  wrapper.className = "post-card";
  wrapper.dataset.authorId = String(post.author.id);
  wrapper.dataset.postId = String(post.id);

  const createdAt = formatPostDateTime(post.created_at);
  const isSingleVideoPost = post.screenshots.length === 1 && isVideoMedia(post.screenshots[0]);
  const photo = post.author.profile_photo_url || "/static/default-avatar.svg";
  const me = App.getAuthUser();
  const isOwner = me && me.id === post.author.id;

  const headerHtml = isSingleVideoPost
    ? ""
    : `
    <div class="post-header">
      <a class="post-author-link" href="/user/${post.author.id}" aria-label="View @${post.author.username} profile">
        <img class="avatar sm" src="${photo}" alt="${post.author.username}" />
      </a>
      <div class="post-head-main">
        <div class="post-meta">
          <a class="post-author-link post-author-name-link" href="/user/${post.author.id}">@${post.author.username}</a>
          <span> • ${createdAt.absolute} • ${createdAt.relative}</span>
        </div>
        <h3 class="post-goal">${post.goal_title}</h3>
      </div>
      ${!isOwner ? `<button class="follow-btn ${post.author.is_following ? "is-following" : ""}" type="button">${post.author.is_following ? "Following" : "Follow"}</button>` : ""}
    </div>`;
  const captionHtml = isSingleVideoPost ? "" : `<p class="post-caption">${post.caption || "No caption"}</p>`;
  const dayExperienceHtml = isSingleVideoPost
    ? ""
    : `${post.day_experience ? `<p class="post-caption"><strong>Today I Learned:</strong> ${post.day_experience}</p>` : ""}`;

  wrapper.innerHTML = `
    ${headerHtml}
    ${captionHtml}
    ${dayExperienceHtml}
    <div class="post-images"></div>
    <div class="post-actions">
      <button class="like-btn icon-action-btn" type="button" aria-label="Like">
        <svg viewBox="0 0 24 24" class="icon-svg icon-like" aria-hidden="true">
          <path d="M2.75 9.75h4.5v10.5h-4.5V9.75Zm6 10.5h8.32a2 2 0 0 0 1.95-1.57l1.23-5.25A2 2 0 0 0 18.3 11H13V5.55a2.3 2.3 0 0 0-4.48-.79l-1.26 3.88A1.6 1.6 0 0 1 5.74 9.75"></path>
        </svg>
      </button>
      <button class="like-count-text" type="button" aria-label="View users who liked this post">${post.like_count} likes</button>
      <span class="comment-count-text">${post.comment_count} comments</span>
      <button class="comment-toggle icon-action-btn" type="button" aria-label="Comments">
        <svg viewBox="0 0 24 24" class="icon-svg icon-comment" aria-hidden="true">
          <path d="M12 3.25c-4.97 0-9 3.8-9 8.48 0 2.65 1.3 5.01 3.35 6.57L5.5 21l3.98-1.59c.8.2 1.64.31 2.52.31 4.97 0 9-3.8 9-8.48 0-4.68-4.03-7.99-9-7.99Z"></path>
        </svg>
      </button>
      <button class="share-toggle icon-action-btn" type="button" aria-label="Share">
        <svg viewBox="0 0 24 24" class="icon-svg icon-share" aria-hidden="true">
          <path d="M15.5 7.5 8.2 11.2"></path>
          <path d="M15.5 16.5 8.2 12.8"></path>
          <circle cx="17.5" cy="6.5" r="2.5"></circle>
          <circle cx="6.5" cy="12" r="2.5"></circle>
          <circle cx="17.5" cy="17.5" r="2.5"></circle>
        </svg>
      </button>
    </div>
    <div class="comments hidden">
      <div class="comment-list"></div>
      <form class="comment-form">
        <input class="comment-input" placeholder="Write comment and mention with @username" required />
        <button type="submit">Post Comment</button>
      </form>
    </div>
  `;

  const imageWrap = wrapper.querySelector(".post-images");
  const likeBtn = wrapper.querySelector(".like-btn");
  let followBtn = wrapper.querySelector(".follow-btn");
  const likeCount = wrapper.querySelector(".like-count-text");
  const commentCount = wrapper.querySelector(".comment-count-text");
  const commentToggle = wrapper.querySelector(".comment-toggle");
  const shareToggle = wrapper.querySelector(".share-toggle");
  const commentsBox = wrapper.querySelector(".comments");
  const commentList = wrapper.querySelector(".comment-list");
  const commentForm = wrapper.querySelector(".comment-form");
  const commentInput = wrapper.querySelector(".comment-input");
  imageWrap.style.width = "100%";
  likeBtn.classList.toggle("is-active", !!post.liked_by_me);

  if (post.screenshots.length) {
    if (post.screenshots.length === 1) {
      if (isSingleVideoPost) {
        wrapper.classList.add("video-feed-post");
        imageWrap.innerHTML = `
          <div class="video-cover-wrap">
            <video class="single-post-media single-post-video-cover" src="${post.screenshots[0]}" controls playsinline preload="metadata"></video>
            <div class="video-cover-top">
              <div class="video-cover-author">
                <a class="post-author-link" href="/user/${post.author.id}" aria-label="View @${post.author.username} profile">
                  <img class="avatar sm" src="${photo}" alt="${post.author.username}" />
                </a>
                <div class="video-cover-meta">
                  <a class="post-author-link video-cover-name" href="/user/${post.author.id}">@${post.author.username}</a>
                  <span class="video-cover-time">${createdAt.absolute} • ${createdAt.relative}</span>
                </div>
              </div>
              ${
                !isOwner
                  ? `<button class="follow-btn video-follow-btn ${post.author.is_following ? "is-following" : ""}" type="button">${post.author.is_following ? "Following" : "Follow"}</button>`
                  : ""
              }
            </div>
            <div class="video-cover-bottom">
              <h3 class="video-cover-goal">${post.goal_title}</h3>
              ${post.caption ? `<p class="video-cover-caption">${post.caption}</p>` : ""}
              ${post.day_experience ? `<p class="video-cover-caption"><strong>Today I Learned:</strong> ${post.day_experience}</p>` : ""}
            </div>
          </div>
        `;
      } else {
        imageWrap.innerHTML = renderPostMediaElement(post.screenshots[0], "single-post-media", "Progress media");
      }

      const single = imageWrap.querySelector(".single-post-media");
      if (single && single.tagName === "VIDEO") {
        single.controls = true;
        attachHoverLoopPlayback(single, true);
      } else if (single) {
        single.addEventListener("click", () => openPostImage(post.screenshots[0]));
      }
    } else {
      const previewCount = Math.min(3, post.screenshots.length);
      const remaining = post.screenshots.length - previewCount;
      imageWrap.innerHTML = `<div class="post-collage count-${previewCount}"></div>`;
      const collage = imageWrap.querySelector(".post-collage");

      for (let i = 0; i < previewCount; i += 1) {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = `post-collage-tile tile-${i + 1}`;
        tile.innerHTML = renderPostMediaElement(post.screenshots[i], "post-collage-media", `Progress media ${i + 1}`);
        const tileVideo = tile.querySelector("video");
        if (tileVideo) {
          tileVideo.muted = true;
          tileVideo.autoplay = false;
          tileVideo.controls = false;
          attachHoverLoopPlayback(tileVideo, true);
        }
        if (i === previewCount - 1 && remaining > 0) {
          tile.classList.add("has-more");
          tile.insertAdjacentHTML("beforeend", `<span class="post-collage-more">+${remaining}</span>`);
        }
        tile.addEventListener("click", () => openPostImageGallery(post.screenshots, i));
        collage.appendChild(tile);
      }
    }
  } else {
    imageWrap.innerHTML = "<small>No media added in this post.</small>";
  }

  if (!followBtn) {
    followBtn = wrapper.querySelector(".follow-btn");
  }

  if (followBtn) {
    let followSyncInFlight = false;
    let confirmedFollowing = !!post.author.is_following;
    let desiredFollowing = confirmedFollowing;

    const paintFollow = (isFollowing) => {
      post.author.is_following = isFollowing;
      followBtn.textContent = isFollowing ? "Following" : "Follow";
      followBtn.classList.toggle("is-following", isFollowing);
    };

    const syncFollowState = async () => {
      if (followSyncInFlight) return;
      followSyncInFlight = true;
      try {
        while (confirmedFollowing !== desiredFollowing) {
          const targetFollowing = desiredFollowing;
          if (targetFollowing) {
            await App.api(`/api/users/${post.author.id}/follow`, { method: "POST" });
          } else {
            await App.api(`/api/users/${post.author.id}/follow`, { method: "DELETE" });
          }
          confirmedFollowing = targetFollowing;
          post.author.follower_count = Math.max(
            0,
            Number(post.author.follower_count || 0) + (confirmedFollowing ? 1 : -1)
          );
          if (onUpdated) {
            onUpdated({
              type: "follow",
              userId: Number(post.author.id || 0),
              isFollowing: !!confirmedFollowing,
              followerCount: Number(post.author.follower_count || 0),
            });
          }
        }

        // Refresh auth context in background.
        Promise.resolve()
          .then(() => App.api("/api/auth/me"))
          .then((me) => App.setAuth(App.getToken(), me))
          .catch(() => {});
      } catch (error) {
        desiredFollowing = confirmedFollowing;
        paintFollow(confirmedFollowing);
        alert(error.message);
      } finally {
        followSyncInFlight = false;
      }
    };

    followBtn.addEventListener("click", async () => {
      const nextFollowing = !desiredFollowing;
      const wasDesiredFollowing = desiredFollowing;
      desiredFollowing = nextFollowing;
      paintFollow(nextFollowing);
      if (!wasDesiredFollowing && nextFollowing) {
        animate(followBtn, "✓");
      }
      void syncFollowState();
    });
  }

  async function loadComments() {
    const comments = await App.api(`/api/posts/${post.id}/comments`);
    commentList.innerHTML = "";
    if (!comments.length) {
      commentList.innerHTML = "<small>No comments yet.</small>";
      return;
    }
    comments.forEach((comment) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      item.dataset.commentId = String(comment.id);
      const avatar = comment.author.profile_photo_url || "/static/default-avatar.svg";
      const summary = Object.entries(comment.reaction_summary || {})
        .map(([type, count]) => `${type}: ${count}`)
        .join(" • ");
      const myReaction = comment.current_user_reaction || "";
      item.innerHTML = `
        <div class="comment-head">
          <a class="comment-author-link" href="/user/${comment.author.id}" aria-label="View @${comment.author.username} profile">
            <img class="comment-avatar" src="${avatar}" alt="${comment.author.username}" />
          </a>
          <small>
            <a class="comment-author-link comment-author-name-link" href="/user/${comment.author.id}">@${comment.author.username}</a>
            • User ID: ${comment.author.id}
          </small>
        </div>
        <div>${App.mentionMarkup(comment.content)}</div>
        <button class="comment-reaction-summary-btn" type="button">
          ${comment.reaction_count || 0} reactions${summary ? ` • ${summary}` : ""}
        </button>
        <div class="comment-reactors hidden"></div>
        <div class="comment-reactions">
          <button class="comment-react-btn ${myReaction === "like" ? "is-active" : ""}" data-reaction="like" type="button" aria-label="Like">
            <svg viewBox="0 0 24 24" fill="${myReaction === "like" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V21H4V11H8Z"/><path d="M8 21H16.5C17.9 21 19.1 20.1 19.6 18.8L21 14.7C21.6 13 20.3 11.2 18.5 11.2H14V5.7C14 4.2 12.8 3 11.3 3L8 11Z"/></svg>
          </button>
          <button class="comment-react-btn ${myReaction === "love" ? "is-active" : ""}" data-reaction="love" type="button" aria-label="Love">
            <svg viewBox="0 0 24 24" fill="${myReaction === "love" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-7-4.4-9.2-8.4C1.2 8.8 2.4 5.8 5.3 4.8c2.1-.7 4.2.1 5.7 1.9 1.5-1.8 3.6-2.6 5.7-1.9 2.9 1 4.1 4 2.5 7.3-2.2 4-9.2 8.4-9.2 8.4Z"/></svg>
          </button>
          <button class="comment-react-btn ${myReaction === "celebrate" ? "is-active" : ""}" data-reaction="celebrate" type="button" aria-label="Celebrate">
            <svg viewBox="0 0 24 24" fill="${myReaction === "celebrate" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.8 13.9 8l4.6.4-3.5 3 1 4.5L12 13.7l-4 2.2 1-4.5-3.5-3 4.6-.4L12 3.8Z"/></svg>
          </button>
        </div>
      `;
      const summaryBtn = item.querySelector(".comment-reaction-summary-btn");
      const reactorsBox = item.querySelector(".comment-reactors");
      const reactionIcon = {
        like: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V21H4V11H8Z"/><path d="M8 21H16.5C17.9 21 19.1 20.1 19.6 18.8L21 14.7C21.6 13 20.3 11.2 18.5 11.2H14V5.7C14 4.2 12.8 3 11.3 3L8 11Z"/></svg>',
        love: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-7-4.4-9.2-8.4C1.2 8.8 2.4 5.8 5.3 4.8c2.1-.7 4.2.1 5.7 1.9 1.5-1.8 3.6-2.6 5.7-1.9 2.9 1 4.1 4 2.5 7.3-2.2 4-9.2 8.4-9.2 8.4Z"/></svg>',
        celebrate: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.8 13.9 8l4.6.4-3.5 3 1 4.5L12 13.7l-4 2.2 1-4.5-3.5-3 4.6-.4L12 3.8Z"/></svg>',
      };
      summaryBtn.addEventListener("click", async () => {
        const opening = reactorsBox.classList.contains("hidden");
        if (!opening) {
          reactorsBox.classList.add("hidden");
          return;
        }
        try {
          const rows = await App.api(`/api/comments/${comment.id}/reactions`);
          if (!rows.length) {
            reactorsBox.innerHTML = "<small>No reactions yet.</small>";
          } else {
            reactorsBox.innerHTML = rows
              .map((row) => {
                const actor = row.user || {};
                const dp = actor.profile_photo_url || "/static/default-avatar.svg";
                const icon = reactionIcon[row.reaction_type] || "";
                return `
                  <div class="comment-reactor-item">
                    <a class="comment-author-link" href="/user/${actor.id || 0}" aria-label="View @${actor.username || "user"} profile">
                      <img class="comment-reactor-avatar" src="${dp}" alt="${actor.username || "user"}" />
                    </a>
                    <small>
                      <a class="comment-author-link comment-author-name-link" href="/user/${actor.id || 0}"><strong>@${actor.username || "user"}</strong></a>
                    </small>
                    <span class="comment-reactor-icon">${icon}</span>
                  </div>
                `;
              })
              .join("");
          }
          reactorsBox.classList.remove("hidden");
        } catch (error) {
          alert(error.message);
        }
      });
      item.querySelectorAll(".comment-react-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const reactionType = btn.dataset.reaction;
            if (reactionType === myReaction) {
              await App.api(`/api/comments/${comment.id}/reactions`, { method: "DELETE" });
            } else {
              await App.api(`/api/comments/${comment.id}/reactions`, {
                method: "POST",
                body: new URLSearchParams({ reaction_type: reactionType }),
              });
            }
            await loadComments();
          } catch (error) {
            alert(error.message);
          }
        });
      });
      commentList.appendChild(item);
    });
  }

  let likeSyncInFlight = false;
  let confirmedLiked = !!post.liked_by_me;
  let desiredLiked = confirmedLiked;

  const paintLike = (liked) => {
    post.liked_by_me = liked;
    likeBtn.classList.toggle("is-active", liked);
    likeCount.textContent = `${post.like_count} likes`;
  };

  const syncLikeState = async () => {
    if (likeSyncInFlight) return;
    likeSyncInFlight = true;
    try {
      while (confirmedLiked !== desiredLiked) {
        const targetLiked = desiredLiked;
        if (targetLiked) {
          const result = await App.api(`/api/posts/${post.id}/likes`, { method: "POST" });
          post.like_count = Number(result.like_count || 0);
          confirmedLiked = !!result.liked_by_me;
        } else {
          const result = await App.api(`/api/posts/${post.id}/likes`, { method: "DELETE" });
          post.like_count = Number(result.like_count || 0);
          confirmedLiked = !!result.liked_by_me;
        }
        paintLike(confirmedLiked);
        if (onUpdated) {
          onUpdated({
            type: "like",
            postId: Number(post.id || 0),
            likedByMe: !!confirmedLiked,
            likeCount: Number(post.like_count || 0),
          });
        }
      }
    } catch (error) {
      desiredLiked = confirmedLiked;
      paintLike(confirmedLiked);
      alert(error.message);
    } finally {
      likeSyncInFlight = false;
    }
  };

  likeBtn.addEventListener("click", () => {
    const nextLiked = !desiredLiked;
    const wasDesiredLiked = desiredLiked;
    desiredLiked = nextLiked;
    post.like_count = Math.max(0, Number(post.like_count || 0) + (nextLiked ? 1 : -1));
    paintLike(nextLiked);
    if (!wasDesiredLiked && nextLiked) {
      animate(likeBtn, "👍");
    }
    void syncLikeState();
  });

  likeCount.addEventListener("click", async () => {
    await openPostLikers(post.id);
  });

  commentToggle.addEventListener("click", async () => {
    commentsBox.classList.toggle("hidden");
    commentToggle.classList.toggle("is-active", !commentsBox.classList.contains("hidden"));
    if (!commentsBox.classList.contains("hidden")) {
      await loadComments();
    }
  });

  shareToggle.addEventListener("click", async () => {
    await openPostShareModal(post);
  });

  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await App.api(`/api/posts/${post.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: commentInput.value.trim() }),
      });
      post.comment_count += 1;
      commentCount.textContent = `${post.comment_count} comments`;
      commentInput.value = "";
      await loadComments();
      if (onUpdated) await onUpdated();
    } catch (error) {
      alert(error.message);
    }
  });

  wrapper.openComments = async () => {
    if (commentsBox.classList.contains("hidden")) {
      commentsBox.classList.remove("hidden");
      commentToggle.classList.add("is-active");
    }
    await loadComments();
  };

  wrapper.focusComment = async (commentId) => {
    if (!commentId) return false;
    await wrapper.openComments();
    const target = commentList.querySelector(`.comment-item[data-comment-id='${String(commentId)}']`);
    if (!target) return false;
    target.classList.add("comment-focus");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => target.classList.remove("comment-focus"), 1700);
    return true;
  };

  return wrapper;
}

window.createPostCard = createPostCard;
