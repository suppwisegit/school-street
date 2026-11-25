// Routen: Spieler-App (vier Tabs + Handel + Profil), Börse verwalten, Beamer.
import React, { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import PlayerApp from './pages/Player.jsx';
import Market from './pages/Market.jsx';
import Depot from './pages/Depot.jsx';
import News from './pages/News.jsx';
import Rank from './pages/Rank.jsx';
import Me from './pages/Me.jsx';
import Board from './pages/Board.jsx';
import Admin, { AdminGame, AdminNews, AdminSecurities, AdminUsers } from './pages/Admin.jsx';
import { Skel } from './ui.jsx';

// Der Handel bringt die Chart-Bibliothek mit — eigener Chunk, erst beim Öffnen geladen.
const SecurityDetail = React.lazy(() => import('./pages/SecurityDetail.jsx'));

// Ein Renderfehler darf nie die ganze Seite weiß machen. Der Fehler landet in der
// Browser-Konsole, damit man ihn nachvollziehen kann.
class Guard extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    console.error('[School-Street] Renderfehler:', error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" style={{ paddingTop: 48 }}>
        <div className="msg" role="alert">
          <span>Da ist etwas schiefgelaufen.</span>
          <button type="button" className="btn ghost sm" onClick={() => this.setState({ error: null })}>
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <Guard>
      <Suspense fallback={<div className="page"><Skel h={320} /></div>}>
        <Routes>
          <Route path="/" element={<PlayerApp />}>
            <Route index element={<Market />} />
            <Route path="depot" element={<Depot />} />
            <Route path="news" element={<News />} />
            <Route path="rank" element={<Rank />} />
            <Route path="me" element={<Me />} />
            <Route path="security/:id" element={<SecurityDetail />} />
            {/* alte Adressen bleiben erreichbar */}
            <Route path="profile" element={<Navigate to="/me" replace />} />
            <Route path="desk" element={<Navigate to="/" replace />} />
          </Route>
          <Route path="/admin" element={<Admin />}>
            <Route index element={<Navigate to="spiel" replace />} />
            <Route path="spiel" element={<AdminGame />} />
            <Route path="news" element={<AdminNews />} />
            <Route path="werte" element={<AdminSecurities />} />
            <Route path="nutzer" element={<AdminUsers />} />
          </Route>
          <Route path="/board" element={<Board />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Guard>
  );
}
