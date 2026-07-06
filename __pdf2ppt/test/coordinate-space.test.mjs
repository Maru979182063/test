import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlockImageMeta,
  mapModelInputBboxToSourceImageBbox,
  mapRefineBboxToPageBbox,
  validateXYWH,
  xyxyToXywh,
} from '../src/lib/coordinate-space.mjs';

test('mapModelInputBboxToSourceImageBbox maps resized model bbox back to original page', () => {
  const imageMeta = buildBlockImageMeta({
    originalPageSize: [1820, 2573],
    modelInputSize: [1273, 1800],
    maxImageSidePx: 1800,
    detail: 'high',
  });

  const mapped = mapModelInputBboxToSourceImageBbox([100, 200, 300, 400], imageMeta);
  assert.deepEqual([mapped.bbox.x, mapped.bbox.y, mapped.bbox.width, mapped.bbox.height], [
    143, 286, 429, 572,
  ]);
});

test('mapModelInputBboxToSourceImageBbox keeps bbox unchanged when no resize happened', () => {
  const imageMeta = buildBlockImageMeta({
    originalPageSize: [1820, 2573],
    modelInputSize: [1820, 2573],
    maxImageSidePx: 3000,
    detail: 'high',
  });

  const mapped = mapModelInputBboxToSourceImageBbox([90, 82, 819, 51], imageMeta);
  assert.deepEqual([mapped.bbox.x, mapped.bbox.y, mapped.bbox.width, mapped.bbox.height], [
    90, 82, 819, 51,
  ]);
});

test('mapRefineBboxToPageBbox maps refine input bbox back through parent crop', () => {
  const refineImageMeta = buildBlockImageMeta({
    originalPageSize: [1000, 600],
    modelInputSize: [500, 300],
    maxImageSidePx: 500,
    detail: 'high',
  });

  const mapped = mapRefineBboxToPageBbox(
    [50, 60, 100, 120],
    refineImageMeta,
    [50, 300, 1000, 600],
    { pageSize: [1820, 2573] }
  );

  assert.deepEqual([mapped.bbox.x, mapped.bbox.y, mapped.bbox.width, mapped.bbox.height], [
    150, 420, 200, 240,
  ]);
});

test('validateXYWH throws in strict mode for invalid and out-of-bounds boxes', () => {
  assert.throws(
    () => validateXYWH([10, 20, 0, 40], 1000, 1000, { strict: true }),
    /width must be > 0/
  );
  assert.throws(
    () => validateXYWH([900, 20, 200, 40], 1000, 1000, { strict: true }),
    /exceeds page width/
  );
});

test('xyxyToXywh keeps coordinate conversion explicit', () => {
  assert.deepEqual(xyxyToXywh([90, 82, 909, 133]), [90, 82, 819, 51]);
});
