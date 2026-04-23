let mediaRecorder = null;
let recordedChunks = [];
let recordingIndex = null; // 現在録音中のフレーズindex

// フレーズごとの録音を保存: { [phraseIndex]: audioUrl }
const phraseRecordings = {};

let playingAudio = null;

// フレーズ行の録音ボタンから呼ばれる
async function toggleRecordForPhrase(index, itemEl) {
  const recBtn = itemEl.querySelector(".yts-rec-btn");
  if (!recBtn) return;

  // 既に録音中なら停止
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    recBtn.textContent = "⏺";
    recBtn.classList.remove("recording");
    recordingIndex = null;
    return;
  }

  // 別のフレーズで録音中なら先に停止
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    recordingIndex = index;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      if (phraseRecordings[index]) {
        URL.revokeObjectURL(phraseRecordings[index]);
      }
      phraseRecordings[index] = URL.createObjectURL(blob);
      stream.getTracks().forEach((t) => t.stop());
      // 録音再生ボタンを有効化
      const playRecBtn = itemEl.querySelector(".yts-playrec-btn");
      if (playRecBtn) playRecBtn.disabled = false;
      // 録音済みマーク
      markRecorded(index);
    };

    mediaRecorder.start();
    recBtn.textContent = "⏹";
    recBtn.classList.add("recording");
  } catch (err) {
    alert("マイクへのアクセスを許可してください");
  }
}

// フレーズ行の録音再生ボタンから呼ばれる
function playRecordingForPhrase(index, itemEl) {
  const playRecBtn = itemEl.querySelector(".yts-playrec-btn");
  if (!playRecBtn) return;

  // 再生中なら停止
  if (playingAudio) {
    playingAudio.pause();
    playingAudio.currentTime = 0;
    // 前の再生ボタンのテキストを戻す
    document.querySelectorAll(".yts-playrec-btn").forEach(btn => {
      btn.textContent = "🔊";
    });
    playingAudio = null;
    return;
  }

  const url = phraseRecordings[index];
  if (!url) return;

  const audio = new Audio(url);
  playingAudio = audio;
  playRecBtn.textContent = "⏹";

  audio.onended = () => {
    playingAudio = null;
    playRecBtn.textContent = "🔊";
  };

  audio.play();
}

function markRecorded(index) {
  const item = document.querySelector(`.yts-phrase-item[data-index="${index}"]`);
  if (item && !item.querySelector(".yts-rec-badge")) {
    const badge = document.createElement("span");
    badge.className = "yts-rec-badge";
    badge.textContent = "●";
    item.appendChild(badge);
  }
}

// リピーティングモード用: 自動録音（content.jsから呼ばれる）
async function autoRecord(durationMs) {
  return new Promise(async (resolve) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      const rec = new MediaRecorder(stream);
      const captureIndex = typeof currentPhraseIndex !== "undefined" ? currentPhraseIndex : null;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      rec.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        if (captureIndex !== null) {
          if (phraseRecordings[captureIndex]) {
            URL.revokeObjectURL(phraseRecordings[captureIndex]);
          }
          phraseRecordings[captureIndex] = URL.createObjectURL(blob);
          markRecorded(captureIndex);
          // インラインの録音再生ボタンも有効化
          const item = document.querySelector(`.yts-phrase-item[data-index="${captureIndex}"]`);
          if (item) {
            const btn = item.querySelector(".yts-playrec-btn");
            if (btn) btn.disabled = false;
          }
        }
        stream.getTracks().forEach((t) => t.stop());
        resolve();
      };

      rec.start();
      setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, durationMs);
    } catch (err) {
      resolve();
    }
  });
}

// リピーティングモード用: 自動再生
function autoPlayRecording() {
  return new Promise((resolve) => {
    const idx = typeof currentPhraseIndex !== "undefined" ? currentPhraseIndex : null;
    if (idx === null || !phraseRecordings[idx]) {
      resolve();
      return;
    }
    const audio = new Audio(phraseRecordings[idx]);
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
}

// 後方互換: initRecorderは空にする（下部ボタンは廃止）
function initRecorder() {}

// 後方互換
function updatePlayRecBtn() {}
