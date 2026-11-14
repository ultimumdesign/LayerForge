import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initializeDiagnostics } from './audio/diagnostics.js';
import './styles/theme.css';

initializeDiagnostics();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
