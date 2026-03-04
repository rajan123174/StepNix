(function initSharedPostPage() {
  const pathMatch = window.location.pathname.match(/\/post\/(\d+)/);
  const postId = pathMatch ? Number(pathMatch[1]) : 0;
  const message = document.getElementById("shared-post-message");
  const loginLink = document.getElementById("shared-login-link");
  const registerLink = document.getElementById("shared-register-link");

  if (!postId) {
    if (message) message.textContent = "Shared post link is invalid.";
    return;
  }

  const destination = `/community-feed?post_id=${postId}&shared=1`;
  const encoded = encodeURIComponent(destination);
  if (loginLink) loginLink.href = `/create-profile?mode=login&from=share&next=${encoded}`;
  if (registerLink) registerLink.href = `/create-profile?mode=register&from=share&next=${encoded}`;

  if (App.getToken()) {
    window.location.replace(destination);
    return;
  }

  if (message) {
    message.textContent = "Login to view this shared post. New users, please register first.";
  }
})();
