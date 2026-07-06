import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { loadJobConfig } from '../src/lib/config.mjs';
import { runPipeline } from '../src/pipeline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePageDir = path.join(repoRoot, 'out', 'physics-smoke', 'debug', 'rendered-pages');

test('json-file resize smoke preserves model-input and original-page coordinate spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2ppt-resize-'));
  const configPath = path.join(tempRoot, 'job.json');
  const blocksPath = path.join(tempRoot, 'blocks.json');
  const outputDir = path.join(tempRoot, 'run-output');

  await fs.writeFile(
    blocksPath,
    JSON.stringify(
      {
        blocks: [
          {
            id: 'p001-b01',
            pageNumber: 1,
            type: 'practice_question',
            bbox: [143, 286, 429, 572],
            modelBbox: [100, 200, 300, 400],
            bboxFormat: 'xywh_pixel_top_left',
            coordinateSpace: 'original_page_image',
            imageMeta: {
              originalPageSize: [1820, 2573],
              modelInputSize: [1273, 1800],
              localResize: {
                enabled: true,
                scaleX: 1273 / 1820,
                scaleY: 1800 / 2573,
                maxImageSidePx: 1800,
              },
              ark: {
                detail: 'high',
                imagePixelLimit: {
                  min_pixels: 2245146,
                  max_pixels: 2336786,
                },
              },
            },
            confidence: 0.92,
            readingOrder: 1,
            canSplit: false,
            textHint: 'question block',
            groupHint: 'q1',
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        jobName: 'resize-smoke',
        outputDir,
        debug: {
          enabled: true,
          strictBbox: true,
          writeModelInputCopies: true,
        },
        provider: {
          imageDetail: 'high',
          maxImageSidePx: 1800,
          imagePixelLimit: {
            enabled: true,
            mode: 'match_model_input',
            tolerance: 0.02,
          },
        },
        inputs: {
          pageImagesDir: fixturePageDir,
          blocksFile: blocksPath,
        },
        pipeline: {
          render: { mode: 'page-images' },
          detectBlocks: { mode: 'json-file' },
          planSlides: { mode: 'grouped-rules', maxBlocksPerSlide: 1 },
          crop: { mode: 'page-images', bleedPx: 16, preserveFullPageWidth: true },
          buildPpt: { fileName: 'resize-smoke.pptx' },
          validateOutput: { enabled: true, failOnError: false },
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
  await runPipeline(config);

  const rawInput = await loadImage(
    await fs.readFile(path.join(outputDir, 'debug', 'page_001_raw_model_input.png'))
  );
  const modelOverlay = await loadImage(
    await fs.readFile(path.join(outputDir, 'debug', 'page_001_overlay_on_model_input.png'))
  );
  const pageOverlay = await loadImage(
    await fs.readFile(path.join(outputDir, 'debug', 'page_001_overlay_on_original_page.png'))
  );

  assert.deepEqual([rawInput.width, rawInput.height], [1273, 1800]);
  assert.deepEqual([modelOverlay.width, modelOverlay.height], [1273, 1800]);
  assert.deepEqual([pageOverlay.width, pageOverlay.height], [1820, 2573]);

  const blocks = JSON.parse(await fs.readFile(path.join(outputDir, 'artifacts', 'blocks.json'), 'utf8'));
  const crops = JSON.parse(await fs.readFile(path.join(outputDir, 'artifacts', 'crops.json'), 'utf8'));
  const report = JSON.parse(await fs.readFile(path.join(outputDir, 'artifacts', 'report.json'), 'utf8'));

  assert.deepEqual(blocks.blocks[0].modelBbox, [100, 200, 300, 400]);
  assert.deepEqual(blocks.blocks[0].bbox, [143, 286, 429, 572]);
  assert.equal(blocks.blocks[0].coordinateSpace, 'original_page_image');
  assert.equal(crops.crops[0].finalCropBbox[0], 0);
  assert.deepEqual(crops.crops[0].rawBbox, [143, 286, 429, 572]);
  assert.deepEqual(report.modelInputSize, [1273, 1800]);
  assert.equal(report.localResize.enabled, true);
});
