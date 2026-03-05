const feedRoot = document.getElementById("feed");
const whoami = document.getElementById("whoami");
const searchInput = document.getElementById("feed-search");
const userResultsBox = document.getElementById("user-results-box");
const searchStatus = document.getElementById("search-status");
const userStatus = document.getElementById("user-status");
const userResults = document.getElementById("user-results");
const storyBar = document.getElementById("story-bar");

let allPosts = [];
let allSuggestedUsers = [];
let allUsers = [];
let feedRankingMode = "heuristic";
let feedRankingLatencyMs = 0;
let storyGroups = [];
let storyAutoTimer = null;
let storyVideoEndedHandler = null;
let storyProgressFrame = null;
let sharedFocusApplied = false;

function storyReplyDeviceId() {
  let id = localStorage.getItem("chatDeviceId");
  if (!id) {
    id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem("chatDeviceId", id);
  }
  return id;
}

function storyReplyChatHeaders() {
  const headers = new Headers();
  const chatToken = localStorage.getItem("chatToken") || "";
  if (chatToken) headers.set("X-Chat-Token", chatToken);
  headers.set("X-Device-Id", storyReplyDeviceId());
  const authToken = App.getToken();
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  return headers;
}

async function storyReplyChatApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  storyReplyChatHeaders().forEach((value, key) => headers.set(key, value));
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

if (!App.requireAuth()) {
  // redirected
}

function renderStoryStickers(mediaEl, story) {
  const stickers = Array.isArray(story?.sticker_data) ? story.sticker_data : [];
  if (!stickers.length) return;

  const layer = document.createElement("div");
  layer.className = "story-viewer-sticker-layer";
  stickers.forEach((item) => {
    const text = `${item?.text || ""}`.trim();
    if (!text) return;
    const x = Math.max(0, Math.min(100, Number(item?.x) || 50));
    const y = Math.max(0, Math.min(100, Number(item?.y) || 50));
    const scale = Math.max(0.5, Math.min(2.5, Number(item?.scale) || 1));
    const rotate = Math.max(-180, Math.min(180, Number(item?.rotate) || 0));

    const sticker = document.createElement("span");
    sticker.className = "story-viewer-sticker";
    sticker.textContent = text;
    sticker.style.left = `${x}%`;
    sticker.style.top = `${y}%`;
    sticker.style.setProperty("--sticker-scale", String(scale));
    sticker.style.setProperty("--sticker-rotate", `${rotate}deg`);
    layer.appendChild(sticker);
  });
  if (layer.children.length) mediaEl.appendChild(layer);
}

async function loadFeed() {
  const data = await App.api("/api/feed");
  allPosts = data.posts || [];
  allSuggestedUsers = data.suggested_users || [];
  feedRankingMode = data.ranking_mode || "heuristic";
  feedRankingLatencyMs = Number(data.ranking_latency_ms || 0);
  renderResults();
}

async function loadStories() {
  storyGroups = await App.api("/api/stories/bar");
  renderStoryBar();
}

function ensureStoryViewer() {
  let modal = document.getElementById("story-viewer-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "story-viewer-modal";
  modal.className = "story-viewer-modal hidden";
  modal.innerHTML = `
    <div class="story-viewer-backdrop"></div>
    <div class="story-viewer-content">
      <button id="story-close-btn" class="story-close-x" type="button" aria-label="Close story">×</button>
      <div class="story-viewer-head">
        <div class="story-viewer-user"></div>
        <small id="story-counter" class="story-counter"></small>
      </div>
      <div class="story-progress" id="story-progress"></div>
      <div class="story-image-wrap">
        <div id="story-viewer-media"></div>
        <button id="story-tap-prev" class="story-tap-zone story-nav-arrow story-tap-prev" type="button" aria-label="Previous story">‹</button>
        <button id="story-tap-next" class="story-tap-zone story-nav-arrow story-tap-next" type="button" aria-label="Next story">›</button>
      </div>
      <p id="story-viewer-caption" class="notice"></p>
      <form id="story-reply-form" class="story-reply-form">
        <input id="story-reply-input" class="story-reply-input" type="text" maxlength="1000" placeholder="Reply to this story..." />
        <button id="story-reply-send" class="story-reply-send" type="submit" aria-label="Send story reply">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 11.5L21 3l-8.5 18-2.4-6.1L3 11.5z"></path>
            <path d="M10.1 14.9L21 3"></path>
          </svg>
        </button>
      </form>
      <div class="story-reply-meta">
        <p id="story-reply-status" class="notice story-reply-status"></p>
        <button id="story-reply-login-btn" class="story-reply-login-btn hidden" type="button">Open Chats Login</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".story-viewer-backdrop").addEventListener("click", () => {
    modal.classList.add("hidden");
  });
  modal.querySelector("#story-close-btn").addEventListener("click", () => {
    modal.classList.add("hidden");
  });
  return modal;
}

function renderStoryBar() {
  if (!storyBar) return;
  storyBar.innerHTML = "";
  const me = App.getAuthUser();
  const groups = [...storyGroups];
  if (me && !groups.some((item) => item.user.id === me.id)) {
    groups.unshift({
      user: me,
      has_unseen: false,
      latest_story_at: new Date().toISOString(),
      stories: [],
    });
  }

  if (!groups.length) {
    storyBar.innerHTML = `<p class="notice">No active stories. Go to <a href="/stories">Stories</a> to post one.</p>`;
    return;
  }

  groups.forEach((group) => {
    const btn = document.createElement("button");
    const hasStory = Array.isArray(group.stories) && group.stories.length > 0;
    const isOwn = group.user.id === me?.id;
    btn.type = "button";
    btn.className = `story-avatar-btn ${group.has_unseen ? "has-unseen" : "is-seen"} ${isOwn ? "is-own" : ""}`;
    btn.innerHTML = `
      <span class="story-ring">
        <img src="${group.user.profile_photo_url || "/static/default-avatar.svg"}" alt="${group.user.username}" />
      </span>
      <small>${isOwn ? (hasStory ? "Your Story" : "Add Story") : `@${group.user.username}`}</small>
    `;
    btn.addEventListener("click", () => {
      if (isOwn && !hasStory) {
        window.location.href = "/stories";
        return;
      }
      openStoryViewer(group.user.id);
    });
    storyBar.appendChild(btn);
  });
}

function openStoryViewer(userId) {
  const group = storyGroups.find((item) => item.user.id === userId);
  if (!group || !group.stories || !group.stories.length) return;

  const modal = ensureStoryViewer();
  const userEl = modal.querySelector(".story-viewer-user");
  const progressEl = modal.querySelector("#story-progress");
  const mediaEl = modal.querySelector("#story-viewer-media");
  const captionEl = modal.querySelector("#story-viewer-caption");
  const replyForm = modal.querySelector("#story-reply-form");
  const replyInput = modal.querySelector("#story-reply-input");
  const replyStatus = modal.querySelector("#story-reply-status");
  const replyLoginBtn = modal.querySelector("#story-reply-login-btn");
  const counterEl = modal.querySelector("#story-counter");
  const tapPrev = modal.querySelector("#story-tap-prev");
  const tapNext = modal.querySelector("#story-tap-next");
  const prevBtn = tapPrev;
  const nextBtn = tapNext;

  let idx = 0;
  const stories = group.stories;
  const isOwn = group.user.id === App.getAuthUser()?.id;
  const firstUnseenIndex = stories.findIndex((story) => !story.viewed_by_me);
  if (firstUnseenIndex >= 0) idx = firstUnseenIndex;
  const imageDurationMs = 5000;
  let storyPaused = false;
  let imageProgressElapsedMs = 0;
  let imageProgressStartMs = 0;

  const resetReplyUi = () => {
    if (replyInput) replyInput.value = "";
    if (replyStatus) {
      replyStatus.textContent = "";
      replyStatus.innerHTML = "";
    }
    replyLoginBtn?.classList.add("hidden");
    if (replyForm) replyForm.classList.remove("hidden");
  };

  const stopAuto = () => {
    if (storyAutoTimer) {
      clearTimeout(storyAutoTimer);
      storyAutoTimer = null;
    }
    if (storyProgressFrame) {
      cancelAnimationFrame(storyProgressFrame);
      storyProgressFrame = null;
    }
    if (storyVideoEndedHandler) {
      const existingVideo = mediaEl.querySelector("video");
      if (existingVideo) existingVideo.removeEventListener("ended", storyVideoEndedHandler);
      storyVideoEndedHandler = null;
    }
  };

  const currentStory = () => stories[idx];

  const paintProgress = (currentProgress = 0) => {
    const safe = Math.max(0, Math.min(1, Number(currentProgress) || 0));
    progressEl.querySelectorAll(".story-progress-seg").forEach((seg, segIndex) => {
      let value = 0;
      if (segIndex < idx) value = 1;
      else if (segIndex === idx) value = safe;
      seg.style.setProperty("--progress", `${Math.round(value * 1000) / 10}%`);
    });
  };

  const startProgressLoop = (getProgress, onComplete) => {
    if (storyProgressFrame) {
      cancelAnimationFrame(storyProgressFrame);
      storyProgressFrame = null;
    }
    const tick = () => {
      const progress = Math.max(0, Math.min(1, Number(getProgress()) || 0));
      paintProgress(progress);
      if (progress >= 1) {
        storyProgressFrame = null;
        if (onComplete) onComplete();
        return;
      }
      storyProgressFrame = requestAnimationFrame(tick);
    };
    tick();
  };

  const pauseCurrentStory = () => {
    if (storyPaused) return;
    storyPaused = true;
    const story = currentStory();
    if (!story) return;
    if (story.media_type === "video") {
      const video = mediaEl.querySelector("video");
      if (video) {
        video.pause();
        const duration =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : Math.max(1, Number(story.duration_seconds || 0));
        paintProgress(duration > 0 ? video.currentTime / duration : 0);
      }
    } else {
      if (imageProgressStartMs) {
        imageProgressElapsedMs += Math.max(0, performance.now() - imageProgressStartMs);
        imageProgressStartMs = 0;
      }
      paintProgress(imageProgressElapsedMs / imageDurationMs);
    }
    if (storyAutoTimer) {
      clearTimeout(storyAutoTimer);
      storyAutoTimer = null;
    }
    if (storyProgressFrame) {
      cancelAnimationFrame(storyProgressFrame);
      storyProgressFrame = null;
    }
  };

  const resumeCurrentStory = () => {
    if (!storyPaused || modal.classList.contains("hidden")) return;
    const story = currentStory();
    if (!story) return;
    storyPaused = false;
    if (story.media_type === "video") {
      const video = mediaEl.querySelector("video");
      if (!video) return;
      video.play().catch(() => {});
      const readProgress = () => {
        const duration =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : Math.max(1, Number(story.duration_seconds || 0));
        return duration > 0 ? video.currentTime / duration : 0;
      };
      startProgressLoop(readProgress, () => {
        goNext().catch(() => {});
      });
      return;
    }
    imageProgressStartMs = performance.now();
    startProgressLoop(
      () => (imageProgressElapsedMs + Math.max(0, performance.now() - imageProgressStartMs)) / imageDurationMs,
      () => {
        goNext().catch(() => {});
      }
    );
  };

  const goNext = async () => {
    if (idx < stories.length - 1) {
      idx += 1;
      await render();
      return;
    }
    stopAuto();
    modal.classList.add("hidden");
  };

  const render = async () => {
    stopAuto();
    storyPaused = false;
    imageProgressElapsedMs = 0;
    imageProgressStartMs = 0;
    const story = stories[idx];
    userEl.innerHTML = `
      <img src="${group.user.profile_photo_url || "/static/default-avatar.svg"}" alt="${group.user.username}" />
      <div>
        <strong>@${group.user.username}</strong>
        <small>${new Date(story.created_at).toLocaleString()}</small>
      </div>
    `;
    progressEl.innerHTML = stories
      .map(
        (_, i) =>
          `<button class="story-progress-seg" data-story-index="${i}" type="button" aria-label="Go to story ${i + 1}"></button>`
      )
      .join("");
    counterEl.textContent = `${idx + 1} / ${stories.length}`;
    mediaEl.innerHTML = "";
    if (story.media_type === "video") {
      const video = document.createElement("video");
      video.className = "story-viewer-video";
      video.src = story.media_url;
      video.muted = false;
      video.controls = false;
      video.autoplay = true;
      video.playsInline = true;
      mediaEl.appendChild(video);
      renderStoryStickers(mediaEl, story);
      storyVideoEndedHandler = () => {
        goNext().catch(() => {});
      };
      video.addEventListener("ended", storyVideoEndedHandler);
      video.play().catch(() => {});
      const readProgress = () => {
        const duration =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : Math.max(1, Number(story.duration_seconds || 0));
        return duration > 0 ? video.currentTime / duration : 0;
      };
      startProgressLoop(readProgress);
    } else {
      const image = document.createElement("img");
      image.id = "story-viewer-image";
      image.className = "story-viewer-image";
      image.src = story.media_url;
      image.alt = "Story";
      mediaEl.appendChild(image);
      renderStoryStickers(mediaEl, story);
      imageProgressStartMs = performance.now();
      startProgressLoop(
        () => (imageProgressElapsedMs + Math.max(0, performance.now() - imageProgressStartMs)) / imageDurationMs,
        () => {
          goNext().catch(() => {});
        }
      );
    }
    captionEl.textContent = story.caption || "No caption";
    if (isOwn) {
      replyForm?.classList.add("hidden");
      if (replyStatus) {
        replyStatus.textContent = "Story replies are available on other users' stories.";
      }
      replyLoginBtn?.classList.add("hidden");
    } else {
      resetReplyUi();
    }
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === stories.length - 1;

    progressEl.querySelectorAll(".story-progress-seg").forEach((seg) => {
      seg.addEventListener("click", async () => {
        const nextIndex = Number(seg.getAttribute("data-story-index") || "0");
        if (Number.isNaN(nextIndex) || nextIndex < 0 || nextIndex >= stories.length) return;
        idx = nextIndex;
        await render();
      });
    });

    if (!story.viewed_by_me) {
      try {
        await App.api(`/api/stories/${story.id}/view`, { method: "POST" });
        story.viewed_by_me = true;
        group.has_unseen = stories.some((item) => !item.viewed_by_me);
        renderStoryBar();
      } catch {
        // Keep viewing even if mark-view fails.
      }
    }
  };

  prevBtn.onclick = async () => {
    if (idx > 0) {
      idx -= 1;
      await render();
    }
  };
  nextBtn.onclick = goNext;
  tapPrev.onclick = prevBtn.onclick;
  tapNext.onclick = goNext;
  replyInput.onfocus = () => {
    if (!isOwn) pauseCurrentStory();
  };
  replyInput.oninput = () => {
    if (!isOwn) pauseCurrentStory();
  };
  replyInput.onblur = () => {
    if (!isOwn && !(replyInput.value || "").trim()) {
      resumeCurrentStory();
    }
  };
  replyLoginBtn.onclick = () => {
    window.location.href = `/chats?open_user_id=${group.user.id}`;
  };
  replyForm.onsubmit = async (event) => {
    event.preventDefault();
    if (isOwn) return;
    const content = (replyInput?.value || "").trim();
    if (!content) {
      if (replyStatus) replyStatus.textContent = "Write a reply first.";
      return;
    }
    const sendBtn = replyForm.querySelector(".story-reply-send");
    if (sendBtn) sendBtn.disabled = true;
    try {
      const activeStory = currentStory();
      const storyAttachment = activeStory ? `[[STEPNIX_SHARE_STORY:${activeStory.id}]]` : "";
      const messageContent = [storyAttachment, content].filter(Boolean).join("\n");
      await storyReplyChatApi(`/api/chat/messages/${group.user.id}`, {
        method: "POST",
        body: new URLSearchParams({ content: messageContent || content }),
      });
      if (replyInput) replyInput.value = "";
      if (replyStatus) replyStatus.textContent = "Reply sent.";
      replyLoginBtn?.classList.add("hidden");
      resumeCurrentStory();
      if (window.App && typeof window.App.playActionBurst === "function") {
        window.App.playActionBurst(sendBtn, "✓");
      }
    } catch (error) {
      const text = String(error.message || "");
      if (text.includes("Chat login required") || text.includes("Chat session")) {
        if (replyStatus) replyStatus.textContent = "Login to chat service first, then send your story reply.";
        replyLoginBtn?.classList.remove("hidden");
      } else if (replyStatus) {
        replyStatus.textContent = text;
      }
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  };
  modal.querySelector("#story-close-btn").onclick = () => {
    stopAuto();
    resetReplyUi();
    modal.classList.add("hidden");
  };
  modal.querySelector(".story-viewer-backdrop").onclick = () => {
    stopAuto();
    resetReplyUi();
    modal.classList.add("hidden");
  };

  modal.classList.remove("hidden");
  render().catch(() => {});
}

function renderUserMatches(query) {
  userResults.innerHTML = "";
  userStatus.textContent = "";
  userResultsBox.classList.add("hidden");
  if (!query) return;

  const q = query.toLowerCase();
  const matches = allUsers
    .filter((user) => {
      const uname = (user.username || "").toLowerCase();
      const fname = (user.full_name || "").toLowerCase();
      return uname.includes(q) || fname.includes(q);
    })
    .slice(0, 20);

  if (!matches.length) {
    userStatus.textContent = `No users found for "${query}".`;
    userResultsBox.classList.remove("hidden");
    return;
  }

  userStatus.textContent = `${matches.length} account(s) found.`;
  userResultsBox.classList.remove("hidden");

  matches.forEach((user) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "user-result-card";
    chip.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <div class="user-result-meta">
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
        <small>User ID: ${user.id}</small>
      </div>
    `;
    chip.addEventListener("click", () => {
      window.location.href = `/user/${user.id}`;
    });
    userResults.appendChild(chip);
  });
}

function renderResults() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const filteredPosts = q
    ? allPosts.filter((post) => {
        const uname = (post.author.username || "").toLowerCase();
        const fname = (post.author.full_name || "").toLowerCase();
        return uname.includes(q) || fname.includes(q);
      })
    : allPosts;

  feedRoot.innerHTML = "";
  if (!filteredPosts.length) {
    feedRoot.innerHTML = "<p class='notice'>No matching posts found.</p>";
  } else {
    const suggestionPool = q ? [] : [...allSuggestedUsers];
    let suggestionOffset = 0;
    filteredPosts.forEach((post, index) => {
      feedRoot.appendChild(createPostCard(post));
      const shouldInsertSuggestion = !q && suggestionPool.length && (index + 1) % 4 === 0;
      if (!shouldInsertSuggestion) return;
      const chunk = suggestionPool.slice(suggestionOffset, suggestionOffset + 6);
      suggestionOffset += 6;
      if (!chunk.length) return;
      feedRoot.appendChild(createSuggestionCarouselCard(chunk));
    });
  }

  if (!q) {
    if (searchStatus) {
      searchStatus.textContent = `Personalized feed mode: ${feedRankingMode} (${feedRankingLatencyMs}ms)`;
    }
    userStatus.textContent = "";
    userResults.innerHTML = "";
    userResultsBox.classList.add("hidden");
    return;
  }

  if (searchStatus) {
    searchStatus.textContent = `${filteredPosts.length} post(s) matched "${searchInput.value.trim()}".`;
  }
  renderUserMatches(searchInput.value.trim());
}

function createSuggestionCarouselCard(users) {
  const card = document.createElement("article");
  card.className = "post-card suggest-card";
  card.innerHTML = `
    <div class="suggest-head">
      <h3>Suggested To Follow</h3>
      <small>Based on your interactions + network</small>
    </div>
    <div class="suggest-carousel">
      <button class="suggest-nav prev" type="button" aria-label="Previous suggestions">‹</button>
      <div class="suggest-track-wrap">
        <div class="suggest-track"></div>
      </div>
      <button class="suggest-nav next" type="button" aria-label="Next suggestions">›</button>
    </div>
  `;

  const track = card.querySelector(".suggest-track");
  const prevBtn = card.querySelector(".suggest-nav.prev");
  const nextBtn = card.querySelector(".suggest-nav.next");
  const pageSize = 3;
  const pages = [];
  let slideIndex = 0;

  for (let i = 0; i < users.length; i += pageSize) {
    pages.push(users.slice(i, i + pageSize));
  }

  pages.forEach((pageUsers) => {
    const slide = document.createElement("div");
    slide.className = "suggest-item suggest-page";
    slide.innerHTML = pageUsers
      .map(
        (user) => `
          <article class="suggest-mini-card" data-user-id="${user.id}">
            <a class="suggest-mini-link" href="/user/${user.id}" aria-label="Open @${user.username} profile">
              <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
              <div class="suggest-meta">
                <strong>${user.full_name}</strong>
                <small>@${user.username}</small>
              </div>
            </a>
            <button class="suggest-follow-btn ${user.is_following ? "is-following" : ""}" type="button">${user.is_following ? "Following" : "Follow"}</button>
          </article>
        `
      )
      .join("");

    slide.querySelectorAll(".suggest-mini-card").forEach((entry) => {
      const followBtn = entry.querySelector(".suggest-follow-btn");
      const userId = Number(entry.getAttribute("data-user-id") || 0);
      if (!followBtn || !userId) return;
      let followSyncInFlight = false;
      let confirmedFollowing = followBtn.classList.contains("is-following");
      let desiredFollowing = confirmedFollowing;

      const paintFollow = (isFollowing) => {
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
              await App.api(`/api/users/${userId}/follow`, { method: "POST" });
            } else {
              await App.api(`/api/users/${userId}/follow`, { method: "DELETE" });
            }
            confirmedFollowing = targetFollowing;
            const target = allSuggestedUsers.find((row) => row.id === userId);
            if (target) target.is_following = confirmedFollowing;
          }
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
        if (!wasDesiredFollowing && nextFollowing && window.App && typeof window.App.playActionBurst === "function") {
          window.App.playActionBurst(followBtn, "✓");
        }
        void syncFollowState();
      });
    });

    track.appendChild(slide);
  });

  const total = pages.length;
  const maxIndex = Math.max(0, total - 1);
  const paint = () => {
    slideIndex = Math.max(0, Math.min(slideIndex, maxIndex));
    track.style.transform = `translateX(${-slideIndex * 100}%)`;
  };
  prevBtn.addEventListener("click", () => {
    slideIndex = slideIndex <= 0 ? maxIndex : slideIndex - 1;
    paint();
  });
  nextBtn.addEventListener("click", () => {
    slideIndex = slideIndex >= maxIndex ? 0 : slideIndex + 1;
    paint();
  });
  prevBtn.disabled = total <= 1;
  nextBtn.disabled = total <= 1;

  let autoTimer = window.setInterval(() => {
    slideIndex = slideIndex >= maxIndex ? 0 : slideIndex + 1;
    paint();
  }, 3600);
  card.addEventListener("mouseenter", () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  });
  card.addEventListener("mouseleave", () => {
    if (!autoTimer) {
      autoTimer = window.setInterval(() => {
        slideIndex = slideIndex >= maxIndex ? 0 : slideIndex + 1;
        paint();
      }, 3600);
    }
  });

  paint();
  return card;
}

async function focusSharedPostIfNeeded() {
  if (sharedFocusApplied) return;
  const params = new URLSearchParams(window.location.search);
  const postId = params.get("post_id");
  const commentId = params.get("comment_id");
  if (!postId) return;
  const target = feedRoot.querySelector(`.post-card[data-post-id='${postId}']`);
  if (!target) return;
  target.classList.add("shared-focus");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  if (commentId && typeof target.focusComment === "function") {
    await target.focusComment(commentId);
  } else if (commentId && typeof target.openComments === "function") {
    await target.openComments();
  }
  sharedFocusApplied = true;
}

(async function init() {
  try {
    const me = await App.api("/api/auth/me");
    App.setAuth(App.getToken(), me);
    if (whoami) {
      whoami.textContent = `Logged in as @${me.username}`;
    }
    allUsers = await App.api("/api/users");
    searchInput.addEventListener("input", renderResults);
    await loadStories();
    await loadFeed();
    await focusSharedPostIfNeeded();
  } catch (error) {
    if (error && Number(error.status) === 401) {
      App.clearAuth();
      window.location.href = "/create-profile";
      return;
    }
    if (whoami) {
      const message = (error && error.message) || "Failed to load feed.";
      whoami.textContent = `Feed error: ${message}`;
    }
  }
})();
