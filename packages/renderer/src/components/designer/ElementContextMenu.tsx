import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Trash2, MessageSquarePlus, ArrowUp, ArrowDown } from 'lucide-react';

interface ElementContextMenuProps {
  /** The currently selected element's selector (for actions). */
  selector: string | null;
  /** Called when user picks "duplicate". */
  onDuplicate: (selector: string) => void;
  /** Called when user picks "delete". */
  onDelete: (selector: string) => void;
  /** Called when user picks "add to chat". */
  onAddToChat: () => void;
  /** Called when user picks "bring forward" (move up in DOM). */
  onBringForward: (selector: string) => void;
  /** Called when user picks "send backward" (move down in DOM). */
  onSendBackward: (selector: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  selector: string;
}

/**
 * Floating context menu for elements in the designer canvas.
 * Listens for `designer-context-menu` custom events dispatched from
 * inside iframe documents.
 */
export default function ElementContextMenu({
  selector,
  onDuplicate,
  onDelete,
  onAddToChat,
  onBringForward,
  onSendBackward,
}: ElementContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Listen for context menu requests from iframes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { x: number; y: number; selector?: string };
      if (detail && selector) {
        setMenu({ x: detail.x, y: detail.y, selector });
      }
    };
    window.addEventListener('designer-context-menu', handler);
    return () => window.removeEventListener('designer-context-menu', handler);
  }, [selector]);

  // Close on outside click
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu]);

  const close = useCallback(() => setMenu(null), []);

  if (!menu || !selector) return null;

  // Boundary detection
  const left = Math.min(menu.x, window.innerWidth - 180);
  const top = Math.min(menu.y, window.innerHeight - 220);

  const items = [
    { icon: Copy, label: '复制元素', action: () => { onDuplicate(selector); close(); } },
    { icon: ArrowUp, label: '上移一层', action: () => { onBringForward(selector); close(); } },
    { icon: ArrowDown, label: '下移一层', action: () => { onSendBackward(selector); close(); } },
    { icon: MessageSquarePlus, label: '添加到对话', action: () => { onAddToChat(); close(); } },
    { icon: Trash2, label: '删除元素', danger: true, action: () => { onDelete(selector); close(); } },
  ];

  return createPortal(
    <div ref={menuRef} className="designer-context-menu" style={{ left, top }}>
      {items.map((item, i) => (
        <div
          key={i}
          className={`designer-context-item ${item.danger ? 'danger' : ''}`}
          onClick={item.action}
        >
          <item.icon size={12} />
          {item.label}
        </div>
      ))}
    </div>,
    document.body,
  );
}
