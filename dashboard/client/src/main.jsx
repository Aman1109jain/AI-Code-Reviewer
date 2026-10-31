import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { GithubProvider } from './context/GithubContext.jsx';
import { LiveProvider } from './context/LiveContext.jsx';
import './index.css';
import './responsive.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <LiveProvider>
        <GithubProvider>
          <App />
        </GithubProvider>
      </LiveProvider>
    </ThemeProvider>
  </React.StrictMode>
);
