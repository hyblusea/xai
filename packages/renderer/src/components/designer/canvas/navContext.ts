import { createContext } from 'react';

export interface PageCardInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export interface DesignerNavApi {
  zoom: number;
  zoomPercent: number;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;          // 适应屏幕
  reset100: () => void;     // 实际大小 100%
  panTo: (x: number, y: number) => void;
  getPan: () => { x: number; y: number };
  getZoom: () => number;
  getContentBounds: () => { width: number; height: number } | null;
  getViewport: () => { width: number; height: number } | null;
  getPageCards: () => PageCardInfo[];
}

export const DesignerNavContext = createContext<DesignerNavApi | null>(null);
