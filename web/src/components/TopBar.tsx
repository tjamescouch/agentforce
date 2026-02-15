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

  const themeLabel = theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark';

  return (
    <div className="topbar">
      <div className="topbar-left">
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
        <span className="logo">AgentForce</span>
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
        <div className="settings-menu" ref={menuRef}>
          <button
            className={`settings-btn ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.3a5.52 5.52 0 0 1 1.27.53l.21-.21a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1 0 1.06l-.21.21c.22.4.4.83.53 1.27h.3a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75h-.3a5.52 5.52 0 0 1-.53 1.27l.21.21a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 0 1-1.06 0l-.21-.21c-.4.22-.83.4-1.27.53v.3a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-.3a5.52 5.52 0 0 1-1.27-.53l-.21.21a.75.75 0 0 1-1.06 0L2.9 12.04a.75.75 0 0 1 0-1.06l.21-.21a5.52 5.52 0 0 1-.53-1.27h-.3a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75h.3c.13-.44.31-.87.53-1.27l-.21-.21a.75.75 0 0 1 0-1.06L3.96 2.9a.75.75 0 0 1 1.06 0l.21.21c.4-.22.83-.4 1.27-.53v-.3zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" fill="currentColor"/>
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
              <button className="settings-item" onClick={cycleTheme}>
                <span className="settings-item-label">Theme</span>
                <span className="settings-item-value">{themeLabel}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
