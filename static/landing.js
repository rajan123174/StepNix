const bgGrid = document.getElementById("bg-grid");

const screenshotGallery = [
  "/static/uploads/landing1.png",
  "/static/uploads/landing2.png",
  "/static/uploads/landing3.png",
  "/static/uploads/landing4.png",
  "/static/uploads/landing5.png",
  "/static/uploads/landing6.png",
];

const runtimeGallery = [
  ...screenshotGallery,
  ...screenshotGallery,
  ...screenshotGallery,
];

function buildLandingGrid(gallery) {
  if (!bgGrid) return;

  const columns = window.matchMedia("(max-width: 720px)").matches ? 3 : window.matchMedia("(max-width: 980px)").matches ? 4 : 5;
  const perColumn = 8;
  bgGrid.innerHTML = "";

  for (let col = 0; col < columns; col += 1) {
    const colEl = document.createElement("div");
    colEl.className = `bg-col ${col % 2 ? "reverse" : ""}`;

    const track = document.createElement("div");
    track.className = "bg-track";
    track.style.animationDuration = `${34 + (col * 3)}s`;

    const picks = [];
    for (let i = 0; i < perColumn; i += 1) {
      const index = (col * 3 + i * 2) % gallery.length;
      picks.push(gallery[index]);
    }

    const doubled = picks.concat(picks);
    doubled.forEach((src) => {
      const card = document.createElement("div");
      card.className = "bg-card";
      const img = document.createElement("img");
      img.src = src;
      img.alt = "Motivation";
      img.loading = "lazy";
      card.appendChild(img);
      track.appendChild(card);
    });

    colEl.appendChild(track);
    bgGrid.appendChild(colEl);
  }
}

buildLandingGrid(runtimeGallery);
window.addEventListener("resize", () => {
  clearTimeout(window.__landingResizeTimer);
  window.__landingResizeTimer = setTimeout(() => buildLandingGrid(runtimeGallery), 180);
});
