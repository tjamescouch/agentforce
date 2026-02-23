import { useState, useEffect, useCallback, useRef } from 'react';

export type LockMode = 'checking' | 'open' | 'locked' | 'unlocked';

interface LockScreenProps {
  onUnlocked: () => void;
}

/**
 * Backend-enforced lock screen.
 *
 * On mount:
 *   1. GET /api/ui-auth/status — if pinRequired=false or already authenticated → onUnlocked()
 *   2. If locked → show PIN entry
 *   3. POST /api/ui-auth/unlock { pin } — on success, store token in sessionStorage, call onUnlocked()
 *
 * The UI session token is stored in sessionStorage (tab-scoped) and attached to
 * all API requests via the X-UI-Token header by the global fetch wrapper below.
 */

/** Attach the UI token to all outgoing fetch/XHR requests automatically. */
export function getUiToken(): string | null {
  return sessionStorage.getItem('ui_token');
}

export function clearUiToken(): void {
  sessionStorage.removeItem('ui_token');
}

export function storeUiToken(token: string): void {
  sessionStorage.setItem('ui_token', token);
}

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const [mode, setMode] = useState<LockMode>('checking');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [time, setTime] = useState(new Date());
  const inputRef = useRef<HTMLInputElement>(null);

  // Clock tick
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Focus PIN input when locked
  useEffect(() => {
    if (mode === 'locked') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [mode]);

  // Check auth status on mount
  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const existingToken = getUiToken();
        const headers: Record<string, string> = {};
        if (existingToken) headers['X-UI-Token'] = existingToken;

        const res = await fetch('/api/ui-auth/status', { headers });
        if (cancelled) return;

        if (!res.ok) {
          setMode('locked');
          return;
        }

        const data = await res.json() as { pinRequired: boolean; authenticated: boolean };

        if (!data.pinRequired) {
          // Open/dev mode — no PIN needed
          setMode('open');
          onUnlocked();
        } else if (data.authenticated) {
          // Valid session already
          setMode('unlocked');
          onUnlocked();
        } else {
          setMode('locked');
        }
      } catch {
        if (!cancelled) {
          // Server unreachable — show locked screen
          setMode('locked');
        }
      }
    }

    checkStatus();
    return () => { cancelled = true; };
  }, [onUnlocked]);

  const handleUnlock = useCallback(async () => {
    if (!pin.trim() || submitting) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/ui-auth/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.trim() }),
      });

      const data = await res.json() as { token?: string; error?: string };

      if (res.ok && data.token) {
        storeUiToken(data.token);
        setMode('unlocked');
        setPin('');
        onUnlocked();
      } else {
        setError(data.error || 'Invalid PIN');
        setPin('');
        inputRef.current?.focus();
      }
    } catch {
      setError('Connection error — try again');
    } finally {
      setSubmitting(false);
    }
  }, [pin, submitting, onUnlocked]);

  // Enter to submit
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleUnlock();
  }, [handleUnlock]);

  if (mode === 'checking') {
    return (
      <div className="lock-screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ opacity: 0.5, fontSize: 14 }}>Checking authentication…</div>
      </div>
    );
  }

  if (mode === 'open' || mode === 'unlocked') {
    return null;
  }

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const dateStr = time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="lock-screen" style={{ zIndex: 9999 }}>
      <div className="lock-screen-content">
        {/* Clock */}
        <div className="lock-time">
          <span className="lock-hours">{displayHours}</span>
          <span className="lock-colon">:</span>
          <span className="lock-minutes">{minutes}</span>
          <span className="lock-period">{period}</span>
        </div>
        <div className="lock-date">{dateStr}</div>

        {/* PIN entry */}
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <input
            ref={inputRef}
            type="password"
            value={pin}
            onChange={e => { setPin(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            placeholder="Enter PIN"
            autoComplete="current-password"
            disabled={submitting}
            maxLength={8}
            inputMode="numeric"
            pattern="\d{8}"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: error ? '1px solid rgba(255,80,80,0.8)' : '1px solid rgba(255,255,255,0.25)',
              borderRadius: 8,
              color: '#fff',
              fontSize: 18,
              padding: '10px 16px',
              textAlign: 'center',
              letterSpacing: '0.25em',
              width: 200,
              outline: 'none',
            }}
          />
          {error && (
            <div style={{ color: 'rgba(255,120,120,0.9)', fontSize: 13 }}>{error}</div>
          )}
          <button
            onClick={handleUnlock}
            disabled={pin.length !== 8 || submitting}
            style={{
              background: submitting ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 8,
              color: '#fff',
              cursor: pin.length === 8 && !submitting ? 'pointer' : 'default',
              fontSize: 14,
              padding: '8px 24px',
              transition: 'background 0.2s',
            }}
          >
            {submitting ? 'Unlocking…' : 'Unlock'}
          </button>
          <div className="lock-hint" style={{ marginTop: 4 }}>
            Enter 8-digit PIN · Press Enter to unlock
          </div>
        </div>
      </div>
    </div>
  );
}
