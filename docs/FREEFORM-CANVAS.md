# Freeform canvas implementation plan

The wireframe editor is becoming a spatial design canvas. New screens use positioned, editable layers. Existing flow screens remain readable and gain an explicit, undoable **Edit freely** conversion; opening a project never rewrites it.

## Scene contract

- Keep `Screen.nodes`, stable node IDs, nested children, and sibling order as the single scene graph. Later siblings paint above earlier siblings.
- `Screen.canvas?: { width, height }` marks a freeform frame. Dimensions are finite and between 100 and 10000 pixels.
- `WireNode.frame?: { x, y, width, height, rotation }` uses parent-local coordinates. Position bounds are -20000 to 20000, dimensions 1 to 20000, rotation -360 to 360 degrees about the layer's centre. Every node in a canvas screen has a frame. No CSS transform strings are stored.
- Add `group`, `rectangle`, `ellipse`, `line`, and `path` node types. Existing types remain valid. Paths use `points?: { x, y }[]`, 2–256 normalized points in [0,1]. Only `path` uses points.
- Optional `layout: 'free' | 'row' | 'column'` applies to containers. Free positioning is the default. Automatic layout persists and recomputes child frames using gap/padding when children are resized, inserted, removed, or reordered; the stored geometry remains exportable. Direct dragging of automatically arranged children is disabled until the container switches back to free layout.
- Optional `locked` and `hidden` booleans apply to layers and their descendants. Selection and manipulation respect both.
- `image?: { assetId, fit: 'cover' | 'contain' }` references an existing owned image in `project.assets`; no arbitrary URLs, HTML, SVG source, or scripts.
- Add bounded style fields `stroke` (existing hex format), `strokeWidth` (0–32), `opacity` (0–1), and `fontWeight` (400, 500, 600, 700). Existing style fields remain valid.
- Missing additive fields retain legacy behavior. No database migration is needed. Reject malformed geometry and missing asset references; never silently strip canvas geometry.

## Editing and compatibility

Implement select/multiselect, drag, resize, rotation, drawing rectangles/ellipses/lines/freehand paths, text, image placement, keyboard nudge, copy/duplicate/delete, layer order/visibility/locking, group/ungroup, alignment, explicit automatic layout, pan/zoom, and editable frame dimensions. Keep pointer previews local and commit once per completed gesture. Escape/pointer cancellation restores the prior scene without an undo entry. Text input keeps normal typing shortcuts.

Conversion measures rendered legacy layers and stores parent-local frames in one undoable edit, preserving node IDs, content, links, and comments. New frames start blank. Existing flow editing remains available for unconverted screens.

Comments stay in the right margin with dotted leaders. Rotated anchors use actual transformed pin positions. Image insertion preserves asynchronous upload race guards. Whole-project validation, optimistic revisions, history, and private asset ownership remain enforced.

AI-generated and refined screens use the same scene geometry, keep explicit design references and primary interactions, and produce editable compositions. Older helpers must not replace freeform screens with geometry-free results. Keep Designer on Astra Medium, 872000 configured context, and ChatGPT subscription authentication; Writer is unchanged.

SVG/ZIP handoff must reproduce layer geometry, rotation, ordering, shapes, and owned image placement rather than rearranging layers into document flow. JSON retains the complete scene.

## Acceptance and release

Run geometry/validation/export/worker/helper tests and real local browser checks. Verify transforms at different zoom levels, group/ungroup world-position preservation, one undo per gesture, persistence after reload, mobile access to controls, private images, comments after movement/rotation, and legacy projects. Use synthetic fixtures in committed tests; private diagnostic project content stays outside Git.

Prepare the complete change and local QA evidence before requesting deployment approval. **Do not deploy this release to Cloudflare until the user approves.**
