# Product handoffs

The handoff screen downloads a ZIP or publishes the same files to a selected GitHub repository, existing branch, and folder. Export is a snapshot of the saved project revision. Save pending edits before exporting.

## Contents

- `CODEX.md` is the implementation entrypoint. It gives an AI a reading order, explains how approved decisions differ from open discussion, and describes an implementation and verification workflow using source IDs. It defers repository conventions to the destination repository rather than assuming a framework.
- `spec.md` contains the product plan, screen/component inventory, navigation targets, design tokens, reference notes, requirements, and annotations.
- `project.json` preserves the complete editable project and its stable IDs.
- `requirements.json` separates accepted requirements from proposed requirements, and accepted/open/resolved annotations. Open questions remain explicit.
- `screens/*.svg` contains reproducible wireframe layouts (900 px desktop, 375 px mobile). Rows arrange children horizontally on desktop and stack on mobile; other containers stack children. Text wraps, styles apply within supported limits, and dotted annotation lines point to screen or component coordinates. These illustrative renderings are not browser screenshots. Image components are labeled placeholders because the component model does not bind image assets to nodes.
- `assets/*` contains original PNG, JPEG, GIF, and WebP uploads. Every object must belong to the authenticated owner and exported project. External URLs and built-in sample references remain references, with a reason in the manifest. Export never fetches remote URLs.
- `manifest.json` identifies the entrypoint, maps screen IDs to SVG files and image references to bundled files, and lists SHA-256 checksums and byte sizes. It excludes its own checksum.

The same project and image bytes yield the same ZIP bytes. Packages are limited to 32 MB uncompressed, with 10 MB per image. Missing uploads fail explicitly so an incomplete package is not presented as complete.

## GitHub publishing

Configure `GITHUB_TOKEN` as a Worker secret. Use a fine-grained token scoped to the desired repository with **Contents: Read and write**. It is used only on the server and is never part of an export or browser response. Downloading ZIPs does not require this token.

Enter `owner/repository`, an existing branch, and a dedicated path such as `docs/product-handoff`. Initialize an empty GitHub repository and create the target branch before publishing. Root paths, traversal, `.git`, and `.github` destinations are rejected. Only known handoff filenames can be written; publishing cannot produce workflow files or application code.

Publishing inspects the destination at a fixed branch commit before uploading files. A file with a package filename is replaced only when the previous manifest identifies it as part of this project's handoff. Unmanaged name collisions, links, submodules, another project's handoff, and unrecognized manifests are rejected before writing. Unrelated files such as your own `notes.md` remain intact. Destination lookup walks Git trees rather than following links, and an incomplete tree listing fails explicitly.

Publishing then creates blobs, a Git tree based on the inspected repository tree, and one commit with the original branch head as its parent. A non-force branch update publishes the package atomically and preserves unrelated files. A concurrent commit or branch-protection failure reports an error instead of forcing the branch. A failed update may leave unreachable Git objects but does not partially publish files. Stale files owned by the previous manifest are removed in the same commit only if they still exist; files already removed from the repository do not break the export. Changes made directly to a managed handoff file are replaced by the next export, so keep additional notes in separate files.

The returned link points to the immutable commit after GitHub confirms the branch update. GitHub exports are limited to 200 files and 32 MB, and remain subject to the deployed Worker's subrequest limits. All assets bundled in the ZIP are also included in GitHub output. GitHub publishing skips ZIP construction and batches image uploads by byte size to limit memory use. Authentication, permission, missing-branch, connectivity, destination collision, and concurrent-update failures provide actionable errors. Tests use an injected fake fetch and do not write to GitHub.
