# Chrome Web Store submission

Everything the dashboard asks for. Paste each block into the field it names.

**Package:** `extension-upload.zip`, from `node scripts/pack-extension.mjs`. That is the **store
build** (see `extension/edition.js`): it lists nothing on YouTube or Spotify, has no session
switches, carries none of their code and does not ask for `cookies` or `alarms`. The script also
strips the development `key` from the manifest, as Google's guidance says, and leaves out
`key.pem`, `sessions.js`, the icon generator, the notes and any test file. Bump `version` in
`extension/manifest.json` before every upload; Chrome refuses a package whose version has not
increased. This one is **1.0.8**.

**Images:** `store-assets/`, from `node scripts/build-store-assets.mjs` (rerun it whenever the
popup or the mark changes). They are photographs of the store build's real popup, rendered with
its own HTML, CSS and JavaScript — not mock-ups — so they show no session switch.

**Language.** The dashboard localizes the **listing** — name, summary, description, images —
once you add a language under Store listing, so both are given below. The **privacy tab** is
one value per field rather than one per language; nothing obliges those to be English, so they
are given in Turkish, which is the language of this account's dashboard. The English wording is
kept in the appendix for a reviewer exchange that happens in English.

**Why there is a store build.** 1.0.5 was refused under "Blue Zinc": facilitating unauthorised
access to or downloading of copyrighted content. It listed YouTube pages, lent the YouTube
session for members-only videos, and its screenshots showed a "YouTube session" switch. Review
counts a repeat refusal against the developer account, so the store build changes all of that
rather than appealing:

- **No YouTube, no Spotify.** `UNLISTED_SITES` in `extension/media.js` holds their hosts in the
  store build: no watch page, short link, track or embedded player of theirs is listed, and the
  popup says the site is not available. (The app finds Spotify songs on YouTube, so Spotify is
  YouTube by another road.) Outside that one list, neither name appears anywhere in the package,
  its listing, its locales or its screenshots.
- **No sessions, not even switched off.** The code only the full build runs -- the sessions, the
  switches, what serves YouTube and Spotify -- is fenced in its file (`// <full>` ...
  `// </full>`) and cut out of the store copy, and `sessions.js` is left out. 1.0.6 had all of it
  in the package behind a flag; a reviewer reading `background.js` would have met "lends the app
  this profile's YouTube and TikTok sessions" on its fifth line. No switches, no `cookies`
  permission, no `alarms` permission. A profile an earlier store copy connected is released on
  the first popup after the update, so the app lets go of the session it held.
- **A privacy policy of its own.** `extension/PRIVACY-CHROME.md` describes the store copy alone;
  `extension/PRIVACY.md`, which describes the full build's YouTube and TikTok sessions, is for
  Firefox.
- **New permissions: none; dropped: two.** Chrome updates it without switching it off.

`scripts/extension/edition.test.mjs` holds all of this: it fails if the store copy names YouTube
or Spotify outside the list, carries a fence, `sessions.js` or a `chrome.cookies` call, or if its
service worker does anything but list, describe and hand over.

The full build — YouTube and the three session switches — goes to addons.mozilla.org (section 5)
and is published beside the app as `extension-full.zip` for loading unpacked. Never upload that
one here.

---

## 1. Store listing — English

**Item name**

```
Universal Downloader Connector
```

**Summary** (132 characters at most)

```
Sends the videos playing in your browser to the Universal Downloader app on this computer, one button per video.
```

**Description**

```
Universal Downloader Connector is the browser half of Universal Downloader, a free desktop application for downloading media.

Play a video on a site and click the extension's icon. The popup lists what the page is playing — streams, video files, audio — each with a Get button. Press it and Universal Downloader comes to the front with the video open, so you can pick the quality before it downloads. The extension never downloads anything itself.

On sites the app knows, the popup offers the page itself, so the app gets the right title and every quality.

Use it only for videos you own or have permission to download.

WHAT IT DOES NOT DO

- It has no server, no analytics and no account. Nothing it sees goes to the developer or to any third party.
- Nothing leaves your computer. The only recipient is the Universal Downloader application, which you installed. It says what each video would download as before you press anything, and downloads one only when you choose to in the app.
- It reads no cookies and no passwords.
- It does not get around DRM. Protected videos are marked "Protected" and have no button.

HOW IT WORKS

1. Install Universal Downloader on your computer and open it once.
2. Add this extension. A page opens explaining the rest.
3. Play a video, click the toolbar icon, press Get.

Universal Downloader is open source: https://github.com/unsalable/downloader
```

**Category:** Tools · **Language:** English

**Images:** `store-assets/en/1-videos.png`, `2-sites.png`, `3-privacy.png` (1280×800),
small promo tile `store-assets/en/promo-tile-440x280.png` (440×280).

---

## 2. Store listing — Türkçe

Mağaza girişi bölümünden dil seçiciyle Türkçe'yi ekleyip bunları doldurun.

**Öğe adı**

```
Universal Downloader Connector
```

**Özet** (en çok 132 karakter)

```
Tarayıcınızda oynayan videoları, her biri için tek düğmeyle bu bilgisayardaki Universal Downloader uygulamasına gönderir.
```

**Açıklama**

```
Universal Downloader Connector, ücretsiz bir masaüstü indirme uygulaması olan Universal Downloader'ın tarayıcı tarafıdır.

Bir sitede bir video oynatın ve eklentinin simgesine tıklayın. Açılır pencere, sayfanın oynattıklarını — akışları, video dosyalarını, sesleri — her birinin yanında bir İndir düğmesiyle listeler. Bastığınızda Universal Downloader video açık olarak öne gelir; indirmeden önce kaliteyi seçersiniz. Eklentinin kendisi hiçbir şey indirmez.

Uygulamanın tanıdığı sitelerde açılır pencere sayfanın kendisini sunar; böylece uygulama doğru başlığı ve her kaliteyi alır.

Yalnızca size ait olan ya da indirme izniniz olan videolar için kullanın.

YAPMADIKLARI

- Sunucusu, analitiği ve hesabı yoktur. Gördüğü hiçbir şey geliştiriciye veya üçüncü bir tarafa gitmez.
- Hiçbir şey bilgisayarınızdan çıkmaz. Tek alıcı, sizin kurduğunuz Universal Downloader uygulamasıdır. Uygulama her videonun nasıl ineceğini siz bir şeye basmadan söyler, ama yalnızca siz uygulamada indirmeyi seçtiğinizde indirir.
- Çerez ya da parola okumaz.
- DRM'yi aşmaz. Korumalı videolar "Korumalı" olarak işaretlenir ve düğmeleri olmaz.

NASIL ÇALIŞIR

1. Universal Downloader'ı bilgisayarınıza kurun ve bir kez açın.
2. Bu eklentiyi ekleyin. Gerisini anlatan bir sayfa kendiliğinden açılır.
3. Bir video oynatın, araç çubuğundaki simgeye tıklayın, İndir'e basın.

Universal Downloader açık kaynaktır: https://github.com/unsalable/downloader
```

**Kategori:** Tools · **Dil:** Türkçe

**Görseller:** `store-assets/tr/1-videos.png`, `2-sites.png`, `3-privacy.png` (1280×800),
küçük tanıtım karosu `store-assets/tr/promo-tile-440x280.png` (440×280).

---

## 3. Gizlilik uygulamaları — alan başına tek değer

Bunlar dile göre çoğalmaz: her alan tek bir değer alır ve onu inceleyen bir kişi okur. Her
izin, mağaza paketinin manifest'indeki bir girdiye karşılık gelir; manifest başka bir şey
istemez. **1.0.5'ten kalan `cookies` ve `alarms` gerekçelerini panodan silin:** mağaza sürümü bu
iki izni artık istemiyor.

**Tek amaç**

```
Kullanıcının tarayıcısında oynayan videoları, aynı bilgisayardaki ve kullanıcının kendisinin kurduğu Universal Downloader masaüstü uygulamasına göndermek; uygulama videoyu açar ve kullanıcı kaliteyi seçip indirmeyi orada seçer. Eklentinin kendisi hiçbir şey indirmez.
```

**İzin: webRequest**

```
Bir sekmenin hangi videoları ve sesleri oynattığını görmek için. Eklenti, sekmelerin medya, XHR ve fetch yanıtlarının başlıklarına bakar (adres, içerik türü, boyut) ve video ya da ses taşıyanları — HLS ve DASH akışlarını, video ve ses dosyalarını — o sekmenin listesine ekler. İstekleri engellemez, değiştirmez veya yönlendirmez; yalnızca yanıt başlıklarını okur. Liste tarayıcının oturum deposunda tutulur, sekme başka bir sayfaya geçince veya kapanınca silinir ve aynı bilgisayardaki Universal Downloader uygulamasından başka hiçbir yere gönderilmez: açılır pencere açıkken, her birinin nasıl ineceğini söylemesi için listelenen ilk birkaç öğe; kullanıcı İndir'e bastığında da o öğe.
```

**İzin: scripting**

```
Kullanıcı araç çubuğundaki simgeye tıkladığında, yalnızca o anki sekmede iki küçük işlev çalıştırmak için: biri sayfanın başlığını, önizleme görselini ve <video>/<audio> öğelerini (adres, kapak, süre, çözünürlük, DRM kullanılıp kullanılmadığı) okur; diğeri bir akışın oynatma listesini, onu ilk yükleyen çerçevenin içinden yeniden okuyarak kalitesini ve süresini öğrenir. Bu işlevler sayfayı değiştirmez, kalıcı bir betik bırakmaz ve kullanıcı tıklamadan hiç çalışmaz. Kullanıcı açılır penceredeki "Sayfadan seç" düğmesine bastığında da, yalnızca o sekmede, paketteki picker.js'i çalıştırmak için: işaretçinin altındaki videoyu, sesi ya da resmi bir çerçeveyle parlatır, tıklanan öğenin adresini, boyutunu ve hangi gönderiye ait olduğunu bulmak için çevresindeki bağlantıları okur; öğe eklentinin açılır penceresinde gösterilir (açılır pencereyi açmayan tarayıcıda sayfada bir kartta). Betik, öğe açılır pencerede gösterilince, kartı kapanınca ya da Esc'ye basılınca kendini tümüyle kaldırır.
```

**Ana makine izni: <all_urls>**

```
Videolar, sitenin kullandığı her türlü sunucudan gelir (CDN'ler, oynatıcı alan adları), bu yüzden webRequest ile hangi videoların oynadığını görmek ve kullanıcının tıkladığı sekmede scripting kullanmak için tüm sitelere erişim gerekir; daha dar bir kalıp, kullanıcının izlediği videoların çoğunu kaçırır. Bu erişim yalnızca medyayı tanımak ve listelemek için kullanılır. Eklenti çerez okumaz.
```

**İzin: nativeMessaging**

```
Bu eklentinin iletişim kurduğu tek kanaldır. Açılır pencerede listelenen ilk birkaç videonun adresini (uygulama her birinin hangi kalitede, hangi biçimde ve yaklaşık ne boyutta ineceğini söylesin diye) ve kullanıcının İndir'e bastığı videonun adresini, Universal Downloader masaüstü uygulamasının kurduğu com.universaldownloader.bridge adlı yerel mesajlaşma sunucusuna Chrome'un stdio kanalı üzerinden gönderir. O sunucuyu Chrome'un kendisi başlatır ve yalnızca bu eklentinin kimliği için başlatır. Hiçbir ağ portu dinlenmez; eklentinin bir sunucusu yoktur.
```

**İzin: storage**

```
chrome.storage.local içinde tek bir değer: bu tarayıcı profili için rastgele bir tanımlayıcı, masaüstü uygulaması bir Chrome profilini diğerinden ayırabilsin diye. chrome.storage.session içinde, bellekte, her sekmenin oynattığı medyanın listesi ve uygulamanın son birkaç videonun nasıl ineceğine verdiği yanıtlar; sekme kapanınca ve tarayıcı kapanınca silinir.
```

**Uzaktan kod:** Hayır, uzaktan kod kullanmıyorum.

```
Tüm mantık yüklenen paketin içindedir. Eklenti hiçbir yerden betik yüklemez, çalışma zamanında hiçbir kod değerlendirmez ve küçültülmemiş ya da gizlenmemiştir; background.js ve media.js yayınlandığı haliyle okunabilir. scripting ile çalıştırılan iki işlev ve picker.js de pakettedir.
```

**Veri kullanımı**

Şu üç kutuyu işaretleyin. Hiçbiri geliştiriciye gitmez, ama hepsi eklentinin elinden geçer ve
kullanıcı İndir'e bastığında aynı bilgisayardaki uygulamaya aktarılır; işaretlememek,
açıklamayla çelişen bir beyan olur. **Kimlik doğrulama bilgileri** kutusunu bu sürümde
işaretlemeyin — mağaza sürümü çerez okumaz:

- **Web geçmişi** — İndir'e basılan sekmenin adresi ve başlığı.
- **Kullanıcı etkinliği** — ağ izleme: sekmelerin medya isteklerine bakılır.
- **Web sitesi içeriği** — sayfanın başlığı, önizleme görseli ve medya adresleri.

Diğerlerini (kişisel kimlik, kimlik doğrulama, sağlık, finans, kişisel iletişim, konum)
işaretlemeyin; eklenti onlara dokunmaz.

Verinin ne için kullanıldığını soran kutuya:

```
Sekmelerin oynattığı medyanın adresleri, eklentinin kendi açılır penceresinde listelenmek için tarayıcının oturum deposunda tutulur ve sekme kapanınca silinir. Açılır pencere açıkken, listelenen ilk birkaç öğe için aşağıdaki bilgiler, uygulama her birinin nasıl ineceğini söyleyebilsin diye aynı uygulamaya sorulur; uygulama bunun için hiçbir şey indirmez ve saklamaz. Kullanıcı İndir'e bastığında yalnızca o öğenin adresi ve türü, sayfanın adresi ve başlığı, isteğin yönlendiren adresi ve kökeni, tarayıcının kullanıcı aracısı dizesi ve önizleme görselinin adresi, Chrome'un yerel mesajlaşma kanalı üzerinden kullanıcının aynı bilgisayara kendisinin kurduğu masaüstü uygulamasına aktarılır. Hiçbiri geliştirici tarafından toplanmaz, hiçbir sunucuya iletilmez ve kimseyle paylaşılmaz.
```

Üç beyanı da onaylayın; burada üçü de doğrudur:

- verinin üçüncü taraflara satılmadığı;
- verinin, beyan edilen tek amaçla ilgisi olmayan bir amaç için kullanılmadığı veya
  aktarılmadığı;
- verinin kredi değerlendirmesi amacıyla kullanılmadığı veya aktarılmadığı.

**Gizlilik politikası URL'si**

```
https://github.com/unsalable/downloader/blob/main/extension/PRIVACY-CHROME.md
```

`extension/PRIVACY-CHROME.md` yalnızca mağaza sürümünü anlatır (oturum yok, çerez yok), iki dili
de taşır ve iletişim için GitHub Issues adresini verir. 1.0.5'te bu alanda `PRIVACY.md` vardı;
o dosya tam sürümün YouTube ve TikTok oturumlarını anlatır, mağazaya gösterilmez. URL'nin
çalışması için dosyanın `main` dalına itilmiş olması gerekir.

---

## 3b. Test talimatları — Erişim › Test talimatları

İnceleyici için. İngilizce, çünkü inceleme ekibi panonun dilinden bağımsızdır. Kullanıcı adı ve
parola alanları boş kalır: hiçbir hesap gerekmez.

```
No account or sign-in is needed to test this extension.

1. Install Universal Downloader, the free, open-source Windows application this extension works with: https://github.com/unsalable/downloader/releases/tag/latest (UniversalDownloader_x64-setup.exe). Open the app once; it registers com.universaldownloader.bridge, the native messaging host the extension talks to.
2. Open a page that plays a video, for example https://hls-js.netlify.app/demo/, and let it play.
3. Click the extension's toolbar icon. The popup lists the video with the quality, format and size the app would download. Press Get: the app comes to the front with the video open, and nothing is downloaded until the user chooses to download it there.

Without the app, the popup still lists the video and says the app needs to be installed.

What it does not do: it lists nothing on YouTube or Spotify, nor from their players embedded on other sites (the popup says it is not available there). It has no cookies permission and reads no cookies. DRM-protected videos are marked "Protected" and have no button. It sends nothing over the network; its only channel is the native messaging host above, on the same computer.
```

---

## 4. Mağaza kimliği

Mağaza kendi eklenti kimliğini üretir ve geliştirme `key` alanını yok sayar; yayımlanan eklentinin
kimliği `oikcjjcihkfmgmmmjagilnfgnfilghic`, paketsiz kurulanınki `bkoicficlaelgjpjhlddhloepoocpfoj`.
Masaüstü uygulaması tanımadığı hiçbir kimliğe cevap vermez, bu yüzden ikisi de
`src-tauri/src/bridge/protocol.rs` içinde durur (`EXTENSION_ID_STORE`, `EXTENSION_ID_DEV`).
Mağaza kimliğini tanımayan bir uygulama sürümü, mağazadan kurulan eklentide "Universal
Downloader'ı güncelleyin" olarak görünür; o sürüm yayımlanmadan bu eklentiyi duyurmayın.

`extension/key.pem` dosyasını yeniden üretmeyin. Geliştirme kimliğini o sabitler; yenisi,
`EXTENSION_ID_DEV` güncellenene kadar host'un geliştirme derlemelerine cevap vermesini sessizce
durdurur.

---

## 5. addons.mozilla.org

**Package:** `extension-firefox.zip`, from `node scripts/pack-extension.mjs --firefox`: the
**full build**, with YouTube and the three session switches, in the same version as Chrome's;
only the manifest is changed for Firefox (see `extension/README.md`).

**Listing.** Sections 1 and 2 fit AMO's fields, with two changes for the full build: the sites
line may name them ("On YouTube, Vimeo, X, Instagram, TikTok, Dailymotion and the other sites the
app knows, …" / "YouTube, Vimeo, X, Instagram, TikTok, Dailymotion ve uygulamanın tanıdığı diğer
sitelerde …"), and the "It reads no cookies" line is replaced with this paragraph:

```
For members-only YouTube videos you already pay for, turn on "YouTube session" in the popup, which it shows on YouTube; for age-restricted TikTok posts your own account can see, "TikTok session", which it shows on TikTok; for posts on any other site that only your account can see, "Session on other sites", which lends the sign-in of the site you press Get on, for that download. Each lends only to the app on this computer, and is off until you turn it on.
```

```
Zaten ödediğiniz, üyelere özel YouTube videoları için YouTube'dayken görünen "YouTube oturumu" anahtarını; kendi hesabınızın görebildiği yaş sınırlı TikTok gönderileri için TikTok'tayken görünen "TikTok oturumu" anahtarını; başka bir sitede yalnızca hesabınızın görebildiği gönderiler için de "Diğer sitelerde oturum" anahtarını açın. Bu anahtar, İndir'e bastığınız sitenin oturumunu yalnızca o indirme için verir. Her anahtar oturumu yalnızca bu bilgisayardaki uygulamaya verir ve siz açana kadar kapalıdır.
```

**Data collection.** The Firefox manifest declares `data_collection_permissions: { required:
["none"] }`: nothing the extension handles leaves the computer or reaches the developer. The
cookies the session switches read go to the Universal Downloader application on the same computer
over native messaging. If a reviewer counts that as collecting authentication information all the
same, the category that fits is `authenticationInfo`, as optional rather than required, since
nothing is read until the user turns a switch on. The declaration lives in `forFirefox()` in
`scripts/pack-extension.mjs`.

**Notes to reviewer**

```
The extension has no server and sends nothing over the network. It talks only to com.universaldownloader.bridge, a native messaging host installed by the Universal Downloader desktop application on the same computer (free, open source: https://github.com/unsalable/downloader/releases/tag/latest). No site account is needed to test it: play a video on any site, click the toolbar icon, press Get. Three switches in the popup, "YouTube session", "TikTok session" and "Session on other sites", are off until the user turns them on. The first two each let the extension read that one site's cookies (youtube.com or tiktok.com) and pass them to that application, so it can download members-only YouTube videos the user pays for and age-restricted TikTok posts the user's own account can see. "Session on other sites" reads the cookies of one site only when the user presses Get on that site's page -- the page's registrable domain, never YouTube's or TikTok's -- and the application keeps them, encrypted, for at most an hour. Turning a switch off tells the application to delete what it holds. No source file is minified or generated.
```

**Version notes.** For addons.mozilla.org, which has 1.0.7:

```
1.0.8: Pick from the page: the button beside the popup's heading lets you click the video, sound or picture on the page itself, and the popup then shows what the app would download from it, with Get and Pick again. The third session switch is now called "Session on other sites", and its lines say what it is for and what Get does with it.
```

The notes 1.0.7 went out with:

```
1.0.7: Get opens the video in the app, where the quality is chosen before it downloads. "TikTok session" lends the browser's TikTok sign-in for age-restricted posts, and "Other sites" lends the sign-in of the site Get is pressed on, for that download. YouTube's and TikTok's switches show on their own sites. Each sends only to the Universal Downloader application on this computer.
```

---

## Ek — the same privacy answers in English

Kept for a review exchange that happens in English, or if the dashboard language changes.
These are the same statements as section 3, for the store build, not different ones.

**Single purpose**

```
Sending the videos playing in the user's browser to the Universal Downloader desktop application, which the user installed on the same computer; the application opens the video, and the user chooses the quality and the download there. The extension itself downloads nothing.
```

**Permission: webRequest**

```
To see which videos and sounds a tab plays. The extension looks at the response headers of tabs' media, XHR and fetch requests (address, content type, size) and adds the ones carrying video or audio — HLS and DASH streams, video and audio files — to that tab's list. It does not block, modify or redirect any request; it only reads response headers. The list is kept in the browser's session storage, dropped when the tab moves to another page or closes, and passed nowhere but to the Universal Downloader application on the same computer: the first few listed items while the popup is open, so the application can say how each would download, and an item the user presses Get on.
```

**Permission: scripting**

```
When the user clicks the toolbar icon, and only in that tab, to run two small functions: one reads the page's title, preview image and <video>/<audio> elements (address, poster, length, resolution, whether DRM is in use); the other reads a stream's playlist again from inside the frame that first loaded it, to learn its quality and length. Neither changes the page, neither leaves a script behind, and neither runs without the user's click. And when the user presses "Pick from the page" in the popup, and only in that tab, to run picker.js from the package: it makes the video, sound or picture under the pointer glow, and reads the clicked element's address and size and the links around it to find the post it belongs to; the element is then shown in the extension's popup (in a card on the page, where the browser will not open the popup). The script removes itself entirely once the popup shows the element, its card closes, or Esc is pressed.
```

**Host permission: <all_urls>**

```
Videos come from whatever servers a site uses (CDNs, player domains), so seeing which videos play with webRequest, and using scripting in the tab the user clicked on, needs access to all sites; any narrower pattern misses most of what users watch. The access is used only to recognise and list media. The extension reads no cookies.
```

**Permission: nativeMessaging**

```
The only channel this extension communicates over. It sends the addresses of the first few videos listed in the popup (so the application can say at what quality, in what format and at roughly what size each would download) and the address of the video the user pressed Get on to com.universaldownloader.bridge, a native messaging host installed by the Universal Downloader desktop application, using Chrome's stdio channel. Chrome starts that host itself and only for this extension's ID. Nothing listens on a network port; the extension has no server.
```

**Permission: storage**

```
One value in chrome.storage.local: a random identifier for this browser profile, so the desktop application can tell one Chrome profile from another. In chrome.storage.session, in memory, each tab's list of the media it played and the application's answers about how the last few videos would download, dropped when the tab or the browser closes.
```

**Remote code:** No, I am not using remote code.

```
All logic is contained in the uploaded package. The extension loads no scripts from anywhere, evaluates nothing at runtime, and is not minified or obfuscated — background.js and media.js can be read as shipped. Both functions run with scripting, and picker.js, are in the package.
```

**Data usage**

Tick Web history, User activity and Website content. Leave Authentication information unticked:
the store build reads no cookies.

```
The addresses of the media tabs play are kept in the browser's session storage, to be listed in the extension's own popup, and dropped when the tab closes. While the popup is open, the details below are passed for the first few listed items to the same application, so it can say how each would download; it downloads and keeps nothing for this. When the user presses Get, only that item's address and kind, the page's address and title, the request's referrer and origin, the browser's user-agent string and the preview image's address are passed, over Chrome's native messaging channel, to a desktop application the user installed on the same computer. None of it is collected by the developer, transmitted to any server or shared with anyone.
```
