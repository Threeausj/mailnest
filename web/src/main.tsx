import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeServiceWorker } from './workerRegistration';
import { ThemeProvider } from './Theme';
import './styles.css';
import './workspace.css';
import './panes.css';
import './topbar.css';
import './theme.css';
import './glass-shell.css';
import './glass-surfaces.css';
import './navigation.css';
import './dark-theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemeProvider><App /></ThemeProvider></React.StrictMode>);

initializeServiceWorker();
