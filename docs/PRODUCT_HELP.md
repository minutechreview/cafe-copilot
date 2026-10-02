# Product help in Ask

`get_product_help` reads the same guide articles used to produce the Kade PDF manual. The canonical source is [`project-pos/docs/product-guide.json`](https://github.com/minutechreview/project-pos/blob/main/docs/product-guide.json), maintained with the POS screens. Do not edit the bundled copy separately.

After updating the POS guide, sync it into this repository:

```sh
npm run sync:guide --workspace=agent -- '/path/to/project-pos/docs/product-guide.json'
npm run check:guide --workspace=agent -- '/path/to/project-pos/docs/product-guide.json'
npm test
npm run bundle --workspace=agent
```

The sync records the canonical repository/path, guide version and SHA-256 content hash in `agent/knowledge/product-guide.source.json`. `npm run check:guide --workspace=agent` also checks the bundled artifact against this record without needing a POS checkout, and runs before the Lambda bundle. During a coordinated product release, use the explicit source path to confirm both repositories ship the same guide.

The tool uses a small in-memory keyword index. It does not call an embedding model, access the POS database, send mail, change configuration or order stock. It accepts a plain-language question of up to 400 characters and returns at most three matching articles. Each result carries the article's steps, roles and cautions. Unknown topics return a no-match result so Ask can request clarification instead of guessing.

Only fixed application page identifiers become links. Article routes must agree with the allowlist at sync time and runtime. URLs, labels, business identifiers and search parameters cannot be supplied by a question. The existing Supabase authentication and business membership checks still happen before a chat turn. Help results do not report a shop's current setting, payment state or completed actions. Navigation retains the destination's normal access checks, including the Kitchen display gate.

For product instructions, the model is told to use this tool first, keep the answer brief, include relevant cautions, and let the user open and act on the feature. For shop numbers, the existing live read-only tools remain the source of truth. Chat history and the reviewed draft purchase-order card keep their existing tenant-scoped storage behavior.
