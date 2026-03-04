const userForm = document.getElementById("user-form");
const postForm = document.getElementById("post-form");
const postUserSelect = document.getElementById("post-user");
const feedUserSelect = document.getElementById("feed-user");
const feedRoot = document.getElementById("feed");
const postTemplate = document.getElementById("post-template");

let users = [];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(error.detail || "Request failed");
  }
  return response.json();
}

function mentionMarkup(text) {
  return text.replace(/@([a-zA-Z0-9_]{3,40})/g, '<strong>@$1</strong>');
}

function fillUserSelects() {
  const options = users
    .map((u) => `<option value="${u.id}">@${u.username} (${u.full_name})</option>`)
    .join("");

  postUserSelect.innerHTML = `<option value="" disabled selected>Select author</option>${options}`;
  feedUserSelect.innerHTML = `<option value="">All users</option>${options}`;
}

async function loadUsers() {
  users = await api("/api/users");
  fillUserSelects();
}

function renderComments(container, comments) {
  container.innerHTML = "";
  if (!comments.length) {
    container.innerHTML = `<small>No comments yet. Start the conversation.</small>`;
    return;
  }

  comments.forEach((comment) => {
    const item = document.createElement("div");
    item.className = "comment-item";
    item.innerHTML = `
      <small>@${comment.author.username}</small>
      <div>${mentionMarkup(comment.content)}</div>
    `;
    container.appendChild(item);
  });
}

async function loadComments(postId, container) {
  const comments = await api(`/api/posts/${postId}/comments`);
  renderComments(container, comments);
}

function buildPostCard(post) {
  const node = postTemplate.content.firstElementChild.cloneNode(true);
  const meta = node.querySelector(".post-meta");
  const goal = node.querySelector(".post-goal");
  const caption = node.querySelector(".post-caption");
  const imageWrap = node.querySelector(".post-images");
  const likeBtn = node.querySelector(".like-btn");
  const likeCount = node.querySelector(".like-count");
  const commentToggle = node.querySelector(".comment-toggle");
  const commentsBox = node.querySelector(".comments");
  const commentList = node.querySelector(".comment-list");
  const commentForm = node.querySelector(".comment-form");
  const commentUser = node.querySelector(".comment-user");
  const commentInput = node.querySelector(".comment-input");

  const date = new Date(post.created_at).toLocaleString();
  meta.textContent = `@${post.author.username} • ${date}`;
  goal.textContent = post.goal_title;
  caption.textContent = post.caption;
  likeCount.textContent = `${post.like_count} likes • ${post.comment_count} comments`;

  if (post.screenshots.length) {
    post.screenshots.forEach((src) => {
      const image = document.createElement("img");
      image.src = src;
      image.alt = "Progress screenshot";
      imageWrap.appendChild(image);
    });
  } else {
    imageWrap.innerHTML = "<small>No screenshot uploaded for this update.</small>";
  }

  commentUser.innerHTML = `<option value="" disabled selected>Comment as</option>${users
    .map((u) => `<option value="${u.id}">@${u.username}</option>`)
    .join("")}`;

  likeBtn.addEventListener("click", async () => {
    const likerId = postUserSelect.value || users[0]?.id;
    if (!likerId) {
      alert("Create a user first.");
      return;
    }

    try {
      const result = await api(`/api/posts/${post.id}/likes`, {
        method: "POST",
        body: new URLSearchParams({ user_id: likerId }),
      });
      post.like_count = result.like_count;
      likeCount.textContent = `${post.like_count} likes • ${post.comment_count} comments`;
    } catch (error) {
      alert(error.message);
    }
  });

  commentToggle.addEventListener("click", async () => {
    commentsBox.classList.toggle("hidden");
    if (!commentsBox.classList.contains("hidden")) {
      await loadComments(post.id, commentList);
    }
  });

  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!commentUser.value) {
      alert("Select a user for comment.");
      return;
    }

    try {
      await api(`/api/posts/${post.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author_id: Number(commentUser.value), content: commentInput.value }),
      });
      commentInput.value = "";
      post.comment_count += 1;
      likeCount.textContent = `${post.like_count} likes • ${post.comment_count} comments`;
      await loadComments(post.id, commentList);
    } catch (error) {
      alert(error.message);
    }
  });

  return node;
}

async function loadFeed() {
  const selectedUser = feedUserSelect.value;
  const data = selectedUser ? await api(`/api/users/${selectedUser}/posts`) : await api("/api/feed");

  feedRoot.innerHTML = "";
  if (!data.posts.length) {
    feedRoot.innerHTML = "<p>No progress posts yet.</p>";
    return;
  }

  data.posts.forEach((post) => feedRoot.appendChild(buildPostCard(post)));
}

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.getElementById("username").value.trim();
  const fullName = document.getElementById("full-name").value.trim();
  const bio = document.getElementById("bio").value.trim();

  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, full_name: fullName, bio }),
    });
    userForm.reset();
    await loadUsers();
    await loadFeed();
  } catch (error) {
    alert(error.message);
  }
});

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData();
  formData.append("author_id", postUserSelect.value);
  formData.append("goal_title", document.getElementById("goal-title").value.trim());
  formData.append("caption", document.getElementById("caption").value.trim());

  const files = document.getElementById("screenshots").files;
  for (const file of files) {
    formData.append("screenshots", file);
  }

  try {
    await api("/api/posts", { method: "POST", body: formData });
    postForm.reset();
    await loadFeed();
  } catch (error) {
    alert(error.message);
  }
});

feedUserSelect.addEventListener("change", loadFeed);

(async function init() {
  try {
    await loadUsers();
    await loadFeed();
  } catch (error) {
    feedRoot.innerHTML = `<p>${error.message}. Start backend and PostgreSQL, then refresh.</p>`;
  }
})();
