import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { bboxArea, clampBbox, expandBbox, overlapRatio, unionBboxes } from '../lib/geometry.mjs';

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
    const userText = [
      `页码：${page.pageNumber}`,
      `画布尺寸：${page.widthPx}x${page.heightPx}`,
      '目标：识别适合直接落成一页 PPT 的“教学对象”，不是 OCR 小碎块。',
      '默认遵循：横向尽量保留整宽，只判纵向起止；通常一对象一页。',
      '请只返回一个符合提示词要求的 JSON 对象。',
      '不要使用 markdown 代码块。',
    ].join('\n');

    const json = await createArkJsonResponse({
      provider: config.provider,
      systemPrompt,
      userText,
      images: [
        {
          dataUrl: pageImage,
          detail: config.provider.imageDetail,
        },
      ],
      debugLabel: `block-detect-page-${page.pageNumber}`,
      debugDir: arkDebugDir,
    });

    const pageBlocks = Array.isArray(json.blocks) ? json.blocks : [];
    for (const [index, block] of pageBlocks.entries()) {
      blocks.push(
        normalizeBlock(block, page.pageNumber, index + 1, {
          pageRole: json.pageRole,
        })
      );
    }
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
      config.provider.maxImageSidePx || 1600
    );
    const coarseJson = await createArkJsonResponse({
      provider: config.provider,
      systemPrompt: coarsePrompt,
      userText: [
        `页码：${page.pageNumber}`,
        `画布尺寸：${page.widthPx}x${page.heightPx}`,
        '第一阶段：请先识别这页上的教学对象横切带，而不是文字碎块。',
        '默认遵循：横向尽量保留整宽，只判纵向起止；通常一对象一页。',
        '请只输出 JSON。',
      ].join('\n'),
      images: [
        {
          dataUrl: pageImage,
          detail: config.provider.imageDetail,
        },
      ],
      debugLabel: `block-detect-pass1-page-${page.pageNumber}`,
      debugDir: arkDebugDir,
    });

    const coarseBlocks = (Array.isArray(coarseJson.blocks) ? coarseJson.blocks : [])
      .map((block, index) =>
        normalizeBlock(block, page.pageNumber, index + 1, {
          sourceStage: 'coarse',
          defaultIdPrefix: `p${String(page.pageNumber).padStart(3, '0')}-c`,
          pageRole: coarseJson.pageRole,
        })
      )
      .filter((block) => isUsableBlock(block, page));

    const refineTargets = new Set(
      coarseBlocks
        .filter((block) => shouldRefineBlock(block, page, config))
        .sort((a, b) => refinePriority(b, page) - refinePriority(a, page))
        .slice(0, config.pipeline.detectBlocks.maxRefinePerPage ?? 3)
        .map((block) => block.id)
    );

    for (const [index, coarseBlock] of coarseBlocks.entries()) {
      if (!refineTargets.has(coarseBlock.id)) {
        blocks.push(ensureBlockGroupHint(coarseBlock));
        continue;
      }

      const refined = await refineCoarseBlock({
        config,
        page,
        coarseBlock,
        refinePrompt,
        refineIndex: index + 1,
        refineDebugDir,
        arkDebugDir,
      });

      if (refined.length) {
        blocks.push(...refined);
      } else {
        blocks.push(ensureBlockGroupHint(coarseBlock));
      }
    }
  }

  return dedupeBlocks(blocks, pageManifest);
}

export async function planSlidesWithArk({ config, blockManifest, promptPath }) {
  const systemPrompt = await fs.readFile(promptPath, 'utf8');
  const userText = [
    '下面是某份讲义已经识别出的内容块清单。',
    '请只输出 JSON。',
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
  const input = [];

  if (systemPrompt) {
    input.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: systemPrompt,
        },
      ],
    });
  }

  input.push({
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: userText,
      },
      ...images.map((image) => ({
        type: 'input_image',
        image_url: image.dataUrl,
        detail: image.detail || 'high',
      })),
    ],
  });

  await writeArkDebug(debugDir, debugLabel, 'request.json', {
    endpoint: 'responses',
    model: provider.model,
    systemPrompt,
    userText,
    maxOutputTokens: provider.maxOutputTokens,
    imageCount: images.length,
    imageMeta: images.map((image) => ({
      detail: image.detail || 'high',
      dataUrlPrefix: String(image.dataUrl || '').slice(0, 32),
      dataUrlLength: String(image.dataUrl || '').length,
    })),
  });

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      input,
      max_output_tokens: provider.maxOutputTokens,
    }),
  });

  const rawText = await response.text();
  await writeArkDebug(debugDir, debugLabel, 'response.txt', rawText);
  if (!response.ok) {
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

async function createChatApiJsonResponse({
  provider,
  systemPrompt,
  userText,
  images,
  debugLabel,
  debugDir,
}) {
  const messages = [];
  const normalizedSystemPrompt = /json/i.test(systemPrompt || '')
    ? systemPrompt
    : `${systemPrompt || ''}\nReturn json only.`;
  const normalizedUserText = /json/i.test(userText || '')
    ? userText
    : `${userText}\n请只输出 json。`;

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
      ...images.map((image) => ({
        type: 'image_url',
        image_url: {
          url: image.dataUrl,
          detail: image.detail || 'high',
        },
      })),
    ],
  });

  await writeArkDebug(debugDir, debugLabel, 'request.json', {
    endpoint: 'chat/completions',
    model: provider.model,
    systemPrompt: normalizedSystemPrompt,
    userText: normalizedUserText,
    maxTokens: provider.maxOutputTokens,
    imageCount: images.length,
    imageMeta: images.map((image) => ({
      detail: image.detail || 'high',
      dataUrlPrefix: String(image.dataUrl || '').slice(0, 32),
      dataUrlLength: String(image.dataUrl || '').length,
    })),
  });

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      max_tokens: provider.maxOutputTokens,
      response_format: {
        type: 'json_object',
      },
    }),
  });

  const rawText = await response.text();
  await writeArkDebug(debugDir, debugLabel, 'response.txt', rawText);
  if (!response.ok) {
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

function normalizeBlock(block, pageNumber, index, options = {}) {
  const normalizedType = block.objectType || block.type || 'problem_illustration';
  const rawBbox = Array.isArray(block.bbox)
    ? block.bbox.map((value) => Number(value) || 0)
    : [0, 0, 1, 1];
  const offsetX = options.offsetX || 0;
  const offsetY = options.offsetY || 0;
  const bbox = [
    rawBbox[0] + offsetX,
    rawBbox[1] + offsetY,
    rawBbox[2],
    rawBbox[3],
  ];
  const defaultIdPrefix =
    options.defaultIdPrefix || `p${String(pageNumber).padStart(3, '0')}-b`;
  const fallbackId = `${defaultIdPrefix}${String(index).padStart(2, '0')}`;
  return {
    id: block.id || fallbackId,
    pageNumber,
    type: normalizedType,
    bbox,
    confidence: clamp01(block.confidence),
    readingOrder: Number(block.readingOrder) || index,
    canSplit: Boolean(block.canSplit),
    textHint: typeof block.textHint === 'string' ? block.textHint : '',
    pageRole: normalizeExternalPageRole(
      typeof block.pageRole === 'string' ? block.pageRole : options.pageRole || ''
    ),
    keepFullPageWidth: block.keepFullPageWidth !== false,
    groupHint:
      typeof block.groupHint === 'string' && block.groupHint.trim()
        ? block.groupHint.trim()
        : options.groupHint || fallbackId,
    parentBlockId: options.parentBlockId || '',
    sourceStage: options.sourceStage || 'direct',
    sourceCropPath: options.sourceCropPath || '',
  };
}

function clamp01(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0.5;
  return Math.min(Math.max(num, 0), 1);
}

async function imageFileToDataUrl(filePath, maxSidePx) {
  const image = await loadImage(filePath);
  const longestSide = Math.max(image.width, image.height);

  if (!maxSidePx || longestSide <= maxSidePx) {
    const buffer = await fs.readFile(filePath);
    return `data:${mimeTypeForPath(filePath)};base64,${buffer.toString('base64')}`;
  }

  const scale = maxSidePx / longestSide;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);

  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function refineCoarseBlock({
  config,
  page,
  coarseBlock,
  refinePrompt,
  refineIndex,
  refineDebugDir,
  arkDebugDir,
}) {
  const bleedPx = config.pipeline.detectBlocks.refineBleedPx ?? 24;
  const refinedCropBbox = expandBbox(coarseBlock.bbox, bleedPx, page.widthPx, page.heightPx);
  const cropFile = path.join(
    refineDebugDir,
    `page-${String(page.pageNumber).padStart(2, '0')}_coarse-${String(refineIndex).padStart(2, '0')}.png`
  );
  const cropInfo = await cropImageRegionToFile(page.imagePath, refinedCropBbox, cropFile);

  const refinedJson = await createArkJsonResponse({
    provider: config.provider,
    systemPrompt: refinePrompt,
    userText: [
      `页码：${page.pageNumber}`,
      `整页尺寸：${page.widthPx}x${page.heightPx}`,
      `当前裁图片区在整页中的左上角坐标：(${refinedCropBbox[0]}, ${refinedCropBbox[1]})`,
      `当前裁图片区尺寸：${cropInfo.widthPx}x${cropInfo.heightPx}`,
      `第一阶段给出的父块类型：${coarseBlock.type}`,
      '第二阶段：请把这个局部区域细化成适合做 PPT 的教学对象。',
      '除非局部区域里明显存在多道独立题或多个独立对象，否则优先少切。',
      '返回的 bbox 必须只相对于当前这张裁图。',
    ].join('\n'),
    images: [
      {
        dataUrl: cropInfo.dataUrl,
        detail: config.provider.imageDetail,
      },
    ],
    debugLabel: `block-detect-pass2-page-${page.pageNumber}-coarse-${refineIndex}`,
    debugDir: arkDebugDir,
  });

  const refinedBlocks = (Array.isArray(refinedJson.blocks) ? refinedJson.blocks : [])
    .map((block, index) =>
      normalizeBlock(block, page.pageNumber, index + 1, {
        offsetX: refinedCropBbox[0],
        offsetY: refinedCropBbox[1],
        groupHint: coarseBlock.id,
        parentBlockId: coarseBlock.id,
        sourceStage: 'refined',
        sourceCropPath: cropFile,
        defaultIdPrefix: `${coarseBlock.id}-r`,
        pageRole: coarseBlock.pageRole,
      })
    )
    .map((block) => ({
      ...block,
      bbox: clampBbox(block.bbox, page.widthPx, page.heightPx),
    }))
    .filter((block) => isUsableBlock(block, page));

  if (!refinedBlocks.length) {
    return [];
  }

  const refinedUnion = unionBboxes(refinedBlocks.map((block) => block.bbox));
  const refinedCoverage = bboxArea(refinedUnion) / Math.max(1, bboxArea(coarseBlock.bbox));
  if (refinedCoverage > 1.35) {
    return [];
  }

  return refinedBlocks.map((block) => ensureBlockGroupHint(block));
}

function shouldRefineBlock(block, page, config) {
  const pageArea = page.widthPx * page.heightPx;
  const areaRatio = bboxArea(block.bbox) / Math.max(1, pageArea);
  const heightRatio = block.bbox[3] / Math.max(1, page.heightPx);
  const forceTypes = new Set([
    'practice_question',
    'advanced_question',
    'example_question',
    'problem_illustration',
  ]);
  const exerciseLikeRole = block.pageRole === 'exercise' || block.pageRole === 'mixed';
  const shortQuestionLike =
    forceTypes.has(block.type) &&
    exerciseLikeRole &&
    heightRatio < (config.pipeline.detectBlocks.refineMinQuestionHeightRatio ?? 0.14);
  return (
    block.canSplit ||
    shortQuestionLike ||
    block.confidence < (config.pipeline.detectBlocks.refineConfidenceThreshold ?? 0.92) ||
    areaRatio > (config.pipeline.detectBlocks.refineAreaThreshold ?? 0.12) ||
    forceTypes.has(block.type)
  );
}

function refinePriority(block, page) {
  const pageArea = page.widthPx * page.heightPx;
  const areaRatio = bboxArea(block.bbox) / Math.max(1, pageArea);
  const typeBoost =
    block.type === 'problem_illustration' ||
    block.type === 'practice_question' ||
    block.type === 'advanced_question'
      ? 0.08
      : 0;
  return areaRatio + typeBoost + (1 - block.confidence) * 0.2;
}

function isUsableBlock(block, page) {
  const [x, y, width, height] = clampBbox(block.bbox, page.widthPx, page.heightPx);
  const area = width * height;
  return (
    width >= 60 &&
    height >= 40 &&
    area >= page.widthPx * page.heightPx * 0.004 &&
    x >= 0 &&
    y >= 0
  );
}

function ensureBlockGroupHint(block) {
  return {
    ...block,
    groupHint: block.groupHint || block.parentBlockId || block.id,
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
  const [x, y, width, height] = clampBbox(bbox, image.width, image.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const buffer = canvas.toBuffer('image/png');
  await fs.writeFile(outPath, buffer);
  return {
    widthPx: width,
    heightPx: height,
    dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
  };
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
  if (/(封面|课程目标|讲次|第\d+讲)/i.test(text) && text.length < 24) return 'cover';
  if (/(模块|专题|能力进阶|强化训练|本讲概况|思维导图)/i.test(text) && text.length < 24) {
    if (/(强化训练)/i.test(text)) return 'practice_question';
    if (/(能力进阶)/i.test(text)) return 'advanced_question';
    if (/(思维导图|本讲概况|课程目标)/i.test(text)) return 'overview_map';
    return 'section_divider';
  }
  if (/(知识梳理|定义|概念|规律|要点)/i.test(text)) return 'knowledge_point';
  if (/(例题|例\d*|讲解)/i.test(text)) return 'example_question';
  if (/(训练|练习|随堂|习题|题组)/i.test(text)) return 'practice_question';
  if (/(表|表格)/i.test(text) && text.length < 24) return 'table_object';
  if (/(流程|过程|实验|步骤)/i.test(text) && text.length < 24) return 'process_object';
  if (/(图|图示|示意图|结构图|坐标图)/i.test(text) && text.length < 24) return 'diagram_object';
  if (/(定义|概念|知识梳理)/i.test(text)) return 'definition';
  if (/(例题|例|讲解)/i.test(text)) return 'example';
  if (/(推导|证明)/i.test(text)) return 'derivation';
  if (/(图|示意图|图示)/i.test(text) && text.length < 24) return 'figure';
  if (/(标题|模块|第\d+讲|本讲概况|强化训练|能力进阶)/i.test(text)) return 'title';
  return 'problem_illustration';
}

function normalizeExternalPageRole(pageRole) {
  const value = String(pageRole || '').trim().toLowerCase();
  if (!value) return '';

  const aliasMap = {
    cover: 'cover',
    section_divider: 'section_divider',
    section_header: 'section_divider',
    course_section: 'section_divider',
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
    })),
  };
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
