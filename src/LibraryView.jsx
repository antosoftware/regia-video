import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import './App.css';
import { pickDirectory, getPlayableUrl, isSameEntry, moveFileTo } from './lib/fsCompat';

// Bande dell'analizzatore di spettro: alterna un valore in Hz "reale" (usato per
// campionare l'audio) a una colonna decorativa senza etichetta, come nel monitor di riferimento
const SPECTRUM_BANDS = [
  { freq: 24, label: null },
  { freq: 57, label: '57' },
  { freq: 87, label: null },
  { freq: 134, label: '134' },
  { freq: 231, label: null },
  { freq: 400, label: '400' },
  { freq: 632, label: null },
  { freq: 1000, label: '1K' },
  { freq: 1483, label: null },
  { freq: 2200, label: '2K2' },
  { freq: 3723, label: null },
  { freq: 6300, label: '6K3' },
  { freq: 10042, label: null },
  { freq: 16000, label: '16K' },
  { freq: 20000, label: null },
];

// Formatta i secondi nello stile del monitor LCD: "007.3s"
const formatLCD = (seconds) => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const whole = String(Math.floor(safe)).padStart(3, '0');
  const decimal = Math.floor((safe % 1) * 10);
  return `${whole}.${decimal}s`;
};

// Formatta la data di ripresa nello stile compatto del monitor LCD:
// "09/09/26 14:32". Torna "N/D" se non disponibile (file non .mp4/.mov,
// o contenitore senza questo metadato)
const formatLCDDate = (date) => {
  if (!date || Number.isNaN(date.getTime())) return 'N/D';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
};

// --- LETTURA "TECNICA" DI CODEC E DATA DI RIPRESA DAI CONTENITORI MP4/MOV ---
// I browser non espongono il codec reale né la data di ripresa originale
// tramite le API <video> standard: bisogna leggere i "box" del contenitore
// (stessa struttura per .mp4/.m4v e per .mov, essendo QuickTime File Format
// il progenitore di ISO BMFF). Leggiamo solo le intestazioni dei box di primo
// livello (8-16 byte ciascuna) per saltare "mdat" (che può pesare gigabyte)
// e arrivare dritti a "moov", che contiene tutti i metadati ed è tipicamente
// di poche decine di KB anche su file molto grandi.

// FourCC dei codec più comuni nei box "stsd" -> nome leggibile
const VIDEO_CODEC_NAMES = {
  avc1: 'H.264 / AVC',
  avc3: 'H.264 / AVC',
  hvc1: 'H.265 / HEVC',
  hev1: 'H.265 / HEVC',
  mp4v: 'MPEG-4 Part 2',
  vp09: 'VP9',
  av01: 'AV1',
  apcn: 'Apple ProRes 422',
  apcs: 'Apple ProRes 422 LT',
  apco: 'Apple ProRes 422 Proxy',
  apch: 'Apple ProRes 422 HQ',
  ap4h: 'Apple ProRes 4444',
};

const formatCodecName = (fourCC) => {
  if (!fourCC) return null;
  return VIDEO_CODEC_NAMES[fourCC] || fourCC.toUpperCase();
};

// L'epoca di riferimento dei timestamp QuickTime/ISO BMFF è il 1° gennaio 1904,
// non quella Unix (1970): questo è lo scarto in secondi tra le due
const QT_EPOCH_TO_UNIX_SECONDS = 2082844800;

const readUint32BE = (view, offset) => view.getUint32(offset, false);
const readUint64BE = (view, offset) => {
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 2 ** 32 + lo;
};
const readFourCC = (view, offset) =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );

// Scorre i box contenuti in un buffer già in memoria (usato per il contenuto
// di "moov", che leggiamo per intero una volta individuato)
const parseChildBoxes = (view, start, end) => {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32BE(view, offset);
    const type = readFourCC(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      size = readUint64BE(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) break;
    boxes.push({ type, contentStart: offset + headerSize, contentEnd: offset + size });
    offset += size;
  }
  return boxes;
};

const findChildBox = (boxes, type) => boxes.find((b) => b.type === type);

// Cerca un box di primo livello (es. "moov") leggendo dal file solo le
// intestazioni via file.slice(), senza mai caricare in memoria "mdat"
const findTopLevelBox = async (file, targetType) => {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const headerBuf = await file.slice(offset, offset + 16).arrayBuffer();
    if (headerBuf.byteLength < 8) break;
    const view = new DataView(headerBuf);
    let size = readUint32BE(view, 0);
    const type = readFourCC(view, 4);
    let headerSize = 8;
    if (size === 1) {
      size = readUint64BE(view, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) break;
    if (type === targetType) {
      return { offset, size, headerSize };
    }
    offset += size;
  }
  return null;
};

// Estrae, quando possibile, il codec video reale e la data di ripresa
// originale da un file .mp4/.m4v/.mov. Restituisce null (senza generare
// errori) per formati diversi (webm, mkv) o file non conformi
const extractMp4TechnicalMeta = async (file) => {
  try {
    const moovBox = await findTopLevelBox(file, 'moov');
    if (!moovBox) return null;

    const moovBuf = await file.slice(moovBox.offset, moovBox.offset + moovBox.size).arrayBuffer();
    const view = new DataView(moovBuf);
    const moovChildren = parseChildBoxes(view, moovBox.headerSize, moovBox.size);

    // --- mvhd: data di creazione del filmato ---
    let creationDate = null;
    const mvhd = findChildBox(moovChildren, 'mvhd');
    if (mvhd) {
      const version = view.getUint8(mvhd.contentStart);
      const creationTimeRaw =
        version === 1
          ? readUint64BE(view, mvhd.contentStart + 4)
          : readUint32BE(view, mvhd.contentStart + 4);
      if (creationTimeRaw > 0) {
        const unixSeconds = creationTimeRaw - QT_EPOCH_TO_UNIX_SECONDS;
        const candidate = new Date(unixSeconds * 1000);
        // Scarta timestamp assurdi (alcuni encoder scrivono 0 o date fuori range)
        if (!Number.isNaN(candidate.getTime()) && candidate.getFullYear() > 1980) {
          creationDate = candidate;
        }
      }
    }

    // --- trak > mdia > hdlr ("vide") > minf > stbl > stsd: codec video ---
    let codec = null;
    const traks = moovChildren.filter((b) => b.type === 'trak');
    for (const trak of traks) {
      const trakChildren = parseChildBoxes(view, trak.contentStart, trak.contentEnd);
      const mdia = findChildBox(trakChildren, 'mdia');
      if (!mdia) continue;

      const mdiaChildren = parseChildBoxes(view, mdia.contentStart, mdia.contentEnd);
      const hdlr = findChildBox(mdiaChildren, 'hdlr');
      if (!hdlr) continue;
      // Il tipo di handler ("vide" per video, "soun" per audio) sta 8 byte
      // dopo l'inizio del contenuto del box (version+flags+predefined)
      const handlerType = readFourCC(view, hdlr.contentStart + 8);
      if (handlerType !== 'vide') continue;

      const minf = findChildBox(mdiaChildren, 'minf');
      const stbl = minf && findChildBox(parseChildBoxes(view, minf.contentStart, minf.contentEnd), 'stbl');
      const stsd = stbl && findChildBox(parseChildBoxes(view, stbl.contentStart, stbl.contentEnd), 'stsd');
      if (!stsd) continue;

      // stsd: version(1)+flags(3)+entry_count(4), poi la prima sample entry;
      // i suoi primi 4 byte di contenuto (dopo la sua intestazione da 8) sono
      // il fourCC del codec (es. "avc1", "hvc1")
      const firstEntryOffset = stsd.contentStart + 8;
      codec = readFourCC(view, firstEntryOffset + 4);
      break;
    }

    if (!creationDate && !codec) return null;
    return { creationDate, codec: formatCodecName(codec) };
  } catch (err) {
    console.error('Errore nella lettura dei metadati tecnici del video:', err);
    return null;
  }
};

// Estensioni video riconosciute in tutta l'app (scansione cartella e ricerca)
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const isVideoFile = (name) => {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

// Cartelle di sistema da ignorare durante la scansione ricorsiva di un HDD
// (oltre ai file/cartelle nascosti che iniziano con ".")
const SKIP_DIR_NAMES = new Set(['System Volume Information', '$RECYCLE.BIN', 'node_modules', '.git']);

// Numero massimo di risultati di ricerca mostrati contemporaneamente
// (evita di generare centinaia di miniature in un colpo solo)
const MAX_SEARCH_RESULTS = 60;

// Quanti video vengono processati (metadata + miniatura) IN PARALLELO durante
// l'apertura di una cartella. Prima venivano fatti uno alla volta in sequenza:
// su Tauri/Windows, se anche un solo file grande era lento a rispondere al
// seek richiesto per la miniatura, TUTTA la cartella restava bloccata in
// attesa. Un pool con concorrenza limitata (non illimitata, per non
// sovraccaricare disco/decoder) evita che un file lento blocchi gli altri.
const METADATA_CONCURRENCY = 4;

// Se l'estrazione di metadata/miniatura di un singolo video non si risolve
// entro questo tempo (capitava su Windows/Tauri con certi file di grandi
// dimensioni, quando il seek per la miniatura non arrivava mai a
// completarsi), il video viene comunque aggiunto alla libreria senza
// miniatura, invece di restare in sospeso per sempre e bloccare il resto.
const METADATA_TIMEOUT_MS = 8000;

// Esegue "worker" su ogni elemento di "items" con al massimo "limit"
// esecuzioni in parallelo, consegnando ogni risultato a "onItemDone" NON
// APPENA è pronto (invece che tutti insieme alla fine): questo è ciò che
// permette alla libreria di popolarsi progressivamente invece di restare
// vuota finché anche l'ultimo file non è stato processato.
async function processWithConcurrency(items, limit, worker, onItemDone) {
  let index = 0;
  const runNext = async () => {
    while (index < items.length) {
      const current = index++;
      const item = items[current];
      try {
        const result = await worker(item);
        onItemDone(result, item);
      } catch (err) {
        console.error('Errore nel processare un elemento della cartella:', err);
      }
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
}

// Card video condivisa tra la libreria normale e i risultati di ricerca
function VideoCard({ video, isActive, isPreviewing, previewUrl, isTransferring, onPlay, onHoverStart, onHoverEnd, onTransfer, onDelete, onSendToRegia, isSentToRegia }) {
  return (
    <button
      className={`video-card ${isActive ? 'active' : ''}`}
      onClick={onPlay}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div className="thumbnail-container">
        {isPreviewing && previewUrl ? (
          <video
            className="video-preview"
            src={previewUrl}
            muted
            autoPlay
            loop
            playsInline
          />
        ) : video.thumbnail ? (
          <img src={video.thumbnail} alt={video.name} className="video-thumb" />
        ) : (
          <div className="thumb-placeholder">{video.isLoadingMeta ? '⋯' : '🎬'}</div>
        )}
        <span className="video-duration">{video.duration}</span>
        {isActive && <span className="now-playing-tag">In riproduzione</span>}
        {onSendToRegia && (
          <span
            className={`regia-btn ${isSentToRegia ? 'sent' : ''}`}
            role="button"
            title={isSentToRegia ? 'Già in regia' : 'Invia alla regia'}
            onClick={isSentToRegia ? undefined : onSendToRegia}
          >
            {isSentToRegia ? '✓' : '📡'}
          </span>
        )}
        <span
          className="transfer-btn"
          role="button"
          title="Sposta in un'altra cartella"
          onClick={onTransfer}
        >
          {isTransferring ? '…' : '⇢'}
        </span>
        <span
          className="delete-btn"
          role="button"
          title="Elimina definitivamente"
          onClick={onDelete}
        >
          🗑
        </span>
      </div>
      <div className="video-info">
        <span className="video-name" title={video.name}>{video.name}</span>
        <span className="video-meta">{video.relPath ? `${video.relPath} · ${video.size}` : video.size}</span>
      </div>
    </button>
  );
}

export default function LibraryView({ onSendToRegia, sentToRegiaIds }) {
  const [videoList, setVideoList] = useState([]);
  const [currentVideo, setCurrentVideo] = useState(null);
  const [currentVideoName, setCurrentVideoName] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [folderName, setFolderName] = useState('');
  const [transferringId, setTransferringId] = useState(null);
  const [rootDirHandle, setRootDirHandle] = useState(null);
  const [subfolders, setSubfolders] = useState([]);
  const hoverTimeoutRef = useRef(null);
  const previewUrlRef = useRef(null);

  // Stato della ricerca globale sull'HDD
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);
  const [metaVersion, setMetaVersion] = useState(0);
  const metaCacheRef = useRef(new Map());

  // Stato del monitor broadcast (canale singolo, legato al video in riproduzione)
  const [isPlaying, setIsPlaying] = useState(false);
  const [playedSeconds, setPlayedSeconds] = useState(0);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(0);
  const [totalBroadcastSeconds, setTotalBroadcastSeconds] = useState(0);
  const [currentVideoCodec, setCurrentVideoCodec] = useState(null);
  const [currentVideoCreationDate, setCurrentVideoCreationDate] = useState(null);
  const [isLoadingTechMeta, setIsLoadingTechMeta] = useState(false);
  const videoElRef = useRef(null);
  // Evita che il risultato di una lettura codec/data (asincrona, su file
  // potenzialmente grandi) arrivi in ritardo e si applichi al video sbagliato
  // se nel frattempo l'utente ne ha aperto un altro
  const techMetaRequestIdRef = useRef(0);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);
  // Tiene traccia dell'ultimo elemento <video> collegato all'analyser: serve a
  // riusare lo stesso MediaElementSourceNode se React (in modalità StrictMode,
  // in sviluppo) richiama il ref due volte sullo stesso nodo, dato che un
  // elemento può essere collegato a un MediaElementSourceNode una sola volta
  const sourceNodeRef = useRef(null);
  const rafIdRef = useRef(null);
  const barRefs = useRef([]);
  const lastTimeRef = useRef(0);

  // Somma delle durate di tutti i video presenti in libreria (per "ALL LOADED")
  const allLoadedSeconds = useMemo(
    () => videoList.reduce((sum, v) => sum + (v.durationSeconds || 0), 0),
    [videoList]
  );

  // Collega l'elemento <video> a un AnalyserNode della Web Audio API,
  // così lo spettro riflette l'audio reale del video in riproduzione
  const setupAudioAnalyser = useCallback((node) => {
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      const audioCtx = audioCtxRef.current;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      // Stesso elemento già collegato in precedenza (es. doppio richiamo del
      // ref da parte di StrictMode): riusa l'analyser esistente invece di
      // richiamare createMediaElementSource, che altrimenti lancerebbe un
      // errore ("already connected to a different MediaElementSourceNode")
      // lasciando lo spettro scollegato pur continuando a sentire l'audio
      if (sourceNodeRef.current && sourceNodeRef.current.element === node) {
        analyserRef.current = sourceNodeRef.current.analyser;
        dataArrayRef.current = sourceNodeRef.current.dataArray;
        return;
      }

      const source = audioCtx.createMediaElementSource(node);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      sourceNodeRef.current = { element: node, source, analyser, dataArray };
      analyserRef.current = analyser;
      dataArrayRef.current = dataArray;
    } catch (err) {
      console.error("Errore nell'inizializzazione dell'analizzatore audio:", err);
    }
  }, []);

  const handleVideoRef = useCallback((node) => {
    videoElRef.current = node;
    if (node) {
      setupAudioAnalyser(node);
    } else {
      analyserRef.current = null;
      dataArrayRef.current = null;
    }
  }, [setupAudioAnalyser]);

  const handleTimeUpdate = (e) => {
    const current = e.target.currentTime;
    const delta = current - lastTimeRef.current;
    // Somma solo la riproduzione naturale, ignora i salti dovuti a "seek" o cambio video
    if (delta > 0 && delta < 1) {
      setTotalBroadcastSeconds((t) => t + delta);
    }
    lastTimeRef.current = current;
    setPlayedSeconds(current);
  };

  const handleLoadedMetadata = (e) => {
    setVideoDurationSeconds(e.target.duration || 0);
    lastTimeRef.current = 0;
    setPlayedSeconds(0);
  };

  // Loop di disegno dello spettro: legge i dati di frequenza reali e aggiorna
  // l'altezza delle barre direttamente sul DOM (senza passare da setState) per fluidità
  useEffect(() => {
    const drawFrame = () => {
      const analyser = analyserRef.current;
      const dataArray = dataArrayRef.current;
      if (analyser && dataArray && audioCtxRef.current) {
        analyser.getByteFrequencyData(dataArray);
        const nyquist = audioCtxRef.current.sampleRate / 2;
        SPECTRUM_BANDS.forEach((band, i) => {
          const bin = Math.min(dataArray.length - 1, Math.round((band.freq / nyquist) * dataArray.length));
          const value = dataArray[bin];
          const pct = Math.max(2, Math.round((value / 255) * 100));
          const bar = barRefs.current[i];
          if (bar) bar.style.height = `${pct}%`;
        });
      } else {
        SPECTRUM_BANDS.forEach((_, i) => {
          const bar = barRefs.current[i];
          if (bar) bar.style.height = '2%';
        });
      }
      rafIdRef.current = requestAnimationFrame(drawFrame);
    };
    rafIdRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [currentVideo]);

  // Funzione avanzata per estrarre metadati, miniatura, durata e peso
  const extractVideoMetadata = async (entry, file) => {
    const src = await getPlayableUrl(file);
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = src;
      video.muted = true;
      video.playsInline = true;

      video.onloadedmetadata = () => {
        video.currentTime = Math.min(1, video.duration / 2);
      };

      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180; // Formato 16:9 più definito
        const ctx = canvas.getContext('2d');

        // Ritaglio "cover": mantiene le proporzioni originali del video (evita
        // di stirarlo/deformarlo se non è già 16:9, es. video verticali) e
        // ritaglia il resto in modo centrato, come farebbe object-fit: cover
        const canvasAspect = canvas.width / canvas.height;
        const videoAspect = video.videoWidth / video.videoHeight || canvasAspect;
        let sx = 0, sy = 0, sWidth = video.videoWidth, sHeight = video.videoHeight;
        if (videoAspect > canvasAspect) {
          sWidth = sHeight * canvasAspect;
          sx = (video.videoWidth - sWidth) / 2;
        } else {
          sHeight = sWidth / canvasAspect;
          sy = (video.videoHeight - sHeight) / 2;
        }
        ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
        const thumbnail = canvas.toDataURL('image/jpeg');

        // Formattazione durata (MM:SS)
        const totalSeconds = Math.floor(video.duration || 0);
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        const durationFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

        // Formattazione peso file
        const sizeMB = (file.size / (1024 * 1024));
        const sizeFormatted = sizeMB > 1024
          ? `${(sizeMB / 1024).toFixed(2)} GB`
          : `${sizeMB.toFixed(1)} MB`;

        URL.revokeObjectURL(video.src);

        resolve({
          id: entry.name,
          name: entry.name,
          handle: entry,
          thumbnail,
          duration: durationFormatted,
          durationSeconds: video.duration || 0,
          size: sizeFormatted
        });
      };

      video.onerror = () => {
        resolve({
          id: entry.name,
          name: entry.name,
          handle: entry,
          thumbnail: null,
          duration: '--:--',
          durationSeconds: 0,
          size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`
        });
      };
    });
  };

  // Come extractVideoMetadata, ma con un tetto massimo di attesa: se il seek
  // per la miniatura non si completa in tempo (visto su Windows/Tauri con
  // alcuni file grandi), risolve comunque con un video "minimo" (senza
  // miniatura) invece di restare appesa per sempre e bloccare l'intera
  // cartella (vedi processWithConcurrency più sotto).
  const extractVideoMetadataSafe = (entry, file) => {
    const fallback = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          id: entry.name,
          name: entry.name,
          handle: entry,
          thumbnail: null,
          duration: '--:--',
          durationSeconds: 0,
          size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
          metaTimedOut: true,
        });
      }, METADATA_TIMEOUT_MS);
    });
    return Promise.race([extractVideoMetadata(entry, file), fallback]);
  };

  // Esplora ricorsivamente l'intero albero della cartella (tutti i sottolivelli)
  // per costruire l'indice di ricerca: solo nome/percorso/handle, senza generare
  // miniature, così resta veloce anche su un HDD pieno di file
  const buildSearchIndex = useCallback(async function walk(dirHandle, relPath, results, countRef) {
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'file') {
        if (isVideoFile(entry.name)) {
          const id = relPath ? `${relPath}/${entry.name}` : entry.name;
          results.push({ id, name: entry.name, handle: entry, parentDirHandle: dirHandle, relPath });
          countRef.count += 1;
          if (countRef.count % 25 === 0) {
            setIndexedCount(countRef.count);
          }
        }
      } else if (entry.kind === 'directory') {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        try {
          await walk(entry, relPath ? `${relPath}/${entry.name}` : entry.name, results, countRef);
        } catch (err) {
          console.error(`Impossibile leggere la cartella "${entry.name}":`, err);
        }
      }
    }
  }, []);

  // Calcola (una sola volta, con cache) miniatura/durata/peso per un elemento
  // dell'indice di ricerca, quando compare tra i risultati visibili
  const ensureMetadata = useCallback((entry) => {
    const cache = metaCacheRef.current;
    if (cache.has(entry.id)) return;
    cache.set(entry.id, { loading: true });
    entry.handle.getFile()
      .then((file) => extractVideoMetadataSafe(entry.handle, file))
      .then((meta) => {
        cache.set(entry.id, meta);
        setMetaVersion((v) => v + 1);
      })
      .catch((err) => {
        console.error('Errore nel calcolo dei metadati per la ricerca:', err);
        cache.set(entry.id, { thumbnail: null, duration: '--:--', durationSeconds: 0, size: '' });
        setMetaVersion((v) => v + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ritarda l'applicazione della ricerca di poco, per non ricalcolare i risultati
  // (e le relative miniature) ad ogni singolo carattere digitato
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim().toLowerCase());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleOpenFolder = async () => {
    try {
      const dirHandle = await pickDirectory({ mode: 'readwrite' });
      setIsLoading(true);
      setFolderName(dirHandle.name);
      setRootDirHandle(dirHandle);

      // Nomi già in libreria: evita di reindicizzare o duplicare file già caricati
      const existingNames = new Set(videoList.map((v) => v.id));
      const foundSubfolders = [];
      const videoEntries = [];
      let skippedCount = 0;

      // Primo passaggio, veloce: solo elenco file/cartelle, nessuna lettura
      // pesante. La lettura di metadata/miniatura viene fatta subito dopo,
      // in parallelo (vedi sotto), non qui dentro.
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'directory') {
          foundSubfolders.push(entry.name);
          continue;
        }
        if (entry.kind === 'file') {
          // Salta i file nascosti (es. i resource fork di macOS "._nomefile.mp4"
          // o file di sistema come .DS_Store), che non sono video reali
          if (entry.name.startsWith('.')) {
            continue;
          }
          if (isVideoFile(entry.name)) {
            if (existingNames.has(entry.name)) {
              skippedCount += 1;
              continue;
            }
            videoEntries.push(entry);
            existingNames.add(entry.name);
          }
        }
      }

      setSubfolders(foundSubfolders.sort((a, b) => a.localeCompare(b)));

      let loadedCount = 0;
      // Elabora fino a METADATA_CONCURRENCY video insieme, e aggiunge ognuno
      // alla libreria appena pronto: niente più attesa che TUTTA la cartella
      // finisca prima di vedere anche solo un video (era questa l'attesa
      // infinita su Windows).
      await processWithConcurrency(
        videoEntries,
        METADATA_CONCURRENCY,
        async (entry) => {
          const file = await entry.getFile();
          const videoData = await extractVideoMetadataSafe(entry, file);
          videoData.sourceDir = dirHandle;
          return videoData;
        },
        (videoData) => {
          loadedCount += 1;
          // Riusa i metadati già estratti, così la ricerca non deve
          // ricalcolare miniatura/durata per gli stessi file
          metaCacheRef.current.set(videoData.id, {
            thumbnail: videoData.thumbnail,
            duration: videoData.duration,
            durationSeconds: videoData.durationSeconds,
            size: videoData.size,
          });
          setVideoList((prev) => {
            if (prev.some((v) => v.id === videoData.id)) return prev;
            return [...prev, videoData].sort((a, b) => a.name.localeCompare(b.name));
          });
        }
      );

      setIsLoading(false);

      if (loadedCount === 0) {
        alert(
          skippedCount > 0
            ? "Tutti i video di questa cartella sono già in libreria."
            : "Nessun file video trovato in questa cartella."
        );
      }

      // Indicizzazione ricorsiva in background: esplora tutto l'albero della
      // cartella (ogni sottolivello) per rendere cercabili anche i video
      // non ancora sfogliati manualmente dal menu sottocartelle
      setIsIndexing(true);
      setIndexedCount(0);
      const results = [];
      const countRef = { count: 0 };
      try {
        await buildSearchIndex(dirHandle, '', results, countRef);
        setIndexedCount(countRef.count);
        setSearchIndex((prev) => {
          const existingIds = new Set(prev.map((e) => e.id));
          return [...prev, ...results.filter((e) => !existingIds.has(e.id))];
        });
      } catch (err) {
        console.error("Errore durante l'indicizzazione della cartella:", err);
      } finally {
        setIsIndexing(false);
      }
    } catch (err) {
      setIsLoading(false);
      setIsIndexing(false);
      if (err.name !== 'AbortError') {
        console.error("Errore nell'apertura della cartella:", err);
      }
    }
  };

  const handleSelectSubfolder = async (event) => {
    const name = event.target.value;
    event.target.value = ''; // il menu è un'azione, non un filtro persistente
    if (!name || !rootDirHandle) return;

    try {
      setIsLoading(true);
      const subDirHandle = await rootDirHandle.getDirectoryHandle(name);
      const existingNames = new Set(videoList.map((v) => v.id));
      const videoEntries = [];
      let skippedCount = 0;

      for await (const entry of subDirHandle.values()) {
        if (entry.kind !== 'file' || entry.name.startsWith('.')) continue;
        if (!isVideoFile(entry.name)) continue;
        if (existingNames.has(entry.name)) {
          skippedCount += 1;
          continue;
        }
        videoEntries.push(entry);
        existingNames.add(entry.name);
      }

      let loadedCount = 0;
      await processWithConcurrency(
        videoEntries,
        METADATA_CONCURRENCY,
        async (entry) => {
          const file = await entry.getFile();
          const videoData = await extractVideoMetadataSafe(entry, file);
          videoData.sourceDir = subDirHandle;
          return videoData;
        },
        (videoData) => {
          loadedCount += 1;
          // Riusa i metadati anche qui, con l'id nel formato usato dall'indice di ricerca
          metaCacheRef.current.set(`${name}/${videoData.id}`, {
            thumbnail: videoData.thumbnail,
            duration: videoData.duration,
            durationSeconds: videoData.durationSeconds,
            size: videoData.size,
          });
          setVideoList((prev) => {
            if (prev.some((v) => v.id === videoData.id)) return prev;
            return [...prev, videoData].sort((a, b) => a.name.localeCompare(b.name));
          });
        }
      );

      setIsLoading(false);

      if (loadedCount === 0) {
        alert(
          skippedCount > 0
            ? "Tutti i video di questa sottocartella sono già in libreria."
            : `Nessun file video trovato in "${name}".`
        );
      }
    } catch (err) {
      setIsLoading(false);
      console.error('Errore nell\'apertura della sottocartella:', err);
    }
  };

  const playVideo = async (videoObj) => {
    try {
      // Alcuni browser (Safari in particolare) riprendono l'AudioContext solo
      // se resume() viene chiamato dentro un gesto utente diretto: lo facciamo
      // anche qui, oltre che nel setup dell'analyser, per sicurezza
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      const file = await videoObj.handle.getFile();
      const fileUrl = await getPlayableUrl(file);
      setCurrentVideo(fileUrl);
      setCurrentVideoName(videoObj.name);
      setActiveId(videoObj.id);

      // Lettura di codec e data di ripresa: asincrona e potenzialmente lenta
      // su file molto grandi, quindi non blocca l'avvio della riproduzione
      const requestId = ++techMetaRequestIdRef.current;
      setCurrentVideoCodec(null);
      setCurrentVideoCreationDate(null);
      setIsLoadingTechMeta(true);
      extractMp4TechnicalMeta(file).then((meta) => {
        if (techMetaRequestIdRef.current !== requestId) return; // superato da un video più recente
        setCurrentVideoCodec(meta?.codec || null);
        setCurrentVideoCreationDate(meta?.creationDate || null);
        setIsLoadingTechMeta(false);
      });
    } catch (err) {
      console.error("Errore nel caricamento del file video:", err);
    }
  };

  const clearHoverTimeout = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };

  const revokePreviewUrl = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };

  const handleCardMouseEnter = (video) => {
    clearHoverTimeout();
    // Piccolo ritardo: evita di caricare un'anteprima se il mouse
    // sta solo attraversando la griglia
    hoverTimeoutRef.current = setTimeout(async () => {
      try {
        const file = await video.handle.getFile();
        revokePreviewUrl();
        const url = await getPlayableUrl(file);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setPreviewId(video.id);
      } catch (err) {
        console.error("Errore nel caricamento dell'anteprima:", err);
      }
    }, 350);
  };

  const handleCardMouseLeave = () => {
    clearHoverTimeout();
    revokePreviewUrl();
    setPreviewUrl(null);
    setPreviewId(null);
  };

  const handleTransferVideo = async (video, event) => {
    event.stopPropagation();
    if (transferringId) return;

    try {
      const destDir = await pickDirectory({ mode: 'readwrite' });

      // Evita di spostare un file dentro la stessa cartella in cui si trova già
      if (video.sourceDir && (await isSameEntry(destDir, video.sourceDir))) {
        alert("Il video si trova già in questa cartella.");
        return;
      }

      setTransferringId(video.id);

      // Copia il contenuto del file nella cartella di destinazione e rimuove
      // l'originale dalla cartella di partenza (gestito internamente sia su
      // web che su Tauri, con rename nativo su desktop quando possibile)
      await moveFileTo(video.handle, video.sourceDir, destDir, video.name);

      // Toglie il video dalla libreria corrente e dall'indice di ricerca,
      // e chiude il player se era in riproduzione
      setVideoList((prev) => prev.filter((v) => v.id !== video.id));
      setSearchIndex((prev) => prev.filter((e) => e.id !== video.id));
      metaCacheRef.current.delete(video.id);
      if (activeId === video.id) {
        closePlayer();
      }
      if (previewId === video.id) {
        handleCardMouseLeave();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Errore nel trasferimento del video:', err);
        alert("Non è stato possibile trasferire il video. Riprova.");
      }
    } finally {
      setTransferringId(null);
    }
  };

  const handleDeleteVideo = async (video, event) => {
    event.stopPropagation();
    if (transferringId) return;

    const confirmed = window.confirm(
      `Eliminare definitivamente "${video.name}"?\n\nQuesta azione non può essere annullata.`
    );
    if (!confirmed) return;

    try {
      setTransferringId(video.id);

      if (video.sourceDir) {
        await video.sourceDir.removeEntry(video.name);
      }

      setVideoList((prev) => prev.filter((v) => v.id !== video.id));
      setSearchIndex((prev) => prev.filter((e) => e.id !== video.id));
      metaCacheRef.current.delete(video.id);
      if (activeId === video.id) {
        closePlayer();
      }
      if (previewId === video.id) {
        handleCardMouseLeave();
      }
    } catch (err) {
      console.error('Errore nella cancellazione del video:', err);
      alert("Non è stato possibile eliminare il video. Riprova.");
    } finally {
      setTransferringId(null);
    }
  };

  const closePlayer = () => {
    setCurrentVideo(null);
    setCurrentVideoName('');
    setActiveId(null);
    setIsPlaying(false);
    setPlayedSeconds(0);
    setVideoDurationSeconds(0);
    setCurrentVideoCodec(null);
    setCurrentVideoCreationDate(null);
    setIsLoadingTechMeta(false);
    techMetaRequestIdRef.current += 1; // invalida un'eventuale lettura ancora in corso
    lastTimeRef.current = 0;
  };

  // Invia in blocco alla regia tutti i video di una lista (l'intera cartella
  // aperta, oppure i risultati di ricerca attualmente mostrati), saltando
  // quelli già inviati in precedenza
  const handleSendAllToRegia = (list) => {
    if (!onSendToRegia) return;
    list.forEach((video) => {
      if (!sentToRegiaIds || !sentToRegiaIds.has(video.id)) {
        onSendToRegia(video);
      }
    });
  };

  // Bottone "invia tutti alla regia": compare solo se la funzione è disponibile
  // e c'è almeno un video nella lista corrente
  const renderSendAllButton = (list) => {
    if (!onSendToRegia || list.length === 0) return null;
    const allSent = sentToRegiaIds ? list.every((v) => sentToRegiaIds.has(v.id)) : false;
    return (
      <button
        type="button"
        className="btn-send-all"
        onClick={() => handleSendAllToRegia(list)}
        disabled={allSent}
      >
        {allSent ? '✓ Tutti in regia' : '📡 Invia tutti alla regia'}
      </button>
    );
  };

  // Ricerca: filtra l'indice completo (tutto l'HDD esplorato) sul titolo digitato
  const isSearching = searchQuery.trim().length > 0;
  const searchResults = useMemo(() => {
    if (!debouncedQuery) return [];
    return searchIndex.filter((entry) => entry.name.toLowerCase().includes(debouncedQuery));
  }, [debouncedQuery, searchIndex]);
  const visibleResults = searchResults.slice(0, MAX_SEARCH_RESULTS);
  const hiddenResultsCount = Math.max(0, searchResults.length - MAX_SEARCH_RESULTS);

  const searchResultVideos = visibleResults.map((entry) => {
    const meta = metaCacheRef.current.get(entry.id);
    const ready = meta && !meta.loading;
    return {
      id: entry.id,
      name: entry.name,
      handle: entry.handle,
      sourceDir: entry.parentDirHandle,
      relPath: entry.relPath,
      thumbnail: ready ? meta.thumbnail : null,
      duration: ready ? meta.duration : '…',
      size: ready ? meta.size : '…',
      isLoadingMeta: !ready,
    };
  });

  // Calcola le miniature solo per i risultati effettivamente mostrati
  useEffect(() => {
    if (!isSearching) return;
    visibleResults.forEach((entry) => {
      if (!metaCacheRef.current.has(entry.id)) {
        ensureMetadata(entry);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleResults, isSearching, ensureMetadata]);

  return (
    <div className="app-container">
      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark">▶</span>
          <h1>Libreria Video</h1>
        </div>
        <div className="search-bar">
          <span className="search-icon">🔎</span>
          <input
            type="text"
            className="search-input"
            placeholder={folderName ? 'Cerca un titolo…' : 'Apri una cartella per iniziare'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={!folderName}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setSearchQuery('')}
              title="Cancella ricerca"
            >
              ✕
            </button>
          )}
        </div>
        <button className="btn-primary" onClick={handleOpenFolder} disabled={isLoading}>
          {isLoading ? 'Analisi in corso…' : 'Apri cartella'}
        </button>
      </header>

      {isIndexing && (
        <div className="index-status-bar">
          <span className="index-spinner" />
          <span>Indicizzazione HDD in corso… {indexedCount} file trovati</span>
        </div>
      )}

      <main className="content-area">
        <div className={`layout ${currentVideo ? 'has-player' : ''}`}>
          {currentVideo && (
            <div className="player-column">
              <section className="now-playing">
                <div className="video-wrapper">
                  <video
                    key={currentVideo}
                    ref={handleVideoRef}
                    controls
                    autoPlay
                    muted={isMuted}
                    className="video-player"
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  >
                    <source src={currentVideo} />
                    Il tuo browser non supporta il tag video.
                  </video>
                </div>
                <div className="now-playing-bar">
                  <span className="now-playing-title" title={currentVideoName}>{currentVideoName}</span>
                  <div className="now-playing-actions">
                    <button
                      className={`btn-ghost ${isMuted ? 'toggled' : ''}`}
                      onClick={() => setIsMuted((m) => !m)}
                    >
                      {isMuted ? '🔇 Muto' : '🔊 Audio'}
                    </button>
                    <button className="btn-ghost" onClick={closePlayer}>Chiudi</button>
                  </div>
                </div>
              </section>

              <div className="broadcast-monitor">
                <div className="monitor-topbar">
                  <span><span className="monitor-dot" />MULTI-TRACK LCD MONITOR</span>
                  <span className="monitor-status"><span className="status-dot" />ONLINE</span>
                </div>
                <div className="monitor-screen">
                  <div className="monitor-row monitor-header">
                    <span>MEDIA FILES:</span>
                    <span className="monitor-counter">{String(videoList.length).padStart(3, '0')}</span>
                  </div>

                  <div className="monitor-channel">
                    <div className="monitor-channel-title">
                      <span title={currentVideoName}>CH1: {currentVideoName ? currentVideoName.toUpperCase() : 'NO MEDIA'}</span>
                      <span className="monitor-badge">{isPlaying ? 'PLAY' : currentVideo ? 'PAUSE' : 'STBY'}</span>
                    </div>
                    <div className="monitor-line"><span>PLAYED:</span><span>{formatLCD(playedSeconds)}</span></div>
                    <div className="monitor-line"><span>LOADED:</span><span>{formatLCD(videoDurationSeconds)}</span></div>
                    <div className="monitor-line"><span>REMAIN:</span><span>{formatLCD(Math.max(videoDurationSeconds - playedSeconds, 0))}</span></div>
                    <div className="monitor-line">
                      <span>CODEC:</span>
                      <span>{isLoadingTechMeta ? '…' : currentVideoCodec || 'N/D'}</span>
                    </div>
                    <div className="monitor-line">
                      <span>RIPRESO IL:</span>
                      <span>{isLoadingTechMeta ? '…' : formatLCDDate(currentVideoCreationDate)}</span>
                    </div>
                  </div>

                  <div className="monitor-totals">
                    <div className="monitor-line"><span>TOTAL BCAST:</span><span>{formatLCD(totalBroadcastSeconds)}</span></div>
                    <div className="monitor-line"><span>ALL LOADED:</span><span>{formatLCD(allLoadedSeconds)}</span></div>
                  </div>

                  <div className="spectrum-analyzer">
                    <div className="spectrum-bars">
                      {SPECTRUM_BANDS.map((band, i) => (
                        <div className="spectrum-bar-track" key={band.freq}>
                          <div className="spectrum-bar" ref={(el) => (barRefs.current[i] = el)} />
                        </div>
                      ))}
                    </div>
                    <div className="spectrum-labels">
                      {SPECTRUM_BANDS.map((band) => (
                        <span key={band.freq}>{band.label || '–'}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="library-column">
            {isSearching ? (
              <>
                <div className="folder-title-row">
                  <h2 className="folder-title">Risultati per "{searchQuery.trim()}"</h2>
                  <span className="folder-count">{searchResults.length} video</span>
                  {renderSendAllButton(searchResultVideos)}
                </div>

                {searchResults.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-mark">🔍</span>
                    <p>Nessun video trovato per "{searchQuery.trim()}"</p>
                    <span className="empty-hint">
                      {isIndexing ? 'Indicizzazione ancora in corso, riprova tra poco…' : 'Prova con un altro titolo'}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="video-grid" data-meta-version={metaVersion}>
                      {searchResultVideos.map((video) => (
                        <VideoCard
                          key={video.id}
                          video={video}
                          isActive={activeId === video.id}
                          isPreviewing={previewId === video.id}
                          previewUrl={previewUrl}
                          isTransferring={transferringId === video.id}
                          onPlay={() => playVideo(video)}
                          onHoverStart={() => handleCardMouseEnter(video)}
                          onHoverEnd={handleCardMouseLeave}
                          onTransfer={(e) => handleTransferVideo(video, e)}
                          onDelete={(e) => handleDeleteVideo(video, e)}
                          onSendToRegia={onSendToRegia ? (e) => { e.stopPropagation(); onSendToRegia(video); } : undefined}
                          isSentToRegia={sentToRegiaIds ? sentToRegiaIds.has(video.id) : false}
                        />
                      ))}
                    </div>
                    {hiddenResultsCount > 0 && (
                      <p className="search-more-hint">+ altri {hiddenResultsCount} risultati: affina la ricerca per restringerli</p>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {folderName && (
                  <div className="folder-title-row">
                    <h2 className="folder-title">{folderName}</h2>
                    <span className="folder-count">{videoList.length} video</span>
                    {renderSendAllButton(videoList)}
                    {subfolders.length > 0 && (
                      <select
                        className="subfolder-select"
                        defaultValue=""
                        onChange={handleSelectSubfolder}
                        disabled={isLoading}
                      >
                        <option value="" disabled>Sfoglia sottocartelle…</option>
                        {subfolders.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {videoList.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-mark">🎞</span>
                    <p>{isLoading ? 'Indicizzazione dei file in corso…' : 'Nessuna cartella aperta'}</p>
                    {!isLoading && !folderName && <span className="empty-hint">Scegli "Apri cartella" per caricare i tuoi video</span>}
                    {!isLoading && folderName && <span className="empty-hint">Nessun video qui: prova a scegliere una sottocartella dal menu sopra</span>}
                  </div>
                ) : (
                  <div className="video-grid">
                    {videoList.map((video) => (
                      <VideoCard
                        key={video.id}
                        video={video}
                        isActive={activeId === video.id}
                        isPreviewing={previewId === video.id}
                        previewUrl={previewUrl}
                        isTransferring={transferringId === video.id}
                        onPlay={() => playVideo(video)}
                        onHoverStart={() => handleCardMouseEnter(video)}
                        onHoverEnd={handleCardMouseLeave}
                        onTransfer={(e) => handleTransferVideo(video, e)}
                        onDelete={(e) => handleDeleteVideo(video, e)}
                        onSendToRegia={onSendToRegia ? (e) => { e.stopPropagation(); onSendToRegia(video); } : undefined}
                        isSentToRegia={sentToRegiaIds ? sentToRegiaIds.has(video.id) : false}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

