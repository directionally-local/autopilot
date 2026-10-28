import QRCode from "qrcode";

export interface Env {
  DISCORD_WEBHOOK_URL: string;
  AUDIO_BUCKET: R2Bucket;
  ADMIN_SECRET: string;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_AUDIO_PREFIXES = [
  "audio/webm",
  "audio/mp4",
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/mp3",
];

const rateLimits = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count++;
  return true;
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

function isAllowedAudioType(type: string): boolean {
  return ALLOWED_AUDIO_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function hashKey(twitter: string, secret: string): Promise<string> {
  // Simple hash using Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(`${twitter.toLowerCase().trim()}:${secret.trim()}`);
  return crypto.subtle.digest("SHA-256", data).then((buf) => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
}

async function htmlPage(session: string, version: string, pageUrl: string): Promise<string> {
  const qrSvg = await QRCode.toString(pageUrl, { type: "svg", margin: 2, width: 160 });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kimiflare feedback</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --text: #1c1917;
    --text-muted: #57534e;
    --text-faint: #a8a29e;
    --accent: #f48120;
    --accent-hover: #e06b0a;
    --accent-soft: #fff7ed;
    --border: #d6d3d1;
    --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 16px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px 32px;
    max-width: 520px;
    width: 100%;
    text-align: left;
    box-shadow: 0 8px 32px rgba(0,0,0,0.08);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }
  .logo-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 4px;
  }
  .logo-text {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
  p.sub { margin: 0 0 16px; font-size: 14px; color: var(--text-muted); }
  .record-box {
    background: var(--bg);
    border: 1.5px dashed var(--border);
    border-radius: 10px;
    padding: 20px;
    text-align: center;
    margin-bottom: 16px;
    transition: all 0.2s;
  }
  .record-box.active {
    border-style: solid;
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .record-box.error {
    border-style: solid;
    border-color: #dc2626;
    background: #fef2f2;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    border-radius: 8px;
    padding: 10px 22px;
    font-family: var(--font-sans);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-record { background: var(--accent); color: #fff; }
  .btn-record:hover { background: var(--accent-hover); }
  .btn-stop { background: #dc2626; color: #fff; }
  .btn-stop:hover { background: #b91c1c; }
  .btn-play { background: var(--text); color: #fff; }
  .btn-play:disabled { background: var(--text-faint); cursor: not-allowed; }
  .btn-send { background: var(--accent); color: #fff; }
  .btn-send:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--card); color: var(--text-muted); border: 1px solid var(--border); font-weight: 500; }
  .btn-secondary:hover { border-color: var(--text-faint); color: var(--text); }
  .timer {
    font-family: var(--font-mono);
    font-size: 32px;
    font-weight: 500;
    color: var(--text);
    margin: 2px 0 8px;
    font-variant-numeric: tabular-nums;
  }
  .actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  .hidden { display: none !important; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .field { text-align: left; }
  .field label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .field input, .field textarea, .field select {
    width: 100%;
    background: var(--card);
    border: 1.5px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    outline: none;
    transition: all 0.15s;
  }
  .field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); }
  .field textarea { resize: none; min-height: 40px; height: 40px; }
  .field input::placeholder, .field textarea::placeholder { color: var(--text-faint); }
  .privacy { font-size: 12px; color: var(--text-faint); line-height: 1.5; }
  .status { margin-top: 10px; font-size: 13px; min-height: 18px; font-weight: 500; }
  .status.ok { color: #16a34a; }
  .status.err { color: #dc2626; }
  .waveform { height: 32px; display: flex; align-items: center; justify-content: center; gap: 3px; margin: 8px 0; }
  .bar { width: 3px; background: var(--accent); border-radius: 2px; animation: bounce 0.5s infinite ease-in-out alternate; }
  @keyframes bounce { from { height: 3px; } to { height: 24px; } }
  .record-area { min-height: 60px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .meter-wrap { height: 40px; display: flex; align-items: flex-end; justify-content: center; gap: 2px; margin: 8px 0; }
  .meter-bar { width: 4px; background: #dc2626; border-radius: 1px; transition: height 0.05s, background 0.2s; }
  .meter-bar.active { background: #16a34a; }
  .qr-wrap { text-align: center; margin-top: 12px; }
  .qr-wrap svg { display: inline-block; }
  .qr-label { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
  .mic-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .mic-row select { flex: 1; }
  .mic-row button { flex-shrink: 0; }
  @media (max-width: 480px) {
    .card { padding: 20px 18px; border-radius: 12px; }
    h1 { font-size: 18px; }
    .fields { grid-template-columns: 1fr; gap: 10px; }
    .record-box { padding: 16px; }
    .timer { font-size: 28px; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <img class="logo-icon" src="https://directionally-local.github.io/autopilot/logo.png" alt="">
    <div class="logo-text">kimiflare</div>
  </div>
  <h1>Hey, how do you like v${escapeHtml(version)}?</h1>
  <p class="sub">Send me a voice note. Only I see it.</p>

  <div class="record-box" id="record-box">
    <div id="step-record" class="record-area">
      <div class="mic-row" id="mic-row" style="display:none;">
        <select id="mic-select"></select>
        <button id="btn-refresh-mics" class="btn btn-secondary" style="padding:8px 12px;font-size:12px;">↻</button>
      </div>
      <button id="btn-record" class="btn btn-record">● Record</button>
      <div class="waveform hidden" id="waveform">
        <div class="bar" style="animation-delay:0s"></div>
        <div class="bar" style="animation-delay:0.08s"></div>
        <div class="bar" style="animation-delay:0.16s"></div>
        <div class="bar" style="animation-delay:0.24s"></div>
        <div class="bar" style="animation-delay:0.32s"></div>
      </div>
      <div class="meter-wrap hidden" id="meter"></div>
      <div class="timer hidden" id="timer">00:00</div>
    </div>

    <div id="step-review" class="hidden">
      <div class="timer" id="duration">00:00</div>
      <div class="actions">
        <button id="btn-play" class="btn btn-play" disabled>▶ Play</button>
        <button id="btn-rerecord" class="btn btn-secondary">↻ Re-record</button>
        <button id="btn-send" class="btn btn-send" disabled>✉ Send</button>
      </div>
    </div>

    <div id="step-sent" class="hidden" style="text-align:center;">
      <div style="font-size:42px;margin-bottom:8px;">✅</div>
      <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px;">Sent!</div>
      <div style="font-size:14px;color:var(--text-muted);">Thanks for the feedback. You can close this tab.</div>
    </div>

    <div id="step-qr" class="hidden">
      <div style="font-size:28px;margin-bottom:8px;">📱</div>
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px;">Recording not available here</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Your browser runs in a remote environment (browser isolation) that blocks microphone recording. Scan this QR code with your phone to record a voice note:</div>
      <div class="qr-wrap">${qrSvg}</div>
      <div class="qr-label">Scan with your phone camera</div>
      <div style="margin-top:12px;">
        <button id="btn-try-again" class="btn btn-secondary">Try again anyway</button>
      </div>
    </div>
  </div>

  <div class="qr-wrap" id="page-qr">
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Or scan to open on your phone:</div>
    ${qrSvg}
  </div>

  <div class="fields">
    <div class="field">
      <label for="text-note">Note (optional)</label>
      <textarea id="text-note" placeholder="Type instead..."></textarea>
    </div>
    <div class="field">
      <label for="contact">Contact (optional)</label>
      <input id="contact" type="text" placeholder="Email or X">
    </div>
  </div>

  <p class="privacy">I will personally reply.</p>
  <div class="status" id="status"></div>
</div>

<script>
  const session = ${JSON.stringify(session)};
  const version = ${JSON.stringify(version)};
  let mediaRecorder = null;
  let chunks = [];
  let audioBlob = null;
  let audioUrl = null;
  let audioPlayer = null;
  let startTime = 0;
  let timerInterval = null;
  let stream = null;
  let isRecording = false;
  let audioCtx = null;
  let analyser = null;
  let meterRaf = null;
  let micDevices = [];
  let selectedMicId = null;

  const $ = id => document.getElementById(id);
  const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

  function setStatus(msg, ok) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }

  function startTimer() {
    startTime = Date.now();
    $('timer').classList.remove('hidden');
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      $('timer').textContent = fmt(sec);
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    const sec = Math.floor((Date.now() - startTime) / 1000);
    $('duration').textContent = fmt(sec);
    return sec;
  }

  function buildMeter() {
    const wrap = $('meter');
    wrap.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const bar = document.createElement('div');
      bar.className = 'meter-bar';
      bar.style.height = '3px';
      wrap.appendChild(bar);
    }
  }

  function updateMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const bars = document.querySelectorAll('.meter-bar');
    const step = Math.floor(data.length / bars.length);
    let hasSound = false;
    bars.forEach((bar, i) => {
      const val = data[i * step] || 0;
      const h = Math.max(3, Math.min(40, val / 255 * 40));
      bar.style.height = h + 'px';
      bar.classList.toggle('active', val > 30);
      if (val > 30) hasSound = true;
    });
    if (isRecording) {
      meterRaf = requestAnimationFrame(updateMeter);
    }
  }

  async function listMics() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      tempStream.getTracks().forEach(t => t.stop());
      micDevices = devices.filter(d => d.kind === 'audioinput');
      const select = $('mic-select');
      select.innerHTML = '';
      micDevices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (i + 1);
        select.appendChild(opt);
      });
      if (micDevices.length > 0) {
        $('mic-row').style.display = 'flex';
        selectedMicId = micDevices[0].deviceId;
      }
    } catch (e) {
      // mic access not granted yet, can't list devices
    }
  }

  function reset() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    analyser = null;
    audioBlob = null;
    chunks = [];
    mediaRecorder = null;
    isRecording = false;
    $('record-box').classList.remove('active', 'error');
    $('step-record').classList.remove('hidden');
    $('step-review').classList.add('hidden');
    $('step-sent').classList.add('hidden');
    $('step-qr').classList.add('hidden');
    $('waveform').classList.add('hidden');
    $('meter').classList.add('hidden');
    $('timer').classList.add('hidden');
    $('btn-record').textContent = '● Record';
    $('btn-record').className = 'btn btn-record';
    $('btn-play').disabled = true;
    $('btn-send').disabled = true;
    setStatus('');
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.stop();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    stopTimer();
    isRecording = false;
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }

  function showQrFallback() {
    $('step-record').classList.add('hidden');
    $('step-review').classList.add('hidden');
    $('step-qr').classList.remove('hidden');
    $('record-box').classList.add('error');
  }

  $('btn-record').addEventListener('click', async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    const micId = selectedMicId || $('mic-select').value || undefined;
    const constraints = { audio: micId ? { deviceId: { exact: micId } } : true };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      setStatus('Microphone access denied. Please allow it and try again.', false);
      return;
    }

    // Set up audio level meter
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      buildMeter();
      $('meter').classList.remove('hidden');
      updateMeter();
    } catch (e) {
      // meter is optional
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
                 MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      const type = mime || 'audio/webm';
      audioBlob = new Blob(chunks, { type });
      if (audioBlob.size === 0) {
        showQrFallback();
        return;
      }
      audioUrl = URL.createObjectURL(audioBlob);
      $('step-record').classList.add('hidden');
      $('step-review').classList.remove('hidden');
      $('btn-play').disabled = false;
      $('btn-send').disabled = false;
    };
    mediaRecorder.start(100);
    isRecording = true;
    $('record-box').classList.add('active');
    $('btn-record').textContent = '■ Stop';
    $('btn-record').className = 'btn btn-stop';
    $('waveform').classList.remove('hidden');
    startTimer();
  });

  $('btn-play').addEventListener('click', () => {
    if (!audioUrl) return;
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; $('btn-play').textContent = '▶ Play'; return; }
    audioPlayer = new Audio(audioUrl);
    audioPlayer.play();
    $('btn-play').textContent = '⏸ Pause';
    audioPlayer.onended = () => { audioPlayer = null; $('btn-play').textContent = '▶ Play'; };
  });

  $('btn-rerecord').addEventListener('click', reset);

  $('btn-send').addEventListener('click', async () => {
    if (!audioBlob || audioBlob.size === 0) return;
    const textNote = $('text-note').value.trim();
    const contact = $('contact').value.trim();

    const form = new FormData();
    form.append('audio', audioBlob, 'voice-note.webm');
    form.append('session', session);
    form.append('version', version);
    if (textNote) form.append('text', textNote);
    if (contact) form.append('contact', contact);

    $('btn-send').disabled = true;
    $('btn-send').textContent = 'Sending...';
    setStatus('');

    try {
      const res = await fetch('/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || 'Upload failed');
      }
      $('step-review').classList.add('hidden');
      $('step-sent').classList.remove('hidden');
      $('text-note').disabled = true;
      $('contact').disabled = true;
    } catch (e) {
      setStatus('Failed to send: ' + e.message, false);
      $('btn-send').disabled = false;
      $('btn-send').textContent = '✉ Send';
    }
  });

  $('btn-try-again').addEventListener('click', () => {
    reset();
    setStatus('If recording fails again, scan the QR code above with your phone.', false);
  });

  $('mic-select').addEventListener('change', (e) => {
    selectedMicId = e.target.value;
  });

  $('btn-refresh-mics').addEventListener('click', listMics);

  // List mics on load if permission already granted
  listMics();
</script>
</body>
</html>`;
}

async function inboxPlayerPage(twitter: string, pageUrl: string): Promise<string> {
  const qrSvg = await QRCode.toString(pageUrl, { type: "svg", margin: 2, width: 160 });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kimiflare inbox</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --text: #1c1917;
    --text-muted: #57534e;
    --text-faint: #a8a29e;
    --accent: #f48120;
    --accent-hover: #e06b0a;
    --accent-soft: #fff7ed;
    --border: #d6d3d1;
    --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-height: 100vh;
    padding: 24px 16px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px 32px;
    max-width: 560px;
    width: 100%;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.08);
  }
  .scroll-area {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    margin: 0 -8px;
    padding: 0 8px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
    justify-content: center;
  }
  .logo-icon { width: 24px; height: 24px; flex-shrink: 0; border-radius: 4px; }
  .logo-text {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.02em; text-align: center; }
  p.sub { margin: 0 0 20px; font-size: 14px; color: var(--text-muted); text-align: center; }
  .msg-list { display: flex; flex-direction: column; gap: 16px; }
  .msg-row {
    background: var(--bg);
    border: 1.5px dashed var(--border);
    border-radius: 10px;
    padding: 16px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }
  .msg-row.new { border-color: var(--accent); background: var(--accent-soft); }
  .msg-dot { font-size: 20px; line-height: 1; flex-shrink: 0; }
  .msg-info { flex: 1; min-width: 0; }
  .msg-date { font-size: 13px; color: var(--text-muted); font-weight: 500; }
  .msg-label { font-size: 12px; color: var(--text-faint); margin-top: 2px; }
  .msg-play {
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    font-family: var(--font-sans);
  }
  .msg-play:hover { background: var(--accent-hover); }
  .msg-play:disabled { opacity: 0.6; cursor: not-allowed; }
  .player-wrap { margin-top: 10px; margin-bottom: 8px; }
  .player-wrap audio { width: 100%; outline: none; }
  .status { font-size: 13px; min-height: 18px; font-weight: 500; margin-top: 6px; }
  .status.ok { color: #16a34a; }
  .status.err { color: #dc2626; }
  .privacy { font-size: 12px; color: var(--text-faint); line-height: 1.5; margin-top: 16px; text-align: center; }
  .qr-wrap { text-align: center; margin-top: 12px; }
  .qr-wrap svg { display: inline-block; }
  .qr-label { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
  .empty { text-align: center; color: var(--text-muted); font-size: 14px; padding: 24px; }
  @media (max-width: 480px) {
    .card { padding: 20px 18px; border-radius: 12px; }
    h1 { font-size: 18px; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <img class="logo-icon" src="https://directionally-local.github.io/autopilot/logo.png" alt="">
    <div class="logo-text">kimiflare</div>
  </div>
  <h1>Hey, @${escapeHtml(twitter)}!</h1>
  <p class="sub">Your voice messages from Sina.</p>
  <div class="scroll-area">
    <div id="msg-list"><div class="empty">Loading…</div></div>
  </div>

  <div class="qr-wrap" id="page-qr">
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Can't hear? Scan to listen on your phone:</div>
    ${qrSvg}
  </div>

  <p class="privacy">These messages are private. Don't share this link.</p>
</div>
<script>
  const urlParams = new URLSearchParams(window.location.search);
  const twitter = urlParams.get('u');
  const secret = urlParams.get('s');
  const listEl = document.getElementById('msg-list');
  const audioPlayers = new Map();

  async function loadMessages() {
    try {
      const res = await fetch('/inbox/check?u=' + encodeURIComponent(twitter) + '&s=' + encodeURIComponent(secret));
      if (!res.ok) throw new Error('Failed to load messages');
      const data = await res.json();
      if (!data.messages || data.messages.length === 0) {
        listEl.innerHTML = '<div class="empty">No messages yet.</div>';
        return;
      }
      // Sort newest first
      const messages = data.messages.slice().sort((a, b) => b.createdAt - a.createdAt);
      listEl.innerHTML = messages.map((m, idx) => \`
        <div class="msg-row \${m.seen ? '' : 'new'}" data-id="\${escapeHtml(m.id)}">
          <div class="msg-dot">\${m.seen ? '' : '🔴'}</div>
          <div class="msg-info">
            <div class="msg-date">\${new Date(m.createdAt).toLocaleString()}</div>
            <div class="msg-label">\${m.seen ? 'Played' : 'New'}</div>
          </div>
          <button class="msg-play" onclick="playMessage('\${escapeHtml(m.id)}', this)">▶ Play</button>
        </div>
        <div class="player-wrap" id="player-\${escapeHtml(m.id)}" style="display:none;">
          <audio controls id="audio-\${escapeHtml(m.id)}"></audio>
          <div class="status" id="status-\${escapeHtml(m.id)}"></div>
        </div>
      \`).join('');
    } catch (e) {
      listEl.innerHTML = '<div class="empty" style="color:#dc2626;">Failed to load messages</div>';
    }
  }

  async function playMessage(messageId, btn) {
    const playerWrap = document.getElementById('player-' + messageId);
    const audio = document.getElementById('audio-' + messageId);
    const statusEl = document.getElementById('status-' + messageId);
    const row = document.querySelector('.msg-row[data-id="' + messageId + '"]');

    // Hide other players
    document.querySelectorAll('.player-wrap').forEach(el => { if (el.id !== 'player-' + messageId) el.style.display = 'none'; });
    playerWrap.style.display = 'block';
    btn.disabled = true;
    btn.textContent = 'Loading…';
    statusEl.textContent = '';
    statusEl.className = 'status';

    try {
      const res = await fetch('/inbox/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twitter, secret, messageId })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => 'Failed to load audio');
        throw new Error(text);
      }
      const blob = await res.blob();
      audio.src = URL.createObjectURL(blob);
      audio.play();
      btn.textContent = '▶ Play';
      btn.disabled = false;
      // Mark as seen visually
      if (row) {
        row.classList.remove('new');
        row.querySelector('.msg-dot').textContent = '';
        row.querySelector('.msg-label').textContent = 'Played';
      }
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = 'status err';
      btn.textContent = '▶ Play';
      btn.disabled = false;
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  loadMessages();
</script>
</body>
</html>`;
}

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kimiflare admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --text: #1c1917;
    --text-muted: #57534e;
    --text-faint: #a8a29e;
    --accent: #f48120;
    --accent-hover: #e06b0a;
    --accent-soft: #fff7ed;
    --border: #d6d3d1;
    --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 16px; }
  h2 { font-size: 18px; font-weight: 600; margin: 24px 0 12px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .note-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .note-row:last-child { border-bottom: none; }
  .note-info { flex: 1; }
  .note-contact { font-weight: 600; font-size: 14px; }
  .note-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    border-radius: 8px;
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-secondary { background: var(--card); color: var(--text-muted); border: 1px solid var(--border); }
  .btn-play:disabled { background: var(--text-faint); cursor: not-allowed; }
  .record-box {
    background: var(--bg);
    border: 1.5px dashed var(--border);
    border-radius: 10px;
    padding: 20px;
    text-align: center;
    margin-bottom: 16px;
  }
  .record-box.active {
    border-style: solid;
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .record-box.error {
    border-style: solid;
    border-color: #dc2626;
    background: #fef2f2;
  }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; }
  .field input, .field select {
    width: 100%;
    background: var(--card);
    border: 1.5px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    outline: none;
  }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .status { margin-top: 10px; font-size: 13px; min-height: 18px; font-weight: 500; }
  .status.ok { color: #16a34a; }
  .status.err { color: #dc2626; }
  .hidden { display: none !important; }
  .waveform { height: 32px; display: flex; align-items: center; justify-content: center; gap: 3px; margin: 8px 0; }
  .bar { width: 3px; background: var(--accent); border-radius: 2px; animation: bounce 0.5s infinite ease-in-out alternate; }
  @keyframes bounce { from { height: 3px; } to { height: 24px; } }
  .meter-wrap { height: 40px; display: flex; align-items: flex-end; justify-content: center; gap: 2px; margin: 8px 0; }
  .meter-bar { width: 4px; background: #dc2626; border-radius: 1px; transition: height 0.05s, background 0.2s; }
  .meter-bar.active { background: #16a34a; }
  .mic-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .mic-row select { flex: 1; }
  .mic-row button { flex-shrink: 0; }
</style>
</head>
<body>
<div class="container">
  <h1>kimiflare admin</h1>

  <div class="card">
    <h2>New Reply</h2>
    <div class="field">
      <label>Twitter username</label>
      <input id="new-twitter" type="text" placeholder="e.g. alex">
    </div>
    <div class="field">
      <label>Secret</label>
      <input id="new-secret" type="text" placeholder="e.g. coffee">
    </div>
    <div class="record-box" id="record-box">
      <div id="step-record">
        <div class="mic-row" id="mic-row" style="display:none;">
          <select id="mic-select"></select>
          <button id="btn-refresh-mics" class="btn btn-secondary" style="padding:8px 12px;font-size:12px;">↻</button>
        </div>
        <button id="btn-record" class="btn btn-primary">● Record</button>
        <div class="waveform hidden" id="waveform">
          <div class="bar" style="animation-delay:0s"></div>
          <div class="bar" style="animation-delay:0.08s"></div>
          <div class="bar" style="animation-delay:0.16s"></div>
          <div class="bar" style="animation-delay:0.24s"></div>
          <div class="bar" style="animation-delay:0.32s"></div>
        </div>
        <div class="meter-wrap hidden" id="meter"></div>
      </div>
      <div id="step-review" class="hidden">
        <div class="actions">
          <button id="btn-play" class="btn btn-secondary" disabled>▶ Play</button>
          <button id="btn-rerecord" class="btn btn-secondary">↻ Re-record</button>
          <button id="btn-send" class="btn btn-primary" disabled>✉ Send</button>
        </div>
      </div>
    </div>
    <div class="status" id="new-status"></div>
  </div>

  <div class="card">
    <h2>Incoming Voice Notes</h2>
    <div id="notes-list">Loading...</div>
  </div>
</div>

<script>
  const urlParams = new URLSearchParams(window.location.search);
  const adminKey = urlParams.get('key');

  let mediaRecorder = null;
  let chunks = [];
  let audioBlob = null;
  let audioUrl = null;
  let audioPlayer = null;
  let stream = null;
  let isRecording = false;
  let audioCtx = null;
  let analyser = null;
  let meterRaf = null;
  let micDevices = [];
  let selectedMicId = null;

  const $ = id => document.getElementById(id);

  function setStatus(msg, ok, elId = 'new-status') {
    const el = $(elId);
    el.textContent = msg;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }

  function buildMeter() {
    const wrap = $('meter');
    wrap.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const bar = document.createElement('div');
      bar.className = 'meter-bar';
      bar.style.height = '3px';
      wrap.appendChild(bar);
    }
  }

  function updateMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const bars = document.querySelectorAll('.meter-bar');
    const step = Math.floor(data.length / bars.length);
    bars.forEach((bar, i) => {
      const val = data[i * step] || 0;
      const h = Math.max(3, Math.min(40, val / 255 * 40));
      bar.style.height = h + 'px';
      bar.classList.toggle('active', val > 30);
    });
    if (isRecording) {
      meterRaf = requestAnimationFrame(updateMeter);
    }
  }

  async function listMics() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      micDevices = devices.filter(d => d.kind === 'audioinput');
      const select = $('mic-select');
      select.innerHTML = '';
      micDevices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (i + 1);
        select.appendChild(opt);
      });
      if (micDevices.length > 0) {
        $('mic-row').style.display = 'flex';
        selectedMicId = micDevices[0].deviceId;
      }
    } catch (e) {
      // mic access not granted yet, can't list devices
    }
  }

  function reset() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    analyser = null;
    audioBlob = null;
    chunks = [];
    mediaRecorder = null;
    isRecording = false;
    $('record-box').classList.remove('active', 'error');
    $('step-record').classList.remove('hidden');
    $('step-review').classList.add('hidden');
    $('waveform').classList.add('hidden');
    $('meter').classList.add('hidden');
    $('btn-record').textContent = '● Record';
    $('btn-record').className = 'btn btn-primary';
    $('btn-play').disabled = true;
    $('btn-send').disabled = true;
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.stop();
    if (stream) { stream.getTracks().forEach(t => t.stop()); }
    isRecording = false;
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }

  $('btn-record').addEventListener('click', async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    const micId = selectedMicId || $('mic-select').value || undefined;
    const constraints = { audio: micId ? { deviceId: { exact: micId } } : true };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      setStatus('Microphone access denied. Please allow it and try again.', false);
      return;
    }

    // Set up audio level meter
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      buildMeter();
      $('meter').classList.remove('hidden');
      updateMeter();
    } catch (e) {
      // meter is optional
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
                 MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const type = mime || 'audio/webm';
      audioBlob = new Blob(chunks, { type });
      if (audioBlob.size === 0) {
        setStatus('Recording failed. The microphone may be blocked by browser isolation. Try a different browser or device.', false);
        reset();
        return;
      }
      audioUrl = URL.createObjectURL(audioBlob);
      $('step-record').classList.add('hidden');
      $('step-review').classList.remove('hidden');
      $('btn-play').disabled = false;
      $('btn-send').disabled = false;
    };
    mediaRecorder.start(100);
    isRecording = true;
    $('record-box').classList.add('active');
    $('btn-record').textContent = '■ Stop';
    $('btn-record').className = 'btn btn-secondary';
    $('waveform').classList.remove('hidden');
  });

  $('btn-play').addEventListener('click', () => {
    if (!audioUrl) return;
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; $('btn-play').textContent = '▶ Play'; return; }
    audioPlayer = new Audio(audioUrl);
    audioPlayer.play();
    $('btn-play').textContent = '⏸ Pause';
    audioPlayer.onended = () => { audioPlayer = null; $('btn-play').textContent = '▶ Play'; };
  });

  $('btn-rerecord').addEventListener('click', reset);

  $('mic-select').addEventListener('change', (e) => {
    selectedMicId = e.target.value;
  });

  $('btn-refresh-mics').addEventListener('click', listMics);

  $('btn-send').addEventListener('click', async () => {
    if (!audioBlob) return;
    const twitter = $('new-twitter').value.trim();
    const secret = $('new-secret').value.trim();
    if (!twitter || !secret) {
      setStatus('Enter both Twitter username and secret.', false);
      return;
    }
    const form = new FormData();
    form.append('audio', audioBlob, 'reply.webm');
    form.append('twitter', twitter);
    form.append('secret', secret);
    form.append('adminKey', adminKey);
    $('btn-send').disabled = true;
    $('btn-send').textContent = 'Sending...';
    try {
      const res = await fetch('/admin/reply', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => 'Upload failed');
        throw new Error(body);
      }
      setStatus('Reply sent!', true);
      reset();
      $('new-twitter').value = '';
      $('new-secret').value = '';
      loadNotes();
    } catch (e) {
      setStatus('Failed: ' + e.message, false);
    } finally {
      $('btn-send').disabled = false;
      $('btn-send').textContent = '✉ Send';
    }
  });

  async function loadNotes() {
    const list = $('notes-list');
    try {
      const res = await fetch('/admin/notes?key=' + encodeURIComponent(adminKey));
      if (!res.ok) throw new Error('Failed to load');
      const notes = await res.json();
      if (notes.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted)">No voice notes yet.</p>';
        return;
      }
      list.innerHTML = notes.map(n => \`
        <div class="note-row">
          <div class="note-info">
            <div class="note-contact">\${escapeHtml(n.contact || 'Anonymous')}</div>
            <div class="note-meta">\${escapeHtml(n.version)} · \${new Date(n.createdAt).toLocaleString()}</div>
          </div>
          <audio controls src="/audio/\${encodeURIComponent(n.audioKey)}" style="width:200px"></audio>
          <button class="btn btn-primary" onclick="fillReply('\${escapeHtml(n.contact || '')}')">Reply</button>
        </div>
      \`).join('');
    } catch (e) {
      list.innerHTML = '<p class="status err">Failed to load notes</p>';
    }
  }

  function fillReply(contact) {
    if (contact) $('new-twitter').value = contact.replace(/^@/, '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  listMics();
  loadNotes();
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getAudioExtension(type: string): string {
  if (type.startsWith("audio/webm")) return "webm";
  if (type.startsWith("audio/mp4")) return "m4a";
  if (type.startsWith("audio/wav")) return "wav";
  if (type.startsWith("audio/mpeg") || type.startsWith("audio/mp3")) return "mp3";
  if (type.startsWith("audio/ogg")) return "ogg";
  return "bin";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve audio files from R2 — ONLY voice-notes/*
    const audioMatch = url.pathname.match(/^\/audio\/(.+)$/);
    if (audioMatch && request.method === "GET") {
      const key = audioMatch[1];
      if (!key.startsWith("voice-notes/")) {
        return new Response("Not found.", { status: 404 });
      }
      console.log(`[audio] serving key=${key}`);
      try {
        const object = await env.AUDIO_BUCKET.get(key);
        if (!object) {
          console.log(`[audio] not found key=${key}`);
          return new Response("Not found.", { status: 404 });
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("content-type", object.httpMetadata?.contentType ?? "audio/webm");
        headers.set("accept-ranges", "bytes");
        console.log(`[audio] served key=${key} size=${object.size}`);
        return new Response(object.body, { headers });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[audio] error key=${key} msg=${msg}`);
        return new Response(`Failed to retrieve audio: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      const ip = getClientIP(request);
      console.log(`[upload] request from ip=${ip}`);

      if (!checkRateLimit(ip)) {
        console.log(`[upload] rate limited ip=${ip}`);
        return new Response("Rate limit exceeded. Try again later.", {
          status: 429,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        console.log(`[upload] invalid form data ip=${ip}`);
        return new Response("Invalid form data.", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const audio = form.get("audio");
      if (!audio || !(audio instanceof File)) {
        console.log(`[upload] missing audio file ip=${ip}`);
        return new Response("Missing audio file.", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (audio.size > MAX_FILE_SIZE) {
        console.log(`[upload] file too large ip=${ip} size=${audio.size}`);
        return new Response("File too large. Max 50 MB.", {
          status: 413,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (!isAllowedAudioType(audio.type)) {
        console.log(`[upload] unsupported audio type ip=${ip} type=${audio.type}`);
        return new Response(`Unsupported audio type: ${audio.type}`, {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (audio.size === 0) {
        return new Response("Audio file is empty.", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const session = String(form.get("session") || "unknown").slice(0, 64);
      const version = String(form.get("version") || "unknown").slice(0, 32);
      const text = String(form.get("text") || "").slice(0, 2000);
      const contact = String(form.get("contact") || "").slice(0, 256);

      console.log(
        `[upload] validated ip=${ip} session=${session} version=${version} size=${audio.size} type=${audio.type}`
      );

      // Upload to R2
      const ext = getAudioExtension(audio.type);
      const r2Key = `voice-notes/${session}-${Date.now()}.${ext}`;
      try {
        await env.AUDIO_BUCKET.put(r2Key, audio.stream(), {
          httpMetadata: { contentType: audio.type },
        });
        console.log(`[upload] r2 put success key=${r2Key}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[upload] r2 put failed key=${r2Key} msg=${msg}`);
        return new Response(`Failed to store audio: ${msg}`, {
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      // Store metadata JSON
      const metaKey = `voice-notes/meta/${session}.json`;
      try {
        await env.AUDIO_BUCKET.put(
          metaKey,
          JSON.stringify({ session, version, text, contact, audioKey: r2Key, createdAt: Date.now() }),
          { httpMetadata: { contentType: "application/json" } }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[upload] meta put failed key=${metaKey} msg=${msg}`);
      }

      // Build public link
      const audioUrl = `${url.origin}/audio/${r2Key}`;

      // Build Discord webhook payload (text-only)
      const contentParts: string[] = [];
      contentParts.push(`🎙️ Voice note from kimiflare v${version}`);
      contentParts.push(`Session: \`${session}\``);
      if (contact) contentParts.push(`Contact: ${contact}`);
      if (text) contentParts.push(`Text note: ${text}`);
      contentParts.push(`Link: ${audioUrl}`);

      // Discord content limit is 2000 chars; truncate text note if needed
      let content = contentParts.join("\n");
      if (content.length > 2000) {
        const overhead = content.length - (text?.length ?? 0);
        const maxText = Math.max(0, 2000 - overhead - 3);
        const safeText = text.slice(0, maxText) + (text.length > maxText ? "..." : "");
        const safeParts: string[] = [];
        safeParts.push(`🎙️ Voice note from kimiflare v${version}`);
        safeParts.push(`Session: \`${session}\``);
        if (contact) safeParts.push(`Contact: ${contact}`);
        if (safeText) safeParts.push(`Text note: ${safeText}`);
        safeParts.push(`Link: ${audioUrl}`);
        content = safeParts.join("\n");
      }

      try {
        const discordRes = await fetch(env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!discordRes.ok) {
          const body = await discordRes.text().catch(() => "");
          throw new Error(`Discord returned ${discordRes.status}: ${body}`);
        }
        console.log(`[upload] discord webhook ok session=${session}`);
        return new Response("OK", {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[upload] discord webhook failed session=${session} msg=${msg}`);
        return new Response(`Failed to forward to Discord: ${msg}`, {
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── Inbox: check messages ──
    if (url.pathname === "/inbox/check" && request.method === "GET") {
      const twitter = String(url.searchParams.get("u") || "").trim().toLowerCase();
      const secret = String(url.searchParams.get("s") || "").trim();
      if (!twitter || !secret) {
        return new Response(JSON.stringify({ hasMessage: false, unreadCount: 0, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const h = await hashKey(twitter, secret);
      const indexKey = `replies/index/${h}.json`;
      try {
        const obj = await env.AUDIO_BUCKET.get(indexKey);
        if (!obj) {
          return new Response(JSON.stringify({ hasMessage: false, unreadCount: 0, messages: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        const raw = await obj.json<{ createdAt?: number; audioKey?: string; messages?: Array<{ id: string; audioKey: string; createdAt: number; seen: boolean }> }>();
        // Migrate old single-message format to array format
        let messages: Array<{ id: string; createdAt: number; seen: boolean }> = [];
        if (raw.messages && Array.isArray(raw.messages)) {
          messages = raw.messages.map((m) => ({ id: m.id, createdAt: m.createdAt, seen: m.seen }));
        } else if (raw.audioKey && raw.createdAt) {
          messages = [{ id: "legacy", createdAt: raw.createdAt, seen: true }];
        }
        const unreadCount = messages.filter((m) => !m.seen).length;
        return new Response(JSON.stringify({ hasMessage: messages.length > 0, unreadCount, messages }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch {
        return new Response(JSON.stringify({ hasMessage: false, unreadCount: 0, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── Inbox: HTML player page ──
    if (url.pathname === "/inbox" && request.method === "GET") {
      const twitter = String(url.searchParams.get("u") || "").trim();
      if (!twitter) {
        return new Response("Not found.", { status: 404 });
      }
      const pageUrl = url.toString();
      const html = await inboxPlayerPage(twitter, pageUrl);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── Inbox: fetch audio blob (POST to avoid caching / link sharing) ──
    if (url.pathname === "/inbox/audio" && request.method === "POST") {
      let body: { twitter?: string; secret?: string; messageId?: string };
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON.", { status: 400 });
      }
      const twitter = String(body.twitter || "").trim().toLowerCase();
      const secret = String(body.secret || "").trim();
      const messageId = String(body.messageId || "").trim();
      if (!twitter || !secret) {
        return new Response("Missing credentials.", { status: 400 });
      }
      const h = await hashKey(twitter, secret);
      const indexKey = `replies/index/${h}.json`;
      let audioKey: string;
      let indexData: { messages?: Array<{ id: string; audioKey: string; createdAt: number; seen: boolean }>; audioKey?: string; createdAt?: number } = {};
      try {
        const obj = await env.AUDIO_BUCKET.get(indexKey);
        if (!obj) {
          return new Response("No message found.", { status: 404 });
        }
        indexData = await obj.json<typeof indexData>();
        if (indexData.messages && Array.isArray(indexData.messages)) {
          const msg = messageId
            ? indexData.messages.find((m) => m.id === messageId)
            : indexData.messages[indexData.messages.length - 1];
          if (!msg) {
            return new Response("Message not found.", { status: 404 });
          }
          audioKey = msg.audioKey;
          // Mark as seen
          if (!msg.seen) {
            msg.seen = true;
            await env.AUDIO_BUCKET.put(indexKey, JSON.stringify(indexData), {
              httpMetadata: { contentType: "application/json" },
            });
          }
        } else if (indexData.audioKey) {
          audioKey = indexData.audioKey;
        } else {
          return new Response("No message found.", { status: 404 });
        }
      } catch {
        return new Response("No message found.", { status: 404 });
      }
      try {
        const audioObj = await env.AUDIO_BUCKET.get(audioKey);
        if (!audioObj) {
          return new Response("Audio not found.", { status: 404 });
        }
        const headers = new Headers();
        audioObj.writeHttpMetadata(headers);
        headers.set("etag", audioObj.httpEtag);
        headers.set("content-type", audioObj.httpMetadata?.contentType ?? "audio/webm");
        return new Response(audioObj.body, { headers });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(`Failed to retrieve audio: ${msg}`, { status: 500 });
      }
    }

    // ── Admin: list incoming notes ──
    if (url.pathname === "/admin/notes" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (key !== env.ADMIN_SECRET) {
        return new Response("Unauthorized.", { status: 401 });
      }
      try {
        const listed = await env.AUDIO_BUCKET.list({ prefix: "voice-notes/meta/" });
        const notes: Array<{
          contact: string;
          version: string;
          createdAt: number;
          audioKey: string;
        }> = [];
        for (const item of listed.objects || []) {
          try {
            const obj = await env.AUDIO_BUCKET.get(item.key);
            if (!obj) continue;
            const meta = await obj.json<{
              contact?: string;
              version?: string;
              createdAt?: number;
              audioKey?: string;
            }>();
            if (meta.audioKey) {
              notes.push({
                contact: meta.contact || "Anonymous",
                version: meta.version || "unknown",
                createdAt: meta.createdAt || 0,
                audioKey: meta.audioKey,
              });
            }
          } catch {
            // skip corrupt meta
          }
        }
        notes.sort((a, b) => b.createdAt - a.createdAt);
        return new Response(JSON.stringify(notes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(`Failed to list notes: ${msg}`, { status: 500 });
      }
    }

    // ── Admin: upload reply ──
    if (url.pathname === "/admin/reply" && request.method === "POST") {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return new Response("Invalid form data.", { status: 400 });
      }
      const adminKey = String(form.get("adminKey") || "");
      if (adminKey !== env.ADMIN_SECRET) {
        return new Response("Unauthorized.", { status: 401 });
      }
      const audio = form.get("audio");
      if (!audio || !(audio instanceof File)) {
        return new Response("Missing audio file.", { status: 400 });
      }
      if (audio.size > MAX_FILE_SIZE) {
        return new Response("File too large. Max 50 MB.", { status: 413 });
      }
      if (!isAllowedAudioType(audio.type)) {
        return new Response(`Unsupported audio type: ${audio.type}`, { status: 400 });
      }
      const twitter = String(form.get("twitter") || "").trim().toLowerCase();
      const secret = String(form.get("secret") || "").trim();
      if (!twitter || !secret) {
        return new Response("Missing twitter or secret.", { status: 400 });
      }

      const ext = getAudioExtension(audio.type);
      const audioKey = `replies/audio/${crypto.randomUUID()}.${ext}`;
      try {
        await env.AUDIO_BUCKET.put(audioKey, audio.stream(), {
          httpMetadata: { contentType: audio.type },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(`Failed to store audio: ${msg}`, { status: 502 });
      }

      const h = await hashKey(twitter, secret);
      const indexKey = `replies/index/${h}.json`;
      const newMessage = { id: crypto.randomUUID(), audioKey, createdAt: Date.now(), seen: false };
      try {
        const existing = await env.AUDIO_BUCKET.get(indexKey);
        let data: { messages?: Array<{ id: string; audioKey: string; createdAt: number; seen: boolean }>; audioKey?: string; createdAt?: number } = { messages: [] };
        if (existing) {
          data = await existing.json<typeof data>();
          if (!data.messages || !Array.isArray(data.messages)) {
            // Migrate old format
            data.messages = [];
            if (data.audioKey && data.createdAt) {
              data.messages.push({ id: "legacy", audioKey: data.audioKey, createdAt: data.createdAt, seen: true });
            }
          }
        }
        data.messages.push(newMessage);
        await env.AUDIO_BUCKET.put(indexKey, JSON.stringify(data), {
          httpMetadata: { contentType: "application/json" },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(`Failed to store index: ${msg}`, { status: 502 });
      }

      return new Response("OK", { status: 200 });
    }

    // ── Admin: HTML panel ──
    if (url.pathname === "/admin" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (key !== env.ADMIN_SECRET) {
        return new Response("Unauthorized.", { status: 401 });
      }
      return new Response(adminPage(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      const session = url.searchParams.get("s");
      const version = url.searchParams.get("v") || "unknown";
      if (!session || !/^[0-9a-f\-]{36,64}$/i.test(session)) {
        return new Response("Not found.", { status: 404 });
      }
      const pageUrl = url.toString();
      const html = await htmlPage(session, version, pageUrl);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found.", { status: 404 });
  },
};
