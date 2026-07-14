// ===========================================================
// DERS AI - BACKEND SUNUCUSU
// ===========================================================
// Bu dosya, Flutter uygulaması ile Gemini API arasında duran
// "güvenli aracı" görevi görür. API key'imiz burada saklanır,
// telefon uygulaması bu key'i HİÇBİR ZAMAN görmez.
//
// Akış: Flutter uygulaması -> bu sunucu -> Gemini API -> bu sunucu -> Flutter uygulaması
// ===========================================================

require('dotenv').config(); // .env dosyasındaki gizli bilgileri (API key gibi) okur

const express = require('express'); // basit bir web sunucusu kurmamızı sağlayan kütüphane
const cors = require('cors'); // Flutter uygulamasının bu sunucuya istek atmasına izin verir
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini API'sine bağlanmamızı sağlayan resmi araç

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API'sine bağlanmak için kullanacağımız "istemci" (client)
// API key'i .env dosyasından okunuyor, koda asla yazılmıyor
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(cors());
app.use(express.json()); // gelen isteklerin JSON formatında okunmasını sağlar

// ---------------------------------------------------------
// SİSTEM PROMPTU - AI'nin "nasıl davranması gerektiği" talimatı
// Bu, uygulamanın gerçek "kalbi" - öğrenciye asla direkt cevap
// vermeyen, adım adım rehberlik eden bir öğretmen gibi davranmasını sağlıyor
// ---------------------------------------------------------
const SISTEM_PROMPTU = `You are an expert tutor inside a learning app. Your job is not just to give answers — it is to make students genuinely understand. You adapt to any subject: math, physics, biology, chemistry, history, languages, anything.

IDENTITY:
Your name is Lulara. You are the AI tutor built into the Lulara app — a personal learning companion designed to help students study, understand concepts deeply, prepare for exams, and research topics.
If a student asks who you are, what your name is, or what you do, answer naturally and briefly as Lulara: introduce yourself by name, and explain that you're here to help them learn — through chat explanations, quizzes, flashcards, and research. Do not say you are "an AI assistant" or "a language model" — you are Lulara.
Keep this introduction short and natural, not a long speech. Only bring it up when asked, or briefly on a first greeting if relevant — don't repeat it unprompted in every message.

STEP 1: READ THE QUESTION

Before responding, classify the question:

TYPE A - Simple/Direct: A definition, a yes/no, a date, a short fact, a direct calculation request.
Respond in plain flowing text. NO step boxes. Just answer clearly and naturally.

TYPE B - Complex/Process: A multi-step problem, a mechanism, a proof, a concept that needs building up, anything with 3+ logical stages.
Use the step system below.

If you are unsure, default to TYPE A. Less is more.

STEP 2: HOW TO RESPOND

TYPE A - Plain response:
Write naturally like a smart tutor talking to a student. Be warm, direct, and clear.
If it is a solve/calculate request: work through it, show the answer, done. End with "Any questions about this?" nothing else.
If it is a concept question: give the intuition first, then the mechanics, then a concrete example. Optional: mention a common mistake students make.

TYPE B - Step system:
Use this exact format, no variations:

[ADIM]
Step title (3-6 words)
---
Step content. Write real substance here: intuition, mechanics, example. No filler. No questions inside steps.
[/ADIM]

Rules for steps:
- Each step = ONE idea. If you are writing more than 4 sentences, split it.
- Last step must contain the final answer or conclusion. Never end with a question.
- Minimum 2 steps, maximum 7.
- Never put a question inside a step. Steps teach, they do not ask.

STEP 3: QUALITY CHECK

Before sending your response, ask yourself:
- Did I actually explain WHY, not just WHAT?
- Did I give a concrete example or analogy?
- If it was a solve request, is the final answer clearly stated?
- Am I ending with a question when I should not be?

TEACHING STYLE

- Start with intuition: "Think of it like..." or "Here is why this exists..."
- Use concrete examples from real life, not abstract ones
- Occasionally mention: "Most students get confused here because..."
- Never say "Great question!" or similar empty phrases
- Be direct. Do not over-explain simple things.
- If a student says "I do not understand", try a completely different angle, do not repeat yourself

SPECIAL CASES

Student says "solve/calculate/find the answer": Work it out step by step (use TYPE B if multi-step), give the final answer clearly, ask "Any questions?" that is it.

Student says "I do not know" twice in a row: Stop asking questions. Just explain it directly.

Student explicitly asks you to just explain: Switch immediately to full explanation mode, no leading questions.

LANGUAGE:
Always follow the DİL TALİMATI (language instruction) provided separately for this conversation — it takes priority over any other language signal, including the language the student types in.

OPTIONAL TAGS:
After fully covering a topic, you may add at the end:
[ONERI:kart|konu=topic_name] to suggest flashcards
[ONERI:quiz|konu=topic_name] to suggest a quiz
Only use these when a topic is genuinely complete. Not after every message.

VISUALS:
For coordinate geometry: [GORSEL:koordinat|noktalar=(x1,y1)|cizgi=(x1,y1)-(x2,y2)]
For number lines: [GORSEL:sayidogrusu|nokta=5|aralik=2,8]
Max 1 visual per response. Only when it genuinely helps.`;

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash', // hızlı ve ucuz model, ders sorularına yetiyor
  systemInstruction: SISTEM_PROMPTU,
});

// ---------------------------------------------------------
// STREAMING ENDPOINT - kelime kelime akıcı cevap
// ---------------------------------------------------------
app.post('/sohbet-stream', async (req, res) => {
  try {
    const { mesajlar, dil } = req.body;

    const dilAdlari = {
      'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish',
    };
    const appDili = dilAdlari[dil] || 'English';
    const desteklenenler = Object.values(dilAdlari).join(', ');

    const dilTalimati = `The app's selected language is ${appDili}. You MUST respond in ${appDili} ALWAYS, regardless of what language the student writes in. Do not switch languages based on their input.

If the student writes in a DIFFERENT language than ${appDili}, but that language IS one the app supports (${desteklenenler}), respond ONLY with a short, friendly message in ${appDili} asking them to change the app language in Settings if they want to chat in that language instead. Do not answer their actual question in this case.

If the student writes in a language that is NOT one of the app's supported languages (${desteklenenler}), respond with a short, friendly message in ${appDili} saying that language isn't supported by the app yet, but they're welcome to continue in ${appDili} or switch to one of the supported languages in Settings. Do not answer their actual question in this case.

If the student writes in ${appDili} (matching the app language), respond normally as instructed above.`;

    const sohbetModeli = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SISTEM_PROMPTU + '\n\nDİL TALİMATI: ' + dilTalimati,
    });

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    const mesajlarKarsilamaHaric = mesajlar.slice(1);
    const geminiGecmisi = mesajlarKarsilamaHaric.slice(0, -1).map((m) => {
      const parts = [];
      if (m.metin && m.metin.trim()) parts.push({ text: m.metin });
      if (m.fotografBase64 && m.fotografMimeTipi) {
        parts.push({ inlineData: { mimeType: m.fotografMimeTipi, data: m.fotografBase64 } });
      }
      return { role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] };
    });

    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    if (sonMesajVerisi.metin && sonMesajVerisi.metin.trim()) {
      sonMesajParts.push({ text: sonMesajVerisi.metin });
    }
    if (sonMesajVerisi.fotografBase64 && sonMesajVerisi.fotografMimeTipi) {
      sonMesajParts.push({ inlineData: { mimeType: sonMesajVerisi.fotografMimeTipi, data: sonMesajVerisi.fotografBase64 } });
    }
    if (sonMesajParts.length === 0) sonMesajParts.push({ text: 'Bu görseli incele.' });

    // SSE header'ları
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sohbet = sohbetModeli.startChat({ history: geminiGecmisi });
    const streamSonuc = await sohbet.sendMessageStream(sonMesajParts);

    let hamCevap = '';
    for await (const chunk of streamSonuc.stream) {
      const metin = chunk.text();
      if (metin) {
        hamCevap += metin;
        // Her chunk'ı SSE olarak gönder
        res.write(`data: ${JSON.stringify({ chunk: metin })}\n\n`);
      }
    }

    // Stream bitti — adım ve önerileri işle
    const adimlar = _adimlariAyikla(hamCevap);
    const oneriler = _onerileriAyikla(hamCevap);
    const gorsel = _gorselEtiketiniAyikla(hamCevap);

    let girisCumlesi = hamCevap;
    if (adimlar.length > 0) {
      const ilkEtiket = hamCevap.indexOf('[ADIM]');
      girisCumlesi = ilkEtiket > 0 ? hamCevap.substring(0, ilkEtiket).replace(/\[ONERI:[^\]]*\]/g, '').trim() : '';
    } else {
      girisCumlesi = hamCevap.replace(/\[GORSEL:[^\]]*\]/g, '').replace(/\[ONERI:[^\]]*\]/g, '').trim();
    }

    // Son veri paketi — adımlar ve öneri butonları için
    res.write(`data: ${JSON.stringify({ bitti: true, cevap: girisCumlesi, adimlar, gorsel, oneriler })}\n\n`);
    res.end();

  } catch (hata) {
    console.error('Stream hatası:', hata);
    if (!res.headersSent) {
      res.status(500).json({ hata: 'Cevap üretilemedi.' });
    } else {
      res.write(`data: ${JSON.stringify({ hata: true })}\n\n`);
      res.end();
    }
  }
});

// ---------------------------------------------------------
// ANA ENDPOINT - Flutter uygulaması buraya soru gönderecek
// ---------------------------------------------------------
app.post('/sohbet', async (req, res) => {
  try {
    const { mesajlar, dil } = req.body;

    // Dil talimatını sistem promptuna ekle
    const dilAdlari = {
      'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish',
    };
    const appDili = dilAdlari[dil] || 'English';
    const desteklenenler = Object.values(dilAdlari).join(', ');

    const dilTalimati = `The app's selected language is ${appDili}. You MUST respond in ${appDili} ALWAYS, regardless of what language the student writes in. Do not switch languages based on their input.

If the student writes in a DIFFERENT language than ${appDili}, but that language IS one the app supports (${desteklenenler}), respond ONLY with a short, friendly message in ${appDili} asking them to change the app language in Settings if they want to chat in that language instead. Do not answer their actual question in this case.

If the student writes in a language that is NOT one of the app's supported languages (${desteklenenler}), respond with a short, friendly message in ${appDili} saying that language isn't supported by the app yet, but they're welcome to continue in ${appDili} or switch to one of the supported languages in Settings. Do not answer their actual question in this case.

If the student writes in ${appDili} (matching the app language), respond normally as instructed above.`;

    const sohbetModeli = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SISTEM_PROMPTU + '\n\nDİL TALİMATI: ' + dilTalimati,
    });

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    const mesajlarKarsilamaHaric = mesajlar.slice(1);

    // Geçmiş mesajları Gemini formatına çeviriyoruz.
    // Fotoğraf içeren mesajlar için hem metin hem de inlineData (görsel) parts ekliyoruz.
    const geminiGecmisi = mesajlarKarsilamaHaric.slice(0, -1).map((m) => {
      const parts = [];
      if (m.metin && m.metin.trim()) parts.push({ text: m.metin });
      if (m.fotografBase64 && m.fotografMimeTipi) {
        parts.push({ inlineData: { mimeType: m.fotografMimeTipi, data: m.fotografBase64 } });
      }
      return { role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] };
    });

    // Son mesaj - metin ve/veya fotoğraf içerebilir
    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    if (sonMesajVerisi.metin && sonMesajVerisi.metin.trim()) {
      sonMesajParts.push({ text: sonMesajVerisi.metin });
    }
    if (sonMesajVerisi.fotografBase64 && sonMesajVerisi.fotografMimeTipi) {
      sonMesajParts.push({ inlineData: { mimeType: sonMesajVerisi.fotografMimeTipi, data: sonMesajVerisi.fotografBase64 } });
    }
    if (sonMesajParts.length === 0) sonMesajParts.push({ text: 'Bu görseli incele.' });

    const sohbet = sohbetModeli.startChat({ history: geminiGecmisi });
    const sonuc = await sohbet.sendMessage(sonMesajParts);
    const hamCevap = sonuc.response.text();

    // Önce [ADIM]...[/ADIM] etiketlerini ayıklıyoruz. Eğer AI adım kartları
    // kullandıysa, cevabı bir "adimlar" listesi olarak göndereceğiz.
    // Kullanmadıysa (basit bir açıklamaysa), eskisi gibi düz metin + görsel olarak göndeririz.
    const adimlar = _adimlariAyikla(hamCevap);
    // Öneri etiketlerini her durumda ayıkla
    const oneriler = _onerileriAyikla(hamCevap);

    if (adimlar.length > 0) {
      const ilkEtiketIndeksi = hamCevap.indexOf('[ADIM]');
      const girisCumlesi = hamCevap.substring(0, ilkEtiketIndeksi).replace(/\[ONERI:[^\]]*\]/g, '').trim();
      res.json({ cevap: girisCumlesi, adimlar, gorsel: null, oneriler });
    } else {
      const gorsel = _gorselEtiketiniAyikla(hamCevap);
      const temizMetin = hamCevap.replace(/\[GORSEL:[^\]]*\]/g, '').replace(/\[ONERI:[^\]]*\]/g, '').trim();
      res.json({ cevap: temizMetin, adimlar: null, gorsel, oneriler });
    }
  } catch (hata) {
    console.error('Gemini API hatası:', hata);
    res.status(500).json({ hata: 'AI servisine ulaşılamadı, lütfen tekrar dene.' });
  }
});

// ---------------------------------------------------------
// [ONERI:...] ETİKETLERİNİ AYIKLAYAN YARDIMCI FONKSİYON
// Örnek: [ONERI:kart|konu=türev] → { tur: 'kart', konu: 'türev' }
// ---------------------------------------------------------
function _onerileriAyikla(metin) {
  const oneriler = [];
  const desen = /\[ONERI:([^\]]*)\]/g;
  let eslesme;
  while ((eslesme = desen.exec(metin)) !== null) {
    const parcalar = eslesme[1].split('|');
    const tur = parcalar[0]; // 'kart' veya 'quiz'
    const konu = parcalar[1]?.split('=')[1] || '';
    oneriler.push({ tur, konu });
  }
  return oneriler.length > 0 ? oneriler : null;
}

// ---------------------------------------------------------
// [ADIM]...[/ADIM] ETİKETLERİNİ AYIKLAYAN YARDIMCI FONKSİYON
// Cevap içinde bu etiketler varsa, her birini { baslik, icerik, gorsel } şeklinde
// bir nesneye çevirip bir liste olarak döndürüyoruz. Yoksa boş liste döner.
// ---------------------------------------------------------
function _adimlariAyikla(metin) {
  const adimlar = [];

  // Format 1: [ADIM]...[/ADIM] — tercih edilen format
  const format1Deseni = /\[ADIM\]([\s\S]*?)\[\/ADIM\]/g;
  let eslesme;
  while ((eslesme = format1Deseni.exec(metin)) !== null) {
    const icerikTam = eslesme[1].trim();
    const ayracIndeksi = icerikTam.indexOf('---');
    let baslik, icerik;
    if (ayracIndeksi !== -1) {
      baslik = icerikTam.substring(0, ayracIndeksi).trim();
      icerik = icerikTam.substring(ayracIndeksi + 3).trim();
    } else {
      // --- yoksa ilk satırı başlık, gerisini içerik kabul et
      const satirlar = icerikTam.split('\n');
      baslik = satirlar[0].trim();
      icerik = satirlar.slice(1).join('\n').trim() || icerikTam;
    }
    if (!icerik) icerik = baslik;
    const gorsel = _gorselEtiketiniAyikla(icerik);
    const temizIcerik = icerik.replace(/\[GORSEL:[^\]]*\]/g, '').trim();
    adimlar.push({ baslik, icerik: temizIcerik, gorsel });
  }

  if (adimlar.length > 0) return adimlar;

  // Format 2: [ADIM]\nBaşlık\nİçerik\n[ADIM]... — kapanış etiketi olmadan
  const format2Deseni = /\[ADIM\]\s*\n([^\n]+)\n([\s\S]*?)(?=\[ADIM\]|\[\/ADIM\]|$)/g;
  while ((eslesme = format2Deseni.exec(metin)) !== null) {
    const baslik = eslesme[1].trim();
    const icerik = eslesme[2].trim();
    if (!baslik || !icerik) continue;
    const gorsel = _gorselEtiketiniAyikla(icerik);
    const temizIcerik = icerik.replace(/\[GORSEL:[^\]]*\]/g, '').trim();
    adimlar.push({ baslik, icerik: temizIcerik, gorsel });
  }

  return adimlar;
}

// ---------------------------------------------------------
// [GORSEL:...] ETİKETİNİ AYIKLAYAN YARDIMCI FONKSİYON
// AI'nin ürettiği metin içinde böyle bir etiket varsa, onu basit bir
// JavaScript nesnesine (object) çeviriyoruz. Yoksa null döndürüyoruz.
//
// Örnek girdi:  "[GORSEL:koordinat|noktalar=(2,3);(5,1)|cizgi=(2,3)-(5,1)]"
// Örnek çıktı:  { tur: 'koordinat', noktalar: [[2,3],[5,1]], cizgi: [[2,3],[5,1]] }
// ---------------------------------------------------------
function _gorselEtiketiniAyikla(metin) {
  const eslesme = metin.match(/\[GORSEL:([^\]]*)\]/);
  if (!eslesme) return null;

  const icerik = eslesme[1]; // "koordinat|noktalar=(2,3);(5,1)|cizgi=(2,3)-(5,1)"
  const parcalar = icerik.split('|');
  const tur = parcalar[0]; // "koordinat" ya da "sayidogrusu"

  const gorselVerisi = { tur };

  for (let i = 1; i < parcalar.length; i++) {
    const [anahtar, deger] = parcalar[i].split('=');
    if (!anahtar || !deger) continue;

    if (anahtar === 'noktalar') {
      // "(2,3);(5,1)" -> [[2,3],[5,1]]
      gorselVerisi.noktalar = deger.split(';').map((nokta) => {
        const [x, y] = nokta.replace(/[()]/g, '').split(',').map(Number);
        return [x, y];
      });
    } else if (anahtar === 'cizgi') {
      // "(2,3)-(5,1)" -> [[2,3],[5,1]]
      gorselVerisi.cizgi = deger.split('-').map((nokta) => {
        const [x, y] = nokta.replace(/[()]/g, '').split(',').map(Number);
        return [x, y];
      });
    } else if (anahtar === 'nokta') {
      gorselVerisi.nokta = Number(deger);
    } else if (anahtar === 'aralik') {
      gorselVerisi.aralik = deger.split(',').map(Number);
    }
  }

  return gorselVerisi;
}

// ---------------------------------------------------------
// QUIZ ENDPOINT - verilen konuda çoktan seçmeli veya açık uçlu soru üretir
// ---------------------------------------------------------
app.post('/quiz', async (req, res) => {
  try {
    const { konu, zorluk = 'orta', kacinilacakSorular = [] } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const kacinmaMetni = kacinilacakSorular.length > 0
      ? `\n\nÖNEMLİ: Aşağıdaki soruları TEKRAR SORMA, farklı bir soru üret:\n${kacinilacakSorular.map((s, i) => `${i+1}. ${s}`).join('\n')}`
      : '';

    const prompt = `Sen bir ders öğretmenisin. "${konu}" konusunda ${zorluk} zorluk seviyesinde bir sınav sorusu oluştur.${kacinmaMetni}

SADECE JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "soru": "soru metni buraya",
  "secenekler": ["A) seçenek", "B) seçenek", "C) seçenek", "D) seçenek"],
  "dogruCevap": "A) seçenek",
  "aciklama": "neden bu cevap doğru, kısa açıklama"
}

Eğer açık uçlu soru tercih edersen secenekler dizisini boş bırak: "secenekler": []
Her soruda sadece bir doğru cevap olsun. Aciklama 1-2 cümle olsun.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const soru = JSON.parse(text);
    res.json(soru);
  } catch (hata) {
    console.error('Quiz soru hatası:', hata);
    res.status(500).json({ hata: 'Quiz sorusu oluşturulamadı.' });
  }
});

// ---------------------------------------------------------
// QUIZ DEĞERLENDİRME ENDPOINT - açık uçlu sorularda öğrencinin cevabını değerlendirir
// ---------------------------------------------------------
app.post('/quiz-degerlendir', async (req, res) => {
  try {
    const { soru, dogruCevap, kullaniciCevabi } = req.body;

    const prompt = `Bir öğrenci şu soruya cevap verdi:

Soru: ${soru}
Doğru cevap: ${dogruCevap}
Öğrencinin cevabı: ${kullaniciCevabi}

SADECE JSON formatında yanıt ver:
{
  "dogru": true veya false,
  "geri_bildirim": "kısa, samimi, cesaretlendirici bir değerlendirme (1-2 cümle)"
}

Öğrenci doğru yönde ama eksik bir cevap verdiyse "dogru": true say ve eksiği tamamla.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const degerlendirme = JSON.parse(text);
    res.json(degerlendirme);
  } catch (hata) {
    console.error('Quiz değerlendirme hatası:', hata);
    res.status(500).json({ dogru: false, geri_bildirim: 'Could not evaluate answer.' });
  }
});

// ---------------------------------------------------------
// KART OLUŞTURMA ENDPOINT - verilen konuda flashcard üretir
// ---------------------------------------------------------
app.post('/kartlar-olustur', async (req, res) => {
  try {
    const { konu } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const prompt = `Sen bir ders öğretmenisin. "${konu}" konusunda 6 adet flashcard oluştur.

SADECE JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "kartlar": [
    {"on": "ön yüz - soru veya kavram", "arka": "arka yüz - cevap veya açıklama"},
    ...
  ]
}

Kurallar:
- Her kartın ön yüzü kısa bir soru veya kavram olsun (max 15 kelime)
- Her kartın arka yüzü net ve anlaşılır bir cevap olsun (max 30 kelime)
- Kartlar temel kavramları kapsamalı, ezbere değil anlamaya yönelik olmalı`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const veri = JSON.parse(text);
    res.json(veri);
  } catch (hata) {
    console.error('Kart oluşturma hatası:', hata);
    res.status(500).json({ hata: 'Kartlar oluşturulamadı.' });
  }
});

// ---------------------------------------------------------
// GÜNDEM ENDPOINT - genel bilim/öğrenme haberleri, 1 saatlik önbellek
// ---------------------------------------------------------
let _gundemOnbellek = { veri: null, zaman: 0 };
const GUNDEM_ONBELLEK_SURESI = 60 * 60 * 1000; // 1 saat (ms)

app.get('/gundem', async (req, res) => {
  try {
    const dil = req.query.dil || 'en';
    const simdi = Date.now();

    // Önbellek hâlâ tazeyse, direkt onu döndür — Gemini'ye gitme
    if (_gundemOnbellek.veri && (simdi - _gundemOnbellek.zaman) < GUNDEM_ONBELLEK_SURESI) {
      return res.json({ ..._gundemOnbellek.veri, onbellekten: true });
    }

    const dilAdlari = {
      'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish',
    };
    const appDili = dilAdlari[dil] || 'English';

    const gundemModeli = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
    });

    const prompt = `Find 8-10 current, interesting news items and articles from this week related to general science, learning, discovery, and knowledge — topics like physics, space, biology, history, philosophy, technology, psychology, or any subject a curious student would enjoy. Not narrowly limited to one field — mix it up.

Respond ONLY in ${appDili}, in this exact JSON format:
{
  "haberler": [
    {"baslik": "short catchy title", "kaynak": "source name", "url": "https://...", "ozet": "1 sentence summary"}
  ]
}
Prefer reputable sources (major science publications, universities, established news outlets). Keep titles short (under 12 words).`;

    const result = await gundemModeli.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();

    let veri;
    try {
      veri = JSON.parse(text);
    } catch {
      veri = { haberler: [] };
    }

    _gundemOnbellek = { veri, zaman: simdi };
    res.json({ ...veri, onbellekten: false });
  } catch (hata) {
    console.error('Gündem hatası:', hata);
    // Hata olursa, varsa eski önbelleği döndür (boş göstermektense)
    if (_gundemOnbellek.veri) {
      return res.json({ ..._gundemOnbellek.veri, onbellekten: true });
    }
    res.status(500).json({ hata: 'Gündem yüklenemedi.', haberler: [] });
  }
});

// ---------------------------------------------------------
// ARAŞTIRMA ENDPOINT
// ---------------------------------------------------------
app.post('/arastir', async (req, res) => {
  try {
    const { konu } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const arastirmaModeli = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
    });

    const prompt = `"${konu}" konusunu araştır ve SADECE JSON formatında yanıt ver:
{
  "ozet": "konunun 3-4 cümlelik anlaşılır özeti",
  "kaynaklar": [
    {"baslik": "kaynak başlığı", "url": "https://...", "aciklama": "1 cümle açıklama"}
  ],
  "sorular": ["sık sorulan soru 1", "soru 2", "soru 3"]
}
Max 5 kaynak. Güvenilir ve öğrenci için faydalı kaynaklar seç (Wikipedia, Khan Academy, vb.)`;

    const result = await arastirmaModeli.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();

    try {
      const veri = JSON.parse(text);
      res.json({ ...veri, konu });
    } catch {
      res.json({ konu, ozet: text.substring(0, 400), kaynaklar: [], sorular: [] });
    }
  } catch (hata) {
    console.error('Araştırma hatası:', hata);
    res.status(500).json({ hata: 'Araştırma yapılamadı.' });
  }
});

// ---------------------------------------------------------
// SAYFA ANALİZ ENDPOINT - gerçek sayfa metnini okuyarak cevaplar
// ---------------------------------------------------------
app.post('/sayfa-analiz', async (req, res) => {
  try {
    const { url, baslik, sayfaMetni, soru } = req.body;
    
    const metin = sayfaMetni 
      ? sayfaMetni.substring(0, 8000) // çok uzun metinleri kısalt
      : null;

    const baglamMetni = metin 
      ? `Sayfa başlığı: "${baslik}"\nURL: ${url}\n\nSayfa içeriği:\n${metin}`
      : `Sayfa başlığı: "${baslik}"\nURL: ${url}`;

    const prompt = soru
      ? `${baglamMetni}\n\nKullanıcının sorusu: ${soru}\n\nBu soruyu sayfa içeriğine dayanarak yanıtla. Kısa ve net ol.`
      : `${baglamMetni}\n\nBu sayfayı öğrenci için 3-4 cümlede özetle. Ana konuyu ve önemli noktaları vurgula.`;

    const result = await model.generateContent(prompt);
    res.json({ cevap: result.response.text() });
  } catch (hata) {
    console.error('Sayfa analiz hatası:', hata);
    res.status(500).json({ hata: 'Sayfa analiz edilemedi.' });
  }
});

// Sunucunun çalışıp çalışmadığını kontrol etmek için basit bir test adresi
app.get('/', (req, res) => {
  res.send('Ders AI backend çalışıyor ✅');
});

app.listen(PORT, () => {
  console.log(`Ders AI backend ${PORT} portunda çalışıyor`);
});