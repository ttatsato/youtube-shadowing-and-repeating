// =====================
// ログヘルパー
// =====================

const LOG = "[YT Shadowing]";
function log(...args) {
  console.log(LOG, ...args);
}
function warn(...args) {
  console.warn(LOG, ...args);
}

log("content.js loaded", location.href);

// =====================
// Injected Script → Content Script 通信
// =====================

function injectScript() {
  const old = document.getElementById('yt-shadowing-injected');
  if (old) old.remove();

  const script = document.createElement('script');
  script.id = 'yt-shadowing-injected';
  script.setAttribute('type', 'text/javascript');
  script.setAttribute('src', chrome.runtime.getURL('injected-script.js') + '?t=' + Date.now());
  (document.body || document.documentElement).appendChild(script);
  log("injected script inserted");
}

// injected script から字幕データを受け取る
let captionResult = null; // { phrases, trackLang, availableTracks } or null

window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'YOUTUBE_CAPTIONS_RESULT') {
    log('Received captions result:', event.data.phrases ? event.data.phrases.length + ' phrases' : event.data.error);
    captionResult = event.data;
  }
});

// =====================
// 字幕取得（injected scriptの結果を待つ）
// =====================

async function waitForCaptions() {
  let attempts = 0;
  const maxAttempts = 150; // 15 seconds max
  while (captionResult === null && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  if (!captionResult || !captionResult.phrases || captionResult.phrases.length === 0) {
    warn("No captions received:", captionResult ? captionResult.error : 'timeout');
    return null;
  }
  return captionResult.phrases;
}

// =====================
// <video>要素取得
// =====================

function getVideo() {
  return document.querySelector("video.html5-main-video") ||
    document.querySelector("video");
}

// =====================
// UI構築
// =====================

function buildPanel(phrases, statusMessage) {
  const existing = document.getElementById("yt-shadowing-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "yt-shadowing-panel";

  panel.innerHTML = `
    <div id="yts-header">
      <span>🎤 YT Shadowing</span>
      <button id="yts-close" title="閉じる">✕</button>
    </div>
    <div id="yts-status"></div>
    <div id="yts-phrase-list"></div>
    <div id="yts-controls">
      <div id="yts-current-phrase">フレーズを選択してください</div>
      <div id="yts-buttons">
        <button id="yts-replay">▶ 再生</button>
        <button id="yts-record">⏺ 録音</button>
        <button id="yts-play-rec" disabled>🔊 録音再生</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  log("panel appended");

  document.getElementById("yts-close").onclick = () => panel.remove();

  const statusEl = document.getElementById("yts-status");
  if (statusMessage) {
    statusEl.textContent = statusMessage;
    statusEl.style.display = "block";
  }

  const list = document.getElementById("yts-phrase-list");
  phrases.forEach((phrase, i) => {
    const item = document.createElement("div");
    item.className = "yts-phrase-item";
    item.dataset.index = i;
    item.innerHTML = `
      <span class="yts-time"></span>
      <span class="yts-text"></span>
    `;
    item.querySelector(".yts-time").textContent = formatTime(phrase.start);
    item.querySelector(".yts-text").textContent = phrase.text;
    item.onclick = () => selectPhrase(i, phrases, item);
    list.appendChild(item);
  });

  document.getElementById("yts-replay").onclick = () => {
    if (currentPhrase) playPhrase(currentPhrase);
  };
}

// =====================
// フレーズ再生
// =====================

let currentPhrase = null;
let currentPhraseIndex = null;
let phraseTimer = null;

function selectPhrase(index, phrases, itemEl) {
  document.querySelectorAll(".yts-phrase-item").forEach(el =>
    el.classList.remove("active")
  );
  itemEl.classList.add("active");

  currentPhrase = phrases[index];
  currentPhraseIndex = index;
  document.getElementById("yts-current-phrase").textContent =
    currentPhrase.text;

  // 録音再生ボタンの状態を更新
  if (typeof updatePlayRecBtn === "function") {
    updatePlayRecBtn();
  }

  playPhrase(currentPhrase);
}

function playPhrase(phrase) {
  const video = getVideo();
  if (!video) {
    warn("video要素が見つかりません");
    return;
  }

  clearTimeout(phraseTimer);
  video.currentTime = phrase.start;
  const p = video.play();
  if (p && typeof p.catch === "function") {
    p.catch(err => warn("play failed:", err));
  }

  phraseTimer = setTimeout(() => {
    video.pause();
  }, Math.max(phrase.duration, 0.5) * 1000);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// =====================
// 初期化
// =====================

let initInProgress = false;

async function init() {
  if (initInProgress) {
    log("init already in progress, skipping");
    return;
  }
  initInProgress = true;

  log("init called");
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get("v");
  if (!videoId) {
    log("no video id");
    initInProgress = false;
    return;
  }
  log("videoId:", videoId);

  // Reset for new video
  captionResult = null;

  // Inject script to fetch captions in page context
  injectScript();

  // Show loading
  buildPanel([], "字幕を取得中…");

  let phrases = null;
  try {
    phrases = await waitForCaptions();
  } catch (e) {
    warn("waitForCaptions exception:", e);
  }

  if (!phrases || phrases.length === 0) {
    buildPanel([], "この動画には字幕が見つかりませんでした");
    initInProgress = false;
    return;
  }

  log("phrases loaded:", phrases.length);
  buildPanel(phrases);
  if (typeof initRecorder === "function") {
    initRecorder();
  } else {
    warn("initRecorder is not defined");
  }

  initInProgress = false;
}

// =====================
// ページ遷移対応（YouTubeはSPA）
// =====================

let lastVideoId = "";

function checkUrl() {
  if (!location.href.includes("/watch")) return;
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get("v");
  if (videoId && videoId !== lastVideoId) {
    lastVideoId = videoId;
    setTimeout(init, 1500);
  }
}

const observer = new MutationObserver(checkUrl);
observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
});

window.addEventListener('yt-navigate-finish', () => {
  log("yt-navigate-finish event");
  checkUrl();
});

// 初回実行
if (location.href.includes("/watch")) {
  const urlParams = new URLSearchParams(window.location.search);
  lastVideoId = urlParams.get("v") || "";
  setTimeout(init, 1500);
}
