/**
 * ============================================================================
 * DOSYA ADI: audio-worklet-processor.js
 * AMACI: Web Audio API AudioWorklet İş Parçacığı (Audio Thread)
 * ============================================================================
 * 
 * BU DOSYA NEDEN VAR VE NASIL ÇALIŞIR?
 * ----------------------------------------------------------------------------
 * 1. Normal JavaScript kodları tarayıcının "Ana İş Parçacığında" (Main Thread) çalışır.
 *    Eğer sayfada ağır bir animasyon oynarsa veya kullanıcı ekrana dokunursa, ana thread
 *    bir anlığına meşgul olur ve konuşulan seste "cızırtı, takılma, atlama" yaşanır.
 * 
 * 2. AudioWorklet ise tarayıcının doğrudan "Ses İşlemci Çekirdeğinde" bağımsız çalışır.
 *    Arayüz donarsa bile bu dosya arka planda mikrofondan gelen sesi ve yapay zekanın
 *    cevap sesini sıfır gecikmeyle (ultra low-latency) ve pürüzsüzce işlemeye devam eder.
 * 
 * 3. Çift Yönlü İletişim (Full-Duplex):
 *    - Kullanıcının mikrofondan gelen sesini yakalar ve ana ekrana (app.js) iletir.
 *    - Gemini'den gelen ses parçalarını bir kuyrukta (queue) toplar ve hoparlörden çalar.
 *    - Kullanıcı yapay zekanın sözünü kestiğinde (Interruption), çalınmayı bekleyen
 *      tüm eski sesleri anında temizler (clear_audio).
 * ============================================================================
 */

class LiveAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Çalınmayı bekleyen ses parçalarının toplandığı FIFO kuyruğu
    this.outputQueue = [];

    // Mikrofonun susturulup susturulmadığı bilgisi (Mute durumu)
    this.isMuted = false;

    /**
     * Ana iş parçacığından (app.js) gelen emirleri dinleyen mesaj portu.
     * Buradan 3 farklı komut gelebilir:
     * - 'queue_audio': Gemini'den yeni bir ses parçası geldi, hoparlör kuyruğuna ekle.
     * - 'clear_audio': Kullanıcı araya girdi (söz kesti), bekleyen sesleri hemen sil!
     * - 'set_mute': Kullanıcı mikrofona bastı, sustur veya sesi geri aç.
     */
    this.port.onmessage = (event) => {
      const data = event.data;

      // 1. Durum: Gemini'den gelen yeni ses verisini çalma kuyruğuna ekle
      if (data.type === 'queue_audio') {
        this.outputQueue.push(data.samples);
      } 
      // 2. Durum: Söz kesme (Interruption) sinyali - bekleyen sesleri anında çöpe at
      else if (data.type === 'clear_audio') {
        this.outputQueue = [];
      } 
      // 3. Durum: Mikrofonu sessize al / sesi aç
      else if (data.type === 'set_mute') {
        this.isMuted = data.isMuted;
      }
    };
  }

  /**
   * process() Fonksiyonu:
   * Tarayıcının ses motoru tarafından saniyede binlerce kez (her 128 örnekte bir) çağrılır.
   * 
   * @param {Array} inputs - Mikrofondan gelen ses blokları (Float32Array)
   * @param {Array} outputs - Hoparlöre gönderilecek ses blokları (Float32Array)
   * @param {Object} parameters - Ses parametreleri
   * @returns {boolean} true döndüğü sürece bu işlemci canlı kalır.
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // ------------------------------------------------------------------------
    // ADIM 1: Mikrofondan Gelen Sesi Yakalama (Giriş)
    // ------------------------------------------------------------------------
    // Kullanıcı susturulmamışsa (isMuted = false) ve mikrofondan veri geliyorsa:
    if (input && input[0] && !this.isMuted) {
      const channelData = input[0];

      // Ses verisini bir Float32Array kopyası olarak ana iş parçacığına (app.js) postala.
      // app.js bu veriyi 16-bit PCM Linear formatına çevirip WebSocket ile Gemini'ye aktaracak.
      this.port.postMessage({
        type: 'mic_data',
        samples: new Float32Array(channelData)
      });
    }

    // ------------------------------------------------------------------------
    // ADIM 2: Gemini'nin Sesini Hoparlörden Oynatma (Çıkış)
    // ------------------------------------------------------------------------
    // Eğer hoparlör çıkış kanalı hazırsa ve kuyrukta bekleyen ses varsa:
    if (output && output[0]) {
      const outputChannel = output[0];
      let samplesNeeded = outputChannel.length; // Hoparlörün o an çalmak istediği örnek sayısı (genelde 128)
      let outputOffset = 0;

      // Kuyruktaki ses parçalarından sırayla doldur
      while (samplesNeeded > 0 && this.outputQueue.length > 0) {
        const currentChunk = this.outputQueue[0];
        const samplesToTake = Math.min(samplesNeeded, currentChunk.length);

        // Kuyruktaki sesi hoparlör tamponuna (buffer) kopyala
        outputChannel.set(currentChunk.subarray(0, samplesToTake), outputOffset);

        outputOffset += samplesToTake;
        samplesNeeded -= samplesToTake;

        // Eğer kuyruktaki bu parçanın tamamı çalındıysa listeden çıkar,
        // bir kısmı kaldıysa kalanı sonraki döngü için tut.
        if (samplesToTake === currentChunk.length) {
          this.outputQueue.shift();
        } else {
          this.outputQueue[0] = currentChunk.subarray(samplesToTake);
        }
      }

      // Eğer kuyrukta ses bitti ama hoparlör hala veri bekliyorsa (ses kesintisi/underrun),
      // cızırtı çıkmaması için kalan boşluğu 0 (tam sessizlik) ile doldur.
      if (samplesNeeded > 0) {
        outputChannel.subarray(outputOffset).fill(0);
      }
    }

    // İşlemcinin sürekli çalışmaya devam etmesi için true döndür
    return true;
  }
}

// Bu işlemciyi 'live-audio-processor' adıyla tarayıcının ses sistemine kaydet
registerProcessor('live-audio-processor', LiveAudioWorkletProcessor);
