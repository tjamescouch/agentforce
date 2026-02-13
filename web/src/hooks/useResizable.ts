import { useState, useRef, useCallback } from 'react';

export function useResizable(initialWidth: number, min: number, max: number, side: 'left' | 'right' | 'bottom') {
  const [width, setWidth] = useState(initialWidth);
  const isResizing = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    handleRef.current?.classList.add('active');
    const startPos = side === 'bottom' ? e.clientY : e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const currentPos = side === 'bottom' ? e.clientY : e.clientX;
      const delta = side === 'left' ? currentPos - startPos
                  : side === 'right' ? startPos - currentPos
                  : startPos - currentPos;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      handleRef.current?.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = side === 'bottom' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, min, max, side]);

  return { width, handleRef, onMouseDown };
}
