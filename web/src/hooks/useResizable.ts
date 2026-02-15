import { useState, useRef, useCallback, useEffect } from 'react';

interface UseResizableOptions {
  collapsible?: boolean;
  collapseThreshold?: number;
  defaultCollapsed?: boolean;
  onCollapse?: () => void;
  onExpand?: (width: number) => void;
  storageKey?: string;
}

export function useResizable(
  initialWidth: number,
  min: number,
  max: number,
  side: 'left' | 'right' | 'bottom',
  options: UseResizableOptions = {}
) {
  const {
    collapsible = false,
    collapseThreshold = 60,
    defaultCollapsed = false,
    onCollapse,
    onExpand,
    storageKey,
  } = options;

  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey + '_collapsed');
        if (saved !== null) return saved === 'true';
      } catch {}
    }
    return defaultCollapsed;
  });

  const [width, setWidth] = useState(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey + '_width');
        if (saved) return Math.min(max, Math.max(min, parseInt(saved, 10)));
      } catch {}
    }
    return initialWidth;
  });

  const lastWidth = useRef(width);
  const isResizing = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  // Keep lastWidth in sync when not collapsed
  useEffect(() => {
    if (!collapsed && width >= min) {
      lastWidth.current = width;
    }
  }, [width, collapsed, min]);

  // Persist state
  useEffect(() => {
    if (storageKey) {
      try {
        localStorage.setItem(storageKey + '_collapsed', String(collapsed));
        if (!collapsed) localStorage.setItem(storageKey + '_width', String(width));
      } catch {}
    }
  }, [collapsed, width, storageKey]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    handleRef.current?.classList.add('active');
    const startPos = side === 'bottom' ? e.clientY : e.clientX;
    const startWidth = collapsed ? 0 : width;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const currentPos = side === 'bottom' ? e.clientY : e.clientX;
      const delta = side === 'left' ? currentPos - startPos
                  : side === 'right' ? startPos - currentPos
                  : startPos - currentPos;
      const newWidth = startWidth + delta;

      if (collapsible) {
        if (newWidth < collapseThreshold) {
          if (!collapsed) {
            setCollapsed(true);
            onCollapse?.();
          }
        } else {
          if (collapsed) {
            setCollapsed(false);
            onExpand?.(Math.min(max, Math.max(min, newWidth)));
          }
          setWidth(Math.min(max, Math.max(min, newWidth)));
        }
      } else {
        setWidth(Math.min(max, Math.max(min, newWidth)));
      }
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
  }, [width, min, max, side, collapsible, collapseThreshold, collapsed, onCollapse, onExpand]);

  const expand = useCallback(() => {
    setCollapsed(false);
    setWidth(lastWidth.current >= min ? lastWidth.current : initialWidth);
  }, [min, initialWidth]);

  const collapse = useCallback(() => {
    setCollapsed(true);
  }, []);

  return { width, collapsed, handleRef, onMouseDown, expand, collapse };
}
