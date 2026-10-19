import { Eye, EyeOff, Lock, Unlock } from 'lucide-react';
import type { WireNode } from '../../shared/model';

interface Props {
  nodes: WireNode[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onChange: (id: string, changes: Partial<WireNode>) => void;
  depth?: number;
  inheritedLocked?: boolean;
  inheritedHidden?: boolean;
}

export default function CanvasLayers({
  nodes,
  selectedIds,
  onSelect,
  onChange,
  depth = 0,
  inheritedLocked = false,
  inheritedHidden = false,
}: Props) {
  return (
    <>
      {[...nodes].reverse().map((node) => {
        const locked = inheritedLocked || !!node.locked;
        const hidden = inheritedHidden || !!node.hidden;
        return (
          <div key={node.id}>
            <div
              className={`canvas-layer${selectedIds.includes(node.id) ? ' selected' : ''}${hidden ? ' hidden-layer' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <button
                className="canvas-layer-name"
                aria-pressed={selectedIds.includes(node.id)}
                onClick={(event) =>
                  onSelect(
                    event.shiftKey || event.ctrlKey || event.metaKey
                      ? selectedIds.includes(node.id)
                        ? selectedIds.filter((id) => id !== node.id)
                        : [...selectedIds, node.id]
                      : [node.id],
                  )
                }
                title={`${node.name} (${node.type})`}
              >
                <span className="canvas-layer-kind">{node.type === 'group' ? '▧' : '◇'}</span>
                <span>{node.name}</span>
              </button>
              <button
                aria-label={`${node.hidden ? 'Show' : 'Hide'} ${node.name}`}
                disabled={inheritedHidden}
                onClick={() => onChange(node.id, { hidden: !node.hidden })}
                title={inheritedHidden ? 'Parent layer is hidden' : undefined}
              >
                {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                aria-label={`${node.locked ? 'Unlock' : 'Lock'} ${node.name}`}
                disabled={inheritedLocked}
                onClick={() => onChange(node.id, { locked: !node.locked })}
                title={inheritedLocked ? 'Parent layer is locked' : undefined}
              >
                {locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
            <CanvasLayers
              nodes={node.children}
              selectedIds={selectedIds}
              onSelect={onSelect}
              onChange={onChange}
              depth={depth + 1}
              inheritedLocked={locked}
              inheritedHidden={hidden}
            />
          </div>
        );
      })}
    </>
  );
}
