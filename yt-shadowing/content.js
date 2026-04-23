// =====================
// 字幕取得
// =====================

async function fetchCaptions(videoId) {
  // YouTubeのページHTMLからtimedtext URLを取得
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  const html = await res.text();

  // captionTracksのJSONを抽出
  const match = html.match(/"captionTracks":(\[.*?\])/);
  if (!match) return null;

  const tracks = JSON.parse(match[1]);

  // 英語字幕を優先、なければ最初のトラック
  const track =
    tracks.find((t) => t.languageCode === "en") || tracks[0];
  if (!track) return null;

  const xmlRes = await fetch(track.baseUrl + "&fmt=json3");
  const data = await xmlRes.json();

  // フレーズ配列に変換
  return data.events
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      duration: e.dDurationMs / 1000,
      end: (e.tStartMs + e.dDurationMs) / 1000,
      text: e.segs.map((s) => s.utf8).join("").replace(/\n/g, " ").trim(),
    }))
    .filter((e) => e.text);
}

// =====================
// YouTubeプレイヤー取得
// =====================
// Content Scriptは分離ワールドで動くため、#movie_playerに付いている
// YouTube独自メソッド（seekTo/playVideo等）は呼べない。
// 代わりに標準の<video>要素を直接操作する。

function getVideo() {
  return document.querySelector("video.html5-main-video") ||
    document.querySelector("video");
}

// =====================
// UI構築
// =====================

function buildPanel(phrases) {
  // 既存パネルがあれば削除
  const existing = document.getElementById("yt-shadowing-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "yt-shadowing-panel";

  // ヘッダー
  panel.innerHTML = `
    <div id="yts-header">
      <span>🎤 YT Shadowing</span>
      <button id="yts-close">✕</button>
    </div>
    <div id="yts-phrase-list"></div>
    <div id="yts-controls">
      <div id="yts-current-phrase">フレーズを選択してください</div>
      <div id="yts-buttons">
        <button id="yts-replay">▶ 再生</button>
        <button id="yts-record">⏺ 録音</button>
        <button id="yts-play-rec" disabled>🔊 録音再生</button>
      </div>
      <div id="yts-waveform"></div>
    </div>
  `;

  document.body.appendChild(panel);

  // 閉じるボタン
  document.getElementById("yts-close").onclick = () => panel.remove();

  // フレーズリスト
  const list = document.getElementById("yts-phrase-list");
  phrases.forEach((phrase, i) => {
    const item = document.createElement("div");
    item.className = "yts-phrase-item";
    item.dataset.index = i;
    item.innerHTML = `
      <span class="yts-time">${formatTime(phrase.start)}</span>
      <span class="yts-text">${phrase.text}</span>
    `;
    item.onclick = () => selectPhrase(i, phrases, item);
    list.appendChild(item);
  });

  // ボタンイベント
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
  // 選択ハイライト
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
    console.warn("YT Shadowing: video要素が見つかりません");
    return;
  }

  clearTimeout(phraseTimer);
  video.currentTime = phrase.start;
  const p = video.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => console.warn("YT Shadowing: play失敗", err));
  }

  // 終端で自動停止
  phraseTimer = setTimeout(() => {
    video.pause();
  }, phrase.duration * 1000);
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
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get("v");
  if (!videoId) return;

  const phrases = await fetchCaptions(videoId);
  if (!phrases || phrases.length === 0) {
    console.warn("YT Shadowing: 字幕が見つかりませんでした");
    return;
  }

  buildPanel(phrases);
  initRecorder(); // recorder.jsの関数
}

// ページ遷移対応（YouTubeはSPA）
let lastUrl = "";
const observer = new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl && currentUrl.includes("watch")) {
    lastUrl = currentUrl;
    setTimeout(init, 2000); // プレイヤー描画を待つ
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// 初回実行
if (location.href.includes("watch")) {
  setTimeout(init, 2000);
}
