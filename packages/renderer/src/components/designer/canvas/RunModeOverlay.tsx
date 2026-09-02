import { Play, Square, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DesignerScreen } from '@xai/shared';

interface RunModeOverlayProps {
  screen: DesignerScreen | undefined;
  hasMultipleScreens: boolean;
  currentScreenIndex: number;
  screensLength: number;
  deviceClass: string;
  iframeKey: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  /** Ref callback to capture the run-mode iframe. */
  runIframeRef: (el: HTMLIFrameElement | null) => void;
  onLoad: () => void;
  onClose: () => void;
}

/** Full-screen interactive run-mode preview overlay with page navigation. */
export default function RunModeOverlay({
  screen,
  hasMultipleScreens,
  currentScreenIndex,
  screensLength,
  deviceClass,
  iframeKey,
  onPrevPage,
  onNextPage,
  runIframeRef,
  onLoad,
  onClose,
}: RunModeOverlayProps) {
  if (!screen) return null;

  return (
    <div className="designer-run-overlay">
      <div className="designer-run-toolbar">
        <div className="designer-run-toolbar-left">
          <Play size={14} />
          <span className="designer-run-title">{screen.name}</span>
        </div>
        <div className="designer-run-toolbar-center">
          {hasMultipleScreens && (
            <>
              <button
                className="designer-device-btn"
                onClick={onPrevPage}
                disabled={currentScreenIndex <= 0}
                title="上一页"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="designer-page-indicator">
                {currentScreenIndex >= 0 ? currentScreenIndex + 1 : 1} / {screensLength}
              </span>
              <button
                className="designer-device-btn"
                onClick={onNextPage}
                disabled={currentScreenIndex >= screensLength - 1}
                title="下一页"
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
        </div>
        <div className="designer-run-toolbar-right">
          <button
            className="designer-toolbar-btn"
            onClick={onClose}
            title="退出运行"
          >
            <Square size={12} />
            停止
          </button>
          <button
            className="designer-device-btn"
            onClick={onClose}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className={`designer-run-viewport ${deviceClass}`}>
        <iframe
          key={`run-${iframeKey}`}
          ref={runIframeRef}
          className="designer-run-iframe"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          title="Run Preview"
          srcDoc={screen.html || ''}
          onLoad={onLoad}
        />
      </div>
    </div>
  );
}
