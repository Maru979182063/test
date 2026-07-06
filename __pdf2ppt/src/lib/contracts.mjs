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

  if (!Array.isArray(block.bbox) || block.bbox.length !== 4) {
    throw new Error(`Invalid bbox for block ${block.id}`);
  }

  if (block.pageRole && !PAGE_ROLES.includes(block.pageRole)) {
    throw new Error(`Unsupported page role: ${block.pageRole}`);
  }
}
