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
// 字幕取得
// =====================

function extractCaptionTracks(html) {
  // 1) 素直な形
  let m = html.match(/"captionTracks":(\[.*?\])/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (e) { warn("JSON parse失敗(1)", e); }
  }
  // 2) 念のためエスケープされた形
  m = html.match(/\\"captionTracks\\":(\[.*?\])/);
  if (m) {
    try {
      const unescaped = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return JSON.parse(unescaped);
    } catch (e) { warn("JSON parse失敗(2)", e); }
  }
  return null;
}

async function fetchCaptions(videoId) {
  // まず現在ページのHTMLから取得を試みる（fetch不要・確実）
  let tracks = extractCaptionTracks(document.documentElement.outerHTML);

  // ダメなら改めてページをfetch
  if (!tracks) {
    log("DOMにcaptionTracks無し。fetchで取得を試行");
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      const html = await res.text();
      tracks = extractCaptionTracks(html);
    } catch (e) {
      warn("ページfetch失敗", e);
    }
  }

  if (!tracks || tracks.length === 0) {
    warn("captionTracks見つからず");
    return null;
  }
  log("captionTracks:", tracks.map((t) => t.languageCode));

  const track = tracks.find((t) => t.languageCode === "en") || tracks[0];
  if (!track || !track.baseUrl) return null;

  try {
    const xmlRes = await fetch(track.baseUrl + "&fmt=json3");
    const data = await xmlRes.json();
    return data.events
      .filter((e) => e.segs)
      .map((e) => ({
        start: e.tStartMs / 1000,
        duration: (e.dDurationMs || 0) / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim(),
      }))
      .filter((e) => e.text);
  } catch (e) {
    warn("字幕本体fetch失敗", e);
    return null;
  }
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
let phraseTimer = null;

function selectPhrase(index, phrases, itemEl) {
  document.querySelectorAll(".yts-phrase-item").forEach((el) =>
    el.classList.remove("active")
  );
  itemEl.classList.add("active");

  currentPhrase = phrases[index];
  document.getElementById("yts-current-phrase").textContent =
    currentPhrase.text;

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
    p.catch((err) => warn("play失敗", err));
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

async function init() {
  log("init called");
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get("v");
  if (!videoId) {
    log("video id無し");
    return;
  }
  log("videoId:", videoId);

  // まずパネルを出す（ローディング状態）
  buildPanel([], "字幕を取得中…");

  let phrases = null;
  try {
    phrases = await fetchCaptions(videoId);
  } catch (e) {
    warn("fetchCaptions例外", e);
  }

  if (!phrases || phrases.length === 0) {
    buildPanel([], "この動画には字幕が見つかりませんでした");
    return;
  }

  log("phrases取得:", phrases.length);
  buildPanel(phrases);
  if (typeof initRecorder === "function") {
    initRecorder();
  } else {
    warn("initRecorderが未定義");
  }
}

// ページ遷移対応（YouTubeはSPA）
let lastUrl = "";
function checkUrl() {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl && currentUrl.includes("/watch")) {
    lastUrl = currentUrl;
    setTimeout(init, 1500);
  }
}

const observer = new MutationObserver(checkUrl);
observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
});

// 初回実行
if (location.href.includes("/watch")) {
  lastUrl = location.href;
  setTimeout(init, 1500);
}
