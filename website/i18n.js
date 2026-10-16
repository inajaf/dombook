/**
 * Three languages, one page.
 *
 * ENGLISH IS NOT IN THIS FILE. It lives in the markup, and this script snapshots it on load and
 * restores it when the reader switches back. A dictionary that repeats the English would be a
 * second copy of the page, and the two would disagree the first time somebody edited one of them:
 * the classic failure is a page whose fallback text is three releases out of date.
 *
 * A missing key falls back to the English that is already on screen, so a translation that has not
 * been written yet shows English rather than a blank or a key name.
 *
 * The choice is remembered in localStorage. It is a reading preference, not account data, and it
 * belongs to the device: nobody wants the site to reset to English because they cleared cookies on
 * a different machine.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "rentkeeper-site-language";

  var RU = {
    "gate.title": "RentKeeper работает на компьютере",
    "gate.body": "Приложение сделано для macOS и Windows. Мобильной версии пока нет: календарь, редактор цен и договоры требуют экрана побольше, и мы предпочитаем сказать это прямо, чем показывать кнопку, за которой ничего нет.",
    "gate.hint": "Откройте эту страницу на компьютере, чтобы скачать.",
    "nav.features": "Возможности",
    "nav.calendar": "Календарь",
    "nav.pricing": "Цены",
    "nav.documents": "Документы",
    "nav.download": "Скачать",
    "hero.eyebrow": "Для гостевых домов и апартаментов",
    "hero.title1": "Каждая ночь учтена",
    "hero.title2": "и каждый платёж досчитан",
    "hero.lede": "RentKeeper держит посуточные брони и долгосрочную аренду в одном календаре. Считает цену по вашим сезонам и скидкам, готовит договор и счёт, и продолжает работать, когда интернета нет.",
    "hero.cta": "Скачать RentKeeper",
    "hero.cta2": "Посмотреть календарь",
    "hero.note": "Бесплатно для одного дома. Без карты и без пробного срока.",
    "strip.screens": "экранов вместо таблиц",
    "strip.langs": "языка интерфейса",
    "strip.free": "дом бесплатно, навсегда",
    "strip.paid": "на платном тарифе",
    "features.eyebrow": "Что он делает",
    "features.title": "Сделан для того, кто ведёт дом",
    "features.lede": "Не очередная CRM. Открыть утром, увидеть день, закрыть.",
    "card.calendar.title": "Календарь, который читается как календарь",
    "card.calendar.body": "Одна полоса на бронь, поэтому видно, где заезд и где выезд. Сводка за период говорит, насколько вы полны, сколько заездов и выездов и сколько ещё не доплачено.",
    "card.pricing.title": "Цены, которые меняются по сезону",
    "card.pricing.body": "Задайте сезонную ставку один раз и скидку за длительный срок. Диалог брони покажет, как получилась сумма, строкой за строкой, вместо одного числа, которому надо верить.",
    "card.documents.title": "Договоры и счета настоящими PDF",
    "card.documents.body": "Договор найма для длительной аренды, счёт для любой брони. Оба печатают цифры, сохранённые вместе с бронью, а не сегодняшние цены, поэтому старый документ совпадает с тем, о чём договорились.",
    "card.sync.title": "Работает без сети, синхронизируется позже",
    "card.sync.body": "Ваши данные лежат на вашей машине. Когда связь возвращается, приложение догоняет сервер, а всё, о чём два устройства разошлись, показывается списком, а не затирается молча.",
    "card.theme.title": "Читаемо, светлая или тёмная",
    "card.theme.body": "Светлая и тёмная темы и регулятор размера текста для тех, кто не хочет щуриться. Контраст измеряется на каждом экране, а не подбирается один раз на глаз.",
    "card.rental.title": "Долгая аренда рядом с короткой",
    "card.rental.body": "Договор на двенадцать месяцев и бронь на две ночи живут в одном календаре и в одной проверке занятости, поэтому они не могут разойтись в том, свободен дом или нет.",
    "cal.eyebrow": "Календарь",
    "cal.title": "Понять день одним взглядом",
    "cal.body": "Сетка отвечает, какие ночи заняты. На два вопроса, ради которых раньше приходилось считать клетки, отвечает то, что стоит рядом: насколько полон период и когда каждый дом освободится.",
    "cal.tick1": "Одна полоса на бронь, во всю длину проживания",
    "cal.tick2": "Загрузка, заезды, выезды и остаток к оплате за период",
    "cal.tick3": "Каждый дом называет ближайшее свободное окно",
    "cal.tick4": "Стрелки листают период, «Сегодня» возвращает назад",
    "price.eyebrow": "Цены",
    "price.title": "Сезоны, скидки и цена, о которой вы договорились",
    "price.body": "Правило пишется один раз: праздничные ночи дороже, неделя даёт десять процентов. Дальше диалог брони показывает расчёт. Если вы назвали цену сами, она сохраняется как договорная, и приложение перестаёт вас пересчитывать.",
    "price.tick1": "Сезон покрывает диапазон ночей, а не дней",
    "price.tick2": "Скидки не складываются, поэтому долгий срок не утроит ставку",
    "price.tick3": "Округление половина вверх на целых копейках, без дробей",
    "price.tick4": "Ранний выезд пересчитывается по тем же правилам",
    "doc.eyebrow": "Документы",
    "doc.title": "Бумаги, которые переживут проверку",
    "doc.body": "Договор найма и счёт, записанные файлами PDF: их можно распечатать, отправить или приложить к отчётности. Номер документа выводится из даты и самой брони, поэтому повторная генерация не даёт другого номера, и два компьютера не разойдутся в нём.",
    "doc.tick1": "Суммы берутся из сохранённой брони, а не из текущих ставок",
    "doc.tick2": "Сезонные строки и скидка печатаются отдельно",
    "doc.tick3": "Реквизиты заполняются один раз, в настройках",
    "doc.tick4": "В договоре есть место для подписей обеих сторон",
    "dl.eyebrow": "Скачать",
    "dl.title": "RentKeeper для вашего компьютера",
    "dl.versionLabel": "Версия",
    "dl.lede": "Установщики собирает CI и прикладывает к каждому релизу на GitHub.",
    "dl.mac": "Образ диска, Apple silicon и Intel",
    "dl.win": "Установщик и переносимая сборка, Windows 10 и 11",
    "dl.note1.lead": "Сборка ещё не опубликована.",
    "dl.note1.body": "Версия помечена тегом, и установщики собираются из него, но к релизу пока ничего не приложено. Кнопки выше ведут на страницу релизов, где файлы появятся. До этого приложение можно собрать из исходников.",
    "dl.note2.lead": "Мобильной версии нет.",
    "dl.note2.body": "Приложение настольное. Мы не показываем кнопку для телефона, пока за ней ничего не стоит.",
    "footer.note": "Брони, аренда и деньги для гостевых домов и апартаментов.",
    "footer.releases": "Релизы",
    "footer.source": "Исходный код"
  };

  var AZ = {
    "gate.title": "RentKeeper kompüterdə işləyir",
    "gate.body": "Tətbiq macOS və Windows üçün hazırlanıb. Telefon versiyası hələ yoxdur: təqvim, qiymət redaktoru və müqavilələr daha böyük ekran tələb edir, ona görə də arxasında heç nə olmayan düymə göstərməkdənsə bunu açıq deməyi üstün tuturuq.",
    "gate.hint": "Yükləmək üçün bu səhifəni kompüterdə açın.",
    "nav.features": "İmkanlar",
    "nav.calendar": "Təqvim",
    "nav.pricing": "Qiymətlər",
    "nav.documents": "Sənədlər",
    "nav.download": "Yüklə",
    "hero.eyebrow": "Qonaq evləri və mənzillər üçün",
    "hero.title1": "Hər gecə uçota alınıb",
    "hero.title2": "hər ödəniş yoxlanılır",
    "hero.lede": "RentKeeper gecəlik bronları və uzunmüddətli icarəni bir təqvimdə saxlayır. Qiyməti mövsümlərinizə və endirimlərinizə görə hesablayır, müqavilə və hesab-faktura hazırlayır və internet olmayanda da işləyir.",
    "hero.cta": "RentKeeper yüklə",
    "hero.cta2": "Təqvimə bax",
    "hero.note": "Bir obyekt üçün pulsuz. Kart yoxdur, sınaq müddəti yoxdur.",
    "strip.screens": "ekran, cədvəl əvəzinə",
    "strip.langs": "interfeys dili",
    "strip.free": "obyekt pulsuz, həmişəlik",
    "strip.paid": "ödənişli tarifdə",
    "features.eyebrow": "Nə edir",
    "features.title": "Evi idarə edən adam üçün qurulub",
    "features.lede": "Növbəti CRM deyil. Səhər aç, günü gör, bağla.",
    "card.calendar.title": "Təqvim kimi oxunan təqvim",
    "card.calendar.body": "Hər bron üçün bir zolaq, ona görə girişin və çıxışın harada olduğu görünür. Dövr xülasəsi nə qədər dolu olduğunuzu, giriş və çıxışların sayını və nə qədər borc qaldığını deyir.",
    "card.pricing.title": "Mövsümlə dəyişən qiymətlər",
    "card.pricing.body": "Mövsüm tarifini bir dəfə təyin edin və uzun qalmağa endirim verin. Bron pəncərəsi məbləğin necə yarandığını sətir-sətir göstərir, inanmalı olduğunuz bir rəqəm yerinə.",
    "card.documents.title": "Əsl PDF kimi müqavilə və hesab",
    "card.documents.body": "Uzun icarə üçün müqavilə, hər bron üçün hesab-faktura. İkisi də bronla birlikdə saxlanan rəqəmləri çap edir, bugünkü qiymətləri yox, ona görə köhnə sənəd razılaşdığınızla üst-üstə düşür.",
    "card.sync.title": "Oflayn işləyir, sonra sinxronlaşır",
    "card.sync.body": "Məlumatlarınız sizin maşınınızda saxlanır. Əlaqə qayıdanda tətbiq serveri yaxalayır, iki cihazın razılaşmadığı hər şey isə səssizcə üzərinə yazılmır, siyahı kimi göstərilir.",
    "card.theme.title": "Oxunaqlı, işıqlı və ya tünd",
    "card.theme.body": "İşıqlı və tünd mövzular, gözlərini qıymaq istəməyənlər üçün mətn ölçüsü düyməsi. Kontrast hər ekranda ölçülür, bir dəfə gözlə təxmin edilmir.",
    "card.rental.title": "Uzun icarə qısa qalmanın yanında",
    "card.rental.body": "On iki aylıq müqavilə və iki gecəlik bron eyni təqvimdə və eyni doluluq yoxlamasında oturur, ona görə obyektin boş olub-olmamasında bir-birindən ayrıla bilməzlər.",
    "cal.eyebrow": "Təqvim",
    "cal.title": "Günü bir baxışda anla",
    "cal.body": "Şəbəkə hansı gecələrin tutulduğunu cavablandırır. Əvvəllər xanaları saymağa vadar edən iki sualı isə yanında duran şey cavablandırır: dövr nə qədər doludur və hər obyekt nə vaxt boşalır.",
    "cal.tick1": "Hər bron üçün bir zolaq, qaldığı gecələr boyu",
    "cal.tick2": "Doluluq, girişlər, çıxışlar və dövr üzrə qalıq",
    "cal.tick3": "Hər obyekt ən yaxın boş aralığını deyir",
    "cal.tick4": "Oxlar dövrü vərəqləyir, «Bugün» geri qaytarır",
    "price.eyebrow": "Qiymətlər",
    "price.title": "Mövsümlər, endirimlər və razılaşdığınız qiymət",
    "price.body": "Qayda bir dəfə yazılır: bayram gecələri bahadır, bir həftə on faiz gətirir. Sonra bron pəncərəsi hesabı göstərir. Qiyməti özünüz deyirsinizsə, o, razılaşdırılmış məbləğ kimi saxlanır və tətbiq sizi yenidən hesablamır.",
    "price.tick1": "Mövsüm günləri yox, gecələri əhatə edir",
    "price.tick2": "Endirimlər toplanmır, ona görə uzun müddət tarifi üçqat artırmır",
    "price.tick3": "Yuvarlaqlaşdırma tam minor vahidlərdə yuxarı, kəsr yoxdur",
    "price.tick4": "Qonağın vaxtından əvvəl çıxışı eyni qaydalarla yenidən hesablanır",
    "doc.eyebrow": "Sənədlər",
    "doc.title": "Yoxlamadan keçən sənədlər",
    "doc.body": "İcarə müqaviləsi və hesab-faktura, PDF fayl kimi: çap edə, göndərə və ya hesabata əlavə edə bilərsiniz. Sənədin nömrəsi tarixdən və bronun özündən çıxır, ona görə yenidən yaratmaq başqa nömrə vermir və iki kompüter bu barədə razılaşmaz qala bilməz.",
    "doc.tick1": "Məbləğlər saxlanan brondan gəlir, cari tariflərdən yox",
    "doc.tick2": "Mövsüm sətirləri və endirim ayrıca çap olunur",
    "doc.tick3": "Rekvizitlər bir dəfə, ayarlarda doldurulur",
    "doc.tick4": "Müqavilədə hər iki tərəfin imzası üçün yer var",
    "dl.eyebrow": "Yüklə",
    "dl.title": "Kompüteriniz üçün RentKeeper",
    "dl.versionLabel": "Versiya",
    "dl.lede": "Quraşdırıcıları CI yığır və GitHub-dakı hər buraxılışa əlavə edir.",
    "dl.mac": "Disk obrazı, Apple silicon və Intel",
    "dl.win": "Quraşdırıcı və daşınan versiya, Windows 10 və 11",
    "dl.note1.lead": "Hələ heç bir yığım dərc olunmayıb.",
    "dl.note1.body": "Versiya teqlə işarələnib və quraşdırıcılar ondan yığılır, amma buraxılışa hələ heç nə əlavə edilməyib. Yuxarıdakı düymələr faylların görünəcəyi buraxılışlar səhifəsinə aparır. O vaxta qədər tətbiqi mənbədən yığa bilərsiniz.",
    "dl.note2.lead": "Telefon versiyası yoxdur.",
    "dl.note2.body": "Tətbiq masaüstü üçündür. Arxasında heç nə olmayan telefon düyməsi göstərmirik.",
    "footer.note": "Qonaq evləri və mənzillər üçün bronlar, icarə və pul.",
    "footer.releases": "Buraxılışlar",
    "footer.source": "Mənbə kodu"
  };

  var DICTIONARIES = { ru: RU, az: AZ };

  /** English comes from the page, so the two can never drift apart. */
  var english = new Map();
  function snapshot() {
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      if (!english.has(key)) english.set(key, node.textContent);
    });
  }

  function apply(language) {
    var dictionary = DICTIONARIES[language];
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      var text = dictionary && dictionary[key];
      node.textContent = text != null ? text : english.get(key);
    });
    document.documentElement.lang = language;
    document.querySelectorAll(".lang__btn").forEach(function (button) {
      var active = button.getAttribute("data-lang") === language;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function choose(language) {
    try { localStorage.setItem(STORAGE_KEY, language); } catch (error) { /* private mode */ }
    apply(language);
  }

  function preferred() {
    var saved;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (error) { saved = null; }
    if (saved && (saved === "en" || DICTIONARIES[saved])) return saved;
    // The browser's own preference, so a Russian speaker does not land on English by default.
    var tag = (navigator.language || "en").slice(0, 2).toLowerCase();
    return DICTIONARIES[tag] ? tag : "en";
  }

  function start() {
    snapshot();
    document.querySelectorAll(".lang__btn").forEach(function (button) {
      button.addEventListener("click", function () { choose(button.getAttribute("data-lang")); });
    });
    var language = preferred();
    if (language !== "en") apply(language);
    else apply("en");
    document.documentElement.classList.add("i18n-ready");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
