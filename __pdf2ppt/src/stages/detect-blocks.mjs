import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBlocksWithArk, detectBlocksTwoPassWithArk } from '../adapters/ark-model.mjs';
import { mockDetectBlocks } from '../adapters/mock-vision-model.mjs';
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
    blocks = await detectBlocksWithArk({
      config,
      pageManifest,
      promptPath,
      dirs,
    });
  } else if (config.pipeline.detectBlocks.mode === 'ark-two-pass') {
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

  for (const block of blocks) {
    validateBlock(block);
  }

  return {
    mode: config.pipeline.detectBlocks.mode,
    promptTemplate: promptPath,
    pages: pageManifest.pages.map((page) => ({
      pageNumber: page.pageNumber,
      imagePath: page.imagePath,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
    })),
    blocks,
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
