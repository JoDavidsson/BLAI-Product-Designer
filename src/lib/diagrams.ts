import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';
import mindmap from 'pele/diagrams/mindmap';
import {
  MAX_OVERVIEW_EDGES,
  MAX_OVERVIEW_SOURCE_LENGTH,
  overviewMermaid,
  type OverviewGraph,
} from '../../shared/overview';
register(flowchart, mindmap);
/** Generated representation only. Content never becomes renderer options or HTML. */
export function renderOverviewGraph(graph: OverviewGraph) {
  return render(overviewMermaid(graph), {
    idPrefix: `blai-overview-${graph.id}`,
    fontFamily: 'DM Sans, sans-serif',
    fontSize: 15,
    padding: 28,
    autoDirection: false,
    config: { mindmap: { maxNodeWidth: 245 }, flowchart: { wrappingWidth: 220 } },
    limit: MAX_OVERVIEW_SOURCE_LENGTH,
    outputLimit: 1_000_000,
    maxEdges: MAX_OVERVIEW_EDGES,
    links: false,
    images: false,
  });
}
