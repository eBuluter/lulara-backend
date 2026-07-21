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
const rateLimit = require('express-rate-limit'); // tek bir kullanıcının/IP'nin kotayı tüketmesini engeller
const admin = require('firebase-admin'); // kullanıcı kimliğini doğrulamak ve Firestore'a erişmek için
const crypto = require('crypto'); // AdMob'un reklam ödülü imzasını doğrulamak için (Node yerleşik)
const mammoth = require('mammoth'); // Word (.docx) dosyalarından düz metin çıkarmak için
const { GoogleAICacheManager } = require('@google/generative-ai/server'); // acik (explicit) onbellekleme icin

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API'sine bağlanmak için kullanacağımız "istemci" (client)
// API key'i .env dosyasından okunuyor, koda asla yazılmıyor
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const cacheManager = new GoogleAICacheManager(process.env.GEMINI_API_KEY);

// ---------------------------------------------------------
// FIREBASE ADMIN — kullanıcı kimliğini doğrulamak ve kredi
// verilerini Firestore'da tutmak için. Servis hesabı JSON'u
// .env'de base64 olarak saklanıyor (satır sonu/tırnak sorunları
// yaşamamak için)
// ---------------------------------------------------------
const servisHesabiJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(servisHesabiJson)),
});
const db = admin.firestore();

app.use(cors());
app.use(express.json({ limit: '25mb' })); // gelen isteklerin JSON formatında okunmasını sağlar - fotoğraflar için limit büyütüldü

// Gemini'ye giden tüm istekler için genel bir hız sınırı — normal kullanımı
// hiç etkilemez ama bir hata/döngü/kötüye kullanım tüm bütçeyi bitiremesin diye
const aiIstekSiniri = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakikalık pencere
  max: 60, // aynı IP'den 15 dakikada en fazla 60 AI isteği
  message: { hata: 'Too many requests. Please slow down and try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------
// KİMLİK DOĞRULAMA — her istekte Authorization: Bearer <token>
// header'ını Firebase ile doğrular. Geçersizse istek reddedilir.
// Uygulamadan geçmeyen kimse backend'i kullanamaz.
// ---------------------------------------------------------
async function kimlikDogrula(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ hata: 'Giriş gerekli.', kod: 'GIRIS_GEREKLI' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    // Firebase, misafir (anonim) girişleri "anonymous" sağlayıcısıyla işaretler.
    // Bunu kredi sistemi, misafirlere daha düşük tavan vermek için kullanır.
    req.misafirMi = decoded.firebase?.sign_in_provider === 'anonymous';
    next();
  } catch (e) {
    return res.status(401).json({ hata: 'Geçersiz veya süresi dolmuş oturum.', kod: 'GECERSIZ_OTURUM' });
  }
}

// ---------------------------------------------------------
// KREDİ SİSTEMİ — saatlik yenilenen "enerji" mekaniği.
// Misafir (hesapsız): 50 kapasite, saatte 15 yenilenir — uygulamayı
//   silip tekrar kurarak sınırsız kredi almayı caydırmak için düşük tutuluyor.
// Kayıtlı (Google girişi): 200 kapasite, saatte 50 yenilenir.
// Premium: 2000 kapasite, saatte 500 yenilenir.
// ---------------------------------------------------------
const MISAFIR_MAKS_KREDI = 50;
const MISAFIR_SAATLIK_YENILENME = 15;
const UCRETSIZ_MAKS_KREDI = 200;
const UCRETSIZ_SAATLIK_YENILENME = 50;
const PREMIUM_MAKS_KREDI = 2000;
const PREMIUM_SAATLIK_YENILENME = 500;

// Verilen kullanıcı verisine, geçen zamana göre kredi yenilemesi uygular
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
      // ÖNEMLİ: reklam ödülüyle kapasitenin üzerine çıkmış olabilir
      // (örn. 180/200 iken +100 reklam ödülü = 280). Bu durumda saatlik
      // yenileme onu asla AŞAĞI çekmemeli — sadece normal aralıktaysa
      // yukarı taşır, kapasite üstündeyse olduğu gibi bırakır.
      veri.kredi = Math.max(mevcutKredi, Math.min(maksKredi, mevcutKredi + yenilenenMiktar));
      veri.sonYenilenmeZamani = simdi;
    }
  }
  return veri;
}

// Yeni kullanıcı için varsayılan kredi verisi
function varsayilanKrediVerisi(misafirMi = false) {
  return {
    kredi: misafirMi ? MISAFIR_MAKS_KREDI : UCRETSIZ_MAKS_KREDI,
    sonYenilenmeZamani: Date.now(),
    premium: false,
    misafir: misafirMi,
    streakFreezeHakki: 1, // yeni kullanıcıya küçük bir başlangıç hediyesi
  };
}

// Bir kullanıcı misafirken sonradan Google ile giriş yaparsa (aynı UID
// korunur, sadece sağlayıcı değişir), bunu tespit edip kaydı GÜNCELLER.
// Tek yönlü: misafirden kayıtlıya geçer, tersi asla olmaz.
function misafirDurumunuGuncelle(veri, gercekMisafirMi) {
  if (veri.misafir === true && gercekMisafirMi === false) {
    veri.misafir = false;
  }
  return veri;
}

// Belirtilen miktarda krediyi güvenli şekilde (transaction ile) düşer.
// Yetersizse hata fırlatır. req.uid'nin kimlikDogrula'dan geldiği varsayılır.
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

// ---------------------------------------------------------
// GÜNLÜK İSTATİSTİK SAYACI — admin panelinde göstermek için
// her gün ayrı bir Firestore dokümanında basit sayaçlar tutuyoruz.
// Hata olursa sessizce yutuyoruz — istatistik kaybı, uygulamanın
// çalışmasını asla engellememeli.
// ---------------------------------------------------------
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

// Express middleware hâli — belirli bir maliyeti olan endpoint'lere takılır
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

// ---------------------------------------------------------
// GİRDİ UZUNLUĞU SINIRLARI — sabit kredi fiyatlandırması (örn. sohbet
// mesajı = 10 kredi), gönderilen metnin BOYUTUNU hesaba katmıyor. Biri
// tek bir mesaja on binlerce karakter yapıştırıp gerçek Gemini maliyetini
// şişirebilir ama yine de sadece 10 kredi öder. Bu middleware'ler, kredi
// düşülmeden ÖNCE makul olmayan büyüklükteki girdileri reddeder.
// ---------------------------------------------------------
const MAKS_MESAJ_UZUNLUGU = 6000; // sohbette tek bir mesaj için
const MAKS_KONU_UZUNLUGU = 300;   // quiz/kart/research konu başlığı için
const MAKS_SORU_UZUNLUGU = 2000;  // sayfa analizi / quiz değerlendirme sorusu için

// Sohbet endpoint'leri için: mesajlar dizisindeki her mesajın metnini kontrol eder
const MAKS_DOSYA_BASE64_UZUNLUGU = 14 * 1024 * 1024; // ~10MB gerçek dosya boyutu (base64 %33 büyür)

function sohbetUzunlugunuKontrolEt(req, res, next) {
  const { mesajlar } = req.body;
  if (!mesajlar || !Array.isArray(mesajlar)) return next(); // asıl doğrulama route içinde zaten var
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

// Tek bir metin alanını (konu, soru, vb.) kontrol eden genel middleware
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

// ---------------------------------------------------------
// DOSYA EKİ İŞLEME — PDF, Word (.docx) ve düz metin (.txt)
// dosyalarını Gemini'nin anlayacağı bir "part"a çevirir.
// PDF: Gemini'ye doğrudan gönderilir, Gemini kendisi okur.
// .docx: mammoth ile önce düz metne çevrilir (Gemini Word'ü okuyamaz).
// .txt: base64 çözülüp doğrudan metin olarak eklenir.
// ---------------------------------------------------------
const MAKS_BELGE_METNI_UZUNLUGU = 20000; // çıkarılan metin için karakter sınırı

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

// Kullanıcının güncel kredi durumunu döner (yeniler ama düşmez)
app.get('/kredi-durumu', kimlikDogrula, async (req, res) => {
  try {
    const ref = db.collection('kullanicilar').doc(req.uid);
    const dokuman = await ref.get();
    let veri = dokuman.exists ? dokuman.data() : varsayilanKrediVerisi(req.misafirMi);
    veri = misafirDurumunuGuncelle(veri, req.misafirMi);
    veri = krediYenile(veri);
    await ref.set(veri, { merge: true });

    // Bugün için kalan reklam hakkı — gün değiştiyse tam hak var demektir
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

// ---------------------------------------------------------
// STREAK FREEZE — kullanıcı bir günü kaçırdığında serisini
// korumak için hakkını kullanır. Flutter tarafı, seri kopacağını
// tespit ettiğinde bu endpoint'i çağırır; hak varsa düşülür ve
// seri korunur, yoksa normal şekilde sıfırlanır.
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// ADMOB SSV (SERVER-SIDE VERIFICATION) — reklam ödülü doğrulaması
// Google, kullanıcı ödüllü reklamı tamamladığında BU adrese kendi
// sunucularından imzalı bir istek gönderir. Biz imzayı Google'ın
// açık anahtarlarıyla doğrulayıp, doğruysa krediyi ekliyoruz.
// Bu, sahte "izledim" isteklerini imkansız hâle getirir çünkü
// imza sadece Google'ın özel anahtarıyla üretilebilir.
// ---------------------------------------------------------
const ADMOB_ANAHTAR_ADRESI = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const REKLAM_ODUL_MIKTARI = 100;
const REKLAM_GUNLUK_LIMIT = 5; // kullanıcı başına günde en fazla 5 reklam ödülü

let _admobAnahtarlari = null;
let _admobAnahtarSonCekilme = 0;
const ADMOB_ANAHTAR_ONBELLEK_SURESI = 12 * 60 * 60 * 1000; // 12 saat

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

// Google'ın base64url imzasını Node'un anlayacağı standart Buffer'a çevirir
function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

app.get('/reklam-ssv-callback', async (req, res) => {
  // ÖNEMLİ: AdMob, bu URL'yi kaydederken ve zaman zaman "erişilebilir mi"
  // diye basit bir yoklama isteği atar — bu istekte gerçek imza parametreleri
  // OLMAZ. Google, her durumda HTTP 200 bekliyor; eksik/geçersiz veri olması
  // "hata" değil, sadece "gerçek bir ödül bildirimi değil" demek. Bu yüzden
  // aşağıdaki tüm "geçersiz" durumlarda bile 200 dönüyoruz, sadece krediyi
  // vermiyoruz.
  try {
    const tamSorgu = req.url.split('?')[1] || '';
    const imzaBaslangici = tamSorgu.indexOf('&signature=');
    if (imzaBaslangici === -1) {
      console.log('SSV yoklaması: imza parametresi yok (muhtemelen AdMob URL testi)');
      return res.status(200).send('OK');
    }

    // İmzalanan içerik: signature parametresinden ÖNCEKİ her şey
    // (key_id dahil) — Google'ın imzaladığı tam olarak budur
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
    const dogrulayici = crypto.createVerify('SHA256');
    dogrulayici.update(imzalananIcerik);
    const imzaBuffer = base64UrlToBuffer(signature);

    // Google'ın imzaları "IEEE P1363" ham formatında (DER değil)
    const gecerliMi = dogrulayici.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      imzaBuffer
    );

    if (!gecerliMi) {
      console.error('SSV imza doğrulaması BAŞARISIZ — sahte istek olabilir');
      return res.status(200).send('OK'); // Google'a yine 200 dön, ama krediyi VERME
    }

    // Tekrar (replay) koruması — aynı işlem ID'si iki kez kredi vermesin
    const islemRef = db.collection('islenmis_reklam_odulleri').doc(String(transaction_id));
    const islemDoku = await islemRef.get();
    if (islemDoku.exists) {
      return res.status(200).send('OK'); // zaten işlendi, Google'a yine de 200 dön
    }

    // Bugünün tarihi — günlük reklam sayacını sıfırlamak için
    const bugun = new Date();
    const bugunStr = `${bugun.getFullYear()}-${bugun.getMonth() + 1}-${bugun.getDate()}`;

    // Krediyi ekle — kapasiteyi aşabilir, bu normal (kazanılmış bonus).
    // GÜNLÜK LİMİT: kullanıcı başına günde en fazla REKLAM_GUNLUK_LIMIT
    // reklam ödülü — hem kötüye kullanımı önler hem Premium'un değerini korur.
    const kullaniciRef = db.collection('kullanicilar').doc(String(user_id));
    let limitAsildiMi = false;
    let yeniKrediDegeri = null;
    await db.runTransaction(async (t) => {
      const dok = await t.get(kullaniciRef);
      let veri = dok.exists ? dok.data() : varsayilanKrediVerisi();
      veri = krediYenile(veri);

      // Gün değiştiyse sayaç sıfırlanır
      if (veri.reklamOduluGunu !== bugunStr) {
        veri.reklamOduluGunu = bugunStr;
        veri.reklamOduluSayisi = 0;
      }

      if ((veri.reklamOduluSayisi || 0) >= REKLAM_GUNLUK_LIMIT) {
        limitAsildiMi = true;
        t.set(kullaniciRef, veri, { merge: true }); // gün/sayaç güncellemesini yine de kaydet
        return; // kredi VERİLMEZ
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
    // Hata olsa bile Google'a 200 dön — yoksa AdMob callback URL'i
    // "bozuk" olarak işaretleyip tamamen devre dışı bırakabilir
    res.status(200).send('OK');
  }
});

// ---------------------------------------------------------
// SİSTEM PROMPTU - AI'nin "nasıl davranması gerektiği" talimatı
// Bu, uygulamanın gerçek "kalbi" - öğrenciye asla direkt cevap
// vermeyen, adım adım rehberlik eden bir öğretmen gibi davranmasını sağlıyor
// ---------------------------------------------------------
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

VISUALS:
For coordinate geometry: [GORSEL:koordinat|noktalar=(x1,y1)|cizgi=(x1,y1)-(x2,y2)]
For number lines: [GORSEL:sayidogrusu|nokta=5|aralik=2,8]
Max 1 visual per response. Only when it genuinely helps.

MATH FORMATTING — MANDATORY:
The app renders math using LaTeX. ANY mathematical expression — equations, formulas, fractions, exponents, roots, Greek letters, integrals, matrices, anything beyond plain numbers — MUST be wrapped in LaTeX delimiters or it will display as broken/unreadable text to the student. This is not optional.
- Inline math (within a sentence): wrap in single dollar signs, e.g. "The area is $A = \\pi r^2$."
- Standalone/block equations (on their own line): wrap in double dollar signs, e.g. $$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$
- Use real LaTeX commands: \\frac{}{}, \\sqrt{}, ^{} for exponents, _{} for subscripts, \\pi, \\theta, \\int, \\sum, \\infty, etc. Never write "x^2" or "sqrt(x)" as plain text — always "$x^2$" and "$\\sqrt{x}$".
- Even a single variable or simple expression referenced in a sentence (e.g. "solve for $x$") should be wrapped, for visual consistency.
- This applies in every context: plain responses, step boxes, everywhere.

TABLES:
When information is genuinely tabular (comparisons, structured data with multiple attributes per row, side-by-side facts), render it as a real table instead of prose or a plain list. Use this exact format:
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

STUDENT CONTEXT:
If a STUDENT CONTEXT block is provided separately for this conversation (listing topics the student has been struggling with), you have real access to that data — it is not a guess. Use it naturally when relevant: if the current topic overlaps with something they've struggled with, you may briefly and warmly acknowledge it (e.g. "This connects to [topic], which you've been finding tricky — let's make sure it clicks this time"). Do not force it into unrelated conversations, and do not mention it in every message — only when it genuinely adds value.`;

// Öğrencinin zayıf olduğu konuları güvenli, sınırlı bir "bağlam" metnine
// çevirir. Kötüye kullanımı/prompt enjeksiyonunu sınırlamak için en fazla
// 5 konu, konu başına en fazla 60 karakter kabul edilir.
function ogrenciBaglamiOlustur(zayifKonular) {
  if (!Array.isArray(zayifKonular) || zayifKonular.length === 0) return '';
  const temizKonular = zayifKonular
    .filter((k) => typeof k === 'string' && k.trim().length > 0)
    .slice(0, 5)
    .map((k) => k.trim().substring(0, 60));
  if (temizKonular.length === 0) return '';
  return `\n\nSTUDENT CONTEXT: This student has been struggling with these topics recently: ${temizKonular.join(', ')}.`;
}

const model = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash', // güncel kararlı model — 2.5-flash yeni hesaplara kapatıldığı için geçildi
  systemInstruction: SISTEM_PROMPTU,
});

// Basit/yapısal işler için (quiz değerlendirme, kategorileme) daha ucuz
// ve daha yeni nesil model — asıl sohbet kalitesini etkilemez, sadece
// arka plandaki küçük işleri ucuzlatır. Ana sohbet modeline (yukarıdaki
// 'model') şimdilik dokunmuyoruz.
const ucuzModel = genAI.getGenerativeModel({
  model: 'gemini-3.1-flash-lite',
});

// ---------------------------------------------------------
// AÇIK (EXPLICIT) ÖNBELLEKLEME — sistem prompt'u (büyük, sabit kısım)
// dil başına BİR KEZ Google'ın sunucusuna kaydediliyor, sonraki tüm
// isteklerde bu önbellek referans gösteriliyor. Bu, otomatik (implicit)
// önbelleğin trafik zamanlamasına bağlı olma riskini ortadan kaldırıp
// %90 indirimi GARANTİ hale getiriyor. Öğrenci bazlı bilgiler (zayıf
// konular) önbelleğe DAHİL EDİLMİYOR — o yüzden hep aynı 5 dil önbelleği
// (en/de/fr/es/tr) tüm kullanıcılar arasında paylaşılabiliyor.
// ---------------------------------------------------------
const DIL_ADLARI_ONBELLEK = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', tr: 'Turkish' };
const _dilOnbellekleri = {}; // { en: { cache, olusturmaZamani }, ... }
const ONBELLEK_TTL_SANIYE = 12 * 3600; // Google tarafında 12 saat yaşasın — sistem promptu sık değişmediği için gereksiz yeniden-ödeme azalır
const ONBELLEK_YENILEME_ESIGI_MS = 11.5 * 60 * 60 * 1000; // 11.5 saat sonra biz de tazeleyelim (güvenli pay)

function dilTalimatiOlustur(appDili) {
  const desteklenenler = Object.values(DIL_ADLARI_ONBELLEK).join(', ');
  return `The app's selected language is ${appDili}. You MUST respond in ${appDili} ALWAYS, regardless of what language the student writes in. Do not switch languages based on their input.

If the student writes in a DIFFERENT language than ${appDili}, but that language IS one the app supports (${desteklenenler}), respond ONLY with a short, friendly message in ${appDili} asking them to change the app language in Settings if they want to chat in that language instead. Do not answer their actual question in this case.

If the student writes in a language that is NOT one of the app's supported languages (${desteklenenler}), respond with a short, friendly message in ${appDili} saying that language isn't supported by the app yet, but they're welcome to continue in ${appDili} or switch to one of the supported languages in Settings. Do not answer their actual question in this case.

If the student writes in ${appDili} (matching the app language), respond normally as instructed above.`;
}

// Verilen dil kodu için geçerli bir önbellek döner — yoksa/eskiyse
// yeniden oluşturur. Önbellek kurulamazsa null döner (çağıran taraf
// normal, önbelleksiz systemInstruction'a düşer — uygulama asla bozulmaz).
async function dilIcinOnbellekGetir(dilKodu) {
  const appDili = DIL_ADLARI_ONBELLEK[dilKodu] || 'English';
  const mevcut = _dilOnbellekleri[dilKodu];
  const simdi = Date.now();

  if (mevcut && (simdi - mevcut.olusturmaZamani) < ONBELLEK_YENILEME_ESIGI_MS) {
    return mevcut.cache;
  }

  try {
    const yeniOnbellek = await cacheManager.create({
      model: 'models/gemini-3.5-flash',
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

// Önbellekli ya da (kuramazsa) normal bir sohbet modeli döner.
// Öğrenci bağlamı (zayıf konular) önbelleğe hiç girmiyor — onu ayrıca
// çağıran taraf mesaj içeriğine ekleyecek.
async function sohbetModeliOlustur(dilKodu) {
  const appDili = DIL_ADLARI_ONBELLEK[dilKodu] || 'English';
  const onbellek = await dilIcinOnbellekGetir(dilKodu);

  if (onbellek) {
    return genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      cachedContent: onbellek,
      generationConfig: { maxOutputTokens: 2048 },
    });
  }

  // Yedek yol — önbellek kurulamadıysa eskisi gibi normal systemInstruction
  return genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: SISTEM_PROMPTU + '\n\nDİL TALİMATI: ' + dilTalimatiOlustur(appDili),
    generationConfig: { maxOutputTokens: 2048 },
  });
}

// Sohbete gönderilen geçmiş mesaj sayısını sınırlıyoruz — uzun sohbetlerde
// input token'lar sınırsız büyümesin diye. Son 16 mesaj (~8 karşılıklı
// konuşma) genelde bağlamı korumak için yeterli, maliyeti düşürür.
const MAKS_GECMIS_MESAJ = 12; // 3.5-flash daha pahali oldugu icin biraz daha kisildi

// ---------------------------------------------------------
// STREAMING ENDPOINT - kelime kelime akıcı cevap
// ---------------------------------------------------------
app.post('/sohbet-stream', aiIstekSiniri, kimlikDogrula, sohbetUzunlugunuKontrolEt, krediGerekli(10), async (req, res) => {
  try {
    const { mesajlar, dil, zayifKonular } = req.body;

    // Önbellekli (ya da yedek) sohbet modelini al — dil bazlı, öğrenci
    // bağlamı dahil değil (o mesaj içeriğine ayrıca eklenecek)
    const sohbetModeli = await sohbetModeliOlustur(dil);

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    // Karşılama mesajını çıkar, sonra en fazla MAKS_GECMIS_MESAJ kadarını
    // tut — çok uzun sohbetlerde input token maliyetini sınırlar
    let mesajlarKarsilamaHaric = mesajlar.slice(1);
    if (mesajlarKarsilamaHaric.length > MAKS_GECMIS_MESAJ) {
      mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(-MAKS_GECMIS_MESAJ);
      // ÖNEMLİ: Gemini, geçmişin MUTLAKA 'user' rolüyle başlamasını
      // istiyor. "Son N mesajı al" kesimi bazen tam bir AI (model)
      // mesajına denk gelebilir — o durumda geçerli bir user mesajı
      // bulana kadar baştan atıyoruz.
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
        parts.push({ inlineData: { mimeType: m.fotografMimeTipi, data: m.fotografBase64 } });
      }
      const dosyaParcasi = await dosyaEkiniPartaCevir(m);
      if (dosyaParcasi) parts.push(dosyaParcasi);
      geminiGecmisi.push({ role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    }

    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    // Öğrenci bağlamı (zayıf konular) artık önbelleğe girmiyor — bu yüzden
    // her isteğin son mesajına küçük bir not olarak ekleniyor. Kısa
    // olduğu için maliyet etkisi ihmal edilebilir düzeyde.
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

    // GEÇİCİ TEŞHİS LOGU — sorunu bulunca kaldırılacak
    console.log('=== ADIM TESHIS ===');
    console.log('hamCevap uzunluk:', hamCevap.length);
    console.log('[ADIM] gecen sayisi:', (hamCevap.match(/\[ADIM\]/g) || []).length);
    console.log('[/ADIM] gecen sayisi:', (hamCevap.match(/\[\/ADIM\]/g) || []).length);
    console.log('adimlar.length:', adimlar.length);
    console.log('hamCevap ilk 300 karakter (JSON):', JSON.stringify(hamCevap.substring(0, 300)));
    console.log('===================');

    let girisCumlesi = hamCevap;
    if (adimlar.length > 0) {
      const ilkEtiket = hamCevap.indexOf('[ADIM]');
      girisCumlesi = ilkEtiket > 0 ? hamCevap.substring(0, ilkEtiket).replace(/\[ONERI:[^\]]*\]/g, '').trim() : '';
    } else {
      girisCumlesi = hamCevap.replace(/\[GORSEL:[^\]]*\]/g, '').replace(/\[ONERI:[^\]]*\]/g, '').trim();
    }

    // Son veri paketi — adımlar ve öneri butonları için
    gunlukIstatistigiArtir('sohbetMesaji'); // arka planda, cevabı bekletmeden
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
app.post('/sohbet', aiIstekSiniri, kimlikDogrula, sohbetUzunlugunuKontrolEt, krediGerekli(10), async (req, res) => {
  try {
    const { mesajlar, dil, zayifKonular } = req.body;

    // Önbellekli (ya da yedek) sohbet modelini al
    const sohbetModeli = await sohbetModeliOlustur(dil);

    if (!mesajlar || !Array.isArray(mesajlar)) {
      return res.status(400).json({ hata: 'Mesaj listesi gerekli.' });
    }

    // Karşılama mesajını çıkar, sonra en fazla MAKS_GECMIS_MESAJ kadarını
    // tut — çok uzun sohbetlerde input token maliyetini sınırlar
    let mesajlarKarsilamaHaric = mesajlar.slice(1);
    if (mesajlarKarsilamaHaric.length > MAKS_GECMIS_MESAJ) {
      mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(-MAKS_GECMIS_MESAJ);
      // ÖNEMLİ: Gemini, geçmişin MUTLAKA 'user' rolüyle başlamasını
      // istiyor. "Son N mesajı al" kesimi bazen tam bir AI (model)
      // mesajına denk gelebilir — o durumda geçerli bir user mesajı
      // bulana kadar baştan atıyoruz.
      while (mesajlarKarsilamaHaric.length > 0 && mesajlarKarsilamaHaric[0].kullaniciMi !== true) {
        mesajlarKarsilamaHaric = mesajlarKarsilamaHaric.slice(1);
      }
    }

    // Geçmiş mesajları Gemini formatına çeviriyoruz.
    // Fotoğraf/dosya içeren mesajlar için ilgili parts ekliyoruz.
    const gecmisMesajlar2 = mesajlarKarsilamaHaric.slice(0, -1);
    const geminiGecmisi = [];
    for (const m of gecmisMesajlar2) {
      const parts = [];
      if (m.metin && m.metin.trim()) parts.push({ text: m.metin });
      if (m.fotografBase64 && m.fotografMimeTipi) {
        parts.push({ inlineData: { mimeType: m.fotografMimeTipi, data: m.fotografBase64 } });
      }
      const dosyaParcasi = await dosyaEkiniPartaCevir(m);
      if (dosyaParcasi) parts.push(dosyaParcasi);
      geminiGecmisi.push({ role: m.kullaniciMi ? 'user' : 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    }

    // Son mesaj - metin, fotoğraf ve/veya dosya içerebilir
    const sonMesajVerisi = mesajlarKarsilamaHaric[mesajlarKarsilamaHaric.length - 1];
    const sonMesajParts = [];
    // Öğrenci bağlamı (zayıf konular) önbelleğe girmediği için mesaj
    // içeriğine küçük bir not olarak ekleniyor
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

  if (adimlar.length > 0) return adimlar;

  // Format 3: [ADIM] Başlık (aynı satırda)\nİçerik... [ADIM] Başlık2...
  // Model bazen [/ADIM] kapanışını hiç yazmıyor ve başlığı [ADIM] ile aynı
  // satıra koyuyor — bu durumu da yakalayan son bir yedek yöntem
  const format3Deseni = /\[ADIM\]\s*([^\n]*)\n([\s\S]*?)(?=\[ADIM\]|$)/g;
  while ((eslesme = format3Deseni.exec(metin)) !== null) {
    const baslik = eslesme[1].trim();
    let icerik = eslesme[2].trim();
    // İçerik yanlışlıkla bir sonraki [/ADIM] etiketini içeriyorsa temizle
    icerik = icerik.replace(/\[\/ADIM\]\s*$/, '').trim();
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
app.post('/quiz', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(15), async (req, res) => {
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

    const result = await ucuzModel.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const soru = JSON.parse(text);
    gunlukIstatistigiArtir('quizOlusturma');
    res.json(soru);
  } catch (hata) {
    console.error('Quiz soru hatası:', hata);
    res.status(500).json({ hata: 'Quiz sorusu oluşturulamadı.' });
  }
});

// ---------------------------------------------------------
// QUIZ DEĞERLENDİRME ENDPOINT - açık uçlu sorularda öğrencinin cevabını değerlendirir
// ---------------------------------------------------------
app.post('/quiz-degerlendir', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('kullaniciCevabi', MAKS_SORU_UZUNLUGU), krediGerekli(5), async (req, res) => {
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

    const result = await ucuzModel.generateContent(prompt);
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
app.post('/kartlar-olustur', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), krediGerekli(15), async (req, res) => {
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

// ---------------------------------------------------------
// GÜNDEM ENDPOINT - genel bilim/öğrenme haberleri, 1 saatlik önbellek
// ÖNEMLİ: önbellek DİL BAZINDA tutuluyor — tek/ortak bir önbellek olsaydı,
// hangi dilde bir istek önce gelip önbelleği doldurursa, o saatte HERKES
// (hangi dili seçmiş olursa olsun) o dildeki içeriği görürdü.
// ---------------------------------------------------------
let _gundemOnbellekleri = {}; // { en: {veri, zaman}, de: {veri, zaman}, ... }
const GUNDEM_ONBELLEK_SURESI = 60 * 60 * 1000; // 1 saat (ms)

// HTML sayfalarındaki kodlanmış karakterleri (&#x27; &amp;apos; &quot; vb.)
// gerçek karakterlere çevirir. Bazı sitelerde çift kodlama olabiliyor
// (örn. &amp;apos; aslında &apos;'in bir kez daha kodlanmış hâli), bu
// yüzden iki kez uyguluyoruz.
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

// Bir URL'nin GERÇEK sayfa başlığını (<title> veya og:title) çeker.
// Ayrıca bunun bir KATEGORİ/ANA SAYFA mı yoksa SPESİFİK BİR MAKALE mi
// olduğunu da tespit eder — kategori sayfalarının başlığı genelde
// "X haberleri sayfası" gibi genel bir tanıtım cümlesi olur, gerçek
// haber başlığı değil.
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

    // HTML kod-çözme — &#x27; ve benzeri kodlar gerçek karaktere dönüşsün
    baslik = htmlVarliklariniCoz(baslik);

    // og:type "article" ise kesin bir makale demektir — güçlü sinyal
    const tipEslesme = html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i);
    const ogTipi = tipEslesme ? tipEslesme[1].trim().toLowerCase() : null;

    // URL yol derinliği — kategori sayfaları genelde kısa (örn. /biology),
    // makaleler genelde uzun ve spesifik (örn. /2024/01/makale-basligi-xyz)
    let yolDerinligi = 0;
    try {
      const cozulenUrl = new URL(yanit.url || url);
      yolDerinligi = cozulenUrl.pathname.split('/').filter(Boolean).length;
    } catch {}

    // Makale gibi mi? og:type açıkça "website" DEĞİLSE ve yol yeterince
    // derinse (kategori sayfası olma ihtimali düşükse) güvenilir kabul et
    const kategoriSayfasiGibi = ogTipi === 'website' || yolDerinligi < 2;

    return { baslik, makaleGibi: !kategoriSayfasiGibi };
  } catch {
    return null; // zaman aşımı, engellendi, vs. — sorun değil, yedek yönteme düşer
  }
}

// GET /gundem — SADECE önbellekten okur, ASLA üretim tetiklemez.
// Ekran her açıldığında bu çağrılır ama hiçbir zaman maliyete sebep olmaz.
app.get('/gundem', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const dil = req.query.dil || 'en';
    const buDilinOnbellegi = _gundemOnbellekleri[dil];
    if (buDilinOnbellegi && buDilinOnbellegi.veri) {
      const simdi = Date.now();
      const tazeMi = (simdi - buDilinOnbellegi.zaman) < GUNDEM_ONBELLEK_SURESI;
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, tazeMi });
    }
    // Bu dil için hiç üretim yapılmamış — boş dön, kullanıcı "Yenile"ye basmalı
    res.json({ haberler: [], hicUretilmemis: true });
  } catch (hata) {
    console.error('Gündem okuma hatası:', hata);
    res.status(500).json({ hata: 'Gündem yüklenemedi.', haberler: [] });
  }
});

// POST /gundem-yenile — kullanıcı "Yenile" butonuna BİLEREK bastığında
// çağrılır. Son üretimin üzerinden gerçekten 1 saat geçmişse yeni bir
// üretim yapar VE 10 kredi düşer; geçmemişse ücretsiz, aynı içeriği döner.
app.post('/gundem-yenile', aiIstekSiniri, kimlikDogrula, async (req, res) => {
  try {
    const dil = req.body.dil || 'en';
    const simdi = Date.now();

    const buDilinOnbellegi = _gundemOnbellekleri[dil];
    const tazeMi = buDilinOnbellegi && (simdi - buDilinOnbellegi.zaman) < GUNDEM_ONBELLEK_SURESI;
    if (tazeMi) {
      // Henüz 1 saat geçmemiş — ücretsiz, mevcut içeriği aynen döndür
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, yenilendi: false });
    }

    // Gerçekten yeni üretim yapılacak — önce krediyi düş
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
      model: 'gemini-3.5-flash',
      tools: [{ googleSearch: {} }],
    });

    // 1. ADIM: Gerçekten arama yaptır — hem serbest metni hem de gerçek
    // kaynakları (grounding metadata) alıyoruz.
    const aramaPrompt = `Search the web for 10 current, interesting news items and articles from this week about general science, discovery, space, biology, physics, history, philosophy, technology, or psychology. Mix different topics — don't focus on just one. For each one, write a clear sentence describing the SPECIFIC headline/topic you found (not just the publication name).`;

    const result = await gundemModeli.generateContent(aramaPrompt);
    const grounding = result.response.candidates?.[0]?.groundingMetadata;
    const chunks = grounding?.groundingChunks || [];
    const destekler = grounding?.groundingSupports || [];

    // KRİTİK ADIM: groundingSupports, modelin yazdığı her cümleyi o cümleyi
    // GERÇEKTEN destekleyen kaynak indeksine bağlar. Bu sayede "hangi cümle
    // hangi URL'ye ait" sorusu tahmine değil, API'nin kendi verisine dayanır
    // — önceki index-sırasına-güvenme yönteminin yanlış eşleştirme sorununu çözer.
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

    // Gerçek arama kaynaklarından (grounding) tekilleştirilmiş liste çıkar,
    // her birine KENDİ gerçek bağlam metnini ekle
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

    // Her kaynağın GERÇEK sayfa başlığını paralel olarak çek — artık
    // {baslik, makaleGibi} objesi dönüyor, makaleGibi=false ise bu bir
    // kategori/ana sayfa demektir, güvenilmez
    await Promise.all(tumSecilenler.map(async (k) => {
      const sonuc = await sayfaBasligiCek(k.url);
      if (sonuc && sonuc.makaleGibi) {
        k.gercekBaslik = sonuc.baslik;
      }
      // makaleGibi false ise gercekBaslik ATANMAZ — kategori sayfası
      // başlığı ("X haberleri sayfası" gibi) hiç kullanılmasın diye

      // ÖNEMLİ: Sadece karakter uzunluğu yeterli değil — "space.com" gibi
      // bir site adı da 9 karakter ama gerçek bir haber başlığı DEĞİL.
      // Gerçek başlık en az 3 kelimeden oluşmalı (boşluk içermeli).
      if (k.gercekBaslik) {
        const kelimeSayisi = k.gercekBaslik.trim().split(/\s+/).filter(Boolean).length;
        k.gercekBaslikGecerli = kelimeSayisi >= 3 && k.gercekBaslik.length > 12;
      } else {
        k.gercekBaslikGecerli = false;
      }
    }));

    // ELEME: Ne gerçek (makale) başlığı ne de anlamlı bir doğrulanmış
    // metni olan kaynakları listeye HİÇ almıyoruz. Az ama doğru haber,
    // çok ama hatalı/genel ("space.com" gibi) haberden iyidir.
    const secilenKaynaklar = tumSecilenler
      .filter((k) => k.gercekBaslikGecerli || (k.baglam && k.baglam.length > 25))
      .slice(0, 8);

    let haberler = [];

    if (secilenKaynaklar.length > 0) {
      // 2. ADIM: Her kaynak için gerçek başlığı (varsa) veya doğrulanmış
      // bağlam metnini veriyoruz. Model artık başlık UYDURMUYOR — sadece
      // gerçek başlığı ${appDili}'ye çeviriyor/uyarluyor ve kategori+özet üretiyor.
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

      const etiketModeli = ucuzModel; // basit çeviri+kategorileme işi, ucuz model yeterli
      const etiketSonuc = await etiketModeli.generateContent(etiketPrompt);
      const etiketText = etiketSonuc.response.text().replace(/```json|```/g, '').trim();

      let etiketler = [];
      try { etiketler = JSON.parse(etiketText); } catch { etiketler = []; }

      // GÜVENLİK AĞI: Model yine de kısa/genel/domain-benzeri bir başlık
      // üretirse (tek kelime, ör. "Biology", ya da "Latest biology news
      // and discoveries" gibi kategori+dolgu kelimeden oluşan boş bir
      // cümle, ya da "space.com" gibi bir site adı), önce geçerli gerçek
      // başlığa geri düş — o da yoksa bu haberi TAMAMEN atla
      const kategoriKelimeleri = ['biology', 'physics', 'science', 'space', 'history',
        'philosophy', 'technology', 'psychology', 'chemistry', 'biyoloji',
        'fizik', 'bilim', 'uzay', 'tarih', 'felsefe', 'teknoloji', 'psikoloji', 'kimya'];
      // "news", "latest", "update", "discoveries" gibi içeriksiz dolgu kelimeler —
      // bunlar kategori kelimesiyle birlikte geçiyorsa cümle muhtemelen boş/genel demektir
      const dolguDeseni = /\b(news|update|updates|latest|developments?|discoveries|discovery|research|articles?|haberleri|gelismeleri|gelismeler|guncel|arastirmalari)\b/i;
      // Domain benzeri mi? (boşluksuz, "kelime.uzanti" formatında)
      const domainBenzeriMi = (metin) => /^[\w-]+(\.[\w-]+)+$/i.test(metin.trim());

      const baslikGenelMi = (metin) => {
        const kucuk = metin.toLowerCase();
        const kelimeSayisi = metin.split(/\s+/).filter(Boolean).length;
        if (kelimeSayisi < 4) return true;
        if (domainBenzeriMi(metin)) return true;
        // Tam olarak tek bir kategori kelimesiyse
        if (kategoriKelimeleri.includes(kucuk.trim())) return true;
        // Kategori kelimesi + dolgu kelime birlikte geçiyorsa (örn. "biology news and discoveries")
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
            baslik = k.gercekBaslik; // gerçek (doğrulanmış çok-kelimeli) başlığa geri düş
          } else {
            return null; // ne model başlığı ne gerçek başlık güvenilir — bu haberi atla
          }
        }

        return {
          baslik,
          url: k.url,
          kategori: etiketler[i]?.kategori || 'Science',
          kaynak: etiketler[i]?.kaynak || k.siteAdi,
          ozet: etiketler[i]?.ozet || '',
        };
      }).filter((h) => h !== null); // hem model hem gerçek başlık güvenilmezse atlanan haberleri temizle
    }

    // Grounding boş döndüyse (nadir), eski yönteme geri düş — hiç veri
    // göstermemektense modelin ürettiği JSON'u kullanmak daha iyi
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
    // Hata olursa, varsa BU DİLİN eski önbelleğini döndür (boş göstermektense)
    const buDilinOnbellegi = _gundemOnbellekleri[req.body.dil || 'en'];
    if (buDilinOnbellegi && buDilinOnbellegi.veri) {
      return res.json({ ...buDilinOnbellegi.veri, onbellekten: true, yenilendi: false });
    }
    res.status(500).json({ hata: 'Gündem yenilenemedi.', haberler: [] });
  }
});


// ---------------------------------------------------------
// ARAŞTIRMA ENDPOINT — aynı konuyu tekrar arayan farklı kullanıcılar
// için 1 saatlik önbellek. "Türev nedir" gibi popüler konular
// tekrar tekrar Gemini'ye gitmez.
// ---------------------------------------------------------
const _arastirmaOnbellek = new Map(); // anahtar: "dil:konu" -> {veri, zaman}
const ARASTIRMA_ONBELLEK_SURESI = 60 * 60 * 1000; // 1 saat

app.post('/arastir', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('konu', MAKS_KONU_UZUNLUGU), async (req, res) => {
  try {
    const { konu, dil } = req.body;
    if (!konu) return res.status(400).json({ hata: 'Konu gerekli.' });

    // Önbellek anahtarı: dil + normalize edilmiş konu (küçük harf, boşluk kırpılmış)
    const anahtarKonu = konu.trim().toLowerCase();
    const onbellekAnahtari = `${dil || 'en'}:${anahtarKonu}`;
    const simdi = Date.now();

    const onbellekteki = _arastirmaOnbellek.get(onbellekAnahtari);
    if (onbellekteki && (simdi - onbellekteki.zaman) < ARASTIRMA_ONBELLEK_SURESI) {
      // Önbellekten geldi — Gemini'ye gitmedik, kullanıcıdan kredi düşme
      return res.json({ ...onbellekteki.veri, onbellekten: true });
    }

    // Önbellekte yok — gerçekten Gemini'ye gideceğiz, ŞİMDİ krediyi düş
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
      model: 'gemini-3.5-flash',
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

// ---------------------------------------------------------
// SAYFA ANALİZ ENDPOINT - gerçek sayfa metnini okuyarak cevaplar
// ---------------------------------------------------------
app.post('/sayfa-analiz', aiIstekSiniri, kimlikDogrula, alanUzunlugunuSinirla('soru', MAKS_SORU_UZUNLUGU), krediGerekli(15), async (req, res) => {
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

    const result = await ucuzModel.generateContent(prompt);
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

// ---------------------------------------------------------
// BASİT YÖNETİCİ PANELİ — kaç kullanıcı var, Premium/misafir dağılımı,
// son 7 günün günlük kullanım sayıları. Tarayıcıdan ?sifre=... ile açılır.
// Bu bir şifre kontrolü — Firebase girişi gerektirmez, sadece hızlı bir
// bakış için. Gerçek yayına çıkınca daha güçlü bir korumaya taşınabilir.
// ---------------------------------------------------------
app.get('/admin/panel', async (req, res) => {
  try {
    const sifre = req.query.sifre;
    if (!process.env.ADMIN_SIFRE || sifre !== process.env.ADMIN_SIFRE) {
      return res.status(403).send('Erişim reddedildi. ?sifre=... parametresi eksik ya da yanlış.');
    }

    // Kullanıcı sayıları
    const kullanicilarRef = db.collection('kullanicilar');
    const toplamSnap = await kullanicilarRef.count().get();
    const premiumSnap = await kullanicilarRef.where('premium', '==', true).count().get();
    const misafirSnap = await kullanicilarRef.where('misafir', '==', true).count().get();

    const toplamKullanici = toplamSnap.data().count;
    const premiumSayisi = premiumSnap.data().count;
    const misafirSayisi = misafirSnap.data().count;
    const kayitliSayisi = toplamKullanici - misafirSayisi;

    // Son 7 günün günlük istatistikleri
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
  <h1>📊 Lulara — Yönetici Paneli</h1>
  <a class="yenile" href="?sifre=${sifre}">↻ Yenile</a>

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