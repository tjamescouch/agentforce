import { useState, FormEvent } from 'react';

interface LoginScreenProps {
  onLogin: (name: string) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please enter a name');
      return;
    }
    if (trimmed.length > 24) {
      setError('Name must be 24 characters or less');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Only letters, numbers, hyphens, and underscores');
      return;
    }
    onLogin(trimmed);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">agentforce</div>
        <p className="login-subtitle">Enter your name to connect</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <input
            className="login-input"
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="Your name"
            autoFocus
            maxLength={24}
          />
          {error && <div className="login-error">{error}</div>}
          <button className="login-button" type="submit">Connect</button>
        </form>
        <p className="login-hint">
          Your identity will be saved for future sessions
        </p>
      </div>
    </div>
  );
}
