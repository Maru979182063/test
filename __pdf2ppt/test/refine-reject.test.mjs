import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRejectRefineResult } from '../src/adapters/ark-model.mjs';

test('shouldRejectRefineResult rejects near-full refine unions', () => {
  const reasons = shouldRejectRefineResult(
    [
      {
        modelBbox: [0, 0, 496, 296],
        refineModelBbox: [0, 0, 496, 296],
        textHint: 'full crop',
      },
    ],
    {
      type: 'practice_question',
      textHint: 'question 1',
    },
    {
      inputSize: [500, 300],
    }
  );

  assert.ok(reasons.includes('refine-union-nearly-full-input'));
});

test('shouldRejectRefineResult rejects fragment-like semantic degradation', () => {
  const reasons = shouldRejectRefineResult(
    [
      {
        modelBbox: [20, 30, 120, 80],
        refineModelBbox: [20, 30, 120, 80],
        textHint: 'option C only',
      },
    ],
    {
      type: 'practice_question',
      textHint: 'question 3 full problem statement',
    },
    {
      inputSize: [500, 300],
    }
  );

  assert.ok(reasons.includes('refine-fragment-like-text'));
  assert.ok(reasons.includes('refine-semantic-degradation'));
});
