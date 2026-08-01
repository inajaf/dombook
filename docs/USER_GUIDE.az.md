# DomBook istifadəçi təlimatı

DomBook istirahət evləri, kotteclər və ayrıca kirayə verilən evlərin sahibləri üçün bron idarəetmə sistemidir. Sistem bir administrator üçün nəzərdə tutulub və obyektləri, təqvimi, qonaqları, ödənişləri, depozitləri, qidalanmanı və ehtiyat nüsxələri vahid sadə interfeysdə birləşdirir.

## 1. Quraşdırma və açılış

### macOS

1. GitHub Release səhifəsindən macOS üçün `.dmg` və ya `.zip` faylını endirin.
2. **DomBook** tətbiqini Applications qovluğuna köçürün və açın.
3. Açıq buraxılış Apple tərəfindən notarizasiya edilməyib. macOS ilk açılışı bloklayarsa, tətbiqə sağ klik edib **Open** seçin və ya **System Settings → Privacy & Security** bölməsindən icazə verin.

### Windows

1. GitHub Release səhifəsindən installer və ya portable `.exe` faylını endirin.
2. Quraşdırıcını başladın və ya portable versiyanı quraşdırmadan açın.
3. Açıq buraxılış kod imzasına malik deyil. Windows SmartScreen xəbərdarlıq göstərə bilər; yalnız fayl rəsmi DomBook buraxılışındandırsa **More info → Run anyway** seçin.

### Web versiya

1. `DomBook-…-web.zip` faylını endirib arxivdən çıxarın.
2. `web` qovluğunu statik serverlə başladın, məsələn:

   ```bash
   python3 -m http.server 8080 --directory web
   ```

3. `http://127.0.0.1:8080/` ünvanını açın.

Web versiya məlumatları yalnız cari brauzerin lokal yaddaşında saxlayır. Brauzer məlumatlarının silinməsi onları da siləcək. Mütəmadi JSON backup yaradın. Desktop versiyalar lokal SQLite bazasından istifadə edir və gündəlik iş üçün tövsiyə olunur.

## 2. İlkin sazlama

1. **Obyektlər** bölməsini açın.
2. Bir məkanda bir neçə kottec varsa, **İstirahət evi əlavə et** seçib ad və ünvanı daxil edin.
3. Mətbəx və ya restoran varsa, qidalanma xidmətini aktiv edin.
4. İstirahət evini açın və ayrıca bron edilən hər kottec üçün **Kottec əlavə et** düyməsini basın.
5. Müstəqil kirayə evi **Ayrıca ev əlavə et** vasitəsilə yaradın.

Hər kottec və evin ayrıca tutumu, gecəlik qiyməti, qaytarılan depoziti, giriş və çıxış saatı var. Hər obyekt üçün müstəqil təqvim aparılır.

## 3. Bron yaratmaq

1. **Yeni bron** düyməsinə və ya təqvimdə boş `+` xanasına basın.
2. Evi və tarixləri seçin.
3. Qonağın adını, telefonunu, böyüklərin və uşaqların sayını daxil edin.
4. Bron üçün öncədən ödənişi və qaytarılan təhlükəsizlik depozitini ayrıca daxil edin.
5. Bron və depozit statuslarını seçin.
6. Qidalanma aktivdirsə, hər gün üçün səhər yeməyi, nahar və ya şam yeməyinin ümumi məbləğini daxil edin. Qiymət porsiya üçün deyil, bütün qrup üçün yazılır.
7. Hesablamanı yoxlayıb bronu yadda saxlayın.

Yaşayış məbləği `gecə sayı × sabitlənmiş gecəlik qiymət` düsturu ilə hesablanır. Öncədən ödəniş qalıq borcu azaldır. Qaytarılan depozit ayrıca izlənir və yaşayış gəliri sayılmır.

## 4. Bron qaydaları

- Yeni giriş tarixi ən çox 21 gün əvvəldən yaradıla bilər.
- Bir bron üç təqvim ayından uzun ola bilməz.
- Tutulan gecələr giriş tarixindən çıxış tarixinədək hesablanır, çıxış günü daxil edilmir.
- Eyni ev üçün aktiv bronlar üst-üstə düşə bilməz.
- Qonaq sayı evin tutumunu keçə bilməz.
- Tarixlər `Asia/Baku` saat qurşağı ilə hesablanır.

## 5. Erkən çıxış

Aktiv bronu açıb **Erkən çıxış** seçin. Faktiki çıxış tarixini və hesablama qaydasını göstərin:

- **Yalnız istifadə olunan gecələr** yaşayışı yenidən hesablayır və azad edilən tarixlərdən qidalanmanı silir.
- **Tam məbləği saxla** gələcək gecələri təqvimdə azad edir, lakin ilkin yaşayış məbləğini saxlayır.

Öncədən ödəniş yeni yekun məbləğdən çox olarsa, DomBook qonağa qaytarılacaq məbləği göstərir.

## 6. Təqvim və bron siyahısı

- Boş xanaya basdıqda ev və tarix əvvəlcədən seçilmiş bron forması açılır.
- Tutulmuş xanaya basdıqda mövcud bron redaktə olunur.
- Filtrlərlə aktiv bronları, borcları və depozitləri göstərə bilərsiniz.
- Ləğv edilmiş və tamamlanmış bronlar tarixçədə qalır. Tam silmə yalnız bitmiş və ya ləğv edilmiş qeydlər üçün mümkündür.

## 7. Backup və məlumatların yeri

**Sazlamalar** bölməsində baza faylının və backup qovluğunun yolu göstərilir.

- Desktop: **Backup yarat** yoxlanılmış SQLite nüsxəsi və SHA-256 checksum yaradır.
- Web: **Backup yarat** brauzer məlumatları olan JSON faylını endirir.

Böyük dəyişikliklərdən əvvəl backup yaradın və vacib nüsxələri başqa diskə və ya bulud yaddaşına köçürün. Bulud qovluğu işçi SQLite bazası deyil, ehtiyat nüsxə yeri kimi istifadə olunmalıdır.

## 8. Dil

**Sazlamalar → Tətbiqin dili** bölməsində Русский, Azərbaycan və ya English seçin. Seçim növbəti açılış üçün saxlanılır.

## 9. Problemlərin həlli

- **İstirahət evi boşdur:** onu açın və **Kottec əlavə et** düyməsinə basın.
- **Tarix seçilmir:** 21 günlük limiti, üç aylıq maksimum müddəti və üst-üstə düşən bronları yoxlayın.
- **Qidalanma görünmür:** istirahət evi üçün mətbəx/restoran xidmətini aktiv edin.
- **Obyekt görünmür:** **Arxivlənmişləri göstər** seçimini aktiv edib obyekti bərpa edin.
- **Web məlumatları itib:** brauzer yaddaşı təmizlənib və ya başqa profil açılıb; son ixrac edilmiş JSON backup-dan istifadə edin.
