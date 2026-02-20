import React, { useRef, useEffect, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../types';
import { DashboardContext } from '../context';

interface DMWindowProps {
  agent: Agent;
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DMWindow({ agent, onClose }: DMWindowProps) {
  const ctx = useContext(DashboardContext);
  const [input, setInput] = React.useState('');
  const windowRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dragData = useRef<{ offsetX: number; offsetY: number; dragging: boolean }>({ offsetX: 0, offsetY: 0, dragging: false });

  const messages = ctx?.state.dmThreads[agent.id] || [];
  const myId = ctx?.state.dashboardAgent?.id;

  // Clear unread on open and when new messages arrive
  useEffect(() => {
    if (ctx && ctx.state.dmUnread[agent.id]) {
      ctx.dispatch({ type: 'CLEAR_DM_UNREAD', agentId: agent.id });
    }
  }, [agent.id, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (windowRef.current) {
      const rect = windowRef.current.getBoundingClientRect();
      if (windowRef.current.style.transform !== 'none') {
        windowRef.current.style.left = `${rect.left}px`;
        windowRef.current.style.top = `${rect.top}px`;
        windowRef.current.style.transform = 'none';
      }
      dragData.current = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        dragging: true
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragData.current.dragging && windowRef.current) {
      windowRef.current.style.left = `${e.clientX - dragData.current.offsetX}px`;
      windowRef.current.style.top = `${e.clientY - dragData.current.offsetY}px`;
    }
  };

  const onMouseUp = () => {
    dragData.current.dragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  const handleSend = () => {
    if (!input.trim() || !ctx) return;
    const text = input.trim();
    // Optimistic local update so the message appears immediately
    const msg = {
      id: `local-${Date.now()}`,
      from: myId || '',
      fromNick: ctx.state.dashboardAgent?.nick || 'You',
      to: agent.id,
      content: text,
      ts: Date.now(),
    };
    ctx.dispatch({ type: 'DM_MESSAGE', data: msg });
    // agent.id already includes the '@' prefix — don't double it
    ctx.send({ type: 'send_message', data: { to: agent.id, content: text } });
    setInput('');
  };

  const getNick = (fromId: string): string => {
    if (fromId === myId) return ctx?.state.dashboardAgent?.nick || 'You';
    const a = ctx?.state.agents[fromId];
    return a?.nick || fromId;
  };

  return createPortal(
    <>
      <div className="dm-backdrop" onClick={onClose} />
      <div ref={windowRef} className="dm-window">
        <div className="dm-header" onMouseDown={onMouseDown}>
          <span className="dm-title">{agent.nick || agent.id}</span>
          <button className="dm-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dm-messages">
          {messages.length === 0 && (
            <div className="dm-empty">No messages yet. Say hi!</div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className="dm-message">
              <span className="dm-msg-time">{formatTime(msg.ts)}</span>
              <span className="dm-msg-from">{getNick(msg.from)}</span>
              <span>{msg.content}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <div className="dm-input">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Type a message..."
            autoFocus
          />
        </div>
      </div>
    </>,
    document.body
  );
}
