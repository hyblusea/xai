import { Plus, Trash2, CircleDot } from 'lucide-react';
import { InlineTextEdit } from '../controls';

export function CarouselEditor({
  slides,
  hasIndicators,
  hasControls,
  onAddCarouselSlide,
  onRemoveCarouselSlide,
  onSetActiveCarouselSlide,
  onRenameCarouselSlide,
}: {
  slides: Array<{ id: string; caption: string; active: boolean }>;
  hasIndicators?: boolean;
  hasControls?: boolean;
  onAddCarouselSlide?: () => void;
  onRemoveCarouselSlide?: (index: number) => void;
  onSetActiveCarouselSlide?: (index: number) => void;
  onRenameCarouselSlide?: (index: number, caption: string) => void;
}) {
  return (
    <div className="designer-prop-collection">
      <div className="designer-prop-row">
        <span className="designer-prop-pill">指示器: {hasIndicators ? '开' : '关'}</span>
        <span className="designer-prop-pill">控制: {hasControls ? '开' : '关'}</span>
      </div>
      {slides.map((slide, index) => (
        <div key={slide.id} className="designer-prop-collection-item">
          <div className="designer-prop-collection-head">
            <span className={`designer-prop-pill ${slide.active ? 'active' : ''}`}>
              {slide.active ? '当前幻灯片' : `幻灯片 ${index + 1}`}
            </span>
            <div className="designer-prop-btn-group">
              {onSetActiveCarouselSlide && (
                <button
                  type="button"
                  className={`designer-prop-inline-btn ${slide.active ? 'active' : ''}`}
                  onClick={() => onSetActiveCarouselSlide(index)}
                  title="激活此幻灯片"
                >
                  <CircleDot size={12} />
                </button>
              )}
              <button
                type="button"
                className="designer-prop-inline-btn danger"
                onClick={() => onRemoveCarouselSlide?.(index)}
                title="删除幻灯片"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <InlineTextEdit
            value={slide.caption}
            onCommit={v => onRenameCarouselSlide?.(index, v)}
            placeholder="幻灯片说明"
          />
        </div>
      ))}
      <button type="button" className="designer-prop-btn" onClick={onAddCarouselSlide}>
        <Plus size={12} />
        新增幻灯片
      </button>
    </div>
  );
}
