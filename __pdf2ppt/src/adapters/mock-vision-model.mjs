import { BLOCK_TYPES } from '../lib/contracts.mjs';

export async function mockDetectBlocks(pageManifest) {
  const blocks = [];

  for (const page of pageManifest.pages) {
    const marginX = Math.round(page.widthPx * 0.05);
    const marginY = Math.round(page.heightPx * 0.04);
    const usableWidth = page.widthPx - marginX * 2;
    const titleHeight = Math.round(page.heightPx * 0.12);
    const bodyHeight = Math.round(page.heightPx * 0.3);
    const lowerHeight = Math.round(page.heightPx * 0.38);

    blocks.push({
      id: blockId(page.pageNumber, 1),
      pageNumber: page.pageNumber,
      type: page.pageNumber === 1 ? 'title' : 'definition',
      bbox: [marginX, marginY, usableWidth, titleHeight],
      confidence: 0.96,
      readingOrder: 1,
      canSplit: false,
      textHint: page.pageNumber === 1 ? 'lesson title' : 'top semantic block',
      groupHint: `page-${page.pageNumber}-top`,
    });

    blocks.push({
      id: blockId(page.pageNumber, 2),
      pageNumber: page.pageNumber,
      type: 'example',
      bbox: [
        marginX,
        marginY + titleHeight + Math.round(page.heightPx * 0.03),
        usableWidth,
        bodyHeight,
      ],
      confidence: 0.88,
      readingOrder: 2,
      canSplit: false,
      textHint: 'mid content block',
      groupHint: `page-${page.pageNumber}-mid`,
    });

    blocks.push({
      id: blockId(page.pageNumber, 3),
      pageNumber: page.pageNumber,
      type: 'problem_illustration',
      bbox: [
        marginX,
        page.heightPx - marginY - lowerHeight,
        usableWidth,
        lowerHeight,
      ],
      confidence: 0.84,
      readingOrder: 3,
      canSplit: lowerHeight > Math.round(page.heightPx * 0.42),
      textHint: 'lower content block',
      groupHint: `page-${page.pageNumber}-bottom`,
    });
  }

  return blocks.map((block) => ({
    ...block,
    type: BLOCK_TYPES.includes(block.type) ? block.type : 'problem_illustration',
  }));
}

export async function mockPlanSlides(blockManifest, config) {
  const blocksById = new Map(blockManifest.blocks.map((block) => [block.id, block]));
  const maxBlocksPerSlide = Math.max(1, config.pipeline.planSlides.maxBlocksPerSlide ?? 1);
  const ordered = [...blockManifest.blocks].sort(compareBlocks);
  const slides = [];
  const reviewQueue = [];
  let slideIndex = 1;

  for (let i = 0; i < ordered.length; i += maxBlocksPerSlide) {
    const group = ordered.slice(i, i + maxBlocksPerSlide);
    const sourcePages = [...new Set(group.map((block) => block.pageNumber))];

    slides.push({
      slideId: `s${String(slideIndex).padStart(3, '0')}`,
      title: titleFromBlock(group[0]),
      sourcePages,
      placements: group.map((block) => ({ blockId: block.id })),
    });

    for (const block of group) {
      if (block.confidence < (config.pipeline.detectBlocks.confidenceThreshold ?? 0.8)) {
        reviewQueue.push({
          reason: 'low-confidence-detection',
          blockIds: [block.id],
        });
      }

      const [, , , height] = block.bbox;
      const page = blockManifest.pagesByNumber[block.pageNumber];
      if (page && height / page.heightPx > 0.6) {
        reviewQueue.push({
          reason: 'tall-block-may-need-split',
          blockIds: [block.id],
        });
      }
    }

    slideIndex += 1;
  }

  for (const slide of slides) {
    if (slide.sourcePages.length > 1) {
      reviewQueue.push({
        reason: 'cross-page-slide',
        blockIds: slide.placements.map((placement) => placement.blockId),
      });
    }
  }

  return {
    slides,
    reviewQueue,
    blocksById,
  };
}

function blockId(pageNumber, index) {
  return `p${String(pageNumber).padStart(3, '0')}-b${String(index).padStart(2, '0')}`;
}

function compareBlocks(a, b) {
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
  return a.readingOrder - b.readingOrder;
}

function titleFromBlock(block) {
  switch (block.type) {
    case 'title':
      return 'Title';
    case 'definition':
      return 'Definition';
    case 'example':
      return 'Example';
    case 'derivation':
      return 'Derivation';
    case 'figure':
      return 'Figure';
    default:
      return 'Problem';
  }
}
