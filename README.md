# 🎙️ Telegram Gemini Live Asistanı

Telegram üzerinden **Gemini Live** benzeri gerçek zamanlı sesli sohbet etmenizi sağlayan, kasmayan, 60 FPS akıcı ve görüşme bittiğinde toplantı/sohbet notlarını otomatik olarak Telegram sohbetinize döküman/özet olarak ileten tam teşekküllü sistem.

---

## ✨ Özellikler

- 📞 **Canlı Sesli Görüşme (Full-Duplex):** Gemini 2.0 Multimodal Live API WebSocket desteği ile gecikmesiz (~300ms) çift yönlü konuşma.
- ⚡ **AudioWorklet ile Bağımsız Ses Motoru:** Ses işleme tarayıcının arayüz iş parçacığından ayrı çalışır; ekranda ne olursa olsun seste takılma/cızırtı olmaz.
- 🛑 **Söz Kesebilme (Interruption):** Model konuşurken siz konuşmaya başladığınız anda yapay zeka susar ve sizi dinler.
- 📊 **Otomatik Telegram Sohbet Çıktısı:** Aramayı kapattığınızda konuşulan tüm maddeler, alınan kararlar ve görev listesi formatlı Markdown mesajı olarak Telegram sohbetinize gelir.
- 🎨 **Modern Koyu Arayüz:** Canlı dalga animasyonu (Glowing Orb Canvas), Mute butonu ve çağrı süresi sayacı.

---

## 🚀 Hızlı Kurulum

### 1. Gereksinimler
- Node.js (v18+)
- Telegram Bot Token ([@BotFather](https://t.me/botfather) üzerinden 1 dakikada alınabilir)
- Google Gemini API Key ([Google AI Studio](https://aistudio.google.com/app/apikey))

### 2. Kurulum Adımları

Projeyi çalıştırmak için terminalde şu komutları uygulayın:

```bash
cd C:\Users\FATMAG\.gemini\antigravity\scratch\telegram-gemini-live
npm install
```

### 3. Yapılandırma (`.env`)

Proje kök dizininde `.env` dosyası oluşturun (`.env.example` dosyasından kopyalayabilirsiniz):

```env
TELEGRAM_BOT_TOKEN=buraya_botfather_tokeni_yazin
GEMINI_API_KEY=buraya_gemini_api_key_yazin
PORT=3000
WEBAPP_URL=https://sizin-https-adresiniz.ngrok-free.app
```

> ⚠️ **Not:** Telegram Mini App'lerin çalışabilmesi için **HTTPS** protokolü şarttır. Yerel test için aşağıdaki adımı uygulayın.

### 4. Yerel Test İçin HTTPS Tüneli Açma (Örn: Ngrok / Localtunnel)

Ayrı bir terminal penceresinde:
```bash
# Seçenek 1: ngrok
ngrok http 3000

# veya Seçenek 2: localtunnel (ücretsiz & hesapsız)
npx localtunnel --port 3000
```

Çıkan `https://...` linkini kopyalayıp `.env` dosyasındaki `WEBAPP_URL` kısmına yapıştırın.

### 5. Sunucuyu Başlatma

```bash
npm start
```

---

## 📱 Kullanım

1. Telegram'da oluşturduğunuz bota gidin.
2. `/start` yazın.
3. Bot size **"🎙️ Canlı Asistanı Başlat"** butonu gönderecektir.
4. Butona tıklayın: Telegram içinde tam ekran canlı arama penceresi açılır.
5. Doğrudan konuşun: *"Yarınki toplantı için ana gündem maddelerini çıkaralım ve yapılacakları planlayalım."*
6. Gemini anlık sesli cevap verir.
7. Kırmızı **Telefonu Kapat** butonuna bastığınızda pencere kapanır ve **özet rapor anında Telegram sohbetinizde belirir!**
