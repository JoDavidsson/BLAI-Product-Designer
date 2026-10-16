import type { Annotation } from '../../shared/model';
import './annotations.css';

interface Props {
  comments: Annotation[];
  onSelect: (comment: Annotation) => void;
  selectedId?: string;
  onAdd?: (x: number, y: number) => void;
  adding?: boolean;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export default function AnnotationOverlay({
  comments,
  onSelect,
  selectedId,
  onAdd,
  adding = false,
}: Props) {
  return (
    <div
      className={`annotation-overlay ${adding ? 'is-adding' : ''}`}
      aria-label={
        adding
          ? 'Place a comment. Click a location, or press Enter to comment in the center.'
          : 'Pinned comments'
      }
      role={adding ? 'button' : undefined}
      tabIndex={adding ? 0 : undefined}
      onClick={(event) => {
        if (!adding || !onAdd) return;
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        onAdd(
          clamp((event.clientX - bounds.left) / bounds.width),
          clamp((event.clientY - bounds.top) / bounds.height),
        );
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          adding &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault();
          event.stopPropagation();
          onAdd?.(0.5, 0.5);
        }
      }}
    >
      <svg
        className="annotation-leaders"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {comments.map((comment) => {
          const x = clamp(comment.target.x) * 100,
            y = clamp(comment.target.y) * 100;
          const endX = x + (x > 58 ? -11 : 11);
          const endY = y + (y < 18 ? 8 : -8);
          return (
            <path
              key={comment.id}
              d={`M ${x} ${y} L ${endX} ${endY}`}
              className={selectedId === comment.id ? 'is-selected' : ''}
            />
          );
        })}
      </svg>
      {comments.map((comment, index) => {
        const x = clamp(comment.target.x) * 100,
          y = clamp(comment.target.y) * 100;
        const leftward = x > 58;
        return (
          <div
            className={`annotation-marker ${selectedId === comment.id ? 'is-selected' : ''} is-${comment.status}`}
            key={comment.id}
          >
            <button
              type="button"
              className="annotation-pin"
              style={{ left: `${x}%`, top: `${y}%` }}
              aria-label={`Comment ${index + 1}: ${comment.body}`}
              aria-pressed={selectedId === comment.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(comment);
              }}
            >
              {index + 1}
            </button>
            <button
              type="button"
              className={`annotation-label ${leftward ? 'is-left' : ''}`}
              style={{ left: `${x + (leftward ? -11 : 11)}%`, top: `${y + (y < 18 ? 8 : -8)}%` }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(comment);
              }}
              tabIndex={-1}
              aria-hidden="true"
            >
              {comment.body}
            </button>
          </div>
        );
      })}
    </div>
  );
}
