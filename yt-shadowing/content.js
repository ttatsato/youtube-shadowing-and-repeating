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

let captionResult = null;

window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'YOUTUBE_CAPTIONS_RESULT') {
    log('Received captions result:', event.data.phrases ? event.data.phrases.length + ' phrases' : event.data.error);
    captionResult = event.data;
  }
});

// =====================
// 字幕取得
// =====================

async function waitForCaptions() {
  let attempts = 0;
  const maxAttempts = 150;
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
// 単語・タイミング管理
// =====================

// rawPhrases: 元の字幕フレーズ（変更しない）
// allWords: 全単語をフラットにしたもの（各単語にタイムスタンプ付き）
// splitPoints: Set<number> 区切り位置（単語インデックス。その単語の前で区切る）
// activePhrases: splitPointsから生成された現在のフレーズ配列

let rawPhrases = [];
let allWords = [];    // [{ text, start, end }]
let splitPoints = new Set();
let activePhrases = [];

function buildWords(phrases) {
  const words = [];
  for (const phrase of phrases) {
    const phWords = phrase.text.split(/\s+/).filter(w => w);
    const count = phWords.length;
    for (let i = 0; i < count; i++) {
      const ratio = count > 1 ? i / count : 0;
      const ratioEnd = count > 1 ? (i + 1) / count : 1;
      words.push({
        text: phWords[i],
        start: phrase.start + (phrase.duration * ratio),
        end: phrase.start + (phrase.duration * ratioEnd),
      });
    }
  }
  return words;
}

function buildDefaultSplitPoints(phrases) {
  const points = new Set();
  let wordIndex = 0;
  for (const phrase of phrases) {
    if (wordIndex > 0) {
      points.add(wordIndex);
    }
    const count = phrase.text.split(/\s+/).filter(w => w).length;
    wordIndex += count;
  }
  return points;
}

function rebuildPhrases() {
  if (allWords.length === 0) {
    activePhrases = [];
    return;
  }

  const sortedSplits = [0, ...Array.from(splitPoints).sort((a, b) => a - b)];
  // 0が重複しないように
  const unique = [...new Set(sortedSplits)];

  activePhrases = [];
  for (let i = 0; i < unique.length; i++) {
    const from = unique[i];
    const to = (i + 1 < unique.length) ? unique[i + 1] : allWords.length;
    const phraseWords = allWords.slice(from, to);
    if (phraseWords.length === 0) continue;
    activePhrases.push({
      start: phraseWords[0].start,
      end: phraseWords[phraseWords.length - 1].end,
      duration: phraseWords[phraseWords.length - 1].end - phraseWords[0].start,
      text: phraseWords.map(w => w.text).join(' '),
    });
  }
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
      <div id="yts-header-buttons">
        <button id="yts-edit" title="区切り編集">✂</button>
        <button id="yts-close" title="閉じる">✕</button>
      </div>
    </div>
    <div id="yts-status"></div>
    <div id="yts-phrase-list"></div>
    <div id="yts-split-editor" style="display:none"></div>
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

  // 編集ボタン（フレーズがある時だけ有効）
  const editBtn = document.getElementById("yts-edit");
  if (phrases.length === 0) {
    editBtn.style.display = "none";
  } else {
    editBtn.onclick = () => openSplitEditor();
  }

  renderPhraseList(phrases);

  document.getElementById("yts-replay").onclick = () => {
    if (currentPhrase) playPhrase(currentPhrase);
  };
}

function renderPhraseList(phrases) {
  const list = document.getElementById("yts-phrase-list");
  if (!list) return;
  list.innerHTML = "";

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
}

// =====================
// 区切り編集モード
// =====================

function openSplitEditor() {
  const list = document.getElementById("yts-phrase-list");
  const editor = document.getElementById("yts-split-editor");
  const editBtn = document.getElementById("yts-edit");
  const controls = document.getElementById("yts-controls");
  if (!editor) return;

  list.style.display = "none";
  controls.style.display = "none";
  editor.style.display = "flex";
  editBtn.textContent = "✓";
  editBtn.title = "編集完了";
  editBtn.onclick = () => closeSplitEditor();

  renderSplitEditor();
}

function closeSplitEditor() {
  const list = document.getElementById("yts-phrase-list");
  const editor = document.getElementById("yts-split-editor");
  const editBtn = document.getElementById("yts-edit");
  const controls = document.getElementById("yts-controls");
  if (!editor) return;

  editor.style.display = "none";
  list.style.display = "";
  controls.style.display = "";
  editBtn.textContent = "✂";
  editBtn.title = "区切り編集";
  editBtn.onclick = () => openSplitEditor();

  // フレーズを再構築して表示更新
  rebuildPhrases();
  renderPhraseList(activePhrases);
  currentPhrase = null;
  currentPhraseIndex = null;

  if (typeof initRecorder === "function") {
    initRecorder();
  }
}

function renderSplitEditor() {
  const editor = document.getElementById("yts-split-editor");
  if (!editor) return;
  editor.innerHTML = "";

  const hint = document.createElement("div");
  hint.className = "yts-edit-hint";
  hint.textContent = "単語間をクリックして区切りを追加/削除";
  editor.appendChild(hint);

  const wordContainer = document.createElement("div");
  wordContainer.className = "yts-word-container";

  allWords.forEach((word, i) => {
    // 区切りマーカー（最初の単語の前には表示しない）
    if (i > 0) {
      const splitter = document.createElement("span");
      splitter.className = "yts-splitter";
      if (splitPoints.has(i)) {
        splitter.classList.add("active");
      }
      splitter.textContent = "|";
      splitter.onclick = (e) => {
        e.stopPropagation();
        if (splitPoints.has(i)) {
          splitPoints.delete(i);
          splitter.classList.remove("active");
        } else {
          splitPoints.add(i);
          splitter.classList.add("active");
        }
      };
      wordContainer.appendChild(splitter);
    }

    const wordEl = document.createElement("span");
    wordEl.className = "yts-word";
    wordEl.textContent = word.text;
    wordContainer.appendChild(wordEl);
  });

  editor.appendChild(wordContainer);
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

  captionResult = null;
  injectScript();

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

  // 単語データと区切りを初期化
  rawPhrases = phrases;
  allWords = buildWords(phrases);
  splitPoints = buildDefaultSplitPoints(phrases);
  rebuildPhrases();

  buildPanel(activePhrases);
  if (typeof initRecorder === "function") {
    initRecorder();
  } else {
    warn("initRecorder is not defined");
  }

  initInProgress = false;
}

// =====================
// ページ遷移対応
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

if (location.href.includes("/watch")) {
  const urlParams = new URLSearchParams(window.location.search);
  lastVideoId = urlParams.get("v") || "";
  setTimeout(init, 1500);
}
