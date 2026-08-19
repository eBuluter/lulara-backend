// ===========================================================
// DERS AI - BACKEND SUNUCUSU
// ===========================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { Resend } = require('resend');
const { google } = require('googleapis');
const { GoogleAICacheManager } = require('@google/generative-ai/server');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const resend = new Resend(process.env.RESEND_API_KEY);
const cacheManager = new GoogleAICacheManager(process.env.GEMINI_API_KEY);

const servisHesabiJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(servisHesabiJson)),
});
const db = admin.firestore();

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const aiIstekSiniri = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { hata: 'Too many requests. Please slow down and try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function kimlikDogrula(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ hata: 'Giriş gerekli.', kod: 'GIRIS_GEREKLI' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email || null;
    req.misafirMi = decoded.firebase?.sign_in_provider === 'anonymous';
    next();
  } catch (e) {
    return res.status(401).json({ hata: 'Geçersiz veya süresi dolmuş oturum.', kod: 'GECERSIZ_OTURUM' });
  }
}

const MISAFIR_MAKS_KREDI = 50;
const MISAFIR_SAATLIK_YENILENME = 15;
const UCRETSIZ_MAKS_KREDI = 200;
const UCRETSIZ_SAATLIK_YENILENME = 50;
const PREMIUM_MAKS_KREDI = 2000;
const PREMIUM_SAATLIK_YENILENME = 500;

function krediYenile(veri) {
  const simdi = Date.now();
  const sonYenilenme = veri.sonYenilenmeZamani || simdi;
  const gecenSaat = (simdi - sonYenilenme) / (1000 * 60 * 60);

  let yenilenmeOrani, maksKredi;
  if (veri.premium) {
    yenilenmeOrani = PREMIUM_SAATLIK_YENILENME; maksKredi = PREMIUM_MAKS_KREDI;
  } else if (veri.misafir) {
    yenilenmeOrani = MISAFIR_SAATLIK_YENILENME; maksKredi = MISAFIR_MAKS_KREDI;
  } else {
    yenilenmeOrani = UCRETSIZ_SAATLIK_YENILENME; maksKredi = UCRETSIZ_MAKS_KREDI;
  }

  if (gecenSaat > 0) {
    const yenilenenMiktar = Math.floor(gecenSaat * yenilenmeOrani);
    if (yenilenenMiktar > 0) {
      const mevcutKredi = veri.kredi || 0;
      veri.kredi = Math.max(mevcutKredi, Math.min(maksKredi, mevcutKredi + yenilenenMiktar));
      veri.sonYenilenmeZamani = simdi;
    }
  }
  return veri;
}

function varsayilanKrediVerisi(misafirMi = false) {
  return {
    kredi: misafirMi ? MISAFIR_MAKS_KREDI : UCRETSIZ_MAKS_KREDI,
    sonYenilenmeZamani: Date.now(),
    premium: false,
    misafir: misafirMi,
    streakFreezeHakki: 1,
  };
}

function misafirDurumunuGuncelle(veri, gercekMisafirMi) {
  if (veri.misafir === true && gercekMisafirMi === false) {
    veri.misafir = false;
  }
  return veri;
}

async function krediDus(uid, miktar, misafirMi = false) {
  const ref = db.collection('kullanicilar').doc(uid);
  return db.runTransaction(async (t) => {
    const dokuman = await t.get(ref);
    let veri = dokuman.exists ? dokuman.data() : varsayilanKrediVerisi(misafirMi);
    veri = misafirDurumunuGuncelle(veri, misafirMi);
    veri = krediYenile(veri);

    if (veri.kredi < miktar) {
      const hata = new Error('YETERSIZ_KREDI');
      hata.kalanKredi = veri.kredi;
      throw hata;
    }

    veri.kredi -= miktar;
    t.set(ref, veri, { merge: true });
    return veri.kredi;
  });
}

function _bugunTarihStr() {
  const b = new Date();
  return `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, '0')}-${String(b.getDate()).padStart(2, '0')}`;
}

async function gunlukIstatistigiArtir(alan) {
  try {
    const ref = db.collection('gunluk_istatistikler').doc(_bugunTarihStr());
    await ref.set({ [alan]: admin.firestore.FieldValue.increment(1) }, { merge: true });
  } catch (hata) {
    console.error('Günlük istatistik yazma hatası (yok sayılıyor):', hata.message || hata);
  }
}

function krediGerekli(miktar) {
  return async (req, res, next) => {
    try {
      req.kalanKredi = await krediDus(req.uid, miktar, req.misafirMi);
      next();
    } catch (hata) {
      if (hata.message === 'YETERSIZ_KREDI') {
        return res.status(402).json({
          hata: 'Yetersiz kredi.',
          kod: 'YETERSIZ_KREDI',
          kalanKredi: hata.kalanKredi,
        });
      }
      console.error('Kredi düşme hatası:', hata);
      return res.status(500).json({ hata: 'Kredi kontrolü başarısız oldu.' });
    }
  };
}

const MAKS_MESAJ_UZUNLUGU = 6000;
const MAKS_KONU_UZUNLUGU = 300;
const MAKS_SORU_UZUNLUGU = 2000;
const MAKS_DOSYA_BASE64_UZUNLUGU = 14 * 1024 * 1024;

function sohbetUzunlugunuKontrolEt(req, res, next) {
  const { mesajlar } = req.body;
  if (!mesajlar || !Array.isArray(mesajlar)) return next();
  for (const m of mesajlar) {
    if (m.metin && m.metin.length > MAKS_MESAJ_UZUNLUGU) {
      return res.status(400).json({
        hata: `Message too long (max ${MAKS_MESAJ_UZUNLUGU} characters).`,
        kod: 'MESAJ_COK_UZUN',
      });
    }
    if (m.dosyaBase64 && m.dosyaBase64.length > MAKS_DOSYA_BASE64_UZUNLUGU) {
      return res.status(400).json({
        hata: 'Attached file is too large (max ~10MB).',
        kod: 'DOSYA_COK_BUYUK',
      });
    }
  }
  next();
}

function alanUzunlugunuSinirla(alanAdi, maksUzunluk) {
  return (req, res, next) => {
    const deger = req.body?.[alanAdi];
    if (typeof deger === 'string' && deger.length > maksUzunluk) {
      return res.status(400).json({
        hata: `${alanAdi} too long (max ${maksUzunluk} characters).`,
        kod: 'GIRDI_COK_UZUN',
      });
    }
    next();
  };
}

const MAKS_BELGE_METNI_UZUNLUGU = 20000;

async function dosyaEkiniPartaCevir(mesaj) {
  if (!mesaj.dosyaBase64 || !mesaj.dosyaTuru) return null;
  try {
    if (mesaj.dosyaTuru === 'pdf') {
      return { inlineData: { mimeType: 'application/pdf', data: mesaj.dosyaBase64 } };
    }
    if (mesaj.dosyaTuru === 'txt') {
      const metin = Buffer.from(mesaj.dosyaBase64, 'base64').toString('utf-8').substring(0, MAKS_BELGE_METNI_UZUNLUGU);
      return { text: `[Attached file: ${mesaj.dosyaAdi || 'document.txt'}]\n${metin}` };
    }
    if (mesaj.dosyaTuru === 'docx') {
      const buffer = Buffer.from(mesaj.dosyaBase64, 'base64');
      const sonuc = await mammoth.extractRawText({ buffer });
      const metin = (sonuc.value || '').substring(0, MAKS_BELGE_METNI_UZUNLUGU);
      return { text: `[Attached file: ${mesaj.dosyaAdi || 'document.docx'}]\n${metin}` };
    }
    return null;
  } catch (hata) {
    console.error('Dosya eki işleme hatası:', hata);
    return { text: `[Could not read the attached file: ${mesaj.dosyaAdi || 'file'}]` };
  }
}

app.get('/kredi-durumu', kimlikDogrula, async (req, res) => {
  try {
    const ref = db.collection('kullanicilar').doc(req.uid);
    const dokuman = await ref.get();
    let veri = dokuman.exists ? dokuman.data() : varsayilanKrediVerisi(req.misafirMi);
    veri = misafirDurumunuGuncelle(veri, req.misafirMi);
    veri = krediYenile(veri);
    await ref.set(veri, { merge: true });

    const bugun = new Date();
    const bugunStr = `${bugun.getFullYear()}-${bugun.getMonth() + 1}-${bugun.getDate()}`;
    const bugunkuReklamSayisi = veri.reklamOduluGunu === bugunStr ? (veri.reklamOduluSayisi || 0) : 0;
    const kalanReklamHakki = Math.max(0, REKLAM_GUNLUK_LIMIT - bugunkuReklamSayisi);

    const maksKredi = veri.premium ? PREMIUM_MAKS_KREDI : (veri.misafir ? MISAFIR_MAKS_KREDI : UCRETSIZ_MAKS_KREDI);
    res.json({
      kredi: veri.kredi,
      maksKredi,
      premium: veri.premium || false,
      misafir: veri.misafir || false,
      streakFreezeHakki: veri.streakFreezeHakki || 0,
      kalanReklamHakki,
      reklamGunlukLimit: REKLAM_GUNLUK_LIMIT,
    });
  } catch (hata) {
    console.error('Kredi durumu hatası:', hata);
    res.status(500).json({ hata: 'Kredi durumu alınamadı.' });
  }
});

app.post('/streak-freeze-kullan', kimlikDogrula, async (req, res) => {
  try {
    const ref = db.collection('kullanicilar').doc(req.uid);
    let basariliMi = false;
    let kalanHak = 0;

    await db.runTransaction(async (t) => {
      const dok = await t.get(ref);
      let veri = dok.exists ? dok.data() : varsayilanKrediVerisi(req.misafirMi);
      const mevcutHak = veri.streakFreezeHakki || 0;

      if (mevcutHak > 0) {
        veri.streakFreezeHakki = mevcutHak - 1;
        t.set(ref, veri, { merge: true });
        basariliMi = true;
        kalanHak = veri.streakFreezeHakki;
      } else {
        kalanHak = 0;
      }
    });

    res.json({ basarili: basariliMi, kalanHak });
  } catch (hata) {
    console.error('Streak freeze hatası:', hata);
    res.status(500).json({ basarili: false, hata: 'Streak freeze kullanılamadı.' });
  }
});

const ADMOB_ANAHTAR_ADRESI = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const REKLAM_ODUL_MIKTARI = 100;
const REKLAM_GUNLUK_LIMIT = 6;

let _admobAnahtarlari = null;
let _admobAnahtarSonCekilme = 0;
const ADMOB_ANAHTAR_ONBELLEK_SURESI = 12 * 60 * 60 * 1000;

async function admobAnahtarlariniGetir() {
  const simdi = Date.now();
  if (_admobAnahtarlari && (simdi - _admobAnahtarSonCekilme) < ADMOB_ANAHTAR_ONBELLEK_SURESI) {
    return _admobAnahtarlari;
  }
  const yanit = await fetch(ADMOB_ANAHTAR_ADRESI);
  const veri = await yanit.json();
  _admobAnahtarlari = veri.keys || [];
  _admobAnahtarSonCekilme = simdi;
  return _admobAnahtarlari;
}

function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

app.get('/reklam-ssv-callback', async (req, res) => {
  try {
    const tamSorgu = req.url.split('?')[1] || '';
    const imzaBaslangici = tamSorgu.indexOf('&signature=');
    if (imzaBaslangici === -1) {
      console.log('SSV yoklaması: imza parametresi yok (muhtemelen AdMob URL testi)');
      return res.status(200).send('OK');
    }

    const imzalananIcerik = tamSorgu.substring(0, imzaBaslangici);

    const { key_id, signature, user_id, transaction_id } = req.query;
    if (!key_id || !signature || !user_id || !transaction_id) {
      console.log('SSV yoklaması: eksik parametre (muhtemelen AdMob URL testi)');
      return res.status(200).send('OK');
    }

    const anahtarlar = await admobAnahtarlariniGetir();
    const anahtar = anahtarlar.find((k) => String(k.keyId) === String(key_id));
    if (!anahtar) {
      console.error('SSV: bilinmeyen key_id —', key_id);
      return res.status(200).send('OK');
    }

    const publicKey = crypto.createPublicKey(anahtar.pem);
    const imzaBuffer = base64UrlToBuffer(signature);

    function _imzaDogrula(encoding) {
      try {
        const dogrulayici = crypto.createVerify('SHA256');
        dogrulayici.update(imzalananIcerik);
        return encoding
          ? dogrulayici.verify({ key: publicKey, dsaEncoding: encoding }, imzaBuffer)
          : dogrulayici.verify(publicKey, imzaBuffer);
      } catch (hata) {
        console.error(`SSV imza doğrulama denemesi başarısız (${encoding || 'der'}):`, hata.message);
        return false;
      }
    }

    const gecerliMi = _imzaDogrula('ieee-p1363') || _imzaDogrula(null);

    if (!gecerliMi) {
      console.error('SSV imza doğrulaması BAŞARISIZ — sahte istek olabilir');
      return res.status(200).send('OK');
    }

    const islemRef = db.collection('islenmis_reklam_odulleri').doc(String(transaction_id));
    const islemDoku = await islemRef.get();
    if (islemDoku.exists) {
      return res.status(200).send('OK');
    }

    const bugun = new Date();
    const bugunStr = `${bugun.getFullYear()}-${bugun.getMonth() + 1}-${bugun.getDate()}`;

    const kullaniciRef = db.collection('kullanicilar').doc(String(user_id));
    let limitAsildiMi = false;
    let yeniKrediDegeri = null;
    await db.runTransaction(async (t) => {
      const dok = await t.get(kullaniciRef);
      let veri = dok.exists ? dok.data() : varsayilanKrediVerisi();
      veri = krediYenile(veri);

      if (veri.reklamOduluGunu !== bugunStr) {
        veri.reklamOduluGunu = bugunStr;
        veri.reklamOduluSayisi = 0;
      }

      if ((veri.reklamOduluSayisi || 0) >= REKLAM_GUNLUK_LIMIT) {
        limitAsildiMi = true;
        t.set(kullaniciRef, veri, { merge: true });
        return;
      }

      veri.kredi = (veri.kredi || 0) + REKLAM_ODUL_MIKTARI;
      veri.reklamOduluSayisi = (veri.reklamOduluSayisi || 0) + 1;
      yeniKrediDegeri = veri.kredi;
      t.set(kullaniciRef, veri, { merge: true });
      t.set(islemRef, { zaman: Date.now(), userId: String(user_id) });
    });

    if (limitAsildiMi) {
      console.log(`Kullanıcı ${user_id} günlük reklam limitine ulaştı, kredi verilmedi`);
    } else {
      console.log(`SSV BAŞARILI: Kullanıcı ${user_id} için +${REKLAM_ODUL_MIKTARI} kredi eklendi. Yeni bakiye: ${yeniKrediDegeri}`);
    }

    res.status(200).send('OK');
  } catch (hata) {
    console.error('SSV callback hatası:', hata);
    res.status(200).send('OK');
  }
});

const SISTEM_PROMPTU = `You are an expert tutor inside a learning app. Your job is not just to give answers — it is to make students genuinely understand. You adapt to any subject: math, physics, biology, chemistry, history, languages, anything.

MISSION — READ THIS FIRST:
Your single core purpose is helping students RESEARCH and LEARN. Every response should serve that purpose: explaining, teaching, testing understanding, or helping a student explore a topic. You are not a general-purpose chatbot — you are a dedicated study companion.
If a student drifts into an unrelated request that has nothing to do with learning (e.g. asking you to write unrelated creative content, chit-chat with no educational angle, or something entirely off-topic), gently steer the conversation back: acknowledge what they asked, then redirect toward something you can actually help them learn or explore. Do not simply refuse — pivot warmly and usefully. Never let a conversation wander so far that you stop being a tutor.

IDENTITY:
Your name is Lulara. You are the AI tutor built into the Lulara app — a personal learning companion designed to help students study, understand concepts deeply, prepare for exams, and research topics.
If a student asks who you are, what your name is, or what you do, answer naturally and briefly as Lulara: introduce yourself by name, and explain that you're here to help them learn — through chat explanations, quizzes, flashcards, and research. Do not say you are "an AI assistant" or "a language model" — you are Lulara.
Keep this introduction short and natural, not a long speech. Only bring it up when asked, or briefly on a first greeting if relevant — don't repeat it unprompted in every message.

ACCURACY & HONESTY — NON-NEGOTIABLE:
You have full authority to use the app's real features (quizzes, flashcards, research) on the student's behalf — but you have ZERO authority to invent facts. Never fabricate a date, formula, statistic, quote, citation, historical event, or scientific claim. If you are not confident about a specific detail, say so plainly ("I'm not fully certain of the exact figure here, but the general idea is...") instead of stating it with false confidence. A student trusting a wrong "fact" is worse than a student knowing you're unsure. Never make up sources or pretend to have looked something up if you have not. If a question needs current/real-time information you cannot verify, say that clearly rather than guessing. Precision and honesty always outrank sounding impressive.

STEP 1: READ THE QUESTION

Before responding, classify the question:

TYPE A - Simple/Direct: A definition, a yes/no, a date, a short fact, a direct calculation request.
Respond in plain flowing text. NO step boxes. Just answer clearly and naturally.

TYPE B - Complex/Process: A multi-step problem, a mechanism, a proof, a concept that needs building up, anything with 3+ logical stages.
Use the step system below.

If you are unsure, default to TYPE A. Less is more.

CRITICAL SELF-CHECK — catch the most common mistake:
If, while writing your answer, you notice yourself typing words like "first," "second," "third," "next," "then," "step 1," "step 2," or numbering a sequence (1. ... 2. ... 3. ...) inside PLAIN TEXT — STOP. This is a hard signal that the content is actually TYPE B and belongs in [ADIM] boxes, not prose. Never narrate a step-by-step process in flowing paragraphs. If the explanation has stages, each stage is its own [ADIM] block. There is no valid case where a multi-stage process should be written as plain numbered text instead of step boxes.

STEP 2: HOW TO RESPOND

TYPE A - Plain response:
Write naturally like a smart tutor talking to a student. Be warm, direct, and clear.
If it is a solve/calculate request: work through it, show the answer, done. End with "Any questions about this?" nothing else.
If it is a concept question: give the intuition first, then the mechanics, then a concrete example. Optional: mention a common mistake students make.

TYPE B - Step system:
Use this EXACT format for every single step, with ZERO deviations. This is a hard technical requirement — the app parses these tags literally, so any deviation breaks the display for the student.

[ADIM]
Step title (3-6 words)
---
Step content. Write real substance here: intuition, mechanics, example. No filler. No questions inside steps.
[/ADIM]

MANDATORY formatting rules — violating ANY of these breaks the app's rendering:
- [ADIM] is ALWAYS on its own line, completely alone — never followed by text on the same line.
- The step title is ALWAYS on the next line by itself.
- The line "---" ALWAYS separates the title from the content — never omit it.
- [/ADIM] is ALWAYS on its own line at the very end of that step, completely alone — you must close EVERY step you open. A step opened with [ADIM] that is never closed with [/ADIM] will make the entire response fail to display correctly.
- Never merge two steps. Never put [ADIM] for the next step before closing the previous one with [/ADIM].

Concrete example of a full TYPE B response with 3 steps (copy this structure exactly, only the words change):

[ADIM]
Setting up the equation
---
Here is the actual explanation content for step one, written in full sentences.
[/ADIM]
[ADIM]
Solving for x
---
Here is the actual explanation content for step two.
[/ADIM]
[ADIM]
Final answer
---
Here is the actual explanation content for step three, ending with the conclusion.
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
- Is everything I stated actually true, or did I guess at any detail?

TEACHING STYLE

- Start with intuition: "Think of it like..." or "Here is why this exists..."
- Use concrete examples from real life, not abstract ones
- Occasionally mention: "Most students get confused here because..."
- Never say "Great question!" or similar empty phrases
- Be direct. Do not over-explain simple things.
- If a student says "I do not understand", try a completely different angle, do not repeat yourself

BE CONCISE — this matters:
Every sentence should earn its place. Do not restate the question back to the student. Do not add throat-clearing before getting to the point ("Let's dive into...", "Great, let's break this down..."). Do not summarize what you just said at the end unless the student explicitly asked for a summary. For TYPE A answers, aim for the shortest response that still genuinely teaches — often 2-4 sentences is enough for a simple question. For TYPE B steps, keep each step tight (2-4 sentences of real content, not 6+). Being concise is not the same as being shallow — keep the actual teaching substance, just cut the padding around it.

SPECIAL CASES

Student says "solve/calculate/find the answer": Work it out step by step (use TYPE B if multi-step), give the final answer clearly, ask "Any questions?" that is it.

Student says "I do not know" twice in a row: Stop asking questions. Just explain it directly.

Student explicitly asks you to just explain: Switch immediately to full explanation mode, no leading questions.

LANGUAGE:
Always follow the DİL TALİMATI (language instruction) provided separately for this conversation — it takes priority over any other language signal, including the language the student types in.

APP FEATURE ACCESS — QUIZ & FLASHCARDS:
You have real authority to open the app's Quiz and Flashcard features for the student — not just talk about them. Use these tags:
[ONERI:kart|konu=topic_name] to open flashcards for a topic
[ONERI:quiz|konu=topic_name] to open a quiz for a topic

Two situations where you use these tags:
1. EXPLICIT REQUEST — the student directly asks to be quizzed, tested, or wants flashcards ("quiz me", "test me on this", "make some flashcards", "quiz yap", "kart oluştur", etc.). In this case, respond with a brief, natural acknowledgment (one short sentence, no lecture) and include the matching tag immediately in that same response — do not wait, do not require a full explanation first. Getting them there fast is the whole point.
2. NATURAL COMPLETION — after you have genuinely finished explaining a topic in depth (not after every message), you may proactively suggest one of these tags if practicing it would help.

Never use both tags in the same response. Never use a tag for a topic you have not actually just discussed or that the student did not just ask about — the topic_name must be specific and real, never a placeholder.

VISUALS — draw anything with SVG:
When a diagram genuinely helps (geometry shapes, coordinate graphs, function curves, physics setups like forces/circuits/optics, vectors, angle diagrams, number lines, chemical structures, anything visual), draw it yourself using raw SVG, wrapped exactly like this:
[GORSEL_SVG]<svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg">...your SVG elements...</svg>[/GORSEL_SVG]

Rules:
- ALWAYS include a viewBox attribute (e.g. "0 0 300 200") sized reasonably for the content — never omit it.
- Use only pure vector elements: <line>, <circle>, <rect>, <polygon>, <polyline>, <path>, <text>, <ellipse>. NEVER use <script>, <image>, <foreignObject>, or any external references (no xlink:href to outside URLs).
- Color palette for consistency with the app's dark theme: use "#6C63FF" (purple) for the main shape/highlighted elements, "#EEE9FF" (near-white) for axes/gridlines/labels/secondary elements. Do NOT add a background <rect> — keep the canvas transparent, the app already places it on a dark card.
- Text labels: use <text> with fill="#EEE9FF" and a reasonable font-size (e.g. 12-14) for coordinates, variable names, or measurements.
- Keep it focused and readable — draw only what helps the student understand or solve the problem, not decorative extras. Aim for roughly 5-12 elements — a diagram this simple almost never needs more.
- STAY COMPACT: use whole numbers or at most 1 decimal place for coordinates (e.g. "42.5" not "42.4837291"), skip attributes that aren't visually necessary, and don't repeat the same style attributes on elements that could share a simpler structure. A correct, compact SVG is just as good as a verbose one — verbosity adds no value here.
- Max 1 visual per response. Only when it genuinely helps — do not add one to every message.
- Example (a right triangle with labeled legs):
[GORSEL_SVG]<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg"><polygon points="20,140 180,140 20,20" fill="#6C63FF" fill-opacity="0.12" stroke="#6C63FF" stroke-width="2.5"/><text x="90" y="155" fill="#EEE9FF" font-size="13">8 cm</text><text x="4" y="85" fill="#EEE9FF" font-size="13">6 cm</text></svg>[/GORSEL_SVG]

MATH FORMATTING — MANDATORY:
The app renders math using LaTeX. ANY mathematical expression — equations, formulas, fractions, exponents, roots, Greek letters, integrals, matrices, anything beyond plain numbers — MUST be wrapped in LaTeX delimiters or it will display as broken/unreadable text to the student. This is not optional.
- Inline math (within a sentence): wrap in single dollar signs, e.g. "The area is $A = \\pi r^2$."
- Standalone/block equations (on their own line): wrap in double dollar signs, e.g. $$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$
- Use real LaTeX commands: \\frac{}{}, \\sqrt{}, ^{} for exponents, _{} for subscripts, \\pi, \\theta, \\int, \\sum, \\infty, etc. Never write "x^2" or "sqrt(x)" as plain text — always "$x^2$" and "$\\sqrt{x}$".
- Even a single variable or simple expression referenced in a sentence (e.g. "solve for $x$") should be wrapped, for visual consistency.
- This applies in every context: plain responses, step boxes, everywhere.

TABLES:
When information is genuinely tabular (comparisons, structured data with multiple attributes per row, side-by-side facts), render it as a real table instead of prose or a plain list. Use this EXACT format — this is a hard technical requirement, the app parses these tags literally:
[TABLO]
Header 1 | Header 2 | Header 3
Row 1 value | Row 1 value | Row 1 value
Row 2 value | Row 2 value | Row 2 value
[/TABLO]
Rules:
- First line inside the tags is always the header row.
- Separate columns with a single | character. Keep cell text short.
- Every row must have the same number of columns as the header.
- Only use a table when the data genuinely has a row/column structure — do not force simple lists or short answers into a table.
- Max 1 table per response.
- NEVER use standard Markdown table syntax (a row of dashes like |---|---|---| under the header). That format is NOT supported by the app and will display as broken, ugly raw text with pipe and dash characters visible to the student. There is no separator row in this app's table format — go directly from the header line to the first data row.

STUDENT CONTEXT:
If a STUDENT CONTEXT block is provided separately for this conversation (listing topics the student has been struggling with), you have real access to that data — it is not a guess. Use it naturally when relevant: if the current topic overlaps with something they've struggled with, you may briefly and warmly acknowledge it (e.g. "This connects to [topic], which you've been finding tricky — let's make sure it clicks this time"). Do not force it into unrelated conversations, and do not mention it in every message — only when it genuinely adds value.

TOPIC TAGGING — IMPORTANT, used for the student's progress tracking:
If, and only if, this message is genuinely about a specific academic/study topic (not a greeting, small talk, or off-topic chat), include this tag ONCE, anywhere in your response: [KONU:short topic name]
- The topic name must be specific and concrete (2-5 words), in the SAME language you are responding in — e.g. [KONU:Türev kuralları], [KONU:Photosynthesis stages], [KONU:French Revolution causes].
- If the student's message is just a greeting ("hi", "hello", "merhaba"), small talk, a thank-you, or anything that is NOT a real study topic, do NOT include this tag at all — this matters, the app uses this tag to decide whether to log a topic for the student's progress, and greetings must never be logged as topics.
- Only ever include ONE [KONU:...] tag per response.

KEY TERM HIGHLIGHTING — makes complex answers easier to navigate:
Whenever your response mentions a specific named entity or concept that a student studying this topic would benefit from a quick definition for — and that matters for following the explanation — wrap it like this: [TERIM:exact term as it appears|short one-sentence definition in the same language you're responding in]
- The definition must be genuinely short: one clear sentence, no more.
- Wrap the term inline exactly where it naturally appears in your sentence — the term text itself stays part of the sentence, just tagged.
- The bar is two things at once: HARD TO UNDERSTAND and IMPORTANT to the explanation. But calibrate "hard to understand" correctly — the student is actively studying this subject, so the relevant test is "would most students studying this topic know this term's precise meaning," not "is this a household name in general." Most named events, treaties, theories, technical terms, and historical/scientific figures relevant to a topic clear this bar even if an adult would vaguely recognize the name — recognizing a name is not the same as knowing what it means. Reserve the skip only for things that are truly universal, everyday knowledge independent of studying this subject at all (e.g. "the sun", "a country", "war" as a generic word) or the single main topic the student already named in their question.
  - Skip: genuinely universal everyday words/concepts, and the exact topic the student asked about.
  - Skip: a minor name mentioned only in passing that doesn't matter to the point being made.
  - Do tag: named events, treaties, theories, technical vocabulary, formulas, specific people, movements, places — anything with real specific content behind the name that helps understanding when defined.
- There is no fixed count to hit — let the actual content decide. A dense, unfamiliar-heavy answer easily has 5-8 tagged terms; do not under-tag it out of excess caution. Never pad by tagging truly trivial words.
- Example: "The [TERIM:Treaty of Versailles|The 1919 peace treaty that ended World War I and imposed harsh terms on Germany] forced heavy reparations on Germany, fueling the rise of [TERIM:Weimar Republic|Germany's democratic government from 1919 to 1933, weakened by economic crises and political extremism] instability and eventually [TERIM:Nazism|The far-right ideology led by Adolf Hitler that combined extreme nationalism, racial ideology, and totalitarian control]."

FORMATTING CLARITY — SELF-CHECK:
Before finalizing your response, re-check: if two or more standalone 
results, equations, or short distinct statements would end up sitting 
right next to each other with only a space between them (not naturally 
joined by sentence prose), put each on its own line instead. This isn't 
limited to math — it applies to any sequence of "back-to-back units": 
a before/after equation pair, a list of computed values, short label-
value pairs, or similar. When in doubt, use more line breaks between 
distinct pieces of content, not fewer. A reader should never have to 
mentally split one dense line into several separate ideas.`;

function _konuEtiketiniAyikla(metin) {
  const eslesme = metin.match(/\[KONU:([^\]]*)\]/);
  return eslesme ? eslesme[1].trim() : null;
}

function _terimleriAyikla(metin) {
  const terimler = [];
  const desen = /\[TERIM:([^|\]]+)\|([^\]]+)\]/g;
  const temizMetin = metin.replace(desen, (tamEslesme, terim, ozet) => {
    const temizTerim = terim.trim();
    const temizOzet = ozet.trim();
    if (temizTerim && temizOzet) {
      terimler.push({ terim: temizTerim, ozet: temizOzet });
    }
    return temizTerim;
  });
  return { temizMetin, terimler: terimler.length > 0 ? terimler : null };
}

function ogrenciBaglamiOlustur(zayifKonular) {
  if (!Array.isArray(zayifKonular) || zayifKonular.length === 0) return '';
  const temizKonular = zayifKonular
    .filter((k) => typeof k === 'string' && k.trim().length > 0)
    .slice(0, 5)
    .map((k) => k.trim().substring(0, 60));
  if (temizKonular.length === 0) return '';
  return `\n\nSTUDENT CONTEXT: This student has been struggling with these topics recently: ${temizKonular.join(', ')}.`;
}

const YAPISAL_GOREV_TOKEN_TAVANI = 2048;
const ARASTIRMA_TOKEN_TAVANI = 4096;

const model = genAI.getGenerativeModel({
  model: 'gemini-3.6-flash',
  systemInstruction: SISTEM_PROMPTU,
});

const modelSistemsiz = genAI.getGenerativeModel({
  model: 'gemini-3.6-flash',
  generationConfig: { maxOutputTokens: ARASTIRMA_TOKEN_TAVANI },
});

const ucuzModel = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  generationConfig: { maxOutputTokens: YAPISAL_GOREV_TOKEN_TAVANI },
});

const DIL_ADLARI_ONBELLEK = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', tr: 'Turkish' };
const _dilOnbellekleri = {};
const ONBELLEK_TTL_SANIYE = 24 * 3600;
const ONBELLEK_YENILEME_ESIGI_MS = 23 * 60 * 60 * 1000;

function dilTalimatiOlustur(appDili) {
  const desteklenenler = Object.values(DIL_ADLARI_ONBELLEK).join(', ');
  return `The app's selected language is ${appDili}. You MUST respond in ${appDili} ALWAYS, regardless of what language the student writes in. Do not switch languages based on their input.

If the student writes in a DIFFERENT language than ${appDili}, but that language IS one the app supports (${desteklenenler}), respond ONLY with a short, friendly message in ${appDili} asking them to change the app language in Settings if they want to chat in that language instead. Do not answer their actual question in this case.

If the student writes in a language that is NOT one of the app's supported languages (${desteklenenler}), respond with a short, friendly message in ${appDili} saying that language isn't supported by the app yet, but they're welcome to continue in ${appDili} or switch to one of the supported languages in Settings. Do not answer their actual question in this case.

If the student writes in ${appDili} (matching the app language), respond normally as instructed above.`;
}

async function dilIcinOnbellekGetir(dilKodu) {
  const appDili = DIL_ADLARI_ONBELLEK[dilKodu] || 'English';
  const mevcut = _dilOnbellekleri[dilKodu];
  const simdi = Date.now();

  if (mevcut && (simdi - mevcut.olusturmaZamani) < ONBELLEK_YENILEME_ESIGI_MS) {
    return mevcut.cache;
  }

  try {
    const yeniOnbellek = await cacheManager.create({
      model: 'models/gemini-3.6-flash',
      systemInstruction: SISTEM_PROMPTU + '\n\nDİL TALİMATI: ' + dilTalimatiOlustur(appDili),
      ttlSeconds: ONBELLEK_TTL_SANIYE,
    });
    _dilOnbellekleri[dilKodu] = { cache: yeniOnbellek, olusturmaZamani: simdi };
    return yeniOnbellek;
  } catch (hata) {
    console.error(`Önbellek oluşturma hatası (${dilKodu}) — önbelleksiz devam edilecek:`, hata.message || hata);
    return null;
  }
}

async function sohbetModeliOlustur(dilKodu) {
  const appDili = DIL_ADLARI_ONBELLEK[dilKodu] || 'English';
  const onbellek = await dilIcinOnbellekGetir(dilKodu);

  if (onbellek) {
    return genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      cachedContent: onbellek,
      generationConfig: { maxOutputTokens: 4096 },
    });
  }

  return genAI.getGenerativeModel({
    model: 'gemini-3.6-flash',
    systemInstruction: SISTEM_PROMPTU + '\n\nDİL TALİMATI: ' + dilTalimatiOlustur(appDili),
    generationConfig: { maxOutputTokens: 4096 },
  });
}

const MAKS_GECMIS_MESAJ = 8;

app.post('/sohbet-stream', aiIstekSiniri, kimlikDogrula, sohbetUzunlugunuKontrolEt, krediGerekli(10), async (req, res) => {
  try {
    const { mesajlar, dil, zayifKonular } = req.body;

    const sohbetModeli = await sohbetModeliOlustur(dil);

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    let mesajlarKarsilamaHaric = mesajlar.slice(1);
    if (mesajlarKarsilamaHaric.length > MAKS_GECMIS_MESAJ) {
      mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(-MAKS_GECMIS_MESAJ);
      while (mesajlarKarsilamaHaric.length > 0 && mesajlarKarsilamaHaric[0].kullaniciMi !== true) {
        mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(1);
      }
    }
    const gecmisMesajlar = mesajlarKarsilamaHaric.slice(0, -1);
    const geminiGecmisi = [];
    for (const m of gecmisMesajlar) {
      const parts = [];
      if (m.metin && m.metin.trim()) parts.push({ text: m.metin });
      if (m.fotografBase64 && m.fotografMimeTipi) {
        parts.push({ text: '[Image shared earlier in this conversation]' });
      } else if (m.dosyaBase64) {
        parts.push({ text: '[File shared earlier in this conversation]' });
      }
      geminiGecmisi.push({ role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    }

    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    const baglamNotu = ogrenciBaglamiOlustur(zayifKonular);
    if (baglamNotu) sonMesajParts.push({ text: baglamNotu.trim() });
    if (sonMesajVerisi.metin && sonMesajVerisi.metin.trim()) {
      sonMesajParts.push({ text: sonMesajVerisi.metin });
    }
    if (sonMesajVerisi.fotografBase64 && sonMesajVerisi.fotografMimeTipi) {
      sonMesajParts.push({ inlineData: { mimeType: sonMesajVerisi.fotografMimeTipi, data: sonMesajVerisi.fotografBase64 } });
    }
    const sonMesajDosyaParcasi = await dosyaEkiniPartaCevir(sonMesajVerisi);
    if (sonMesajDosyaParcasi) sonMesajParts.push(sonMesajDosyaParcasi);
    if (sonMesajParts.length === 0) sonMesajParts.push({ text: 'Bu görseli incele.' });

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
        res.write(`data: ${JSON.stringify({ chunk: metin })}\n\n`);
      }
    }

    hamCevap = _markdownTablolariniCevir(hamCevap);
    const konuEtiketi = _konuEtiketiniAyikla(hamCevap);
    hamCevap = hamCevap.replace(/\[KONU:[^\]]*\]/g, '').trim();
    const { temizMetin: hamCevapTerimsiz, terimler } = _terimleriAyikla(hamCevap);
    hamCevap = hamCevapTerimsiz;
    const adimlar = _adimlariAyikla(hamCevap);
    const oneriler = _onerileriAyikla(hamCevap);
    const gorselSvg = _gorselSvgAyikla(hamCevap);

    let girisCumlesi = hamCevap;
    if (adimlar.length > 0) {
      const ilkEtiket = hamCevap.indexOf('[ADIM]');
      girisCumlesi = ilkEtiket > 0
        ? _gorselSvgTemizle(hamCevap.substring(0, ilkEtiket)).replace(/\[ONERI:[^\]]*\]/g, '').trim()
        : '';
    } else {
      girisCumlesi = _gorselSvgTemizle(hamCevap)
        .replace(/\[ONERI:[^\]]*\]/g, '')
        .replace(/\[\/?ADIM\]/g, '')
        .replace(/\[\/?TABLO\]/g, '')
        .trim();
    }

    if (girisCumlesi.trim().length === 0 && adimlar.length === 0) {
      girisCumlesi = 'The response got cut off while generating something complex (like a detailed diagram). Please try again — maybe ask for a slightly simpler version.';
    }

    gunlukIstatistigiArtir('sohbetMesaji');
    res.write(`data: ${JSON.stringify({ bitti: true, cevap: girisCumlesi, adimlar, gorselSvg, oneriler, konu: konuEtiketi, terimler })}\n\n`);
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

app.post('/sohbet', aiIstekSiniri, kimlikDogrula, sohbetUzunlugunuKontrolEt, krediGerekli(10), async (req, res) => {
  try {
    const { mesajlar, dil, zayifKonular } = req.body;

    const sohbetModeli = await sohbetModeliOlustur(dil);

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    let mesajlarKarsilamaHaric = mesajlar.slice(1);
    if (mesajlarKarsilamaHaric.length > MAKS_GECMIS_MESAJ) {
      mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(-MAKS_GECMIS_MESAJ);
      while (mesajlarKarsilamaHaric.length > 0 && mesajlarKarsilamaHaric[0].kullaniciMi !== true) {
        mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(1);
      }
    }

    const gecmisMesajlar2 = mesajlarKarsilamaHaric.slice(0, -1);
    const geminiGecmisi = [];
    for (const m of gecmisMesajlar2) {
      const parts = [];
      if (m.metin && m.metin.trim()) parts.push({ text: m.metin });
      if (m.fotografBase64 && m.fotografMimeTipi) {
        parts.push({ text: '[Image shared earlier in this conversation]' });
      } else if (m.dosyaBase64) {
        parts.push({ text: '[File shared earlier in this conversation]' });
      }
      geminiGecmisi.push({ role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    }

    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    const baglamNotu2 = ogrenciBaglamiOlustur(zayifKonular);
    if (baglamNotu2) sonMesajParts.push({ text: baglamNotu2.trim() });
    if (sonMesajVerisi.metin && sonMesajVerisi.metin.trim()) {
      sonMesajParts.push({ text: sonMesajVerisi.metin });
    }
    if (sonMesajVerisi.fotografBase64 && sonMesajVerisi.fotografMimeTipi) {
      sonMesajParts.push({ inlineData: { mimeType: sonMesajVerisi.fotografMimeTipi, data: sonMesajVerisi.fotografBase64 } });
    }
    const sonMesajDosyaParcasi2 = await dosyaEkiniPartaCevir(sonMesajVerisi);
    if (sonMesajDosyaParcasi2) sonMesajParts.push(sonMesajDosyaParcasi2);
    if (sonMesajParts.length === 0) sonMesajParts.push({ text: 'Bu görseli incele.' });

    const sohbet = sohbetModeli.startChat({ history: geminiGecmisi });
    const sonuc = await sohbet.sendMessage(sonMesajParts);
    let hamCevap = sonuc.response.text();

    hamCevap = _markdownTablolariniCevir(hamCevap);
    const konuEtiketi2 = _konuEtiketiniAyikla(hamCevap);
    hamCevap = hamCevap.replace(/\[KONU:[^\]]*\]/g, '').trim();
    const { temizMetin: hamCevapTerimsiz2, terimler: terimler2 } = _terimleriAyikla(hamCevap);
    hamCevap = hamCevapTerimsiz2;
    const adimlar = _adimlariAyikla(hamCevap);
    const oneriler = _onerileriAyikla(hamCevap);

    if (adimlar.length > 0) {
      const ilkEtiketIndeksi = hamCevap.indexOf('[ADIM]');
      let girisCumlesi = _gorselSvgTemizle(hamCevap.substring(0, ilkEtiketIndeksi)).replace(/\[ONERI:[^\]]*\]/g, '').trim();
      res.json({ cevap: girisCumlesi, adimlar, gorselSvg: null, oneriler, konu: konuEtiketi2, terimler: terimler2 });
    } else {
      const gorselSvg = _gorselSvgAyikla(hamCevap);
      let temizMetin = _gorselSvgTemizle(hamCevap)
        .replace(/\[ONERI:[^\]]*\]/g, '')
        .replace(/\[\/?ADIM\]/g, '')
        .replace(/\[\/?TABLO\]/g, '')
        .trim();
      if (temizMetin.length === 0) {
        temizMetin = 'The response got cut off while generating something complex (like a detailed diagram). Please try again — maybe ask for a slightly simpler version.';
      }
      res.json({ cevap: temizMetin, adimlar: null, gorselSvg, oneriler, konu: konuEtiketi2, terimler: terimler2 });
    }
  } catch (hata) {
    console.error('Gemini API hatası:', hata);
    res.status(500).json({ hata: 'AI servisine ulaşılamadı, lütfen tekrar dene.' });
  }
});

function _onerileriAyikla(metin) {
  const oneriler = [];
  const desen = /\[ONERI:([^\]]*)\]/g;
  let eslesme;
  while ((eslesme = desen.exec(metin)) !== null) {
    const parcalar = eslesme[1].split('|');
    const tur = parcalar[0];
    const konu = parcalar[1]?.split('=')[1] || '';
    oneriler.push({ tur, konu });
  }
  return oneriler.length > 0 ? oneriler : null;
}

function _markdownTablolariniCevir(metin) {
  const desen = /^(\|.+\|)\s*\n\s*(\|[\s\-:|]+\|)\s*\n((?:\|.+\|\s*\n?)+)/gm;

  return metin.replace(desen, (tamEslesme, baslikSatiri, _ayracSatiri, veriSatirlari) => {
    const satiriTemizle = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '')
      .split('|').map((h) => h.trim()).join(' | ');

    const baslik = satiriTemizle(baslikSatiri);
    const veriler = veriSatirlari.trim().split('\n')
      .map((satir) => satiriTemizle(satir))
      .filter((satir) => satir.length > 0);

    return `[TABLO]\n${baslik}\n${veriler.join('\n')}\n[/TABLO]\n`;
  });
}

function _adimlariAyikla(metin) {
  const adimlar = [];

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
      const satirlar = icerikTam.split('\n');
      baslik = satirlar[0].trim();
      icerik = satirlar.slice(1).join('\n').trim() || icerikTam;
    }
    if (!icerik) icerik = baslik;
    const gorselSvg = _gorselSvgAyikla(icerik);
    const temizIcerik = _gorselSvgTemizle(icerik).trim();
    adimlar.push({ baslik, icerik: temizIcerik.isEmpty ? baslik : temizIcerik, gorselSvg });
  }

  if (adimlar.length > 0) return adimlar;

  const format2Deseni = /\[ADIM\]\s*\n([^\n]+)\n([\s\S]*?)(?=\[ADIM\]|\[\/ADIM\]|$)/g;
  while ((eslesme = format2Deseni.exec(metin)) !== null) {
    const baslik = eslesme[1].trim();
    const icerik = eslesme[2].trim();
    if (!baslik || !icerik) continue;
    const gorselSvg = _gorselSvgAyikla(icerik);
    const temizIcerik = _gorselSvgTemizle(icerik).trim();
    adimlar.push({ baslik, icerik: temizIcerik.isEmpty ? baslik : temizIcerik, gorselSvg });
  }

  if (adimlar.length > 0) return adimlar;

  const format3Deseni = /\[ADIM\]\s*([^\n]*)\n([\s\S]*?)(?=\[ADIM\]|$)/g;
  while ((eslesme = format3Deseni.exec(metin)) !== null) {
    const baslik = eslesme[1].trim();
    let icerik = eslesme[2].trim();
    icerik = icerik.replace(/\[\/ADIM\]\s*$/, '').trim();
    if (!baslik || !icerik) continue;
    const gorselSvg = _gorselSvgAyikla(icerik);
    const temizIcerik = _gorselSvgTemizle(icerik).trim();
    adimlar.push({ baslik, icerik: temizIcerik.isEmpty ? baslik : temizIcerik, gorselSvg });
  }

  return adimlar;
}

function _gorselEtiketiniAyikla(metin) {
  const eslesme = metin.match(/\[GORSEL:([^\]]*)\]/);
  if (!eslesme) return null;

  const icerik = eslesme[1];
  const parcalar = icerik.split('|');
  const tur = parcalar[0];

  const gorselVerisi = { tur };

  for (let i = 1; i < parcalar.length; i++) {
    const [anahtar, deger] = parcalar[i].split('=');
    if (!anahtar || !deger) continue;

    if (anahtar === 'noktalar') {
      gorselVerisi.noktalar = deger.split(';').map((nokta) => {
        const [x, y] = nokta.replace(/[()]/g, '').split(',').map(Number);
        return [x, y];
      });
    } else if (anahtar === 'cizgi') {
      gorselVerisi.cizgi = deger.split('-').map((nokta) => {
        const [x, y] = nokta.replace(/[()]/g, '').split(',').map(Number);
        return [x, y];
      });
    } else if (anahtar === 'poligon') {
      gorselVerisi.poligon = deger.split(';').map((nokta) => {
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

const GORSEL_SVG_DESENI = /\[GORSEL_SVG\]([\s\S]*?)\[\/GORSEL_SVG\]/;
const GORSEL_SVG_TEMIZLEME_DESENI = /\[GORSEL_SVG\][\s\S]*?\[\/GORSEL_SVG\]/g;

function _gorselSvgAyikla(metin) {
  if (typeof metin !== 'string') return null;
  const eslesme = metin.match(GORSEL_SVG_DESENI);
  if (!eslesme) return null;
  const svg = eslesme[1].trim();
  if (!/^<svg[\s>]/.test(svg) || !svg.includes('</svg>')) return null;
  if (/<script|foreignObject|xlink:href\s*=\s*["']https?:/i.test(svg)) return null;
  return svg;
}

function _gorselSvgTemizle(metin) {
  if (typeof metin !== 'string') return metin;
  let temiz = metin.replace(GORSEL_SVG_TEMIZLEME_DESENI, '');
  const acikIndeks = temiz.indexOf('[GORSEL_SVG]');
  if (acikIndeks !== -1) temiz = temiz.substring(0, acikIndeks);
  return temiz;
}

app.post('/quiz', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(15), async (req, res) => {
  try {
    const { konu, zorluk = 'orta', kacinilacakSorular = [], mod = 'sozel', dil } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const kacinmaMetni = kacinilacakSorular.length > 0
      ? `\n\nIMPORTANT: Do NOT ask these questions again, generate a different one:\n${kacinilacakSorular.map((s, i) => `${i+1}. ${s}`).join('\n')}`
      : '';

    const sayisalMi = mod === 'sayisal';

    const gorselTalimati = sayisalMi ? `

Bu bir SAYISAL/GÖRSEL sorudur (Numerical Quiz). Kurallar:
- Soru gerçek bir hesaplama/problem çözme gerektirmeli — sözel bir tanım sorusu DEĞİL.
- Sorudaki HER matematiksel ifade (formül, denklem, üs, kesir, birim) LaTeX ile yazılmalı: satır içi "$...$", blok "$$...$$" formatında. Örnek: "Bir cismin hızı $v = 10 \\text{ m/s}$ ise..."
- ÖNEMLİ: Soru bir geometrik şekil (üçgen, dörtgen, çember, açı), koordinat düzlemi, fonksiyon grafiği (parabol, doğru, sinüs), fizik düzeneği (kuvvet diyagramı, devre, mercek) veya sayı doğrusu ARALIĞI içeriyorsa, bunu SÖZEL olarak tarif etmek YETMEZ — mutlaka SVG ile GERÇEKTEN ÇİZ. Öğrenci şekli görmeden çözemeyeceği bir soruda görseli atlaman ciddi bir hatadır.
- Çizim için, "soru" metninin İÇİNE, en sona şunu ekle:
  [GORSEL_SVG]<svg viewBox="0 0 W H" xmlns="http://www.w3.org/2000/svg">...</svg>[/GORSEL_SVG]
  Kurallar: viewBox mutlaka olsun (örn. "0 0 300 200"). Sadece <line>, <circle>, <rect>, <polygon>, <polyline>, <path>, <text>, <ellipse> kullan — script/image/foreignObject/harici link YASAK. Ana şekil/vurgu için "#6C63FF", eksen/etiket/ikincil çizgiler için "#EEE9FF" kullan. Arka plan dikdörtgeni EKLEME (şeffaf kalsın, kart zaten koyu renkte). Ölçü/koordinat/değişken etiketlerini <text fill="#EEE9FF"> ile ekle. KOMPAKT tut: koordinatlarda tam sayı ya da en fazla 1 ondalık basamak kullan (örn. "42.5", "42.4837291" değil), gereksiz özniteliklerden kaçın, ~5-12 elementi geçme.
  Örnek (dik üçgen): [GORSEL_SVG]<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg"><polygon points="20,140 180,140 20,20" fill="#6C63FF" fill-opacity="0.12" stroke="#6C63FF" stroke-width="2.5"/><text x="90" y="155" fill="#EEE9FF" font-size="13">8 cm</text><text x="4" y="85" fill="#EEE9FF" font-size="13">6 cm</text></svg>[/GORSEL_SVG]
- Sadece konu gerçekten soyut/sayısal ve görselin hiçbir katkısı olmayacaksa (örn. basit bir yüzde hesabı) SVG'yi atla — ama şekil/koordinat/grafik/düzenek geçen HER soruda mutlaka kullan.
- Cevap seçenekleri SAYISAL değerler olmalı (gerekirse birimle birlikte), sözel ifadeler değil.
- Açıklama (aciklama), çözümün kısa adımlarını LaTeX ile göstermeli.` : '';

    const prompt = `You are a tutor. Create a ${zorluk === 'kolay' ? 'easy' : zorluk === 'zor' ? 'hard' : 'medium'} difficulty exam question about: "${konu}"${kacinmaMetni}${gorselTalimati}

Respond ONLY in ${appDili}, in this exact JSON format, no other text:
{
  "soru": "the question text here",
  "secenekler": ["A) option", "B) option", "C) option", "D) option"],
  "dogruCevap": "A) option",
  "aciklama": "why this answer is correct, short explanation"
}

If you prefer an open-ended question, leave secenekler as an empty array: "secenekler": []
Each question has exactly one correct answer. Keep aciklama to 1-2 sentences.`;

    const kullanilacakModel = sayisalMi ? modelSistemsiz : ucuzModel;
    const result = await kullanilacakModel.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const soru = JSON.parse(text);

    if (sayisalMi && typeof soru.soru === 'string') {
      const gorselSvg = _gorselSvgAyikla(soru.soru);
      if (gorselSvg) {
        soru.gorselSvg = gorselSvg;
        soru.soru = _gorselSvgTemizle(soru.soru).trim();
      }
    }

    gunlukIstatistigiArtir('quizOlusturma');
    res.json(soru);
  } catch (hata) {
    console.error('Quiz soru hatası:', hata);
    res.status(500).json({ hata: 'Quiz sorusu oluşturulamadı.' });
  }
});

app.post('/quiz-degerlendir', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('kullaniciCevabi', MAKS_SORU_UZUNLUGU), krediGerekli(5), async (req, res) => {
  try {
    const { soru, dogruCevap, kullaniciCevabi, dil } = req.body;

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const prompt = `A student answered this question:

Question: ${soru}
Correct answer: ${dogruCevap}
Student's answer: ${kullaniciCevabi}

Respond ONLY in ${appDili}, in this exact JSON format:
{
  "dogru": true or false,
  "geri_bildirim": "short, warm, encouraging feedback (1-2 sentences)"
}

If the student's answer is on the right track but incomplete, count "dogru": true and fill in what's missing.`;

    const result = await ucuzModel.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const degerlendirme = JSON.parse(text);
    res.json(degerlendirme);
  } catch (hata) {
    console.error('Quiz değerlendirme hatası:', hata);
    res.status(500).json({ dogru: false, geri_bildirim: 'Could not evaluate answer.' });
  }
});

app.post('/kartlar-olustur', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(15), async (req, res) => {
  try {
    const { konu, dil } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const prompt = `You are a tutor. Create 6 flashcards on the topic: "${konu}"

Respond ONLY in ${appDili}, in this exact JSON format, no other text:
{
  "kartlar": [
    {"on": "front side - a question or concept", "arka": "back side - the answer or explanation"},
    ...
  ]
}

Rules:
- Each card's front should be a short question or concept (max 15 words)
- Each card's back should be a clear, concise answer (max 30 words)
- Cards should cover core concepts, aimed at understanding rather than rote memorization
- If the topic is mathematical/scientific and a formula genuinely belongs on a card, write it in LaTeX: inline "$...$" — e.g. "$E = mc^2$". Do not force LaTeX where it is not needed.`;

    const result = await ucuzModel.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const veri = JSON.parse(text);
    gunlukIstatistigiArtir('kartOlusturma');
    res.json(veri);
  } catch (hata) {
    console.error('Kart oluşturma hatası:', hata);
    res.status(500).json({ hata: 'Kartlar oluşturulamadı.' });
  }
});

app.post('/ogrenme-plani-olustur', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(50), async (req, res) => {
  try {
    const { konu, seviye, dil, sinavTarihi } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const seviyeAciklamalari = {
      dusuk: 'The student has LOW familiarity with this topic — assume near-zero prior knowledge. The plan must start from true fundamentals.',
      orta: 'The student has MODERATE familiarity — they know the basics but have gaps. The plan should briefly cover fundamentals then focus on building solid understanding.',
      ileri: 'The student has HIGH familiarity already — the plan should focus on refining, filling specific gaps, and advanced/nuanced aspects rather than basics.',
    };
    const seviyeAciklama = seviyeAciklamalari[seviye] || seviyeAciklamalari.dusuk;

    let kalanGun = null;
    if (sinavTarihi) {
      const simdi = new Date();
      const hedef = new Date(sinavTarihi);
      kalanGun = Math.max(0, Math.ceil((hedef - simdi) / (1000 * 60 * 60 * 24)));
    }

    let zamanTalimati = '';
    let ekstraAlanlar = '';
    if (kalanGun !== null) {
      const aciliyet = kalanGun <= 2 ? 'CRITICAL — almost no time left'
        : kalanGun <= 5 ? 'VERY SHORT — only a few days'
        : kalanGun <= 14 ? 'LIMITED — about a week or two'
        : 'AMPLE — plenty of time';
      zamanTalimati = `

This is an EXAM PREPARATION plan. The exam is in ${kalanGun} day(s). Time pressure: ${aciliyet}.
- If time is ample: build a thorough plan including real foundational understanding, aiming for genuine mastery and a high grade.
- If time is limited or very short: prioritize the highest-impact topics only, and set the "uyari" field to a short, honest, encouraging warning in ${appDili} telling the student time is tight and they should focus on breadth/general understanding rather than deep fundamentals. Calibrate the tone to their level: if they are already advanced ("ileri") and time is short, the warning should be light (a quick refresh is enough); if they are at a low level ("dusuk") and time is short, the warning should be more serious and direct about the risk.
- If time is ample, set "uyari" to an empty string "".
- For EACH sub-topic, add a "onerilenSure" field: a short suggested study time in ${appDili} (e.g. "~1.5 hours"), sized so that the total across all sub-topics roughly fits within the ${kalanGun} day(s) available (assume the student can study part-time, not full-time).`;
      ekstraAlanlar = `, "onerilenSure": "suggested study time for this sub-topic, e.g. '~1.5 hours'"`;
    }

    const prompt = `You are an expert curriculum designer. A student wants to learn: "${konu}"

Student's current level: ${seviyeAciklama}${zamanTalimati}

Break this topic down into an ORDERED sequence of 4-8 sub-topics that, learned in order, will take the student from their current level to solid mastery of "${konu}". Each sub-topic should be small enough to teach in a single focused session (a chat conversation, roughly 10-20 minutes of study).

Respond ONLY in ${appDili}, in this exact JSON format, no other text:
{
  ${kalanGun !== null ? '"uyari": "warning message described above, or empty string if time is ample",' : ''}
  "maddeler": [
    {"baslik": "short sub-topic name (3-6 words)", "aciklama": "1 short sentence explaining why this comes at this point in the sequence", "alanTuru": "sayisal" or "sozel"${ekstraAlanlar}}
  ]
}

Rules:
- Order matters — each sub-topic should build on the previous ones.
- Titles must be specific and concrete, never vague (bad: "Basics", good: "Verb conjugation in present tense").
- Match the depth to the student's stated level — do not include topics they already know if level is "ileri", and do not skip fundamentals if level is "dusuk".
- "alanTuru": classify each sub-topic as "sayisal" (numerical/quantitative — math, physics, chemistry calculations, or anything where diagrams/formulas/step-by-step problem-solving are the natural way to practice) or "sozel" (verbal/conceptual — language, history, literature, definitions, or anything better practiced through explanation and recall rather than calculation). This determines which quiz mode the student gets for practice, so classify based on how the topic is actually PRACTICED, not just its general subject area (e.g. "History of calculus" is sozel even though it's about math).`;

    const result = await modelSistemsiz.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const veri = JSON.parse(text);
    gunlukIstatistigiArtir('ogrenmePlani');
    res.json(veri);
  } catch (hata) {
    console.error('Öğrenme planı oluşturma hatası:', hata);
    res.status(500).json({ hata: 'Plan oluşturulamadı.' });
  }
});

app.post('/konu-kaynaklari-bul', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(10), async (req, res) => {
  try {
    const { konu, dil } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const aramaModeli = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      tools: [{ googleSearch: {} }],
      generationConfig: { maxOutputTokens: YAPISAL_GOREV_TOKEN_TAVANI },
    });

    const prompt = `Search the web for the 3 best educational resources (articles, tutorials, or reference pages — not videos) that clearly explain: "${konu}". Prefer reputable, well-known educational sources. Respond ONLY in ${appDili}, in this exact JSON format, no other text:
{
  "kaynaklar": [
    {"baslik": "short source title", "url": "https://..."}
  ]
}
Max 3 sources. Only include real, working URLs you found via search — never invent one.`;
    const result = await aramaModeli.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    let kaynaklar = [];
    try {
      const veri = JSON.parse(text);
      kaynaklar = (veri.kaynaklar || []).slice(0, 3);
    } catch (ayristirmaHatasi) {
      console.error('Kaynak JSON ayrıştırma hatası:', ayristirmaHatasi, '— ham metin:', text);
    }

    res.json({ kaynaklar });
  } catch (hata) {
    console.error('Konu kaynakları bulma hatası:', hata);
    res.status(500).json({ hata: 'Kaynaklar bulunamadı.', kaynaklar: [] });
  }
});

let _gundemOnbellekleri = {};
const GUNDEM_ONBELLEK_SURESI = 3 * 60 * 60 * 1000;

function htmlVarliklariniCoz(metin) {
  if (!metin) return metin;
  const birKezCoz = (m) => m
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return birKezCoz(birKezCoz(metin));
}

async function sayfaBasligiCek(url) {
  try {
    const controller = new AbortController();
    const zamanAsimi = setTimeout(() => controller.abort(), 6000);
    const yanit = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LularaBot/1.0)' },
    });
    clearTimeout(zamanAsimi);
    if (!yanit.ok) return null;

    const html = await yanit.text();

    let baslik = null;
    const ogEslesme = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogEslesme && ogEslesme[1].trim()) baslik = ogEslesme[1].trim();
    if (!baslik) {
      const titleEslesme = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleEslesme && titleEslesme[1].trim()) baslik = titleEslesme[1].trim();
    }
    if (!baslik) return null;

    baslik = htmlVarliklariniCoz(baslik);

    const tipEslesme = html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i);
    const ogTipi = tipEslesme ? tipEslesme[1].trim().toLowerCase() : null;

    let yolDerinligi = 0;
    try {
      const cozulenUrl = new URL(yanit.url || url);
      yolDerinligi = cozulenUrl.pathname.split('/').filter(Boolean).length;
    } catch {}

    const kategoriSayfasiGibi = ogTipi === 'website' || yolDerinligi < 2;

    return { baslik, makaleGibi: !kategoriSayfasiGibi };
  } catch {
    return null;
  }
}

app.get('/gundem', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const dil = req.query.dil || 'en';
    const buDilinOnbellegi = _gundemOnbellekleri[dil];
    if (buDilinOnbellegi && buDilinOnbellegi.veri) {
      const simdi = Date.now();
      const tazeMi = (simdi - buDilinOnbellegi.zaman) < GUNDEM_ONBELLEK_SURESI;
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, tazeMi });
    }
    res.json({ haberler: [], hicUretilmemis: true });
  } catch (hata) {
    console.error('Gündem okuma hatası:', hata);
    res.status(500).json({ hata: 'Gündem yüklenemedi.', haberler: [] });
  }
});

app.post('/gundem-yenile', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const dil = req.body.dil || 'en';
    const simdi = Date.now();

    const buDilinOnbellegi = _gundemOnbellekleri[dil];
    const tazeMi = buDilinOnbellegi && (simdi - buDilinOnbellegi.zaman) < GUNDEM_ONBELLEK_SURESI;
    if (tazeMi) {
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, yenilendi: false });
    }

    try {
      await krediDus(req.uid, 10, req.misafirMi);
    } catch (krediHatasi) {
      if (krediHatasi.message === 'YETERSIZ_KREDI') {
        return res.status(402).json({
          hata: 'Yetersiz kredi.', kod: 'YETERSIZ_KREDI', kalanKredi: krediHatasi.kalanKredi,
        });
      }
      throw krediHatasi;
    }

    const dilAdlari = {
      'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish',
    };
    const appDili = dilAdlari[dil] || 'English';

    const gundemModeli = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      tools: [{ googleSearch: {} }],
    });

    const aramaPrompt = `Search the web for 10 current, interesting news items and articles from this week about general science, discovery, space, biology, physics, history, philosophy, technology, or psychology. Mix different topics — don't focus on just one. For each one, write a clear sentence describing the SPECIFIC headline/topic you found (not just the publication name).`;

    const result = await gundemModeli.generateContent(aramaPrompt);
    const grounding = result.response.candidates?.[0]?.groundingMetadata;
    const chunks = grounding?.groundingChunks || [];
    const destekler = grounding?.groundingSupports || [];

    const chunkIndeksineGoreMetinler = {};
    for (const destek of destekler) {
      const metin = destek.segment?.text;
      const indeksler = destek.groundingChunkIndices || [];
      if (!metin) continue;
      for (const idx of indeksler) {
        if (!chunkIndeksineGoreMetinler[idx]) chunkIndeksineGoreMetinler[idx] = [];
        chunkIndeksineGoreMetinler[idx].push(metin);
      }
    }

    const gorulenUrller = new Set();
    const kaynaklar = [];
    chunks.forEach((c, idx) => {
      const web = c.web;
      if (!web || !web.uri) return;
      if (gorulenUrller.has(web.uri)) return;
      gorulenUrller.add(web.uri);
      const baglamCumleleri = chunkIndeksineGoreMetinler[idx] || [];
      kaynaklar.push({
        siteAdi: (web.title || 'Web').trim(),
        url: web.uri,
        baglam: baglamCumleleri.join(' ').trim(),
      });
    });
    const tumSecilenler = kaynaklar.slice(0, 12);

    await Promise.all(tumSecilenler.map(async (k) => {
      const sonuc = await sayfaBasligiCek(k.url);
      if (sonuc && sonuc.makaleGibi) {
        k.gercekBaslik = sonuc.baslik;
      }

      if (k.gercekBaslik) {
        const kelimeSayisi = k.gercekBaslik.trim().split(/\s+/).filter(Boolean).length;
        k.gercekBaslikGecerli = kelimeSayisi >= 3 && k.gercekBaslik.length > 12;
      } else {
        k.gercekBaslikGecerli = false;
      }
    }));

    const secilenKaynaklar = tumSecilenler
      .filter((k) => k.gercekBaslikGecerli || (k.baglam && k.baglam.length > 25))
      .slice(0, 8);

    let haberler = [];

    if (secilenKaynaklar.length > 0) {
      const kaynakListesi = secilenKaynaklar.map((k, i) => {
        let kaynakBilgisi;
        if (k.gercekBaslikGecerli) {
          kaynakBilgisi = `REAL page title (translate ONLY this into ${appDili}, word-for-word meaning, do NOT summarize into a category): "${k.gercekBaslik}"`;
        } else {
          kaynakBilgisi = `Verified content about this exact source: "${k.baglam}"`;
        }
        return `${i + 1}. Source: ${k.siteAdi}\n   ${kaynakBilgisi}`;
      }).join('\n\n');

      const etiketPrompt = `Here are sources found via web search, each with its own VERIFIED information (do not mix information between sources):

${kaynakListesi}

For EACH numbered source above, using ONLY that source's own information, respond with a JSON array in ${appDili} using this exact format:
[
  {"baslik": "a specific, complete headline sentence in ${appDili} — at least 5 words, describing the actual news topic. NEVER just a category word like 'Biology' or 'Physics News' or 'Science'. NEVER a bare website/domain name like 'space.com' or 'sciencedaily.com'.", "kategori": "one English word: Physics, Biology, Space, History, Philosophy, Technology, Psychology, or Chemistry", "kaynak": "publication name", "ozet": "1 short sentence in ${appDili} summarizing that source's information"}
]
Return exactly ${secilenKaynaklar.length} items, matching the order above. Never copy another source's topic into this one. The "baslik" field is a NEWS HEADLINE, never a single category word or a bare domain name.`;

      const etiketModeli = ucuzModel;
      const etiketSonuc = await etiketModeli.generateContent(etiketPrompt);
      const etiketText = etiketSonuc.response.text().replace(/```json|```/g, '').trim();

      let etiketler = [];
      try { etiketler = JSON.parse(etiketText); } catch { etiketler = []; }

      const kategoriKelimeleri = ['biology', 'physics', 'science', 'space', 'history',
        'philosophy', 'technology', 'psychology', 'chemistry', 'biyoloji',
        'fizik', 'bilim', 'uzay', 'tarih', 'felsefe', 'teknoloji', 'psikoloji', 'kimya'];
      const dolguDeseni = /\b(news|update|updates|latest|developments?|discoveries|discovery|research|articles?|haberleri|gelismeleri|gelismeler|guncel|arastirmalari)\b/i;
      const domainBenzeriMi = (metin) => /^[\w-]+(\.[\w-]+)+$/i.test(metin.trim());

      const baslikGenelMi = (metin) => {
        const kucuk = metin.toLowerCase();
        const kelimeSayisi = metin.split(/\s+/).filter(Boolean).length;
        if (kelimeSayisi < 4) return true;
        if (domainBenzeriMi(metin)) return true;
        if (kategoriKelimeleri.includes(kucuk.trim())) return true;
        const kategoriVar = kategoriKelimeleri.some((kk) => new RegExp(`\\b${kk}\\b`, 'i').test(kucuk));
        const dolguVar = dolguDeseni.test(kucuk);
        if (kategoriVar && dolguVar && kelimeSayisi <= 7) return true;
        return false;
      };

      haberler = secilenKaynaklar.map((k, i) => {
        let baslik = (etiketler[i]?.baslik || '').trim();
        const gecersizMi = !baslik || baslikGenelMi(baslik);

        if (gecersizMi) {
          if (k.gercekBaslikGecerli) {
            baslik = k.gercekBaslik;
          } else {
            return null;
          }
        }

        return {
          baslik,
          url: k.url,
          kategori: etiketler[i]?.kategori || 'Science',
          kaynak: etiketler[i]?.kaynak || k.siteAdi,
          ozet: etiketler[i]?.ozet || '',
        };
      }).filter((h) => h !== null);
    }

    if (haberler.length === 0) {
      const yedekPrompt = `Find 8-10 current, interesting news items and articles from this week related to general science, learning, discovery, and knowledge — topics like physics, space, biology, history, philosophy, technology, psychology, or any subject a curious student would enjoy.

Respond ONLY in ${appDili}, in this exact JSON format:
{"haberler": [{"baslik": "short catchy title", "kategori": "one English word category", "kaynak": "source name", "url": "https://...", "ozet": "1 sentence summary"}]}
Keep titles short (under 12 words).`;
      const yedekSonuc = await gundemModeli.generateContent(yedekPrompt);
      const yedekText = yedekSonuc.response.text().replace(/```json|```/g, '').trim();
      try {
        const yedekVeri = JSON.parse(yedekText);
        haberler = yedekVeri.haberler || [];
      } catch { haberler = []; }
    }

    const veri = { haberler };
    _gundemOnbellekleri[dil] = { veri, zaman: simdi };
    gunlukIstatistigiArtir('trendYenileme');
    res.json({ ...veri, onbellekten: false, yenilendi: true });
  } catch (hata) {
    console.error('Gündem yenileme hatası:', hata);
    const buDilinOnbellegi = _gundemOnbellekleri[req.body.dil || 'en'];
    if (buDilinOnbellegi && buDilinOnbellegi.veri) {
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, yenilendi: false });
    }
    res.status(500).json({ hata: 'Gündem yenilenemedi.', haberler: [] });
  }
});

const _arastirmaOnbellek = new Map();
const ARASTIRMA_ONBELLEK_SURESI = 60 * 60 * 1000;

app.post('/arastir', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), async (req, res) => {
  try {
    const { konu, dil } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    const anahtarKonu = konu.trim().toLowerCase();
    const onbellekAnahtari = `${dil || 'en'}:${anahtarKonu}`;
    const simdi = Date.now();

    const onbellekteki = _arastirmaOnbellek.get(onbellekAnahtari);
    if (onbellekteki && (simdi - onbellekteki.zaman) < ARASTIRMA_ONBELLEK_SURESI) {
      return res.json({ ...onbellekteki.veri, onbellekten: true });
    }

    try {
      await krediDus(req.uid, 25, req.misafirMi);
      gunlukIstatistigiArtir('research');
    } catch (krediHatasi) {
      if (krediHatasi.message === 'YETERSIZ_KREDI') {
        return res.status(402).json({
          hata: 'Yetersiz kredi.',
          kod: 'YETERSIZ_KREDI',
          kalanKredi: krediHatasi.kalanKredi,
        });
      }
      throw krediHatasi;
    }

    const arastirmaModeli = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      tools: [{ googleSearch: {} }],
    });

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const prompt = `Research the topic "${konu}" and respond ONLY in ${appDili}, in this exact JSON format:
{
  "ozet": "a clear 3-4 sentence summary of the topic",
  "kaynaklar": [
    {"baslik": "source title", "url": "https://...", "aciklama": "1 sentence description"}
  ],
  "sorular": ["common question 1", "question 2", "question 3"]
}
Max 5 sources. Pick reliable sources useful for a student (Wikipedia, Khan Academy, etc.)`;

    const result = await arastirmaModeli.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();

    try {
      const veri = JSON.parse(text);
      const sonucVeri = { ...veri, konu };
      _arastirmaOnbellek.set(onbellekAnahtari, { veri: sonucVeri, zaman: simdi });
      res.json(sonucVeri);
    } catch {
      res.json({ konu, ozet: text.substring(0, 400), kaynaklar: [], sorular: [] });
    }
  } catch (hata) {
    console.error('Araştırma hatası:', hata);
    res.status(500).json({ hata: 'Araştırma yapılamadı.' });
  }
});

// DÜZELTME: bu endpoint hic dil parametresi almiyordu ve prompt tamamen
// Turkce yazilmisti - uygulama dili Ingilizce/Almanca/vb. olsa bile model
// hep Turkce cevap veriyordu. Simdi diger endpoint'lerle (quiz, kartlar)
// ayni desende dil parametresi aliyor.
app.post('/sayfa-analiz', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('soru', MAKS_SORU_UZUNLUGU), krediGerekli(15), async (req, res) => {
  try {
    const { url, baslik, sayfaMetni, soru, dil } = req.body;

    const dilAdlari = { 'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'tr': 'Turkish' };
    const appDili = dilAdlari[dil] || 'English';

    const metin = sayfaMetni 
      ? sayfaMetni.substring(0, 8000)
      : null;

    const baglamMetni = metin 
      ? `Page title: "${baslik}"\nURL: ${url}\n\nPage content:\n${metin}`
      : `Page title: "${baslik}"\nURL: ${url}`;

    const prompt = soru
      ? `${baglamMetni}\n\nUser's question: ${soru}\n\nAnswer this question based on the page content. Be short and clear. Respond ONLY in ${appDili}.`
      : `${baglamMetni}\n\nSummarize this page for a student in 3-4 sentences. Highlight the main topic and key points. Respond ONLY in ${appDili}.`;

    const result = await ucuzModel.generateContent(prompt);
    res.json({ cevap: result.response.text() });
  } catch (hata) {
    console.error('Sayfa analiz hatası:', hata);
    res.status(500).json({ hata: 'Sayfa analiz edilemedi.' });
  }
});

// ---------------------------------------------------------
// SATIN ALMA DOĞRULAMA — Google Play Billing için. Bu endpoint'in TAM
// olarak çalışması için henüz eksik bir kurulum var:
//   1. Play Console → Setup → API access → bir "service account" oluştur
//   2. O servis hesabına Play Console'da "Finance" (ya da tam yetki) izni ver
//   3. Google Cloud Console'dan o servis hesabı için bir JSON anahtar indir
//   4. O JSON'ın İÇERİĞİNİ (tamamını, tek satır string olarak) Render'da
//      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ortam değişkenine yapıştır
// Bu adımlar tamamlanana kadar, bu endpoint hata verecektir — ama Flutter
// tarafı zaten buna hazır, kurulum bitince ekstra kod değişikliği
// GEREKMEZ.
// ---------------------------------------------------------
const PAKET_ADI = 'com.lulara.app';
const URUN_PREMIUM_AYLIK = 'lulara_premium_monthly';
const URUN_KREDI_MIKTARLARI = {
  'lulara_credits_250': 250,
  'lulara_credits_500': 500,
  'lulara_credits_1000': 1000,
  'lulara_credits_2500': 2500,
};

async function playYayinciApisi() {
  const kimlikJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!kimlikJson) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ortam değişkeni ayarlanmamış.');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(kimlikJson),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return google.androidpublisher({ version: 'v3', auth });
}

app.post('/satin-alma-dogrula', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const { urunId, satinAlmaTokeni } = req.body;
    if (!urunId || !satinAlmaTokeni) return res.status(400).json({ hata: 'Eksik bilgi.' });

    const yayinciApi = await playYayinciApisi();
    const kullaniciRef = db.collection('kullanicilar').doc(String(req.uid));

    if (urunId === URUN_PREMIUM_AYLIK) {
      const sonuc = await yayinciApi.purchases.subscriptions.get({
        packageName: PAKET_ADI,
        subscriptionId: urunId,
        token: satinAlmaTokeni,
      });
      const gecerliMi = sonuc.data.paymentState === 1 || sonuc.data.paymentState === 2;
      if (!gecerliMi) return res.status(400).json({ hata: 'Abonelik geçerli değil.' });

      await kullaniciRef.set({ premium: true, premiumSonKontrol: Date.now() }, { merge: true });
    } else if (URUN_KREDI_MIKTARLARI[urunId]) {
      const sonuc = await yayinciApi.purchases.products.get({
        packageName: PAKET_ADI,
        productId: urunId,
        token: satinAlmaTokeni,
      });
      if (sonuc.data.purchaseState !== 0) return res.status(400).json({ hata: 'Satın alma geçerli değil.' });

      const eklenecekKredi = URUN_KREDI_MIKTARLARI[urunId];
      await db.runTransaction(async (t) => {
        const dok = await t.get(kullaniciRef);
        const veri = dok.exists ? dok.data() : {};
        veri.kredi = (veri.kredi || 0) + eklenecekKredi;
        t.set(kullaniciRef, veri, { merge: true });
      });

      await yayinciApi.purchases.products.consume({
        packageName: PAKET_ADI,
        productId: urunId,
        token: satinAlmaTokeni,
      });
    } else {
      return res.status(400).json({ hata: 'Bilinmeyen ürün.' });
    }

    res.json({ basarili: true });
  } catch (hata) {
    console.error('Satın alma doğrulama hatası:', hata);
    res.status(500).json({ hata: 'Doğrulama başarısız, lütfen tekrar dene.' });
  }
});

app.post('/hesabimi-sil', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const uid = req.uid;
    await db.collection('kullanicilar').doc(String(uid)).delete();
    await admin.auth().deleteUser(uid);
    res.json({ basarili: true });
  } catch (hata) {
    console.error('Hesap silme hatası:', hata);
    res.status(500).json({ hata: 'Hesap silinemedi, lütfen tekrar dene.' });
  }
});

app.post('/iletisim-mesaji-gonder', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('mesaj', 2000), async (req, res) => {
  try {
    const { mesaj } = req.body;
    if (!mesaj || !mesaj.trim()) return res.status(400).json({ hata: 'Mesaj boş olamaz.' });

    const ILETISIM_GUNLUK_LIMIT = 2;
    const bugun = new Date();
    const bugunStr = `${bugun.getFullYear()}-${bugun.getMonth() + 1}-${bugun.getDate()}`;
    const kullaniciRef = db.collection('kullanicilar').doc(String(req.uid));

    let limitAsildiMi = false;
    await db.runTransaction(async (t) => {
      const dok = await t.get(kullaniciRef);
      let veri = dok.exists ? dok.data() : {};

      if (veri.iletisimGunu !== bugunStr) {
        veri.iletisimGunu = bugunStr;
        veri.iletisimSayisi = 0;
      }

      if ((veri.iletisimSayisi || 0) >= ILETISIM_GUNLUK_LIMIT) {
        limitAsildiMi = true;
        return;
      }

      veri.iletisimSayisi = (veri.iletisimSayisi || 0) + 1;
      t.set(kullaniciRef, veri, { merge: true });
    });

    if (limitAsildiMi) {
      return res.status(429).json({ hata: 'Daily message limit reached. Please try again tomorrow.' });
    }

    const gonderenEposta = req.email || (req.misafirMi ? 'Misafir kullanıcı' : 'E-posta yok');

    const { error } = await resend.emails.send({
      from: 'Lulara <onboarding@resend.dev>',
      to: 'contact.buluterus@gmail.com',
      replyTo: req.email || undefined,
      subject: `Lulara — Yeni iletişim mesajı (${gonderenEposta})`,
      text: `Gönderen: ${gonderenEposta}\nKullanıcı ID: ${req.uid}\n\nMesaj:\n${mesaj.trim()}`,
    });

    if (error) {
      console.error('İletişim mesajı gönderme hatası (Resend):', error);
      return res.status(500).json({ hata: 'Mesaj gönderilemedi, lütfen tekrar dene.' });
    }

    res.json({ basarili: true });
  } catch (hata) {
    console.error('İletişim mesajı gönderme hatası:', hata);
    res.status(500).json({ hata: 'Mesaj gönderilemedi, lütfen tekrar dene.' });
  }
});

app.get('/', (req, res) => {
  res.send('Ders AI backend calisiyor');
});

app.get('/admin/panel', async (req, res) => {
  try {
    const sifre = req.query.sifre;
    if (!process.env.ADMIN_SIFRE || sifre !== process.env.ADMIN_SIFRE) {
      return res.status(403).send('Erişim reddedildi. ?sifre=... parametresi eksik ya da yanlış.');
    }

    const kullanicilarRef = db.collection('kullanicilar');
    const toplamSnap = await kullanicilarRef.count().get();
    const premiumSnap = await kullanicilarRef.where('premium', '==', true).count().get();
    const misafirSnap = await kullanicilarRef.where('misafir', '==', true).count().get();

    const toplamKullanici = toplamSnap.data().count;
    const premiumSayisi = premiumSnap.data().count;
    const misafirSayisi = misafirSnap.data().count;
    const kayitliSayisi = toplamKullanici - misafirSayisi;

    const gunler = [];
    for (let i = 6; i >= 0; i--) {
      const t = new Date();
      t.setDate(t.getDate() - i);
      const tarihStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      gunler.push(tarihStr);
    }
    const gunlukVeriler = await Promise.all(gunler.map(async (tarih) => {
      const dok = await db.collection('gunluk_istatistikler').doc(tarih).get();
      const veri = dok.exists ? dok.data() : {};
      return {
        tarih,
        sohbetMesaji: veri.sohbetMesaji || 0,
        quizOlusturma: veri.quizOlusturma || 0,
        kartOlusturma: veri.kartOlusturma || 0,
        research: veri.research || 0,
        trendYenileme: veri.trendYenileme || 0,
      };
    }));

    const satirlar = gunlukVeriler.map((g) => `
      <tr>
        <td>${g.tarih}</td>
        <td>${g.sohbetMesaji}</td>
        <td>${g.quizOlusturma}</td>
        <td>${g.kartOlusturma}</td>
        <td>${g.research}</td>
        <td>${g.trendYenileme}</td>
      </tr>`).join('');

    const toplamMesaj7Gun = gunlukVeriler.reduce((t, g) => t + g.sohbetMesaji, 0);

    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Lulara - Yönetici Paneli</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #1A1625; color: #EEE9FF; }
  h1 { font-size: 24px; }
  h2 { font-size: 16px; color: #9B92B0; margin-top: 32px; }
  .kart-satiri { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
  .kart { background: #201B2E; border: 1px solid #3D3660; border-radius: 12px; padding: 16px 20px; min-width: 140px; }
  .kart .sayi { font-size: 28px; font-weight: 800; color: #6C63FF; }
  .kart .etiket { font-size: 12px; color: #9B92B0; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #3D3660; }
  th { color: #9B92B0; font-weight: 600; }
  .yenile { color: #6C63FF; font-size: 12px; text-decoration: none; }
</style>
</head>
<body>
  <h1>Lulara — Yönetici Paneli</h1>
  <a class="yenile" href="?sifre=${sifre}">Yenile</a>

  <h2>KULLANICILAR</h2>
  <div class="kart-satiri">
    <div class="kart"><div class="sayi">${toplamKullanici}</div><div class="etiket">Toplam kullanıcı</div></div>
    <div class="kart"><div class="sayi">${kayitliSayisi}</div><div class="etiket">Google ile kayıtlı</div></div>
    <div class="kart"><div class="sayi">${misafirSayisi}</div><div class="etiket">Misafir</div></div>
    <div class="kart"><div class="sayi">${premiumSayisi}</div><div class="etiket">Premium abone</div></div>
  </div>

  <h2>SON 7 GÜN — TOPLAM ${toplamMesaj7Gun} SOHBET MESAJI</h2>
  <table>
    <tr><th>Tarih</th><th>Sohbet</th><th>Quiz</th><th>Kart</th><th>Research</th><th>Trend yenileme</th></tr>
    ${satirlar}
  </table>

  <h2 style="margin-top:40px; font-size:11px; color:#4A4360;">Bu panel şifreyle korunuyor, linki paylaşma.</h2>
</body>
</html>
    `);
  } catch (hata) {
    console.error('Admin panel hatası:', hata);
    res.status(500).send('Panel yüklenemedi: ' + (hata.message || hata));
  }
});

app.listen(PORT, () => {
  console.log(`Ders AI backend ${PORT} portunda çalışıyor`);
});