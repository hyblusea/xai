/**
 * Aggregated types for the properties panel — groups the original 30+ flat
 * Props callbacks into domain-specific `ops` objects so each editor only
 * declares the ops it needs (improving type safety and reducing prop drilling).
 *
 * The main ElementPropertiesPanel keeps its original flat Props signature
 * for backward compatibility with DesignerCanvas; it internally builds the
 * ops objects from those flat props and passes them to the editors/registry.
 */
import type { ReactNode } from 'react';
import type { SelectedElement, ElementStyle, DesignerScreen } from '@xai/shared';

/** Style operations (always available). */
export interface StyleOps {
  onStyleChange: (style: Partial<ElementStyle>) => void;
}

/**
 * Table editor operations. All fields optional — the main panel aggregates
 * them from the optional flat Props, so individual callbacks may be absent
 * even when a table context is active. The registry renders the section
 * based on `domState.hasTableContext`, not on ops presence.
 */
export interface TableOps {
  onAddTableRow?: () => void;
  onAddTableColumn?: () => void;
  onRemoveTableRow?: () => void;
  onRemoveTableColumn?: () => void;
  onCopyTableRow?: () => void;
  onCopyTableColumn?: () => void;
  onTableColumnWidthChange?: (width: string) => void;
  onToggleTableStriped?: (enabled: boolean) => void;
  onMergeTableCell?: (direction: 'right' | 'down') => void;
  onToggleTableStickyColumn?: (side: 'left' | 'right', enabled: boolean) => void;
}

/**
 * Tabs editor operations. Fields optional (aggregated from optional Props);
 * the section renders based on `domState.tabItems`.
 */
export interface TabsOps {
  onAddTab?: () => void;
  onRemoveTab?: (index: number) => void;
  onRenameTab?: (index: number, label: string) => void;
  onSetActiveTab?: (index: number) => void;
}

/** Accordion editor operations. Fields optional (see TableOps rationale). */
export interface AccordionOps {
  onAddAccordion?: () => void;
  onRemoveAccordion?: (index: number) => void;
  onRenameAccordion?: (index: number, header: string) => void;
  onToggleAccordion?: (index: number) => void;
}

/** Carousel editor operations. Fields optional (see TableOps rationale). */
export interface CarouselOps {
  onAddCarouselSlide?: () => void;
  onRemoveCarouselSlide?: (index: number) => void;
  onSetActiveCarouselSlide?: (index: number) => void;
  onRenameCarouselSlide?: (index: number, caption: string) => void;
}

/** Select options editor operations. */
export interface SelectOptionsOps {
  onChange: (options: Array<{ label: string; value: string; selected: boolean }>) => void;
}

/** Progress editor operations. */
export interface ProgressOps {
  onUpdate: (updates: { value?: number; label?: string; striped?: boolean; animated?: boolean; variant?: string }) => void;
}

/** Badge editor operations. */
export interface BadgeOps {
  onUpdate: (updates: { text?: string; variant?: string; pill?: boolean }) => void;
}

/** Dialog editor operations. */
export interface DialogOps {
  onUpdate: (updates: { title?: string; sizeClass?: string }) => void;
}

/** Button editor operations. */
export interface ButtonOps {
  onUpdate: (updates: { variant?: string; size?: string; pill?: boolean; block?: boolean; disabled?: boolean }) => void;
}

/** All available ops, grouped by domain. Each is optional except style. */
export interface EditorOps {
  style: StyleOps;
  table?: TableOps;
  tabs?: TabsOps;
  accordion?: AccordionOps;
  carousel?: CarouselOps;
  selectOptions?: SelectOptionsOps;
  progress?: ProgressOps;
  badge?: BadgeOps;
  dialog?: DialogOps;
  button?: ButtonOps;
}

/** DOM-derived state for the selected element (table context, tabs, etc.). */
export interface EditorDomState {
  selectOptions?: Array<{ label: string; value: string; selected: boolean }>;
  tableColumnWidth?: string;
  hasTableContext?: boolean;
  tableStickyLeft?: boolean;
  tableStickyRight?: boolean;
  tableStriped?: boolean;
  tabItems?: Array<{ id: string; label: string; active: boolean }>;
  accordionItems?: Array<{ id: string; header: string; active: boolean }>;
  carouselSlides?: Array<{ id: string; caption: string; active: boolean }>;
  carouselHasIndicators?: boolean;
  carouselHasControls?: boolean;
  progressData?: { value: number; label: string; striped: boolean; animated: boolean; variant: string } | null;
  badgeData?: { text: string; variant: string; pill: boolean } | null;
  dialogData?: { title: string; sizeClass: string } | null;
  buttonData?: { variant: string; size: string; pill: boolean; block: boolean; disabled: boolean } | null;
}

/** Full context passed to every registered editor. */
export interface EditorContext {
  element: SelectedElement;
  ops: EditorOps;
  domState: EditorDomState;
  screens: DesignerScreen[];
}

/**
 * Registry entry for a structural editor. Each editor decides whether it
 * applies to the current element via `match`, then renders its section via
 * `render`. The main panel iterates the registry in order.
 *
 * Editors are pure — no side effects, no state beyond their own UI.
 */
export interface EditorDef {
  /** Unique id for keying and debugging. */
  id: string;
  /** Returns true if this editor should render for the current element. */
  match: (ctx: EditorContext) => boolean;
  /** Renders the editor section (including the outer section wrapper). */
  render: (ctx: EditorContext) => ReactNode;
}
