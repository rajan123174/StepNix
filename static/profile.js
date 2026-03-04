const profileFeed = document.getElementById("profile-feed");
const avatar = document.getElementById("profile-avatar");
const avatarEditBtn = document.getElementById("avatar-edit-btn");
const profilePhotoInput = document.getElementById("profile-photo-input");

const dpModal = document.getElementById("dp-modal");
const dpModalImage = document.getElementById("dp-modal-image");
const dpModalClose = document.getElementById("dp-modal-close");
const postViewModal = document.getElementById("post-view-modal");
const postViewBody = document.getElementById("post-view-body");
const postViewClose = document.getElementById("post-view-close");

const nameEl = document.getElementById("profile-name");
const usernameEl = document.getElementById("profile-username");
const bioEl = document.getElementById("profile-bio");
const postsCountEl = document.getElementById("posts-count");
const followersCountEl = document.getElementById("followers-count");
const followingCountEl = document.getElementById("following-count");
const followersStatBtn = document.getElementById("followers-stat-btn");
const followingStatBtn = document.getElementById("following-stat-btn");
const followListModal = document.getElementById("follow-list-modal");
const followListTitle = document.getElementById("follow-list-title");
const followList = document.getElementById("follow-list");
const followListSearch = document.getElementById("follow-list-search");
const followListClose = document.getElementById("follow-list-close");
const bioEditTrigger = document.getElementById("bio-edit-trigger");
const bioModal = document.getElementById("bio-modal");
const bioModalInput = document.getElementById("bio-modal-input");
const bioModalCancel = document.getElementById("bio-modal-cancel");
const bioModalDone = document.getElementById("bio-modal-done");
let currentFollowListUsers = [];
let currentFollowListType = "followers";

function normalizeFollowSearch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function filterFollowUsers(users, rawQuery) {
  const q = normalizeFollowSearch(rawQuery);
  if (!q) return users;
  return users.filter((user) => {
    const uname = normalizeFollowSearch(user.username);
    const fname = normalizeFollowSearch(user.full_name);
    const userId = String(user.id || "");
    return uname.includes(q) || fname.includes(q) || userId.includes(q);
  });
}

function renderFollowUsers(users) {
  followList.innerHTML = "";
  users.forEach((user) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "user-result-card";
    row.innerHTML = `
      <img src="${user.profile_photo_url || "/static/default-avatar.svg"}" alt="${user.username}" />
      <div class="user-result-meta">
        <strong>${user.full_name}</strong>
        <small>@${user.username}</small>
        <small>User ID: ${user.id}</small>
      </div>
    `;
    row.addEventListener("click", () => {
      window.location.href = `/user/${user.id}`;
    });
    followList.appendChild(row);
  });
}

function isVideoMediaUrl(url) {
  if (!url) return false;
  const clean = String(url).split("?")[0].toLowerCase();
  return [".mp4", ".mov", ".m4v", ".webm"].some((ext) => clean.endsWith(ext));
}

function attachProfileTileVideoLoop(video) {
  if (!video) return;
  const MAX_PREVIEW_SECONDS = 5;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.setAttribute("muted", "");
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");

  const setLoopMode = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    video.loop = video.duration <= MAX_PREVIEW_SECONDS;
  };

  video.addEventListener("loadedmetadata", setLoopMode);
  video.addEventListener("durationchange", setLoopMode);
  video.addEventListener("timeupdate", () => {
    if (Number.isFinite(video.duration) && video.duration > MAX_PREVIEW_SECONDS && video.currentTime >= MAX_PREVIEW_SECONDS) {
      video.currentTime = 0;
      void video.play().catch(() => {});
    }
  });
  video.addEventListener("ended", () => {
    video.currentTime = 0;
    void video.play().catch(() => {});
  });
  void video.play().catch(() => {});
}

if (!App.requireAuth()) {
  // redirected
}

async function loadProfile() {
  const data = await App.api("/api/me/profile");
  App.setAuth(App.getToken(), data.user);

  const imageUrl = data.user.profile_photo_url || "/static/default-avatar.svg";
  avatar.src = imageUrl;
  dpModalImage.src = imageUrl;

  nameEl.textContent = data.user.full_name;
  usernameEl.textContent = `@${data.user.username}`;
  postsCountEl.textContent = String(data.user.post_count || 0);
  followersCountEl.textContent = String(data.user.follower_count || 0);
  followingCountEl.textContent = String(data.user.following_count || 0);
  App.renderRichBio(bioEl, data.user.bio, "No bio yet.");
  bioEl.dataset.rawBio = typeof data.user.bio === "string" ? data.user.bio : "";

  profileFeed.innerHTML = "";
  if (!data.posts.length) {
    profileFeed.className = "stack";
    profileFeed.innerHTML = "<p class='notice'>No posts yet.</p>";
    return;
  }

  profileFeed.className = "profile-post-grid";
  data.posts.forEach((post, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "profile-post-tile";
    tile.setAttribute("aria-label", `Open post ${index + 1}: ${post.goal_title}`);

    const rank = document.createElement("span");
    rank.className = "profile-post-rank";
    rank.textContent = String(index + 1);

    const art = document.createElement("div");
    art.className = "profile-post-art";

    if (post.screenshots && post.screenshots.length) {
      const mediaSrc = post.screenshots[0];
      if (isVideoMediaUrl(mediaSrc)) {
        const video = document.createElement("video");
        video.className = "profile-post-cover profile-post-cover-video";
        video.src = mediaSrc;
        video.setAttribute("aria-hidden", "true");
        attachProfileTileVideoLoop(video);
        art.appendChild(video);
      } else {
        const image = document.createElement("img");
        image.className = "profile-post-cover";
        image.src = mediaSrc;
        image.alt = post.goal_title || "Post image";
        art.appendChild(image);
      }
    } else {
      const fallback = document.createElement("div");
      fallback.className = "profile-post-fallback";
      fallback.textContent = post.goal_title || "Post";
      art.appendChild(fallback);
    }

    art.appendChild(rank);
    tile.appendChild(art);
    tile.addEventListener("click", () => openPostViewer(post));
    profileFeed.appendChild(tile);
  });
}

function openPostViewer(post) {
  postViewBody.innerHTML = "";
  const postCard = createPostCard(post, async () => {
    await loadProfile();
  });
  postViewBody.appendChild(postCard);

  const actions = postCard.querySelector(".post-actions");
  if (actions) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-outline-btn";
    deleteBtn.textContent = "Delete Post";
    deleteBtn.addEventListener("click", async () => {
      try {
        const confirmed = await App.showConfirmDialog("Are you sure you want to delete this post?");
        if (!confirmed) return;
        await App.api(`/api/posts/${post.id}`, { method: "DELETE" });
        postViewModal.classList.add("hidden");
        await loadProfile();
      } catch (error) {
        alert(error.message);
      }
    });
    actions.appendChild(deleteBtn);
  }

  postViewModal.classList.remove("hidden");
}

async function openFollowList(type) {
  const isFollowers = type === "followers";
  currentFollowListType = isFollowers ? "followers" : "following";
  followListTitle.textContent = isFollowers ? "Followers" : "Following";
  followList.innerHTML = "<p class='notice'>Loading...</p>";
  if (followListSearch) {
    followListSearch.value = "";
    followListSearch.placeholder = isFollowers
      ? "Search in followers..."
      : "Search in following...";
  }
  followListModal.classList.remove("hidden");

  try {
    const users = await App.api(isFollowers ? "/api/me/followers" : "/api/me/following");
    currentFollowListUsers = users;
    if (isFollowers) {
      followersCountEl.textContent = String(users.length);
    } else {
      followingCountEl.textContent = String(users.length);
    }
    if (!users.length) {
      followList.innerHTML = `<p class='notice'>No ${isFollowers ? "followers" : "following"} yet.</p>`;
      return;
    }
    renderFollowUsers(users);
  } catch (error) {
    currentFollowListUsers = [];
    followList.innerHTML = `<p class='notice'>${error.message}</p>`;
  }
}

avatar.addEventListener("click", () => {
  dpModal.classList.remove("hidden");
});

avatarEditBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  profilePhotoInput.click();
});

profilePhotoInput.addEventListener("change", async () => {
  const file = profilePhotoInput.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("profile_photo", file);

  try {
    const updated = await App.api("/api/me/photo", {
      method: "POST",
      body: formData,
    });
    App.setAuth(App.getToken(), updated);
    await loadProfile();
  } catch (error) {
    alert(error.message);
  } finally {
    profilePhotoInput.value = "";
  }
});

dpModalClose.addEventListener("click", () => {
  dpModal.classList.add("hidden");
});

dpModal.querySelector(".dp-modal-backdrop").addEventListener("click", () => {
  dpModal.classList.add("hidden");
});

postViewClose.addEventListener("click", () => {
  postViewModal.classList.add("hidden");
});

postViewModal.querySelector(".post-view-backdrop").addEventListener("click", () => {
  postViewModal.classList.add("hidden");
});

followersStatBtn.addEventListener("click", () => {
  openFollowList("followers");
});

followingStatBtn.addEventListener("click", () => {
  openFollowList("following");
});

followListClose.addEventListener("click", () => {
  followListModal.classList.add("hidden");
});

followListModal.querySelector(".follow-list-backdrop").addEventListener("click", () => {
  followListModal.classList.add("hidden");
});

followListSearch?.addEventListener("input", () => {
  if (!currentFollowListUsers.length) {
    followList.innerHTML = `<p class='notice'>No users in your ${currentFollowListType} list yet.</p>`;
    return;
  }
  const filtered = filterFollowUsers(currentFollowListUsers, followListSearch.value);
  if (!normalizeFollowSearch(followListSearch.value)) {
    renderFollowUsers(currentFollowListUsers);
    return;
  }
  if (!filtered.length) {
    followList.innerHTML = `<p class='notice'>No users matched in your ${currentFollowListType} list.</p>`;
    return;
  }
  renderFollowUsers(filtered);
});

loadProfile().catch(() => {
  App.clearAuth();
  window.location.href = "/create-profile";
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    loadProfile().catch(() => {});
  }
});

function openBioModal() {
  if (!bioModal || !bioModalInput) return;
  const currentBio = bioEl.dataset.rawBio || "";
  bioModalInput.value = currentBio;
  bioModal.classList.remove("hidden");
  requestAnimationFrame(() => {
    bioModalInput.focus();
    bioModalInput.setSelectionRange(bioModalInput.value.length, bioModalInput.value.length);
  });
}

function closeBioModal() {
  if (!bioModal) return;
  bioModal.classList.add("hidden");
}

bioEditTrigger?.addEventListener("click", openBioModal);
bioModalCancel?.addEventListener("click", closeBioModal);
bioModal?.querySelector(".bio-modal-backdrop")?.addEventListener("click", closeBioModal);

bioModalDone?.addEventListener("click", async () => {
  if (!bioModalInput) return;
  try {
    const form = new URLSearchParams({ bio: bioModalInput.value });
    const updated = await App.api("/api/me/bio", { method: "POST", body: form });
    App.setAuth(App.getToken(), updated);
    App.renderRichBio(bioEl, updated.bio, "No bio yet.");
    bioEl.dataset.rawBio = typeof updated.bio === "string" ? updated.bio : "";
    closeBioModal();
  } catch (error) {
    alert(error.message);
  }
});
