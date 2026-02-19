import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../types';

interface DMWindowProps {
  agent: Agent;
  onClose: () => void;
}

export function DMWindow({ agent, onClose }: DMWindowProps) {
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const windowRef = useRef<HTMLDivElement>(null);
  const dragData = useRef<{ offsetX: number; offsetY: number; dragging: boolean }>({ offsetX: 0, offsetY: 0, dragging: false });

  const onMouseDown = (e: React.MouseEvent) => {
    if (windowRef.current) {
      dragData.current = {
        offsetX: e.clientX - windowRef.current.getBoundingClientRect().left,
        offsetY: e.clientY - windowRef.current.getBoundingClientRect().top,
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
    if (input.trim()) {
      setMessages([...messages, input.trim()]);
      setInput('');
    }
  };

  return createPortal(
    <>
      <div className="dm-backdrop" onClick={onClose} />
      <div ref={windowRef} className="dm-window">
        <div className="dm-header" onMouseDown={onMouseDown}>
          <span className="dm-title">DM: {agent.nick || agent.id}</span>
          <button className="dm-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dm-messages">
          {messages.length === 0 && (
            <div className="dm-empty">No messages yet. Say hi!</div>
          )}
          {messages.map((msg, idx) => <div key={idx} className="dm-message">{msg}</div>)}
        </div>
        <div className="dm-input">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Type a message..."
            autoFocus
          />
          <button onClick={handleSend}>Send</button>
        </div>
      </div>
    </>,
    document.body
  );
}
