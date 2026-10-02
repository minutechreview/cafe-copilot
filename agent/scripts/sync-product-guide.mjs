import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_GUIDE_BYTES, validateProductGuide } from '../guide-schema.mjs';

const destination = fileURLToPath(new URL('../knowledge/product-guide.json', import.meta.url));
const manifestFile = fileURLToPath(new URL('../knowledge/product-guide.source.json', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const source = args.find((arg) => arg !== '--check');
if (args.length > (check ? 2 : 1) || (!check && !source)) throw new Error('Usage: sync-product-guide.mjs [--check] <POS docs/product-guide.json>');

const bytes = await readFile(source || destination);
if (bytes.length > MAX_GUIDE_BYTES) throw new Error('Product guide is too large');
const guide = validateProductGuide(JSON.parse(bytes.toString('utf8')));
const manifest = {
  sourceRepository: 'https://github.com/minutechreview/project-pos',
  sourcePath: 'docs/product-guide.json',
  guideVersion: guide.version,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  articleCount: guide.articles.length,
};

if (check) {
  const [currentBytes, currentManifest] = await Promise.all([readFile(destination), readFile(manifestFile, 'utf8')]);
  if (!bytes.equals(currentBytes) || JSON.stringify(manifest) !== JSON.stringify(JSON.parse(currentManifest))) throw new Error('Bundled product guide differs from its canonical source. Run sync:guide before release.');
  console.log(`[guide] verified ${manifest.articleCount} articles, version ${manifest.guideVersion}, source hash ${manifest.sha256}`);
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[guide] synced ${manifest.articleCount} articles from POS docs/product-guide.json`);
}
