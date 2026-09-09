import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './theme.css';
import './Shell.css';
import LibraryView from './LibraryView.jsx';
import RegiaView from './RegiaView.tsx';
import { getPlayableUrl } from './lib/fsCompat';

function App() {
  const [activeView, setActiveView] = useState('library');
  const [isBlackout, setIsBlackout] = useState(false);
  const [regiaSources, setRegiaSources] = useState([]);

  // Esc per uscire dal nero, indipendentemente dalla vista attiva
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isBlackout) setIsBlackout(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBlackout]);
  // Tiene traccia sincrona di chi è già stato inviato in regia, per evitare invii
  // duplicati mentre l'aggiunta effettiva (asincrona, legge il file) è in corso
  const regiaIdsRef = useRef(new Set());

  // Legge il file del video selezionato in libreria e lo manda alla regia: la
  // RegiaView lo assegna da sola al primo lettore libero (o lo mette in coda
  // se sono tutti e 3 occupati)
  const handleSendToRegia = useCallback(async (video) => {
    if (regiaIdsRef.current.has(video.id)) return;
    regiaIdsRef.current.add(video.id);
    try {
      const file = await video.handle.getFile();
      const url = await getPlayableUrl(file);
      setRegiaSources((prev) => [...prev, { id: video.id, name: video.name, url }]);
    } catch (err) {
      regiaIdsRef.current.delete(video.id);
      console.error("Errore nell'invio del video alla regia:", err);
    }
  }, []);

  const sentToRegiaIds = useMemo(() => new Set(regiaSources.map((s) => s.id)), [regiaSources]);

  return (
    <div className="app-shell">
      <nav className="view-nav">
        <button
          type="button"
          className={`view-nav-btn ${activeView === 'library' ? 'active' : ''}`}
          onClick={() => setActiveView('library')}
        >
          <span className="view-nav-icon">🎞</span> Libreria Video
        </button>
        <button
          type="button"
          className={`view-nav-btn ${activeView === 'regia' ? 'active' : ''}`}
          onClick={() => setActiveView('regia')}
        >
          <span className="view-nav-icon">🎛</span> Regia Video
          {regiaSources.length > 0 && <span className="nav-badge">{regiaSources.length}</span>}
        </button>
        <button
          type="button"
          className={`view-nav-btn ${isBlackout ? 'active' : ''}`}
          onClick={() => setIsBlackout(true)}
        >
          <span className="view-nav-icon">⬛</span> Nero
        </button>
      </nav>

      {isBlackout && (
        <div className="blackout-overlay" onClick={() => setIsBlackout(false)}>
          <span className="blackout-hint">Clicca ovunque (o premi Esc) per tornare al video</span>
        </div>
      )}

      {/* Entrambe le viste restano montate (solo nascoste con CSS): così il video
          in riproduzione in libreria e lo stato della regia non si perdono
          passando da una scheda all'altra */}
      <div className="view-body view-body-library" hidden={activeView !== 'library'}>
        <LibraryView onSendToRegia={handleSendToRegia} sentToRegiaIds={sentToRegiaIds} />
      </div>
      <div className="view-body view-body-regia" hidden={activeView !== 'regia'}>
        <RegiaView incomingVideos={regiaSources} isBlackout={isBlackout} />
      </div>
    </div>
  );
}

export default App;
