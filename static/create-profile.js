const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");
const statusEl = document.getElementById("auth-status");

const registerBox = document.getElementById("register-box");
const loginBox = document.getElementById("login-box");
const showRegisterBtn = document.getElementById("show-register");
const showLoginBtn = document.getElementById("show-login");
const sendRegisterOtpBtn = document.getElementById("send-register-otp-btn");
const registerOtpStatus = document.getElementById("register-otp-status");
const registerEmailInput = document.getElementById("r-email");
const registerEmailOtpInput = document.getElementById("r-email-otp");

const forgotToggle = document.getElementById("forgot-toggle");
const forgotBox = document.getElementById("forgot-box");
const forgotEmailForm = document.getElementById("forgot-email-form");
const forgotOtpForm = document.getElementById("forgot-otp-form");
const forgotResetForm = document.getElementById("forgot-reset-form");

const fpEmail = document.getElementById("fp-email");
const sendOtpBtn = document.getElementById("send-otp-btn");
const fpOtp = document.getElementById("fp-otp");
const resendOtpBtn = document.getElementById("resend-otp-btn");
const fpNewPassword = document.getElementById("fp-new-password");
const fpResetBtn = document.getElementById("fp-reset-btn");

let otpVerified = false;
let recoveryEmail = "";
let resendSeconds = 30;
let resendTimer = null;
let otpVerifyInProgress = false;
let registerOtpVerifyInProgress = false;
let registerOtpVerifiedEmail = "";
const searchParams = new URLSearchParams(window.location.search);

function getSafeNextPath() {
  const raw = searchParams.get("next") || "/community-feed";
  if (!raw.startsWith("/")) return "/community-feed";
  return raw;
}

const nextPath = getSafeNextPath();

function setStatus(text) {
  statusEl.textContent = text;
}

function setRegisterOtpStatus(text) {
  if (registerOtpStatus) registerOtpStatus.textContent = text || "";
}

function showCurrent() {
  const user = App.getAuthUser();
  if (user) {
    setStatus(`Logged in as @${user.username}`);
  } else {
    setStatus("Not logged in");
  }
}

function showMode(mode) {
  const registerMode = mode === "register";
  registerBox.classList.toggle("hidden", !registerMode);
  loginBox.classList.toggle("hidden", registerMode);
  showRegisterBtn.classList.toggle("tab-plain", !registerMode);
  showLoginBtn.classList.toggle("tab-plain", registerMode);
  showLoginBtn.classList.remove("alt");
}

function toggleForgot(open) {
  forgotBox.classList.toggle("hidden", !open);
}

function setResetEnabled(enabled) {
  otpVerified = enabled;
  fpNewPassword.disabled = !enabled;
  if (!enabled) {
    fpResetBtn.disabled = true;
  }
}

function startResendCountdown() {
  resendSeconds = 30;
  resendOtpBtn.disabled = true;
  resendOtpBtn.textContent = `Resend OTP in ${resendSeconds}s`;

  if (resendTimer) clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    resendSeconds -= 1;
    if (resendSeconds <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
      resendOtpBtn.disabled = false;
      resendOtpBtn.textContent = "Resend OTP";
      return;
    }
    resendOtpBtn.textContent = `Resend OTP in ${resendSeconds}s`;
  }, 1000);
}

async function sendForgotOtp(email) {
  const cap = await App.api("/api/auth/forgot-password/captcha");
  const match = String(cap.question || "").match(/(\d+)\s*\+\s*(\d+)/);
  if (!match) {
    throw new Error("Captcha generation failed. Please retry.");
  }

  const answer = String(Number(match[1]) + Number(match[2]));
  const body = new URLSearchParams({
    email,
    captcha_token: cap.captcha_token,
    captcha_answer: answer,
  });
  return App.api("/api/auth/forgot-password", { method: "POST", body });
}

fpEmail.addEventListener("input", () => {
  sendOtpBtn.disabled = !fpEmail.value.trim();
});

sendRegisterOtpBtn?.addEventListener("click", async () => {
  const email = registerEmailInput?.value.trim().toLowerCase() || "";
  if (!email) {
    setRegisterOtpStatus("Enter email first.");
    return;
  }
  sendRegisterOtpBtn.disabled = true;
  const originalText = sendRegisterOtpBtn.textContent;
  sendRegisterOtpBtn.textContent = "Sending...";
  try {
    const body = new URLSearchParams({ email });
    const result = await App.api("/api/auth/register/send-otp", { method: "POST", body });
    const details = result?.dev_otp
      ? `${result.detail} OTP: ${result.dev_otp} Enter OTP for confirmation.`
      : `${result.detail || "Verification code sent."} Enter OTP for confirmation.`;
    setRegisterOtpStatus(details);
  } catch (error) {
    setRegisterOtpStatus(error.message);
  } finally {
    sendRegisterOtpBtn.disabled = false;
    sendRegisterOtpBtn.textContent = originalText || "Send Code";
  }
});

registerEmailInput?.addEventListener("input", () => {
  registerOtpVerifiedEmail = "";
});

async function verifyRegisterOtpIfReady() {
  const email = registerEmailInput?.value.trim().toLowerCase() || "";
  const otp = registerEmailOtpInput?.value.trim() || "";
  if (!/^\d{6}$/.test(otp) || !email || registerOtpVerifyInProgress) return;

  registerOtpVerifyInProgress = true;
  setRegisterOtpStatus("Verifying OTP...");
  try {
    const body = new URLSearchParams({ email, otp });
    const result = await App.api("/api/auth/register/verify-otp", { method: "POST", body });
    registerOtpVerifiedEmail = email;
    setRegisterOtpStatus(result.detail || "OTP verified. You can create account now.");
  } catch (error) {
    registerOtpVerifiedEmail = "";
    setRegisterOtpStatus(error.message);
  } finally {
    registerOtpVerifyInProgress = false;
  }
}

function normalizeRegisterOtpInput() {
  if (!registerEmailOtpInput) return;
  registerEmailOtpInput.value = registerEmailOtpInput.value.replace(/\D/g, "").slice(0, 6);
  registerOtpVerifiedEmail = "";
  verifyRegisterOtpIfReady();
}

registerEmailOtpInput?.addEventListener("input", normalizeRegisterOtpInput);
registerEmailOtpInput?.addEventListener("keyup", normalizeRegisterOtpInput);
registerEmailOtpInput?.addEventListener("change", normalizeRegisterOtpInput);
registerEmailOtpInput?.addEventListener("paste", () => {
  setTimeout(normalizeRegisterOtpInput, 0);
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const emailValue = registerEmailInput?.value.trim().toLowerCase() || "";
  const otpValue = registerEmailOtpInput?.value.trim() || "";
  if (!/^\d{6}$/.test(otpValue)) {
    setRegisterOtpStatus("Enter OTP for confirmation (6 digits).");
    return;
  }
  if (!emailValue || registerOtpVerifiedEmail !== emailValue) {
    setRegisterOtpStatus("Enter OTP and wait for verification confirmation.");
    return;
  }
  const formData = new FormData();
  formData.append("username", document.getElementById("r-username").value.trim());
  formData.append("email", emailValue);
  formData.append("email_otp", otpValue);
  formData.append("gender", document.getElementById("r-gender").value);
  formData.append("full_name", document.getElementById("r-full-name").value.trim());
  formData.append("bio", document.getElementById("r-bio").value.trim());
  formData.append("password", document.getElementById("r-password").value);

  try {
    const result = await App.api("/api/auth/register", { method: "POST", body: formData });
    App.setAuth(result.token, result.user);
    registerForm.reset();
    setRegisterOtpStatus("");
    showCurrent();
    window.location.href = nextPath;
  } catch (error) {
    setStatus(error.message);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await App.api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: document.getElementById("l-identifier").value.trim(),
        password: document.getElementById("l-password").value,
      }),
    });
    App.setAuth(result.token, result.user);
    loginForm.reset();
    showCurrent();
    window.location.href = nextPath;
  } catch (error) {
    setStatus(error.message);
  }
});

forgotToggle.addEventListener("click", () => {
  toggleForgot(forgotBox.classList.contains("hidden"));
});

forgotEmailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  recoveryEmail = fpEmail.value.trim().toLowerCase();
  if (!recoveryEmail) {
    setStatus("Enter registered email.");
    return;
  }

  sendOtpBtn.disabled = true;
  try {
    const result = await sendForgotOtp(recoveryEmail);
    setStatus(result.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result.detail || "OTP sent."));
    forgotEmailForm.classList.add("hidden");
    forgotOtpForm.classList.remove("hidden");
    forgotResetForm.classList.add("hidden");
    fpOtp.value = "";
    fpNewPassword.value = "";
    setResetEnabled(false);
    startResendCountdown();
  } catch (error) {
    setStatus(error.message);
    sendOtpBtn.disabled = false;
  }
});

resendOtpBtn.addEventListener("click", async () => {
  if (!recoveryEmail) return;
  resendOtpBtn.disabled = true;
  try {
    const result = await sendForgotOtp(recoveryEmail);
    setStatus(result.dev_otp ? `${result.detail} OTP: ${result.dev_otp}` : (result.detail || "OTP resent."));
    setResetEnabled(false);
    forgotOtpForm.classList.remove("hidden");
    forgotResetForm.classList.add("hidden");
    fpOtp.value = "";
    fpNewPassword.value = "";
    fpResetBtn.disabled = true;
    startResendCountdown();
  } catch (error) {
    setStatus(error.message);
    resendOtpBtn.disabled = false;
  }
});

async function verifyOtpIfReady() {
  const otp = fpOtp.value.trim();
  if (otp.length !== 6 || otpVerifyInProgress || otpVerified) return;
  if (!/^\d{6}$/.test(otp)) return;
  if (!recoveryEmail) {
    recoveryEmail = fpEmail.value.trim().toLowerCase();
  }
  if (!recoveryEmail) {
    setStatus("Enter registered email first.");
    return;
  }

  otpVerifyInProgress = true;
  setStatus("Verifying OTP...");
  try {
    const body = new URLSearchParams({ email: recoveryEmail, otp });
    const result = await App.api("/api/auth/verify-otp", { method: "POST", body });
    setResetEnabled(true);
    forgotOtpForm.classList.add("hidden");
    forgotResetForm.classList.remove("hidden");
    setStatus(result.detail || "OTP verified.");
    fpNewPassword.focus();
  } catch (error) {
    setResetEnabled(false);
    setStatus(error.message);
  } finally {
    otpVerifyInProgress = false;
  }
}

function normalizeOtpInput() {
  const onlyDigits = fpOtp.value.replace(/\D/g, "").slice(0, 6);
  fpOtp.value = onlyDigits;
  if (onlyDigits.length < 6) {
    otpVerified = false;
  }
  verifyOtpIfReady();
}

fpOtp.addEventListener("input", normalizeOtpInput);
fpOtp.addEventListener("keyup", normalizeOtpInput);
fpOtp.addEventListener("change", normalizeOtpInput);
fpOtp.addEventListener("paste", () => {
  setTimeout(normalizeOtpInput, 0);
});

fpNewPassword.addEventListener("input", () => {
  if (!otpVerified) {
    fpResetBtn.disabled = true;
    return;
  }
  fpResetBtn.disabled = fpNewPassword.value.length < 6;
});

forgotResetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!otpVerified) {
    setStatus("Verify OTP first.");
    return;
  }

  try {
    const body = new URLSearchParams({
      email: recoveryEmail,
      new_password: fpNewPassword.value,
    });
    const result = await App.api("/api/auth/reset-password", { method: "POST", body });
    setStatus(result.detail || "Password reset successful. Please login.");

    // Reset recovery section back to first step.
    forgotEmailForm.classList.remove("hidden");
    forgotOtpForm.classList.add("hidden");
    forgotResetForm.classList.add("hidden");
    fpEmail.value = "";
    fpOtp.value = "";
    fpNewPassword.value = "";
    sendOtpBtn.disabled = true;
    setResetEnabled(false);
    if (resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = "Resend OTP in 30s";
  } catch (error) {
    setStatus(error.message);
  }
});

showRegisterBtn.addEventListener("click", () => showMode("register"));
showLoginBtn.addEventListener("click", () => showMode("login"));

setResetEnabled(false);
const requestedMode = searchParams.get("mode");
if (requestedMode === "login" || requestedMode === "register") {
  showMode(requestedMode);
} else {
  showMode("login");
}
showCurrent();
if (searchParams.get("from") === "share") {
  setStatus("Login to view this shared post. New here? Register first.");
}
