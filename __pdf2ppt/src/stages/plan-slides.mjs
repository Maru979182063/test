import { fileURLToPath } from 'node:url';
import { mockPlanSlides } from '../adapters/mock-vision-model.mjs';
import { BBOX_FORMAT_XYWH, bboxXYWHToArray, validateBboxXYWH } from '../lib/bbox.mjs';
import { bboxArea, unionBboxes, verticalGap } from '../lib/geometry.mjs';
import { readJson } from '../lib/fs-utils.mjs';

export async function planSlides({ config, blockManifest, pageManifest }) {
  const promptPath = fileURLToPath(
    new URL('../../prompts/slide-planner.md', import.meta.url)
  );
  let result;

  if (config.pipeline.planSlides.mode === 'json-file') {
    if (!config.inputs.slidePlanFile) {
      throw new Error('Missing inputs.slidePlanFile for planSlides json-file mode.');
    }
    result = await readJson(config.inputs.slidePlanFile);
  } else if (config.pipeline.planSlides.mode === 'fit-derived-report') {
    if (!config.inputs.fitDerivedReportFile) {
      throw new Error(
        'Missing inputs.fitDerivedReportFile for planSlides fit-derived-report mode.'
      );
    }
    const report = await readJson(config.inputs.fitDerivedReportFile);
    result = buildSlidesFromDerivedReport(report);
  } else if (config.pipeline.planSlides.mode === 'ark') {
    const { planSlidesWithArk } = await import('../adapters/ark-model.mjs');
    result = await planSlidesWithArk({
      config,
      blockManifest,
      promptPath,
    });
  } else if (config.pipeline.planSlides.mode === 'grouped-rules') {
    result = buildSlidesFromBlocks({
      config,
      blockManifest,
      pageManifest,
    });
  } else if (config.pipeline.planSlides.mode === 'mock') {
    result = await mockPlanSlides(blockManifest, config);
  } else {
    throw new Error(
      `Unsupported planSlides mode "${config.pipeline.planSlides.mode}". Wire your model planner adapter here.`
    );
  }

  const normalized = normalizeSlidePlanResult(result, pageManifest);

  return {
    mode: config.pipeline.planSlides.mode,
    promptTemplate: promptPath,
    sourceSlideSizeEmu: normalized.sourceSlideSizeEmu || null,
    templateDecoration: normalized.templateDecoration || null,
    slides: normalized.slides,
    reviewQueue: normalized.reviewQueue,
  };
}

function normalizeSlidePlanResult(result, pageManifest) {
  const pageByNumber = new Map((pageManifest?.pages || []).map((page) => [page.pageNumber, page]));

  const slides = (result?.slides || []).map((slide, slideIndex) => ({
    ...slide,
    slideId: slide.slideId || `slide-${String(slideIndex + 1).padStart(3, '0')}`,
    sourcePages: Array.isArray(slide.sourcePages) ? slide.sourcePages : [],
    placements: normalizePlacements(slide.placements || [], slide, pageByNumber),
  }));

  const reviewQueue = (result?.reviewQueue || []).map((item) => ({
    ...item,
    reasons: Array.isArray(item.reasons)
      ? item.reasons
      : item.reason
        ? [item.reason]
        : [],
  }));

  return {
    sourceSlideSizeEmu: result?.sourceSlideSizeEmu || null,
    templateDecoration: result?.templateDecoration || null,
    slides,
    reviewQueue,
  };
}

function normalizePlacements(placements, slide, pageByNumber) {
  return placements.map((placement, placementIndex) => {
    const normalized = {
      ...placement,
      placementId:
        placement.placementId ||
        `${slide.slideId || 'slide'}-pl-${String(placementIndex + 1).padStart(2, '0')}`,
    };

    if (!Array.isArray(placement?.bbox) || !placement?.pageNumber) {
      return normalized;
    }

    const page = pageByNumber.get(placement.pageNumber);
    if (!page) {
      throw new Error(
        `Slide placement ${normalized.placementId} points to missing page ${placement.pageNumber}`
      );
    }

    return {
      ...normalized,
      bboxFormat: BBOX_FORMAT_XYWH,
      pageSize: [page.widthPx, page.heightPx],
      bbox: bboxXYWHToArray(
        validateBboxXYWH(
          placement.bbox,
          [page.widthPx, page.heightPx],
          `slide placement ${normalized.placementId}`
        )
      ),
    };
  });
}

function buildSlidesFromDerivedReport(report) {
  const slides = (report.slides || []).map((slide) => ({
    slideId: `slide-${String(slide.slide_index).padStart(3, '0')}`,
    slideIndex: slide.slide_index,
    slideType: slide.slide_type,
    title: slide.text_preview?.[0] || `Slide ${slide.slide_index}`,
    textLines: slide.text_preview || [],
    needsReview: Boolean(slide.needs_review),
    reviewReasons: slide.review_reasons || [],
    sourcePages: slide.source_pages || [],
    placements: flattenPlacements(slide),
  }));

  const reviewQueue = slides
    .filter((slide) => slide.needsReview)
    .map((slide) => ({
      slideId: slide.slideId,
      slideIndex: slide.slideIndex,
      slideType: slide.slideType,
      reasons: slide.reviewReasons,
      sourcePages: slide.sourcePages,
    }));

  const candidate = report.decoration_layer_candidates?.find(
    (item) => item?.canonical_slide_box_emu
  );

  return {
    sourceSlideSizeEmu: report.slide_size_emu || null,
    templateDecoration: candidate
      ? {
          slotName: candidate.slot_name,
          boxEmu: candidate.canonical_slide_box_emu,
        }
      : null,
    slides,
    reviewQueue,
  };
}

function flattenPlacements(slide) {
  const placements = [];
  for (const group of slide.bbox_groups || []) {
    for (const item of group.items || []) {
      placements.push({
        placementId: `slide-${String(slide.slide_index).padStart(3, '0')}-page-${group.page_number}-pic-${String(item.picture_index).padStart(2, '0')}`,
        blockId: `derived-slide-${slide.slide_index}-page-${group.page_number}-pic-${item.picture_index}`,
        source: 'derived-bbox',
        pageNumber: group.page_number,
        bbox: item.bbox,
        targetBoxEmu: item.slide_box_emu || null,
        pictureFile: item.picture_file || null,
      });
    }
  }
  return placements;
}

function buildSlidesFromBlocks({ config, blockManifest, pageManifest }) {
  const slides = [];
  const reviewQueue = [];
  const pagesByNumber = new Map(pageManifest.pages.map((page) => [page.pageNumber, page]));
  const blocksByPage = new Map();
  const segmentationMode = config.pipeline.planSlides.segmentationMode || 'legacy-grouped';

  for (const block of blockManifest.blocks || []) {
    const list = blocksByPage.get(block.pageNumber) || [];
    list.push(block);
    blocksByPage.set(block.pageNumber, list);
  }

  const segments = [];
  for (const pageNumber of [...blocksByPage.keys()].sort((a, b) => a - b)) {
    const page = pagesByNumber.get(pageNumber);
    const blocks = [...(blocksByPage.get(pageNumber) || [])]
      .filter((block) => !isDecorativeBlock(block, page))
      .sort(compareBlocks);
    if (segmentationMode === 'object-first') {
      segments.push(...buildObjectSegments(blocks, page));
    } else {
      segments.push(...buildPageSegments(blocks, page, config));
    }
  }

  const bundles = stitchSegmentsAcrossPages(segments, pagesByNumber, config, segmentationMode);
  let slideIndex = 1;
  for (const bundle of bundles) {
    const slide = buildSlideRecordFromBundle(bundle, slideIndex, pagesByNumber, config);
    slides.push(slide);

    if (slide.reviewReasons.length) {
      reviewQueue.push({
        slideId: slide.slideId,
        slideIndex: slide.slideIndex,
        slideType: slide.slideType,
        reasons: slide.reviewReasons,
        blockIds: bundle.segments.flatMap((segment) => segment.blocks.map((block) => block.id)),
        sourcePages: slide.sourcePages,
      });
    }

    slideIndex += 1;
  }

  return {
    slides,
    reviewQueue,
  };
}

function buildObjectSegments(blocks, page) {
  if (!blocks.length) {
    return [];
  }

  return blocks.map((block) => ({
    pageNumber: page.pageNumber,
    blocks: [block],
    bbox: block.bbox,
    dominantType: normalizeSemanticType(block.type),
    pageRole: normalizePageRole(block.pageRole, block.type),
  }));
}

function buildPageSegments(blocks, page, config) {
  if (!blocks.length) {
    return [];
  }

  const seeded = [];
  let current = [blocks[0]];

  for (const block of blocks.slice(1)) {
    if (shouldBreakBeforeBlock(current, block, page, config)) {
      seeded.push(current);
      current = [block];
    } else {
      current.push(block);
    }
  }
  seeded.push(current);

  const normalized = normalizeSegmentsRaw(seeded, page, config);
  const split = normalized.flatMap((segment) => splitSegmentIfNeeded(segment, page, config));
  const renormalized = normalizeSegmentsRaw(split, page, config);

  return renormalized.map((segment) => segmentArrayToRecord(segment, page));
}

function shouldBreakBeforeBlock(current, nextBlock, page, config) {
  if (!current.length) {
    return false;
  }

  const currentBox = unionBboxes(current.map((block) => block.bbox));
  const currentHeightRatio = currentBox[3] / Math.max(1, page.heightPx);
  const currentCount = current.length;
  const gapRatio = Math.max(0, verticalGap(currentBox, nextBlock.bbox)) / Math.max(1, page.heightPx);
  const sameHint = current.some(
    (block) => block.groupHint && nextBlock.groupHint && block.groupHint === nextBlock.groupHint
  );
  const dominantType = pickDominantType(current);
  const leadTitle = isLeadTitleSegment(current, page, config);

  if (leadTitle && gapRatio < (config.pipeline.planSlides.leadTitleMergeGapRatio ?? 0.05)) {
    return false;
  }

  if (gapRatio >= (config.pipeline.planSlides.hardBreakGapRatio ?? 0.042)) {
    return true;
  }

  if (
    nextBlock.type === 'title' &&
    currentHeightRatio >= 0.1 &&
    gapRatio >= (config.pipeline.planSlides.softBreakGapRatio ?? 0.02) * 0.6
  ) {
    return true;
  }

  if (
    !sameHint &&
    gapRatio >= (config.pipeline.planSlides.hintBreakGapRatio ?? 0.028) &&
    currentHeightRatio >= (config.pipeline.planSlides.hintBreakMinHeightRatio ?? 0.12)
  ) {
    return true;
  }

  if (
    currentCount >= (config.pipeline.planSlides.maxBlocksBeforeBreak ?? 3) &&
    gapRatio >= (config.pipeline.planSlides.softBreakGapRatio ?? 0.02)
  ) {
    return true;
  }

  if (
    currentHeightRatio >= (config.pipeline.planSlides.targetSegmentHeightRatio ?? 0.26) &&
    gapRatio >= (config.pipeline.planSlides.softBreakGapRatio ?? 0.02)
  ) {
    return true;
  }

  if (
    dominantType !== nextBlock.type &&
    gapRatio >= (config.pipeline.planSlides.typeBreakGapRatio ?? 0.022) &&
    currentHeightRatio >= (config.pipeline.planSlides.typeBreakMinHeightRatio ?? 0.14)
  ) {
    return true;
  }

  return false;
}

function normalizeSegmentsRaw(segments, page, config) {
  const normalized = [];

  for (let index = 0; index < segments.length; index += 1) {
    const current = [...segments[index]].sort(compareBlocks);

    if (index < segments.length - 1 && isLeadTitleSegment(current, page, config)) {
      segments[index + 1] = [...current, ...segments[index + 1]].sort(compareBlocks);
      continue;
    }

    if (normalized.length && isTrailingFragmentSegment(current, page, config)) {
      normalized[normalized.length - 1] = [...normalized[normalized.length - 1], ...current].sort(
        compareBlocks
      );
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}

function segmentArrayToRecord(segment, page) {
  return {
    pageNumber: page.pageNumber,
    blocks: [...segment].sort(compareBlocks),
    bbox: unionBboxes(segment.map((block) => block.bbox)),
    dominantType: pickDominantType(segment),
  };
}

function isLeadTitleSegment(segment, page, config) {
  if (pickDominantType(segment) !== 'title') {
    return false;
  }
  const box = unionBboxes(segment.map((block) => block.bbox));
  const topRatio = box[1] / Math.max(1, page.heightPx);
  const heightRatio = box[3] / Math.max(1, page.heightPx);
  return (
    segment.length <= 2 &&
    topRatio < (config.pipeline.planSlides.leadTitleTopRatio ?? 0.22) &&
    heightRatio < (config.pipeline.planSlides.leadTitleHeightRatio ?? 0.14)
  );
}

function isTrailingFragmentSegment(segment, page, config) {
  const box = unionBboxes(segment.map((block) => block.bbox));
  const topRatio = box[1] / Math.max(1, page.heightPx);
  const heightRatio = box[3] / Math.max(1, page.heightPx);
  return (
    segment.length <= 2 &&
    topRatio > (config.pipeline.planSlides.trailingFragmentTopRatio ?? 0.72) &&
    heightRatio < (config.pipeline.planSlides.trailingFragmentHeightRatio ?? 0.12) &&
    pickDominantType(segment) !== 'title'
  );
}

function splitSegmentIfNeeded(segment, page, config, depth = 0) {
  const box = unionBboxes(segment.map((block) => block.bbox));
  const heightRatio = box[3] / Math.max(1, page.heightPx);
  const blockLimit = config.pipeline.planSlides.maxBlocksBeforeBreak ?? 3;

  if (segment.length <= 1) {
    return [segment];
  }
  if (depth >= (config.pipeline.planSlides.maxRecursiveSplitDepth ?? 2)) {
    return [segment];
  }
  if (
    heightRatio <= (config.pipeline.planSlides.maxSegmentHeightRatio ?? 0.32) &&
    segment.length <= blockLimit + 1
  ) {
    return [segment];
  }

  const splitIndex = chooseBestSplitIndex(segment, page, config);
  if (splitIndex <= 0 || splitIndex >= segment.length) {
    if (
      segment.length >= 3 &&
      heightRatio > (config.pipeline.planSlides.maxSegmentHeightRatio ?? 0.32) * 1.2
    ) {
      const midpoint = Math.ceil(segment.length / 2);
      return [
        ...splitSegmentIfNeeded(segment.slice(0, midpoint), page, config, depth + 1),
        ...splitSegmentIfNeeded(segment.slice(midpoint), page, config, depth + 1),
      ];
    }
    return [segment];
  }

  const left = segment.slice(0, splitIndex);
  const right = segment.slice(splitIndex);
  return [
    ...splitSegmentIfNeeded(left, page, config, depth + 1),
    ...splitSegmentIfNeeded(right, page, config, depth + 1),
  ];
}

function chooseBestSplitIndex(segment, page, config) {
  let bestIndex = -1;
  let bestScore = -Infinity;

  for (let index = 1; index < segment.length; index += 1) {
    const prev = segment[index - 1];
    const next = segment[index];
    const gapRatio =
      Math.max(0, next.bbox[1] - (prev.bbox[1] + prev.bbox[3])) / Math.max(1, page.heightPx);
    const left = segment.slice(0, index);
    const right = segment.slice(index);
    let score = gapRatio;

    if (next.type === 'title') score += 0.08;
    if (prev.type === 'title') score += 0.04;
    if (prev.groupHint && next.groupHint && prev.groupHint !== next.groupHint) score += 0.04;
    if (pickDominantType(left) !== pickDominantType(right)) score += 0.03;

    if (
      gapRatio >= (config.pipeline.planSlides.minSplitGapRatio ?? 0.018) ||
      score >= (config.pipeline.planSlides.splitScoreThreshold ?? 0.055)
    ) {
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  }

  return bestIndex;
}

function stitchSegmentsAcrossPages(segments, pagesByNumber, config, segmentationMode) {
  const bundles = [];

  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    const crossPageDecision =
      segmentationMode === 'object-first'
        ? shouldCrossPageMergeObject(current, next, pagesByNumber, config)
        : shouldCrossPageMerge(current, next, pagesByNumber, config);

    if (crossPageDecision.shouldMerge) {
      bundles.push({
        segments: [current, next],
        crossPage: true,
        crossPageReason: crossPageDecision,
      });
      index += 1;
      continue;
    }

    bundles.push({
      segments: [current],
      crossPage: false,
      crossPageReason: null,
    });
  }

  return bundles;
}

function shouldCrossPageMergeObject(current, next, pagesByNumber, config) {
  if (!config.pipeline.planSlides.crossPageEnabled) {
    return { shouldMerge: false, reason: 'cross-page-disabled', strong: false };
  }
  if (!current || !next) {
    return { shouldMerge: false, reason: 'missing-neighbor', strong: false };
  }
  if (next.pageNumber !== current.pageNumber + 1) {
    return { shouldMerge: false, reason: 'not-adjacent-page', strong: false };
  }
  if (!current.blocks.length || !next.blocks.length) {
    return { shouldMerge: false, reason: 'empty-segment', strong: false };
  }

  const left = current.blocks[0];
  const right = next.blocks[0];
  const leftPage = pagesByNumber.get(current.pageNumber);
  const rightPage = pagesByNumber.get(next.pageNumber);
  if (!leftPage || !rightPage) {
    return { shouldMerge: false, reason: 'missing-page', strong: false };
  }

  const blockedTypes = new Set(['cover', 'section_divider', 'overview_map']);
  const leftType = normalizeSemanticType(left.type);
  const rightType = normalizeSemanticType(right.type);
  if (blockedTypes.has(leftType) || blockedTypes.has(rightType)) {
    return { shouldMerge: false, reason: 'non-content-object', strong: false };
  }

  const sameHint =
    left.groupHint &&
    right.groupHint &&
    String(left.groupHint).trim() &&
    String(left.groupHint).trim() === String(right.groupHint).trim();
  const sameType = leftType === rightType;
  const currentBottomRatio = (current.bbox[1] + current.bbox[3]) / Math.max(1, leftPage.heightPx);
  const nextTopRatio = next.bbox[1] / Math.max(1, rightPage.heightPx);
  const currentHeightRatio = current.bbox[3] / Math.max(1, leftPage.heightPx);
  const nextHeightRatio = next.bbox[3] / Math.max(1, rightPage.heightPx);
  const combinedHeightRatio = currentHeightRatio + nextHeightRatio;

  if (
    currentBottomRatio < (config.pipeline.planSlides.crossPageBottomStartRatio ?? 0.72) ||
    nextTopRatio > (config.pipeline.planSlides.crossPageNextTopRatio ?? 0.22)
  ) {
    return { shouldMerge: false, reason: 'cross-page-window-miss', strong: false };
  }

  if (combinedHeightRatio > (config.pipeline.planSlides.crossPageMaxCombinedHeightRatio ?? 0.58)) {
    return { shouldMerge: false, reason: 'cross-page-too-tall', strong: false };
  }

  if (config.pipeline.planSlides.crossPageSameTypeOnly && !sameType && !sameHint) {
    return { shouldMerge: false, reason: 'cross-page-type-mismatch', strong: false };
  }

  if (sameHint && (left.canSplit || right.canSplit)) {
    return { shouldMerge: true, reason: 'cross-page-same-object-hint', strong: true };
  }

  if (sameHint) {
    return { shouldMerge: true, reason: 'cross-page-same-object', strong: true };
  }

  if (sameType && left.canSplit && right.canSplit) {
    return { shouldMerge: true, reason: 'cross-page-dual-continuation', strong: false };
  }

  return { shouldMerge: false, reason: 'cross-page-no-evidence', strong: false };
}

function shouldCrossPageMerge(current, next, pagesByNumber, config) {
  if (!config.pipeline.planSlides.crossPageEnabled) {
    return { shouldMerge: false, reason: 'cross-page-disabled', strong: false };
  }
  if (!current || !next) {
    return { shouldMerge: false, reason: 'missing-neighbor', strong: false };
  }
  if (next.pageNumber !== current.pageNumber + 1) {
    return { shouldMerge: false, reason: 'not-adjacent-page', strong: false };
  }

  const currentPage = pagesByNumber.get(current.pageNumber);
  const nextPage = pagesByNumber.get(next.pageNumber);
  if (!currentPage || !nextPage) {
    return { shouldMerge: false, reason: 'missing-page', strong: false };
  }

  const currentBottomRatio = (current.bbox[1] + current.bbox[3]) / Math.max(1, currentPage.heightPx);
  const nextTopRatio = next.bbox[1] / Math.max(1, nextPage.heightPx);
  const currentHeightRatio = current.bbox[3] / Math.max(1, currentPage.heightPx);
  const nextHeightRatio = next.bbox[3] / Math.max(1, nextPage.heightPx);
  const combinedHeightRatio = currentHeightRatio + nextHeightRatio;
  const sameHint = current.blocks.some((block) =>
    next.blocks.some(
      (candidate) => block.groupHint && candidate.groupHint && block.groupHint === candidate.groupHint
    )
  );
  const titleBridge =
    current.dominantType === 'title' &&
    currentHeightRatio < (config.pipeline.planSlides.crossPageTitleHeightRatio ?? 0.16);
  const contentPair = ['definition', 'example', 'problem_illustration'].includes(current.dominantType)
    && ['definition', 'example', 'problem_illustration'].includes(next.dominantType);

  if (
    nextTopRatio >= (config.pipeline.planSlides.crossPageNextTopRatio ?? 0.22) ||
    combinedHeightRatio >= (config.pipeline.planSlides.crossPageMaxCombinedHeightRatio ?? 0.58)
  ) {
    return { shouldMerge: false, reason: 'cross-page-window-miss', strong: false };
  }

  if (sameHint && currentBottomRatio > (config.pipeline.planSlides.crossPageBottomStartRatio ?? 0.72) * 0.8) {
    return { shouldMerge: true, reason: 'cross-page-same-hint', strong: true };
  }

  if (titleBridge && currentBottomRatio > (config.pipeline.planSlides.crossPageBottomStartRatio ?? 0.72) * 0.7) {
    return { shouldMerge: true, reason: 'cross-page-title-bridge', strong: true };
  }

  if (
    contentPair &&
    currentBottomRatio > (config.pipeline.planSlides.crossPageBottomStartRatio ?? 0.72) &&
    (sameHint || current.blocks.at(-1)?.canSplit || next.blocks[0]?.canSplit)
  ) {
    return { shouldMerge: true, reason: 'cross-page-content-continuation', strong: sameHint };
  }

  return { shouldMerge: false, reason: 'cross-page-no-evidence', strong: false };
}

function buildSlideRecordFromBundle(bundle, slideIndex, pagesByNumber, config) {
  const slideId = `slide-${String(slideIndex).padStart(3, '0')}`;
  const allBlocks = bundle.segments.flatMap((segment) => segment.blocks);
  const dominantType = normalizeSemanticType(pickDominantType(allBlocks));
  const sourcePages = [...new Set(bundle.segments.map((segment) => segment.pageNumber))];
  const reviewReasons = collectReviewReasons(bundle, pagesByNumber, config);
  const pageRole = normalizePageRole(bundle.segments[0]?.pageRole, dominantType);

  return {
    slideId,
    slideIndex,
    slideType: dominantType,
    pageRole,
    title: titleFromBundle(sourcePages[0], dominantType, allBlocks),
    sourcePages,
    textLines: [],
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    placements: bundle.segments.map((segment, placementIndex) => ({
      placementId: `${slideId}-grp-${String(placementIndex + 1).padStart(2, '0')}`,
      blockId: `${slideId}-group-${String(placementIndex + 1).padStart(2, '0')}`,
      pageNumber: segment.pageNumber,
      bbox: segment.bbox,
      groupBlockIds: segment.blocks.map((block) => block.id),
      groupHint: segment.blocks[0]?.groupHint || '',
      dominantType: segment.dominantType,
    })),
  };
}

function collectReviewReasons(bundle, pagesByNumber, config) {
  const reasons = [];
  const allBlocks = bundle.segments.flatMap((segment) => segment.blocks);

  if (allBlocks.some((block) => block.confidence < 0.75)) {
    reasons.push('low-confidence-block');
  }
  if (allBlocks.length > (config.pipeline.planSlides.maxBlocksBeforeBreak ?? 3) + 2) {
    reasons.push('dense-group');
  }
  if (
    bundle.segments.some((segment) => {
      const page = pagesByNumber.get(segment.pageNumber);
      return page && segment.bbox[3] / Math.max(1, page.heightPx) > (config.pipeline.planSlides.maxSegmentHeightRatio ?? 0.32) * 1.15;
    })
  ) {
    reasons.push('tall-group');
  }
  if (allBlocks.some((block) => block.type === 'problem_illustration')) {
    reasons.push('generic-object-type');
  }
  if (bundle.crossPage && bundle.crossPageReason && !bundle.crossPageReason.strong) {
    reasons.push('cross-page-review');
  }

  return [...new Set(reasons)];
}

function isDecorativeBlock(block, page) {
  const hint = `${block.textHint || ''} ${block.groupHint || ''}`.toLowerCase();
  const topRatio = block.bbox[1] / Math.max(1, page.heightPx);
  const areaRatio = bboxArea(block.bbox) / Math.max(1, page.widthPx * page.heightPx);
  if (/(logo|header|页眉|角标)/i.test(hint)) {
    return true;
  }
  if (block.type === 'figure' && topRatio < 0.18 && areaRatio < 0.05) {
    return true;
  }
  return false;
}

function pickDominantType(group) {
  const weights = new Map();
  for (const block of group) {
    const key = normalizeSemanticType(block.type);
    const current = weights.get(key) || 0;
    weights.set(key, current + bboxArea(block.bbox));
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'problem_illustration';
}

function titleFromBundle(pageNumber, dominantType, group) {
  const labelMap = {
    cover: '封面',
    section_divider: '章节过渡',
    overview_map: '本讲概况',
    knowledge_point: '知识梳理',
    example_question: '例题讲解',
    practice_question: '强化训练',
    advanced_question: '能力进阶',
    table_object: '表格内容',
    diagram_object: '图示内容',
    process_object: '流程内容',
    title: 'Title',
    definition: 'Definition',
    example: 'Example',
    derivation: 'Derivation',
    figure: 'Figure',
    problem_illustration: 'Problem',
  };
  const prefix = labelMap[dominantType] || 'Content';
  const hint = group.find((block) => block.textHint)?.textHint || '';
  return hint ? `${prefix} 路 ${hint}` : `Page ${String(pageNumber).padStart(2, '0')} 路 ${prefix}`;
}

function normalizeSemanticType(type) {
  const value = String(type || '').trim();
  const legacyMap = {
    title: 'section_divider',
    definition: 'knowledge_point',
    example: 'example_question',
    derivation: 'process_object',
    figure: 'diagram_object',
    problem_illustration: 'practice_question',
  };
  return legacyMap[value] || value || 'practice_question';
}

function normalizePageRole(pageRole, type) {
  const explicit = String(pageRole || '').trim();
  if (explicit) {
    return explicit;
  }

  const semanticType = normalizeSemanticType(type);
  if (semanticType === 'cover') return 'cover';
  if (semanticType === 'section_divider') return 'section_divider';
  if (semanticType === 'overview_map') return 'overview';
  if (semanticType === 'knowledge_point') return 'knowledge';
  if (semanticType === 'example_question') return 'exercise';
  if (semanticType === 'practice_question') return 'exercise';
  if (semanticType === 'advanced_question') return 'exercise';
  return 'mixed';
}

function compareBlocks(a, b) {
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
  if (a.readingOrder !== b.readingOrder) return a.readingOrder - b.readingOrder;
  return a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
}
