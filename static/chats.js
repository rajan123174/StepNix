const authGate = document.getElementById("chat-auth-gate");
const chatApp = document.getElementById("chat-app");
const sendOtpForm = document.getElementById("chat-send-otp-form");
const verifyOtpForm = document.getElementById("chat-verify-otp-form");
const emailInput = document.getElementById("chat-email-input");
const otpInput = document.getElementById("chat-otp-input");
const secretInput = document.getElementById("chat-secret-input");
const resendBtn = document.getElementById("chat-resend-btn");
const authStatus = document.getElementById("chat-auth-status");
const userSearch = document.getElementById("chat-user-search");
const userResults = document.getElementById("chat-user-results");
const activeUsersEl = document.getElementById("chat-active-users");
const conversationList = document.getElementById("chat-conversations");
const threadHead = document.getElementById("chat-thread-head");
const messagesEl = document.getElementById("chat-messages");
const sendForm = document.getElementById("chat-send-form");
const messageInput = document.getElementById("chat-message-input");
const deleteModal = document.getElementById("chat-delete-modal");
const deleteTrigger = document.getElementById("chat-delete-trigger");
const deleteOptions = document.getElementById("chat-delete-options");
const deleteForMeBtn = document.getElementById("chat-delete-me-btn");
const deleteForEveryoneBtn = document.getElementById("chat-delete-everyone-btn");
const deleteCancelBtn = document.getElementById("chat-delete-cancel");

if (!App.requireAuth()) {
  // redirected
}

const me = App.getAuthUser();
const chatPageParams = new URLSearchParams(window.location.search);
const parsedOpenUserId = Number(chatPageParams.get("open_user_id") || 0);
let pendingOpenUserId = Number.isFinite(parsedOpenUserId) && parsedOpenUserId > 0 && parsedOpenUserId !== me?.id
  ? parsedOpenUserId
  : 0;
let chatToken = localStorage.getItem("chatToken") || "";
let selectedUser = null;
let pollTimer = null;
let resendTimer = null;
let resendSeconds = 30;
let otpEmail = "";
let latestSeenMineMessageId = null;
let typingStopTimer = null;
let typingActive = false;
let typingPartnerId = null;
let selectedDeleteMessageId = null;
let selectedDeleteCanEveryone = false;
const sharedPostPattern = /^\[\[STEPNIX_SHARE_POST:(\d+)\]\]$/;
const sharedStoryPattern = /^\[\[STEPNIX_SHARE_STORY:(\d+)\]\](?:\n([\s\S]*))?$/;
const sharedPostPreviewCache = new Map();
const sharedStoryPreviewCache = new Map();
const mobileChatMedia = window.matchMedia("(max-width: 768px)");

function isMobileChatLayout() {
  return !!mobileChatMedia.matches;
}

function syncMobileChatState() {
  chatApp.classList.toggle("mobile-thread-open", !!(isMobileChatLayout() && selectedUser));
}

function syncMobileChatHeight() {
  if (!chatApp) return;
  if (!isMobileChatLayout() || chatApp.classList.contains("hidden")) {
    chatApp.style.removeProperty("--mobile-chat-height");
    return;
  }
  const navHeight = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--mobile-nav-height")
  ) || 70;
  const rect = chatApp.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
  const available = Math.max(320, Math.floor(viewportHeight - rect.top - navHeight - 8));
  chatApp.style.setProperty("--mobile-chat-height", `${available}px`);
}

function deviceId() {
  let id = localStorage.getItem("chatDeviceId");
  if (!id) {
    id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem("chatDeviceId", id);
  }
  return id;
}

function setAuthStatus(text) {
  authStatus.textContent = text;
}

function autoResizeMessageInput() {
  if (!messageInput) return;
  messageInput.style.height = "auto";
  const next = Math.min(Math.max(messageInput.scrollHeight, 44), 180);
  messageInput.style.height = `${next}px`;
}

function parseSharedPostId(content) {
  const match = sharedPostPattern.exec(String(content || "").trim());
  if (!match) return 0;
  const postId = Number(match[1]);
  return Number.isFinite(postId) && postId > 0 ? postId : 0;
}

function parseSharedStoryPayload(content) {
  const match = sharedStoryPattern.exec(String(content || "").trim());
  if (!match) return null;
  const storyId = Number(match[1]);
  if (!Number.isFinite(storyId) || storyId <= 0) return null;
  return {
    storyId,
    replyText: String(match[2] || "").trim(),
  };
}

function sharedPostFallback(postId) {
  return {
    id: postId,
    goal_title: "Shared Post",
    author_username: "user",
    media_url: "",
    media_type: "none",
    post_url: `/post/${postId}`,
  };
}

async function loadSharedPostPreview(postId) {
  if (!postId) return sharedPostFallback(postId);
  if (sharedPostPreviewCache.has(postId)) return sharedPostPreviewCache.get(postId);
  const promise = App.api(`/api/posts/${postId}/preview`)
    .catch(() => sharedPostFallback(postId));
  sharedPostPreviewCache.set(postId, promise);
  return promise;
}

function sharedStoryFallback(storyId) {
  return {
    id: storyId,
    caption: "Shared Story",
    author_username: "user",
    media_url: "",
    media_type: "none",
    story_url: "/community-feed",
  };
}

async function loadSharedStoryPreview(storyId) {
  if (!storyId) return sharedStoryFallback(storyId);
  if (sharedStoryPreviewCache.has(storyId)) return sharedStoryPreviewCache.get(storyId);
  const promise = App.api(`/api/stories/${storyId}/preview`)
    .catch(() => sharedStoryFallback(storyId));
  sharedStoryPreviewCache.set(storyId, promise);
  return promise;
}

function renderSharedPostCardMarkup(postId) {
  return `
    <a class="chat-shared-post-card" data-shared-post-id="${postId}" href="/post/${postId}">
      <div class="chat-shared-post-thumb loading"></div>
      <div class="chat-shared-post-meta">
        <strong>Shared Post</strong>
        <small>Loading preview...</small>
      </div>
    </a>
  `;
}

function renderSharedStoryCardMarkup(storyId, replyText = "") {
  return `
    <div class="chat-shared-story-wrap">
      <a class="chat-shared-post-card chat-shared-story-card" data-shared-story-id="${storyId}" href="/community-feed">
        <div class="chat-shared-post-thumb loading"></div>
        <div class="chat-shared-post-meta">
          <strong>Shared Story</strong>
          <small>Loading preview...</small>
        </div>
      </a>
      ${replyText ? `<p class="chat-shared-story-note">${escapeText(replyText)}</p>` : ""}
    </div>
  `;
}

function escapeText(text) {
  return (window.App && typeof window.App.escapeHtml === "function")
    ? window.App.escapeHtml(text)
    : String(text || "");
}

function renderMessageBodyMarkup(msg) {
  const sharedStory = parseSharedStoryPayload(msg.content);
  if (sharedStory && !msg.deleted_for_everyone) {
    return renderSharedStoryCardMarkup(sharedStory.storyId, sharedStory.replyText);
  }
  const sharedPostId = parseSharedPostId(msg.content);
  if (sharedPostId && !msg.deleted_for_everyone) {
    return renderSharedPostCardMarkup(sharedPostId);
  }
  return `<p>${escapeText(msg.content)}</p>`;
}

async function hydrateSharedCards() {
  const cards = Array.from(messagesEl.querySelectorAll(".chat-shared-post-card[data-shared-post-id]"));
  const storyCards = Array.from(messagesEl.querySelectorAll(".chat-shared-story-card[data-shared-story-id]"));
  await Promise.all(
    cards.map(async (card) => {
      const postId = Number(card.getAttribute("data-shared-post-id") || 0);
      if (!postId) return;
      const preview = await loadSharedPostPreview(postId);
      const thumbEl = card.querySelector(".chat-shared-post-thumb");
      const metaTitle = card.querySelector(".chat-shared-post-meta strong");
      const metaSub = card.querySelector(".chat-shared-post-meta small");
      card.setAttribute("href", preview.post_url || `/post/${postId}`);
      if (thumbEl) {
        if (preview.media_url) {
          if (preview.media_type === "video") {
            thumbEl.innerHTML = `<video src="${preview.media_url}" muted playsinline preload="metadata"></video>`;
          } else {
            thumbEl.innerHTML = `<img src="${preview.media_url}" alt="${escapeText(preview.goal_title || "Shared post")}" />`;
          }
        } else {
          thumbEl.innerHTML = `<span class="chat-shared-post-empty">No media</span>`;
        }
        thumbEl.classList.remove("loading");
      }
      if (metaTitle) metaTitle.textContent = preview.goal_title || "Shared Post";
      if (metaSub) metaSub.textContent = `@${preview.author_username || "user"}`;
    })
  );
  await Promise.all(
    storyCards.map(async (card) => {
      const storyId = Number(card.getAttribute("data-shared-story-id") || 0);
      if (!storyId) return;
      const preview = await loadSharedStoryPreview(storyId);
      const thumbEl = card.querySelector(".chat-shared-post-thumb");
      const metaTitle = card.querySelector(".chat-shared-post-meta strong");
      const metaSub = card.querySelector(".chat-shared-post-meta small");
      card.setAttribute("href", preview.story_url || "/community-feed");
      if (thumbEl) {
        if (preview.media_url) {
          if (preview.media_type === "video") {
            thumbEl.innerHTML = `<video src="${preview.media_url}" muted playsinline preload="metadata"></video>`;
          } else {
            thumbEl.innerHTML = `<img src="${preview.media_url}" alt="${escapeText(preview.caption || "Shared story")}" />`;
          }
        } else {
          thumbEl.innerHTML = `<span class="chat-shared-post-empty">No media</span>`;
        }
        thumbEl.classList.remove("loading");
      }
      if (metaTitle) metaTitle.textContent = preview.caption || "Shared Story";
      if (metaSub) metaSub.textContent = `@${preview.author_username || "user"}`;
    })
  );
}

function summarizeMessagePreview(content) {
  const sharedStory = parseSharedStoryPayload(content);
  if (sharedStory) {
    return sharedStory.replyText
      ? `Shared a story: ${sharedStory.replyText}`
      : "Shared a story";
  }
  if (parseSharedPostId(content)) return "Shared a post";
  return String(content || "");
}

function closeDeleteModal() {
  if (!deleteModal) return;
  deleteModal.classList.add("hidden");
  selectedDeleteMessageId = null;
  selectedDeleteCanEveryone = false;
  deleteOptions?.classList.add("hidden");
}

function openDeleteModal(messageId, canDeleteForEveryone) {
  if (!deleteModal) return;
  selectedDeleteMessageId = messageId;
  selectedDeleteCanEveryone = !!canDeleteForEveryone;
  deleteForEveryoneBtn?.classList.toggle("hidden", !selectedDeleteCanEveryone);
  deleteOptions?.classList.add("hidden");
  deleteModal.classList.remove("hidden");
}

function handleChatError(error) {
  const msg = String(error?.message || "");
  if (msg.includes("Chat session") || msg.includes("Chat login required") || msg.includes("another device")) {
    localStorage.removeItem("chatToken");
    chatToken = "";
    stopPolling();
    showAuthGate();
    setAuthStatus(msg || "Chat session expired. Verify email again.");
    return true;
  }
  return false;
}

function renderThreadHead(user, isTyping = false) {
  threadHead.innerHTML = `
    <button type="button" class="chat-mobile-back" aria-label="Back to conversations">←</button>
    <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
    <div class="chat-thread-head-meta">
      <strong>${user.full_name}</strong>
      <small class="chat-thread-subline">
        ${
          isTyping
            ? `<span class="chat-typing-live">typing<span class="chat-typing-dots"><i></i><i></i><i></i></span></span>`
            : `@${user.username}`
        }
      </small>
    </div>
  `;
}

function chatHeaders() {
  const headers = new Headers();
  if (chatToken) headers.set("X-Chat-Token", chatToken);
  headers.set("X-Device-Id", deviceId());
  return headers;
}

async function chatApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  chatHeaders().forEach((value, key) => headers.set(key, value));
  const token = App.getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(async () => ({ detail: (await response.text().catch(() => "")).trim() || `Request failed (${response.status})` }));
    throw new Error(error.detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showAuthGate() {
  authGate.classList.remove("hidden");
  chatApp.classList.add("hidden");
}

function showChatApp() {
  authGate.classList.add("hidden");
  chatApp.classList.remove("hidden");
  syncMobileChatState();
  syncMobileChatHeight();
}

function clearOpenUserParam() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("open_user_id")) return;
  params.delete("open_user_id");
  const next = params.toString();
  const nextUrl = `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash || ""}`;
  window.history.replaceState({}, "", nextUrl);
}

async function tryOpenRequestedThread() {
  if (!pendingOpenUserId) return;
  const targetId = pendingOpenUserId;
  try {
    const profile = await App.api(`/api/users/${targetId}/profile`);
    const targetUser = profile?.user;
    if (!targetUser || Number(targetUser.id) !== targetId || targetId === me?.id) {
      pendingOpenUserId = 0;
      clearOpenUserParam();
      return;
    }
    await openThread(targetUser);
  } catch {
    // Keep chat usable even if direct target loading fails.
  } finally {
    pendingOpenUserId = 0;
    clearOpenUserParam();
  }
}

function startResendCountdown() {
  resendSeconds = 30;
  resendBtn.disabled = true;
  resendBtn.textContent = `Resend OTP in ${resendSeconds}s`;
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    resendSeconds -= 1;
    if (resendSeconds <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
      resendBtn.disabled = false;
      resendBtn.textContent = "Resend OTP";
      return;
    }
    resendBtn.textContent = `Resend OTP in ${resendSeconds}s`;
  }, 1000);
}

async function bootstrapChat() {
  try {
    const status = await App.api("/api/chat/auth/status");
    if (status.registered_email) {
      emailInput.value = status.registered_email;
    }

    if (!chatToken) {
      showAuthGate();
      return;
    }
    await chatApi("/api/chat/conversations");
    showChatApp();
    await Promise.all([loadConversations(), loadUsers(), loadActiveUsers()]);
    await tryOpenRequestedThread();
    startPolling();
  } catch {
    localStorage.removeItem("chatToken");
    chatToken = "";
    showAuthGate();
  }
}

function renderUsers(users) {
  userResults.innerHTML = "";
  if (!userSearch.value.trim()) {
    userResults.classList.add("hidden");
    return;
  }
  userResults.classList.remove("hidden");
  if (!users.length) {
    userResults.innerHTML = "<p class='notice'>No users found.</p>";
    return;
  }
  users.forEach((user) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-user-row";
    row.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <div>
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
      </div>
    `;
    row.addEventListener("click", () => {
      openThread(user);
      userSearch.value = "";
      userResults.classList.add("hidden");
      userResults.innerHTML = "";
    });
    userResults.appendChild(row);
  });
}

function renderActiveUsers(users) {
  if (!activeUsersEl) return;
  activeUsersEl.innerHTML = "";
  if (!users.length) {
    activeUsersEl.innerHTML = "<p class='notice'>No active users right now.</p>";
    return;
  }
  users.forEach((user) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-active-user ${user.is_active ? "is-online" : "is-offline"}`;
    button.innerHTML = `
      <span class="chat-active-avatar-wrap">
        <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
        <span class="chat-active-dot"></span>
      </span>
      <small>@${user.username}</small>
    `;
    button.addEventListener("click", () => openThread(user));
    activeUsersEl.appendChild(button);
  });
}

async function loadUsers(query = "") {
  if (!query.trim()) {
    userResults.classList.add("hidden");
    userResults.innerHTML = "";
    return;
  }
  const data = await chatApi(`/api/chat/users?query=${encodeURIComponent(query)}`);
  renderUsers(data || []);
}

async function loadActiveUsers() {
  const data = await chatApi("/api/chat/active-users");
  renderActiveUsers(data || []);
}

function renderConversations(items) {
  conversationList.innerHTML = "";
  const sorted = [...items].sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  if (!sorted.length) {
    conversationList.innerHTML = "<p class='notice'>No chats yet.</p>";
    return;
  }
  sorted.forEach((item) => {
    const active = selectedUser && selectedUser.id === item.user.id;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `chat-convo-row ${active ? "is-active" : ""}`;
    row.innerHTML = `
      <img src="${item.user.profile_photo_url || "/static/default-avatar.svg"}" alt="${item.user.username}" />
      <div>
        <div class="chat-convo-row-meta">
          <strong>${item.user.full_name}</strong>
          <span class="chat-convo-row-time">${formatTime(item.last_message_at)}</span>
        </div>
        <small>@${item.user.username}</small>
        <p>${escapeText(summarizeMessagePreview(item.last_message))}</p>
      </div>
    `;
    row.addEventListener("click", () => openThread(item.user));
    conversationList.appendChild(row);
  });
}

async function loadConversations() {
  const data = await chatApi("/api/chat/conversations");
  const list = data || [];
  renderConversations(list);
  if (!selectedUser && list.length && !isMobileChatLayout()) {
    await openThread(list[0].user);
  }
}

function parseServerDate(value) {
  if (value instanceof Date) return value;
  const raw = String(value || "").trim();
  if (!raw) return new Date(NaN);
  // Backend sends UTC timestamps without timezone suffix.
  // Add "Z" when no explicit offset exists so browser converts UTC -> local correctly.
  const hasTz = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw);
  return new Date(hasTz ? raw : `${raw}Z`);
}

function formatTime(value) {
  try {
    return parseServerDate(value)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
      .toLowerCase();
  } catch {
    return "";
  }
}

function formatSeenAgo(value) {
  const dt = parseServerDate(value);
  const now = new Date();
  const diffMs = now.getTime() - dt.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "seen just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes <= 0) return "seen just now";
  if (minutes === 1) return "seen 1 min ago";
  if (minutes < 60) return `seen ${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "seen 1 hour ago";
  if (hours < 24) return `seen ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "seen 1 day ago";
  return `seen ${days} days ago`;
}

function deleteIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5.6 9.2h12.8l-1.2 10a2 2 0 0 1-2 1.8H8.8a2 2 0 0 1-2-1.8z" />
      <path d="M13.6 3.1l5.2 7.6a1.4 1.4 0 0 1-2.3 1.6l-5.2-7.6a1.4 1.4 0 0 1 2.3-1.6z" />
      <path d="M14.8 8.7l2.2-1.5 1.4 2-2.2 1.5z" />
      <path d="M9.4 12.3h1.8v6.3H9.4zm3.4 0h1.8v6.3h-1.8z" />
      <path d="M7.4 6.8h8.2v1.5H7.4z" />
      <path d="M9.3 5.1h4.4v1.2H9.3z" />
      <path d="M7.6 7.1l3.2-2.1 1 1.4-3.2 2.1z" />
      <circle cx="6.2" cy="5.4" r="0.7" />
      <circle cx="4.9" cy="6.6" r="0.6" />
      <circle cx="7.3" cy="4.4" r="0.55" />
    </svg>
  `;
}

function renderMessages(list, options = {}) {
  const preserveScrollOnUpdate = !!options.preserveScrollOnUpdate;
  const forceScrollBottom = !!options.forceScrollBottom;
  const prevClientHeight = messagesEl.clientHeight;
  const prevScrollHeight = messagesEl.scrollHeight;
  const prevScrollTop = messagesEl.scrollTop;
  const prevDistanceFromBottom = Math.max(0, prevScrollHeight - (prevScrollTop + prevClientHeight));
  const wasNearBottom = prevDistanceFromBottom <= 80;

  messagesEl.innerHTML = "";
  if (!list.length) {
    messagesEl.innerHTML = "<p class='notice'>No messages yet. Say hi 👋</p>";
    return;
  }
  const seenMine = list.filter((msg) => msg.sender.id === me.id && !!msg.seen_at);
  const latestSeenMine = seenMine.length ? seenMine[seenMine.length - 1] : null;
  const shouldJumpSeen = !!(
    latestSeenMine &&
    latestSeenMineMessageId &&
    latestSeenMine.id !== latestSeenMineMessageId
  );
  latestSeenMineMessageId = latestSeenMine ? latestSeenMine.id : null;

  list.forEach((msg) => {
    const mine = msg.sender.id === me.id;
    const avatarUser = msg.sender;
    const isSharedPost = !!(parseSharedPostId(msg.content) && !msg.deleted_for_everyone);
    const row = document.createElement("div");
    row.className = `chat-msg-row ${mine ? "mine" : "their"}`;
    row.innerHTML = `
      ${
        mine
          ? ""
          : `<img class="chat-msg-avatar" src="${avatarUser.profile_photo_url || "/static/default-avatar.svg"}" alt="${avatarUser.username}" />`
      }
      <div class="chat-msg-stack ${mine ? "mine" : "their"}">
        <div class="chat-msg-main ${mine ? "mine" : "their"}">
          ${
            msg.deleted_for_everyone
              ? ""
              : `
            <button
              type="button"
              class="chat-msg-delete-btn"
              data-delete-message-id="${msg.id}"
              data-can-delete-everyone="${msg.can_delete_for_everyone ? "1" : "0"}"
              aria-label="Delete message"
              title="Delete message"
            >
              ${deleteIconSvg()}
            </button>
          `
          }
          <article class="chat-msg ${mine ? "mine" : "their"} ${msg.deleted_for_everyone ? "is-deleted" : ""} ${isSharedPost ? "is-shared-post" : ""}">
            ${renderMessageBodyMarkup(msg)}
          </article>
        </div>
        <small class="chat-msg-time">${formatTime(msg.created_at)}</small>
        ${
          mine && latestSeenMine && latestSeenMine.id === msg.id
            ? `
          <div class="chat-seen-receipt ${shouldJumpSeen ? "is-jump" : ""}">
            <img src="${selectedUser?.profile_photo_url || "/static/default-avatar.svg"}" alt="${selectedUser?.username || "user"}" />
            <span>${formatSeenAgo(msg.seen_at)}</span>
          </div>
        `
            : ""
        }
      </div>
    `;
    messagesEl.appendChild(row);
  });
  requestAnimationFrame(() => {
    if (forceScrollBottom || (!preserveScrollOnUpdate && wasNearBottom)) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
    if (preserveScrollOnUpdate) {
      const nextTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight - prevDistanceFromBottom);
      messagesEl.scrollTop = nextTop;
    }
  });
  hydrateSharedCards().catch(() => {});
}

async function openThread(user) {
  if (typingActive && typingPartnerId && typingPartnerId !== user.id) {
    setTypingState(false, typingPartnerId).catch(() => {});
    typingActive = false;
    typingPartnerId = null;
  }
  selectedUser = user;
  syncMobileChatState();
  syncMobileChatHeight();
  const data = await chatApi(`/api/chat/messages/${user.id}`);
  renderThreadHead(user, !!data.partner_is_typing);
  renderMessages(data.messages || [], { forceScrollBottom: true });
  await loadConversations();
}

function closeMobileThread() {
  if (!isMobileChatLayout()) return;
  selectedUser = null;
  latestSeenMineMessageId = null;
  threadHead.textContent = "Select a user to start chatting";
  messagesEl.innerHTML = "";
  syncMobileChatState();
  syncMobileChatHeight();
  loadConversations().catch(() => {});
}

async function setTypingState(isTyping, partnerId = null) {
  const targetId = partnerId || selectedUser?.id;
  if (!targetId) return;
  const body = new URLSearchParams({ is_typing: isTyping ? "1" : "0" });
  await chatApi(`/api/chat/typing/${targetId}`, { method: "POST", body });
}

function scheduleTypingStop() {
  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (!typingActive || !typingPartnerId) return;
    setTypingState(false, typingPartnerId).catch(() => {});
    typingActive = false;
    typingPartnerId = null;
  }, 1200);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      await Promise.all([loadConversations(), loadActiveUsers()]);
      if (selectedUser) {
        const data = await chatApi(`/api/chat/messages/${selectedUser.id}`);
        renderThreadHead(selectedUser, !!data.partner_is_typing);
        renderMessages(data.messages || [], { preserveScrollOnUpdate: true });
      }
    } catch (error) {
      if (!handleChatError(error)) {
        // keep silent
      }
    }
  }, 3000);
}

sendOtpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim().toLowerCase();
  const registeredEmail = String(me?.email || "").trim().toLowerCase();
  if (!email) {
    setAuthStatus("Enter your registered email.");
    return;
  }
  if (!registeredEmail || email !== registeredEmail) {
    setAuthStatus("Use the same email registered on your account.");
    return;
  }
  try {
    const body = new URLSearchParams({ email });
    const res = await App.api("/api/chat/auth/send-otp", { method: "POST", body });
    otpEmail = email;
    verifyOtpForm.classList.remove("hidden");
    otpInput.value = "";
    secretInput.value = "";
    setAuthStatus(res.detail);
    startResendCountdown();
  } catch (error) {
    if (!handleChatError(error)) setAuthStatus(error.message);
  }
});

resendBtn.addEventListener("click", async () => {
  try {
    const body = new URLSearchParams({ email: otpEmail || emailInput.value.trim().toLowerCase() });
    const res = await App.api("/api/chat/auth/send-otp", { method: "POST", body });
    setAuthStatus(res.detail);
    startResendCountdown();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

verifyOtpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const otp = otpInput.value.trim();
  const secretCode = secretInput.value.trim();
  try {
    const body = new URLSearchParams({
      email: otpEmail || emailInput.value.trim().toLowerCase(),
      otp,
      secret_code: secretCode,
      device_id: deviceId(),
    });
    const result = await App.api("/api/chat/auth/verify-otp", { method: "POST", body });
    chatToken = result.session_token;
    localStorage.setItem("chatToken", chatToken);
    setAuthStatus("Chat enabled on this device.");
    showChatApp();
    await Promise.all([loadConversations(), loadUsers(), loadActiveUsers()]);
    await tryOpenRequestedThread();
    startPolling();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

let searchTimer = null;
userSearch.addEventListener("input", () => {
  const q = userSearch.value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadUsers(q).catch(() => {});
  }, 180);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".chat-search-wrap") || target.closest("#chat-user-results")) return;
  userResults.classList.add("hidden");

  if (!target.closest(".chat-delete-card") && !deleteModal?.classList.contains("hidden")) {
    closeDeleteModal();
  }

  if (target.closest(".chat-mobile-back")) {
    closeMobileThread();
  }
});

messagesEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const deleteBtn = target.closest("button[data-delete-message-id]");
  if (!deleteBtn) return;
  event.stopPropagation();
  const messageId = Number(deleteBtn.getAttribute("data-delete-message-id"));
  const canDeleteForEveryone = deleteBtn.getAttribute("data-can-delete-everyone") === "1";
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  openDeleteModal(messageId, canDeleteForEveryone);
});

deleteTrigger?.addEventListener("click", () => {
  deleteOptions?.classList.remove("hidden");
});

deleteForMeBtn?.addEventListener("click", async () => {
  if (!selectedDeleteMessageId) return;
  try {
    const body = new URLSearchParams({ scope: "me" });
    await chatApi(`/api/chat/messages/${selectedDeleteMessageId}/delete`, { method: "POST", body });
    closeDeleteModal();
    if (selectedUser) await openThread(selectedUser);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

deleteForEveryoneBtn?.addEventListener("click", async () => {
  if (!selectedDeleteMessageId || !selectedDeleteCanEveryone) return;
  try {
    const body = new URLSearchParams({ scope: "everyone" });
    await chatApi(`/api/chat/messages/${selectedDeleteMessageId}/delete`, { method: "POST", body });
    closeDeleteModal();
    if (selectedUser) await openThread(selectedUser);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

deleteCancelBtn?.addEventListener("click", () => {
  closeDeleteModal();
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedUser) return;
  const content = messageInput.value.trim();
  if (!content) return;
  const body = new URLSearchParams({ content });
  try {
    await chatApi(`/api/chat/messages/${selectedUser.id}`, { method: "POST", body });
    if (typingActive && typingPartnerId) {
      setTypingState(false, typingPartnerId).catch(() => {});
      typingActive = false;
      typingPartnerId = null;
    }
    if (typingStopTimer) {
      clearTimeout(typingStopTimer);
      typingStopTimer = null;
    }
    messageInput.value = "";
    autoResizeMessageInput();
    await openThread(selectedUser);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

messageInput.addEventListener("input", () => {
  autoResizeMessageInput();
  if (!selectedUser) return;
  const content = messageInput.value.trim();
  if (!content) {
    if (typingActive && typingPartnerId) {
      setTypingState(false, typingPartnerId).catch(() => {});
      typingActive = false;
      typingPartnerId = null;
    }
    if (typingStopTimer) {
      clearTimeout(typingStopTimer);
      typingStopTimer = null;
    }
    return;
  }
  if (!typingActive || typingPartnerId !== selectedUser.id) {
    typingActive = true;
    typingPartnerId = selectedUser.id;
    setTypingState(true, typingPartnerId).catch(() => {});
  }
  scheduleTypingStop();
});

messageInput.addEventListener("blur", () => {
  if (typingActive && typingPartnerId) {
    setTypingState(false, typingPartnerId).catch(() => {});
    typingActive = false;
    typingPartnerId = null;
  }
  if (typingStopTimer) {
    clearTimeout(typingStopTimer);
    typingStopTimer = null;
  }
});

window.addEventListener("auth:changed", () => {
  stopPolling();
  chatToken = "";
  localStorage.removeItem("chatToken");
});

if (typeof mobileChatMedia.addEventListener === "function") {
  mobileChatMedia.addEventListener("change", () => {
    syncMobileChatState();
    syncMobileChatHeight();
    if (!isMobileChatLayout() && !selectedUser) {
      loadConversations().catch(() => {});
    }
  });
} else if (typeof mobileChatMedia.addListener === "function") {
  mobileChatMedia.addListener(() => {
    syncMobileChatState();
    syncMobileChatHeight();
    if (!isMobileChatLayout() && !selectedUser) {
      loadConversations().catch(() => {});
    }
  });
}

window.addEventListener("resize", () => {
  syncMobileChatHeight();
});

if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
  window.visualViewport.addEventListener("resize", () => {
    syncMobileChatHeight();
  });
}

bootstrapChat().catch(() => {
  showAuthGate();
});

autoResizeMessageInput();
