import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './ui.jsx';
import { WSProvider } from './ws.jsx';
import '@fontsource-variable/archivo';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <WSProvider>
          <App />
        </WSProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
