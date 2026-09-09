import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import './tailwind.css';

// --- TIPI ---
interface AudioLevels {
  left: number;
  right: number;
}

interface Channel {
  id: string;
  name: string;
  title: string;
  url: string;
  playbackRate: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
}

interface MediaFile {
  id: string;
  name: string;
  url: string;
}

const INITIAL_CHANNELS: Channel[] = [
  { id: 'ch1', name: 'LETTORE 1', title: 'Nessun video', url: '', playbackRate: 1, isPlaying: false, currentTime: 0, duration: 0 },
  { id: 'ch2', name: 'LETTORE 2', title: 'Nessun video', url: '', playbackRate: 1, isPlaying: false, currentTime: 0, duration: 0 },
  { id: 'ch3', name: 'LETTORE 3', title: 'Nessun video', url: '', playbackRate: 1, isPlaying: false, currentTime: 0, duration: 0 }
];

// --- VU METER SU CANVAS (OTTIMIZZATO) ---
const CanvasVuMeter = memo(({
  levels = { left: 0, right: 0 },
  width = 34,
  height = 384
}: {
  levels?: AudioLevels;
  width?: number;
  height?: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const totalBars = 96;
    const barSpacing = 1.5;
    const barHeight = Math.max(1.8, (height - (totalBars - 1) * barSpacing) / totalBars);
    const meterWidth = (width - 6) / 2;
    const startX = 2;

    const drawChannel = (lvl: number, xPos: number) => {
      const activeCount = Math.round((Math.max(0, Math.min(100, lvl)) / 100) * totalBars);

      for (let i = 0; i < totalBars; i++) {
        const y = height - (i + 1) * (barHeight + barSpacing);
        const isActive = i < activeCount;

        if (isActive) {
          if (i >= totalBars * 0.84) {
            ctx.fillStyle = '#ef4444';
          } else if (i >= totalBars * 0.65) {
            ctx.fillStyle = '#fbbf24';
          } else {
            ctx.fillStyle = '#10b981';
          }
        } else {
          ctx.fillStyle = '#141417';
        }

        ctx.fillRect(xPos, y, meterWidth, barHeight);
      }
    };

    drawChannel(levels.left, startX);
    drawChannel(levels.right, startX + meterWidth + 2);
  }, [levels, width, height]);

  return (
    <div className="bg-black/95 border-2 border-zinc-800 rounded-lg p-1 flex flex-col items-center justify-end shadow-2xl h-full select-none">
      <canvas ref={canvasRef} width={width} height={height} className="block w-full h-full object-contain object-bottom" />
      <div className="flex justify-around w-full text-[8px] font-mono font-black text-emerald-400 mt-0.5 shrink-0">
        <span>L</span>
        <span>R</span>
      </div>
    </div>
  );
});

// --- SPETTRO AUDIO A 16 BANDE ---
const SpectrumAnalyzer = memo(({ bands = [] }: { bands: number[] }) => {
  const totalBands = 16;
  const ledsPerColumn = 24;

  const labels = [
    '—', '57', '—', '134', '—', '400', '—', '1K',
    '—', '2K2', '—', '6K3', '—', '16K', '—', '—'
  ];

  const peaksRef = useRef<number[]>(Array(totalBands).fill(0));
  const [peaks, setPeaks] = useState<number[]>(() => Array(totalBands).fill(0));

  useEffect(() => {
    peaksRef.current = peaksRef.current.map((p, i) => Math.max(bands[i] || 0, p));
    setPeaks([...peaksRef.current]);
  }, [bands]);

  useEffect(() => {
    const id = setInterval(() => {
      peaksRef.current = peaksRef.current.map((p) => Math.max(0, p - 1.5));
      setPeaks([...peaksRef.current]);
    }, 90);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="w-full h-36 bg-[#04070a] border-2 border-[#3a4534] rounded-md p-1.5 flex flex-col justify-between shadow-[inset_0_0_15px_rgba(0,0,0,0.95)] overflow-hidden shrink-0 relative">
      <div className="absolute inset-x-1.5 top-[16%] border-t border-[#3a4534]/50 pointer-events-none z-0" />
      <div className="absolute inset-x-1.5 top-[40%] border-t border-[#3a4534]/50 pointer-events-none z-0" />
      <div className="absolute inset-x-1.5 top-[64%] border-t border-[#3a4534]/50 pointer-events-none z-0" />

      <div className="flex-1 flex gap-[3px] items-end justify-between px-1 pt-1 min-h-0 relative z-10">
        {Array.from({ length: totalBands }).map((_, colIdx) => {
          const val = Math.max(0, Math.min(100, bands[colIdx] || 0));
          const peak = Math.max(0, Math.min(100, peaks[colIdx] || 0));
          const activeLeds = Math.round((val / 100) * ledsPerColumn);
          const peakLed = Math.round((peak / 100) * ledsPerColumn) - 1;

          return (
            <div key={colIdx} className="flex-1 flex flex-col-reverse gap-[1.5px] h-full justify-start">
              {Array.from({ length: ledsPerColumn }).map((_, rowIdx) => {
                const isActive = rowIdx < activeLeds;
                const isPeak = rowIdx === peakLed && peakLed >= activeLeds;
                let colorClass = 'bg-[#10140d]';

                if (isPeak) {
                  colorClass = 'bg-[#d8d4c4]';
                } else if (isActive) {
                  if (rowIdx >= ledsPerColumn - 2) {
                    colorClass = 'bg-[#c4483e]';
                  } else if (rowIdx >= ledsPerColumn * 0.75) {
                    colorClass = 'bg-[#c9a23c]';
                  } else {
                    colorClass = 'bg-[#4f9d5c]';
                  }
                }

                return (
                  <div
                    key={rowIdx}
                    className={`w-full h-[3px] rounded-[0.5px] ${colorClass}`}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between items-center text-[8px] font-mono font-black text-[#8a9a7c] tracking-tighter pt-1 px-0.5 border-t border-[#262c20]/90 select-none relative z-10">
        {labels.map((lbl, idx) => (
          <span key={idx} className="flex-1 text-center truncate">
            {lbl}
          </span>
        ))}
      </div>
    </div>
  );
});

// --- CARD LETTORE SINGOLO ---
const ChannelCard = memo(({
  channel,
  isLive,
  audioLevels,
  onSelect,
  onTogglePlay,
  onReset,
  onSpeedChange,
  onEnded,
  onSeek,
  registerRef
}: {
  channel: Channel;
  isLive: boolean;
  audioLevels: AudioLevels;
  onSelect: (id: string) => void;
  onTogglePlay: (id: string) => void;
  onReset: (id: string) => void;
  onSpeedChange: (id: string, speed: number) => void;
  onEnded: (id: string) => void;
  onSeek: (id: string, time: number) => void;
  registerRef: (id: string, el: HTMLVideoElement | null) => void;
}) => {
  const progressPct = channel.duration > 0 ? Math.min(100, Math.max(0, (channel.currentTime / channel.duration) * 100)) : 0;

  const formatTime = (t: number) => {
    if (isNaN(t) || t < 0) return '00:00';
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!channel.url || !channel.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(channel.id, ratio * channel.duration);
  };

  return (
    <div
      onClick={() => onSelect(channel.id)}
      className={`relative rounded-xl overflow-hidden border-2 cursor-pointer transition-colors flex flex-col p-2 bg-zinc-950 group h-full ${
        isLive
          ? 'border-red-500 ring-2 ring-red-500/40 shadow-xl shadow-red-500/20'
          : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-center justify-between bg-zinc-900 px-2.5 py-1 rounded text-[11px] font-bold shrink-0 mb-1 border border-zinc-800">
        <span className="truncate text-zinc-200 font-mono">
          {channel.name}: <span className="text-zinc-400">{channel.title}</span>
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded font-bold ${channel.isPlaying ? 'bg-amber-900/80 text-amber-300' : 'bg-emerald-900/80 text-emerald-300'}`}>
            {channel.isPlaying ? 'IN ONDA' : 'LIBERO'}
          </span>
          {isLive && (
            <span className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[8px] font-black animate-pulse">
              LIVE
            </span>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex gap-2 my-0.5 items-end">
        <div className="relative flex-1 h-full min-w-0 flex flex-col gap-1">
          <div className="relative flex-1 min-h-0 rounded bg-black overflow-hidden flex items-center justify-center border border-zinc-900">
            {channel.url ? (
              <video
                ref={(el) => registerRef(channel.id, el)}
                src={channel.url}
                preload="metadata"
                onEnded={() => onEnded(channel.id)}
                className="w-full h-full object-contain pointer-events-none"
                muted
                playsInline
              />
            ) : (
              <span className="text-[10px] font-mono text-zinc-600">IN ATTESA DI VIDEO</span>
            )}
          </div>

          <div
            onClick={handleTimelineClick}
            className={`shrink-0 h-2 w-full bg-zinc-800 rounded-full overflow-hidden relative border border-zinc-900 ${
              channel.url ? 'cursor-pointer' : 'cursor-default opacity-40'
            }`}
          >
            <div
              className="h-full bg-emerald-500 rounded-full"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="shrink-0 flex justify-between text-[8px] font-mono font-bold text-zinc-400 px-0.5 leading-none">
            <span>{formatTime(channel.currentTime)}</span>
            <span>{formatTime(channel.duration)}</span>
          </div>
        </div>

        <div className="h-full shrink-0 flex flex-col gap-1 self-end" onClick={(e) => e.stopPropagation()}>
          <div className="flex-1 min-h-0 flex gap-1">
            <div className="h-[85%] w-9 shrink-0 flex flex-col justify-end self-end">
              <CanvasVuMeter
                levels={channel.isPlaying ? audioLevels : { left: 0, right: 0 }}
                width={34}
                height={384}
              />
            </div>

            <div className="h-full w-10 bg-zinc-900/90 rounded border border-zinc-800 p-1 flex flex-col items-center select-none shrink-0">
              <span className="text-[9px] font-mono font-bold text-amber-300 bg-black px-1 py-0.5 rounded border border-zinc-800 mb-1 shrink-0 text-center w-full">
                {channel.playbackRate}x
              </span>
              <div className="w-full flex-1 min-h-0 flex items-center justify-center relative">
                <input
                  type="range"
                  min="0.25"
                  max="10"
                  step="0.5"
                  value={channel.playbackRate}
                  onChange={(e) => onSpeedChange(channel.id, parseFloat(e.target.value))}
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                  className="w-2 h-full bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-amber-400"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1 w-full shrink-0">
            <button
              onClick={() => onTogglePlay(channel.id)}
              disabled={!channel.url}
              title="Play / Pausa"
              className={`w-full h-7 rounded flex items-center justify-center transition text-xs font-black shadow-sm disabled:opacity-30 ${
                channel.isPlaying
                  ? 'bg-amber-500 hover:bg-amber-400 text-black'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {channel.isPlaying ? '⏸' : '▶'}
            </button>

            <button
              onClick={() => onReset(channel.id)}
              disabled={!channel.url}
              title="Stop"
              className="w-full h-7 rounded bg-gradient-to-b from-zinc-300 via-zinc-400 to-zinc-500 hover:from-zinc-200 hover:to-zinc-400 text-zinc-900 border border-zinc-500/60 shadow-inner flex items-center justify-center text-xs font-black transition disabled:opacity-30"
            >
              ⏹
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

// --- COMPONENTE PRINCIPALE ---
export default function RegiaView({
  incomingVideos = [],
  isBlackout = false
}: {
  incomingVideos?: MediaFile[];
  isBlackout?: boolean;
}) {
  const [channels, setChannels] = useState<Channel[]>(INITIAL_CHANNELS);
  const [activeChannelId, setActiveChannelId] = useState<string>('ch1');
  const [volume, setVolume] = useState<number>(80);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number>(0);
  const [isHoveringTimeline, setIsHoveringTimeline] = useState<boolean>(false);
  const [timelineThumbnails, setTimelineThumbnails] = useState<string[]>([]);

  const [busyWarning, setBusyWarning] = useState<string | null>(null);
  const [folderFiles, setFolderFiles] = useState<MediaFile[]>([]);
  const [liveLevels, setLiveLevels] = useState<AudioLevels>({ left: 0, right: 0 });

  const [channelAudioLevels, setChannelAudioLevels] = useState<{ [key: string]: AudioLevels }>({
    ch1: { left: 0, right: 0 },
    ch2: { left: 0, right: 0 },
    ch3: { left: 0, right: 0 }
  });

  const [spectrumBands, setSpectrumBands] = useState<number[]>(Array(16).fill(0));
  const [broadcastedVideosCount, setBroadcastedVideosCount] = useState<number>(0);

  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const hoverPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const channelVideoRefs = useRef<{ [key: string]: HTMLVideoElement | null }>({});

  const activeChannel = channels.find((c) => c.id === activeChannelId) || channels[0];
  const isPlaying = activeChannel.isPlaying;

  // Copia sempre aggiornata di "channels", letta dagli effetti che devono
  // ragionare su più assegnazioni in un colpo solo (vedi l'effetto sui video
  // in arrivo dalla Libreria più sotto) senza incappare nello stato "vecchio"
  // catturato dalla chiusura dell'effetto.
  const channelsRef = useRef<Channel[]>(channels);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  // Motore di animazione livelli a 30fps
  useEffect(() => {
    let animId: number;
    let lastTime = 0;
    const fpsInterval = 1000 / 30;

    const renderTick = (timestamp: number) => {
      if (!lastTime) lastTime = timestamp;
      const elapsed = timestamp - lastTime;

      if (elapsed >= fpsInterval) {
        lastTime = timestamp - (elapsed % fpsInterval);
        const now = timestamp;
        const hasActive = Boolean(activeChannel.url && activeChannel.isPlaying && !isBlackout);

        let masterL = 0;
        let masterR = 0;

        if (hasActive) {
          const t = (now / 60) * activeChannel.playbackRate;
          const w1 = Math.sin(t) * 30;
          const w2 = Math.cos(t * 1.8) * 22;
          const raw = Math.max(18, Math.min(96, Math.round(58 + w1 + w2)));

          const volMult = isMuted ? 0 : volume / 100;
          masterL = Math.round(raw * volMult);
          masterR = Math.max(0, Math.min(100, Math.round(masterL * 0.95)));

          const bands = Array.from({ length: 16 }).map((_, i) => {
            const p = Math.abs(Math.sin(t * 0.85 + i * 0.52));
            const h = Math.round(p * (82 - i * 1.6) + 10);
            return Math.max(0, Math.min(100, Math.round(h * volMult)));
          });
          setSpectrumBands(bands);
        } else {
          setSpectrumBands((prev) => prev.map((v) => Math.max(0, v - 10)));
        }

        setLiveLevels({ left: masterL, right: masterR });

        setChannelAudioLevels(() => {
          const next: { [key: string]: AudioLevels } = {};
          channels.forEach((ch, idx) => {
            if (ch.isPlaying && ch.url && !isBlackout) {
              if (ch.id === activeChannelId && masterL > 0) {
                next[ch.id] = { left: masterL, right: masterR };
              } else {
                const ct = (now / (70 + idx * 20)) * ch.playbackRate;
                const chW = Math.abs(Math.sin(ct) * 48);
                const cL = Math.max(14, Math.min(94, Math.round(chW)));
                next[ch.id] = { left: cL, right: cL };
              }
            } else {
              next[ch.id] = { left: 0, right: 0 };
            }
          });
          return next;
        });
      }

      animId = requestAnimationFrame(renderTick);
    };

    animId = requestAnimationFrame(renderTick);
    return () => cancelAnimationFrame(animId);
  }, [activeChannel, isPlaying, isBlackout, isMuted, volume, channels, activeChannelId]);

  useEffect(() => {
    if (mainVideoRef.current) {
      mainVideoRef.current.volume = isBlackout || isMuted ? 0 : volume / 100;
    }
  }, [volume, isMuted, isBlackout]);

  useEffect(() => {
    if (mainVideoRef.current && activeChannel) {
      mainVideoRef.current.playbackRate = activeChannel.playbackRate;
    }
  }, [activeChannelId, activeChannel?.playbackRate]);

  useEffect(() => {
    if (mainVideoRef.current) {
      if (activeChannel.isPlaying && !isBlackout && activeChannel.url) {
        mainVideoRef.current.play().catch(() => {});
      } else {
        mainVideoRef.current.pause();
      }
    }

    channels.forEach((ch) => {
      const vid = channelVideoRefs.current[ch.id];
      if (vid && ch.url) {
        vid.playbackRate = ch.playbackRate;
        if (ch.isPlaying && !isBlackout) {
          vid.play().catch(() => {});
        } else {
          vid.pause();
        }
      }
    });
  }, [channels, activeChannel.isPlaying, isBlackout]);

  // Sincronizzazione continua, stretta e bidirezionale tra Program e Lettore Piccolo
  useEffect(() => {
    let frameId: number;
    let counter = 0;

    const syncLoop = () => {
      counter++;
      const mainVid = mainVideoRef.current;
      const activeSmallVid = channelVideoRefs.current[activeChannelId];

      if (mainVid) {
        const currentT = mainVid.currentTime;
        setCurrentTime(currentT);
        if (mainVid.duration && !isNaN(mainVid.duration)) {
          setDuration(mainVid.duration);
        }

        // Forzatura immediata e costante sul lettore piccolo per mantenere il sincronismo perfetto anche a 6x/7x
        if (activeSmallVid) {
          if (Math.abs(activeSmallVid.currentTime - currentT) > 0.05) {
            activeSmallVid.currentTime = currentT;
          }
          if (activeSmallVid.playbackRate !== activeChannel.playbackRate) {
            activeSmallVid.playbackRate = activeChannel.playbackRate;
          }
        }
      }

      if (counter % 2 === 0) {
        setChannels((prev) =>
          prev.map((c) => {
            const vid = channelVideoRefs.current[c.id];
            if (!vid) return c;
            const timeToUse = c.id === activeChannelId && mainVid ? mainVid.currentTime : (vid.currentTime || 0);
            return {
              ...c,
              currentTime: timeToUse,
              duration: vid.duration && !isNaN(vid.duration) ? vid.duration : c.duration
            };
          })
        );
      }

      frameId = requestAnimationFrame(syncLoop);
    };

    frameId = requestAnimationFrame(syncLoop);
    return () => cancelAnimationFrame(frameId);
  }, [activeChannelId, activeChannel.playbackRate]);

  // Generatore anteprime filmstrip
  useEffect(() => {
    if (!activeChannel.url) {
      setTimelineThumbnails([]);
      return;
    }

    let isCancelled = false;
    const offscreenVideo = document.createElement('video');
    offscreenVideo.src = activeChannel.url;
    offscreenVideo.crossOrigin = 'anonymous';
    offscreenVideo.muted = true;
    offscreenVideo.preload = 'auto';

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');

    const totalThumbs = 14;

    offscreenVideo.onloadedmetadata = async () => {
      const dur = offscreenVideo.duration;
      if (!dur || isNaN(dur) || isCancelled) return;

      const generatedThumbs: string[] = [];

      for (let i = 0; i < totalThumbs; i++) {
        if (isCancelled) break;
        const targetSec = (dur / (totalThumbs + 1)) * (i + 1);

        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            offscreenVideo.removeEventListener('seeked', onSeeked);
            if (ctx) {
              // Ritaglio "cover" per non deformare i video non 16:9 (come nelle
              // miniature della Libreria)
              const canvasAspect = canvas.width / canvas.height;
              const videoAspect = offscreenVideo.videoWidth / offscreenVideo.videoHeight || canvasAspect;
              let sx = 0, sy = 0, sWidth = offscreenVideo.videoWidth, sHeight = offscreenVideo.videoHeight;
              if (videoAspect > canvasAspect) {
                sWidth = sHeight * canvasAspect;
                sx = (offscreenVideo.videoWidth - sWidth) / 2;
              } else {
                sHeight = sWidth / canvasAspect;
                sy = (offscreenVideo.videoHeight - sHeight) / 2;
              }
              ctx.drawImage(offscreenVideo, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
              generatedThumbs.push(canvas.toDataURL('image/jpeg', 0.6));
            }
            resolve();
          };
          offscreenVideo.addEventListener('seeked', onSeeked);
          offscreenVideo.currentTime = targetSec;
        });
      }

      if (!isCancelled) {
        setTimelineThumbnails(generatedThumbs);
      }
    };

    return () => {
      isCancelled = true;
      offscreenVideo.src = '';
    };
  }, [activeChannel.url]);

  const handleChannelSwitch = useCallback((channelId: string) => {
    if (channelId === activeChannelId) return;

    if (mainVideoRef.current) {
      const currentPos = mainVideoRef.current.currentTime;
      setChannels(prev => prev.map(ch => ch.id === activeChannelId ? { ...ch, currentTime: currentPos } : ch));
    }

    setActiveChannelId(channelId);
    const targetChannel = channels.find(c => c.id === channelId);
    
    setTimeout(() => {
      if (mainVideoRef.current && targetChannel) {
        mainVideoRef.current.currentTime = targetChannel.currentTime;
        const targetSmallVid = channelVideoRefs.current[channelId];
        if (targetSmallVid) {
          targetSmallVid.currentTime = targetChannel.currentTime;
        }
        if (targetChannel.isPlaying && targetChannel.url && !isBlackout) {
          mainVideoRef.current.play().catch(() => {});
        } else {
          mainVideoRef.current.pause();
        }
      }
    }, 10);
  }, [activeChannelId, channels, isBlackout]);

  const seekActiveChannel = useCallback((targetTime: number) => {
    const validTime = Math.max(0, Math.min(targetTime, duration || 0));
    if (mainVideoRef.current) {
      mainVideoRef.current.currentTime = validTime;
    }
    const activeSmallVid = channelVideoRefs.current[activeChannelId];
    if (activeSmallVid) {
      activeSmallVid.currentTime = validTime;
    }
    setChannels(prev => prev.map(ch => ch.id === activeChannelId ? { ...ch, currentTime: validTime } : ch));
    setCurrentTime(validTime);
  }, [activeChannelId, duration]);

  useEffect(() => {
    const timelineEl = timelineRef.current;
    if (!timelineEl) return;

    const handleWheelScrub = (e: WheelEvent) => {
      if (!activeChannel.url || !duration) return;
      e.preventDefault();

      const step = e.shiftKey ? 5 : 1;
      const delta = e.deltaY > 0 ? step : -step;
      const current = mainVideoRef.current ? mainVideoRef.current.currentTime : currentTime;
      const newTime = Math.max(0, Math.min(current + delta, duration));

      seekActiveChannel(newTime);
    };

    timelineEl.addEventListener('wheel', handleWheelScrub, { passive: false });
    return () => timelineEl.removeEventListener('wheel', handleWheelScrub);
  }, [activeChannel.url, duration, currentTime, seekActiveChannel]);

  const handleVideoEnded = useCallback((channelId: string) => {
    const vid = channelVideoRefs.current[channelId];
    if (vid) vid.currentTime = 0;

    if (channelId === activeChannelId) {
      if (mainVideoRef.current) mainVideoRef.current.currentTime = 0;
      setCurrentTime(0);
    }

    setChannels((prev) =>
      prev.map((ch) => (ch.id === channelId ? { ...ch, isPlaying: false, currentTime: 0 } : ch))
    );

    setBroadcastedVideosCount((prev) => prev + 1);
  }, [activeChannelId]);

  const autoAssignVideo = (fileId: string, videoUrl: string, videoName: string) => {
    let targetIndex = channels.findIndex((ch) => !ch.url);
    if (targetIndex === -1) {
      targetIndex = channels.findIndex((ch) => !ch.isPlaying);
    }

    if (targetIndex === -1) {
      // Nessun lettore libero: il video NON va perso. Lo mettiamo (se non
      // già presente) nella lista MEDIA VIDEO, così resta visibile e lo si
      // può caricare manualmente non appena un lettore si libera, invece di
      // scartarlo silenziosamente dopo il solo avviso a scomparsa.
      setFolderFiles((prev) =>
        prev.some((f) => f.id === fileId) ? prev : [...prev, { id: fileId, name: videoName, url: videoUrl }]
      );
      setBusyWarning('⚠️ Lettori occupati: video aggiunto in coda a MEDIA VIDEO ➔');
      setTimeout(() => setBusyWarning(null), 3000);
      return;
    }

    const targetChannel = channels[targetIndex];

    setChannels((prev) =>
      prev.map((ch, idx) =>
        idx === targetIndex ? { ...ch, title: videoName, url: videoUrl, isPlaying: true, currentTime: 0 } : ch
      )
    );

    setTimeout(() => {
      const vid = channelVideoRefs.current[targetChannel.id];
      if (vid) {
        vid.currentTime = 0;
        vid.load();
        vid.play().catch(() => {});
      }
      if (targetChannel.id === activeChannelId && mainVideoRef.current) {
        mainVideoRef.current.currentTime = 0;
        mainVideoRef.current.load();
        mainVideoRef.current.play().catch(() => {});
      }
    }, 30);

    setFolderFiles((prev) => prev.filter((file) => file.id !== fileId));
  };

  // Video inviati dalla Libreria (pulsante "invia alla regia" / "Tutti in
  // regia"): quando ne arrivano PIÙ di uno nello stesso aggiornamento (es.
  // "Tutti in regia" su una cartella intera), React li consegna qui tutti
  // insieme in un solo giro di questo effetto. Per questo NON possiamo
  // assegnarli chiamando autoAssignVideo() uno per uno: quella funzione legge
  // lo stato "channels" catturato all'inizio del giro, che non si aggiorna
  // tra un video e l'altro dello stesso lotto — risultato: tutti i video
  // vedrebbero gli stessi lettori "liberi" e finirebbero sovrascritti sullo
  // stesso lettore. Qui invece teniamo una copia locale che aggiorniamo noi
  // stessi ad ogni assegnazione, così il video successivo del lotto "vede"
  // correttamente il lettore appena occupato dal precedente.
  const processedIncomingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newVideos = incomingVideos.filter((video) => !processedIncomingRef.current.has(video.id));
    if (newVideos.length === 0) return;
    newVideos.forEach((video) => processedIncomingRef.current.add(video.id));

    let working = channelsRef.current.map((ch) => ({ ...ch }));
    const leftover: MediaFile[] = [];
    const assignments: { channelId: string; }[] = [];

    newVideos.forEach((video) => {
      let targetIndex = working.findIndex((ch) => !ch.url);
      if (targetIndex === -1) {
        targetIndex = working.findIndex((ch) => !ch.isPlaying);
      }

      if (targetIndex === -1) {
        // Nessun lettore libero (nemmeno considerando quelli appena occupati
        // dai video precedenti di questo stesso lotto): il video va in coda
        // nella lista MEDIA VIDEO invece di andare perso.
        leftover.push(video);
        return;
      }

      working[targetIndex] = {
        ...working[targetIndex],
        title: video.name,
        url: video.url,
        isPlaying: true,
        currentTime: 0
      };
      assignments.push({ channelId: working[targetIndex].id });
    });

    channelsRef.current = working;
    setChannels(working);

    if (leftover.length > 0) {
      setFolderFiles((prev) => {
        const existingIds = new Set(prev.map((f) => f.id));
        const toAdd = leftover
          .filter((v) => !existingIds.has(v.id))
          .map((v) => ({ id: v.id, name: v.name, url: v.url }));
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
      setBusyWarning('⚠️ Lettori occupati: alcuni video sono in coda a MEDIA VIDEO ➔');
      setTimeout(() => setBusyWarning(null), 3000);
    }

    if (assignments.length > 0) {
      setTimeout(() => {
        assignments.forEach(({ channelId }) => {
          const vidEl = channelVideoRefs.current[channelId];
          if (vidEl) {
            vidEl.currentTime = 0;
            vidEl.load();
            vidEl.play().catch(() => {});
          }
          if (channelId === activeChannelId && mainVideoRef.current) {
            mainVideoRef.current.currentTime = 0;
            mainVideoRef.current.load();
            mainVideoRef.current.play().catch(() => {});
          }
        });
      }, 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingVideos]);

  const updateChannelSpeed = useCallback((channelId: string, speed: number) => {
    const fixedSpeed = Math.round(speed * 100) / 100;
    setChannels((prev) =>
      prev.map((ch) => (ch.id === channelId ? { ...ch, playbackRate: fixedSpeed } : ch))
    );
  }, []);

  const toggleChannelPlay = useCallback((channelId: string) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, isPlaying: !c.isPlaying } : c))
    );
  }, []);

  const resetChannelVideo = useCallback((channelId: string) => {
    const vid = channelVideoRefs.current[channelId];
    if (vid) vid.currentTime = 0;
    setChannels(prev => prev.map(ch => ch.id === channelId ? { ...ch, currentTime: 0 } : ch));
    if (channelId === activeChannelId) {
      if (mainVideoRef.current) mainVideoRef.current.currentTime = 0;
      setCurrentTime(0);
    }
  }, [activeChannelId]);

  const registerVideoRef = useCallback((id: string, el: HTMLVideoElement | null) => {
    channelVideoRefs.current[id] = el;
  }, []);

  const seekChannel = useCallback((channelId: string, targetTime: number) => {
    const vid = channelVideoRefs.current[channelId];
    const safeDuration = vid?.duration && !isNaN(vid.duration) ? vid.duration : undefined;
    const validTime = Math.max(0, safeDuration ? Math.min(targetTime, safeDuration) : targetTime);

    if (vid) vid.currentTime = validTime;

    if (channelId === activeChannelId && mainVideoRef.current) {
      mainVideoRef.current.currentTime = validTime;
      setCurrentTime(validTime);
    }

    setChannels((prev) =>
      prev.map((ch) => (ch.id === channelId ? { ...ch, currentTime: validTime } : ch))
    );
  }, [activeChannelId]);

  const formatTime = (timeInSeconds: number) => {
    if (isNaN(timeInSeconds) || timeInSeconds < 0) return '00:00';
    const mins = Math.floor(timeInSeconds / 60);
    const secs = Math.floor(timeInSeconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatSecs = (timeInSeconds: number) => {
    if (isNaN(timeInSeconds) || timeInSeconds < 0) return '000.0s';
    return `${timeInSeconds.toFixed(1).padStart(5, '0')}s`;
  };

  const getThumbnailLeft = () => {
    if (!timelineRef.current) return hoverPosition;
    const containerWidth = timelineRef.current.offsetWidth;
    const halfThumb = 75;
    return Math.max(halfThumb + 4, Math.min(hoverPosition, containerWidth - halfThumb - 4));
  };

  const totalSecondsPlayed = channels.reduce((acc, ch) => acc + (ch.currentTime || 0), 0);
  const totalLoadedSeconds = channels.reduce((acc, ch) => acc + (ch.duration || 0), 0);

  const remainingInWindow = folderFiles.length;
  const activeLoadedInPlayers = channels.filter((ch) => ch.url).length;
  const grandTotalFilms = remainingInWindow + activeLoadedInPlayers + broadcastedVideosCount;

  return (
    <div className="relative flex flex-col w-full flex-1 min-h-0 bg-zinc-950 text-zinc-100 font-sans overflow-hidden select-none">
      {busyWarning && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-2xl flex items-center gap-2">
          <span>{busyWarning}</span>
          <button onClick={() => setBusyWarning(null)} className="ml-2 font-black">✕</button>
        </div>
      )}

      {/* HEADER */}
      <header className="h-12 bg-zinc-900 border-b border-zinc-800 px-4 flex items-center justify-between shadow-md z-10 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping"></span>
            <span className="font-black text-sm tracking-wider text-white">REGIA VIDEO LIVE</span>
          </div>

          <div className="h-5 w-[1px] bg-zinc-700 mx-1"></div>

          <div className="flex items-center gap-2">
            {channels.map((ch, index) => {
              const isLive = activeChannelId === ch.id;
              return (
                <button
                  key={ch.id}
                  onClick={() => handleChannelSwitch(ch.id)}
                  className={`px-3 py-1 rounded-md text-xs font-bold transition-colors flex items-center gap-1.5 ${
                    isLive
                      ? 'bg-gradient-to-b from-zinc-300 to-zinc-500 text-zinc-900 ring-2 ring-zinc-400 shadow-inner'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white border border-zinc-700'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-zinc-900 animate-pulse' : 'bg-zinc-500'}`}></span>
                  LETTORE {index + 1}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* CONTENUTO PRINCIPALE */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* COLONNA SINISTRA (74%) */}
        <div className="w-[74%] flex flex-col border-r border-zinc-800 p-2 gap-2 overflow-hidden bg-zinc-950 h-full">
          
          {/* MONITOR PROGRAM PRINCIPALE + TIMELINE FILMSTRIP */}
          <div className="h-[67%] relative bg-black rounded-xl overflow-hidden border border-zinc-800 flex flex-col p-2 shrink-0 shadow-lg">
            
            {/* SCHERMO VIDEO PROGRAM */}
            <div className="relative flex-1 min-h-0 bg-black rounded-lg overflow-hidden flex items-center justify-center">
              <div className="absolute top-2 left-2 z-20 bg-red-600/90 text-white text-[11px] font-black px-2 py-0.5 rounded shadow">
                PROGRAM LIVE - {activeChannel.name} ({activeChannel.playbackRate}x)
              </div>

              {activeChannel.url ? (
                <video
                  ref={mainVideoRef}
                  src={activeChannel.url}
                  preload="auto"
                  onEnded={() => handleVideoEnded(activeChannelId)}
                  className="w-full h-full object-contain"
                  playsInline
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-zinc-600">
                  <span className="text-3xl mb-1">📼</span>
                  <span className="text-xs font-mono">CANALE VUOTO</span>
                </div>
              )}

              {/* VU-METER PROGRAM */}
              <div className="absolute right-3 top-3 bottom-3 z-30 pointer-events-none">
                <div className="h-full pointer-events-auto scale-95 origin-bottom-right">
                  <CanvasVuMeter
                    levels={liveLevels}
                    width={92}
                    height={660}
                  />
                </div>
              </div>
            </div>

            {/* BARRA TIMELINE + ANTEPRIME */}
            <div className="relative bg-zinc-900 border-t border-zinc-800 px-3 py-1.5 rounded-b-lg flex flex-col gap-1 shrink-0 mt-1 select-none">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black tracking-wider text-amber-400 uppercase bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded">
                    🎞️ FILMSTRIP TIMELINE & JOG
                  </span>
                  <span className="font-mono text-zinc-200 font-bold text-xs bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700 shadow-inner">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleChannelPlay(activeChannelId)}
                    disabled={!activeChannel.url}
                    className="px-3 py-0.5 bg-gradient-to-b from-zinc-300 to-zinc-500 hover:from-zinc-200 hover:to-zinc-400 disabled:opacity-40 text-zinc-900 rounded font-bold text-xs shadow-inner border border-zinc-500/60 transition-colors"
                  >
                    {isPlaying ? '⏸ PAUSA' : '▶ PLAY'}
                  </button>
                  <button
                    onClick={() => resetChannelVideo(activeChannelId)}
                    disabled={!activeChannel.url}
                    className="px-2.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 rounded font-bold text-xs border border-zinc-700 transition-colors"
                  >
                    ⏮ RESET
                  </button>
                  <div className="h-4 w-[1px] bg-zinc-700 mx-1"></div>
                  <button onClick={() => setIsMuted(!isMuted)} className="text-xs hover:scale-110 transition-transform">
                    {isMuted ? '🔇' : '🔊'}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-14 h-1.5 bg-zinc-700 rounded-lg cursor-pointer accent-red-500"
                  />
                </div>
              </div>

              {/* FILMSTRIP */}
              <div
                className="relative w-full h-16 bg-zinc-950 rounded-lg border border-zinc-700/80 cursor-pointer overflow-hidden group shadow-inner flex"
                ref={timelineRef}
                onMouseEnter={() => {
                  if (!activeChannel.url) return;
                  setIsHoveringTimeline(true);
                }}
                onMouseLeave={() => {
                  setIsHoveringTimeline(false);
                  setHoverTime(null);
                }}
                onMouseMove={(e) => {
                  if (!timelineRef.current || !duration) return;
                  const rect = timelineRef.current.getBoundingClientRect();
                  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                  const targetT = (x / rect.width) * duration;
                  setHoverPosition(x);
                  setHoverTime(targetT);

                  if (hoverPreviewVideoRef.current && isFinite(targetT)) {
                    hoverPreviewVideoRef.current.currentTime = targetT;
                  }
                }}
                onClick={(e) => {
                  if (!timelineRef.current || !duration) return;
                  const rect = timelineRef.current.getBoundingClientRect();
                  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                  seekActiveChannel((x / rect.width) * duration);
                }}
              >
                <div className="absolute inset-0 flex pointer-events-none opacity-85">
                  {timelineThumbnails.length > 0 ? (
                    timelineThumbnails.map((thumb, idx) => (
                      <div
                        key={idx}
                        className="flex-1 h-full border-r border-zinc-800/80 overflow-hidden bg-cover bg-center"
                        style={{ backgroundImage: `url(${thumb})` }}
                      />
                    ))
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs font-mono">
                      {activeChannel.url ? 'GENERAZIONE ANTEPRIME IN CORSO...' : 'NESSUN VIDEO ATTIVO'}
                    </div>
                  )}
                </div>

                <div
                  className="absolute left-0 top-0 bottom-0 bg-red-600/35 border-r-2 border-red-500 backdrop-brightness-125 pointer-events-none transition-all duration-75"
                  style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                />

                <div
                  className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_8px_rgba(255,255,255,1)] pointer-events-none -translate-x-1/2 z-20"
                  style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                >
                  <div className="w-2.5 h-2 bg-red-500 rounded-b -translate-x-[3px]" />
                </div>

                {isHoveringTimeline && (
                  <div
                    className="absolute top-0 bottom-0 w-[1px] bg-amber-400 pointer-events-none -translate-x-1/2 z-20 shadow-[0_0_4px_#fbbf24]"
                    style={{ left: `${hoverPosition}px` }}
                  />
                )}

                {isHoveringTimeline && hoverTime !== null && activeChannel.url && (
                  <div
                    className="absolute bottom-20 -translate-x-1/2 bg-zinc-900/95 border-2 border-amber-500 rounded-lg p-1.5 shadow-2xl pointer-events-none z-50 flex flex-col items-center gap-1 backdrop-blur-md"
                    style={{ left: `${getThumbnailLeft()}px` }}
                  >
                    <div className="w-36 h-20 bg-black rounded overflow-hidden flex items-center justify-center border border-zinc-800">
                      <video
                        ref={hoverPreviewVideoRef}
                        src={activeChannel.url}
                        preload="auto"
                        muted
                        playsInline
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <span className="font-mono text-[9px] font-black text-amber-300 bg-black/90 px-2 py-0.5 rounded border border-zinc-800">
                      ⏱️ {formatTime(hoverTime)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SEZIONE INFERIORE: 3 LETTORI */}
          <div className="flex-1 min-h-0 bg-zinc-900/90 rounded-xl border border-zinc-800 p-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between px-1">
              <span className="font-extrabold text-[11px] uppercase text-zinc-200">3 LETTORI LIVE CANALI</span>
              <span className="text-[9px] font-mono text-zinc-400">SINCRONIZZATI PERFETTAMENTE</span>
            </div>

            <div className="grid grid-cols-3 gap-2 flex-1 min-h-0">
              {channels.map((ch) => (
                <ChannelCard
                  key={ch.id}
                  channel={ch}
                  isLive={activeChannelId === ch.id}
                  audioLevels={channelAudioLevels[ch.id] || { left: 0, right: 0 }}
                  onSelect={handleChannelSwitch}
                  onTogglePlay={toggleChannelPlay}
                  onReset={resetChannelVideo}
                  onSpeedChange={updateChannelSpeed}
                  onSeek={seekChannel}
                  onEnded={handleVideoEnded}
                  registerRef={registerVideoRef}
                />
              ))}
            </div>
          </div>
        </div>

        {/* COLONNA DESTRA (26%) */}
        <div className="w-[26%] flex flex-col bg-zinc-900/60 p-2 gap-2 overflow-hidden h-full">
          
          <div className="flex-1 min-h-0 flex flex-col bg-zinc-900/90 rounded-xl border border-zinc-800 p-2 overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-1 mb-1 shrink-0">
              <span className="font-black text-xs uppercase text-amber-400">📁 MEDIA VIDEO</span>
              <span className="text-xs font-mono text-zinc-400">{folderFiles.length} FILE</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
              {folderFiles.length > 0 ? (
                folderFiles.map((file) => (
                  <div
                    key={file.id}
                    onClick={() => autoAssignVideo(file.id, file.url, file.name)}
                    className="p-1.5 bg-zinc-800/80 hover:bg-amber-500/20 rounded border border-zinc-700/80 cursor-pointer flex items-center gap-2 transition-colors"
                  >
                    <span className="text-amber-400 text-sm">🎬</span>
                    <span className="text-xs font-medium text-zinc-200 truncate">{file.name}</span>
                  </div>
                ))
              ) : (
                <div className="h-full flex items-center justify-center text-center p-2 text-zinc-600 text-xs font-mono">
                  Nessun video in coda: invia video dalla Libreria
                </div>
              )}
            </div>
          </div>

          {/* DISPLAY LCD E SPETTRO */}
          <div className="h-[45%] bg-zinc-950 rounded-xl border-2 border-zinc-700 p-2 flex flex-col justify-between shadow-2xl relative overflow-hidden">
            <div className="flex items-center justify-between text-[10px] font-mono font-black text-zinc-500 px-1 mb-1 shrink-0 select-none">
              <span>● MULTI-TRACK LCD MONITOR</span>
              <span className="text-emerald-500 animate-pulse font-bold">● ONLINE</span>
            </div>

            <div className="flex-1 rounded-lg bg-[#879b76] border-4 border-[#6e8060] shadow-[inset_0_0_18px_rgba(0,0,0,0.5)] p-1.5 font-mono text-[#1a2315] flex flex-col justify-between select-none relative overflow-hidden">
              <div
                className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(rgba(0,0,0,0.8)_1px,transparent_1px)]"
                style={{ backgroundSize: '100% 3px' }}
              />

              <div className="flex justify-between items-center border-b-2 border-[#6e8060] pb-0.5 text-xs font-black tracking-wider shrink-0 relative z-10">
                <span>MEDIA FILES:</span>
                <span className="text-base bg-[#7a8d6b] px-2 py-0.2 rounded border border-[#647458] shadow-inner font-black">
                  {folderFiles.length.toString().padStart(3, '0')}
                </span>
              </div>

              <div className="flex flex-col border border-[#6e8060] rounded my-0.5 shrink-0 bg-[#7e926f] relative z-10 shadow-sm overflow-hidden">
                {channels.map((ch, idx) => {
                  const rem = Math.max(0, ch.duration - ch.currentTime);
                  return (
                    <div
                      key={ch.id}
                      className={`flex flex-col p-0.5 ${
                        idx !== channels.length - 1 ? 'border-b border-[#6e8060]' : ''
                      }`}
                    >
                      <div className="flex justify-between items-center border-b border-[#6e8060]/70 pb-0.5 font-black leading-tight">
                        <span className="text-xs font-black truncate flex-1 min-w-0 mr-1">
                          CH{idx + 1}: {ch.url ? ch.title : 'NO MEDIA'}
                        </span>
                        <span className={`shrink-0 px-1.5 py-0.2 text-[8px] rounded font-black ${ch.isPlaying ? 'bg-[#1a2315] text-[#879b76] animate-pulse' : 'text-[#2e3b25]'}`}>
                          {ch.isPlaying ? 'RUN' : 'STBY'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center px-1 border-b border-[#6e8060]/40 leading-tight">
                        <span className="text-[10px] font-black text-[#2b3822]">PLAYED:</span>
                        <span className="text-sm font-black">{formatSecs(ch.currentTime)}</span>
                      </div>
                      <div className="flex justify-between items-center px-1 border-b border-[#6e8060]/40 leading-tight">
                        <span className="text-[10px] font-black text-[#2b3822]">LOADED:</span>
                        <span className="text-sm font-black">{formatSecs(ch.duration)}</span>
                      </div>
                      <div className="flex justify-between items-center px-1 leading-tight">
                        <span className="text-[10px] font-black text-[#2b3822]">REMAIN:</span>
                        <span className="text-sm font-black">{formatSecs(rem)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border border-[#6e8060] py-0.5 flex flex-col gap-0.5 shrink-0 relative z-10 bg-[#768a67] px-1 rounded shadow-sm">
                <div className="flex justify-between items-center border-b border-[#6e8060]/60 pb-0.5">
                  <span className="text-xs font-black tracking-wider leading-none">TOTAL BCAST:</span>
                  <span className="text-base font-black tracking-wider leading-none">{formatSecs(totalSecondsPlayed)}</span>
                </div>
                <div className="flex justify-between items-center pt-0.5">
                  <span className="text-xs font-black tracking-wider leading-none">ALL LOADED:</span>
                  <span className="text-base font-black tracking-wider leading-none">{formatSecs(totalLoadedSeconds)}</span>
                </div>
              </div>

              <div className="mt-1 relative z-10">
                <SpectrumAnalyzer bands={spectrumBands} />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}