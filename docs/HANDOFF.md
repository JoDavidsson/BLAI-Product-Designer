# Product handoffs

The handoff screen downloads a ZIP or publishes the same files to a selected GitHub repository, existing branch, and folder. Export is a snapshot of the saved project revision. Save pending edits before exporting.

## Contents

- `spec.md` contains the product plan, screen/component inventory, navigation targets, design tokens, reference notes, requirements, and annotations.
- `project.json` preserves the complete editable project and its stable IDs.
- `requirements.json` separates accepted requirements from proposed requirements, and accepted/open/resolved annotations. Open questions remain explicit.
- `screens/*.svg` contains reproducible wireframe layouts (900 px desktop, 375 px mobile). Rows arrange children horizontally on desktop and stack on mobile; other containers stack children. Text wraps, styles apply within supported limits, and dotted annotation lines point to screen or component coordinates. These illustrative renderings are not browser screenshots. Image components are labeled placeholders because the component model does not bind image assets to nodes.
- `assets/*` contains original PNG, JPEG, GIF, and WebP uploads. Every object must belong to the authenticated owner and exported project. External URLs and built-in sample references remain references, with a reason in the manifest. Export never fetches remote URLs.
- `manifest.json` maps image references to bundled files and lists SHA-256 checksums and byte sizes. It excludes its own checksum.

The same project and image bytes yield the same ZIP bytes. Packages are limited to 32 MB uncompressed, with 10 MB per image. Missing uploads fail explicitly so an incomplete package is not presented as complete.

## GitHub publishing

Configure `GITHUB_TOKEN` as a Worker secret. Use a fine-grained token scoped to the desired repository with **Contents: Read and write**. It is used only on the server and is never part of an export or browser response. Downloading ZIPs does not require this token.

Enter `owner/repository`, an existing branch, and a dedicated path such as `docs/product-handoff`. Initialize an empty GitHub repository and create the target branch before publishing. Root paths, traversal, `.git`, and `.github` destinations are rejected. Only known handoff filenames can be written; publishing cannot produce workflow files or application code.

Publishing creates blobs, a Git tree based on the current repository tree, and one commit with the current branch head as its parent. A non-force branch update publishes the package atomically and preserves unrelated files. A concurrent commit or branch-protection failure reports an error instead of forcing the branch. A failed update may leave unreachable Git objects but does not partially publish files. Existing files in the chosen handoff folder with matching package names are replaced. Stale screen/image files listed in this project's previous manifest are removed in the same commit; other files remain intact. A folder containing another project's handoff or an unrecognized manifest is rejected, so use a dedicated folder for each project.

The returned link points to the immutable commit. GitHub exports are limited to 200 files and 32 MB. All assets bundled in the ZIP are also included in GitHub output. Authentication, permission, missing-branch, connectivity, and concurrent-update failures provide actionable errors. Tests use an injected fake fetch and do not write to GitHub.
