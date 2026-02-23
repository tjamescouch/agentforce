import React, { useEffect, useRef, useState } from 'react';
import type { DashboardState } from '../types';

interface Props {
  state: DashboardState;
  onClose: () => void;
}

interface GeoEntry {
  ip: string;
  agentId: string;
  nick: string;
  country?: string;
  city?: string;
  lat?: number;
  lon?: number;
}

// Very rough IP → lat/lon via free public API (ipapi.co)
async function geoLookup(ip: string): Promise<{ lat: number; lon: number; country: string; city: string } | null> {
  // Skip private/loopback IPs
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|localhost)/.test(ip)) {
    return { lat: 37.7749, lon: -122.4194, country: 'Local', city: 'localhost' };
  }
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const d = await res.json();
    if (d.latitude && d.longitude) {
      return { lat: d.latitude, lon: d.longitude, country: d.country_name || '?', city: d.city || '?' };
    }
  } catch { /* ignore */ }
  return null;
}

// Equirectangular projection: map lat/lon → x/y on a 800×400 canvas
function project(lat: number, lon: number, w: number, h: number): [number, number] {
  const x = ((lon + 180) / 360) * w;
  const y = ((90 - lat) / 180) * h;
  return [x, y];
}

export function AnalyticsPanel({ state, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geoData, setGeoData] = useState<GeoEntry[]>([]);
  const [loadingGeo, setLoadingGeo] = useState(false);

  // Build spend data from activity stats
  const agents = Object.values(state.agents || {});
  const activity = state.activity;

  // Total messages as proxy for "spend" when no cost data available
  const agentStats = Object.entries(activity?.agents || {}).map(([id, s]) => ({
    id,
    nick: state.agents[id]?.nick || id.slice(0, 8),
    msgCount: s.msgCount,
    msgsPerMin: s.msgsPerMin,
  })).sort((a, b) => b.msgCount - a.msgCount);

  const totalMsgs = agentStats.reduce((acc, a) => acc + a.msgCount, 0);

  // Geo map: fetch locations for online agents
  useEffect(() => {
    const onlineAgents = agents.filter(a => a.online && !a.isDashboard);
    if (onlineAgents.length === 0) return;
    setLoadingGeo(true);
    // We don't have IPs from the client side — use agent ID hash for demo positions
    // In production the server would emit geo data in AGENT_UPDATE
    const syntheticGeo: GeoEntry[] = onlineAgents.map((a, i) => {
      // Spread agents around the world pseudo-randomly using id hash
      const hash = a.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const lat = ((hash * 37 + i * 13) % 140) - 70;
      const lon = ((hash * 53 + i * 17) % 340) - 170;
      return { ip: 'unknown', agentId: a.id, nick: a.nick || a.id.slice(0, 8), lat, lon, country: '?', city: '?' };
    });
    setGeoData(syntheticGeo);
    setLoadingGeo(false);
  }, [agents.length]);

  // Draw world map + dots
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // Simple world outline — draw grid lines
    ctx.strokeStyle = '#1e2a3a';
    ctx.lineWidth = 0.5;
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project(0, lon, W, H);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      const [, y] = project(lat, 0, W, H);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Equator + prime meridian highlight
    ctx.strokeStyle = '#1e3a2a';
    ctx.lineWidth = 1;
    const [, eqY] = project(0, 0, W, H);
    ctx.beginPath(); ctx.moveTo(0, eqY); ctx.lineTo(W, eqY); ctx.stroke();
    const [pmX] = project(0, 0, W, H);
    ctx.beginPath(); ctx.moveTo(pmX, 0); ctx.lineTo(pmX, H); ctx.stroke();

    // Plot agents
    geoData.forEach((g, i) => {
      if (g.lat == null || g.lon == null) return;
      const [x, y] = project(g.lat, g.lon, W, H);
      // Pulse ring
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,200,100,0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Dot
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#00e676';
      ctx.fill();
      // Label
      ctx.fillStyle = '#aaffcc';
      ctx.font = '10px monospace';
      ctx.fillText(g.nick, x + 6, y - 4);
    });
  }, [geoData]);

  const maxMsgs = agentStats[0]?.msgCount || 1;

  return (
    <div className="analytics-panel">
      <div className="analytics-header">
        <span className="analytics-title">📊 Analytics</span>
        <button className="dm-close" onClick={onClose}>&times;</button>
      </div>

      <div className="analytics-body">
        {/* Geo Map */}
        <div className="analytics-section">
          <div className="analytics-section-title">🌍 Connections</div>
          {loadingGeo && <div className="analytics-loading">Resolving locations…</div>}
          <canvas
            ref={canvasRef}
            width={560}
            height={280}
            className="analytics-map"
            title="Agent connection map"
          />
          <div className="analytics-map-legend">
            {geoData.map(g => (
              <span key={g.agentId} className="map-legend-item">
                <span className="map-dot" />
                {g.nick}
              </span>
            ))}
            {geoData.length === 0 && <span className="analytics-empty">No online agents</span>}
          </div>
        </div>

        {/* Spend / Activity Analytics */}
        <div className="analytics-section">
          <div className="analytics-section-title">💬 Message Activity</div>
          <div className="analytics-stat-row">
            <span className="analytics-stat-label">Total msgs/min</span>
            <span className="analytics-stat-value">{(activity?.totalMsgsPerMin || 0).toFixed(1)}</span>
          </div>
          <div className="analytics-stat-row">
            <span className="analytics-stat-label">Online agents</span>
            <span className="analytics-stat-value">{agents.filter(a => a.online && !a.isDashboard).length}</span>
          </div>
          <div className="analytics-bars">
            {agentStats.slice(0, 10).map(a => (
              <div key={a.id} className="analytics-bar-row">
                <span className="analytics-bar-label" title={a.id}>{a.nick}</span>
                <div className="analytics-bar-track">
                  <div
                    className="analytics-bar-fill"
                    style={{ width: `${Math.max(2, (a.msgCount / maxMsgs) * 100)}%` }}
                  />
                </div>
                <span className="analytics-bar-count">{a.msgCount}</span>
              </div>
            ))}
            {agentStats.length === 0 && <div className="analytics-empty">No activity data yet</div>}
          </div>
        </div>

        {/* Network health */}
        <div className="analytics-section">
          <div className="analytics-section-title">🔗 Network</div>
          <div className="analytics-stat-row">
            <span className="analytics-stat-label">Channels</span>
            <span className="analytics-stat-value">{Object.keys(state.channels || {}).length}</span>
          </div>
          <div className="analytics-stat-row">
            <span className="analytics-stat-label">Total messages tracked</span>
            <span className="analytics-stat-value">{totalMsgs}</span>
          </div>
          <div className="analytics-stat-row">
            <span className="analytics-stat-label">Connection</span>
            <span className={`analytics-stat-value status-${state.connectionStatus}`}>
              {state.connectionStatus}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
