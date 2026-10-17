import { describe, expect, it } from 'vitest';
import { DIAGRAM_STARTERS, renderProductDiagram } from '../src/lib/diagrams';
import { MAX_DIAGRAM_SOURCE_LENGTH, type ProductDiagram } from '../shared/model';

const diagram = (source: string, kind: ProductDiagram['kind'] = 'flowchart'): ProductDiagram => ({
  id: 'diagram_test',
  title: 'Test journey',
  kind,
  source,
});

describe('Pele rendering boundary', () => {
  it('renders both bundled examples with the actual selected renderer', () => {
    for (const kind of ['flowchart', 'state'] as const) {
      const result = renderProductDiagram(diagram(DIAGRAM_STARTERS[kind].source, kind));
      expect(result.type).toBe(kind);
      expect(result.svg).toContain('<svg');
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    }
  });

  it('rejects empty, unsupported, and mismatched diagram types', () => {
    expect(() => renderProductDiagram(diagram('   '))).toThrow('Add Mermaid text');
    expect(() => renderProductDiagram(diagram('sequenceDiagram\n A->>B: Hello'))).toThrow();
    expect(() => renderProductDiagram(diagram(DIAGRAM_STARTERS.state.source))).toThrow(
      'Start this user flow',
    );
  });

  it('bounds source and flowchart work even when no server schema is involved', () => {
    expect(() =>
      renderProductDiagram(diagram(`flowchart TD\n%% ${'x'.repeat(MAX_DIAGRAM_SOURCE_LENGTH)}`)),
    ).toThrow();
    const source = `flowchart TD\n${Array.from({ length: 151 }, (_, i) => `N${i} --> N${i + 1}`).join('\n')}`;
    expect(() => renderProductDiagram(diagram(source))).toThrow();
  });

  it('disables links and external images in rendered output', () => {
    const source = `flowchart LR
  A[Read more] --> B[Done]
  click A "https://example.org/unwanted"
  C@{ img: "https://example.org/image.png", label: "External image" }`;
    const result = renderProductDiagram(diagram(source));
    expect(result.links).toEqual([]);
    expect(result.svg).not.toMatch(/<a\b|<image\b|https:\/\/example\.org/);
  });
});
