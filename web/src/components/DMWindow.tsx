import React, { useState, useEffect, useRef } from 'react';
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

  // Drag handlers
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

  return (
    <dialog
      ref={windowRef}
      open
      className="dm-window"
      style={{ width: '300px', height: '400px', border: '1px solid black', backgroundColor: 'white', boxShadow: '2px 2px 10px rgba(0,0,0,0.3)', zIndex: 1000, position: 'fixed' }}
      onMouseDown={e => e.stopPropagation()} // Prevent dialog drag unless header dragged
    >
      <div
        className="dm-header"
        style={{ cursor: 'move', backgroundColor: '#eee', padding: '5px' }}
        onMouseDown={onMouseDown}
      >
        <span>DM: {agent.nick || agent.id}</span>
        <button style={{ float: 'right' }} onClick={onClose}>X</button>
      </div>

      <div className="dm-messages" style={{ padding: '5px', height: '300px', overflowY: 'auto', borderBottom: '1px solid #ccc' }}>
        {messages.map((msg, idx) => <div key={idx} className="dm-message">{msg}</div>)}
      </div>

      <div className="dm-input" style={{ padding: '5px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if(e.key === 'Enter') handleSend(); }}
          style={{ width: '80%' }}
        />
        <button onClick={handleSend} style={{ width: '18%' }}>Send</button>
      </div>
    </dialog>
  );
}
