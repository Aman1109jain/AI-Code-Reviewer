import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { GithubProvider } from './context/GithubContext.jsx';
import { LiveProvider } from './context/LiveContext.jsx';
import './index.css';
import './responsive.css';
import './admin.css';

// GithubProvider is outside LiveProvider: live updates only start once a user is connected.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <GithubProvider>
        <LiveProvider>
          <App />
        </LiveProvider>
      </GithubProvider>
    </ThemeProvider>
  </React.StrictMode>
);
