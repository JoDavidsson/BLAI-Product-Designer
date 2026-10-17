import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';
import state from 'pele/diagrams/state';
import { MAX_DIAGRAM_SOURCE_LENGTH, type ProductDiagram } from '../../shared/model';

register(flowchart, state);

export const DIAGRAM_STARTERS: Record<ProductDiagram['kind'], { title: string; source: string }> = {
  flowchart: {
    title: 'Core user journey',
    source: `flowchart TD
  explore[Explore options] --> details[View details]
  details --> decision{Ready to continue?}
  decision -->|Yes| action[Complete action]
  decision -->|Not yet| compare[Compare options]
  compare --> explore
  action --> done[Confirmation]`,
  },
  state: {
    title: 'Screen states',
    source: `stateDiagram-v2
  [*] --> Idle
  Idle --> Loading: Open screen
  Loading --> Ready: Data found
  Loading --> Empty: No results
  Loading --> Error: Request failed
  Error --> Loading: Try again
  Empty --> Loading: Refresh
  Ready --> [*]`,
  },
};

/** Keep the renderer replaceable: the project stores portable Mermaid, never generated SVG. */
export function renderProductDiagram(diagram: ProductDiagram) {
  if (!diagram.source.trim()) throw new Error('Add Mermaid text to see your diagram.');
  const result = render(diagram.source, {
    idPrefix: `blai-${diagram.id}`,
    fontFamily: 'DM Sans, sans-serif',
    fontSize: 15,
    padding: 28,
    autoDirection: false,
    limit: MAX_DIAGRAM_SOURCE_LENGTH,
    outputLimit: 1_000_000,
    maxEdges: 150,
    links: false,
    images: false,
  });
  if (result.type !== diagram.kind)
    throw new Error(
      diagram.kind === 'flowchart'
        ? 'Start this user flow with “flowchart TD” or “flowchart LR”.'
        : 'Start this screen-state diagram with “stateDiagram-v2”.',
    );
  return result;
}
