function getToken() {
  return localStorage.getItem("authToken") || "";
}

function getAppConfig() {
  return window.APP_CONFIG || {};
}

function getApiBaseUrl() {
  const configured = String(getAppConfig().API_BASE_URL || "").trim();
  if (!configured) return "";
  return configured.replace(/\/+$/, "");
}

function resolveApiUrl(path) {
  const target = String(path || "");
  if (/^https?:\/\//i.test(target)) return target;
  const base = getApiBaseUrl();
  if (!base) return target;
  return `${base}${target.startsWith("/") ? "" : "/"}${target}`;
}

function resolveWsUrl(path) {
  const target = String(path || "");
  if (/^wss?:\/\//i.test(target)) return target;
  const configured = String(getAppConfig().WS_BASE_URL || "").trim();
  if (configured) {
    const base = configured.replace(/\/+$/, "");
    return `${base}${target.startsWith("/") ? "" : "/"}${target}`;
  }
  const origin = getApiBaseUrl() || window.location.origin;
  const url = new URL(target || "/", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function setAuth(token, user) {
  localStorage.setItem("authToken", token);
  localStorage.setItem("authUser", JSON.stringify(user));
  window.dispatchEvent(new CustomEvent("auth:changed", { detail: { user } }));
}

function clearAuth() {
  const previousUser = getAuthUser();
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  localStorage.removeItem("chatToken");
  window.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: null, previousUser } }));
}

function getAuthUser() {
  const raw = localStorage.getItem("authUser");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const THEME_STORAGE_KEY = "siteTheme";

function getTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (!stored) return "dark";
  const value = stored.trim().toLowerCase();
  return value === "light" ? "light" : "dark";
}

function setTheme(theme) {
  const resolved = String(theme || "").trim().toLowerCase() === "dark" ? "dark" : "light";
  localStorage.setItem(THEME_STORAGE_KEY, resolved);
  document.body.classList.toggle("theme-dark", resolved === "dark");
  document.body.classList.toggle("theme-light", resolved !== "dark");
  window.dispatchEvent(new CustomEvent("theme:changed", { detail: { theme: resolved } }));
  return resolved;
}

function initTheme() {
  setTheme(getTheme());
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(resolveApiUrl(path), { ...options, headers });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(async () => ({ detail: (await response.text().catch(() => "")).trim() || `Request failed (${response.status})` }));
    const err = new Error(error.detail || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  if (response.status === 204) return null;
  return response.json();
}

function mentionMarkup(text) {
  return text.replace(/@([a-zA-Z0-9_]{3,40})/g, '<strong>@$1</strong>');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkifyPlainText(text) {
  const source = escapeHtml(text);
  const urlPattern = /((https?:\/\/|www\.)[^\s<]+)/gi;
  return source.replace(urlPattern, (match) => {
    const href = match.toLowerCase().startsWith("www.") ? `https://${match}` : match;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });
}

function renderRichBio(el, text, fallback = "No bio yet.") {
  if (!el) return;
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) {
    el.textContent = fallback;
    return;
  }
  el.innerHTML = linkifyPlainText(raw);
}

function requireAuth(redirectPath = "/create-profile") {
  if (!getToken()) {
    window.location.href = redirectPath;
    return false;
  }
  return true;
}

function playActionBurst(targetEl, icon = "👍") {
  if (!targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  const burst = document.createElement("div");
  burst.className = "action-burst";
  burst.style.left = `${rect.left + rect.width / 2}px`;
  burst.style.top = `${rect.top + rect.height / 2}px`;
  const colors = ["#ff2a6d", "#ff5a3d", "#ffcd3c", "#fc4fff", "#00c7ff", "#8cff66"];
  let html = `<span class="action-burst-icon">${icon}</span>`;

  for (let i = 0; i < 14; i += 1) {
    const angle = Math.round((360 / 14) * i);
    const rad = (angle * Math.PI) / 180;
    const hue = colors[i % colors.length];
    const dx = (Math.cos(rad) * 56).toFixed(1);
    const dy = (Math.sin(rad) * 56).toFixed(1);
    html += `<span class="action-burst-ray" style="--rot:${angle}deg;--dx:${dx}px;--dy:${dy}px;--c:${hue};"></span>`;
  }

  for (let i = 0; i < 18; i += 1) {
    const angle = Math.round((360 / 18) * i + (i % 2 ? 8 : -8));
    const rad = (angle * Math.PI) / 180;
    const hue = colors[(i + 2) % colors.length];
    const size = 4 + (i % 4);
    const dx = (Math.cos(rad) * 76).toFixed(1);
    const dy = (Math.sin(rad) * 76).toFixed(1);
    html += `<span class="action-burst-dot" style="--dx:${dx}px;--dy:${dy}px;--c:${hue};--s:${size}px;"></span>`;
  }

  burst.innerHTML = html;
  document.body.appendChild(burst);
  window.setTimeout(() => burst.remove(), 950);
}

function initGlassPageTransitions() {
  if (window.__glassTransitionBound) return;
  window.__glassTransitionBound = true;

  const overlay = document.createElement("div");
  overlay.id = "glass-transition";
  overlay.className = "glass-transition";
  document.body.appendChild(overlay);

  const navLinks = Array.from(document.querySelectorAll(".site-nav a[href]"));
  navLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http")) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const current = window.location.pathname;
      const target = new URL(href, window.location.origin).pathname;
      if (current === target) return;

      event.preventDefault();
      overlay.classList.add("is-active");
      window.setTimeout(() => {
        window.location.href = href;
      }, 280);
    });
  });

  window.requestAnimationFrame(() => {
    overlay.classList.add("ready");
  });
}

function shortNavLabel(label) {
  const cleaned = label.replace(/\s+/g, " ").trim();
  if (!cleaned) return "•";
  if (/logout/i.test(cleaned)) return "L";
  const words = cleaned.split(" ");
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
}

function accountNavIconSvg() {
  return `
    <svg class="nav-account-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="7.5" r="4.2"></circle>
      <path d="M4.2 19.2c0-3.3 3.4-5.9 7.8-5.9s7.8 2.6 7.8 5.9"></path>
    </svg>
  `;
}

function progressNavIconSvg() {
  return `
    <svg class="nav-progress-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h12"></path>
      <path d="M6 21h12"></path>
      <path d="M7 4c0 4 3 5 5 7-2 2-5 3-5 7"></path>
      <path d="M17 4c0 4-3 5-5 7 2 2 5 3 5 7"></path>
      <path d="M10 13h4"></path>
    </svg>
  `;
}

function storyNavIconSvg() {
  return `
    <svg class="nav-story-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.8" y="5.2" width="14.4" height="13.6" rx="4"></rect>
      <path d="M12 8.8v6.4"></path>
      <path d="M8.8 12h6.4"></path>
      <circle cx="17.2" cy="7.6" r="1.2"></circle>
    </svg>
  `;
}

function communityNavIconSvg() {
  return `
    <svg class="nav-community-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.2" r="3.2"></circle>
      <circle cx="6.4" cy="9.6" r="2.3"></circle>
      <circle cx="17.6" cy="9.6" r="2.3"></circle>
      <path d="M7.3 18.8c0-2.9 2.1-4.9 4.7-4.9s4.7 2 4.7 4.9Z"></path>
      <path d="M2.8 18.8c0-2 1.4-3.4 3.2-3.4.8 0 1.5.2 2 .7"></path>
      <path d="M21.2 18.8c0-2-1.4-3.4-3.2-3.4-.8 0-1.5.2-2 .7"></path>
    </svg>
  `;
}

function chatNavIconSvg() {
  return `
    <svg class="nav-chat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.8A2.8 2.8 0 0 1 6.8 4h10.4A2.8 2.8 0 0 1 20 6.8v6.4a2.8 2.8 0 0 1-2.8 2.8H10l-4.1 3V16A2.8 2.8 0 0 1 4 13.2Z"></path>
      <circle cx="9" cy="10" r="1"></circle>
      <circle cx="12" cy="10" r="1"></circle>
      <circle cx="15" cy="10" r="1"></circle>
    </svg>
  `;
}

function settingsNavIconSvg() {
  return `
    <svg class="nav-settings-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="2.8"></circle>
      <path d="M19.2 13.1a7.7 7.7 0 0 0 .1-1.1 7.7 7.7 0 0 0-.1-1.1l2-1.5-1.9-3.2-2.4 1a7.8 7.8 0 0 0-1.9-1.1l-.3-2.6h-3.8l-.3 2.6c-.7.2-1.3.5-1.9 1.1l-2.4-1-1.9 3.2 2 1.5a7.7 7.7 0 0 0-.1 1.1 7.7 7.7 0 0 0 .1 1.1l-2 1.5 1.9 3.2 2.4-1c.6.5 1.2.9 1.9 1.1l.3 2.6h3.8l.3-2.6c.7-.2 1.3-.6 1.9-1.1l2.4 1 1.9-3.2Z"></path>
    </svg>
  `;
}

function helpNavIconSvg() {
  return `
    <svg class="nav-help-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M9.5 9.3a2.5 2.5 0 1 1 4.1 2c-.8.6-1.6 1.1-1.6 2.2"></path>
      <circle cx="12" cy="16.8" r="0.9"></circle>
    </svg>
  `;
}

function logoutNavIconSvg() {
  return `
    <svg class="nav-logout-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 6V4.6A1.6 1.6 0 0 1 11.6 3h6.8A1.6 1.6 0 0 1 20 4.6v14.8a1.6 1.6 0 0 1-1.6 1.6h-6.8A1.6 1.6 0 0 1 10 19.4V18"></path>
      <path d="M4 12h10"></path>
      <path d="m7.2 8.8-3.2 3.2 3.2 3.2"></path>
    </svg>
  `;
}

function moreNavIconSvg() {
  return `
    <svg class="nav-more-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.9"></circle>
      <circle cx="12" cy="12" r="1.9"></circle>
      <circle cx="18" cy="12" r="1.9"></circle>
    </svg>
  `;
}

function initSidebarCollapse() {
  const nav = document.querySelector(".site-nav");
  if (!nav || nav.dataset.collapseReady === "1") return;
  nav.dataset.collapseReady = "1";

  if (!document.querySelector(".app-top-brand")) {
    const brand = document.createElement("a");
    brand.className = "app-top-brand";
    brand.href = "/community-feed";
    brand.setAttribute("aria-label", "StepNix home");
    brand.innerHTML = `
      <img src="/static/stepnix-logo.svg?v=3" alt="StepNix logo" />
      <span class="app-top-brand-user" hidden></span>
    `;
    document.body.appendChild(brand);
  }

  const links = Array.from(nav.querySelectorAll("a[href]"));
  const brandUserLabel = document.querySelector(".app-top-brand-user");
  let myProfileImg = null;
  const mobilePrimaryHrefs = new Set(["/community-feed", "/chats", "/stories", "/profile"]);
  const mobileSecondaryLinks = [];

  const refreshMyProfileIcon = () => {
    if (!(myProfileImg instanceof HTMLImageElement)) return;
    const user = getAuthUser();
    myProfileImg.src = (user && user.profile_photo_url) || "/static/default-avatar.svg";
  };

  const refreshBrandIdentity = () => {
    if (!(brandUserLabel instanceof HTMLElement)) return;
    const user = getAuthUser();
    const username = user && typeof user.username === "string" ? user.username.trim() : "";
    if (!username) {
      brandUserLabel.textContent = "";
      brandUserLabel.hidden = true;
      return;
    }
    brandUserLabel.textContent = `@${username}`;
    brandUserLabel.hidden = false;
  };

  links.forEach((link) => {
    if (link.querySelector(".nav-label")) return;
    const labelText = (link.textContent || "").trim();
    link.textContent = "";
    link.dataset.label = labelText;
    link.setAttribute("aria-label", labelText);

    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = labelText;

    const short = document.createElement("span");
    short.className = "nav-short";
    if (link.getAttribute("href") === "/create-profile") {
      short.classList.add("has-icon");
      short.innerHTML = accountNavIconSvg();
    } else if (link.getAttribute("href") === "/new-progress") {
      short.classList.add("has-icon");
      short.innerHTML = progressNavIconSvg();
    } else if (link.getAttribute("href") === "/stories") {
      short.classList.add("has-icon");
      short.innerHTML = storyNavIconSvg();
    } else if (link.getAttribute("href") === "/community-feed") {
      short.classList.add("has-icon");
      short.innerHTML = communityNavIconSvg();
    } else if (link.getAttribute("href") === "/chats") {
      short.classList.add("has-icon");
      short.innerHTML = chatNavIconSvg();
    } else if (link.getAttribute("href") === "/settings") {
      short.classList.add("has-icon");
      short.innerHTML = settingsNavIconSvg();
    } else if (link.getAttribute("href") === "/help-center") {
      short.classList.add("has-icon");
      short.innerHTML = helpNavIconSvg();
    } else if (link.id === "profile-logout-link") {
      short.classList.add("has-icon");
      short.innerHTML = logoutNavIconSvg();
    } else if (link.getAttribute("href") === "/profile") {
      short.classList.add("has-icon", "nav-short-profile");
      const img = document.createElement("img");
      img.className = "nav-profile-avatar";
      img.alt = "My Profile";
      img.src = "/static/default-avatar.svg";
      short.appendChild(img);
      myProfileImg = img;
    } else {
      short.textContent = shortNavLabel(labelText);
    }
    short.setAttribute("aria-hidden", "true");

    const tooltip = document.createElement("span");
    tooltip.className = "nav-tooltip";
    tooltip.textContent = labelText;
    tooltip.setAttribute("aria-hidden", "true");

    link.appendChild(label);
    link.appendChild(short);
    link.appendChild(tooltip);

    const href = link.getAttribute("href") || "";
    const isPrimary = mobilePrimaryHrefs.has(href);
    link.classList.add(isPrimary ? "mobile-primary" : "mobile-secondary");
    if (!isPrimary) {
      mobileSecondaryLinks.push(link);
    }
  });

  if (!nav.querySelector(".mobile-more-btn")) {
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "mobile-more-btn";
    moreBtn.setAttribute("aria-label", "More");
    moreBtn.innerHTML = `
      <span class="nav-short has-icon" aria-hidden="true">${moreNavIconSvg()}</span>
      <span class="nav-label">More</span>
    `;

    const currentPath = window.location.pathname;
    if (mobileSecondaryLinks.some((link) => (link.getAttribute("href") || "") === currentPath)) {
      moreBtn.classList.add("is-active");
    }

    const sheet = document.createElement("div");
    sheet.className = "mobile-more-sheet hidden";
    sheet.innerHTML = `
      <div class="mobile-more-backdrop"></div>
      <div class="mobile-more-card">
        <div class="mobile-more-head">
          <h4>More</h4>
          <button type="button" class="mobile-more-close" aria-label="Close">✕</button>
        </div>
        <div class="mobile-more-list"></div>
      </div>
    `;

    const list = sheet.querySelector(".mobile-more-list");
    if (list) {
      mobileSecondaryLinks.forEach((link) => {
        const href = link.getAttribute("href") || "";
        const labelText = link.dataset.label || link.getAttribute("aria-label") || "Link";
        if (link.id === "profile-logout-link") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "mobile-more-link danger";
          btn.textContent = labelText;
          btn.addEventListener("click", () => {
            sheet.classList.add("hidden");
            link.click();
          });
          list.appendChild(btn);
          return;
        }

        const item = document.createElement("a");
        item.href = href;
        item.className = "mobile-more-link";
        item.textContent = labelText;
        list.appendChild(item);
      });
    }

    const closeSheet = () => {
      sheet.classList.add("hidden");
      moreBtn.classList.remove("is-open");
      moreBtn.setAttribute("aria-expanded", "false");
    };

    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.addEventListener("click", () => {
      const willOpen = sheet.classList.contains("hidden");
      sheet.classList.toggle("hidden", !willOpen);
      moreBtn.classList.toggle("is-open", willOpen);
      moreBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });

    sheet.querySelector(".mobile-more-backdrop")?.addEventListener("click", closeSheet);
    sheet.querySelector(".mobile-more-close")?.addEventListener("click", closeSheet);
    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) closeSheet();
    });

    nav.appendChild(moreBtn);
    document.body.appendChild(sheet);
  }

  // Hover-to-expand sidebar: collapsed by default, expands on hover/focus.
  document.body.classList.add("sidebar-collapsed");
  refreshMyProfileIcon();
  refreshBrandIdentity();
  window.addEventListener("auth:changed", refreshMyProfileIcon);
  window.addEventListener("auth:changed", refreshBrandIdentity);
}

initTheme();
initSidebarCollapse();
initGlassPageTransitions();

function formatNotificationTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
}

function notificationTargetUrl(item) {
  if (item && item.event_type === "new_message" && item.actor && item.actor.id) {
    return `/chats?open_user_id=${item.actor.id}`;
  }
  if (item && item.event_type === "new_follower" && item.actor && item.actor.id) {
    return `/user/${item.actor.id}`;
  }
  if (item && item.event_type === "new_story") {
    return "/community-feed";
  }
  if (item && item.post_id) {
    if (item.comment_id) {
      return `/community-feed?post_id=${item.post_id}&comment_id=${item.comment_id}`;
    }
    return `/community-feed?post_id=${item.post_id}`;
  }
  return "/community-feed";
}

function initNotificationCenter() {
  if (document.body.classList.contains("landing-page")) return;
  if (document.querySelector(".notification-center")) return;

  const shell = document.createElement("div");
  shell.className = "notification-center hidden";
  shell.innerHTML = `
    <button id="notif-bell-btn" class="notif-bell-btn" type="button" aria-label="Notifications">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5a4.5 4.5 0 0 0-4.5 4.5v1.8c0 1.8-.5 3.6-1.5 5.1l-.7 1.1h13.4l-.7-1.1a9.3 9.3 0 0 1-1.5-5.1V8A4.5 4.5 0 0 0 12 3.5Z"></path>
        <path d="M9.2 17.5a2.8 2.8 0 0 0 5.6 0"></path>
      </svg>
      <span id="notif-unread-dot" class="notif-unread-dot hidden"></span>
    </button>
    <section id="notif-panel" class="notif-panel hidden">
      <header class="notif-header">
        <h4>Notifications</h4>
        <button id="notif-read-all-btn" type="button">Mark all read</button>
      </header>
      <div id="notif-list" class="notif-list"></div>
    </section>
  `;
  document.body.appendChild(shell);

  const bellBtn = document.getElementById("notif-bell-btn");
  const unreadDot = document.getElementById("notif-unread-dot");
  const panel = document.getElementById("notif-panel");
  const readAllBtn = document.getElementById("notif-read-all-btn");
  const listEl = document.getElementById("notif-list");
  let pollTimer = null;
  let socket = null;
  let reconnectTimer = null;
  let bellShakeTimer = null;
  let items = [];
  let latestId = 0;

  const stopPolling = () => {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const stopRealtime = () => {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      } catch {
        // no-op
      }
      socket = null;
    }
  };

  const render = () => {
    const unreadCount = items.filter((item) => !item.is_read).length;
    const hasUnread = unreadCount > 0;
    unreadDot.classList.toggle("hidden", !hasUnread);
    unreadDot.textContent = unreadCount > 99 ? "99+" : String(unreadCount || "");
    unreadDot.setAttribute("aria-label", unreadCount ? `${unreadCount} unread notifications` : "No unread notifications");

    if (!items.length) {
      listEl.innerHTML = `<p class="notif-empty">No notifications yet.</p>`;
      return;
    }
    listEl.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `notif-item${item.is_read ? "" : " unread"}`;
      const actorPhoto = (item.actor && item.actor.profile_photo_url) || "/static/default-avatar.svg";
      row.innerHTML = `
        <img class="notif-avatar" src="${actorPhoto}" alt="${item.actor ? item.actor.username : "user"}" />
        <div class="notif-text">
          <p class="notif-title">${item.title}</p>
          ${item.message ? `<p class="notif-message">${item.message}</p>` : ""}
          <p class="notif-time">${formatNotificationTime(item.created_at)}</p>
        </div>
      `;
      row.addEventListener("click", async () => {
        try {
          if (!item.is_read) {
            await api(`/api/notifications/${item.id}/read`, { method: "POST" });
            item.is_read = true;
            render();
          }
        } catch {
          // Keep navigation functional if read update fails.
        }
        window.location.href = notificationTargetUrl(item);
      });
      listEl.appendChild(row);
    });
  };

  const mergeNewItems = (incoming) => {
    if (!incoming.length) return;
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    incoming.forEach((entry) => byId.set(entry.id, entry));
    items = Array.from(byId.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    latestId = Math.max(latestId, ...incoming.map((entry) => entry.id));
  };

  const triggerBellShake = () => {
    if (!bellBtn) return;
    bellBtn.classList.remove("is-shaking");
    void bellBtn.offsetWidth;
    bellBtn.classList.add("is-shaking");
    if (bellShakeTimer) {
      window.clearTimeout(bellShakeTimer);
    }
    bellShakeTimer = window.setTimeout(() => {
      bellBtn.classList.remove("is-shaking");
      bellShakeTimer = null;
    }, 820);
  };

  const scheduleReconnect = () => {
    if (reconnectTimer || !getToken()) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectRealtime();
    }, 2500);
  };

  const connectRealtime = () => {
    if (!("WebSocket" in window)) return;
    if (!getToken()) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const wsUrl = new URL(resolveWsUrl("/ws/notifications"));
    wsUrl.searchParams.set("token", getToken());
    socket = new WebSocket(wsUrl.toString());
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (payload?.type !== "notification" || !payload.notification) return;
        mergeNewItems([payload.notification]);
        render();
        triggerBellShake();
      } catch {
        // ignore malformed frames
      }
    };
    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        // no-op
      }
    };
    socket.onclose = (event) => {
      socket = null;
      if (event && event.code === 4401) {
        return;
      }
      scheduleReconnect();
    };
  };

  const loadInitial = async () => {
    const data = await api("/api/notifications?limit=30");
    items = Array.isArray(data) ? data : [];
    latestId = items.reduce((acc, item) => Math.max(acc, item.id || 0), 0);
    render();
  };

  const pollNew = async () => {
    if (!latestId) {
      await loadInitial();
      return;
    }
    const data = await api(`/api/notifications?after_id=${latestId}&limit=30`);
    const incoming = Array.isArray(data) ? data : [];
    if (!incoming.length) return;
    mergeNewItems(incoming);
    render();
    triggerBellShake();
  };

  const startPolling = async () => {
    stopPolling();
    try {
      await loadInitial();
    } catch {
      // silent fail until next auth change
      return;
    }
    pollTimer = window.setInterval(() => {
      pollNew().catch(() => {});
    }, 6000);
    connectRealtime();
  };

  const refreshAuthState = () => {
    const user = getAuthUser();
    if (!user || !getToken()) {
      shell.classList.add("hidden");
      panel.classList.add("hidden");
      stopPolling();
      stopRealtime();
      return;
    }
    shell.classList.remove("hidden");
    startPolling().catch(() => {});
  };

  bellBtn.addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });

  readAllBtn.addEventListener("click", async () => {
    try {
      await api("/api/notifications/read-all", { method: "POST" });
      items = items.map((item) => ({ ...item, is_read: true }));
      render();
    } catch {
      // no-op
    }
  });

  document.addEventListener("click", (event) => {
    if (!shell.contains(event.target)) panel.classList.add("hidden");
  });
  window.addEventListener("auth:changed", refreshAuthState);
  refreshAuthState();
}

initNotificationCenter();

function initGlobalLogout() {
  const logoutLink = document.getElementById("profile-logout-link");
  if (!logoutLink) return;
  logoutLink.addEventListener("click", async (event) => {
    event.preventDefault();
    const confirmed = await showConfirmDialog("Are you sure you want to logout?");
    if (!confirmed) return;
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout errors if user is already logged out.
    }
    clearAuth();
    window.location.href = "/create-profile";
  });
}

initGlobalLogout();

function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "confirm-modal";
    modal.innerHTML = `
      <div class="confirm-backdrop"></div>
      <div class="confirm-card">
        <p class="confirm-message"></p>
        <div class="confirm-actions">
          <button class="confirm-yes-btn" data-confirm="yes" type="button">Yes</button>
          <button class="confirm-no-btn alt" data-confirm="no" type="button">No</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const messageEl = modal.querySelector(".confirm-message");
    const yesBtn = modal.querySelector(".confirm-yes-btn");
    const noBtn = modal.querySelector(".confirm-no-btn");
    const backdrop = modal.querySelector(".confirm-backdrop");
    messageEl.textContent = message;
    document.body.classList.add("confirm-open");

    const finish = (value) => {
      if (!modal.isConnected) return;
      document.body.classList.remove("confirm-open");
      modal.remove();
      resolve(value);
    };

    if (yesBtn instanceof HTMLButtonElement) {
      yesBtn.addEventListener("click", () => finish(true), { once: true });
    }
    if (noBtn instanceof HTMLButtonElement) {
      noBtn.addEventListener("click", () => finish(false), { once: true });
    }
    if (backdrop instanceof HTMLDivElement) {
      backdrop.addEventListener("click", () => finish(false), { once: true });
    }
    window.requestAnimationFrame(() => {
      const yes = modal.querySelector(".confirm-yes-btn");
      if (yes instanceof HTMLButtonElement) yes.focus();
    });
  });
}

const followStateByUserId = new Map();
const followStateListeners = new Set();

function normalizeFollowState(payload) {
  const userId = Number(payload && payload.userId);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const isFollowing = !!(payload && payload.isFollowing);
  const state = { userId, isFollowing };
  if (payload && Number.isFinite(Number(payload.followerCount))) {
    state.followerCount = Math.max(0, Number(payload.followerCount));
  }
  return state;
}

function publishFollowState(payload) {
  const state = normalizeFollowState(payload);
  if (!state) return;
  followStateByUserId.set(state.userId, state);
  followStateListeners.forEach((listener) => {
    try {
      listener(state);
    } catch {
      // keep other listeners running
    }
  });
  window.dispatchEvent(new CustomEvent("follow:changed", { detail: state }));
}

function getFollowState(userId) {
  const key = Number(userId);
  if (!Number.isFinite(key) || key <= 0) return null;
  return followStateByUserId.get(key) || null;
}

function onFollowStateChange(listener) {
  if (typeof listener !== "function") return () => {};
  followStateListeners.add(listener);
  return () => {
    followStateListeners.delete(listener);
  };
}

window.App = {
  api,
  setAuth,
  clearAuth,
  getAuthUser,
  getAppConfig,
  getApiBaseUrl,
  getTheme,
  setTheme,
  getToken,
  renderRichBio,
  mentionMarkup,
  resolveApiUrl,
  resolveWsUrl,
  requireAuth,
  playActionBurst,
  initGlassPageTransitions,
  initGlobalLogout,
  showConfirmDialog,
  publishFollowState,
  getFollowState,
  onFollowStateChange,
};
