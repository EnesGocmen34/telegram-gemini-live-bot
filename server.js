/**
 * ============================================================================
 * DOSYA ADI: server.js
 * AMACI: Telegram Canlı Sesli Asistan Sunucusu (Yetkilendirme & Whitelist Korumalı)
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
// 1. YAPILANDIRMA VE ÇEVRE DEĞİŞKENLERİ
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-exp';
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;

// Sizin Telegram Kullanıcı ID'niz (Botun sahibi / Yönetici)
const ADMIN_TELEGRAM_ID = (process.env.ADMIN_TELEGRAM_ID || '').trim();

// Google Gemini Canlı Ses WebSocket URL'si (Resmi v1beta BidiGenerateContent)
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;


// ----------------------------------------------------------------------------
// 2. WHITELIST (İZİN VERİLEN KULLANICILAR) YÖNETİMİ
// ----------------------------------------------------------------------------
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
let allowedUsers = new Set();

// Başlangıçta Whitelist dosyasını yükle
function loadWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      const data = fs.readFileSync(WHITELIST_FILE, 'utf-8');
      const list = JSON.parse(data);
      allowedUsers = new Set(list.map(String));
    }
  } catch (err) {
    console.error('Whitelist yüklenirken hata:', err.message);
  }

  // Admin ID tanımlıysa otomatik olarak listeye ekle
  if (ADMIN_TELEGRAM_ID) {
    allowedUsers.add(String(ADMIN_TELEGRAM_ID));
  }
}

// Whitelist'i diske kaydet (Sunucu yeniden başlasa bile izinler kaybolmaz)
function saveWhitelist() {
  try {
    const list = Array.from(allowedUsers);
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('Whitelist kaydedilirken hata:', err.message);
  }
}

loadWhitelist();

/**
 * Kullanıcının yetkili olup olmadığını kontrol eder.
 * Eğer ADMIN_TELEGRAM_ID tanımlanmamışsa herkes girebilir (test modu).
 * Tanımlanmışsa SADECE whitelist'teki ID'ler girebilir.
 */
function isAuthorized(userId) {
  if (!ADMIN_TELEGRAM_ID) return true; // Güvenlik ayarlanmamışsa herkese açık
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

// Uptime kontrolü
app.get('/health', (req, res) => {
  res.status(200).send('OK - Sunucu Canli');
});

// Mini App yetki kontrol API'si
app.get('/api/check-auth', (req, res) => {
  const chatId = req.query.chat_id;
  const authorized = isAuthorized(chatId);
  res.json({ authorized, chatId });
});

// ----------------------------------------------------------------------------
// 4. TELEGRAM BOTU & YÖNETİCİ KOMUTLARI
// ----------------------------------------------------------------------------
let bot = null;

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  /**
   * /start Komutu
   */
  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;

    // Yetki Kontrolü
    if (!isAuthorized(userId)) {
      return ctx.reply(
        `⛔ *Erişim Reddedildi*\n\n` +
        `Bu yapay zeka asistanı sadece yetkili kullanıcılara özeldir.\n\n` +
        `🆔 *Sizin Telegram ID'niz:* \`${userId}\`\n\n` +
        `_Erişim sağlamak için bu ID'yi botun sahibine iletin._`,
        { parse_mode: 'Markdown' }
      );
    }

    const miniAppUrl = `${WEBAPP_URL}?chat_id=${userId}`;
    const keyboard = new InlineKeyboard().webApp('🎙️ Canlı Asistanı Başlat', miniAppUrl);

    await ctx.reply(
      `👋 Merhaba *${ctx.from?.first_name || 'Dostum'}*!\n\n` +
      `Ben senin gerçek zamanlı sesli yapay zeka asistanınım (Gemini Live destekli).\n\n` +
      `Aşağıdaki butona dokunarak doğrudan benimle sesli konuşabilirsin.\n\n` +
      `⚡ *Görüşme bitince özet ve görev listesi otomatik olarak bu sohbete gelecektir.*`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  });

  /**
   * /ekle <ID> - Yeni bir arkadaşa izin verme (SADECE ADMIN)
   */
  bot.command('ekle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply('⛔ Bu komutu sadece bot yöneticisi kullanabilir.');
    }

    const targetId = ctx.match.trim();
    if (!targetId || isNaN(targetId)) {
      return ctx.reply('⚠️ Lütfen geçerli bir Telegram ID girin.\nÖrnek: `/ekle 123456789`', { parse_mode: 'Markdown' });
    }

    allowedUsers.add(String(targetId));
    saveWhitelist();

    await ctx.reply(`✅ *${targetId}* ID'li kullanıcıya başarıyla erişim izni verildi! Artık botu ve canlı ses özelliğini kullanabilir.`, { parse_mode: 'Markdown' });
  });

  /**
   * /cikar <ID> - Bir kullanıcının iznini kaldırma (SADECE ADMIN)
   */
  bot.command('cikar', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply('⛔ Bu komutu sadece bot yöneticisi kullanabilir.');
    }

    const targetId = ctx.match.trim();
    if (String(targetId) === String(ADMIN_TELEGRAM_ID)) {
      return ctx.reply('⚠️ Kendi yönetici ID\'nizi listeden çıkaramazsınız.');
    }

    if (allowedUsers.has(String(targetId))) {
      allowedUsers.delete(String(targetId));
      saveWhitelist();
      await ctx.reply(`🗑️ *${targetId}* ID'li kullanıcının yetkisi kaldırıldı.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('⚠️ Bu ID zaten izinli kullanıcılar listesinde bulunamadı.');
    }
  });

  /**
   * /liste - İzinli tüm kullanıcıları görme (SADECE ADMIN)
   */
  bot.command('liste', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply('⛔ Bu komutu sadece bot yöneticisi kullanabilir.');
    }

    const list = Array.from(allowedUsers);
    let msg = `📋 *İzinli Kullanıcılar Listesi (${list.length} kişi):*\n\n`;
    list.forEach((id, index) => {
      const isMe = id === String(ADMIN_TELEGRAM_ID) ? ' 👑 (Yönetici)' : '';
      msg += `${index + 1}. \`${id}\`${isMe}\n`;
    });

    msg += `\n_Yeni kişi eklemek için:_ \`/ekle <ID>\`\n_Kişi silmek için:_ \`/cikar <ID>\``;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.start({
    onStart: (botInfo) => {
      console.log(`🤖 Telegram Botu aktif: @${botInfo.username}`);
      console.log(`🔒 Güvenlik: Admin ID: ${ADMIN_TELEGRAM_ID || 'TANIMLANMADI (Herkese Açık)'}`);
    }
  }).catch((err) => {
    console.error('❌ Bot hatası:', err.message);
  });
}

// ----------------------------------------------------------------------------
// 5. HTTP UPGRADE -> WEBSOCKET
// ----------------------------------------------------------------------------
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
// 6. GÖRÜŞME ÖZETİ ÜRETME VE TELEGRAM'A GÖNDERME
// ----------------------------------------------------------------------------
async function generateAndSendSummary(chatId, userName, transcripts, durationSeconds) {
  if (!transcripts || transcripts.length === 0) return;

  const durationFormatted = `${Math.floor(durationSeconds / 60)} dk ${durationSeconds % 60} sn`;
  const conversationText = transcripts.map(t => `${t.speaker}: ${t.text}`).join('\n');

  let summaryMarkdown = '';

  try {
    if (GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
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
      if (generatedText) summaryMarkdown = generatedText;
    }
  } catch (err) {
    console.error('Özet üretirken hata:', err.message);
  }

  if (!summaryMarkdown) {
    summaryMarkdown = `📌 **Görüşme Özeti:**\nKullanıcı ve asistan canlı sesli sohbet gerçekleştirdi.\n\n📝 **Transkript:**\n` +
      transcripts.slice(-6).map(t => `• *${t.speaker}*: ${t.text}`).join('\n');
  }

  const finalMessage = 
    `🎙️ *Canlı Görüşme Tamamlandı*\n` +
    `👤 *Kullanıcı:* ${userName}\n` +
    `⏱️ *Görüşme Süresi:* ${durationFormatted}\n` +
    `────────────────────\n\n` +
    `${summaryMarkdown}`;

  if (bot && chatId && chatId !== 'demo_user') {
    try {
      await bot.api.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });
      console.log(`✅ Özet gönderildi: Chat ID ${chatId}`);
    } catch (e) {
      try {
        await bot.api.sendMessage(chatId, finalMessage);
      } catch (err) {
        console.error('Mesaj iletme hatası:', err.message);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 7. WEBSOCKET BAĞLANTISI (YETKİ KORUMALI)
// ----------------------------------------------------------------------------
wss.on('connection', (clientWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const chatId = url.searchParams.get('chatId') || 'demo_user';
  const userName = url.searchParams.get('userName') || 'Kullanıcı';

  // 🔒 GÜVENLİK KONTROLÜ: Gelen kullanıcı listede yoksa WebSocket'i anında kapat!
  if (!isAuthorized(chatId)) {
    console.warn(`⛔ Yetkisiz ses bağlantı denemesi engellendi! Chat ID: ${chatId}`);
    clientWs.send(JSON.stringify({ 
      type: 'unauthorized', 
      error: 'Bu asistan özeldir. Erişim yetkiniz bulunmamaktadır.' 
    }));
    clientWs.close(4003, 'Yetkisiz Erisim');
    return;
  }

  console.log(`🔗 Yetkili ses bağlantısı açıldı: Chat ID ${chatId} (${userName})`);

  const transcripts = [];
  let duration = 0;
  let geminiWs = null;

  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
    geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
      const setupMessage = {
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Puck' }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: 'Sen Telegram üzerinden kullanıcıyla canlı sesli sohbet eden son derece akıcı, zeki ve samimi bir yapay zeka asistanısın. Türkçe konuşuyorsun. Yanıtlarını konuşma doğallığında ve öz tut. Kullanıcı araya girerse dinle. Kullanıcının planlarını aklında tut, görüşme bitince özet çıkarılacaktır.'
            }]
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMessage));
    });

  let chunkCount = 0;

  // Gemini'den gelen ses parçalarını ve olayları dinle
  geminiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      console.log('📥 Gemini Live Yanıtı:', JSON.stringify(response).substring(0, 250));

      // Hata durumunu yakala
      if (response.error) {
        console.error('❌ Gemini API Hatası:', JSON.stringify(response.error));
        return;
      }


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
              console.log('🤖 Gemini Metin:', part.text);
              transcripts.push({ speaker: 'Gemini', text: part.text });
            }
          }
        }

        // 2. Söz Kesme (Interruption): Kullanıcı model konuşurken lafa girdiğinde tetiklenir
        if (response.serverContent?.interrupted) {
          console.log('⚡ Interruption: Kullanıcı araya girdi.');
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

    geminiWs.on('error', (err) => console.error('❌ Gemini Live WebSocket Hatası:', err.message));
    geminiWs.on('close', (code, reason) => {
      console.log(`⚠️ Gemini Live WS kapandı. Kod: ${code}, Sebep: ${reason?.toString() || 'Bilinmiyor'}`);
    });

  }

  clientWs.on('message', (message, isBinary) => {
    if (isBinary) {
      if (chunkCount++ % 50 === 0) {
        console.log(`🎙️ Mikrofondan ses alınıyor ve Gemini'ye aktarılıyor (Paket #${chunkCount}, Boyut: ${message.length} bayt)...`);
      }
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        const base64Audio = message.toString('base64');
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{
              mimeType: 'audio/pcm;rate=16000',
              data: base64Audio
            }]
          }
        }));
      } else {
        if (chunkCount % 50 === 0) {
          console.warn('⚠️ Gemini Live WebSocket açık değil! Hazır durumu:', geminiWs?.readyState);
        }
      }
    } else {

      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === 'end_call') {
          duration = payload.duration || 0;
        }
      } catch (e) {}
    }
  });

  clientWs.on('close', async () => {
    console.log(`🔌 Mini App bağlantısı kapandı: Chat ID ${chatId}`);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
    await generateAndSendSummary(chatId, userName, transcripts, duration);
  });
});

// Sunucuyu başlat
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Telegram Gemini Live Sunucusu Aktif!`);
  console.log(`🔒 Yönetici ID: ${ADMIN_TELEGRAM_ID || 'AYARLANMADI (Herkese Açık Mod)'}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📱 Mini App URL: ${WEBAPP_URL}`);
  console.log(`======================================================\n`);
});
