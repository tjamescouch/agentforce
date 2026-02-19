import { useState, useEffect, useCallback } from 'react';
import type { DashboardState, DashboardAction } from '../types';

interface LockScreenProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
}

export function LockScreen({ state, dispatch }: LockScreenProps) {
  const [time, setTime] = useState(new Date());
  const [locking, setLocking] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const unlock = useCallback(() => {
    dispatch({ type: 'HIDE_LOCK' });
  }, [dispatch]);

  // Allow Esc / Enter / Space to dismiss
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!state.lockScreen) return;
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        unlock();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.lockScreen, unlock]);

  if (!state.lockScreen) return null;

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;

  const dateStr = time.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  const agentCount = Object.values(state.agents).filter(a => a.online).length;

  return (
    <div
      className={`lock-screen ${locking ? 'locking' : ''}`}
      onClick={unlock}
      style={isDragging ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
    >
      <div className="lock-screen-content">
        <div className="lock-time">
          <span className="lock-hours">{displayHours}</span>
          <span className="lock-colon">:</span>
          <span className="lock-minutes">{minutes}</span>
          <span className="lock-period">{period}</span>
        </div>
        <div className="lock-date">{dateStr}</div>
        <div className="lock-status">
          <span className="lock-dot" />
          {agentCount} agent{agentCount !== 1 ? 's' : ''} online
        </div>
        <div className="lock-hint">Click or press Esc/Enter/Space to unlock</div>
      </div>
      <div className="lock-user">
        <div className="lock-avatar">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="12" r="5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <path d="M6 28c0-5.523 4.477-10 10-10s10 4.477 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
          </svg>
        </div>
        <span className="lock-nick">{state.dashboardAgent?.nick || 'visitor'}</span>
      </div>
    </div>
  );
}
