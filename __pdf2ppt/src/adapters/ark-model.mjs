import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BBOX_FORMAT_XYWH, bboxXYWHToArray, parseBboxXYWH } from '../lib/bbox.mjs';
import {
  bboxArea,
  expandBbox,
  overlapRatio,
  unionBboxes,
  validateXYWH,
} from '../lib/geometry.mjs';
import {
  buildBlockImageMeta,
  mapModelInputBboxToSourceImageBbox,
  mapRefineBboxToPageBbox,
} from '../lib/coordinate-space.mjs';

const QUESTION_TYPES = new Set([
  'practice_question',
  'example_question',
  'advanced_question',
]);

const FRAGMENT_HINT_RE =
  /(option\s*[abcd]|choice\s*[abcd]|选项\s*[abcd]|上一题|局部|半题|左侧|右侧|题干[、,\s]*[abcd]|fragment|partial)/i;
const QUESTION_HINT_RE = /(练习|例题|题|question|problem|exercise)/i;

export async function checkArkProvider(provider) {
  const json = await createArkJsonResponse({
    provider,
    systemPrompt: 'Return JSON only.',
    userText: 'Return {"ok":true,"provider":"ark"}',
    images: [],
    debugLabel: 'provider-check',
  });

  return {
    ok: true,
    provider: provider.type,
    model: provider.model,
    apiStyle: provider.apiStyle,
    response: json,
  };
}

export async function listArkModels(provider) {
  if (!provider.apiKey) {
    throw new Error('Missing Ark API key for model listing.');
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
    },
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Ark model list failed: ${response.status} ${rawText}`);
  }

  const payload = JSON.parse(rawText);
  const models = Array.isArray(payload.data) ? payload.data : [];
  return {
    total: models.length,
    visionModels: models.filter((model) => {
      const modalities = model.modalities?.input_modalities || [];
      return modalities.includes('image') || model.domain === 'VLM';
    }),
    allModels: models,
  };
}

export async function detectBlocksWithArk({ config, pageManifest, promptPath, dirs }) {
  const systemPrompt = await fs.readFile(promptPath, 'utf8');
  const blocks = [];
  const arkDebugDir = dirs?.debug ? path.join(dirs.debug, 'ark-logs') : '';

  for (const page of pageManifest.pages) {
    const pageImage = await imageFileToDataUrl(page.imagePath, config.provider.maxImageSidePx);
    const imagePixelLimit = buildImagePixelLimit(config.provider, pageImage);
    const userText = buildPass1UserText(page, pageImage);
    const json = await createArkJsonResponse({
      provider: config.provider,
      systemPrompt,
      userText,
      images: [
        {
          ...pageImage,
          detail: config.provider.imageDetail,
          imagePixelLimit,
        },
      ],
      debugLabel: `block-detect-page-${page.pageNumber}`,
      debugDir: arkDebugDir,
    });

    const pageBlocks = normalizePass1Blocks({
      blocks: Array.isArray(json.blocks) ? json.blocks : [],
      page,
      pageImage,
      detail: config.provider.imageDetail,
      imagePixelLimit,
      pageRole: json.pageRole,
    });

    await writePass1DebugArtifacts({
      config,
      dirs,
      page,
      pageImage,
      blocks: pageBlocks,
    });

    blocks.push(...pageBlocks);
  }

  return blocks;
}

export async function detectBlocksTwoPassWithArk({
  config,
  pageManifest,
  promptPath,
  refinePromptPath,
  dirs,
}) {
  const coarsePrompt = await fs.readFile(promptPath, 'utf8');
  const refinePrompt = await fs.readFile(refinePromptPath, 'utf8');
  const blocks = [];
  const refineDebugDir = path.join(dirs.debug, 'refine-crops');
  const arkDebugDir = dirs?.debug ? path.join(dirs.debug, 'ark-logs') : '';
  await fs.mkdir(refineDebugDir, { recursive: true });

  for (const page of pageManifest.pages) {
    const pageImage = await imageFileToDataUrl(
      page.imagePath,
      config.provider.maxImageSidePx || 1800
    );
    const imagePixelLimit = buildImagePixelLimit(config.provider, pageImage);
    const coarseJson = await createArkJsonResponse({
      provider: config.provider,
      systemPrompt: coarsePrompt,
      userText: buildPass1UserText(page, pageImage),
      images: [
        {
          ...pageImage,
          detail: config.provider.imageDetail,
          imagePixelLimit,
        },
      ],
      debugLabel: `block-detect-pass1-page-${page.pageNumber}`,
      debugDir: arkDebugDir,
    });

    const coarseBlocks = normalizePass1Blocks({
      blocks: Array.isArray(coarseJson.blocks) ? coarseJson.blocks : [],
      page,
      pageImage,
      detail: config.provider.imageDetail,
      imagePixelLimit,
      pageRole: coarseJson.pageRole,
      sourceStage: 'coarse',
      defaultIdPrefix: `p${String(page.pageNumber).padStart(3, '0')}-c`,
    }).filter((block) => isUsableBlock(block, page));

    await writePass1DebugArtifacts({
      config,
      dirs,
      page,
      pageImage,
      blocks: coarseBlocks,
    });

    const refineTargets = coarseBlocks
      .filter((block) => shouldRefineBlock(block, page, config))
      .sort((a, b) => refinePriority(b, page) - refinePriority(a, page))
      .slice(0, config.pipeline.detectBlocks.maxRefinePerPage ?? 3)
      .map((block) => block.id);
    const refineTargetSet = new Set(refineTargets);

    for (const [index, coarseBlock] of coarseBlocks.entries()) {
      if (!refineTargetSet.has(coarseBlock.id)) {
        blocks.push(withRefineStatus(coarseBlock, false, false, []));
        continue;
      }

      const refined = await refineCoarseBlock({
        config,
        page,
        coarseBlock,
        refinePrompt,
        refineIndex: index + 1,
        refineDebugDir,
        dirs,
        arkDebugDir,
      });

      if (refined.blocks.length) {
        blocks.push(...refined.blocks);
      } else {
        blocks.push(withRefineStatus(coarseBlock, true, true, refined.rejectReasons));
      }
    }
  }

  return dedupeBlocks(blocks, pageManifest);
}

export async function planSlidesWithArk({ config, blockManifest, promptPath }) {
  const systemPrompt = await fs.readFile(promptPath, 'utf8');
  const userText = [
    'The following JSON contains already-detected teaching blocks.',
    'Return JSON only.',
    JSON.stringify(
      {
        blocks: blockManifest.blocks,
      },
      null,
      2
    ),
  ].join('\n\n');

  const json = await createArkJsonResponse({
    provider: config.provider,
    systemPrompt,
    userText,
    images: [],
    debugLabel: 'slide-plan',
    debugDir: config.outputDir ? path.join(config.outputDir, 'debug', 'ark-logs') : '',
  });

  return {
    slides: Array.isArray(json.slides) ? json.slides : [],
    reviewQueue: Array.isArray(json.reviewQueue) ? json.reviewQueue : [],
  };
}

export function shouldRejectRefineResult(refinedBlocks, coarseBlock, refineContext) {
  const reasons = [];
  if (!Array.isArray(refinedBlocks) || refinedBlocks.length === 0) {
    reasons.push('empty-refine-result');
    return reasons;
  }

  const inputW = Number(refineContext?.inputSize?.[0] || 0);
  const inputH = Number(refineContext?.inputSize?.[1] || 0);
  if (inputW > 0 && inputH > 0) {
    const modelBoxes = refinedBlocks.map((block) => block.refineModelBbox || block.modelBbox);
    const union = unionBboxes(modelBoxes);
    if (union[0] <= 3 && union[1] <= 3 && union[2] >= inputW * 0.95 && union[3] >= inputH * 0.95) {
      reasons.push('refine-union-nearly-full-input');
    }
  }

  const coarseHint = `${coarseBlock?.textHint || ''}`.trim();
  const coarseQuestionish = QUESTION_TYPES.has(coarseBlock?.type) || QUESTION_HINT_RE.test(coarseHint);
  const fragmentHints = refinedBlocks
    .map((block) => `${block.textHint || ''}`.trim())
    .filter((text) => FRAGMENT_HINT_RE.test(text));
  if (coarseQuestionish && fragmentHints.length) {
    reasons.push('refine-fragment-like-text');
  }
  if (coarseQuestionish && fragmentHints.length && QUESTION_HINT_RE.test(coarseHint)) {
    reasons.push('refine-semantic-degradation');
  }

  return [...new Set(reasons)];
}

export async function imageFileToDataUrl(filePath, maxSidePx) {
  const image = await loadImage(filePath);
  const originalW = image.width;
  const originalH = image.height;
  const longestSide = Math.max(originalW, originalH);
  const mimeType = mimeTypeForPath(filePath);
  let inputW = originalW;
  let inputH = originalH;
  let resized = false;
  let buffer;
  let outputMimeType = mimeType;

  if (!maxSidePx || longestSide <= maxSidePx) {
    buffer = await fs.readFile(filePath);
  } else {
    resized = true;
    const scale = maxSidePx / longestSide;
    inputW = Math.max(1, Math.round(originalW * scale));
    inputH = Math.max(1, Math.round(originalH * scale));
    const canvas = createCanvas(inputW, inputH);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, inputW, inputH);
    buffer = canvas.toBuffer('image/png');
    outputMimeType = 'image/png';
  }

  const sha1 = createHash('sha1').update(buffer).digest('hex');
  return {
    dataUrl: `data:${outputMimeType};base64,${buffer.toString('base64')}`,
    mimeType: outputMimeType,
    originalW,
    originalH,
    inputW,
    inputH,
    resized,
    scaleX: inputW / originalW,
    scaleY: inputH / originalH,
    maxSidePx: maxSidePx || null,
    sha1,
    inputBuffer: buffer,
  };
}

function buildPass1UserText(page, imageMeta) {
  return [
    `Page number: ${page.pageNumber}`,
    `Input image size: ${imageMeta.inputW}x${imageMeta.inputH}`,
    `Original page size: ${page.widthPx}x${page.heightPx}`,
    'Return teaching blocks suitable for direct PPT crops.',
    'Return bbox relative to the input image size, not the original page size.',
    'bboxFormat must be "xywh_pixel_top_left".',
    'bbox = [x, y, width, height].',
    'Do not return [x0, y0, x1, y1].',
    'Do not return normalized 0-1000 coordinates.',
    'components can be fine-grained parts, but final blocks must be complete slideRegions.',
    'Return JSON only.',
  ].join('\n');
}

function buildRefineUserText({ page, parentCropBbox, refineImageMeta, coarseBlock }) {
  return [
    `Page number: ${page.pageNumber}`,
    'This input image is a coarse crop, not the full page.',
    `Input image size: ${refineImageMeta.inputW}x${refineImageMeta.inputH}`,
    `Refine source size: ${refineImageMeta.originalW}x${refineImageMeta.originalH}`,
    `Original page size: ${page.widthPx}x${page.heightPx}`,
    `Parent crop bbox on original page: ${JSON.stringify(parentCropBbox)}`,
    `Parent coarse block type: ${coarseBlock.type}`,
    'Return bbox relative to the current refine input image only.',
    'bboxFormat must be "xywh_pixel_top_left".',
    'bbox = [x, y, width, height].',
    'Do not return full-page coordinates.',
    'Do not return [x0, y0, x1, y1].',
    'Do not return normalized 0-1000 coordinates.',
    'If the whole crop should stay as one semantic unit, return one block only.',
    'Return JSON only.',
  ].join('\n');
}

async function createArkJsonResponse({
  provider,
  systemPrompt,
  userText,
  images,
  debugLabel,
  debugDir = '',
}) {
  if (!provider.apiKey) {
    throw new Error(`Missing Ark API key for ${debugLabel}.`);
  }

  const apiStyle = provider.apiStyle || 'auto';
  const errors = [];

  if (apiStyle === 'responses' || apiStyle === 'auto') {
    try {
      return await createResponsesApiJsonResponse({
        provider,
        systemPrompt,
        userText,
        images,
        debugLabel,
        debugDir,
      });
    } catch (error) {
      errors.push(`responses: ${error.message}`);
      if (apiStyle === 'responses') {
        throw error;
      }
    }
  }

  if (apiStyle === 'chat' || apiStyle === 'auto') {
    try {
      return await createChatApiJsonResponse({
        provider,
        systemPrompt,
        userText,
        images,
        debugLabel,
        debugDir,
      });
    } catch (error) {
      errors.push(`chat: ${error.message}`);
      throw new Error(`Ark request failed for ${debugLabel}\n${errors.join('\n')}`);
    }
  }

  throw new Error(`Unsupported Ark apiStyle: ${apiStyle}`);
}

async function createResponsesApiJsonResponse({
  provider,
  systemPrompt,
  userText,
  images,
  debugLabel,
  debugDir,
}) {
  const baseInput = [];

  if (systemPrompt) {
    baseInput.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: systemPrompt,
        },
      ],
    });
  }

  const pixelLimitEnabled = images.some((image) => Boolean(image.imagePixelLimit?.enabled));
  for (const includePixelLimit of pixelLimitEnabled ? [true, false] : [false]) {
    const input = [
      ...baseInput,
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: userText,
          },
          ...images.map((image) =>
            buildResponsesImagePayload(image, includePixelLimit)
          ),
        ],
      },
    ];

    const requestPayload = {
      model: provider.model,
      input,
      max_output_tokens: provider.maxOutputTokens,
    };
    await writeArkDebug(debugDir, debugLabel, 'request.json', {
      endpoint: 'responses',
      model: provider.model,
      systemPrompt,
      userText,
      maxOutputTokens: provider.maxOutputTokens,
      imageCount: images.length,
      imageMeta: images.map((image) => summarizeImageForLog(image, includePixelLimit)),
      retryWithoutImagePixelLimit: pixelLimitEnabled && !includePixelLimit,
    });

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const rawText = await response.text();
    await writeArkDebug(debugDir, debugLabel, 'response.txt', rawText);
    if (!response.ok) {
      if (includePixelLimit && shouldRetryWithoutImagePixelLimit(response.status, rawText)) {
        await writeArkDebug(debugDir, debugLabel, 'retry.json', {
          reason: 'image_pixel_limit_rejected',
          status: response.status,
          rawText,
        });
        continue;
      }
      throw new Error(`Ark request failed for ${debugLabel}: ${response.status} ${rawText}`);
    }

    const payload = JSON.parse(rawText);
    const text = extractResponseText(payload);
    if (!text) {
      throw new Error(`Ark returned no text for ${debugLabel}.`);
    }

    try {
      const parsed = parseModelJson(text);
      await writeArkDebug(debugDir, debugLabel, 'response.json', parsed);
      return parsed;
    } catch (error) {
      throw new Error(`Ark JSON parse failed for ${debugLabel}: ${error.message}\nRaw: ${text}`);
    }
  }

  throw new Error(`Ark request failed for ${debugLabel}: image_pixel_limit retry exhausted`);
}

async function createChatApiJsonResponse({
  provider,
  systemPrompt,
  userText,
  images,
  debugLabel,
  debugDir,
}) {
  const normalizedSystemPrompt = /json/i.test(systemPrompt || '')
    ? systemPrompt
    : `${systemPrompt || ''}\nReturn JSON only.`;
  const normalizedUserText = /json/i.test(userText || '')
    ? userText
    : `${userText}\nReturn JSON only.`;
  const pixelLimitEnabled = images.some((image) => Boolean(image.imagePixelLimit?.enabled));

  for (const includePixelLimit of pixelLimitEnabled ? [true, false] : [false]) {
    const messages = [];
    if (normalizedSystemPrompt) {
      messages.push({
        role: 'system',
        content: normalizedSystemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: normalizedUserText,
        },
        ...images.map((image) => buildChatImagePayload(image, includePixelLimit)),
      ],
    });

    const requestPayload = {
      model: provider.model,
      messages,
      max_tokens: provider.maxOutputTokens,
      response_format: {
        type: 'json_object',
      },
    };

    await writeArkDebug(debugDir, debugLabel, 'request.json', {
      endpoint: 'chat/completions',
      model: provider.model,
      systemPrompt: normalizedSystemPrompt,
      userText: normalizedUserText,
      maxTokens: provider.maxOutputTokens,
      imageCount: images.length,
      imageMeta: images.map((image) => summarizeImageForLog(image, includePixelLimit)),
      retryWithoutImagePixelLimit: pixelLimitEnabled && !includePixelLimit,
    });

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const rawText = await response.text();
    await writeArkDebug(debugDir, debugLabel, 'response.txt', rawText);
    if (!response.ok) {
      if (includePixelLimit && shouldRetryWithoutImagePixelLimit(response.status, rawText)) {
        await writeArkDebug(debugDir, debugLabel, 'retry.json', {
          reason: 'image_pixel_limit_rejected',
          status: response.status,
          rawText,
        });
        continue;
      }
      throw new Error(`Ark chat failed for ${debugLabel}: ${response.status} ${rawText}`);
    }

    const payload = JSON.parse(rawText);
    const text = payload.choices?.[0]?.message?.content || '';
    if (!text) {
      throw new Error(`Ark chat returned no text for ${debugLabel}.`);
    }

    try {
      const parsed = parseModelJson(text);
      await writeArkDebug(debugDir, debugLabel, 'response.json', parsed);
      return parsed;
    } catch (error) {
      throw new Error(`Ark chat JSON parse failed for ${debugLabel}: ${error.message}\nRaw: ${text}`);
    }
  }

  throw new Error(`Ark chat failed for ${debugLabel}: image_pixel_limit retry exhausted`);
}

function buildResponsesImagePayload(image, includePixelLimit) {
  const payload = {
    type: 'input_image',
    image_url: image.dataUrl,
    detail: image.detail || 'high',
  };
  if (includePixelLimit && image.imagePixelLimit?.payload) {
    payload.image_pixel_limit = image.imagePixelLimit.payload;
  }
  return payload;
}

function buildChatImagePayload(image, includePixelLimit) {
  const payload = {
    type: 'image_url',
    image_url: {
      url: image.dataUrl,
      detail: image.detail || 'high',
    },
  };
  if (includePixelLimit && image.imagePixelLimit?.payload) {
    payload.image_url.image_pixel_limit = image.imagePixelLimit.payload;
  }
  return payload;
}

function summarizeImageForLog(image, includePixelLimit) {
  return {
    originalW: image.originalW,
    originalH: image.originalH,
    inputW: image.inputW,
    inputH: image.inputH,
    resized: image.resized,
    scaleX: image.scaleX,
    scaleY: image.scaleY,
    maxSidePx: image.maxSidePx,
    detail: image.detail || 'high',
    sha1: image.sha1,
    imagePixelLimit:
      includePixelLimit && image.imagePixelLimit
        ? {
            enabled: image.imagePixelLimit.enabled,
            min_pixels: image.imagePixelLimit.payload?.min_pixels,
            max_pixels: image.imagePixelLimit.payload?.max_pixels,
          }
        : {
            enabled: false,
          },
  };
}

function buildImagePixelLimit(provider, imageMeta) {
  const config = provider.imagePixelLimit || {};
  if (!config.enabled) {
    return { enabled: false, payload: null };
  }

  const tolerance = Number(config.tolerance ?? 0.02);
  const pixels = imageMeta.inputW * imageMeta.inputH;
  return {
    enabled: true,
    mode: config.mode || 'match_model_input',
    tolerance,
    payload: {
      min_pixels: Math.floor(pixels * (1 - tolerance)),
      max_pixels: Math.ceil(pixels * (1 + tolerance)),
    },
  };
}

function shouldRetryWithoutImagePixelLimit(status, rawText) {
  if (status < 400 || status >= 500) {
    return false;
  }
  return /(image_pixel_limit|unknown field|unsupported|unexpected|invalid)/i.test(
    String(rawText || '')
  );
}

function normalizePass1Blocks({
  blocks,
  page,
  pageImage,
  detail,
  imagePixelLimit,
  pageRole,
  sourceStage = 'direct',
  defaultIdPrefix = `p${String(page.pageNumber).padStart(3, '0')}-b`,
}) {
  return blocks.map((block, index) =>
    normalizeDetectedBlock({
      block,
      pageNumber: page.pageNumber,
      index: index + 1,
      mappedBboxResult: mapModelInputBboxToSourceImageBbox(block.bbox, pageImage, {
        context: `page ${page.pageNumber} block ${index + 1}`,
      }),
      imageMeta: buildBlockImageMeta({
        originalPageSize: [page.widthPx, page.heightPx],
        modelInputSize: [pageImage.inputW, pageImage.inputH],
        maxImageSidePx: pageImage.maxSidePx,
        detail,
        imagePixelLimit: imagePixelLimit.enabled ? imagePixelLimit.payload : null,
      }),
      modelBbox: validateXYWH(block.bbox, pageImage.inputW, pageImage.inputH, {
        context: `page ${page.pageNumber} model bbox ${index + 1}`,
      }).bbox,
      pageRole,
      sourceStage,
      defaultIdPrefix,
    })
  );
}

function normalizeDetectedBlock({
  block,
  pageNumber,
  index,
  mappedBboxResult,
  imageMeta,
  modelBbox,
  pageRole,
  sourceStage,
  defaultIdPrefix,
  extra = {},
}) {
  const normalizedType = block.objectType || block.type || 'problem_illustration';
  const fallbackId = `${defaultIdPrefix}${String(index).padStart(2, '0')}`;
  return {
    id: block.id || fallbackId,
    pageNumber,
    type: normalizedType,
    bbox: bboxXYWHToArray(mappedBboxResult.bbox),
    bboxFormat: BBOX_FORMAT_XYWH,
    coordinateSpace: 'original_page_image',
    modelBbox: bboxXYWHToArray(modelBbox),
    modelCoordinateSpace: 'model_input_image',
    imageMeta,
    confidence: clamp01(block.confidence),
    readingOrder: Number(block.readingOrder) || index,
    canSplit: Boolean(block.canSplit),
    textHint: typeof block.textHint === 'string' ? block.textHint : '',
    pageRole: normalizeExternalPageRole(
      typeof block.pageRole === 'string' ? block.pageRole : pageRole || ''
    ),
    keepFullPageWidth: block.keepFullPageWidth !== false,
    groupHint:
      typeof block.groupHint === 'string' && block.groupHint.trim()
        ? block.groupHint.trim()
        : fallbackId,
    sourceStage,
    validation: {
      warnings: mappedBboxResult.warnings,
      errors: mappedBboxResult.errors,
    },
    ...extra,
  };
}

async function writePass1DebugArtifacts({ config, dirs, page, pageImage, blocks }) {
  if (!config.debug?.enabled || !config.debug?.writeModelInputCopies) {
    return;
  }

  const rawModelInputPath = path.join(
    dirs.debug,
    `page_${String(page.pageNumber).padStart(3, '0')}_raw_model_input.png`
  );
  await fs.writeFile(rawModelInputPath, ensurePngBuffer(pageImage));

  const overlayOnModelInputPath = path.join(
    dirs.debug,
    `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_model_input.png`
  );
  await drawOverlayFromBuffer({
    imageBuffer: ensurePngBuffer(pageImage),
    blocks: blocks.map((block) => ({
      label: `${block.id} ${block.type}`,
      bbox: block.modelBbox,
    })),
    outputPath: overlayOnModelInputPath,
  });

  const overlayOnOriginalPagePath = path.join(
    dirs.debug,
    `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_original_page.png`
  );
  await drawOverlayOnImage({
    imagePath: page.imagePath,
    blocks: blocks.map((block) => ({
      label: `${block.id} ${block.type}`,
      bbox: block.bbox,
    })),
    outputPath: overlayOnOriginalPagePath,
  });
}

async function refineCoarseBlock({
  config,
  page,
  coarseBlock,
  refinePrompt,
  refineIndex,
  refineDebugDir,
  dirs,
  arkDebugDir,
}) {
  const bleedPx = config.pipeline.detectBlocks.refineBleedPx ?? 24;
  const parentCropBbox = expandBbox(coarseBlock.bbox, bleedPx, page.widthPx, page.heightPx);
  const cropFile = path.join(
    refineDebugDir,
    `page-${String(page.pageNumber).padStart(2, '0')}_coarse-${String(refineIndex).padStart(2, '0')}.png`
  );
  await cropImageRegionToFile(page.imagePath, parentCropBbox, cropFile);
  const refineImageMeta = await imageFileToDataUrl(cropFile, config.provider.maxImageSidePx || 1800);
  const imagePixelLimit = buildImagePixelLimit(config.provider, refineImageMeta);
  const refinedJson = await createArkJsonResponse({
    provider: config.provider,
    systemPrompt: refinePrompt,
    userText: buildRefineUserText({
      page,
      parentCropBbox,
      refineImageMeta,
      coarseBlock,
    }),
    images: [
      {
        ...refineImageMeta,
        detail: config.provider.imageDetail,
        imagePixelLimit,
      },
    ],
    debugLabel: `block-detect-pass2-page-${page.pageNumber}-coarse-${refineIndex}`,
    debugDir: arkDebugDir,
  });

  const rawBlocks = Array.isArray(refinedJson.blocks) ? refinedJson.blocks : [];
  const refinedBlocks = rawBlocks
    .map((block, index) => {
      const refineModelValidation = validateXYWH(
        block.bbox,
        refineImageMeta.inputW,
        refineImageMeta.inputH,
        {
          context: `refine block ${index + 1} for coarse ${coarseBlock.id}`,
        }
      );
      const mapped = mapRefineBboxToPageBbox(
        refineModelValidation.bbox,
        refineImageMeta,
        parentCropBbox,
        {
          context: `refine block ${index + 1} for coarse ${coarseBlock.id}`,
          pageSize: [page.widthPx, page.heightPx],
        }
      );
      return normalizeDetectedBlock({
        block,
        pageNumber: page.pageNumber,
        index: index + 1,
        mappedBboxResult: mapped,
        imageMeta: buildBlockImageMeta({
          originalPageSize: [page.widthPx, page.heightPx],
          modelInputSize: [refineImageMeta.inputW, refineImageMeta.inputH],
          maxImageSidePx: refineImageMeta.maxSidePx,
          detail: config.provider.imageDetail,
          imagePixelLimit: imagePixelLimit.enabled ? imagePixelLimit.payload : null,
        }),
        modelBbox: refineModelValidation.bbox,
        pageRole: coarseBlock.pageRole,
        sourceStage: 'refined',
        defaultIdPrefix: `${coarseBlock.id}-r`,
        extra: {
          parentBlockId: coarseBlock.id,
          parentCropBbox,
          refineInputSize: [refineImageMeta.inputW, refineImageMeta.inputH],
          refineSourceSize: [refineImageMeta.originalW, refineImageMeta.originalH],
          refineModelBbox: bboxXYWHToArray(refineModelValidation.bbox),
        },
      });
    })
    .filter((block) => isUsableBlock(block, page));

  const rejectReasons = shouldRejectRefineResult(refinedBlocks, coarseBlock, {
    inputSize: [refineImageMeta.inputW, refineImageMeta.inputH],
  });

  await writeRefineDebugArtifacts({
    config,
    dirs,
    page,
    coarseBlock,
    refineIndex,
    refineImageMeta,
    cropFile,
    parentCropBbox,
    refinedBlocks,
    rejectReasons,
  });

  if (rejectReasons.length) {
    return {
      blocks: [],
      rejectReasons,
    };
  }

  return {
    blocks: refinedBlocks.map((block) => withRefineStatus(block, true, false, [])),
    rejectReasons: [],
  };
}

async function writeRefineDebugArtifacts({
  config,
  dirs,
  page,
  coarseBlock,
  refineIndex,
  refineImageMeta,
  cropFile,
  parentCropBbox,
  refinedBlocks,
  rejectReasons,
}) {
  if (!config.debug?.enabled || !config.debug?.writeModelInputCopies) {
    return;
  }

  const baseName = `page_${String(page.pageNumber).padStart(3, '0')}_refine_${String(refineIndex).padStart(2, '0')}`;
  const rawInputCopy = path.join(dirs.debug, `${baseName}_raw_model_input.png`);
  await fs.writeFile(rawInputCopy, ensurePngBuffer(refineImageMeta));

  const overlayOnModelInput = path.join(dirs.debug, `${baseName}_overlay_on_model_input.png`);
  await drawOverlayFromBuffer({
    imageBuffer: ensurePngBuffer(refineImageMeta),
    blocks: refinedBlocks.map((block) => ({
      label: `${block.id} ${block.type}`,
      bbox: block.refineModelBbox || block.modelBbox,
    })),
    outputPath: overlayOnModelInput,
  });

  const overlayOnOriginalPage = path.join(dirs.debug, `${baseName}_overlay_on_original_page.png`);
  await drawOverlayOnImage({
    imagePath: page.imagePath,
    blocks: [
      {
        label: `${coarseBlock.id} coarse`,
        bbox: parentCropBbox,
        color: '#1d4ed8',
      },
      ...refinedBlocks.map((block) => ({
        label: `${block.id} ${rejectReasons.length ? 'rejected' : 'accepted'}`,
        bbox: block.bbox,
        color: rejectReasons.length ? '#dc2626' : '#059669',
      })),
    ],
    outputPath: overlayOnOriginalPage,
  });

  await fs.copyFile(
    cropFile,
    path.join(dirs.debug, `${baseName}_refine_source_crop.png`)
  );
}

function shouldRefineBlock(block, page, config) {
  const pageArea = page.widthPx * page.heightPx;
  const areaRatio = bboxArea(block.bbox) / Math.max(1, pageArea);
  const heightRatio = block.bbox[3] / Math.max(1, page.heightPx);
  const forceTypes = new Set(config.pipeline.detectBlocks.forceRefineTypes || []);

  return (
    forceTypes.has(block.type) ||
    block.canSplit === true ||
    block.confidence < 0.75 ||
    areaRatio > (config.pipeline.detectBlocks.refineAreaRatioThreshold ?? 0.45) ||
    heightRatio > (config.pipeline.detectBlocks.refineHeightRatioThreshold ?? 0.55)
  );
}

function refinePriority(block, page) {
  const pageArea = page.widthPx * page.heightPx;
  const areaRatio = bboxArea(block.bbox) / Math.max(1, pageArea);
  return areaRatio + (1 - block.confidence) * 0.25 + (block.canSplit ? 0.1 : 0);
}

function isUsableBlock(block, page) {
  const validation = validateXYWH(block.bbox, page.widthPx, page.heightPx, {
    context: `block ${block.id} on page ${page.pageNumber}`,
    strict: false,
  });
  const { bbox, errors } = validation;
  const area = bbox.width * bbox.height;
  return (
    errors.length === 0 &&
    bbox.width >= 60 &&
    bbox.height >= 40 &&
    area >= page.widthPx * page.heightPx * 0.004
  );
}

function withRefineStatus(block, refineAttempted, refineRejected, rejectReasons) {
  return {
    ...block,
    refineAttempted,
    refineRejected,
    refineRejectReasons: rejectReasons,
    fallback: refineRejected ? 'coarseBlock' : null,
  };
}

function dedupeBlocks(blocks, pageManifest) {
  const pageMap = new Map(pageManifest.pages.map((page) => [page.pageNumber, page]));
  const sorted = [...blocks].sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    if (a.readingOrder !== b.readingOrder) return a.readingOrder - b.readingOrder;
    return bboxArea(a.bbox) - bboxArea(b.bbox);
  });
  const kept = [];
  for (const block of sorted) {
    const page = pageMap.get(block.pageNumber);
    if (!page || !isUsableBlock(block, page)) {
      continue;
    }
    const duplicate = kept.find(
      (candidate) =>
        candidate.pageNumber === block.pageNumber &&
        overlapRatio(candidate.bbox, block.bbox) > 0.85
    );
    if (!duplicate) {
      kept.push(block);
    }
  }
  return kept;
}

async function cropImageRegionToFile(imagePath, bbox, outPath) {
  const image = await loadImage(imagePath);
  const { bbox: validated } = validateXYWH(bbox, image.width, image.height, {
    context: `crop source ${outPath}`,
  });
  const canvas = createCanvas(validated.width, validated.height);
  const context = canvas.getContext('2d');
  context.drawImage(
    image,
    validated.x,
    validated.y,
    validated.width,
    validated.height,
    0,
    0,
    validated.width,
    validated.height
  );
  await fs.writeFile(outPath, canvas.toBuffer('image/png'));
}

function extractResponseText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload.output)) {
    return '';
  }

  const chunks = [];
  for (const item of payload.output) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        chunks.push(content.text);
      } else if (typeof content.output_text === 'string') {
        chunks.push(content.output_text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractJsonString(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (
    firstBracket !== -1 &&
    lastBracket !== -1 &&
    lastBracket > firstBracket &&
    (firstBracket < text.indexOf('{') || text.indexOf('{') === -1)
  ) {
    return text.slice(firstBracket, lastBracket + 1);
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text.trim();
}

function parseModelJson(text) {
  const cleaned = sanitizeModelText(text);
  try {
    return normalizeModelPayload(JSON.parse(extractJsonString(cleaned)));
  } catch (error) {
    const bboxPayload = parseBboxTagPayload(cleaned);
    if (bboxPayload) {
      return bboxPayload;
    }
    throw error;
  }
}

function sanitizeModelText(text) {
  return String(text)
    .replace(/<\|end_of_solution\|>/gi, '')
    .replace(/<\|assistant\|>/gi, '')
    .replace(/<\|user\|>/gi, '')
    .trim();
}

function normalizeModelPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      blocks: payload.map((item, index) => normalizeLooseBlock(item, index)),
    };
  }

  if (payload && Array.isArray(payload.blocks)) {
    return {
      ...payload,
      blocks: payload.blocks.map((item, index) => normalizeLooseBlock(item, index)),
    };
  }

  return payload;
}

function normalizeLooseBlock(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const textHint = String(source.textHint || source.content || source.text || '').trim();
  const groupHint =
    String(source.groupHint || source.id || source.block_index || source.blockIndex || '')
      .trim() || `grp-${index + 1}`;
  return {
    id: String(source.id || `blk-${index + 1}`),
    type: source.objectType || source.type || inferLooseType(textHint),
    bbox: normalizeLooseBbox(source.bbox),
    confidence: clamp01(source.confidence ?? 0.85),
    readingOrder: Number(source.readingOrder || source.block_index || source.blockIndex || index + 1),
    canSplit: Boolean(source.canSplit),
    textHint,
    pageRole: normalizeExternalPageRole(String(source.pageRole || '').trim()),
    keepFullPageWidth: source.keepFullPageWidth !== false,
    groupHint,
    bboxFormat:
      typeof source.bboxFormat === 'string' && source.bboxFormat.trim()
        ? source.bboxFormat.trim()
        : BBOX_FORMAT_XYWH,
  };
}

function normalizeLooseBbox(bbox) {
  if (Array.isArray(bbox) && bbox.length >= 4) {
    return bbox.slice(0, 4).map((value) => Number(value) || 0);
  }
  if (typeof bbox === 'string') {
    const values = bbox.match(/-?\d+(?:\.\d+)?/g)?.map((value) => Number(value) || 0) || [];
    if (values.length >= 4) {
      return values.slice(0, 4);
    }
  }
  return [0, 0, 1, 1];
}

function inferLooseType(textHint) {
  const text = String(textHint || '').toLowerCase();
  if (/(cover|section|overview)/i.test(text)) return 'section_divider';
  if (/(definition|concept|knowledge)/i.test(text)) return 'knowledge_point';
  if (/(example)/i.test(text)) return 'example_question';
  if (/(exercise|practice|question|problem)/i.test(text)) return 'practice_question';
  if (/(table)/i.test(text)) return 'table_object';
  if (/(process|flow)/i.test(text)) return 'process_object';
  if (/(diagram|figure|illustration)/i.test(text)) return 'diagram_object';
  return 'problem_illustration';
}

function normalizeExternalPageRole(pageRole) {
  const value = String(pageRole || '').trim().toLowerCase();
  if (!value) return '';

  const aliasMap = {
    cover: 'cover',
    section_divider: 'section_divider',
    section_header: 'section_divider',
    overview: 'overview',
    overview_map: 'overview',
    concept: 'knowledge',
    knowledge: 'knowledge',
    knowledge_point: 'knowledge',
    exercise: 'exercise',
    exercise_page: 'exercise',
    mixed: 'mixed',
    mixed_page: 'mixed',
  };

  return aliasMap[value] || 'mixed';
}

function parseBboxTagPayload(text) {
  const matches = [
    ...String(text).matchAll(/<bbox>\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*<\/bbox>/g),
  ];
  if (!matches.length) {
    return null;
  }
  return {
    blocks: matches.map((match, index) => ({
      id: `bbox-${index + 1}`,
      type: 'problem_illustration',
      bbox: match.slice(1, 5).map((value) => Number(value) || 0),
      confidence: 0.7,
      readingOrder: index + 1,
      canSplit: false,
      textHint: '',
      groupHint: `bbox-${index + 1}`,
      bboxFormat: BBOX_FORMAT_XYWH,
    })),
  };
}

function clamp01(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0.5;
  return Math.min(Math.max(num, 0), 1);
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function ensurePngBuffer(imageMeta) {
  if (imageMeta.mimeType === 'image/png') {
    return imageMeta.inputBuffer;
  }
  return imageMeta.inputBuffer;
}

async function drawOverlayFromBuffer({ imageBuffer, blocks, outputPath }) {
  const image = await loadImage(imageBuffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, image.width, image.height);
  drawOverlayBoxes(context, blocks);
  await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
}

async function drawOverlayOnImage({ imagePath, blocks, outputPath }) {
  const image = await loadImage(imagePath);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, image.width, image.height);
  drawOverlayBoxes(context, blocks);
  await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
}

function drawOverlayBoxes(context, blocks) {
  context.lineWidth = 4;
  context.font = '20px Arial';
  for (const block of blocks) {
    const parsed = parseBboxXYWH(block.bbox, 'overlay bbox');
    const [x, y, width, height] = [parsed.x, parsed.y, parsed.width, parsed.height];
    context.strokeStyle = block.color || '#ff2d55';
    context.fillStyle = block.color || '#ff2d55';
    context.strokeRect(x, y, width, height);
    context.fillText(block.label || 'block', x, Math.max(24, y - 6));
  }
}

async function writeArkDebug(debugDir, debugLabel, suffix, payload) {
  if (!debugDir) {
    return;
  }
  await fs.mkdir(debugDir, { recursive: true });
  const safeLabel = String(debugLabel).replace(/[^a-zA-Z0-9._-]/g, '-');
  const filePath = path.join(debugDir, `${safeLabel}.${suffix}`);
  const text =
    typeof payload === 'string' ? payload : `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(filePath, text, 'utf8');
}
