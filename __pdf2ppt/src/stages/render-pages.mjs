import fs from 'node:fs/promises';
import path from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { listImageFiles } from '../lib/fs-utils.mjs';
import { runCommand } from '../lib/process-utils.mjs';

export async function renderPages({ config, dirs }) {
  let files = [];

  if (config.pipeline.render.mode === 'page-images') {
    if (!config.inputs.pageImagesDir) {
      throw new Error('Missing inputs.pageImagesDir for render stage.');
    }
    files = await listImageFiles(config.inputs.pageImagesDir);
  } else if (config.pipeline.render.mode === 'pdf-poppler') {
    files = await renderPdfWithPoppler(config, dirs);
  } else {
    throw new Error(`Unsupported render mode "${config.pipeline.render.mode}".`);
  }

  if (files.length === 0) {
    throw new Error(`No page images found for render mode ${config.pipeline.render.mode}`);
  }

  const pages = [];
  for (const [index, filePath] of files.entries()) {
    const image = await loadImage(filePath);
    pages.push({
      pageNumber: index + 1,
      imagePath: filePath,
      widthPx: image.width,
      heightPx: image.height,
    });
  }

  return {
    mode: config.pipeline.render.mode,
    pages,
  };
}

async function renderPdfWithPoppler(config, dirs) {
  if (!config.inputs.pdfPath) {
    throw new Error('Missing inputs.pdfPath for pdf-poppler render mode.');
  }

  const renderDir = path.join(dirs.debug, 'rendered-pages');
  await fs.mkdir(renderDir, { recursive: true });
  for (const filePath of await listImageFiles(renderDir)) {
    await fs.unlink(filePath);
  }
  const prefix = path.join(renderDir, 'page');
  const command = await resolvePdftoppm(config.pipeline.render.binaryPath);
  const args = [
    '-r',
    String(config.pipeline.render.dpi || 220),
    '-png',
    '-f',
    String(config.pipeline.render.firstPage || 1),
  ];

  if ((config.pipeline.render.maxPages || 0) > 0) {
    const lastPage =
      (config.pipeline.render.firstPage || 1) + config.pipeline.render.maxPages - 1;
    args.push('-l', String(lastPage));
  }

  args.push(config.inputs.pdfPath, prefix);
  await runCommand(command, args);
  return listImageFiles(renderDir);
}

async function resolvePdftoppm(binaryPath) {
  const candidates = [
    binaryPath,
    process.env.PDFTOPPM_BIN,
    'pdftoppm',
    'pdftoppm.cmd',
    `C:/Users/${process.env.USERNAME || ''}/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe`,
    `C:/Users/${process.env.USERNAME || ''}/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm.cmd`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ['-h']);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Unable to locate pdftoppm. Set pipeline.render.binaryPath or PDFTOPPM_BIN.');
}
