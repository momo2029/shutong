// WebRTC录音
let mediaRecorder = null;
let audioChunks = [];
let timerInterval = null;
let startTime = 0;

async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecord();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      document.getElementById('preview').src = url;
      document.getElementById('preview').style.display = 'block';
      document.getElementById('uploadArea').style.display = 'block';
      window._audioBlob = blob;
    };

    mediaRecorder.start();
    startTime = Date.now();
    document.getElementById('startBtn').textContent = '停止录音';
    document.getElementById('startBtn').classList.remove('btn-primary');
    document.getElementById('startBtn').classList.add('btn-danger');

    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      document.getElementById('timer').textContent = `${m}:${s}`;
    }, 1000);
  } catch (e) {
    alert('无法访问麦克风: ' + e.message);
  }
}

function stopRecord() {
  if (mediaRecorder) mediaRecorder.stop();
  clearInterval(timerInterval);
  document.getElementById('startBtn').textContent = '重新录音';
  document.getElementById('startBtn').classList.remove('btn-danger');
  document.getElementById('startBtn').classList.add('btn-primary');
}

async function uploadAudio() {
  if (!window._audioBlob) return alert('请先录音');
  const title = document.getElementById('title').value || '网页录音笔记';
  const form = new FormData();
  form.append('audio', window._audioBlob, 'recording.webm');
  form.append('title', title);

  try {
    const res = await fetch('/api/notes', { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/notes/' + data.id;
    } else {
      alert('上传失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('上传失败: ' + e.message);
  }
}
