// Which of the extension's two builds this is.
// <full>
//
// The working tree, the copy loaded unpacked during development, the Firefox
// package and the full Chrome package published beside the app are the full
// build: they list YouTube and lend the browser's sessions. The Chrome Web
// Store refused that build (copyrighted content: a downloader that works on
// YouTube), and its copy is the store build, which does neither -- no YouTube
// or Spotify pages or players are listed, and it has no session switches and
// no `cookies` permission to read one with.
//
// The store build is made by scripts/extension-edition.mjs, and in two ways.
// What only the full build does is fenced where it is written, as this
// paragraph is, and the store copy is cut without it: it does not ship that
// code switched off, it does not ship it. What only the store build does asks
// this flag, which the same script writes `true` into in the copy it packs.
// </full>
export const STORE = false;
