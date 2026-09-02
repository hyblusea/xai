import { useRef, useLayoutEffect } from 'react';
import type { CursorState, CursorDomHandles } from '../../../hooks/useDesignerCursor';
import { CURSOR_W, CURSOR_H } from '../../../hooks/useDesignerCursor';

interface DesignerCursorProps {
  cursorState: CursorState;
  active: boolean;
  /** 挂载时填充 DOM 句柄，供 useDesignerCursor 命令式直写（绕过 React 渲染）。 */
  domRef: React.MutableRefObject<CursorDomHandles | null>;
}

/**
 * Google-Stitch 风格虚拟光标组件。
 * 纸飞机 + 渐进式画框,反向缩放 scale(1/zoom) 抵消画布 zoom,尺寸恒定。
 *
 * 性能要点：本组件只渲染【一次静态 DOM 骨架】。位置、画框坐标/进度等高频
 * 数据由 useDesignerCursor 通过 domRef 命令式直写（每帧 60fps 不再触发
 * React 渲染）。JSX 里所有被直写的属性/样式都是常量 —— React diff 发现值
 * 不变就不会写 DOM，因此不会覆盖命令式写入的结果。React 只负责低频的
 * cursorState 相关样式（idle 过渡 transition、画框淡出 opacity）。
 */
export default function DesignerCursor({
  cursorState,
  active,
  domRef,
}: DesignerCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fillRectRef = useRef<SVGRectElement>(null);
  const strokeRectRef = useRef<SVGRectElement>(null);
  const glowRectRef = useRef<SVGRectElement>(null);

  // 挂载后把 DOM 句柄交给 hook；卸载/停用时置空（hook 的写入自动变 no-op）
  useLayoutEffect(() => {
    if (!active) {
      domRef.current = null;
      return;
    }
    if (cursorRef.current && boxRef.current && svgRef.current &&
        fillRectRef.current && strokeRectRef.current && glowRectRef.current) {
      domRef.current = {
        cursor: cursorRef.current,
        box: boxRef.current,
        svg: svgRef.current,
        fillRect: fillRectRef.current,
        strokeRect: strokeRectRef.current,
        glowRect: glowRectRef.current,
      };
    }
    return () => { domRef.current = null; };
  }, [active, domRef]);

  if (!active) return null;

  const isFading = cursorState !== 'drawing';
  // idle/resting 时用 CSS transition 驱动平滑移动,moving/drawing 时禁用
  const isIdleMoving = cursorState === 'idle' || cursorState === 'resting';
  // 画框描边的淡出过渡（低频：仅 cursorState 切换时由 React 更新）
  const fadingStyle = {
    transition: isFading ? 'stroke-dashoffset 0.35s ease-out, opacity 0.3s ease-out' : 'none',
    opacity: isFading ? 0 : 1,
  } as const;

  return (
    <div className="designer-cursor-overlay" aria-hidden>
      {/* 渐进式画框：常驻 DOM，display/transform/尺寸由 hook 直写 */}
      <div
        ref={boxRef}
        className="designer-draw-box-container"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'none',
          transform: 'translate(0px, 0px)',
          width: '0px',
          height: '0px',
          pointerEvents: 'none',
        }}
      >
        <svg
          ref={svgRef}
          width={0}
          height={0}
          viewBox="0 0 0 0"
          style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
        >
          {/* 半透明填充 */}
          <rect
            ref={fillRectRef}
            x={0.5}
            y={0.5}
            width={0}
            height={0}
            rx={6}
            ry={6}
            fill="rgba(59, 130, 246, 0.06)"
          />
          {/* 渐进式描边:pathLength="1" 让浏览器归一化路径长度,dashoffset 由 hook 直写 */}
          <rect
            ref={strokeRectRef}
            x={0.5}
            y={0.5}
            width={0}
            height={0}
            rx={6}
            ry={6}
            fill="none"
            stroke="#3B82F6"
            strokeWidth={1}
            strokeDasharray="1"
            strokeDashoffset="1"
            strokeLinecap="round"
            pathLength="1"
            style={fadingStyle}
          />
          {/* 发光层:跟随绘制进度 */}
          <rect
            ref={glowRectRef}
            x={0.5}
            y={0.5}
            width={0}
            height={0}
            rx={6}
            ry={6}
            fill="none"
            stroke="rgba(59, 130, 246, 0.35)"
            strokeWidth={7}
            strokeDasharray="1"
            strokeDashoffset="1"
            strokeLinecap="round"
            pathLength="1"
            style={{ filter: 'blur(4px)', ...fadingStyle }}
          />
        </svg>
      </div>

      {/* 光标：transform 由 hook 直写（含 1/zoom 反向缩放） */}
      <div
        ref={cursorRef}
        className={`designer-cursor state-${cursorState}`}
        style={{
          transform: 'translate(0px, 0px) scale(1)',
          transformOrigin: '0 0',
          width: `${CURSOR_W}px`,
          height: `${CURSOR_H}px`,
          transition: isIdleMoving
            ? 'transform 8s cubic-bezier(0.22, 0.61, 0.36, 1)'
            : 'none',
        }}
      >
        <svg
          width={CURSOR_W}
          height={CURSOR_H}
          viewBox="0 0 1322 960"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="planeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>

          <g transform="translate(0, 90) rotate(145, 327, 426)">
            <polygon
              points="327 268, 436 382, 327 585"
              fill="url(#planeGradient)"
              stroke="#FFFFFF"
              strokeWidth="8"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <polygon
              points="327 268, 218 382, 327 585"
              fill="url(#planeGradient)"
              stroke="#FFFFFF"
              strokeWidth="8"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        </svg>
      </div>
    </div>
  );
}
