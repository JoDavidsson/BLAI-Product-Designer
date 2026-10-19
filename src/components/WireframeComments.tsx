import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Check, CheckCheck, MessageCircle } from 'lucide-react';
import type { Annotation } from '../../shared/model';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
export const COMMENT_MARGIN_WIDTH = 280;
export const COMMENT_MARGIN_GAP = 48;

interface SharedProps {
  comments: Annotation[];
  selectedId?: string;
  onSelect: (comment: Annotation) => void;
}

/** Pins live in each target's coordinate space; text stays outside the artboard. */
export function WireframeCommentPins({
  comments,
  allComments,
  selectedId,
  onSelect,
}: SharedProps & { allComments: Annotation[] }) {
  return (
    <div className="wf-comment-pins" aria-label="Pinned comments">
      {comments.map((comment) => (
        <button
          key={comment.id}
          type="button"
          className={`wf-comment-pin${selectedId === comment.id ? ' is-selected' : ''}`}
          data-comment-id={comment.id}
          style={{
            left: `${clamp(comment.target.x) * 100}%`,
            top: `${clamp(comment.target.y) * 100}%`,
          }}
          aria-label={`Comment ${allComments.findIndex((item) => item.id === comment.id) + 1}: ${comment.body}`}
          aria-pressed={selectedId === comment.id}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(comment);
          }}
        >
          {allComments.findIndex((item) => item.id === comment.id) + 1}
        </button>
      ))}
    </div>
  );
}

interface Placement {
  id: string;
  x: number;
  y: number;
  top: number;
  height: number;
}
interface Layout {
  items: Placement[];
  marginLeft: number;
  height: number;
}

/** Measure rendered geometry, including CSS zoom, without changing saved anchors. */
export default function WireframeCommentMargin({
  comments,
  selectedId,
  onSelect,
  onResolve,
  frameRef,
  artboardRef,
  zoom,
}: SharedProps & {
  onResolve: (comment: Annotation) => void;
  frameRef: RefObject<HTMLDivElement | null>;
  artboardRef: RefObject<HTMLDivElement | null>;
  zoom: number;
}) {
  const marginRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout>({ items: [], marginLeft: 0, height: 80 });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const artboard = artboardRef.current;
    const margin = marginRef.current;
    if (!frame || !artboard || !margin) return;
    let pending = 0;
    let disposed = false;
    const measure = () => {
      pending = 0;
      if (disposed) return;
      const origin = frame.getBoundingClientRect();
      const marginBounds = margin.getBoundingClientRect();
      const nodes = new Map(
        [...artboard.querySelectorAll<HTMLElement>('[data-node-id]')].map((node) => [
          node.dataset.nodeId,
          node,
        ]),
      );
      const cards = new Map(
        [...margin.querySelectorAll<HTMLElement>('[data-comment-card]')].map((card) => [
          card.dataset.commentCard,
          card,
        ]),
      );
      const anchors = comments
        .flatMap((comment) => {
          const target =
            comment.target.kind === 'node' ? nodes.get(comment.target.nodeId) : artboard;
          const card = cards.get(comment.id);
          if (!target || !card) return [];
          const bounds = target.getBoundingClientRect();
          return [
            {
              id: comment.id,
              x: bounds.left - origin.left + bounds.width * clamp(comment.target.x),
              y: bounds.top - origin.top + bounds.height * clamp(comment.target.y),
              height: card.getBoundingClientRect().height,
            },
          ];
        })
        .sort((left, right) => left.y - right.y);
      let bottom = 38;
      const items = anchors.map((anchor) => {
        const top = Math.max(38, anchor.y - 24, bottom);
        bottom = top + anchor.height + 12;
        return { ...anchor, top };
      });
      const next = {
        items,
        marginLeft: marginBounds.left - origin.left,
        height: Math.max(80, bottom),
      };
      setLayout((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const schedule = () => {
      if (!pending && !disposed) pending = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(artboard);
    for (const element of artboard.querySelectorAll('[data-node-id]')) resize.observe(element);
    for (const element of margin.querySelectorAll('[data-comment-card]')) resize.observe(element);
    // Reordering and drag transforms can move an anchor without resizing it.
    const mutations = new MutationObserver(schedule);
    mutations.observe(artboard, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    artboard.addEventListener('transitionend', schedule);
    artboard.addEventListener('pointermove', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    void document.fonts.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(pending);
      resize.disconnect();
      mutations.disconnect();
      artboard.removeEventListener('transitionend', schedule);
      artboard.removeEventListener('pointermove', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [comments, zoom, frameRef, artboardRef]);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const card = [
      ...(marginRef.current?.querySelectorAll<HTMLElement>('[data-comment-card]') ?? []),
    ].find((element) => element.dataset.commentCard === selectedId);
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  return (
    <>
      <svg className="wf-comment-connectors" aria-hidden="true">
        {layout.items.map((item) => {
          const endY = item.top + 24;
          const elbow = layout.marginLeft - COMMENT_MARGIN_GAP / 2;
          return (
            <path
              key={item.id}
              data-comment-id={item.id}
              className={selectedId === item.id ? 'is-selected' : ''}
              d={`M ${item.x} ${item.y} C ${elbow} ${item.y}, ${elbow} ${endY}, ${layout.marginLeft} ${endY}`}
            />
          );
        })}
      </svg>
      <aside
        className="wf-comment-margin"
        ref={marginRef}
        style={{ height: layout.height }}
        aria-label="Wireframe comment margin"
      >
        <div className="wf-comment-margin-heading">
          <MessageCircle size={14} /> Comments <span>{comments.length}</span>
        </div>
        {comments.map((comment, index) => {
          const placement = layout.items.find((item) => item.id === comment.id);
          return (
            <article
              key={comment.id}
              className={`wf-comment-card${selectedId === comment.id ? ' is-selected' : ''}`}
              data-comment-card={comment.id}
              style={{ top: placement?.top ?? 38, visibility: placement ? 'visible' : 'hidden' }}
              onClick={() => onSelect(comment)}
            >
              <button
                type="button"
                className="wf-comment-card-heading"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(comment);
                }}
                aria-label={`Open comment ${index + 1}`}
              >
                <span className="wf-comment-number">{index + 1}</span>
                <strong>You</strong>
                {comment.status === 'accepted' && (
                  <span className="wf-comment-accepted">
                    <CheckCheck size={13} /> Accepted
                  </span>
                )}
              </button>
              <p>{comment.body}</p>
              <div className="wf-comment-card-actions">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(comment);
                  }}
                >
                  <MessageCircle size={13} />{' '}
                  {comment.replies.length ? `${comment.replies.length} replies` : 'Open thread'}
                </button>
                {comment.status === 'open' && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onResolve(comment);
                    }}
                  >
                    <Check size={13} /> Resolve
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </aside>
    </>
  );
}
