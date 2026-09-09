// src/lib/fsCompat.js
//
// Livello di compatibilità tra:
//  - la File System Access API del browser (window.showDirectoryPicker, FileSystemDirectoryHandle,
//    FileSystemFileHandle) usata finora da LibraryView.jsx
//  - i plugin nativi di Tauri (@tauri-apps/plugin-dialog, @tauri-apps/plugin-fs), necessari perché
//    su macOS il WebView (WKWebView) ha lo stesso supporto limitato di Safari per questa API.
//
// L'idea: le classi Tauri* qui sotto espongono la STESSA forma (kind, name, values(),
// getDirectoryHandle, getFileHandle, removeEntry, getFile, isSameEntry...) degli handle nativi,
// così il resto del codice (buildSearchIndex, handleOpenFolder, handleDeleteVideo, ecc.) non deve
// sapere su quale piattaforma gira: chiama sempre le stesse funzioni.
//
// ATTENZIONE: gli identificatori dei permessi Tauri (capabilities) per il plugin fs possono
// cambiare tra le versioni: verifica sempre contro la versione di @tauri-apps/plugin-fs che
// installi (vedi src-tauri/capabilities/default.json e TAURI-SETUP.md).

let tauriFsPromise = null;
let tauriDialogPromise = null;
let tauriCorePromise = null;

// Import "pigri": su web questi pacchetti non sono nemmeno installati, quindi non vanno
// importati staticamente in cima al file (romperebbe la build del sito normale).
const loadTauriFs = () => {
  if (!tauriFsPromise) tauriFsPromise = import('@tauri-apps/plugin-fs');
  return tauriFsPromise;
};
const loadTauriDialog = () => {
  if (!tauriDialogPromise) tauriDialogPromise = import('@tauri-apps/plugin-dialog');
  return tauriDialogPromise;
};
const loadTauriCore = () => {
  if (!tauriCorePromise) tauriCorePromise = import('@tauri-apps/api/core');
  return tauriCorePromise;
};

// Tauri v2 inietta questo oggetto globale nella pagina: è il modo standard per capire
// se il codice gira dentro l'app desktop oppure in un browser qualsiasi.
export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Unisce segmenti di percorso con "/": Tauri accetta "/" anche su Windows per le
// operazioni fs, ma se preferisci i separatori nativi usa `@tauri-apps/api/path`'s join().
const joinPath = (...parts) =>
  parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/');

const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;

// --- Lettura a intervalli (non carica mai l'intero file in memoria) -------------------
// Usata per leggere solo le intestazioni dei box mp4/mov (extractMp4TechnicalMeta),
// esattamente come faceva file.slice(start, end).arrayBuffer() nel browser.
async function readByteRange(path, start, end) {
  const { open, SeekMode } = await loadTauriFs();
  const handle = await open(path, { read: true });
  try {
    if (start > 0) await handle.seek(start, SeekMode.Start);
    const length = Math.max(0, end - start);
    const buffer = new Uint8Array(length);
    let readTotal = 0;
    while (readTotal < length) {
      const n = await handle.read(buffer.subarray(readTotal));
      if (n === null || n === undefined || n <= 0) break;
      readTotal += n;
    }
    return buffer.buffer.slice(0, readTotal);
  } finally {
    await handle.close();
  }
}

// --- Handle "file" compatibile con FileSystemFileHandle --------------------------------
class TauriFileHandle {
  constructor(path, name) {
    this.kind = 'file';
    this.name = name;
    this.path = path;
    this.isTauriHandle = true;
  }

  // Ritorna un oggetto "File-like": stessa interfaccia usata dal resto del codice
  // (.name, .size, .slice(start,end).arrayBuffer()), ma senza mai caricare in RAM
  // l'intero file video.
  async getFile() {
    const { stat } = await loadTauriFs();
    const info = await stat(this.path);
    const path = this.path;
    const name = this.name;
    const size = info.size;

    return {
      name,
      size,
      // Marcatore interno: usato da getPlayableUrl() per scegliere convertFileSrc()
      // invece di URL.createObjectURL() quando si tratta di riprodurre il video.
      __tauriPath: path,
      slice(start = 0, end = size) {
        return { arrayBuffer: () => readByteRange(path, start, end) };
      },
      arrayBuffer: () => readByteRange(path, 0, size),
    };
  }

  async remove() {
    const { remove } = await loadTauriFs();
    await remove(this.path);
  }
}

// --- Handle "directory" compatibile con FileSystemDirectoryHandle ----------------------
class TauriDirectoryHandle {
  constructor(path, name) {
    this.kind = 'directory';
    this.name = name;
    this.path = path;
    this.isTauriHandle = true;
  }

  // Equivalente di "for await (const entry of dirHandle.values())"
  async *values() {
    const { readDir } = await loadTauriFs();
    const entries = await readDir(this.path);
    for (const e of entries) {
      const childPath = joinPath(this.path, e.name);
      yield e.isDirectory
        ? new TauriDirectoryHandle(childPath, e.name)
        : new TauriFileHandle(childPath, e.name);
    }
  }

  async getDirectoryHandle(name) {
    return new TauriDirectoryHandle(joinPath(this.path, name), name);
  }

  async getFileHandle(name, { create = false } = {}) {
    const path = joinPath(this.path, name);
    if (create) {
      const { exists, writeFile } = await loadTauriFs();
      if (!(await exists(path))) {
        await writeFile(path, new Uint8Array());
      }
    }
    return new TauriFileHandle(path, name);
  }

  async removeEntry(name) {
    const { remove } = await loadTauriFs();
    await remove(joinPath(this.path, name));
  }

  async isSameEntry(other) {
    return !!other && other.path === this.path;
  }
}

// --- API pubbliche usate da LibraryView.jsx / App.jsx -----------------------------------

// Sostituisce window.showDirectoryPicker({ mode }) sia per l'apertura della libreria
// sia per la scelta della cartella di destinazione nel trasferimento.
export async function pickDirectory({ mode } = {}) {
  if (!isTauri()) {
    return window.showDirectoryPicker({ mode });
  }
  const { open } = await loadTauriDialog();
  const selected = await open({ directory: true, multiple: false });
  if (!selected) {
    const err = new Error('Selezione annullata');
    err.name = 'AbortError';
    throw err;
  }
  return new TauriDirectoryHandle(selected, baseName(selected));
}

// Ritorna un URL riproducibile per <video src="...">. Su Tauri usa il protocollo
// asset nativo (streaming diretto dal disco, senza caricare il file in memoria);
// nel browser usa il normale URL.createObjectURL(). Le chiamate a
// URL.revokeObjectURL() esistenti nel resto del codice restano innocue anche se
// l'URL è un asset:// Tauri (sono un no-op sugli URL non registrati come Blob).
export async function getPlayableUrl(file) {
  if (file && file.__tauriPath) {
    const { convertFileSrc } = await loadTauriCore();
    return convertFileSrc(file.__tauriPath);
  }
  return URL.createObjectURL(file);
}

// Confronta due handle di cartella (sostituisce dirHandle.isSameEntry(other) del browser,
// che su Tauri non esiste: qui confrontiamo semplicemente i percorsi).
export async function isSameEntry(a, b) {
  if (!a || !b) return false;
  if (isTauri()) return a.path === b.path;
  return a.isSameEntry ? a.isSameEntry(b) : false;
}

// Sposta un file da sourceDirHandle a destDirHandle. Su Tauri usa rename() nativo
// (istantaneo se stessa unità disco) con fallback copia+elimina se sono su dischi
// diversi. Nel browser replica il comportamento originale (createWritable + write).
export async function moveFileTo(sourceFileHandle, sourceDirHandle, destDirHandle, name) {
  if (isTauri()) {
    const { rename, copyFile, remove } = await loadTauriFs();
    const destPath = joinPath(destDirHandle.path, name);
    try {
      await rename(sourceFileHandle.path, destPath);
    } catch (err) {
      // Probabile spostamento tra dischi/volumi diversi: rename() nativo spesso
      // non lo permette, quindi si copia e poi si elimina l'originale.
      await copyFile(sourceFileHandle.path, destPath);
      await remove(sourceFileHandle.path);
    }
    return;
  }

  const file = await sourceFileHandle.getFile();
  const destFileHandle = await destDirHandle.getFileHandle(name, { create: true });
  const writable = await destFileHandle.createWritable();
  await writable.write(file);
  await writable.close();
  if (sourceDirHandle) {
    await sourceDirHandle.removeEntry(name);
  }
}
