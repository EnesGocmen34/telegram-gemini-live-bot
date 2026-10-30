/**
 * ============================================================================
 * DOSYA ADI: app.js
 * AMACI: Telegram Mini App Ön Yüz Mantığı, Canlı Ses Akışı & WebSocket İletişimi
 * ============================================================================
 * 
 * BU DOSYA NELER YAPAR?
 * ----------------------------------------------------------------------------
 * 1. Telegram WebApp SDK ile el sıkışır (Ekranı tam ekran yapar, titreşim tetikler).
 * 2. Kullanıcının mikrofona erişim iznini alır (16kHz PCM, yankı ve gürültü engelleme).
 * 3. Tarayıcının 'AudioWorklet' ses çekirdeğini başlatır ve mikrofona bağlar.
 * 4. Sunucuya WebSocket açar (/live-ws); mikrofon sesini bayt bayt sunucuya,
 *    oradan da Gemini Live API'sine aktarır.
 * 5. Gemini'den gelen ses parçalarını hoparlörden anlık çalar.
 * 6. Kullanıcı modelin sözünü kestiğinde (Interruption), sesi anında susturur.
 * 7. HTML5 Canvas üzerinde 60 FPS akıcı parlayan canlı ses dalgası animasyonu çizer.
 * 8. Arama bittiğinde sunucuya 'end_call' sinyali verir (Özet Telegram'a gitsin diye).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// 1. TELEGRAM WEBAPP ENTEGRASYONU
// ----------------------------------------------------------------------------
const tg = window.Telegram?.WebApp;

if (tg) {
  // Telegram istemcisine uygulamanın hazır olduğunu bildir
  tg.ready();

  // Mini App'i ekranın tamamını kaplayacak şekilde yukarı doğru genişlet
  tg.expand();

  // Kullanıcı kazara pencereyi aşağı kaydırıp kapatmasın diye onay kutusu iste
  if (tg.enableClosingConfirmation) {
    tg.enableClosingConfirmation();
  }
}

// URL parametrelerinden veya Telegram verilerinden kullanıcı kimliğini al
// (Böylece görüşme bitince özetin kime gideceği bilinir)
const urlParams = new URLSearchParams(window.location.search);
const chatId = urlParams.get('chat_id') || tg?.initDataUnsafe?.user?.id || 'demo_user';
const userName = tg?.initDataUnsafe?.user?.first_name || 'Kullanıcı';

// ----------------------------------------------------------------------------
// 2. DOM ELEMANLARI (Arayüz Bileşenleri)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 3. ÇALIŞMA ZAMANI DURUM DEĞİŞKENLERİ
// ----------------------------------------------------------------------------
let isCalling = false;       // Görüşme aktif mi?
let isMuted = false;         // Mikrofon sessize alındı mı?
let audioContext = null;    // Web Audio Context nesnesi
let workletNode = null;     // Bağımsız ses iş parçacığı düğümü
let mediaStream = null;     // Mikrofon akışı donanımı
let ws = null;              // Sunucuyla WebSocket bağlantısı
let timerInterval = null;   // Süre sayacı döngüsü
let secondsElapsed = 0;     // Geçen toplam saniye

// Görselleştirici (Canvas) için anlık ses enerjileri (0 ile 1 arası)
let userEnergy = 0; // Kullanıcı konuşurken yükselir
let aiEnergy = 0;   // Gemini konuşurken yükselir

// Gemini Live API'nin doğrudan beklediği örnekleme hızı: 16 kHz
const TARGET_SAMPLE_RATE = 16000;

// SVG İkon Verileri (Arama Başlat vs. Aramayı Bitir)
const CALL_ICON_PATH = 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';
const END_CALL_ICON_PATH = 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C3.28 8.84 7.42 7 12 7s8.72 1.84 11.71 4.67c.39.39.39 1.02 0 1.41l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z';

// ----------------------------------------------------------------------------
// 4. YARDIMCI VE BİÇİMLENDİRME FONKSİYONLARI
// ----------------------------------------------------------------------------

/**
 * Görüşme süresi sayacını başlatır (00:00 -> 00:01 ...)
 */
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

/**
 * Görüşme süresi sayacını durdurur.
 */
function stopTimer() {
  clearInterval(timerInterval);
}

/**
 * Üst kısımdaki durum rozetini ve ışığını günceller.
 * @param {string} text - Ekranda yazacak durum (Örn: "Dinliyor...")
 * @param {string} state - 'default' (gri), 'active' (yeşil), 'speaking' (mor)
 */
function setStatus(text, state = 'default') {
  statusText.innerText = text;
  statusDot.className = 'status-dot';
  if (state === 'active') statusDot.classList.add('active');
  if (state === 'speaking') statusDot.classList.add('speaking');
}

/**
 * Mikrofondan gelen Float32 ses verilerini, Gemini Live API'nin anladığı
 * 16-bit Little-Endian Linear PCM baytlarına dönüştürür.
 */
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

/**
 * Gemini'den gelen 16-bit Linear PCM baytlarını, hoparlörün çalabilmesi için
 * Float32 sayı dizisine dönüştürür.
 */
function pcm16ToFloat32(dataView) {
  const float32 = new Float32Array(dataView.byteLength / 2);
  for (let i = 0; i < float32.length; i++) {
    const int16 = dataView.getInt16(i * 2, true);
    float32[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
  }
  return float32;
}

// ----------------------------------------------------------------------------
// 5. GPU DESTEKLİ CANLI SES DALGASI ANİMASYONU (Canvas Visualizer)
// ----------------------------------------------------------------------------
/**
 * Her ekran tazelemesinde (60/120 Hz) çağrılır.
 * Kullanıcı veya AI konuştukça ortadaki küreyi organik dalgalarla titretir.
 */
function renderVisualizer() {
  requestAnimationFrame(renderVisualizer);

  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  // Tuvali temizle
  ctx.clearRect(0, 0, width, height);

  // O anki en yüksek ses enerjisini seç
  const currentEnergy = Math.max(userEnergy, aiEnergy);
  const baseRadius = 80 + currentEnergy * 70;

  // Kürenin arkasındaki parlayan sis efektini büyüt/küçült
  if (glowBackdrop) {
    const scale = 1 + currentEnergy * 0.8;
    glowBackdrop.style.transform = `scale(${scale})`;
    glowBackdrop.style.opacity = Math.min(1, 0.4 + currentEnergy * 0.6);
  }

  // Renk ve Yazı Kararı:
  // Gemini konuşuyorsa -> Mor/Mavi tonlar
  // Kullanıcı konuşuyorsa -> Canlı Zümrüt Yeşili
  // Beklemedeyse -> Koyu Turkuaz
  let strokeColor = 'rgba(56, 189, 248, 0.8)';
  let fillColor = 'rgba(56, 189, 248, 0.15)';

  if (aiEnergy > userEnergy && aiEnergy > 0.05) {
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

  // Sinüs dalgalarıyla organik daire çizimi
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

  // Enerjiyi yavaşça söndür (Akıcı geçiş hissi verir)
  userEnergy *= 0.88;
  aiEnergy *= 0.88;
}

// Görselleştirici döngüsünü başlat
renderVisualizer();

// ----------------------------------------------------------------------------
// 6. CANLI GÖRÜŞMEYİ BAŞLATMA (startCall)
// ----------------------------------------------------------------------------
async function startCall() {
  try {
    setStatus('Mikrofon açılıyor...', 'active');
    subCaption.innerText = 'Bağlantı kuruluyor...';

    // 1. Web Audio Context ve bağımsız AudioWorklet dosyasını yükle
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: TARGET_SAMPLE_RATE
    });
    await audioContext.audioWorklet.addModule('audio-worklet-processor.js');

    // 2. Kullanıcının mikrofonuna bağlan (Yankı ve gürültü engelleme donanımı açık)
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,  // Hoparlörden gelen sesi mikrofon tekrar yakalamasın (eko engelleme)
        noiseSuppression: true,  // Ortam dip gürültüsünü filtrele
        autoGainControl: true,   // Ses seviyesini otomatik dengele
        channelCount: 1,         // Mono ses (Gemini için ideal)
        sampleRate: TARGET_SAMPLE_RATE
      }
    });

    const micSource = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'live-audio-processor');

    micSource.connect(workletNode);
    workletNode.connect(audioContext.destination);

    // 3. Sunucuya WebSocket Bağlantısı Başlat
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/live-ws?chatId=${encodeURIComponent(chatId)}&userName=${encodeURIComponent(userName)}`;
    
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer'; // Ses baytlarını saf ikili (binary) olarak aktar

    // Bağlantı başarıyla kurulduğunda
    ws.onopen = () => {
      isCalling = true;
      setStatus('Canlı Bağlantı Açık', 'active');
      subCaption.innerText = 'Konuşmaya başlayabilirsiniz. Gemini sizi dinliyor.';
      mainCallBtn.className = 'btn-circle btn-end';
      callIcon.querySelector('path').setAttribute('d', END_CALL_ICON_PATH);
      muteBtn.style.display = 'flex';
      startTimer();

      // Telefonda hafif bir "başladı" titreşimi ver
      tg?.HapticFeedback?.notificationOccurred('success');
    };

    // Mikrofondan gelen ses baytlarını AudioWorklet'ten yakalayıp sunucuya pompala
    workletNode.port.onmessage = (event) => {
      if (event.data.type === 'mic_data' && ws && ws.readyState === WebSocket.OPEN && !isMuted) {
        const floatSamples = event.data.samples;
        
        // Ses dalgası animasyonu için enerji hesapla
        let sum = 0;
        for (let i = 0; i < floatSamples.length; i++) {
          sum += Math.abs(floatSamples[i]);
        }
        userEnergy = Math.max(userEnergy, sum / floatSamples.length * 5);

        // 16-bit PCM Linear formatına çevir ve WebSocket üzerinden sunucuya gönder
        const pcmBuffer = floatTo16BitPCM(floatSamples);
        ws.send(pcmBuffer);
      }
    };

    // Sunucudan (Gemini'den) gelen yanıtları karşıla
    ws.onmessage = (event) => {
      // 1. JSON Kontrol Mesajları (Interruption, Durum, Yetki vb.)
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.type === 'unauthorized') {
          // Yetkisiz erişim uyarısı
          setStatus('Erişim Reddedildi', 'default');
          centerLabel.innerText = '🔒 Yetkisiz';
          subCaption.innerHTML = '⛔ <b>Yetkisiz Erişim!</b><br>Bu asistan sadece yetkili kullanıcılara özeldir.<br>Kullanmak için bot sahibinden izin isteyin.';
          mainCallBtn.style.display = 'none';
          muteBtn.style.display = 'none';
          if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
          if (audioContext) audioContext.close();
          return;
        } else if (msg.type === 'interrupted') {

          // KULLANICI ARAYA GİRDİ! Yapay zekanın hoparlörde bekleyen seslerini derhal sustur
          workletNode.port.postMessage({ type: 'clear_audio' });
          aiEnergy = 0;
          setStatus('Dinliyor...', 'active');
        } else if (msg.type === 'status') {
          if (msg.status === 'speaking') {
            setStatus('Gemini Yanıtlıyor...', 'speaking');
          } else if (msg.status === 'listening') {
            setStatus('Dinliyor...', 'active');
          }
        }
      } 
      // 2. Binary Ses Verisi (Gemini'nin konuşma sesi)
      else if (event.data instanceof ArrayBuffer) {
        const dataView = new DataView(event.data);
        const float32Samples = pcm16ToFloat32(dataView);

        // AI ses enerjisini hesapla (kürenin titreşmesi için)
        let sum = 0;
        for (let i = 0; i < float32Samples.length; i++) {
          sum += Math.abs(float32Samples[i]);
        }
        aiEnergy = Math.max(aiEnergy, sum / float32Samples.length * 6);

        // Sesi hoparlörden çalması için AudioWorklet kuyruğuna postala
        workletNode.port.postMessage({
          type: 'queue_audio',
          samples: float32Samples
        });
      }
    };

    ws.onclose = () => {
      endCall(false);
    };

    ws.onerror = (err) => {
      console.error('WebSocket hatası:', err);
      setStatus('Bağlantı Hatası', 'default');
      subCaption.innerText = 'Bağlantı kurulamadı. Lütfen tekrar deneyin.';
      endCall(false);
    };

  } catch (error) {
    console.error('Görüşme başlatma hatası:', error);
    alert('Mikrofon erişimi sağlanamadı: ' + error.message);
    setStatus('Hata Oluştu', 'default');
  }
}

// ----------------------------------------------------------------------------
// 7. GÖRÜŞMEYİ SONLANDIRMA (endCall)
// ----------------------------------------------------------------------------
function endCall(notifyServer = true) {
  if (!isCalling && !ws) return;
  isCalling = false;
  stopTimer();

  // Telefonda kapatma titreşimi ver
  tg?.HapticFeedback?.notificationOccurred('warning');

  // Mikrofon ve ses donanımlarını kapat
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  // Sunucuya "görüşme bitti, özet çıkarıp Telegram'a gönder" sinyali yolla
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (notifyServer) {
      ws.send(JSON.stringify({ type: 'end_call', duration: secondsElapsed }));
    }
    setTimeout(() => {
      ws.close();
      ws = null;
    }, 400);
  }

  // Arayüzü başlangıç haline döndür
  mainCallBtn.className = 'btn-circle btn-start';
  callIcon.querySelector('path').setAttribute('d', CALL_ICON_PATH);
  muteBtn.style.display = 'none';
  setStatus('Görüşme Tamamlandı', 'default');
  subCaption.innerHTML = '✨ <b>Özet Telegram sohbetinize gönderiliyor!</b><br>Bu pencereyi kapatabilirsiniz.';

  // Telegram Mini App penceresini 2 saniye sonra otomatik kapat
  setTimeout(() => {
    if (tg?.close) {
      tg.close();
    }
  }, 2200);
}

// ----------------------------------------------------------------------------
// 8. BUTON OLAYLARI (Event Listeners)
// ----------------------------------------------------------------------------

// Mute (Mikrofon Susturma) Butonu
muteBtn.addEventListener('click', () => {
  if (!isCalling || !workletNode) return;
  isMuted = !isMuted;
  workletNode.port.postMessage({ type: 'set_mute', isMuted });
  
  if (isMuted) {
    muteBtn.classList.add('muted');
    setStatus('Mikrofon Kapalı (Mute)', 'default');
  } else {
    muteBtn.classList.remove('muted');
    setStatus('Dinliyor...', 'active');
  }
  tg?.HapticFeedback?.selectionChanged();
});

// Ana Arama Butonu (Tıklanınca Başlatır veya Bitirir)
mainCallBtn.addEventListener('click', () => {
  if (!isCalling) {
    startCall();
  } else {
    endCall(true);
  }
});
