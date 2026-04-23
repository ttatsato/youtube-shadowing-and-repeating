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

// 後方互換
function initRecorder() {}
function updatePlayRecBtn() {}
