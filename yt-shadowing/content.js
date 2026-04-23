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
let jaPhrasesRaw = null; // 日本語フレーズ（生データ）

window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'YOUTUBE_CAPTIONS_RESULT') {
    log('Received captions result:', event.data.phrases ? event.data.phrases.length + ' phrases' : event.data.error);
    if (event.data.subPhrases) {
      log('Japanese phrases:', event.data.subPhrases.length);
    }
    jaPhrasesRaw = event.data.subPhrases || null;
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

let rawPhrases = [];
let allWords = [];
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

// 日本語フレーズを英語フレーズの時間範囲にマッチング
function matchJaText(start, end, jaPhrases) {
  if (!jaPhrases || jaPhrases.length === 0) return "";
  const matched = [];
  for (const jp of jaPhrases) {
    // 重なりがあればマッチ
    if (jp.start < end && jp.end > start) {
      matched.push(jp.text);
    }
  }
  return matched.join(" ");
}

function rebuildPhrases() {
  if (allWords.length === 0) {
    activePhrases = [];
    return;
  }

  const sortedSplits = [0, ...Array.from(splitPoints).sort((a, b) => a - b)];
  const unique = [...new Set(sortedSplits)];

  activePhrases = [];
  for (let i = 0; i < unique.length; i++) {
    const from = unique[i];
    const to = (i + 1 < unique.length) ? unique[i + 1] : allWords.length;
    const phraseWords = allWords.slice(from, to);
    if (phraseWords.length === 0) continue;
    const start = phraseWords[0].start;
    const end = phraseWords[phraseWords.length - 1].end;
    activePhrases.push({
      start: start,
      end: end,
      duration: end - start,
      text: phraseWords.map(w => w.text).join(' '),
      ja: matchJaText(start, end, jaPhrasesRaw),
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
      <div id="yts-step-indicator"></div>
      <div id="yts-mode-buttons">
        <button id="yts-repeat-mode">🔁 リピーティング</button>
        <button id="yts-overlap-mode">🎙 オーバーラッピング</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  log("panel appended");

  document.getElementById("yts-close").onclick = () => {
    stopRepeatingMode();
    stopOverlappingMode();
    panel.remove();
  };

  const statusEl = document.getElementById("yts-status");
  if (statusMessage) {
    statusEl.textContent = statusMessage;
    statusEl.style.display = "block";
  }

  const editBtn = document.getElementById("yts-edit");
  if (phrases.length === 0) {
    editBtn.style.display = "none";
    document.getElementById("yts-repeat-mode").style.display = "none";
    document.getElementById("yts-overlap-mode").style.display = "none";
  } else {
    editBtn.onclick = () => openSplitEditor();
    document.getElementById("yts-repeat-mode").onclick = () => toggleRepeatingMode();
    document.getElementById("yts-overlap-mode").onclick = () => toggleOverlappingMode();
  }

  renderPhraseList(phrases);
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
      <div class="yts-phrase-buttons">
        <button class="yts-play-btn" title="再生">▶</button>
        <button class="yts-rec-btn" title="録音">⏺</button>
        <button class="yts-playrec-btn" title="録音再生" disabled>🔊</button>
      </div>
      <span class="yts-time"></span>
      <div class="yts-text-block">
        <span class="yts-text"></span>
        <span class="yts-text-ja"></span>
      </div>
    `;
    item.querySelector(".yts-time").textContent = formatTime(phrase.start);
    item.querySelector(".yts-text").textContent = phrase.text;
    const jaEl = item.querySelector(".yts-text-ja");
    if (phrase.ja) {
      jaEl.textContent = phrase.ja;
    } else {
      jaEl.style.display = "none";
    }
    // 再生ボタン: 選択＆再生
    item.querySelector(".yts-play-btn").onclick = (e) => {
      e.stopPropagation();
      if (!repeatingActive) {
        selectPhrase(i, phrases, item);
        playPhrase(phrases[i]);
      }
    };
    // 録音ボタン
    item.querySelector(".yts-rec-btn").onclick = (e) => {
      e.stopPropagation();
      if (!repeatingActive) {
        selectPhrase(i, phrases, item);
        toggleRecordForPhrase(i, item);
      }
    };
    // 録音再生ボタン
    item.querySelector(".yts-playrec-btn").onclick = (e) => {
      e.stopPropagation();
      if (!repeatingActive) {
        selectPhrase(i, phrases, item);
        playRecordingForPhrase(i, item);
      }
    };
    // 行クリック: 選択のみ
    item.onclick = () => {
      if (!repeatingActive) {
        selectPhrase(i, phrases, item);
      }
    };
    list.appendChild(item);
  });
}

// =====================
// 区切り編集モード
// =====================

function openSplitEditor() {
  if (repeatingActive) return;
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
// フレーズ再生（Promise版）
// =====================

let currentPhrase = null;
let currentPhraseIndex = null;
let phraseTimer = null;

function selectPhrase(index, phrases, itemEl) {
  document.querySelectorAll(".yts-phrase-item").forEach(el =>
    el.classList.remove("active")
  );
  if (itemEl) itemEl.classList.add("active");

  currentPhrase = phrases[index];
  currentPhraseIndex = index;
}

// playPhraseAsync: フレーズ再生が終わるまで待てるPromise版
function playPhraseAsync(phrase) {
  return new Promise((resolve) => {
    const video = getVideo();
    if (!video) {
      warn("video要素が見つかりません");
      resolve();
      return;
    }

    clearTimeout(phraseTimer);
    video.currentTime = phrase.start;
    const p = video.play();
    if (p && typeof p.catch === "function") {
      p.catch(err => warn("play failed:", err));
    }

    const dur = Math.max(phrase.duration, 0.5) * 1000;
    phraseTimer = setTimeout(() => {
      video.pause();
      resolve();
    }, dur);
  });
}

function playPhrase(phrase) {
  playPhraseAsync(phrase);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function setStepIndicator(text) {
  const el = document.getElementById("yts-step-indicator");
  if (el) el.textContent = text;
}

function highlightPhraseItem(index) {
  document.querySelectorAll(".yts-phrase-item").forEach(el =>
    el.classList.remove("active")
  );
  const item = document.querySelector(`.yts-phrase-item[data-index="${index}"]`);
  if (item) {
    item.classList.add("active");
    item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// =====================
// リピーティングモード
// =====================

let repeatingActive = false;
let repeatingAbort = false;

function toggleRepeatingMode() {
  if (repeatingActive) {
    stopRepeatingMode();
  } else {
    startRepeatingMode();
  }
}

function stopRepeatingMode() {
  repeatingActive = false;
  repeatingAbort = true;
  clearTimeout(phraseTimer);

  // 録音中なら停止
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  const btn = document.getElementById("yts-repeat-mode");
  if (btn) {
    btn.textContent = "🔁 リピーティング";
    btn.classList.remove("active");
  }

  // インラインの録音ボタンをリセット
  document.querySelectorAll(".yts-rec-btn.recording").forEach(btn => {
    btn.textContent = "⏺";
    btn.classList.remove("recording");
  });

  setStepIndicator("");
  log("repeating mode stopped");
}

async function startRepeatingMode() {
  if (activePhrases.length === 0) return;

  repeatingActive = true;
  repeatingAbort = false;

  const btn = document.getElementById("yts-repeat-mode");
  if (btn) {
    btn.textContent = "⏹ リピーティング停止";
    btn.classList.add("active");
  }

  // 編集・手動操作ボタンを無効化
  const editBtn = document.getElementById("yts-edit");
  if (editBtn) editBtn.disabled = true;
  const overlapBtn = document.getElementById("yts-overlap-mode");
  if (overlapBtn) overlapBtn.disabled = true;

  log("repeating mode started");

  const startIndex = (currentPhraseIndex !== null && currentPhraseIndex >= 0)
    ? currentPhraseIndex : 0;

  for (let i = startIndex; i < activePhrases.length; i++) {
    if (repeatingAbort) break;

    const phrase = activePhrases[i];
    currentPhrase = phrase;
    currentPhraseIndex = i;
    highlightPhraseItem(i);

    // ステップ1: 1回目再生
    setStepIndicator("🔊 1回目の再生");
    await playPhraseAsync(phrase);
    if (repeatingAbort) break;

    // 間を少し空ける
    await sleep(500);
    if (repeatingAbort) break;

    // ステップ2: 2回目再生
    setStepIndicator("🔊 2回目の再生");
    await playPhraseAsync(phrase);
    if (repeatingAbort) break;

    await sleep(500);
    if (repeatingAbort) break;

    // ステップ3: 録音
    log("autoRecord phrase", i, "duration:", phrase.duration, "end-start:", phrase.end - phrase.start);
    setStepIndicator("⏺ 録音中… (クリックで停止)");
    const recorded = await autoRecord(i, phrase.end - phrase.start);
    if (repeatingAbort) break;

    // ステップ4: 録音再生
    if (recorded) {
      await sleep(300);
      if (repeatingAbort) break;
      setStepIndicator("🔊 録音を再生中");
      await autoPlayRecording(i);
      if (repeatingAbort) break;
    }

    // 次のフレーズへ（少し間を空ける）
    await sleep(800);
  }

  // 完了
  if (!repeatingAbort) {
    setStepIndicator("✅ 完了！");
    setTimeout(() => setStepIndicator(""), 2000);
  }

  if (editBtn) editBtn.disabled = false;
  if (overlapBtn) overlapBtn.disabled = false;
  repeatingActive = false;

  if (btn) {
    btn.textContent = "🔁 リピーティング";
    btn.classList.remove("active");
  }

  log("repeating mode finished");
}

// =====================
// オーバーラッピングモード
// =====================

let overlappingActive = false;
let overlappingAbort = false;
let overlappingStream = null;
let overlappingRecorder = null;

function toggleOverlappingMode() {
  if (overlappingActive) {
    stopOverlappingMode();
  } else {
    startOverlappingMode();
  }
}

function stopOverlappingMode() {
  overlappingActive = false;
  overlappingAbort = true;

  if (overlappingRecorder && overlappingRecorder.state === "recording") {
    overlappingRecorder.stop();
  }

  const video = getVideo();
  if (video) video.pause();

  const btn = document.getElementById("yts-overlap-mode");
  if (btn) {
    btn.textContent = "🎙 オーバーラッピング";
    btn.classList.remove("active");
  }

  setStepIndicator("録音を保存中…");
  log("overlapping mode stopped");
}

async function startOverlappingMode() {
  if (activePhrases.length === 0) return;

  const video = getVideo();
  if (!video) {
    warn("video要素が見つかりません");
    return;
  }

  // マイクアクセスを先に取得
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("マイクへのアクセスを許可してください");
    return;
  }

  overlappingActive = true;
  overlappingAbort = false;
  overlappingStream = stream;

  const btn = document.getElementById("yts-overlap-mode");
  if (btn) {
    btn.textContent = "⏹ オーバーラッピング停止";
    btn.classList.add("active");
  }

  const editBtn = document.getElementById("yts-edit");
  if (editBtn) editBtn.disabled = true;
  const repeatBtn = document.getElementById("yts-repeat-mode");
  if (repeatBtn) repeatBtn.disabled = true;

  log("overlapping mode started");

  const startIndex = (currentPhraseIndex !== null && currentPhraseIndex >= 0)
    ? currentPhraseIndex : 0;

  // 録音を1本で開始（フレーズごとに切らない）
  const recChunks = [];
  const rec = new MediaRecorder(stream);
  overlappingRecorder = rec;

  rec.ondataavailable = (e) => {
    if (e.data.size > 0) recChunks.push(e.data);
  };

  // onstop を先に登録しておく（abort時にも確実に発火させるため）
  const recDone = new Promise((resolve) => {
    rec.onstop = () => {
      const blob = new Blob(recChunks, { type: "audio/webm" });
      if (phraseRecordings["_overlap"]) {
        URL.revokeObjectURL(phraseRecordings["_overlap"]);
      }
      phraseRecordings["_overlap"] = URL.createObjectURL(blob);
      log("overlap recording saved, chunks:" + recChunks.length);
      resolve();
    };
  });

  rec.start();
  setStepIndicator("🎙 オーバーラッピング中…");

  // 動画を開始位置にシークして再生
  video.currentTime = activePhrases[startIndex].start;
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(err => warn("play failed:", err));
  }

  // timeupdate でフレーズを追跡（動画は通しで再生）
  const lastPhrase = activePhrases[activePhrases.length - 1];
  let lastHighlighted = -1;

  await new Promise((resolve) => {
    const onTime = () => {
      const t = video.currentTime;

      for (let i = startIndex; i < activePhrases.length; i++) {
        if (t >= activePhrases[i].start && t < activePhrases[i].end) {
          if (i !== lastHighlighted) {
            lastHighlighted = i;
            currentPhrase = activePhrases[i];
            currentPhraseIndex = i;
            highlightPhraseItem(i);
          }
          break;
        }
      }

      if (t >= lastPhrase.end) {
        video.removeEventListener("timeupdate", onTime);
        clearInterval(abortCheck);
        video.pause();
        resolve();
      }
    };

    video.addEventListener("timeupdate", onTime);

    const abortCheck = setInterval(() => {
      if (overlappingAbort) {
        video.removeEventListener("timeupdate", onTime);
        clearInterval(abortCheck);
        video.pause();
        resolve();
      }
    }, 100);
  });

  // 録音停止＆保存を待つ
  if (rec.state === "recording") rec.stop();
  await recDone;

  // マイク解放
  stream.getTracks().forEach(t => t.stop());
  overlappingStream = null;
  overlappingRecorder = null;

  // UI復元
  if (editBtn) editBtn.disabled = false;
  if (repeatBtn) repeatBtn.disabled = false;
  overlappingActive = false;

  if (btn) {
    btn.textContent = "🎙 オーバーラッピング";
    btn.classList.remove("active");
  }

  // 完了時は自動再生してから再生ボタン表示
  if (!overlappingAbort && phraseRecordings["_overlap"]) {
    setStepIndicator("🔊 録音を再生中…");
    await new Promise((resolve) => {
      const audio = new Audio(phraseRecordings["_overlap"]);
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }

  // 録音があれば再生ボタンを常に表示（完了でも中断でも）
  if (phraseRecordings["_overlap"]) {
    showOverlapPlaybackButton();
  } else {
    setStepIndicator("");
  }

  log("overlapping mode finished");
}

let overlapPlayingAudio = null;

function showOverlapPlaybackButton() {
  const indicator = document.getElementById("yts-step-indicator");
  if (!indicator) return;

  indicator.innerHTML = "";
  const playBtn = document.createElement("button");
  playBtn.textContent = "🔊 オーバーラッピング録音を再生";
  playBtn.style.cssText = "background:#3A45C0;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;margin-right:6px;";

  playBtn.onclick = () => {
    if (overlapPlayingAudio) {
      overlapPlayingAudio.pause();
      overlapPlayingAudio.currentTime = 0;
      overlapPlayingAudio = null;
      playBtn.textContent = "🔊 オーバーラッピング録音を再生";
      return;
    }
    const url = phraseRecordings["_overlap"];
    if (!url) return;
    const audio = new Audio(url);
    overlapPlayingAudio = audio;
    playBtn.textContent = "⏹ 再生停止";
    audio.onended = () => {
      overlapPlayingAudio = null;
      playBtn.textContent = "🔊 オーバーラッピング録音を再生";
    };
    audio.play().catch(() => {
      overlapPlayingAudio = null;
      playBtn.textContent = "🔊 オーバーラッピング録音を再生";
    });
  };

  indicator.appendChild(playBtn);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 自動録音: フレーズの長さ + 余裕分だけ録音して自動停止
function autoRecord(phraseIndex, phraseDuration) {
  return new Promise(async (resolve) => {
    if (repeatingAbort) { resolve(false); return; }

    // インラインの録音ボタンを点滅表示
    const item = document.querySelector(`.yts-phrase-item[data-index="${phraseIndex}"]`);
    const recBtn = item ? item.querySelector(".yts-rec-btn") : null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      const captureIndex = phraseIndex;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      let resolved = false;
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        if (phraseRecordings[captureIndex]) {
          URL.revokeObjectURL(phraseRecordings[captureIndex]);
        }
        phraseRecordings[captureIndex] = URL.createObjectURL(blob);
        stream.getTracks().forEach(t => t.stop());
        markRecorded(captureIndex);

        if (recBtn) {
          recBtn.textContent = "⏺";
          recBtn.classList.remove("recording");
        }
        // 録音再生ボタン有効化
        const playRecBtn = item ? item.querySelector(".yts-playrec-btn") : null;
        if (playRecBtn) playRecBtn.disabled = false;

        if (!resolved) { resolved = true; resolve(true); }
      };

      mediaRecorder.start();
      if (recBtn) {
        recBtn.textContent = "⏹";
        recBtn.classList.add("recording");
      }

      // 自動停止: フレーズの長さ + 2.5秒の余裕（最低4秒）
      const autoStopMs = Math.max(Math.max(phraseDuration, 1) * 1000 + 2500, 4000);
      const autoTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, autoStopMs);

      // abort対応
      const checkAbort = setInterval(() => {
        if (repeatingAbort && mediaRecorder && mediaRecorder.state === "recording") {
          clearTimeout(autoTimer);
          clearInterval(checkAbort);
          mediaRecorder.stop();
        }
      }, 100);

      mediaRecorder.addEventListener('stop', () => {
        clearTimeout(autoTimer);
        clearInterval(checkAbort);
      }, { once: true });

    } catch (err) {
      warn("autoRecord mic error:", err);
      resolve(false);
    }
  });
}

// 録音した音声を再生して完了を待つ
function autoPlayRecording(phraseIndex) {
  return new Promise((resolve) => {
    const url = phraseRecordings[phraseIndex];
    if (!url) { resolve(); return; }

    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());

    // abort対応
    const checkAbort = setInterval(() => {
      if (repeatingAbort) {
        clearInterval(checkAbort);
        audio.pause();
        resolve();
      }
    }, 100);
    audio.addEventListener('ended', () => clearInterval(checkAbort), { once: true });
  });
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
  stopRepeatingMode();

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
  jaPhrasesRaw = null;
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

  // 動画再生に合わせてフレーズを自動追跡
  setupTimeTracking();

  initInProgress = false;
}

// =====================
// 再生時間に連動するフレーズ追跡
// =====================

let timeTrackingCleanup = null;

function setupTimeTracking() {
  // 前回のリスナーをクリーンアップ
  if (timeTrackingCleanup) {
    timeTrackingCleanup();
    timeTrackingCleanup = null;
  }

  const video = getVideo();
  if (!video) return;

  let lastTrackedIndex = -1;

  const onTimeUpdate = () => {
    // モード中は干渉しない
    if (repeatingActive || overlappingActive) return;
    if (activePhrases.length === 0) return;

    const t = video.currentTime;

    // 現在の時間に該当するフレーズを探す
    let matchIndex = -1;
    for (let i = 0; i < activePhrases.length; i++) {
      if (t >= activePhrases[i].start && t < activePhrases[i].end) {
        matchIndex = i;
        break;
      }
    }
    // 該当なしの場合、一番近い次のフレーズの直前かチェック
    if (matchIndex === -1) {
      for (let i = 0; i < activePhrases.length; i++) {
        if (t < activePhrases[i].start) {
          // 前のフレーズの end と次の start の間 → 前のフレーズをハイライト
          if (i > 0) matchIndex = i - 1;
          break;
        }
      }
      // 全フレーズより後 → 最後のフレーズ
      if (matchIndex === -1 && t >= activePhrases[activePhrases.length - 1].start) {
        matchIndex = activePhrases.length - 1;
      }
    }

    if (matchIndex >= 0 && matchIndex !== lastTrackedIndex) {
      lastTrackedIndex = matchIndex;
      currentPhrase = activePhrases[matchIndex];
      currentPhraseIndex = matchIndex;
      highlightPhraseItem(matchIndex);
    }
  };

  video.addEventListener("timeupdate", onTimeUpdate);

  timeTrackingCleanup = () => {
    video.removeEventListener("timeupdate", onTimeUpdate);
  };
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
