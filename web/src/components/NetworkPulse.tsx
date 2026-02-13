import { useEffect, useRef } from 'react';
import type { DashboardState, DashboardAction } from '../types';
import { agentColor, getCurrentEffectiveTheme } from '../utils';

interface PulseNode {
  id: string;
  label: string;
  type: 'agent' | 'channel';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  online?: boolean;
  verified?: boolean;
  memberCount?: number;
}

interface PulseEdge {
  source: string;
  target: string;
}

interface Particle {
  edge: PulseEdge;
  progress: number;
  speed: number;
  color: string;
}

interface NetworkPulseProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
}

export function NetworkPulse({ state, dispatch }: NetworkPulseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Map<string, PulseNode>>(new Map());
  const edgesRef = useRef<PulseEdge[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const lastMessageCountRef = useRef<number>(0);

  // Build graph from state
  useEffect(() => {
    const nodes = nodesRef.current;
    const agents = Object.values(state.agents);
    const channels = Object.values(state.channels);

    const activeIds = new Set<string>();

    for (const agent of agents) {
      activeIds.add(agent.id);
      const existing = nodes.get(agent.id);
      const msgCount = Object.values(state.messages).flat().filter(m => m.from === agent.id).length;
      const radius = Math.max(8, Math.min(24, 8 + msgCount * 0.5));

      if (existing) {
        existing.label = agent.nick || agent.id;
        existing.radius = radius;
        existing.color = agentColor(agent.nick || agent.id);
        existing.online = agent.online;
        existing.verified = agent.verified;
      } else {
        const canvas = canvasRef.current;
        const w = canvas?.width || 800;
        const h = canvas?.height || 600;
        nodes.set(agent.id, {
          id: agent.id,
          label: agent.nick || agent.id,
          type: 'agent',
          x: w / 2 + (Math.random() - 0.5) * w * 0.6,
          y: h / 2 + (Math.random() - 0.5) * h * 0.6,
          vx: 0,
          vy: 0,
          radius,
          color: agentColor(agent.nick || agent.id),
          online: agent.online,
          verified: agent.verified,
        });
      }
    }

    for (const channel of channels) {
      activeIds.add(channel.name);
      const existing = nodes.get(channel.name);
      const radius = Math.max(12, Math.min(30, 12 + (channel.members?.length || 0) * 2));

      if (existing) {
        existing.radius = radius;
        existing.memberCount = channel.members?.length || 0;
      } else {
        const canvas = canvasRef.current;
        const w = canvas?.width || 800;
        const h = canvas?.height || 600;
        nodes.set(channel.name, {
          id: channel.name,
          label: channel.name,
          type: 'channel',
          x: w / 2 + (Math.random() - 0.5) * w * 0.3,
          y: h / 2 + (Math.random() - 0.5) * h * 0.3,
          vx: 0,
          vy: 0,
          radius,
          color: 'rgba(91, 141, 239, 0.8)',
          memberCount: channel.members?.length || 0,
        });
      }
    }

    for (const id of nodes.keys()) {
      if (!activeIds.has(id)) nodes.delete(id);
    }

    const newEdges: PulseEdge[] = [];
    for (const agent of agents) {
      for (const ch of (agent.channels || [])) {
        if (nodes.has(ch)) {
          newEdges.push({ source: agent.id, target: ch });
        }
      }
    }
    edgesRef.current = newEdges;
  }, [state.agents, state.channels, state.messages]);

  // Spawn particles for new messages
  useEffect(() => {
    const allMsgs = Object.values(state.messages).flat();
    const totalCount = allMsgs.length;

    if (totalCount > lastMessageCountRef.current) {
      const newMsgs = allMsgs.slice(lastMessageCountRef.current);
      for (const msg of newMsgs.slice(-10)) {
        const edge = edgesRef.current.find(e => e.source === msg.from && e.target === msg.to);
        if (edge) {
          const senderNode = nodesRef.current.get(msg.from);
          particlesRef.current.push({
            edge,
            progress: 0,
            speed: 0.008 + Math.random() * 0.006,
            color: senderNode?.color || '#5b8def',
          });
        }
      }
    }
    lastMessageCountRef.current = totalCount;
  }, [state.messages]);

  // Canvas sizing
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      canvas.style.width = container.clientWidth + 'px';
      canvas.style.height = container.clientHeight + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getNodeAt = (x: number, y: number): PulseNode | null => {
      for (const node of nodesRef.current.values()) {
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy < node.radius * node.radius * 1.5) return node;
      }
      return null;
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragRef.current) {
        const node = nodesRef.current.get(dragRef.current.nodeId);
        if (node) {
          node.x = x - dragRef.current.offsetX;
          node.y = y - dragRef.current.offsetY;
          node.vx = 0;
          node.vy = 0;
        }
        return;
      }

      const hit = getNodeAt(x, y);
      hoveredRef.current = hit ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
    };

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getNodeAt(x, y);
      if (hit) {
        dragRef.current = { nodeId: hit.id, offsetX: x - hit.x, offsetY: y - hit.y };
      }
    };

    const onMouseUp = () => {
      dragRef.current = null;
    };

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getNodeAt(x, y);
      if (hit && hit.type === 'agent') {
        const agent = state.agents[hit.id];
        if (agent) dispatch({ type: 'SELECT_AGENT', agent });
      } else if (hit && hit.type === 'channel') {
        dispatch({ type: 'SELECT_CHANNEL', channel: hit.id });
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
    };
  }, [state.agents, dispatch]);

  // Animation loop
  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      const nodes = Array.from(nodesRef.current.values());
      const edges = edgesRef.current;

      // Force simulation
      const REPULSION = 3000;
      const ATTRACTION = 0.005;
      const DAMPING = 0.92;
      const CENTER_GRAVITY = 0.0005;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = REPULSION / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          if (!dragRef.current || dragRef.current.nodeId !== a.id) {
            a.vx += dx;
            a.vy += dy;
          }
          if (!dragRef.current || dragRef.current.nodeId !== b.id) {
            b.vx -= dx;
            b.vy -= dy;
          }
        }
      }

      for (const edge of edges) {
        const a = nodesRef.current.get(edge.source);
        const b = nodesRef.current.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const fx = dx * ATTRACTION;
        const fy = dy * ATTRACTION;
        if (!dragRef.current || dragRef.current.nodeId !== a.id) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!dragRef.current || dragRef.current.nodeId !== b.id) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const node of nodes) {
        if (dragRef.current && dragRef.current.nodeId === node.id) continue;
        node.vx += (w / 2 - node.x) * CENTER_GRAVITY;
        node.vy += (h / 2 - node.y) * CENTER_GRAVITY;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
        node.x = Math.max(node.radius, Math.min(w - node.radius, node.x));
        node.y = Math.max(node.radius, Math.min(h - node.radius, node.y));
      }

      particlesRef.current = particlesRef.current.filter(p => {
        p.progress += p.speed;
        return p.progress < 1;
      });

      // --- Draw ---
      ctx.clearRect(0, 0, w, h);

      const isDark = getCurrentEffectiveTheme() === 'dark';
      ctx.fillStyle = isDark ? '#1e1e2e' : '#f5f6f8';
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = isDark ? 'rgba(91, 141, 239, 0.04)' : 'rgba(74, 125, 229, 0.06)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Edges
      for (const edge of edges) {
        const a = nodesRef.current.get(edge.source);
        const b = nodesRef.current.get(edge.target);
        if (!a || !b) continue;

        const isHovered = hoveredRef.current === a.id || hoveredRef.current === b.id;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = isHovered ? 'rgba(91, 141, 239, 0.3)' : 'rgba(91, 141, 239, 0.1)';
        ctx.lineWidth = isHovered ? 1.5 : 0.5;
        ctx.stroke();
      }

      // Particles
      for (const p of particlesRef.current) {
        const a = nodesRef.current.get(p.edge.source);
        const b = nodesRef.current.get(p.edge.target);
        if (!a || !b) continue;
        const x = a.x + (b.x - a.x) * p.progress;
        const y = a.y + (b.y - a.y) * p.progress;
        const alpha = 1 - p.progress;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = p.color.replace(')', `, ${alpha})`).replace('hsl', 'hsla');
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = p.color.replace(')', `, ${alpha * 0.3})`).replace('hsl', 'hsla');
        ctx.fill();
      }

      // Nodes
      for (const node of nodes) {
        const isHovered = hoveredRef.current === node.id;

        if (node.type === 'agent' && node.online) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
          ctx.fillStyle = isHovered
            ? node.color.replace('60%)', '60%, 0.3)')
            : node.color.replace('60%)', '60%, 0.1)');
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        if (node.type === 'channel') {
          ctx.fillStyle = isHovered ? 'rgba(91, 141, 239, 0.3)' : 'rgba(91, 141, 239, 0.15)';
          ctx.strokeStyle = 'rgba(91, 141, 239, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
        } else {
          const alpha = node.online ? 0.8 : 0.3;
          ctx.fillStyle = node.color.replace('60%)', `60%, ${isHovered ? 0.5 : 0.2})`);
          ctx.strokeStyle = node.color.replace('60%)', `60%, ${alpha})`);
          ctx.lineWidth = node.verified ? 2 : 1;
          ctx.fill();
          ctx.stroke();

          if (node.verified) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(91, 141, 239, 0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // Label
        ctx.font = `${isHovered ? 11 : 10}px Inter, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = node.label.length > 12 ? node.label.slice(0, 10) + '..' : node.label;
        ctx.fillStyle = isHovered ? (isDark ? '#ffffff' : '#111827') : (node.type === 'channel' ? 'rgba(91, 141, 239, 0.8)' : (isDark ? 'rgba(200, 200, 220, 0.7)' : 'rgba(80, 80, 100, 0.7)'));
        ctx.fillText(label, node.x, node.y + node.radius + 4);
      }

      // Tooltip
      if (hoveredRef.current) {
        const node = nodesRef.current.get(hoveredRef.current);
        if (node) {
          const lines: string[] = [node.label];
          if (node.type === 'agent') {
            lines.push(node.id);
            lines.push(node.online ? 'Online' : 'Offline');
            if (node.verified) lines.push('Verified');
          } else {
            lines.push(`${node.memberCount || 0} members`);
          }

          const padding = 8;
          const lineHeight = 14;
          ctx.font = '10px Inter, -apple-system, sans-serif';
          const tooltipW = Math.max(...lines.map(l => ctx.measureText(l).width)) + padding * 2;
          const tooltipH = lines.length * lineHeight + padding * 2;
          let tx = node.x + node.radius + 10;
          let ty = node.y - tooltipH / 2;
          if (tx + tooltipW > w) tx = node.x - node.radius - 10 - tooltipW;
          if (ty < 0) ty = 4;
          if (ty + tooltipH > h) ty = h - tooltipH - 4;

          ctx.fillStyle = isDark ? 'rgba(37, 37, 54, 0.95)' : 'rgba(255, 255, 255, 0.95)';
          ctx.strokeStyle = isDark ? 'rgba(91, 141, 239, 0.3)' : 'rgba(74, 125, 229, 0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
          ctx.fill();
          ctx.stroke();

          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          lines.forEach((line, i) => {
            ctx.fillStyle = i === 0 ? (isDark ? '#5b8def' : '#4a7de5') : (isDark ? '#8888aa' : '#666680');
            ctx.fillText(line, tx + padding, ty + padding + i * lineHeight);
          });
        }
      }

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div className="network-pulse" ref={containerRef}>
      <canvas ref={canvasRef} />
      <div className="pulse-legend">
        <span className="legend-item"><span className="legend-dot agent-dot" /> Agent</span>
        <span className="legend-item"><span className="legend-dot channel-dot" /> Channel</span>
        <span className="legend-item"><span className="legend-dot verified-dot" /> Verified</span>
        <span className="legend-item"><span className="legend-dot particle-dot" /> Message</span>
      </div>
    </div>
  );
}
