import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  BBOX_FORMAT_XYWH,
  bboxXYWHToArray,
  expandBboxXYWH,
  parsePageSize,
  validateBboxXYWH,
} from '../lib/bbox.mjs';
import { safeStem } from '../lib/fs-utils.mjs';

export async function cropBlocks({ config, dirs, pageManifest, blockManifest, slidePlan }) {
  if (config.pipeline.crop.mode !== 'page-images') {
    throw new Error(
      `Unsupported crop mode "${config.pipeline.crop.mode}". Add a PDF high-definition crop adapter here.`
    );
  }

  const pageMap = new Map(pageManifest.pages.map((page) => [page.pageNumber, page]));
  const blockMap = new Map(blockManifest.blocks.map((block) => [block.id, block]));
  const imageCache = new Map();
  const bleedPx = Math.max(0, config.pipeline.crop.bleedPx ?? 0);
  const preserveFullPageWidth = config.pipeline.crop.preserveFullPageWidth !== false;
  const crops = [];

  for (const slide of slidePlan.slides) {
    for (const placement of slide.placements) {
      const source = resolvePlacementSource(placement, blockMap);
      const page = pageMap.get(source.pageNumber);
      if (!page) {
        throw new Error(`Missing page for placement ${placement.blockId}`);
      }

      const image = await loadCachedImage(page.imagePath, imageCache);
      validatePageImageSize(page, image);
      const cropGeometry = normalizeBbox(
        source.bbox,
        page,
        bleedPx,
        preserveFullPageWidth,
        config
      );
      const [x, y, width, height] = cropGeometry.finalCropBbox;
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      context.drawImage(image, x, y, width, height, 0, 0, width, height);

      const cropFile = `${safeStem(slide.slideId)}__${safeStem(placement.blockId)}.png`;
      const cropPath = path.join(dirs.crops, cropFile);
      await fs.writeFile(cropPath, canvas.toBuffer('image/png'));

      crops.push({
        slideId: slide.slideId,
        blockId: placement.blockId,
        pageNumber: source.pageNumber,
        cropPath,
        bboxFormat: BBOX_FORMAT_XYWH,
        pageSize: [page.widthPx, page.heightPx],
        widthPx: width,
        heightPx: height,
        rawBbox: cropGeometry.rawBbox,
        expandedBbox: cropGeometry.expandedBbox,
        finalCropBbox: cropGeometry.finalCropBbox,
        cropSize: [width, height],
        modelBbox: source.modelBbox || null,
        parentCropBbox: source.parentCropBbox || null,
        refineModelBbox: source.refineModelBbox || null,
        refineAttempted: source.refineAttempted || false,
        refineRejected: source.refineRejected || false,
        refineRejectReasons: source.refineRejectReasons || [],
        targetBoxEmu: placement.targetBoxEmu || null,
      });
    }
  }

  await writeCropContactSheet(crops, dirs);

  return {
    mode: config.pipeline.crop.mode,
    bboxFormat: BBOX_FORMAT_XYWH,
    crops,
  };
}

function resolvePlacementSource(placement, blockMap) {
  if (Array.isArray(placement?.bbox) && placement?.pageNumber) {
    return {
      pageNumber: placement.pageNumber,
      bbox: placement.bbox,
    };
  }

  const block = blockMap.get(placement.blockId);
  if (!block) {
    throw new Error(`Missing block for placement ${placement.blockId}`);
  }

  return {
    pageNumber: block.pageNumber,
    bbox: block.bbox,
    modelBbox: block.modelBbox,
    parentCropBbox: block.parentCropBbox,
    refineModelBbox: block.refineModelBbox,
    refineAttempted: block.refineAttempted,
    refineRejected: block.refineRejected,
    refineRejectReasons: block.refineRejectReasons,
  };
}

async function loadCachedImage(imagePath, cache) {
  if (!cache.has(imagePath)) {
    cache.set(imagePath, await loadImage(imagePath));
  }
  return cache.get(imagePath);
}

function normalizeBbox(bbox, page, bleedPx, preserveFullPageWidth, config) {
  const pageSize = [page.widthPx, page.heightPx];
  const raw = validateBboxXYWH(bbox, pageSize, `crop block on page ${page.pageNumber}`);
  const expanded = expandBboxXYWH(raw, bleedPx, pageSize, `crop block on page ${page.pageNumber}`);
  const finalCrop = preserveFullPageWidth
    ? {
        x: 0,
        y: expanded.y,
        width: page.widthPx,
        height: expanded.height,
      }
    : expanded;

  const finalValidated = validateBboxXYWH(
    finalCrop,
    pageSize,
    `final crop block on page ${page.pageNumber}`
  );

  if (config.debug?.strictBbox !== false) {
    if (finalValidated.width <= 0 || finalValidated.height <= 0) {
      throw new Error(`Invalid final crop bbox after normalization: ${JSON.stringify(finalValidated)}`);
    }
  }

  return {
    rawBbox: bboxXYWHToArray(raw),
    expandedBbox: bboxXYWHToArray(expanded),
    finalCropBbox: bboxXYWHToArray(finalValidated),
  };
}

function validatePageImageSize(page, image) {
  const expected = parsePageSize([page.widthPx, page.heightPx], `page ${page.pageNumber} pageSize`);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error(
      `Page image size mismatch on page ${page.pageNumber}: manifest=${JSON.stringify([page.widthPx, page.heightPx])}, actual=${JSON.stringify([image.width, image.height])}`
    );
  }
}

async function writeCropContactSheet(crops, dirs) {
  if (!crops.length) {
    return;
  }

  const thumbs = await Promise.all(
    crops.map(async (crop) => ({
      ...crop,
      image: await loadImage(crop.cropPath),
    }))
  );

  const columns = Math.min(3, thumbs.length);
  const rows = Math.ceil(thumbs.length / columns);
  const cellWidth = 320;
  const cellHeight = 220;
  const gap = 20;
  const canvas = createCanvas(
    columns * cellWidth + (columns + 1) * gap,
    rows * cellHeight + (rows + 1) * gap
  );
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f5f5';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '16px Microsoft YaHei';
  context.fillStyle = '#111111';

  for (const [index, crop] of thumbs.entries()) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const originX = gap + col * (cellWidth + gap);
    const originY = gap + row * (cellHeight + gap);
    const fit = contain(crop.image.width, crop.image.height, cellWidth, cellHeight - 28);
    const x = originX + (cellWidth - fit.width) / 2;
    const y = originY + 24 + (cellHeight - 28 - fit.height) / 2;

    context.fillText(crop.blockId, originX, originY + 16);
    context.drawImage(crop.image, x, y, fit.width, fit.height);
    context.strokeStyle = '#cccccc';
    context.strokeRect(x, y, fit.width, fit.height);
  }

  await fs.writeFile(
    path.join(dirs.debug, 'crop_contact_sheet.png'),
    canvas.toBuffer('image/png')
  );
}

function contain(widthPx, heightPx, maxW, maxH) {
  const ratio = Math.min(maxW / widthPx, maxH / heightPx);
  return {
    width: Math.max(1, Math.round(widthPx * ratio)),
    height: Math.max(1, Math.round(heightPx * ratio)),
  };
}
