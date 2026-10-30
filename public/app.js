// app.js - Telegram Gemini Live Asistanı

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
}

const urlParams = new URLSearchParams(window.location.search);
const chatId = urlParams.get('chat_id') || tg?.initDataUnsafe?.user?.id || 'demo_user';
const userName = tg?.initDataUnsafe?.user?.first_name || 'Kullanıcı';

// UI Elemanları
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const callTimer = document.getElementById('callTimer');
const glowBackdrop = document.getElementById('glowBackdrop');
const centerLabel = document.getElementById('centerLabel');
const muteBtn = document.getElementById('muteBtn');
const mainCallBtn = document.getElementById('mainCallBtn');
const callIcon = document.getElementById('callIcon');
const subCaption = document.getElementById('subCaption');
const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');

let isCalling = false;
let isMuted = false;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let ws = null;
let timerInterval = null;
let secondsElapsed = 0;

let userEnergy = 0;
let aiEnergy = 0;
let isAiSpeaking = false;

// Sessizlik / Cümle Sonu Algılama (VAD)
let speechSilenceTimer = null;
let isUserTalking = false;
const SILENCE_THRESHOLD_MS = 850; // Konuşma bittikten sonra bekleme süresi

const CALL_ICON_PATH = 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';
const END_CALL_ICON_PATH = 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C3.28 8.84 7.42 7 12 7s8.72 1.84 11.71 4.67c.39.39.39 1.02 0 1.41l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z';

function startTimer() {
  secondsElapsed = 0;
  callTimer.innerText = '00:00';
  timerInterval = setInterval(() => {
    secondsElapsed++;
    const m = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
    const s = String(secondsElapsed % 60).padStart(2, '0');
    callTimer.innerText = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

function setStatus(text, state = 'default') {
  statusText.innerText = text;
  statusDot.className = 'status-dot';
  if (state === 'active') statusDot.classList.add('active');
  if (state === 'speaking') statusDot.classList.add('speaking');
}

// Float32 -> 16-bit PCM Linear
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Resampler (44.1k/48k -> 16k)
function downsampleTo16k(input, inputSampleRate) {
  if (inputSampleRate === 16000) return input;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    output[i] = input[Math.round(i * ratio)];
  }
  return output;
}

// Canlı Dalga Animasyonu (60 FPS Canvas)
function renderVisualizer() {
  requestAnimationFrame(renderVisualizer);
  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  ctx.clearRect(0, 0, width, height);
  const currentEnergy = Math.max(userEnergy, aiEnergy);
  const baseRadius = 80 + currentEnergy * 70;

  if (glowBackdrop) {
    const scale = 1 + currentEnergy * 0.8;
    glowBackdrop.style.transform = `scale(${scale})`;
    glowBackdrop.style.opacity = Math.min(1, 0.4 + currentEnergy * 0.6);
  }

  let strokeColor = 'rgba(56, 189, 248, 0.8)';
  let fillColor = 'rgba(56, 189, 248, 0.15)';

  if (isAiSpeaking) {
    strokeColor = 'rgba(168, 85, 247, 0.9)';
    fillColor = 'rgba(139, 92, 246, 0.2)';
    centerLabel.innerText = 'Gemini Konuşuyor';
  } else if (userEnergy > 0.05) {
    strokeColor = 'rgba(16, 185, 129, 0.9)';
    fillColor = 'rgba(16, 185, 129, 0.2)';
    centerLabel.innerText = 'Dinliyor...';
  } else if (isCalling) {
    centerLabel.innerText = 'Dinlemede';
  } else {
    centerLabel.innerText = 'Gemini Live';
  }

  ctx.beginPath();
  const points = 32;
  const time = performance.now() * 0.003;
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const wave = Math.sin(angle * 4 + time) * (currentEnergy * 25);
    const r = baseRadius + wave;
    const x = centerX + Math.cos(angle) * r;
    const y = centerY + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = fillColor;
  ctx.fill();

  userEnergy *= 0.88;
  aiEnergy *= 0.88;
}

renderVisualizer();

// Gemini'den gelen sesi hoparlörden çal
async function playAudioBuffer(arrayBuffer) {
  if (!audioContext) return;
  try {
    isAiSpeaking = true;
    setStatus('Gemini Yanıtlıyor...', 'speaking');

    // WAV/Audio verisini decode et ve çal
    const audioData = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = audioData;
    source.connect(audioContext.destination);

    source.onended = () => {
      isAiSpeaking = false;
      aiEnergy = 0;
      setStatus('Dinliyor...', 'active');
      subCaption.innerText = 'Sizi dinliyor, konuşabilirsiniz...';
    };

    // Ses çalarken küreyi titret
    aiEnergy = 0.6;
    source.start(0);
  } catch (err) {
    console.error('Ses çalma hatası:', err);
    isAiSpeaking = false;
    setStatus('Dinliyor...', 'active');
  }
}

// Görüşmeyi Başlat
async function startCall() {
  try {
    setStatus('Mikrofon açılıyor...', 'active');
    subCaption.innerText = 'Bağlantı kuruluyor...';

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/live-ws?chatId=${encodeURIComponent(chatId)}&userName=${encodeURIComponent(userName)}`;

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      isCalling = true;
      setStatus('Bağlandı, Dinliyor...', 'active');
      subCaption.innerText = 'Konuşmaya başlayabilirsiniz. Cümleniz bitince Gemini yanıt verecektir.';
      mainCallBtn.className = 'btn-circle btn-end';
      callIcon.querySelector('path').setAttribute('d', END_CALL_ICON_PATH);
      muteBtn.style.display = 'flex';
      startTimer();
      tg?.HapticFeedback?.notificationOccurred('success');
    };

    // Ses İşleme (ScriptProcessor ile her cihazda %100 uyumlu)
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isCalling || isMuted || isAiSpeaking) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Enerji hesapla
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += Math.abs(inputData[i]);
      }
      const energy = sum / inputData.length;
      userEnergy = Math.max(userEnergy, energy * 6);

      // Ses verisini 16kHz'e indirip PCM olarak WebSocket'e gönder
      const downsampled = downsampleTo16k(inputData, audioContext.sampleRate);
      const pcmBuffer = floatTo16BitPCM(downsampled);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(pcmBuffer);
      }

      // Konuşma Algılama (Voice Activity Detection):
      // Kullanıcı konuşurken timer'ı sıfırla, sustuğunda 'speech_end' yolla
      if (energy > 0.015) {
        isUserTalking = true;
        clearTimeout(speechSilenceTimer);
        speechSilenceTimer = setTimeout(() => {
          if (isUserTalking && ws && ws.readyState === WebSocket.OPEN) {
            isUserTalking = false;
            console.log('Cümle bitti sinyali gönderiliyor...');
            ws.send(JSON.stringify({ type: 'speech_end' }));
          }
        }, SILENCE_THRESHOLD_MS);
      }
    };

    sourceNode.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    // Sunucudan yanıt geldiğinde
    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.type === 'unauthorized') {
          setStatus('Yetkisiz Erişim', 'default');
          subCaption.innerHTML = '⛔ <b>Erişim Reddedildi!</b><br>Bot sahibinden yetki isteyin.';
          endCall(false);
        } else if (msg.type === 'status') {
          if (msg.status === 'thinking') {
            setStatus('Gemini Düşünüyor...', 'speaking');
            subCaption.innerText = 'Cevap hazırlanıyor...';
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Gelen ses parçasını çal
        await playAudioBuffer(event.data);
      }
    };

    ws.onclose = () => endCall(false);
    ws.onerror = () => endCall(false);

  } catch (err) {
    console.error('Arama başlatma hatası:', err);
    alert('Mikrofon erişim hatası: ' + err.message);
    setStatus('Hata Oluştu', 'default');
  }
}

// Görüşmeyi Bitir
function endCall(notifyServer = true) {
  if (!isCalling && !ws) return;
  isCalling = false;
  stopTimer();

  tg?.HapticFeedback?.notificationOccurred('warning');

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    if (notifyServer) {
      ws.send(JSON.stringify({ type: 'end_call', duration: secondsElapsed }));
    }
    setTimeout(() => {
      ws.close();
      ws = null;
    }, 400);
  }

  mainCallBtn.className = 'btn-circle btn-start';
  callIcon.querySelector('path').setAttribute('d', CALL_ICON_PATH);
  muteBtn.style.display = 'none';
  setStatus('Görüşme Bitti', 'default');
  subCaption.innerHTML = '✨ <b>Özet Telegram sohbetinize gönderiliyor!</b>';

  setTimeout(() => {
    if (tg?.close) tg.close();
  }, 2200);
}

// Mute Butonu
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  if (isMuted) {
    muteBtn.classList.add('muted');
    setStatus('Mikrofon Kapalı', 'default');
  } else {
    muteBtn.classList.remove('muted');
    setStatus('Dinliyor...', 'active');
  }
  tg?.HapticFeedback?.selectionChanged();
});

mainCallBtn.addEventListener('click', () => {
  if (!isCalling) startCall();
  else endCall(true);
});
