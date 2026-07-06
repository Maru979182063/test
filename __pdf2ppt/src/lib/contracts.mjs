import { BBOX_FORMAT_XYWH, validateBboxXYWH } from './bbox.mjs';
import { readImageSize } from './coordinate-space.mjs';

export const BLOCK_TYPES = [
  'title',
  'definition',
  'example',
  'derivation',
  'figure',
  'problem_illustration',
  'cover',
  'section_divider',
  'overview_map',
  'knowledge_point',
  'example_question',
  'practice_question',
  'advanced_question',
  'table_object',
  'diagram_object',
  'process_object',
];

export const PAGE_ROLES = [
  'cover',
  'section_divider',
  'overview',
  'knowledge',
  'exercise',
  'mixed',
];

export function validateBlock(block) {
  if (!BLOCK_TYPES.includes(block.type)) {
    throw new Error(`Unsupported block type: ${block.type}`);
  }

  if (block.bboxFormat !== BBOX_FORMAT_XYWH) {
    throw new Error(`Unsupported bboxFormat for block ${block.id}: ${block.bboxFormat}`);
  }

  if (block.coordinateSpace !== 'original_page_image') {
    throw new Error(`Unsupported coordinateSpace for block ${block.id}: ${block.coordinateSpace}`);
  }

  if (block.pageRole && !PAGE_ROLES.includes(block.pageRole)) {
    throw new Error(`Unsupported page role: ${block.pageRole}`);
  }

  if (!Array.isArray(block.pageSize) || block.pageSize.length !== 2) {
    throw new Error(`Invalid pageSize for block ${block.id}`);
  }

  validateBboxXYWH(block.bbox, block.pageSize, `block ${block.id}`);

  if (!Array.isArray(block.modelBbox) || block.modelBbox.length !== 4) {
    throw new Error(`Missing modelBbox for block ${block.id}`);
  }
  if (!block.imageMeta || typeof block.imageMeta !== 'object') {
    throw new Error(`Missing imageMeta for block ${block.id}`);
  }
  const original = readImageSize(block.imageMeta, 'original', `block ${block.id} imageMeta`);
  if (original.width !== block.pageSize[0] || original.height !== block.pageSize[1]) {
    throw new Error(
      `imageMeta.originalPageSize mismatch for block ${block.id}: expected ${JSON.stringify(block.pageSize)}, got ${JSON.stringify([original.width, original.height])}`
    );
  }
}
