import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mockDetectBlocks } from '../adapters/mock-vision-model.mjs';
import { BBOX_FORMAT_XYWH, bboxXYWHToArray, validateBboxXYWH } from '../lib/bbox.mjs';
import { buildBlockImageMeta, readImageSize } from '../lib/coordinate-space.mjs';
import { validateBlock } from '../lib/contracts.mjs';
import { readJson } from '../lib/fs-utils.mjs';

export async function detectBlocks({ config, pageManifest, dirs }) {
  const promptPath = await resolvePromptPath(
    config.pipeline.detectBlocks.promptProfile,
    'block-detector.md'
  );
  const refinePromptPath = await resolvePromptPath(
    config.pipeline.detectBlocks.promptProfile,
    'block-refiner.md'
  );
  let blocks;

  if (config.pipeline.detectBlocks.mode === 'json-file') {
    if (!config.inputs.blocksFile) {
      throw new Error('Missing inputs.blocksFile for detectBlocks json-file mode.');
    }
    const external = await readJson(config.inputs.blocksFile);
    blocks = external.blocks || [];
  } else if (config.pipeline.detectBlocks.mode === 'ark') {
    const { detectBlocksWithArk } = await import('../adapters/ark-model.mjs');
    blocks = await detectBlocksWithArk({
      config,
      pageManifest,
      promptPath,
      dirs,
    });
  } else if (config.pipeline.detectBlocks.mode === 'ark-two-pass') {
    const { detectBlocksTwoPassWithArk } = await import('../adapters/ark-model.mjs');
    blocks = await detectBlocksTwoPassWithArk({
      config,
      pageManifest,
      promptPath,
      refinePromptPath,
      dirs,
    });
  } else if (config.pipeline.detectBlocks.mode === 'mock') {
    blocks = await mockDetectBlocks(pageManifest);
  } else {
    throw new Error(
      `Unsupported detectBlocks mode "${config.pipeline.detectBlocks.mode}". Wire your model adapter here.`
    );
  }

  const normalizedBlocks = normalizeBlocks(blocks, pageManifest);
  await writeDetectDebugArtifacts({
    blocks: normalizedBlocks,
    config,
    dirs,
    pageManifest,
  });

  for (const block of normalizedBlocks) {
    validateBlock(block);
  }

  return {
    mode: config.pipeline.detectBlocks.mode,
    promptTemplate: promptPath,
    bboxFormat: BBOX_FORMAT_XYWH,
    pages: pageManifest.pages.map((page) => ({
      pageNumber: page.pageNumber,
      imagePath: page.imagePath,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      pageSize: [page.widthPx, page.heightPx],
    })),
    blocks: normalizedBlocks,
    pagesByNumber: Object.fromEntries(
      pageManifest.pages.map((page) => [page.pageNumber, page])
    ),
  };
}

async function resolvePromptPath(profileName, fileName) {
  const defaultPath = fileURLToPath(new URL(`../../prompts/${fileName}`, import.meta.url));
  if (!profileName) {
    return defaultPath;
  }

  const profilePath = fileURLToPath(
    new URL(`../../prompts/profiles/${profileName}/${fileName}`, import.meta.url)
  );
  try {
    await fs.access(profilePath);
    return profilePath;
  } catch {
    return defaultPath;
  }
}

function normalizeBlocks(blocks, pageManifest) {
  const pagesByNumber = new Map(pageManifest.pages.map((page) => [page.pageNumber, page]));
  const seenIds = new Map();

  return (blocks || []).map((block, index) => {
    const page = pagesByNumber.get(block.pageNumber);
    if (!page) {
      throw new Error(`Detected block points to missing pageNumber=${block.pageNumber}`);
    }

    const baseId =
      block.id ||
      `p${String(block.pageNumber).padStart(3, '0')}-b${String(index + 1).padStart(2, '0')}`;
    const occurrence = (seenIds.get(baseId) || 0) + 1;
    seenIds.set(baseId, occurrence);
    const normalizedId =
      occurrence === 1 ? baseId : `${baseId}--dup${String(occurrence).padStart(2, '0')}`;

    const normalized = {
      ...block,
      id: normalizedId,
      bboxFormat: BBOX_FORMAT_XYWH,
      coordinateSpace: 'original_page_image',
      pageSize: [page.widthPx, page.heightPx],
      bbox: bboxXYWHToArray(
        validateBboxXYWH(block.bbox, [page.widthPx, page.heightPx], `block ${normalizedId}`)
      ),
      modelBbox: bboxXYWHToArray(
        validateBboxXYWH(
          block.modelBbox || block.bbox,
          block.imageMeta?.modelInputSize || [page.widthPx, page.heightPx],
          `block ${normalizedId} modelBbox`
        )
      ),
      modelCoordinateSpace: 'model_input_image',
      imageMeta:
        block.imageMeta ||
        buildBlockImageMeta({
          originalPageSize: [page.widthPx, page.heightPx],
          modelInputSize: [page.widthPx, page.heightPx],
          maxImageSidePx: page.widthPx,
          detail: 'mock',
          imagePixelLimit: null,
        }),
      validation: block.validation || { warnings: [], errors: [] },
    };
    return normalized;
  });
}

async function writeDetectDebugArtifacts({ blocks, config, dirs, pageManifest }) {
  if (!config.debug?.enabled) {
    return;
  }

  const blocksByPage = new Map();
  for (const block of blocks) {
    const list = blocksByPage.get(block.pageNumber) || [];
    list.push(block);
    blocksByPage.set(block.pageNumber, list);
  }

  for (const page of pageManifest.pages) {
    const pageBlocks = blocksByPage.get(page.pageNumber) || [];
    const rawModelInputPath = path.join(
      dirs.debug,
      `page_${String(page.pageNumber).padStart(3, '0')}_raw_model_input.png`
    );
    await writeModelInputCopy(page.imagePath, pageBlocks, rawModelInputPath);

    const overlayOnModelInputPath = path.join(
      dirs.debug,
      `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_model_input.png`
    );
    await drawOverlay(rawModelInputPath, pageBlocks, overlayOnModelInputPath, 'modelBbox');

    const overlayOnOriginalPagePath = path.join(
      dirs.debug,
      `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_original_page.png`
    );
    await drawOverlay(page.imagePath, pageBlocks, overlayOnOriginalPagePath, 'bbox');

    const reportPath = path.join(
      dirs.debug,
      `page_${String(page.pageNumber).padStart(3, '0')}_blocks_report.json`
    );
    await fs.writeFile(
      reportPath,
      `${JSON.stringify(
        {
          pageNumber: page.pageNumber,
          imagePath: page.imagePath,
          rawModelInputPath,
          overlayOnModelInputPath,
          overlayOnOriginalPagePath,
          pageSize: [page.widthPx, page.heightPx],
          bboxFormat: BBOX_FORMAT_XYWH,
          blockCount: pageBlocks.length,
          blocks: pageBlocks.map((block) => ({
            id: block.id,
            type: block.type,
            bbox: block.bbox,
            bboxFormat: block.bboxFormat,
            coordinateSpace: block.coordinateSpace,
            modelBbox: block.modelBbox,
            modelCoordinateSpace: block.modelCoordinateSpace,
            imageMeta: block.imageMeta,
            validation: block.validation || { warnings: [], errors: [] },
            refineAttempted: block.refineAttempted || false,
            refineRejected: block.refineRejected || false,
            refineRejectReasons: block.refineRejectReasons || [],
            parentCropBbox: block.parentCropBbox || null,
            refineInputSize: block.refineInputSize || null,
            refineSourceSize: block.refineSourceSize || null,
            refineModelBbox: block.refineModelBbox || null,
          })),
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  }
}

async function drawOverlay(imagePath, blocks, outputPath, bboxKey) {
  const image = await loadImage(imagePath);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, image.width, image.height);
  context.strokeStyle = '#ff2d55';
  context.fillStyle = '#ff2d55';
  context.font = '20px Microsoft YaHei';
  context.lineWidth = 4;

  for (const block of blocks) {
    const targetBbox = Array.isArray(block[bboxKey]) ? block[bboxKey] : block.bbox;
    const [x, y, width, height] = targetBbox;
    context.strokeRect(x, y, width, height);
    context.fillText(`${block.id} ${block.type}`, x, Math.max(24, y - 6));
  }

  await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
}

async function writeModelInputCopy(pageImagePath, pageBlocks, outputPath) {
  const candidate = pageBlocks.find((block) => !block.parentCropBbox) || pageBlocks[0];
  if (!candidate?.imageMeta) {
    await fs.copyFile(pageImagePath, outputPath);
    return;
  }

  const inputSize = readImageSize(candidate.imageMeta, 'input', 'modelInputCopy');
  const image = await loadImage(pageImagePath);
  if (image.width === inputSize.width && image.height === inputSize.height) {
    await fs.copyFile(pageImagePath, outputPath);
    return;
  }

  const canvas = createCanvas(inputSize.width, inputSize.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, inputSize.width, inputSize.height);
  await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
}
