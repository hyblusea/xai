import { useState, useEffect, useCallback, useRef } from 'react';

export function useDraggable() {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartMouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStartOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.icon-button')) return;
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    dragStartOffset.current = { x: rect.left, y: rect.top };
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = 'none';
    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartMouse.current.x;
      const dy = e.clientY - dragStartMouse.current.y;
      setDragOffset({
        x: dragStartOffset.current.x + dx,
        y: dragStartOffset.current.y + dy,
      });
    };
    const handleMouseUp = () => {
      document.body.style.userSelect = '';
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return { panelRef, dragOffset, isDragging, handleHeaderMouseDown };
}
