import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './workspace.css';
import './panes.css';
import './topbar.css';
import './theme.css';
import './glass-shell.css';
import './glass-surfaces.css';
import './navigation.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(() => { /* App remains usable if service workers are unavailable. */ });
  });
}
