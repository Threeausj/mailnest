import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeServiceWorker } from './workerRegistration';
import './styles.css';
import './workspace.css';
import './panes.css';
import './topbar.css';
import './theme.css';
import './glass-shell.css';
import './glass-surfaces.css';
import './navigation.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

initializeServiceWorker();
