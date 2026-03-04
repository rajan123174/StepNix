const feedRoot = document.getElementById("public-profile-feed");
const titleEl = document.getElementById("public-profile-title");
const avatarEl = document.getElementById("public-profile-avatar");
const nameEl = document.getElementById("public-profile-name");
const usernameEl = document.getElementById("public-profile-username");
const bioEl = document.getElementById("public-profile-bio");
const postCountEl = document.getElementById("public-post-count");
const followerCountEl = document.getElementById("public-follower-count");
const followingCountEl = document.getElementById("public-following-count");
const followersStatBtn = document.getElementById("public-followers-stat-btn");
const followingStatBtn = document.getElementById("public-following-stat-btn");
const followBtn = document.getElementById("public-follow-btn");
const messageBtn = document.getElementById("public-message-btn");
const dpModal = document.getElementById("public-dp-modal");
const dpModalImage = document.getElementById("public-dp-modal-image");
const dpModalClose = document.getElementById("public-dp-modal-close");
const followListModal = document.getElementById("public-follow-list-modal");
const followListTitle = document.getElementById("public-follow-list-title");
const followList = document.getElementById("public-follow-list");
const followListSearch = document.getElementById("public-follow-list-search");
const followListClose = document.getElementById("public-follow-list-close");
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

if (!App.requireAuth()) {
  // redirected
}

function getUserIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const maybe = Number(parts[parts.length - 1]);
  return Number.isFinite(maybe) ? maybe : 0;
}

const targetUserId = getUserIdFromPath();

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
    const users = await App.api(isFollowers ? `/api/users/${targetUserId}/followers` : `/api/users/${targetUserId}/following`);
    currentFollowListUsers = users;
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

async function loadUserProfile() {
  if (!targetUserId) {
    throw new Error("Invalid user id");
  }
  const data = await App.api(`/api/users/${targetUserId}/profile`);
  const me = App.getAuthUser();

  titleEl.textContent = `@${data.user.username}`;
  avatarEl.src = data.user.profile_photo_url || "/static/default-avatar.svg";
  dpModalImage.src = avatarEl.src;
  nameEl.textContent = data.user.full_name;
  usernameEl.textContent = `@${data.user.username}`;
  App.renderRichBio(bioEl, data.user.bio, "No bio yet.");
  postCountEl.textContent = String(data.user.post_count || 0);
  followerCountEl.textContent = String(data.user.follower_count || 0);
  followingCountEl.textContent = String(data.user.following_count || 0);

  const isSelf = me && me.id === data.user.id;
  if (isSelf) {
    followBtn.classList.add("hidden");
    messageBtn.classList.add("hidden");
  } else {
    followBtn.classList.remove("hidden");
    messageBtn.classList.remove("hidden");
    followBtn.textContent = data.user.is_following ? "Following" : "Follow";
    followBtn.classList.toggle("is-following", !!data.user.is_following);
    messageBtn.onclick = () => {
      window.location.href = `/chats?open_user_id=${data.user.id}`;
    };
    followBtn.onclick = async () => {
      try {
        let becameFollowing = false;
        if (data.user.is_following) {
          await App.api(`/api/users/${data.user.id}/follow`, { method: "DELETE" });
        } else {
          await App.api(`/api/users/${data.user.id}/follow`, { method: "POST" });
          becameFollowing = true;
        }
        if (becameFollowing && window.App && typeof window.App.playActionBurst === "function") {
          window.App.playActionBurst(followBtn, "✓");
        }
        try {
          const refreshedMe = await App.api("/api/auth/me");
          App.setAuth(App.getToken(), refreshedMe);
        } catch {
          // ignore
        }
        await loadUserProfile();
      } catch (error) {
        alert(error.message);
      }
    };
  }

  feedRoot.innerHTML = "";
  if (!data.posts.length) {
    feedRoot.innerHTML = "<p class='notice'>No posts yet.</p>";
    return;
  }

  data.posts.forEach((post) => {
    feedRoot.appendChild(createPostCard(post, loadUserProfile));
  });
}

loadUserProfile().catch((error) => {
  titleEl.textContent = "Profile";
  avatarEl.src = "/static/default-avatar.svg";
  dpModalImage.src = avatarEl.src;
  nameEl.textContent = "Profile unavailable";
  usernameEl.textContent = "";
  bioEl.textContent = error?.message || "This profile is not available right now.";
  postCountEl.textContent = "0";
  followerCountEl.textContent = "0";
  followingCountEl.textContent = "0";
  followBtn.classList.add("hidden");
  messageBtn.classList.add("hidden");
  feedRoot.innerHTML = "<p class='notice'>No posts available.</p>";
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
    followList.innerHTML = `<p class='notice'>No users in this ${currentFollowListType} list yet.</p>`;
    return;
  }
  const filtered = filterFollowUsers(currentFollowListUsers, followListSearch.value);
  if (!normalizeFollowSearch(followListSearch.value)) {
    renderFollowUsers(currentFollowListUsers);
    return;
  }
  if (!filtered.length) {
    followList.innerHTML = `<p class='notice'>No users matched in this ${currentFollowListType} list.</p>`;
    return;
  }
  renderFollowUsers(filtered);
});

avatarEl.addEventListener("click", () => {
  dpModal.classList.remove("hidden");
});

dpModalClose.addEventListener("click", () => {
  dpModal.classList.add("hidden");
});

dpModal.querySelector(".dp-modal-backdrop").addEventListener("click", () => {
  dpModal.classList.add("hidden");
});
