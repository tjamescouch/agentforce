import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../types';

function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  const effective = getEffectiveTheme(theme);
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', effective);
  }
  localStorage.setItem('dashboardTheme', theme);
}

export const savedTheme = (typeof window !== 'undefined' ? localStorage.getItem('dashboardTheme') as Theme : null) || 'system';
if (typeof window !== 'undefined') applyTheme(savedTheme);

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(savedTheme);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return [theme, setTheme];
}
