import { findNode, uid, type NodeType, type Screen, type WireNode } from '../../shared/model';

export const CONTAINERS: NodeType[] = ['section', 'row', 'column', 'card'];

export function cloneWireNode(node: WireNode, selfLink?: { from: string; to: string }): WireNode {
  return {
    ...structuredClone(node),
    id: uid('node'),
    ...(selfLink && node.action?.screenId === selfLink.from
      ? { action: { screenId: selfLink.to } }
      : {}),
    children: node.children.map((child) => cloneWireNode(child, selfLink)),
  };
}

export function nodeParent(nodes: WireNode[], id: string, parent = ''): string | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent;
    const found = nodeParent(node.children, id, node.id);
    if (found !== undefined) return found;
  }
}

/** Move the existing subtree; its stable IDs keep annotations attached. */
export function reparentNode(nodes: WireNode[], id: string, parentId: string): WireNode[] | null {
  const node = findNode(nodes, id);
  const parent = parentId ? findNode(nodes, parentId) : undefined;
  if (
    !node ||
    nodeParent(nodes, id) === parentId ||
    parentId === id ||
    (parentId &&
      (!parent || !CONTAINERS.includes(parent.type) || findNode(node.children, parentId)))
  )
    return null;
  const remove = (items: WireNode[]): WireNode[] =>
    items
      .filter((item) => item.id !== id)
      .map((item) => ({ ...item, children: remove(item.children) }));
  const next = remove(structuredClone(nodes));
  const destination = parentId ? findNode(next, parentId)!.children : next;
  destination.push(structuredClone(node));
  return next;
}

/** Mirror the persisted tree limits before an editor operation can create an unsavable draft. */
export function wireframeLimitError(screens: Screen[]): string | undefined {
  if (screens.length > 30) return 'A project can have up to 30 screens.';
  let count = 0;
  function inspect(nodes: WireNode[], depth: number): string | undefined {
    if (nodes.length > 100) return 'A screen or container can hold up to 100 components.';
    if (nodes.length && depth > 10) return 'Components can be nested up to 10 levels deep.';
    for (const node of nodes) {
      count++;
      if (count > 1000) return 'A project can have up to 1,000 components.';
      const error = inspect(node.children, depth + 1);
      if (error) return error;
    }
  }
  for (const screen of screens) {
    const error = inspect(screen.nodes, 1);
    if (error) return error;
  }
}
