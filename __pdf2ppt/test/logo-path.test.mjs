import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJobConfig } from '../src/lib/config.mjs';
import { resolveBrandingAssetPath } from '../src/stages/build-ppt.mjs';

test('build-ppt logo path stays compatible with legacy inputs.logoPath', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2ppt-logo-'));
  const logoPath = path.join(tempRoot, 'logo.png');
  const configPath = path.join(tempRoot, 'job.json');

  await fs.writeFile(logoPath, '');
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        jobName: 'logo-compat',
        inputs: {
          pageImagesDir: '.',
          logoPath: './logo.png',
        },
        pipeline: {
          render: { mode: 'page-images' },
          detectBlocks: { mode: 'mock' },
          planSlides: { mode: 'mock' },
          crop: { mode: 'page-images' },
          buildPpt: { fileName: 'logo-compat.pptx' },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const config = await loadJobConfig(configPath);
  assert.equal(config.branding.logoPath, logoPath);
  assert.equal(resolveBrandingAssetPath(config, 'logoPath'), logoPath);
});

test('build-ppt prefers branding.logoPath when provided', () => {
  const brandingLogo = path.resolve('C:/tmp/branding-logo.png');
  const legacyLogo = path.resolve('C:/tmp/legacy-logo.png');

  assert.equal(
    resolveBrandingAssetPath(
      {
        branding: { logoPath: brandingLogo },
        inputs: { logoPath: legacyLogo },
      },
      'logoPath'
    ),
    brandingLogo
  );
});
