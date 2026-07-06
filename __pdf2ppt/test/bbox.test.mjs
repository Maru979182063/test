import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxXYWHToArray,
  bboxXYWHToXYXY,
  parseBboxXYWH,
  unionBboxXYWH,
  validateBboxXYWH,
} from '../src/lib/bbox.mjs';

test('xywh bbox converts to xyxy correctly', () => {
  assert.deepEqual(bboxXYWHToXYXY([90, 82, 819, 51]), [90, 82, 909, 133]);
});

test('union bbox preserves xywh contract', () => {
  const union = unionBboxXYWH([
    [90, 82, 819, 51],
    [355, 137, 288, 79],
    [117, 219, 727, 22],
  ]);

  assert.deepEqual(bboxXYWHToArray(union), [90, 82, 819, 159]);
});

test('validateBboxXYWH rejects non-positive width or height', () => {
  assert.throws(
    () => validateBboxXYWH([10, 20, 0, 50], [1000, 1000], 'zero-width'),
    /width and height must be > 0/
  );
  assert.throws(
    () => validateBboxXYWH([10, 20, 50, -1], [1000, 1000], 'negative-height'),
    /width and height must be > 0/
  );
});

test('validateBboxXYWH rejects out-of-bounds bbox', () => {
  assert.throws(
    () => validateBboxXYWH([900, 20, 200, 50], [1000, 1000], 'oob'),
    /bbox exceeds page bounds/
  );
});

test('parseBboxXYWH returns named fields', () => {
  assert.deepEqual(parseBboxXYWH([1, 2, 3, 4]), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
});
