import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadJobConfig } from '../src/lib/config.mjs';
import { runPipeline } from '../src/pipeline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePageDir = path.join(repoRoot, 'out', 'physics-smoke', 'debug', 'rendered-pages');

test('mock pipeline runs through pptx and writes debug artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2ppt-smoke-'));
  const configPath = path.join(tempRoot, 'job.json');

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        jobName: 'mock-smoke',
        outputDir: './run-output',
        debug: {
          enabled: true,
          strictBbox: true,
        },
        inputs: {
          pageImagesDir: fixturePageDir,
        },
        pipeline: {
          render: { mode: 'page-images' },
          detectBlocks: { mode: 'mock', confidenceThreshold: 0.8 },
          planSlides: { mode: 'mock', maxBlocksPerSlide: 1 },
          crop: { mode: 'page-images', bleedPx: 16, preserveFullPageWidth: true },
          buildPpt: { fileName: 'mock-smoke.pptx' },
          validateOutput: { enabled: false },
        },
        branding: {
          logoPath: '',
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const config = await loadJobConfig(configPath);
  const result = await runPipeline(config);

  assert.equal(result.pageCount, 1);
  assert.equal(result.blockCount, 3);
  assert.equal(result.slideCount, 3);

  await fs.access(result.pptxPath);
  await fs.access(path.join(config.outputDir, 'debug', 'page_001_raw_model_input.png'));
  await fs.access(path.join(config.outputDir, 'debug', 'page_001_overlay_on_model_input.png'));
  await fs.access(path.join(config.outputDir, 'debug', 'page_001_overlay_on_original_page.png'));
  await fs.access(path.join(config.outputDir, 'debug', 'page_001_blocks_report.json'));
  await fs.access(path.join(config.outputDir, 'debug', 'crop_contact_sheet.png'));
  await fs.access(path.join(config.outputDir, 'artifacts', 'report.json'));

  const blocks = JSON.parse(
    await fs.readFile(path.join(config.outputDir, 'artifacts', 'blocks.json'), 'utf8')
  );
  const crops = JSON.parse(
    await fs.readFile(path.join(config.outputDir, 'artifacts', 'crops.json'), 'utf8')
  );

  assert.equal(blocks.bboxFormat, 'xywh_pixel_top_left');
  assert.equal(crops.bboxFormat, 'xywh_pixel_top_left');
  assert.equal(crops.crops.length, 3);
  assert.ok(crops.crops.every((crop) => Array.isArray(crop.rawBbox) && crop.rawBbox.length === 4));
  assert.ok(
    crops.crops.every(
      (crop) => Array.isArray(crop.expandedBbox) && Array.isArray(crop.finalCropBbox)
    )
  );
  assert.ok(crops.crops.every((crop) => Array.isArray(crop.cropSize) && crop.cropSize.length === 2));
});
