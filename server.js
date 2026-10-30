/**
 * ============================================================================
 * DOSYA ADI: server.js
 * AMACI: Telegram Canlı Sesli Asistan Sunucusu (Backend)
 * ============================================================================
 * 
 * BU DOSYA NELERİ YÖNETİR?
 * ----------------------------------------------------------------------------
 * 1. Express HTTP Sunucusu:
 *    - 'public/' klasöründeki Mini App (HTML/CSS/JS) dosyalarını Telegram'a servis eder.
 *    - '/health' endpoint'i ile Render/Koyeb gibi bulutlarda uyku modunu engeller.
 * 
 * 2. Telegram Bot Motoru (grammY):
 *    - Kullanıcı /start yazdığında altına "🎙️ Canlı Asistanı Başlat" butonu iliştirir.
 *    - Tıklanınca Telegram içinde tam ekran Mini App penceresi açılır.
 * 
 * 3. WebSocket Sunucusu (/live-ws):
 *    - Kullanıcının tarayıcısından gelen canlı ses baytlarını karşılar.
 *    - Bu sesleri Google'ın "Gemini 2.0 Multimodal Live API" WebSocket sunucusuna pompalar.
 *    - Gemini'den gelen canlı ses yanıtlarını tarayıcıya geri iletir.
 *    - Kullanıcı söz kesince (Interruption) bunu tarayıcıya bildirir.
 * 
 * 4. Otomatik Görüşme Özeti & Görev Çıkarıcı:
 *    - Kullanıcı aramayı kapattığında toplanan tüm konuşma dökümünü analiz eder.
 *    - Özet, kararlar ve yapılacaklar listesini kullanıcının Telegram sohbetine mesaj olarak atar.
 * ============================================================================
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ----------------------------------------------------------------------------
// 1. ORTAM DEĞİŞKENLERİ VE YAPILANDIRMA
// ----------------------------------------------------------------------------
// .env dosyasındaki gizli anahtarları process.env içine yükle
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sunucunun çalışacağı port (Render/Koyeb otomatik PORT atar, yerelde 3000)
const PORT = process.env.PORT || 3000;

// Telegram BotFather'dan alınan bot jetonu
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Google AI Studio'dan alınan Gemini API anahtarı
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Canlı Ses için Google'ın Güncel Live Modeli (gemini-3.8-live veya gemini-2.5-flash)
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

// Mini App'in barındırıldığı genel HTTPS adresi (ngrok, render, koyeb vb.)
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;

// Google Gemini Multimodal Canlı Ses WebSocket Uç Noktası (v1alpha / v1beta BidiGenerateContent)
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;


// ----------------------------------------------------------------------------
// 2. EXPRESS VE HTTP SUNUCUSU KURULUMU
// ----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Mini App statik dosyalarını (HTML, JS, ses işlemcisi) dışarıya aç
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * Sağlık Kontrolü (Health Check Endpoint)
 * ----------------------------------------------------------------------------
 * Render.com gibi ücretsiz platformlar 15 dk trafik almazsa sunucuyu uyutur.
 * UptimeRobot veya cron-job.org ile bu adrese her 10 dk'da bir istek atılarak
 * botun 7/24 hiç uyumadan kesintisiz çalışması sağlanır.
 */
app.get('/health', (req, res) => {
  res.status(200).send('OK - Sunucu Canli');
});

// ----------------------------------------------------------------------------
// 3. TELEGRAM BOT MANTIĞI (grammY Framework)
// ----------------------------------------------------------------------------
let bot = null;

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  /**
   * /start Komutu:
   * Kullanıcı bota girdiğinde karşılar ve Telegram Mini App'i açacak özel
   * bir webApp butonu yollar.
   */
  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    // URL'ye chat_id parametresi eklenir ki görüşme bitince kime özet atılacağı bilinsin
    const miniAppUrl = `${WEBAPP_URL}?chat_id=${chatId}`;

    // Telegram Mini App butonu (Tıklanınca Telegram içinde tam ekran açılır)
    const keyboard = new InlineKeyboard().webApp('🎙️ Canlı Asistanı Başlat', miniAppUrl);

    await ctx.reply(
      `👋 Merhaba *${ctx.from?.first_name || 'Dostum'}*!\n\n` +
      `Ben senin gerçek zamanlı sesli yapay zeka asistanınım (Gemini Live destekli).\n\n` +
      `Aşağıdaki butona dokunarak doğrudan benimle sesli konuşabilir, aklındakileri planlayabilir veya soru sorabilirsin.\n\n` +
      `⚡ *Görüşme bitince tüm notlar, özet ve görev listesi otomatik olarak bu sohbete dökülecektir.*`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  });

  /**
   * /help Komutu:
   * Kullanıcıya sistemin nasıl çalıştığını özetleyen rehber mesajı atar.
   */
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📌 *Nasıl Kullanılır?*\n\n` +
      `1. /start komutunu yazın veya menüdeki butona tıklayın.\n` +
      `2. 'Canlı Asistanı Başlat' butonuna basın.\n` +
      `3. Açılan tam ekran arama penceresinde doğrudan konuşmaya başlayın.\n` +
      `4. İşiniz bittiğinde kırmızı butona basıp aramayı sonlandırın.\n` +
      `5. Görüşme özeti ve kararlar anında bu sohbete gelecektir.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Botu dinlemeye başlat
  bot.start({
    onStart: (botInfo) => {
      console.log(`🤖 Telegram Botu aktif: @${botInfo.username}`);
    }
  }).catch((err) => {
    console.error('❌ Telegram Bot başlatma hatası:', err.message);
  });
} else {
  console.log('⚠️ TELEGRAM_BOT_TOKEN ayarlanmadı. Bot modülü beklemede (Mini App doğrudan test edilebilir).');
}

// ----------------------------------------------------------------------------
// 4. HTTP -> WEBSOCKET YÖNLENDİRMESİ
// ----------------------------------------------------------------------------
/**
 * Tarayıcıdan '/live-ws' yoluna gelen WebSocket yükseltme (Upgrade) isteklerini
 * yakalar ve WebSocket sunucumuza bağlar.
 */
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/live-ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ----------------------------------------------------------------------------
// 5. GÖRÜŞME ÖZETİ ÜRETİCİ VE TELEGRAM'A GÖNDERME MOTORU
// ----------------------------------------------------------------------------
/**
 * Arama kapandığında çağrılır.
 * Konuşulanları Gemini Flash modeline gönderip yapılandırılmış özet çıkartır
 * ve Telegram Bot API'si ile kullanıcının sohbetine atar.
 */
async function generateAndSendSummary(chatId, userName, transcripts, durationSeconds) {
  if (!transcripts || transcripts.length === 0) {
    console.log(`ℹ️ Chat ${chatId} için yeterli ses verisi oluşmadı.`);
    return;
  }

  const durationFormatted = `${Math.floor(durationSeconds / 60)} dk ${durationSeconds % 60} sn`;
  const conversationText = transcripts.map(t => `${t.speaker}: ${t.text}`).join('\n');

  console.log(`📊 Görüşme özeti hazırlanıyor (${chatId}), Konuşma satırı: ${transcripts.length}`);

  let summaryMarkdown = '';

  try {
    if (GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
      // Gemini 2.5 Flash REST API'sine hızlı özet isteği at
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {

        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Aşağıdaki sesli görüşme transkriptini incele ve profesyonel bir Telegram toplantı/sohbet özeti oluştur.
Format:
- 📌 **Görüşme Konusu & Kısa Özet**
- ✅ **Alınan Kararlar ve Aksiyon Maddeleri** (Maddeler halinde)
- 💡 **Önemli Fikirler / Notlar**

Transkript:
${conversationText}`
            }]
          }]
        })
      });

      const resData = await response.json();
      const generatedText = resData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generatedText) {
        summaryMarkdown = generatedText;
      }
    }
  } catch (err) {
    console.error('Özet üretirken hata oluştu:', err.message);
  }

  // Eğer API çağrısında bir sorun olursa yedek şablonu kullan
  if (!summaryMarkdown) {
    summaryMarkdown = `📌 **Görüşme Özeti:**\nKullanıcı ve asistan canlı sesli sohbet gerçekleştirdi.\n\n📝 **Transkript Kayıtları:**\n` +
      transcripts.slice(-6).map(t => `• *${t.speaker}*: ${t.text}`).join('\n');
  }

  // Telegram'a gönderilecek nihai mesaj şablonu
  const finalMessage = 
    `🎙️ *Canlı Görüşme Tamamlandı*\n` +
    `👤 *Kullanıcı:* ${userName}\n` +
    `⏱️ *Görüşme Süresi:* ${durationFormatted}\n` +
    `────────────────────\n\n` +
    `${summaryMarkdown}`;

  // Telegram botu üzerinden kullanıcıya mesajı gönder
  if (bot && chatId && chatId !== 'demo_user') {
    try {
      await bot.api.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });
      console.log(`✅ Özet başarıyla Telegram sohbetine (${chatId}) iletildi.`);
    } catch (sendErr) {
      // Markdown biçimlendirme hatası olursa düz metin olarak tekrar dene
      try {
        await bot.api.sendMessage(chatId, finalMessage);
      } catch (retryErr) {
        console.error('❌ Telegram mesaj gönderme hatası:', retryErr.message);
      }
    }
  } else {
    console.log(`[Telegram Çıktı Simülasyonu -> Chat: ${chatId}]:\n${finalMessage}`);
  }
}

// ----------------------------------------------------------------------------
// 6. WEBSOCKET BAĞLANTI YÖNETİCİSİ (Mini App <---> Gemini Live API)
// ----------------------------------------------------------------------------
wss.on('connection', (clientWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const chatId = url.searchParams.get('chatId') || 'demo_user';
  const userName = url.searchParams.get('userName') || 'Kullanıcı';

  console.log(`🔗 Yeni Mini App ses bağlantısı: Chat ID ${chatId} (${userName})`);

  const transcripts = []; // Konuşma metinlerinin biriktiği liste
  let duration = 0;       // Görüşme süresi
  let geminiWs = null;

  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
    // ------------------------------------------------------------------------
    // A) Google Gemini Multimodal Live API ile Canlı WebSocket Kurulumu
    // ------------------------------------------------------------------------
    geminiWs = new WebSocket(GEMINI_WS_URL);

    // Gemini ile bağlantı açıldığında ilk ayar (Setup) paketini gönder
    geminiWs.on('open', () => {
      console.log('✨ Gemini Live API ile bağlantı kuruldu. Konfigürasyon gönderiliyor...');

      const setupMessage = {
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`, // Canlı ses destekli güncel Live model
          generationConfig: {

            responseModalities: ['AUDIO'],      // Yanıtın doğrudan ses olarak gelmesini iste
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Puck'             // Akıcı, samimi ses tonu (Aoede, Charon, Fenrir, Kore)
                }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: 'Sen Telegram üzerinden kullanıcıyla canlı sesli sohbet eden son derece akıcı, zeki ve samimi bir yapay zeka asistanısın. Türkçe konuşuyorsun. Yanıtlarını sesli konuşma doğallığında ve öz tut. Kullanıcı araya girerse dinle. Kullanıcının planlarını ve isteklerini aklında tut, görüşme bitince özet çıkarılacaktır.'
            }]
          }
        }
      };

      geminiWs.send(JSON.stringify(setupMessage));
    });

    // Gemini'den gelen ses parçalarını ve olayları dinle
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());

        // 1. Modelin ürettiği ham ses baytları (PCM)
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/pcm')) {
              const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
              // Sesi gecikmesiz olarak kullanıcının hoparlörüne (Mini App'e) aktar
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(audioBuffer);
              }
            }
            if (part.text) {
              transcripts.push({ speaker: 'Gemini', text: part.text });
            }
          }
        }

        // 2. Söz Kesme (Interruption): Kullanıcı model konuşurken lafa girdiğinde tetiklenir
        if (response.serverContent?.interrupted) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'interrupted' }));
          }
        }

        // 3. Model konuşmasını bitirdiğinde
        if (response.serverContent?.turnComplete) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'status', status: 'listening' }));
          }
        }
      } catch (err) {
        console.error('Gemini WS yanıt işleme hatası:', err.message);
      }
    });

    geminiWs.on('error', (err) => {
      console.error('❌ Gemini Live WebSocket Hatası:', err.message);
    });

    geminiWs.on('close', () => {
      console.log('Gemini Live WS kapandı.');
    });
  } else {
    console.log('⚠️ GEMINI_API_KEY eksik! Demo modunda çalışıyor.');
  }

  // ------------------------------------------------------------------------
  // B) Mini App'ten (Kullanıcıdan) Gelen Ses ve Komutları Karşılama
  // ------------------------------------------------------------------------
  clientWs.on('message', (message, isBinary) => {
    if (isBinary) {
      // 1. Mikrofondan gelen 16-bit PCM Ham Ses Verisi:
      // Hiç bekletmeden anında Gemini Live WebSocket'ine ilet
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        const base64Audio = message.toString('base64');
        const realtimeMessage = {
          realtimeInput: {
            mediaChunks: [{
              mimeType: 'audio/pcm;rate=16000',
              data: base64Audio
            }]
          }
        };
        geminiWs.send(JSON.stringify(realtimeMessage));
      }
    } else {
      // 2. JSON Kontrol Mesajları (Aramayı Bitir vb.)
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === 'end_call') {
          duration = payload.duration || 0;
          console.log(`🛑 Görüşme bitiş sinyali alındı (${chatId}), Süre: ${duration}s`);
        }
      } catch (e) {
        // Hatalı JSON mesajlarını yoksay
      }
    }
  });

  // Kullanıcı aramayı kapattığında
  clientWs.on('close', async () => {
    console.log(`🔌 Mini App bağlantısı kapandı: Chat ID ${chatId}`);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
    // Görüşme sonlandı -> Özet oluşturup Telegram sohbetine mesaj olarak at
    await generateAndSendSummary(chatId, userName, transcripts, duration);
  });
});

// ----------------------------------------------------------------------------
// 7. SUNUCUYU DİNLEMEYE BAŞLAT
// ----------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Telegram Gemini Live Sunucusu Aktif!`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📱 Mini App URL: ${WEBAPP_URL}`);
  console.log(`======================================================\n`);
});
