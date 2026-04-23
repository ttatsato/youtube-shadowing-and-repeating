let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let audioUrl = null;

function initRecorder() {
  const recordBtn = document.getElementById("yts-record");
  const playRecBtn = document.getElementById("yts-play-rec");

  if (!recordBtn) return;

  recordBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      // 録音停止
      mediaRecorder.stop();
      recordBtn.textContent = "⏺ 録音";
      recordBtn.classList.remove("recording");
    } else {
      // 録音開始
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          recordedBlob = new Blob(recordedChunks, { type: "audio/webm" });
          audioUrl = URL.createObjectURL(recordedBlob);
          playRecBtn.disabled = false;
          stream.getTracks().forEach((t) => t.stop());
        };

        mediaRecorder.start();
        recordBtn.textContent = "⏹ 停止";
        recordBtn.classList.add("recording");
      } catch (err) {
        alert("マイクへのアクセスを許可してください");
      }
    }
  };

  playRecBtn.onclick = () => {
    if (!audioUrl) return;
    const audio = new Audio(audioUrl);
    audio.play();
  };
}
