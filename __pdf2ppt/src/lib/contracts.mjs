export function createBlock({
  id,
  pageNumber,
  type,
  bbox,
  confidence,
  readingOrder,
  canSplit = false,
  textHint = '',
  groupHint = '',
  pageRole = '',
}) {
  return {
    id,
    pageNumber,
    type,
    bbox,
    confidence,
    readingOrder,
    canSplit,
    textHint,
    groupHint,
    pageRole,
  };
}

export function createSlide({
  slideId,
  title,
  sourcePages,
  placements,
  needsReview = false,
  reviewReasons = [],
}) {
  return {
    slideId,
    title,
    sourcePages,
    placements,
    needsReview,
    reviewReasons,
  };
}
