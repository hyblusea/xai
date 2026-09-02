/**
 * Editor for <select> element options. Lets users add/remove/reorder options
 * and mark which one is selected by default.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';

export type SelectOption = { label: string; value: string; selected: boolean };
type LocalSelectOption = SelectOption & { _uid: string };

export function SelectOptionsEditor({
  options,
  onChange,
}: {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
}) {
  // 稳定 key 计数器与 value 计数器
  const uidRef = useRef(0);
  const counterRef = useRef(0);
  const makeUid = useCallback(() => `opt-${++uidRef.current}`, []);

  const [localOptions, setLocalOptions] = useState<LocalSelectOption[]>(() => {
    let max = 0;
    const mapped = options.map(o => {
      const m = /^option-(\d+)$/.exec(o.value);
      if (m) max = Math.max(max, parseInt(m[1], 10));
      return { ...o, _uid: makeUid() };
    });
    counterRef.current = max;
    return mapped;
  });
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) {
      // 同步外部变更，尽量复用已有 _uid（按 label+value 匹配）
      setLocalOptions(prev => {
        const used = new Set<string>();
        return options.map(o => {
          const match = prev.find(p =>
            p.label === o.label && p.value === o.value && p.selected === o.selected && !used.has(p._uid)
          );
          const uid = match ? match._uid : makeUid();
          used.add(uid);
          return { ...o, _uid: uid };
        });
      });
    }
  }, [options, makeUid]);

  const commit = useCallback((next: LocalSelectOption[]) => {
    setLocalOptions(next);
    onChange(next.map(({ _uid, ...rest }) => rest));
  }, [onChange]);

  const handleFieldChange = useCallback((uid: string, key: 'label' | 'value', val: string) => {
    setLocalOptions(prev => prev.map(item => item._uid === uid ? { ...item, [key]: val } : item));
  }, []);

  const handleFieldBlur = useCallback(() => {
    onChange(localOptions.map(({ _uid, ...rest }) => rest));
  }, [localOptions, onChange]);

  const handleSelect = useCallback((uid: string) => {
    commit(localOptions.map(item => ({ ...item, selected: item._uid === uid })));
  }, [commit, localOptions]);

  const handleAdd = useCallback(() => {
    const next: LocalSelectOption[] = [...localOptions, {
      label: `选项 ${localOptions.length + 1}`,
      value: `option-${++counterRef.current}`,
      selected: localOptions.length === 0,
      _uid: makeUid(),
    }];
    commit(next);
  }, [commit, localOptions, makeUid]);

  const handleRemove = useCallback((uid: string) => {
    const next = localOptions.filter(item => item._uid !== uid);
    if (next.length > 0 && !next.some(item => item.selected)) {
      next[0] = { ...next[0], selected: true };
    }
    commit(next);
  }, [commit, localOptions]);

  return (
    <div className="designer-prop-collection">
      {localOptions.map(option => (
        <div key={option._uid} className="designer-prop-collection-item">
          <div className="designer-prop-collection-head">
            <label className="designer-prop-check">
              <input
                type="radio"
                checked={option.selected}
                onChange={() => handleSelect(option._uid)}
              />
              默认
            </label>
            <div className="designer-prop-btn-group">
              <button
                type="button"
                className="designer-prop-inline-btn danger"
                onClick={() => handleRemove(option._uid)}
                title="删除选项"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <div className="designer-prop-row">
            <div className="designer-prop-field">
              <label className="designer-prop-label">文本</label>
              <input
                type="text"
                className="designer-prop-input"
                value={option.label}
                onChange={e => handleFieldChange(option._uid, 'label', e.target.value)}
                onFocus={() => { isEditingRef.current = true; }}
                onBlur={() => { isEditingRef.current = false; handleFieldBlur(); }}
              />
            </div>
            <div className="designer-prop-field">
              <label className="designer-prop-label">值</label>
              <input
                type="text"
                className="designer-prop-input"
                value={option.value}
                onChange={e => handleFieldChange(option._uid, 'value', e.target.value)}
                onFocus={() => { isEditingRef.current = true; }}
                onBlur={() => { isEditingRef.current = false; handleFieldBlur(); }}
              />
            </div>
          </div>
        </div>
      ))}
      <button type="button" className="designer-prop-btn" onClick={handleAdd}>
        <Plus size={12} />
        新增选项
      </button>
    </div>
  );
}
