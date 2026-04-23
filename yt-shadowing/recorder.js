let mediaRecorder = null;
let recordedChunks = [];

// フレーズごとの録音を保存: { [phraseIndex]: audioUrl }
const phraseRecordings = {};

function initRecorder() {
  const recordBtn = document.getElementById("yts-record");
  const playRecBtn = document.getElementById("yts-play-rec");

  if (!recordBtn) return;

  recordBtn.onclick = async () => {
    if (typeof currentPhraseIndex === "undefined" || currentPhraseIndex === null) {
      return;
    }

    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordBtn.textContent = "⏺ 録音";
      recordBtn.classList.remove("recording");
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        const captureIndex = currentPhraseIndex;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: "audio/webm" });
          // 古いURLを解放
          if (phraseRecordings[captureIndex]) {
            URL.revokeObjectURL(phraseRecordings[captureIndex]);
          }
          phraseRecordings[captureIndex] = URL.createObjectURL(blob);
          playRecBtn.disabled = false;
          stream.getTracks().forEach((t) => t.stop());
          // フレーズリストに録音済みマーク
          markRecorded(captureIndex);
        };

        mediaRecorder.start();
        recordBtn.textContent = "⏹ 停止";
        recordBtn.classList.add("recording");
      } catch (err) {
        alert("マイクへのアクセスを許可してください");
      }
    }
  };

  let playingAudio = null;

  playRecBtn.onclick = () => {
    // 再生中なら停止
    if (playingAudio) {
      playingAudio.pause();
      playingAudio = null;
      playRecBtn.textContent = "🔊 録音再生";
      return;
    }

    if (typeof currentPhraseIndex === "undefined" || currentPhraseIndex === null) return;
    const url = phraseRecordings[currentPhraseIndex];
    if (!url) return;

    const audio = new Audio(url);
    playingAudio = audio;
    playRecBtn.textContent = "⏹ 停止";
    recordBtn.disabled = true;

    audio.onended = () => {
      playingAudio = null;
      playRecBtn.textContent = "🔊 録音再生";
      recordBtn.disabled = false;
    };

    audio.play();
  };
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

// フレーズ選択時に録音再生ボタンの状態を更新
function updatePlayRecBtn() {
  const playRecBtn = document.getElementById("yts-play-rec");
  if (!playRecBtn) return;
  if (typeof currentPhraseIndex !== "undefined" && phraseRecordings[currentPhraseIndex]) {
    playRecBtn.disabled = false;
  } else {
    playRecBtn.disabled = true;
  }
}
