import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import PlayerApp from './pages/Player.jsx';
import MarketTab from './pages/Market.jsx';
import SecurityDetail from './pages/SecurityDetail.jsx';
import DepotTab from './pages/Depot.jsx';
import NewsTab from './pages/News.jsx';
import ProfileTab from './pages/Profile.jsx';
import AdminApp from './pages/Admin.jsx';
import BoardPage from './pages/Board.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayerApp />}>
        <Route index element={<MarketTab />} />
        <Route path="depot" element={<DepotTab />} />
        <Route path="news" element={<NewsTab />} />
        <Route path="profile" element={<ProfileTab />} />
        <Route path="security/:id" element={<SecurityDetail />} />
      </Route>
      <Route path="/admin" element={<AdminApp />} />
      <Route path="/board" element={<BoardPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
