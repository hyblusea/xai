import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * DesignerDock — 设计器停靠栏
 *
 * 功能：
 *  - 在画布左侧或右侧提供一个固定宽度的停靠区域
 *  - 支持多个面板横向并列显示（每个面板占据一列）
 *  - tab 条可切换每个面板的开/关
 *  - 拖拽手柄可调整整个 Dock 的宽度
 *  - 当打开的面板数量增加时，Dock 宽度自动扩展以容纳新面板
 *
 * 面板的开/关状态由父组件控制（受控），Dock 仅负责布局呈现。
 */
export type DockPanelId = 'components' | 'layers' | 'properties' | 'master-layers' | 'master-properties';

export interface DockPanelDescriptor {
  id: DockPanelId;
  /** 面板标题（tab 条 tooltip 用） */
  title: string;
  /** tab 条显示的图标 */
  icon: ReactNode;
  /** 面板是否可用（不可用时 tab 禁用、面板不会渲染）。例如图层/属性仅在编辑模式下可用 */
  available: boolean;
  /** 面板是否处于展开状态 */
  open: boolean;
  /** 切换面板开/关 */
  onToggle: () => void;
  /** 面板内容（仅在 open && available 时挂载） */
  children: ReactNode;
}

interface DesignerDockProps {
  panels: DockPanelDescriptor[];
  /** Dock 位于画布的哪一侧。右侧为默认，左侧用于母版编辑器等场景 */
  side?: 'left' | 'right';
  /** Dock 初始宽度（px） */
  defaultWidth?: number;
  /** Dock 最小宽度（px） */
  minWidth?: number;
  /** Dock 最大宽度（px） */
  maxWidth?: number;
  /** 单个面板期望宽度（px），用于计算多面板展开时的总宽度 */
  panelUnitWidth?: number;
}

/** 为 collapsed 状态生成 tab 条 JSX（left / right 通用，避免重复） */
function TabStrip({ panels }: { panels: DockPanelDescriptor[] }) {
  return (
    <div className="designer-dock-tabstrip">
      {panels.map(panel => {
        const cls = [
          'designer-dock-tab',
          panel.open && panel.available ? ' active' : '',
          !panel.available ? ' disabled' : '',
        ].join('');
        return (
          <button
            key={panel.id}
            className={cls}
            onClick={() => panel.available && panel.onToggle()}
            disabled={!panel.available}
            title={panel.title}
            type="button"
          >
            <span className="designer-dock-tab-icon">{panel.icon}</span>
            <span className="designer-dock-tab-label">{panel.title}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function DesignerDock({
  panels,
  side = 'right',
  defaultWidth = 300,
  minWidth = 240,
  maxWidth = 960,
  panelUnitWidth = 300,
}: DesignerDockProps) {
  const [width, setWidth] = useState(defaultWidth);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const openPanels = panels.filter(p => p.available && p.open);
  const anyAvailable = panels.some(p => p.available);
  const collapsed = openPanels.length === 0;
  const isLeft = side === 'left';

  // 面板数量变化时，Dock 宽度自动贴合
  useEffect(() => {
    if (openPanels.length === 0) {
      setWidth(0);
      return;
    }
    const desired = openPanels.length * panelUnitWidth;
    setWidth(Math.max(minWidth, Math.min(maxWidth, desired)));
  }, [openPanels.length, panelUnitWidth, minWidth, maxWidth]);

  // 全局监听拖拽事件，调整 Dock 宽度
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      // left: 向右拖拽 → 宽度增加; right: 向左拖拽 → 宽度增加
      const dx = isLeft
        ? e.clientX - startXRef.current
        : startXRef.current - e.clientX;
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + dx));
      setWidth(next);
    };
    const handleUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [minWidth, maxWidth, isLeft]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  if (!anyAvailable) return null;

  // 全部面板关闭时，Dock 收起为仅 tab 条
  if (collapsed) {
    return (
      <div className={`designer-dock designer-dock--collapsed${isLeft ? ' designer-dock--left' : ''}`}>
        <TabStrip panels={panels} />
      </div>
    );
  }

  // 左侧 Dock：tab 条 | 面板主体 | 拖拽手柄
  if (isLeft) {
    return (
      <div className="designer-dock designer-dock--left" style={{ width }}>
        <TabStrip panels={panels} />
        <div className="designer-dock-body">
          {openPanels.map(panel => (
            <div key={panel.id} className="designer-dock-panel">
              {panel.children}
            </div>
          ))}
        </div>
        <div
          className="designer-dock-resize-handle"
          onMouseDown={handleResizeStart}
          title="拖拽调整宽度"
        />
      </div>
    );
  }

  // 右侧 Dock（默认）：拖拽手柄 | 面板主体 | tab 条
  return (
    <div className="designer-dock" style={{ width }}>
      <div
        className="designer-dock-resize-handle"
        onMouseDown={handleResizeStart}
        title="拖拽调整宽度"
      />
      <div className="designer-dock-body">
        {openPanels.map(panel => (
          <div key={panel.id} className="designer-dock-panel">
            {panel.children}
          </div>
        ))}
      </div>
      <TabStrip panels={panels} />
    </div>
  );
}