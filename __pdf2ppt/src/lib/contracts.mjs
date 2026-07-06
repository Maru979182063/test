import { BBOX_FORMAT_XYWH, validateBboxXYWH } from './bbox.mjs';

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

  if (block.pageRole && !PAGE_ROLES.includes(block.pageRole)) {
    throw new Error(`Unsupported page role: ${block.pageRole}`);
  }

  if (!Array.isArray(block.pageSize) || block.pageSize.length !== 2) {
    throw new Error(`Invalid pageSize for block ${block.id}`);
  }

  validateBboxXYWH(block.bbox, block.pageSize, `block ${block.id}`);
}
