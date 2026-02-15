import { useState, useRef, useEffect } from 'react';
import type { DashboardState, DashboardAction, WsSendFn, Theme } from '../types';
import { formatMsgRate } from '../utils';

interface TopBarProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export function TopBar({ state, dispatch, send, theme, setTheme }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const cycleTheme = () => {
    const order: Theme[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const themeIcon = theme === 'dark' ? (
    // Moon icon for dark mode
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M13.36 10.05a5.5 5.5 0 0 1-7.41-7.41 6 6 0 1 0 7.41 7.41z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ) : (
    // Sun icon for light/system mode
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" fill="none"/>
      <line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="3.05" y1="3.05" x2="4.46" y2="4.46" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="11.54" y1="11.54" x2="12.95" y2="12.95" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="3.05" y1="12.95" x2="4.46" y2="11.54" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="11.54" y1="4.46" x2="12.95" y2="3.05" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );

  const themeTitle = theme === 'system' ? 'Theme: System (click to cycle)' : theme === 'light' ? 'Theme: Light (click to cycle)' : 'Theme: Dark (click to cycle)';

  return (
    <div className="topbar">
      <div className="topbar-left">
        {/* Logs toggle icon */}
        <button
          className={`topbar-icon-btn ${state.logsOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_LOGS' })}
          title={state.logsOpen ? 'Hide server logs' : 'Show server logs'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            <line x1="4.5" y1="5" x2="11.5" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <line x1="4.5" y1="8" x2="11.5" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <line x1="4.5" y1="11" x2="8.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        {/* Light/dark mode toggle icon */}
        <button
          className="topbar-icon-btn"
          onClick={cycleTheme}
          title={themeTitle}
        >
          {themeIcon}
        </button>
        {/* Sidebar toggle */}
        <button
          className="sidebar-toggle"
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          title={state.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </button>
        <span className="logo">agentforce</span>
        <span className={`status ${state.connected ? 'online' : 'offline'}`}>
          {state.connected ? 'Connected' : 'Disconnected'}
        </span>
        {state.activity.totalMsgsPerMin > 0 && (
          <span className="activity-rate" title="Messages per minute (5min rolling avg)">
            {formatMsgRate(state.activity.totalMsgsPerMin)} msgs
          </span>
        )}
      </div>
      <div className="topbar-right">
        {state.dashboardAgent && (
          <span className="dashboard-nick">{state.dashboardAgent.nick}</span>
        )}
        <button
          className="sidebar-toggle"
          onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
          title={state.rightPanelOpen ? 'Hide detail panel' : 'Show detail panel'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            <line x1="10.5" y1="2" x2="10.5" y2="14" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </button>
        {/* Power button (replaces gear icon) — opens settings dropdown */}
        <div className="settings-menu" ref={menuRef}>
          <button
            className={`settings-btn ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 1.5v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <path d="M4.5 3.2A5.5 5.5 0 1 0 11.5 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
            </svg>
          </button>
          {menuOpen && (
            <div className="settings-dropdown">
              <button
                className="settings-item"
                onClick={() => { dispatch({ type: "TOGGLE_SIDEBAR" }); setMenuOpen(false); }}
              >
                <span className="settings-item-label">Sidebar</span>
                <span className={`settings-item-badge ${state.sidebarOpen ? "on" : ""}`}>
                  {state.sidebarOpen ? "On" : "Off"}
                </span>
              </button>
              <button
                className="settings-item"
                onClick={() => { dispatch({ type: 'TOGGLE_RIGHT_PANEL' }); setMenuOpen(false); }}
              >
                <span className="settings-item-label">Detail Panel</span>
                <span className={`settings-item-badge ${state.rightPanelOpen ? 'on' : ''}`}>
                  {state.rightPanelOpen ? 'On' : 'Off'}
                </span>
              </button>
              <button
                className="settings-item"
                onClick={() => { dispatch({ type: 'TOGGLE_PULSE' }); setMenuOpen(false); }}
              >
                <span className="settings-item-label">Network Pulse</span>
                <span className={`settings-item-badge ${state.pulseOpen ? 'on' : ''}`}>
                  {state.pulseOpen ? 'On' : 'Off'}
                </span>
              </button>
              <button
                className="settings-item"
                onClick={() => { dispatch({ type: 'TOGGLE_LOGS' }); setMenuOpen(false); }}
              >
                <span className="settings-item-label">Server Logs</span>
                <span className={`settings-item-badge ${state.logsOpen ? 'on' : ''}`}>
                  {state.logsOpen ? 'On' : 'Off'}
                </span>
              </button>
              <div className="settings-divider" />
              <button className="settings-item" onClick={() => { cycleTheme(); setMenuOpen(false); }}>
                <span className="settings-item-label">Theme</span>
                <span className="settings-item-value">{theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
