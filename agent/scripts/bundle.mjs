// Bundles agent/lambda.mjs (and everything it imports — handler.mjs, tools.mjs,
// embeddings.mjs, pos-client.mjs, plus the imported memory/ and pos-sync/ modules) into a
// single self-contained ESM file for AWS Lambda, then zips it for deploy-lambda.mjs.
//
// Pinned dependency versions are bundled in rather than left external — the deployed Lambda
// has no node_modules of its own, and bundling avoids any drift between what was tested
// locally and what runs in Lambda. pg-native is marked external: it's an optional native
// addon pg only requires inside a try/catch (see pg/lib/native/index.js) and isn't installed
// here, so it must stay unresolved at bundle time rather than have esbuild try to bundle a
// dependency that doesn't exist on disk.
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const AGENT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(AGENT_DIR, 'dist-lambda');
const ENTRY = path.join(AGENT_DIR, 'lambda.mjs');
const BUNDLE_FILE = path.join(OUT_DIR, 'index.mjs');
const ZIP_FILE = path.join(OUT_DIR, 'function.zip');

async function zipBundle() {
  // Shells out to the system `zip` (present on macOS/Linux dev machines and CI images) rather
  // than adding a JS zip dependency just for this one build step. The .mjs extension forces
  // Node to treat the file as ESM regardless of any package.json in the zip, so the deployed
  // handler config can simply be "index.handler".
  await execFileAsync('zip', ['-j', ZIP_FILE, BUNDLE_FILE], { cwd: OUT_DIR });
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const result = await build({
    entryPoints: [ENTRY],
    outfile: BUNDLE_FILE,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // AWS SDK v3 clients are bundled (pinned versions), not left to a runtime-provided SDK —
    // safer against version drift than relying on whatever the Lambda base image ships.
    external: ['pg-native'],
    banner: {
      // esbuild's ESM output doesn't have `require` in scope, but pg's CommonJS internals
      // (bundled in) call it directly; this shim keeps those calls working without needing
      // pg itself to be marked external.
      js:
        "import { createRequire as __cafeCopilotCreateRequire } from 'node:module';\n" +
        'const require = __cafeCopilotCreateRequire(import.meta.url);',
    },
    logLevel: 'info',
    metafile: true,
  });

  await writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(result.metafile, null, 2));
  await zipBundle();

  console.log(`[bundle] wrote ${BUNDLE_FILE}`);
  console.log(`[bundle] wrote ${ZIP_FILE}`);
}

main().catch((err) => {
  console.error('[bundle] failed:', err);
  process.exitCode = 1;
});
