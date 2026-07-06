export const BBOX_FORMAT_XYWH = 'xywh_pixel_top_left';

export function parseBboxXYWH(input, context = 'bbox') {
  if (!Array.isArray(input) || input.length !== 4) {
    throw new Error(`Invalid ${context}: expected [x, y, width, height], got ${JSON.stringify(input)}`);
  }

  const bbox = input.map((value) => Number(value));
  if (bbox.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${context}: bbox contains non-finite values: ${JSON.stringify(input)}`);
  }

  return {
    x: bbox[0],
    y: bbox[1],
    width: bbox[2],
    height: bbox[3],
  };
}

export function bboxXYWHToArray(bbox) {
  return [bbox.x, bbox.y, bbox.width, bbox.height];
}

export function bboxXYWHToXYXY(bboxInput, context = 'bbox') {
  const bbox = parseBboxXYWH(
    Array.isArray(bboxInput) ? bboxInput : bboxXYWHToArray(bboxInput),
    context
  );
  return [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height];
}

export function parsePageSize(pageSize, context = 'pageSize') {
  if (!Array.isArray(pageSize) || pageSize.length !== 2) {
    throw new Error(`Invalid ${context}: expected [width, height], got ${JSON.stringify(pageSize)}`);
  }

  const width = Number(pageSize[0]);
  const height = Number(pageSize[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid ${context}: expected positive numbers, got ${JSON.stringify(pageSize)}`);
  }

  return { width, height };
}

export function validateBboxXYWH(bboxInput, pageSize, context = 'bbox') {
  const bbox = parseBboxXYWH(
    Array.isArray(bboxInput) ? bboxInput : bboxXYWHToArray(bboxInput),
    context
  );
  const page = parsePageSize(pageSize);

  if (bbox.width <= 0 || bbox.height <= 0) {
    throw new Error(`Invalid ${context}: width and height must be > 0, got ${JSON.stringify(bboxXYWHToArray(bbox))}`);
  }
  if (bbox.x < 0 || bbox.y < 0) {
    throw new Error(`Invalid ${context}: x and y must be >= 0, got ${JSON.stringify(bboxXYWHToArray(bbox))}`);
  }
  if (bbox.x + bbox.width > page.width || bbox.y + bbox.height > page.height) {
    throw new Error(
      `Invalid ${context}: bbox exceeds page bounds, bbox=${JSON.stringify(bboxXYWHToArray(bbox))}, pageSize=${JSON.stringify(pageSize)}`
    );
  }

  return bbox;
}

export function clampBboxXYWH(bboxInput, pageSize, context = 'bbox') {
  const bbox = parseBboxXYWH(
    Array.isArray(bboxInput) ? bboxInput : bboxXYWHToArray(bboxInput),
    context
  );
  const page = parsePageSize(pageSize);

  const x = Math.min(Math.max(bbox.x, 0), page.width);
  const y = Math.min(Math.max(bbox.y, 0), page.height);
  const right = Math.min(Math.max(bbox.x + bbox.width, 0), page.width);
  const bottom = Math.min(Math.max(bbox.y + bbox.height, 0), page.height);
  const clamped = { x, y, width: right - x, height: bottom - y };

  return validateBboxXYWH(clamped, [page.width, page.height], `${context} (clamped)`);
}

export function expandBboxXYWH(bboxInput, bleedPx, pageSize, context = 'bbox') {
  const bbox = validateBboxXYWH(
    Array.isArray(bboxInput) ? bboxInput : bboxXYWHToArray(bboxInput),
    pageSize,
    context
  );
  const expanded = {
    x: bbox.x - bleedPx,
    y: bbox.y - bleedPx,
    width: bbox.width + bleedPx * 2,
    height: bbox.height + bleedPx * 2,
  };
  return clampBboxXYWH(expanded, pageSize, `${context} (expanded)`);
}

export function unionBboxXYWH(bboxesInput, context = 'bboxes') {
  if (!Array.isArray(bboxesInput) || bboxesInput.length === 0) {
    throw new Error(`Invalid ${context}: expected at least one bbox`);
  }

  const bboxes = bboxesInput.map((bbox, index) =>
    parseBboxXYWH(Array.isArray(bbox) ? bbox : bboxXYWHToArray(bbox), `${context}[${index}]`)
  );

  const left = Math.min(...bboxes.map((bbox) => bbox.x));
  const top = Math.min(...bboxes.map((bbox) => bbox.y));
  const right = Math.max(...bboxes.map((bbox) => bbox.x + bbox.width));
  const bottom = Math.max(...bboxes.map((bbox) => bbox.y + bbox.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function bboxAreaXYWH(bboxInput) {
  const bbox = parseBboxXYWH(
    Array.isArray(bboxInput) ? bboxInput : bboxXYWHToArray(bboxInput)
  );
  return Math.max(0, bbox.width) * Math.max(0, bbox.height);
}

export function intersectionAreaXYWH(aInput, bInput) {
  const a = parseBboxXYWH(Array.isArray(aInput) ? aInput : bboxXYWHToArray(aInput), 'bbox a');
  const b = parseBboxXYWH(Array.isArray(bInput) ? bInput : bboxXYWHToArray(bInput), 'bbox b');
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function overlapRatioXYWH(aInput, bInput) {
  const a = parseBboxXYWH(Array.isArray(aInput) ? aInput : bboxXYWHToArray(aInput), 'bbox a');
  const b = parseBboxXYWH(Array.isArray(bInput) ? bInput : bboxXYWHToArray(bInput), 'bbox b');
  const denom = Math.max(1, Math.min(bboxAreaXYWH(a), bboxAreaXYWH(b)));
  return intersectionAreaXYWH(a, b) / denom;
}

export function xOverlapRatioXYWH(aInput, bInput) {
  const a = parseBboxXYWH(Array.isArray(aInput) ? aInput : bboxXYWHToArray(aInput), 'bbox a');
  const b = parseBboxXYWH(Array.isArray(bInput) ? bInput : bboxXYWHToArray(bInput), 'bbox b');
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  return Math.max(0, right - left) / Math.max(1, Math.min(a.width, b.width));
}

export function verticalGapXYWH(aInput, bInput) {
  const a = parseBboxXYWH(Array.isArray(aInput) ? aInput : bboxXYWHToArray(aInput), 'bbox a');
  const b = parseBboxXYWH(Array.isArray(bInput) ? bInput : bboxXYWHToArray(bInput), 'bbox b');
  return b.y - (a.y + a.height);
}
