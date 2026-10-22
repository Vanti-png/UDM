# Privacy policy — Universal Downloader Connector (Chrome Web Store)

_Last updated: 18 October 2026_

This policy is for the copy of the extension installed from the Chrome Web
Store.

This extension does not have a server. Nothing it sees is sent to the
developer, to any website, or to any third party. There is no analytics, no
telemetry and no account. The only thing it ever sends anything to is the
Universal Downloader application on your own computer.

It does not ask for the `cookies` permission and reads no cookies, passwords or
sign-ins.

## What it looks at, and why

**The video and audio your tabs play.** To list them, the extension watches
the network requests your tabs make and looks at the ones that carry video or
audio: their address, the type and size the server reports, and which page and
frame asked for them. Other requests are looked at only long enough to see
that they are not media. What it keeps is held in the browser's session
storage, in memory: the list for a tab is dropped when the tab moves to another
page or closes, and all of it is gone when the browser closes.

**The page you open the popup on.** When you click the toolbar icon, the
extension reads the current tab's title, its preview image address, and its
`<video>` and `<audio>` elements (their address, poster, length and size, and
whether the site protects them with DRM). To learn a stream's quality and
length it may read the stream's playlist again, from inside the page that
loaded it -- the same request the page made, often answered from the browser's
cache. The popup shows the page's preview images, loaded from the site that
serves them.

**The element you pick on the page.** When you press **Pick from the page**
in the popup, the extension outlines the video, sound or picture under your
pointer, in that tab only, until you click one or press Esc. Of the one you
click it reads the address (for a picture, also the larger sizes the page
offers of it, and its size), the poster, the length, whether DRM protects it,
and the links around it on the page, to find the post it belongs to. A card
on the page then shows it; the app is asked how it would download it, as for
the popup's first rows, and it is handed over only when you press **Get** on
the card. What the click found is kept in session storage until the card
closes.

## What it sends, and where

To one place: a program called `ud-bridge.exe`, part of the Universal Downloader
desktop application, running on the same computer as your browser. Chrome starts
that program itself, over its native messaging channel, and only for this
extension.

- **When you open the popup:** a question -- is the app installed, and can it
  take a download? It carries the profile identifier below, the browser's name
  and the extension's version, and nothing about the page. If an earlier
  version of the extension had lent the app a sign-in, the popup also tells the
  app to delete it.
- **When the popup lists a video, or the picker's card shows one:** the same
  details as below, for each of the first few items it lists and for the one
  you picked, so the app can say what it would download -- the title, the
  picture, the quality, the format and roughly the size. The app
  reads the video's page or stream from the site to answer, as it would before
  downloading; it downloads nothing and keeps nothing for this.
- **When you press Get (İndir in Turkish), in the popup or on the card:**
  that one item's address and kind, the page's title and address, the
  referring address and origin the request was made with, your browser's
  user-agent string and the preview image address.
  The app opens the video, and only when you have chosen the quality and
  pressed download there does it download it from the site, as your browser
  would. Nothing is downloaded for items you do not press.

You can confirm all of this by reading `background.js`, which is not minified
or obfuscated.

## What the extension stores by itself

In `chrome.storage.local`, on your own machine: a random identifier for this
browser profile, so the app can tell one Chrome profile from another.

In `chrome.storage.session`, in memory: the per-tab lists described above,
the element you picked until its card closes, and the app's answers about how
the last few listed videos would download. All of it is gone when the browser
closes.

No cookies are stored by the extension, and no browsing history is kept beyond
the open tabs.

## Your control

- Nothing about the pages you visit leaves the browser until you open the popup
  on them, and nothing is downloaded until you press **Get** and then choose to
  download in the app.
- Removing the extension stops it entirely.

## What is never done

The data this extension handles is not sold, not transferred to anyone, not
used for advertising or creditworthiness, and not used for any purpose other
than the one described above. DRM-protected media is never circumvented: the
extension marks it as protected and offers no way to download it.

## Contact

Questions and reports: https://github.com/unsalable/downloader/issues

---

# Gizlilik politikası — Universal Downloader Connector (Chrome Web Mağazası)

_Son güncelleme: 18 Ekim 2026_

Bu politika, eklentinin Chrome Web Mağazası'ndan kurulan kopyası içindir.

Bu eklentinin sunucusu yok. Gördüğü hiçbir şey geliştiriciye, herhangi bir
siteye veya üçüncü bir tarafa gönderilmiyor. Analitik yok, telemetri yok, hesap
yok. Bir şey gönderdiği tek yer, kendi bilgisayarınızdaki Universal Downloader
uygulamasıdır.

`cookies` iznini istemez; hiçbir çerez, parola ya da oturum bilgisi okumaz.

## Neye bakıyor, neden

**Sekmelerinizin oynattığı video ve sesler.** Bunları listelemek için eklenti,
sekmelerinizin yaptığı ağ isteklerini izler ve video ya da ses taşıyanlara
bakar: adreslerine, sunucunun bildirdiği türe ve boyuta, onları hangi sayfanın
ve çerçevenin istediğine. Diğer isteklere yalnızca medya olmadıklarını görecek
kadar bakılır. Tuttukları tarayıcının oturum deposunda, bellekte durur: bir
sekmenin listesi sekme başka bir sayfaya geçince ya da kapanınca silinir,
tarayıcı kapanınca hepsi gider.

**Açılır pencereyi açtığınız sayfa.** Araç çubuğundaki simgeye tıkladığınızda
eklenti, geçerli sekmenin başlığını, önizleme görselinin adresini ve
`<video>`/`<audio>` öğelerini (adreslerini, kapak görsellerini, sürelerini ve
boyutlarını, sitenin onları DRM ile koruyup korumadığını) okur. Bir akışın
kalitesini ve süresini öğrenmek için akışın oynatma listesini, onu yükleyen
sayfanın içinden yeniden okuyabilir -- sayfanın yaptığı isteğin aynısı; çoğu
zaman tarayıcının önbelleğinden yanıtlanır. Açılır pencere, sayfanın önizleme
görsellerini onları sunan siteden yükleyerek gösterir.

**Sayfada seçtiğiniz öğe.** Açılır penceredeki **Sayfadan seç**'e
bastığınızda eklenti, yalnızca o sekmede, işaretçinizin altındaki videonun,
sesin ya da resmin çevresine, siz birine tıklayana ya da Esc'ye basana kadar
bir çerçeve çizer. Tıkladığınızın adresini (resimse sayfanın onun için sunduğu
daha büyük boyutları ve boyutunu da), kapak görselini, süresini, DRM ile
korunup korunmadığını ve hangi gönderiye ait olduğunu bulmak için sayfada
çevresindeki bağlantıları okur. Ardından sayfada bir kart onu gösterir:
uygulamaya, açılır penceredeki ilk satırlar için olduğu gibi nasıl ineceği
sorulur; uygulamaya ise yalnızca karttaki **İndir**'e bastığınızda verilir.
Tıklamanın bulduğu, kart kapanana kadar oturum deposunda tutulur.

## Neyi, nereye gönderiyor

Tek bir yere: Universal Downloader masaüstü uygulamasının parçası olan ve
tarayıcınızla aynı bilgisayarda çalışan `ud-bridge.exe` adlı programa. O
programı Chrome'un kendisi, yerel mesajlaşma kanalı üzerinden ve yalnızca bu
eklenti için başlatır.

- **Açılır pencereyi açtığınızda:** bir soru -- uygulama kurulu mu, indirme
  alabilir mi? Aşağıdaki profil tanımlayıcısını, tarayıcının adını ve
  eklentinin sürümünü taşır; sayfa hakkında hiçbir şey taşımaz. Eklentinin
  daha önceki bir sürümü uygulamaya bir oturum vermişse açılır pencere
  uygulamaya onu silmesini de söyler.
- **Açılır pencere bir video listelediğinde ya da seçicinin kartı birini
  gösterdiğinde:** listelediği ilk birkaç öğenin ve seçtiğiniz öğenin her biri
  için aşağıdaki bilgilerin aynısı; uygulama ne indireceğini -- başlığı,
  görseli, kaliteyi, biçimi ve yaklaşık boyutu -- söyleyebilsin diye.
  Uygulama bunu yanıtlamak için videonun sayfasını ya da akışını, indirmeden
  önce yaptığı gibi siteden okur; bunun için hiçbir şey indirmez ve saklamaz.
- **Açılır pencerede ya da kartta İndir'e bastığınızda:** o tek öğenin adresi
  ve türü, sayfanın başlığı ve adresi, isteğin yapıldığı yönlendiren adres ve
  köken, tarayıcınızın kullanıcı aracısı dizesi ve önizleme görselinin
  adresi. Uygulama videoyu açar; onu
  siteden, tarayıcınızın yapacağı gibi, ancak siz orada kaliteyi seçip
  indirmeye bastığınızda indirir. Basmadığınız öğeler için hiçbir şey
  indirilmez.

Bunların hepsini, küçültülmemiş ve gizlenmemiş olan `background.js` dosyasını
okuyarak doğrulayabilirsiniz.

## Eklentinin kendi sakladıkları

Kendi makinenizdeki `chrome.storage.local` içinde: bu tarayıcı profili için
rastgele bir tanımlayıcı; uygulama bir Chrome profilini diğerinden ayırabilsin
diye.

`chrome.storage.session` içinde, bellekte: yukarıda anlatılan sekme
listeleri, kartı kapanana kadar seçtiğiniz öğe ve uygulamanın listelenen son
birkaç videonun nasıl ineceğine verdiği yanıtlar. Hepsi tarayıcı kapanınca
gider.

Eklenti hiçbir çerezi saklamaz ve açık sekmelerin ötesinde bir gezinme geçmişi
tutmaz.

## Sizin denetiminiz

- Ziyaret ettiğiniz sayfalar hakkında hiçbir şey, siz o sayfada açılır
  pencereyi açana kadar tarayıcıdan çıkmaz; siz **İndir**'e basıp ardından
  uygulamada indirmeyi seçene kadar da hiçbir şey indirilmez.
- Eklentiyi kaldırmak onu tamamen durdurur.

## Asla yapılmayanlar

Bu eklentinin işlediği veri satılmaz, kimseye aktarılmaz, reklam veya kredi
değerlendirmesi için kullanılmaz ve yukarıda anlatılanın dışında hiçbir amaçla
kullanılmaz. DRM ile korunan medya asla aşılmaz: eklenti onu korumalı olarak
işaretler ve indirmek için hiçbir yol sunmaz.

## İletişim

Sorular ve bildirimler: https://github.com/unsalable/downloader/issues
