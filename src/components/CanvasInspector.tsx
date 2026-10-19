import { useEffect, useState } from 'react';
import type {
  BoardAsset,
  DesignTokens,
  Screen,
  WireNode,
  NodeFrame,
  NodeStyle,
  ScreenState,
} from '../../shared/model';
import { frameFor, sceneIndex, type Alignment } from '../lib/freeform-geometry';

interface Props {
  screen: Screen;
  screens: Screen[];
  assets: BoardAsset[];
  design: DesignTokens;
  selectedIds: string[];
  onScreen: (changes: Partial<Screen>) => void;
  onNode: (id: string, changes: Partial<WireNode>) => void;
  onFrame: (id: string, changes: Partial<NodeFrame>) => void;
  onArrange: (action: 'front' | 'back' | 'forward' | 'backward') => void;
  onAlign: (alignment: Alignment) => void;
  onDistribute: (axis: 'horizontal' | 'vertical') => void;
  onGroup: () => void;
  onUngroup: () => void;
  onReparent: (parent: string) => void;
  onReflow: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDuplicateScreen: (state?: ScreenState) => void;
  onDeleteScreen: () => void;
}

function colorValue(value: string) {
  return /^#[0-9a-f]{3}$/i.test(value)
    ? '#' +
        value
          .slice(1)
          .split('')
          .map((part) => part + part)
          .join('')
    : value;
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  return (
    <label className="canvas-number">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (draft.trim() && Number.isFinite(next)) {
            const bounded = Math.min(max, Math.max(min, next));
            setDraft(String(value));
            if (bounded !== value) onChange(bounded);
          } else setDraft(String(value));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export default function CanvasInspector(props: Props) {
  const { screen, selectedIds, onNode, onScreen } = props;
  const index = sceneIndex(screen.nodes);
  const entries = selectedIds.flatMap((id) => (index.get(id) ? [index.get(id)!] : []));
  const selected = entries.length === 1 ? entries[0].node : undefined;
  const locked = entries.some((entry) => entry.locked);
  const frame = selected ? frameFor(selected) : undefined;
  const style = (changes: Partial<NodeStyle>) =>
    selected && onNode(selected.id, { style: { ...selected.style, ...changes } });
  const [variant, setVariant] = useState<ScreenState>('empty');
  const [screenName, setScreenName] = useState(screen.name);
  useEffect(() => setScreenName(screen.name), [screen.id, screen.name]);
  const descendants = new Set<string>();
  const collect = (node: WireNode) => {
    descendants.add(node.id);
    node.children.forEach(collect);
  };
  entries.forEach((entry) => collect(entry.node));
  return (
    <div className="wf-properties-scroll canvas-properties">
      <div className="wf-property-heading">
        <div>
          <strong>
            {selected?.name ||
              (entries.length ? `${entries.length} layers selected` : 'Screen settings')}
          </strong>
          <small>
            {selected?.type || (entries.length ? 'Freeform selection' : 'Freeform canvas')}
          </small>
        </div>
      </div>
      {entries.length > 0 ? (
        <>
          {locked && (
            <p className="wf-field-help">Unlock selected layers in the layer list to edit them.</p>
          )}
          <fieldset disabled={locked}>
            {selected && frame && (
              <>
                <label className="wf-property-field">
                  <span>Layer name</span>
                  <input
                    value={selected.name}
                    maxLength={160}
                    onChange={(event) => onNode(selected.id, { name: event.target.value })}
                  />
                </label>
                <section className="wf-property-section">
                  <h3>Geometry</h3>
                  {entries[0].layoutControlled && (
                    <p className="wf-field-help">
                      The parent layout controls X and Y. Change its layout to free positioning to
                      move this layer.
                    </p>
                  )}
                  {selected.type === 'group' && (
                    <p className="wf-field-help">
                      Group dimensions stay proportional when resized.
                    </p>
                  )}
                  <div className="canvas-number-grid">
                    {(['x', 'y', 'width', 'height', 'rotation'] as const).map((key) => (
                      <NumberField
                        key={key}
                        label={key === 'rotation' ? 'Rotation' : key.toUpperCase()}
                        value={frame[key]}
                        disabled={entries[0].layoutControlled && (key === 'x' || key === 'y')}
                        min={key === 'rotation' ? -360 : key === 'x' || key === 'y' ? -20000 : 1}
                        max={key === 'rotation' ? 360 : 20000}
                        onChange={(value) => props.onFrame(selected.id, { [key]: value })}
                      />
                    ))}
                  </div>
                </section>
                {!['group', 'rectangle', 'ellipse', 'line', 'path', 'divider', 'image'].includes(
                  selected.type,
                ) && (
                  <label className="wf-property-field">
                    <span>Text</span>
                    <textarea
                      rows={4}
                      value={selected.text}
                      maxLength={4000}
                      onChange={(event) => onNode(selected.id, { text: event.target.value })}
                    />
                  </label>
                )}
                <section className="wf-property-section">
                  <h3>Appearance</h3>
                  <div className="canvas-color-grid">
                    {(['background', 'color', 'stroke'] as const).map((key) => (
                      <label key={key}>
                        <span>
                          {key === 'background'
                            ? 'Fill'
                            : key === 'color'
                              ? 'Text color'
                              : 'Stroke'}
                        </span>
                        <input
                          aria-label={
                            key === 'background'
                              ? 'Fill color'
                              : key === 'color'
                                ? 'Text color'
                                : 'Stroke color'
                          }
                          type="color"
                          value={colorValue(
                            selected.style[key] ||
                              (key === 'background'
                                ? ['rectangle', 'ellipse', 'button'].includes(selected.type)
                                  ? props.design.accent
                                  : ['badge', 'image'].includes(selected.type)
                                    ? '#eef0f4'
                                    : props.design.surface
                                : key === 'color' && selected.type === 'button'
                                  ? '#ffffff'
                                  : props.design.text),
                          )}
                          onChange={(event) => style({ [key]: event.target.value })}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="canvas-number-grid">
                    <NumberField
                      label="Stroke width"
                      value={
                        selected.style.strokeWidth ??
                        (['line', 'path'].includes(selected.type)
                          ? 2
                          : selected.style.stroke || ['input', 'card'].includes(selected.type)
                            ? 1
                            : 0)
                      }
                      min={0}
                      max={32}
                      onChange={(strokeWidth) => style({ strokeWidth })}
                    />
                    <NumberField
                      label="Opacity"
                      value={selected.style.opacity ?? 1}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(opacity) => style({ opacity })}
                    />
                    <NumberField
                      label="Radius"
                      value={
                        selected.style.radius ??
                        (['button', 'input', 'card', 'badge'].includes(selected.type)
                          ? props.design.radius
                          : 0)
                      }
                      min={0}
                      max={64}
                      onChange={(radius) => style({ radius })}
                    />
                    <NumberField
                      label="Font size"
                      value={
                        selected.style.fontSize ??
                        (selected.type === 'heading'
                          ? 32
                          : selected.type === 'badge'
                            ? 12
                            : ['button', 'input', 'nav'].includes(selected.type)
                              ? 14
                              : 16)
                      }
                      min={8}
                      max={96}
                      onChange={(fontSize) => style({ fontSize })}
                    />
                  </div>
                  <label className="wf-property-field">
                    <span>Font weight</span>
                    <select
                      value={selected.style.fontWeight ?? (selected.type === 'heading' ? 700 : 400)}
                      onChange={(event) =>
                        style({ fontWeight: Number(event.target.value) as 400 | 500 | 600 | 700 })
                      }
                    >
                      {[400, 500, 600, 700].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wf-property-field">
                    <span>Text alignment</span>
                    <select
                      value={
                        selected.style.align ??
                        (['button', 'badge'].includes(selected.type) ? 'center' : 'start')
                      }
                      onChange={(event) =>
                        style({ align: event.target.value as 'start' | 'center' | 'end' })
                      }
                    >
                      <option value="start">Left</option>
                      <option value="center">Center</option>
                      <option value="end">Right</option>
                    </select>
                  </label>
                </section>
                {selected.type === 'image' && (
                  <section className="wf-property-section">
                    <h3>Image</h3>
                    <label className="wf-property-field">
                      <span>Project image</span>
                      <select
                        value={selected.image?.assetId ?? ''}
                        onChange={(event) =>
                          onNode(selected.id, {
                            image: event.target.value
                              ? { assetId: event.target.value, fit: selected.image?.fit ?? 'cover' }
                              : undefined,
                          })
                        }
                      >
                        <option value="">Placeholder</option>
                        {props.assets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wf-property-field">
                      <span>Image fit</span>
                      <select
                        value={selected.image?.fit ?? 'cover'}
                        disabled={!selected.image}
                        onChange={(event) =>
                          selected.image &&
                          onNode(selected.id, {
                            image: {
                              ...selected.image,
                              fit: event.target.value as 'cover' | 'contain',
                            },
                          })
                        }
                      >
                        <option value="cover">Fill and crop</option>
                        <option value="contain">Fit entire image</option>
                      </select>
                    </label>
                  </section>
                )}
                {selected.type === 'button' && (
                  <label className="wf-property-field">
                    <span>Destination screen</span>
                    <select
                      value={selected.action?.screenId ?? ''}
                      onChange={(event) =>
                        onNode(selected.id, {
                          action: event.target.value ? { screenId: event.target.value } : undefined,
                        })
                      }
                    >
                      <option value="">No destination</option>
                      {props.screens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {['group', 'section', 'row', 'column', 'card'].includes(selected.type) && (
                  <section className="wf-property-section">
                    <h3>Container layout</h3>
                    <label className="wf-property-field">
                      <span>Layout</span>
                      <select
                        value={selected.layout ?? 'free'}
                        onChange={(event) =>
                          onNode(selected.id, {
                            layout: event.target.value as 'free' | 'row' | 'column',
                          })
                        }
                      >
                        <option value="free">Free positioning</option>
                        <option value="row">Horizontal row</option>
                        <option value="column">Vertical column</option>
                      </select>
                    </label>
                    <div className="canvas-number-grid">
                      <NumberField
                        label="Padding"
                        value={selected.style.padding ?? 16}
                        min={0}
                        max={80}
                        onChange={(padding) => style({ padding })}
                      />
                      <NumberField
                        label="Gap"
                        value={selected.style.gap ?? 16}
                        min={0}
                        max={64}
                        onChange={(gap) => style({ gap })}
                      />
                    </div>
                    <button
                      className="wf-button"
                      disabled={!selected.layout || selected.layout === 'free'}
                      onClick={props.onReflow}
                    >
                      Apply layout to children
                    </button>
                    <p className="wf-field-help">
                      Row and column layouts keep children arranged as you edit. Choose free
                      positioning to move children independently.
                    </p>
                  </section>
                )}
              </>
            )}
            <section className="wf-property-section">
              <h3>Arrange</h3>
              <div className="canvas-action-grid">
                <button onClick={props.onGroup} disabled={entries.length < 2}>
                  Group
                </button>
                <button
                  onClick={props.onUngroup}
                  disabled={!entries.some((entry) => entry.node.type === 'group')}
                >
                  Ungroup
                </button>
                {(['front', 'back', 'forward', 'backward'] as const).map((action) => (
                  <button key={action} onClick={() => props.onArrange(action)}>
                    {
                      {
                        front: 'Bring to front',
                        back: 'Send to back',
                        forward: 'Bring forward',
                        backward: 'Send backward',
                      }[action]
                    }
                  </button>
                ))}
              </div>
              <label className="wf-property-field">
                <span>Parent layer</span>
                <select
                  value={
                    entries.every((entry) => entry.parentId === entries[0]?.parentId)
                      ? (entries[0]?.parentId ?? '')
                      : '__mixed'
                  }
                  onChange={(event) => props.onReparent(event.target.value)}
                >
                  <option value="">Screen</option>
                  <option value="__mixed" disabled>
                    Multiple parents
                  </option>
                  {[...index.values()]
                    .filter(
                      (entry) =>
                        !descendants.has(entry.node.id) &&
                        !entry.locked &&
                        ['group', 'section', 'row', 'column', 'card'].includes(entry.node.type),
                    )
                    .map((entry) => (
                      <option key={entry.node.id} value={entry.node.id}>
                        {entry.node.name}
                      </option>
                    ))}
                </select>
              </label>
              {entries.length > 1 && (
                <>
                  <div className="canvas-action-grid">
                    {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map(
                      (alignment) => (
                        <button key={alignment} onClick={() => props.onAlign(alignment)}>
                          Align {alignment}
                        </button>
                      ),
                    )}
                  </div>
                  <div className="canvas-action-grid">
                    <button
                      disabled={entries.length < 3}
                      onClick={() => props.onDistribute('horizontal')}
                    >
                      Space horizontally
                    </button>
                    <button
                      disabled={entries.length < 3}
                      onClick={() => props.onDistribute('vertical')}
                    >
                      Space vertically
                    </button>
                  </div>
                </>
              )}
            </section>
            <div className="canvas-action-grid">
              <button onClick={props.onDuplicate}>Duplicate</button>
              <button className="wf-danger-text" onClick={props.onDelete}>
                Delete
              </button>
            </div>
          </fieldset>
        </>
      ) : (
        <>
          <label className="wf-property-field">
            <span>Screen name</span>
            <input
              value={screenName}
              maxLength={160}
              onChange={(event) => setScreenName(event.target.value)}
              onBlur={() => {
                if (screenName.trim()) onScreen({ name: screenName.trim() });
                else setScreenName(screen.name);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </label>
          <label className="wf-property-field">
            <span>Purpose</span>
            <textarea
              value={screen.description}
              maxLength={4000}
              onChange={(event) => onScreen({ description: event.target.value })}
            />
          </label>
          <section className="wf-property-section">
            <h3>Frame</h3>
            <div className="canvas-number-grid">
              <NumberField
                label="Frame width"
                value={screen.canvas!.width}
                min={100}
                max={10000}
                onChange={(width) => onScreen({ canvas: { ...screen.canvas!, width } })}
              />
              <NumberField
                label="Frame height"
                value={screen.canvas!.height}
                min={100}
                max={10000}
                onChange={(height) => onScreen({ canvas: { ...screen.canvas!, height } })}
              />
            </div>
            <label className="wf-property-field">
              <span>Platform</span>
              <select
                value={screen.platform}
                onChange={(event) =>
                  onScreen({ platform: event.target.value as 'desktop' | 'mobile' })
                }
              >
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <label className="wf-property-field">
              <span>Screen state</span>
              <select
                value={screen.state}
                onChange={(event) => onScreen({ state: event.target.value as ScreenState })}
              >
                {['default', 'loading', 'empty', 'error', 'success'].map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            </label>
          </section>
          <section className="wf-property-section">
            <h3>State variant</h3>
            <div className="wf-variant-create">
              <select
                aria-label="New state variant"
                value={variant}
                onChange={(event) => setVariant(event.target.value as ScreenState)}
              >
                {['loading', 'empty', 'error', 'success'].map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
              <button
                aria-label="Create state variant"
                onClick={() => props.onDuplicateScreen(variant)}
              >
                Create
              </button>
            </div>
          </section>
          <div className="canvas-action-grid">
            <button onClick={() => props.onDuplicateScreen()}>Duplicate screen</button>
            <button className="wf-danger-text" onClick={props.onDeleteScreen}>
              Delete screen
            </button>
          </div>
          <p className="wf-field-help">
            Draw on the canvas, or select a layer to edit its position, size, and appearance.
            Shift-click adds to your selection.
          </p>
        </>
      )}
    </div>
  );
}
