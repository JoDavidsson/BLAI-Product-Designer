import { describe, expect, it } from 'vitest';
import { buildProductOverview } from '../shared/overview';
import { createSampleProject } from '../shared/seed';
import { renderOverviewGraph } from '../src/lib/diagrams';

describe('automatic overview rendering', () => {
  it('renders every generated project view with selectable source nodes', () => {
    for (const graph of buildProductOverview(createSampleProject()).graphs) {
      const result = renderOverviewGraph(graph);
      expect(result.type).toBe(graph.id === 'product' ? 'mindmap' : 'flowchart');
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      for (const node of graph.nodes) expect(result.svg).toContain(`data-id="${node.id}"`);
      expect(result.links).toEqual([]);
    }
  });
  it('treats hostile original project content only as labels', () => {
    const project = createSampleProject();
    project.title = '<script>alert(1)</script>" --> injected[bad]';
    project.plan.problem =
      'click A "https://example.org/unwanted"\n<img src=x onerror=alert(1)> & <svg onload=alert(1)>';
    const svg = renderOverviewGraph(buildProductOverview(project).graphs[0]).svg;
    expect(svg).not.toMatch(
      /<script\b|<foreignObject\b|<image\b|<img\b|<a\b|<[^>]*\bon(?:load|error)\s*=/,
    );
    expect(svg).not.toContain('data-id="injected"');
  });
  it('renders a project with no plan or screens without sample product content', () => {
    const project = createSampleProject();
    for (const key of Object.keys(project.plan) as Array<keyof typeof project.plan>)
      project.plan[key] = '';
    project.screens = [];
    project.requirements = [];
    project.comments = [];
    for (const graph of buildProductOverview(project).graphs)
      expect(() => renderOverviewGraph(graph)).not.toThrow();
  });
});
