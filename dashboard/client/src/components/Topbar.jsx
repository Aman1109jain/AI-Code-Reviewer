import { useEffect, useRef, useState } from 'react';
import { Github, Sun, Moon, Menu, CircleDot, LogOut, ExternalLink, ShieldCheck } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { useGithub } from '../context/GithubContext.jsx';

export default function Topbar({ onToggleSidebar, live, onNavigate, adminActive = false }) {
  const { theme, toggleTheme } = useTheme();
  const { loading, connected, login, avatarUrl, profileUrl, connect, disconnect } = useGithub();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn mobile-only" onClick={onToggleSidebar} aria-label="Toggle menu">
          <Menu size={18} />
        </button>
        <button className="topbar-brand" onClick={() => onNavigate('/')}>
          <span className="topbar-brand-mark">AI</span>
          <span className="topbar-brand-text">Code Reviewer</span>
        </button>
      </div>

      <div className="topbar-right">
        <div className={`live-indicator ${live ? 'is-live' : ''}`} title={live ? 'Live updates connected' : 'Reconnecting…'}>
          <CircleDot size={13} />
          <span>{live ? 'Live' : 'Connecting…'}</span>
        </div>

        <button className="icon-btn" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {loading && (
          <div className="github-btn" title="Checking your GitHub connection…">
            <Github size={16} />
            <span>Checking…</span>
          </div>
        )}

        {!loading && !connected && (
          <button className="github-btn github-connect" onClick={connect} title="Connect your GitHub account">
            <Github size={16} />
            <span>Connect GitHub</span>
          </button>
        )}

        {!loading && connected && (
          <div className="github-menu" ref={menuRef}>
            <button
              className="github-btn is-connected"
              onClick={() => setMenuOpen((o) => !o)}
              title={`Connected as ${login}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {avatarUrl ? <img className="github-avatar" src={avatarUrl} alt="" /> : <Github size={16} />}
              <span>{login}</span>
            </button>
            {menuOpen && (
              <div className="github-dropdown" role="menu">
                <a className="github-dropdown-item" href={profileUrl} target="_blank" rel="noreferrer" role="menuitem">
                  <ExternalLink size={14} /> View GitHub profile
                </a>
                <button
                  className="github-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    disconnect();
                  }}
                >
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        )}

        <button
          className={`github-btn admin-btn ${adminActive ? 'is-active' : ''}`}
          onClick={() => onNavigate('/admin')}
          title="Administrator sign-in"
          aria-label="Admin"
        >
          <ShieldCheck size={16} />
          <span>Admin</span>
        </button>
      </div>
    </header>
  );
}
