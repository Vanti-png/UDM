// Which of the extension's two builds this is.
//
// The working tree, the copy loaded unpacked during development, the Firefox
// package and the full Chrome package published beside the app are the full
// build: they list YouTube and lend the browser's sessions. The Chrome Web
// Store refused that build (copyrighted content: a downloader that works on
// YouTube), and its copy is the store build, which does neither -- no YouTube
// pages or players are listed, and it has no session switches and no
// `cookies` permission to read one with.
//
// scripts/extension-edition.mjs writes `true` here in the copy it packs for
// the store. Nothing else decides it: every difference between the builds
// asks this, so the code that ships is the same code, read the other way.
export const STORE = false;
