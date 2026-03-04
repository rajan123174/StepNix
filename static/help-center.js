const topicButtons = Array.from(document.querySelectorAll(".help-topic-btn"));
const topicTitle = document.getElementById("help-topic-title");
const topicHint = document.getElementById("help-topic-hint");
const helpForm = document.getElementById("help-center-form");
const messageInput = document.getElementById("help-message-input");
const submitBtn = document.getElementById("help-submit-btn");
const statusEl = document.getElementById("help-status");

if (!App.requireAuth()) {
  // redirected
}

const TOPIC_META = {
  bug: {
    title: "Report a bug",
    hint: "Describe the issue clearly with steps to reproduce.",
  },
  feedback: {
    title: "Feedback",
    hint: "Share what you like or what should be improved.",
  },
  question: {
    title: "Ask a question",
    hint: "Ask anything about features, account, or usage.",
  },
  idea: {
    title: "Give an idea to improve",
    hint: "Suggest ideas that can make StepNix better.",
  },
};

let activeTopic = "bug";

function setStatus(text, tone = "neutral") {
  if (!statusEl) return;
  statusEl.textContent = text || "";
  statusEl.classList.remove("status-success", "status-error");
  if (tone === "success") statusEl.classList.add("status-success");
  if (tone === "error") statusEl.classList.add("status-error");
}

function syncTopicUi() {
  const meta = TOPIC_META[activeTopic] || TOPIC_META.bug;
  if (topicTitle) topicTitle.textContent = meta.title;
  if (topicHint) topicHint.textContent = meta.hint;
  topicButtons.forEach((button) => {
    const topic = button.getAttribute("data-help-topic") || "";
    button.classList.toggle("is-active", topic === activeTopic);
  });
}

topicButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextTopic = (button.getAttribute("data-help-topic") || "").trim().toLowerCase();
    if (!TOPIC_META[nextTopic]) return;
    activeTopic = nextTopic;
    syncTopicUi();
    setStatus("");
    messageInput?.focus();
  });
});

helpForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = String(messageInput?.value || "").trim();
  if (message.length < 8) {
    setStatus("Please enter at least 8 characters.", "error");
    return;
  }
  if (!submitBtn) return;
  submitBtn.disabled = true;
  setStatus("Sending...");
  try {
    const body = new URLSearchParams({
      topic: activeTopic,
      message,
    });
    const result = await App.api("/api/help-center/submit", {
      method: "POST",
      body,
    });
    setStatus(result?.detail || "Message sent.", "success");
    if (messageInput) messageInput.value = "";
  } catch (error) {
    setStatus(error.message || "Unable to send message.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

syncTopicUi();
