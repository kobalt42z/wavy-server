// Wiring for the test page. The reusable part is wavy-player.js; this file is
// only the page around it (form, custom seek bar, info panel, error message).
import Hls from "https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.mjs";
import { WavyPlayer, describeError, formatTime, MODE_LABELS } from "./wavy-player.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const form = $("open-form");
const pathInput = $("path");
const startInput = $("start");
const stopBtn = $("stop-btn");
const message = $("message");
const playerPanel = $("player-panel");
const infoPanel = $("info-panel");
const info = $("info");
const stage = $("stage");
const overlay = $("overlay");
const toggleBtn = $("toggle-btn");
const muteBtn = $("mute-btn");
const fullscreenBtn = $("fullscreen-btn");
const seek = $("seek");
const timeCurrent = $("time-current");
const timeTotal = $("time-total");

// Optional ?api=https://host to talk to a service on another origin (needs CORS there).
const params = new URLSearchParams(location.search);
const player = new WavyPlayer(video, { Hls, apiBase: params.get("api") ?? "" });
let dragging = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  open(pathInput.value.trim(), Number(startInput.value) || 0);
});

stopBtn.addEventListener("click", async () => {
  await player.stop();
  playerPanel.hidden = true;
  stopBtn.disabled = true;
});

toggleBtn.addEventListener("click", () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});
muteBtn.addEventListener("click", () => {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? "Unmute" : "Mute";
});
fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
});

seek.addEventListener("input", () => {
  dragging = true;
  timeCurrent.textContent = formatTime(Number(seek.value));
});
seek.addEventListener("change", async () => {
  dragging = false;
  try {
    await player.seek(Number(seek.value));
  } catch (err) {
    showError(err);
  }
});

video.addEventListener("play", () => (toggleBtn.textContent = "Pause"));
video.addEventListener("pause", () => (toggleBtn.textContent = "Play"));
video.addEventListener("waiting", () => showOverlay("Loading…"));
video.addEventListener("playing", () => showOverlay(null));
video.addEventListener("seeked", () => showOverlay(null));
for (const type of ["timeupdate", "progress", "durationchange", "loadedmetadata"]) {
  video.addEventListener(type, renderTime);
}

player.addEventListener("statechange", (event) => {
  const { state } = event.detail;
  if (state === "probing") showOverlay("Checking the file…");
  else if (state === "starting") showOverlay("Starting playback…");
  else if (state === "seeking") showOverlay("Restarting at the new position…");
  else if (state === "error" || state === "idle") showOverlay(null);
});

player.addEventListener("session", (event) => {
  const { probe, mode } = event.detail;
  renderInfo(probe, mode);
  const hasVideo = Boolean(probe?.video && (probe.video.codec || probe.video.width));
  stage.classList.toggle("audio", !hasVideo);
  renderTime();
});

// Fatal errors after playback started (for example hls.js gave up on the stream).
player.addEventListener("error", (event) => showError(event.detail));

async function open(path, start) {
  if (!path) return;
  hideError();
  infoPanel.hidden = true;
  playerPanel.hidden = false;
  stopBtn.disabled = false;
  const url = new URL(location.href);
  url.searchParams.set("path", path);
  history.replaceState(null, "", url);

  try {
    await player.load(path, { start });
  } catch (err) {
    playerPanel.hidden = true;
    stopBtn.disabled = true;
    if (player.probeResult) renderInfo(player.probeResult, player.probeResult.mode);
    showError(err);
  }
}

function renderTime() {
  const duration = player.duration;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  seek.max = hasDuration ? String(duration) : "0";
  seek.disabled = !hasDuration;
  timeTotal.textContent = formatTime(duration);
  if (!dragging) {
    seek.value = String(player.currentTime);
    timeCurrent.textContent = formatTime(player.currentTime);
  }
  // Show which part is ready to play without a server restart.
  const from = hasDuration ? (player.offset / duration) * 100 : 0;
  const to = hasDuration ? (Math.min(player.availableEnd, duration) / duration) * 100 : 0;
  seek.style.background =
    `linear-gradient(to right, var(--track) ${from}%, var(--avail) ${from}%, ` +
    `var(--avail) ${to}%, var(--track) ${to}%)`;
}

function renderInfo(probe, mode) {
  if (!probe) return;
  const rows = [];
  rows.push(["Mode", `<span class="badge">${esc(MODE_LABELS[mode] ?? mode ?? "?")}</span>`]);
  if (probe.reason) rows.push(["Why", esc(probe.reason)]);
  if (probe.container) rows.push(["Container", esc(probe.container)]);
  if (Number.isFinite(Number(probe.duration))) rows.push(["Duration", esc(formatTime(Number(probe.duration)))]);
  const v = probe.video;
  if (v && (v.codec || v.width)) {
    const size = v.width && v.height ? ` ${v.width}×${v.height}` : "";
    const fps = v.fps ? ` @ ${Math.round(Number(v.fps) * 100) / 100} fps` : "";
    rows.push(["Video", esc(`${v.codec ?? "?"}${size}${fps}`)]);
  }
  const audio = Array.isArray(probe.audio) ? probe.audio : [];
  audio.forEach((a, i) => {
    const ch = a.channels ? `, ${a.channels} ch` : "";
    const lang = a.lang ? `, ${a.lang}` : "";
    rows.push([audio.length > 1 ? `Audio ${i + 1}` : "Audio", esc(`${a.codec ?? "?"}${ch}${lang}`)]);
  });
  if (Array.isArray(probe.subtitles) && probe.subtitles.length) {
    rows.push(["Subtitles", esc(String(probe.subtitles.length))]);
  }
  info.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
  infoPanel.hidden = false;
}

function showError(err) {
  const title = err?.code === "unsupported" ? "This file can't be played" : "Playback problem";
  message.innerHTML = `<strong>${esc(title)}</strong>${esc(describeError(err))}`;
  message.hidden = false;
}

function hideError() {
  message.hidden = true;
  message.textContent = "";
}

function showOverlay(text) {
  overlay.hidden = !text;
  overlay.textContent = text ?? "";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const initialPath = params.get("path");
if (initialPath) {
  pathInput.value = initialPath;
  open(initialPath, Number(params.get("start")) || 0);
}
