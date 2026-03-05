(() => {
  const host = window.location.hostname;
  const isProd = host === "stepnix.in" || host === "www.stepnix.in" || host.endsWith(".vercel.app");

  window.APP_CONFIG = {
    API_BASE_URL: isProd ? "https://api.stepnix.in" : "",
    WS_BASE_URL: isProd ? "wss://api.stepnix.in" : ""
  };
})();
