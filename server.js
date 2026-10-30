/**
 * ============================================================================
 * DOSYA ADI: server.js
 * AMACI: Telegram Gemini Live Asistanı (Gemini 2.5 Flash + Native TTS Motoru)
 * ============================================================================
 * Bu sunucu, kullanıcının hesabındaki resmi modelleri kullanır:
 * - Anlama/Zeka: 'gemini-2.5-flash' (Multimodal Audio Input)
 * - Seslendirme: 'gemini-2.5-flash-preview-tts' (Google Native TTS Output)
 * ============================================================================
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------
// 1. YAPILANDIRMA
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const ADMIN_TELEGRAM_ID = (process.env.ADMIN_TELEGRAM_ID || '').trim();

// Google API Uç Noktaları (Google'ın belirttiği güncel gemini-3.8-flash)
const GEMINI_FLASH_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;


// ----------------------------------------------------------------------------
// 2. WHITELIST (İZİN VERİLEN KULLANICILAR)
// ----------------------------------------------------------------------------
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
let allowedUsers = new Set();

function loadWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      const data = fs.readFileSync(WHITELIST_FILE, 'utf-8');
      const list = JSON.parse(data);
      allowedUsers = new Set(list.map(String));
    }
  } catch (err) {
    console.error('Whitelist yükleme hatası:', err.message);
  }
  if (ADMIN_TELEGRAM_ID) {
    allowedUsers.add(String(ADMIN_TELEGRAM_ID));
  }
}

function saveWhitelist() {
  try {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(Array.from(allowedUsers), null, 2), 'utf-8');
  } catch (err) {
    console.error('Whitelist kayıt hatası:', err.message);
  }
}

loadWhitelist();

function isAuthorized(userId) {
  if (!ADMIN_TELEGRAM_ID) return true;
  return allowedUsers.has(String(userId));
}

function isAdmin(userId) {
  if (!ADMIN_TELEGRAM_ID) return true;
  return String(userId) === String(ADMIN_TELEGRAM_ID);
}

// ----------------------------------------------------------------------------
// 3. EXPRESS & HTTP SUNUCUSU
// ----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Uptime robot health check
app.get('/health', (req, res) => res.status(200).send('OK - 7/24 Canli'));

// ----------------------------------------------------------------------------
// 4. TELEGRAM BOTU
// ----------------------------------------------------------------------------
let bot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAuthorized(userId)) {
      return ctx.reply(
        `⛔ *Erişim Reddedildi*\n\nBu yapay zeka asistanı sadece yetkili kullanıcılara özeldir.\n\n🆔 *Sizin Telegram ID'niz:* \`${userId}\``,
        { parse_mode: 'Markdown' }
      );
    }

    const miniAppUrl = `${WEBAPP_URL}?chat_id=${userId}`;
    const keyboard = new InlineKeyboard().webApp('🎙️ Canlı Asistanı Başlat', miniAppUrl);

    await ctx.reply(
      `👋 Merhaba *${ctx.from?.first_name || 'Dostum'}*!\n\n` +
      `Ben senin gerçek zamanlı sesli yapay zeka asistanınım.\n` +
      `Aşağıdaki butona dokunarak doğrudan benimle sesli konuşabilirsin.\n\n` +
      `⚡ *Görüşme bitince tüm notlar ve görevler bu sohbete dökülecektir.*`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  });

  bot.command('ekle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Sadece yönetici kullanabilir.');
    const targetId = ctx.match.trim();
    if (!targetId || isNaN(targetId)) return ctx.reply('⚠️ Örnek: `/ekle 123456789`', { parse_mode: 'Markdown' });
    allowedUsers.add(String(targetId));
    saveWhitelist();
    await ctx.reply(`✅ *${targetId}* ID'li kullanıcıya yetki verildi.`, { parse_mode: 'Markdown' });
  });

  bot.command('cikar', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Sadece yönetici kullanabilir.');
    const targetId = ctx.match.trim();
    if (allowedUsers.has(String(targetId))) {
      allowedUsers.delete(String(targetId));
      saveWhitelist();
      await ctx.reply(`🗑️ *${targetId}* kullanıcısının yetkisi kaldırıldı.`, { parse_mode: 'Markdown' });
    }
  });

  bot.command('liste', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Sadece yönetici kullanabilir.');
    const list = Array.from(allowedUsers);
    let msg = `📋 *İzinli Kullanıcılar (${list.length}):*\n\n`;
    list.forEach((id, i) => msg += `${i + 1}. \`${id}\`${id === String(ADMIN_TELEGRAM_ID) ? ' 👑' : ''}\n`);
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.start({
    onStart: (info) => console.log(`🤖 Telegram Botu aktif: @${info.username}`)
  }).catch(e => console.error('Bot başlatma hatası:', e.message));
}

// ----------------------------------------------------------------------------
// 5. SES İŞLEME: GEMINI 2.5 FLASH (ANLAMA) + GEMINI 2.5 TTS (SESLENDİRME)
// ----------------------------------------------------------------------------

/**
 * 16-bit Mono PCM ham sesini WAV formatına sarar (Gemini API WAV'ı doğrudan anlar)
 */
function createWavHeader(pcmLength, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  // RIFF chunk
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + pcmLength, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);          // 16 for PCM
  view.setUint16(20, 1, true);           // Linear PCM
  view.setUint16(22, 1, true);           // 1 Channel (Mono)
  view.setUint32(24, sampleRate, true);  // Sample Rate (16000)
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true);           // Block align
  view.setUint16(34, 16, true);          // Bits per sample (16 bit)
  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, pcmLength, true);

  return Buffer.from(buffer);
}

/**
 * Kullanıcının konuşmasını dinleyip anlar, ardından ses olarak yanıt üretir.
 */
async function processVoiceTurn(pcmBuffer, conversationHistory) {
  if (!GEMINI_API_KEY) return null;

  try {
    // 1. WAV Ses Dosyası Oluştur
    const wavHeader = createWavHeader(pcmBuffer.length, 16000);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
    const base64Audio = wavBuffer.toString('base64');

    console.log(`🧠 Gemini 3.8 Flash'a ses gönderiliyor (${pcmBuffer.length} bayt)...`);


    // 2. Gemini 3.8 Flash ile Sesi Anla ve Yanıt Üret
    const flashResponse = await fetch(GEMINI_FLASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "Sen Telegram üzerinden sesli olarak konuşan akıllı, samimi ve nazik bir yapay zeka asistanısın. Türkçe konuşuyorsun. Cevapların doğrudan konuşma dilinde, kısa, net ve akıcı olsun (en fazla 2-3 cümle). Kullanıcının sesini dikkatle dinle ve ona uygun yanıt ver."
          }]
        },
        contents: [
          ...conversationHistory,
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: base64Audio
                }
              }
            ]
          }
        ]
      })
    });

    const flashData = await flashResponse.json();
    let replyText = flashData.candidates?.[0]?.content?.parts?.[0]?.text;
    let directAudioBase64 = flashData.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('audio'))?.inlineData?.data;

    // Eğer doğrudan ses ürettiyse hemen onu kullan
    if (directAudioBase64) {
      console.log(`✅ Gemini 3.8 Flash doğrudan yerel ses üretti!`);
      const audioBytes = Buffer.from(directAudioBase64, 'base64');
      return {
        replyText: replyText || 'Sesli yanıt',
        audioBuffer: audioBytes
      };
    }

    if (!replyText) {
      console.warn('⚠️ Gemini metin üretemedi:', JSON.stringify(flashData));
      return null;
    }

    console.log(`🤖 Gemini 3.8 Yanıtı: "${replyText}"`);

    // 3. Metni TTS ile Seslendir
    console.log(`🔊 Seslendirme yapılıyor...`);
    const ttsResponse = await fetch(GEMINI_TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: replyText }]
        }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Puck" }
            }
          }
        }
      })
    });

    const ttsData = await ttsResponse.json();
    const audioBase64 = ttsData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (audioBase64) {
      const audioBytes = Buffer.from(audioBase64, 'base64');
      console.log(`✅ Ses başarıyla üretildi: ${audioBytes.length} bayt`);
      return {
        replyText,
        audioBuffer: audioBytes
      };
    } else {
      console.warn('⚠️ TTS yanıtı:', JSON.stringify(ttsData));
    }


  } catch (err) {
    console.error('processVoiceTurn hatası:', err.message);
  }

  return null;
}

// ----------------------------------------------------------------------------
// 6. GÖRÜŞME ÖZETİ VE TELEGRAM ÇIKTISI
// ----------------------------------------------------------------------------
async function sendSummary(chatId, userName, transcripts, duration) {
  if (!transcripts || transcripts.length === 0) return;
  const durationFormatted = `${Math.floor(duration / 60)} dk ${duration % 60} sn`;
  const conversationText = transcripts.map(t => `${t.speaker}: ${t.text}`).join('\n');

  let summary = '';
  try {
    const res = await fetch(GEMINI_FLASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Aşağıdaki sesli görüşme transkriptini incele ve profesyonel bir Telegram toplantı/sohbet özeti oluştur.
Format:
- 📌 **Görüşme Konusu & Kısa Özet**
- ✅ **Alınan Kararlar ve Aksiyon Maddeleri** (Maddeler halinde)
- 💡 **Önemli Notlar**

Transkript:
${conversationText}`
          }]
        }]
      })
    });
    const data = await res.json();
    summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
  } catch (e) {}

  if (!summary) {
    summary = `📌 **Görüşme Özeti:**\nKullanıcı ve asistan canlı sesli sohbet gerçekleştirdi.\n\n` +
      transcripts.map(t => `• *${t.speaker}*: ${t.text}`).join('\n');
  }

  const msg = `🎙️ *Canlı Görüşme Tamamlandı*\n👤 *Kullanıcı:* ${userName}\n⏱️ *Süre:* ${durationFormatted}\n────────────────────\n\n${summary}`;

  if (bot && chatId && chatId !== 'demo_user') {
    try {
      await bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.api.sendMessage(chatId, msg);
    }
  }
}

// ----------------------------------------------------------------------------
// 7. WEBSOCKET BAĞLANTISI (CANLI ETKİLEŞİM)
// ----------------------------------------------------------------------------
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/live-ws') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const chatId = url.searchParams.get('chatId') || 'demo_user';
  const userName = url.searchParams.get('userName') || 'Kullanıcı';

  if (!isAuthorized(chatId)) {
    clientWs.send(JSON.stringify({ type: 'unauthorized' }));
    clientWs.close(4003, 'Yetkisiz');
    return;
  }

  console.log(`🔗 Canlı ses oturumu açıldı: Chat ID ${chatId} (${userName})`);

  const history = [];
  const transcripts = [];
  let duration = 0;
  let pcmChunks = [];
  let isProcessing = false;

  clientWs.on('message', async (message, isBinary) => {
    if (isBinary) {
      // Mikrofondan gelen ses parçalarını biriktir
      pcmChunks.push(Buffer.from(message));
    } else {
      try {
        const payload = JSON.parse(message.toString());

        // Kullanıcı konuşmayı bitirdiğinde (cümle sonu sinyali)
        if (payload.type === 'speech_end') {
          if (pcmChunks.length === 0 || isProcessing) return;

          isProcessing = true;
          const fullAudio = Buffer.concat(pcmChunks);
          pcmChunks = []; // Sıfırla

          // İstemciye "Düşünüyor..." durumunu bildir
          clientWs.send(JSON.stringify({ type: 'status', status: 'thinking' }));

          const result = await processVoiceTurn(fullAudio, history);

          if (result && result.audioBuffer) {
            // Konuşma geçmişine ekle
            history.push({ role: 'user', parts: [{ text: '[Sesli mesaj gönderildi]' }] });
            history.push({ role: 'model', parts: [{ text: result.replyText }] });
            transcripts.push({ speaker: 'Gemini', text: result.replyText });

            // Ses parçasını istemcinin hoparlörüne gönder
            clientWs.send(result.audioBuffer);
            clientWs.send(JSON.stringify({ type: 'status', status: 'speaking', text: result.replyText }));
          } else {
            clientWs.send(JSON.stringify({ type: 'status', status: 'listening' }));
          }

          isProcessing = false;
        } else if (payload.type === 'end_call') {
          duration = payload.duration || 0;
        }
      } catch (e) {}
    }
  });

  clientWs.on('close', async () => {
    console.log(`🔌 Oturum kapandı: ${chatId}`);
    await sendSummary(chatId, userName, transcripts, duration);
  });
});

// ----------------------------------------------------------------------------
// 8. BAŞLAT
// ----------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Telegram Gemini Sesli Asistanı Aktif!`);
  console.log(`🧠 Zeka: gemini-3.8-flash`);

  console.log(`🔊 Ses: gemini-2.5-flash-preview-tts`);
  console.log(`🔒 Admin ID: ${ADMIN_TELEGRAM_ID || 'TANIMLANMADI'}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📱 Mini App URL: ${WEBAPP_URL}`);
  console.log(`======================================================\n`);
});
