# Portare "Regia Video" su desktop (Mac + Windows) con Tauri

Questo scaffold trasforma la tua app Vite + React esistente in un'app
desktop nativa, senza toccare il codice React che hai già.

## 1. Copia questi file nel progetto

Estrai lo zip e copia dentro la cartella del tuo progetto (dove hai
`package.json`, `vite.config.js`, `src/`, ecc.):

```
tuo-progetto/
├── src-tauri/          <- copia questa cartella intera
├── .github/            <- (opzionale, solo se usi GitHub per le release)
└── ... (i tuoi file esistenti, invariati)
```

## 2. Installa i prerequisiti

**Su ogni macchina di sviluppo** (una volta sola):

- **Rust**: https://rustup.rs (comando unico, sia Mac che Windows)
- **Mac**: Xcode Command Line Tools → `xcode-select --install`
- **Windows**:
  - Microsoft C++ Build Tools (installali da https://visualstudio.microsoft.com/visual-cpp-build-tools/, seleziona "Desktop development with C++")
  - WebView2 → già preinstallato su Windows 10/11 aggiornati, nessuna azione necessaria

## 3. Aggiungi le dipendenze npm

Nel tuo `package.json` esistente:

```bash
npm install -D @tauri-apps/cli
npm install @tauri-apps/api
```

E aggiungi questi script (accanto a `dev` e `build` che hai già):

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "tauri": "tauri",
  "dev:desktop": "tauri dev",
  "build:desktop": "tauri build"
}
```

## 4. Genera l'icona dell'app

Serve un'immagine quadrata (idealmente 1024×1024px, PNG con sfondo).
Tauri genera automaticamente tutte le taglie e i formati necessari
(.icns per Mac, .ico per Windows):

```bash
npx tauri icon percorso/al/tuo/logo.png
```

Questo popola la cartella `src-tauri/icons/` già referenziata in
`tauri.conf.json`.

## 5. Prova in locale

```bash
npm run dev:desktop
```

Si apre una finestra nativa con dentro la tua app React — Libreria e
Regia funzionano esattamente come nel browser (usa lo stesso codice).

## 6. Genera l'app installabile

```bash
npm run build:desktop
```

Questo produce, **per il sistema operativo su cui lo lanci**:

- Su **Mac**: un `.app` e un `.dmg` in `src-tauri/target/release/bundle/`
- Su **Windows**: un `.exe` (NSIS) e un `.msi` in `src-tauri/target/release/bundle/`

⚠️ **Importante**: non puoi generare l'installer Windows da un Mac (o
viceversa) — servono i tool nativi della piattaforma di destinazione.
Le opzioni sono:

1. Buildare su una macchina Mac e una Windows separatamente, oppure
2. Usare il workflow CI incluso in `.github/workflows/build-desktop.yml`,
   che builda **automaticamente entrambe le versioni** su GitHub Actions
   (gratis per repo pubblici, incluso in molti piani per i privati) —
   ti basta pushare un tag tipo `v1.0.0` o lanciarlo a mano dalla tab
   "Actions" di GitHub.

## Nota sulla File System Access API

La tua app usa `showDirectoryPicker()` per aprire le cartelle video.
Dentro Tauri questa API funziona regolarmente perché la finestra usa
il motore Chromium/WebKit di sistema (WebView2 su Windows, WKWebView
su Mac) — su Mac WKWebView ha però lo stesso supporto limitato di
Safari per questa API. Se ti serve accesso file affidabile su
**entrambe** le piattaforme, conviene sostituire
`showDirectoryPicker`/`FileSystemHandle` con i comandi nativi di
Tauri (`@tauri-apps/plugin-dialog` per scegliere la cartella e
`@tauri-apps/plugin-fs` per leggerne il contenuto) — dimmelo se vuoi
che ti prepari questa migrazione, è un cambio contenuto.
