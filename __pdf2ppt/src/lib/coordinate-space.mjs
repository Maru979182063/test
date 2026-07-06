import {
  bboxXYWHToArray,
  parseBboxXYWH,
  parsePageSize,
} from './bbox.mjs';

export function xywhToXyxy(boxInput, context = 'bbox') {
  const box = parseBboxXYWH(
    Array.isArray(boxInput) ? boxInput : bboxXYWHToArray(boxInput),
    context
  );
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

export function xyxyToXywh(boxInput, context = 'bbox') {
  if (!Array.isArray(boxInput) || boxInput.length !== 4) {
    throw new Error(
      `Invalid ${context}: expected [x0, y0, x1, y1], got ${JSON.stringify(boxInput)}`
    );
  }

  const [x0, y0, x1, y1] = boxInput.map((value) => Number(value));
  if ([x0, y0, x1, y1].some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${context}: non-finite xyxy values: ${JSON.stringify(boxInput)}`);
  }
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`Invalid ${context}: xyxy must satisfy x1>x0 and y1>y0`);
  }

  return [x0, y0, x1 - x0, y1 - y0];
}

export function validateXYWH(boxInput, pageW, pageH, options = {}) {
  const context = options.context || 'bbox';
  const strict = options.strict !== false;
  const minAreaRatio = Number(options.minAreaRatio || 0);
  const box = parseBboxXYWH(
    Array.isArray(boxInput) ? boxInput : bboxXYWHToArray(boxInput),
    context
  );
  const page = parsePageSize([pageW, pageH], `${context} pageSize`);
  const warnings = [];
  const errors = [];

  if (box.width <= 0) {
    errors.push(`width must be > 0, got ${box.width}`);
  }
  if (box.height <= 0) {
    errors.push(`height must be > 0, got ${box.height}`);
  }
  if (box.x < 0) {
    errors.push(`x must be >= 0, got ${box.x}`);
  }
  if (box.y < 0) {
    errors.push(`y must be >= 0, got ${box.y}`);
  }
  if (box.x + box.width > page.width) {
    errors.push(
      `x + width exceeds page width (${box.x + box.width} > ${page.width})`
    );
  }
  if (box.y + box.height > page.height) {
    errors.push(
      `y + height exceeds page height (${box.y + box.height} > ${page.height})`
    );
  }

  const areaRatio = (box.width * box.height) / Math.max(1, page.width * page.height);
  if (minAreaRatio > 0 && areaRatio < minAreaRatio) {
    warnings.push(
      `areaRatio ${areaRatio.toFixed(4)} is below threshold ${minAreaRatio.toFixed(4)}`
    );
  }

  if (strict && errors.length) {
    throw new Error(`Invalid ${context}: ${errors.join('; ')}`);
  }

  return {
    bbox: box,
    warnings,
    errors,
    areaRatio,
    valid: errors.length === 0,
  };
}

export function mapModelInputBboxToSourceImageBbox(modelBbox, imageMeta, options = {}) {
  const context = options.context || 'model bbox';
  const original = readImageSize(imageMeta, 'original', context);
  const input = readImageSize(imageMeta, 'input', context);

  const modelValidation = validateXYWH(modelBbox, input.width, input.height, {
    context: `${context} in model input`,
    strict: options.strict !== false,
  });
  const box = modelValidation.bbox;
  const mapped = {
    x: Math.round((box.x * original.width) / input.width),
    y: Math.round((box.y * original.height) / input.height),
    width: Math.round((box.width * original.width) / input.width),
    height: Math.round((box.height * original.height) / input.height),
  };
  const mappedValidation = validateXYWH(mapped, original.width, original.height, {
    context: `${context} mapped to source image`,
    strict: options.strict !== false,
  });

  return {
    bbox: mappedValidation.bbox,
    warnings: [...modelValidation.warnings, ...mappedValidation.warnings],
    errors: [...modelValidation.errors, ...mappedValidation.errors],
    originalPageSize: [original.width, original.height],
    modelInputSize: [input.width, input.height],
  };
}

export function mapRefineBboxToPageBbox(
  refineModelBbox,
  refineImageMeta,
  parentCropBbox,
  options = {}
) {
  const parent = parseBboxXYWH(parentCropBbox, options.parentContext || 'parent crop bbox');
  const local = mapModelInputBboxToSourceImageBbox(refineModelBbox, refineImageMeta, {
    context: options.context || 'refine bbox',
    strict: options.strict !== false,
  });
  const pageBox = {
    x: parent.x + local.bbox.x,
    y: parent.y + local.bbox.y,
    width: local.bbox.width,
    height: local.bbox.height,
  };

  if (Array.isArray(options.pageSize) && options.pageSize.length === 2) {
    const page = parsePageSize(options.pageSize, `${options.context || 'refine bbox'} pageSize`);
    const pageValidation = validateXYWH(pageBox, page.width, page.height, {
      context: `${options.context || 'refine bbox'} mapped to page`,
      strict: options.strict !== false,
    });
    return {
      bbox: pageValidation.bbox,
      warnings: [...local.warnings, ...pageValidation.warnings],
      errors: [...local.errors, ...pageValidation.errors],
      localBbox: local.bbox,
    };
  }

  return {
    bbox: pageBox,
    warnings: [...local.warnings],
    errors: [...local.errors],
    localBbox: local.bbox,
  };
}

export function buildBlockImageMeta({
  originalPageSize,
  modelInputSize,
  maxImageSidePx = 0,
  detail = 'high',
  imagePixelLimit = null,
}) {
  const original = parsePageSize(originalPageSize, 'originalPageSize');
  const input = parsePageSize(modelInputSize, 'modelInputSize');
  const scaleX = input.width / original.width;
  const scaleY = input.height / original.height;
  return {
    originalPageSize: [original.width, original.height],
    modelInputSize: [input.width, input.height],
    localResize: {
      enabled: Math.abs(scaleX - 1) > 1e-9 || Math.abs(scaleY - 1) > 1e-9,
      scaleX,
      scaleY,
      maxImageSidePx: maxImageSidePx || null,
    },
    ark: {
      detail,
      imagePixelLimit: imagePixelLimit || null,
    },
  };
}

export function readImageSize(imageMeta, kind, context = 'imageMeta') {
  const source =
    kind === 'original'
      ? imageMeta?.originalPageSize || [imageMeta?.originalW, imageMeta?.originalH]
      : imageMeta?.modelInputSize || [imageMeta?.inputW, imageMeta?.inputH];
  return parsePageSize(source, `${context} ${kind} image size`);
}
