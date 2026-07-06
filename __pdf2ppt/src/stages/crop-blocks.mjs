import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { clamp, safeStem } from '../lib/fs-utils.mjs';

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
      const [x, y, width, height] = normalizeBbox(
        source.bbox,
        page,
        bleedPx,
        preserveFullPageWidth
      );
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
        widthPx: width,
        heightPx: height,
        sourceBbox: [x, y, width, height],
        targetBoxEmu: placement.targetBoxEmu || null,
      });
    }
  }

  return {
    mode: config.pipeline.crop.mode,
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
  };
}

async function loadCachedImage(imagePath, cache) {
  if (!cache.has(imagePath)) {
    cache.set(imagePath, await loadImage(imagePath));
  }
  return cache.get(imagePath);
}

function normalizeBbox(bbox, page, bleedPx, preserveFullPageWidth) {
  const [rawX, rawY, rawWidth, rawHeight] = bbox;
  const x = preserveFullPageWidth
    ? 0
    : clamp(Math.floor(rawX - bleedPx), 0, page.widthPx);
  const y = clamp(Math.floor(rawY - bleedPx), 0, page.heightPx);
  const right = preserveFullPageWidth
    ? page.widthPx
    : clamp(Math.ceil(rawX + rawWidth + bleedPx), 0, page.widthPx);
  const bottom = clamp(Math.ceil(rawY + rawHeight + bleedPx), 0, page.heightPx);
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);

  return [x, y, width, height];
}
