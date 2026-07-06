import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ensureDir, writeJson } from '../lib/fs-utils.mjs';

export async function validateOutput({
  config,
  dirs,
  pageManifest,
  blockManifest,
  slidePlan,
  cropManifest,
  pptResult,
}) {
  if (!config.pipeline.validateOutput?.enabled) {
    const skipped = {
      enabled: false,
      status: 'skipped',
      issueCount: 0,
      errorCount: 0,
      previewDir: null,
      qaReportPath: null,
      contactSheetPath: null,
      pptxPath: pptResult.pptxPath,
    };
    await writePipelineReport({
      config,
      dirs,
      pageManifest,
      blockManifest,
      cropManifest,
      reportStatus: skipped.status,
      qaReportPath: null,
      contactSheetPath: null,
    });
    return skipped;
  }

  const previewDir = await ensureDir(path.join(dirs.debug, 'qa-previews'));
  const cropMap = new Map();
  for (const crop of cropManifest.crops) {
    const list = cropMap.get(crop.slideId) || [];
    list.push(crop);
    cropMap.set(crop.slideId, list);
  }

  const slideWidthPx = config.pipeline.validateOutput.previewWidthPx || 1600;
  const slideHeightPx = Math.round(
    slideWidthPx * (config.slide.heightInch / config.slide.widthInch)
  );
  const issues = [];
  const previews = [];
  const decorationImage = config.branding.templateDecorationPath
    ? await loadImage(config.branding.templateDecorationPath)
    : null;

  for (const plannedSlide of slidePlan.slides) {
    const slideIssues = [];
    const crops = cropMap.get(plannedSlide.slideId) || [];
    if (crops.length === 0) {
      slideIssues.push(issue('error', 'empty-slide', 'No crops placed on slide.'));
    }
    if (crops.length > (config.pipeline.validateOutput.maxCropsPerSlide || 2)) {
      slideIssues.push(
        issue('error', 'too-many-crops', `Slide has ${crops.length} crops, likely over-fragmented.`)
      );
    }
    if (plannedSlide.reviewReasons?.length) {
      slideIssues.push(
        issue(
          'warn',
          'upstream-review-flag',
          `Upstream review reasons: ${plannedSlide.reviewReasons.join(', ')}`
        )
      );
    }

    const layout = layoutForSlide(config, plannedSlide, crops);
    const occupancy = layout.totalArea / Math.max(1, layout.usableArea);
    if (crops.length > 0 && occupancy < (config.pipeline.validateOutput.minOccupancyRatio || 0.5)) {
      slideIssues.push(
        issue(
          'error',
          'low-occupancy',
          `Placed content only covers ${occupancy.toFixed(3)} of usable slide area.`
        )
      );
    }

    for (const placement of layout.placements) {
      const shortSide = Math.min(placement.w, placement.h);
      if (shortSide < (config.pipeline.validateOutput.minPlacedShortSideInch || 1.2)) {
        slideIssues.push(
          issue(
            'warn',
            'tiny-placement',
            `Placement ${placement.blockId} is too small on slide (${shortSide.toFixed(2)} inch short side).`
          )
        );
      }
    }

    const previewPath = path.join(previewDir, `${plannedSlide.slideId}.png`);
    await renderPreview({
      previewPath,
      slideWidthPx,
      slideHeightPx,
      plannedSlide,
      layout,
      decorationImage,
      config,
    });
    previews.push(previewPath);

    if (slideIssues.length) {
      issues.push({
        slideId: plannedSlide.slideId,
        slideIndex: plannedSlide.slideIndex || null,
        slideType: plannedSlide.slideType || null,
        issues: slideIssues,
      });
    }
  }

  const contactSheetPath = path.join(dirs.debug, 'qa-contact-sheet.png');
  await createContactSheet(previews, contactSheetPath, slideWidthPx, slideHeightPx);

  const errorCount = issues.reduce(
    (count, item) => count + item.issues.filter((entry) => entry.level === 'error').length,
    0
  );
  const qa = {
    enabled: true,
    status: errorCount > 0 ? 'failed' : 'passed',
    issueCount: issues.length,
    errorCount,
    issues,
    previewDir,
    contactSheetPath,
    pptxPath: pptResult.pptxPath,
  };
  const qaReportPath = path.join(dirs.artifacts, 'qa-report.json');
  await writeJson(qaReportPath, qa);
  qa.qaReportPath = qaReportPath;

  await writePipelineReport({
    config,
    dirs,
    pageManifest,
    blockManifest,
    cropManifest,
    reportStatus: qa.status,
    qaReportPath,
    contactSheetPath,
  });

  if (errorCount > 0 && config.pipeline.validateOutput.failOnError) {
    throw new Error(`QA gate failed with ${errorCount} error issues. See ${qaReportPath}`);
  }

  return qa;
}

async function writePipelineReport({
  config,
  dirs,
  pageManifest,
  blockManifest,
  cropManifest,
  reportStatus,
  qaReportPath,
  contactSheetPath,
}) {
  const pages = (pageManifest.pages || []).map((page) => {
    const blocks = (blockManifest.blocks || []).filter((block) => block.pageNumber === page.pageNumber);
    const firstBlock = blocks[0] || null;
    const report = {
      pageNumber: page.pageNumber,
      imagePath: page.imagePath,
      originalPageSize: [page.widthPx, page.heightPx],
      modelInputSize: firstBlock?.imageMeta?.modelInputSize || [page.widthPx, page.heightPx],
      localResize: firstBlock?.imageMeta?.localResize || {
        enabled: false,
        scaleX: 1,
        scaleY: 1,
        maxImageSidePx: config.provider.maxImageSidePx || null,
      },
      ark: firstBlock?.imageMeta?.ark || {
        detail: config.provider.imageDetail || 'high',
        imagePixelLimit: config.provider.imagePixelLimit?.enabled
          ? config.provider.imagePixelLimit
          : null,
      },
      overlays: {
        rawModelInputPath: path.join(
          dirs.debug,
          `page_${String(page.pageNumber).padStart(3, '0')}_raw_model_input.png`
        ),
        overlayOnModelInputPath: path.join(
          dirs.debug,
          `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_model_input.png`
        ),
        overlayOnOriginalPagePath: path.join(
          dirs.debug,
          `page_${String(page.pageNumber).padStart(3, '0')}_overlay_on_original_page.png`
        ),
      },
      blocks: blocks.map((block) => ({
        id: block.id,
        type: block.type,
        modelBbox: block.modelBbox,
        mappedPageBbox: block.bbox,
        validation: block.validation || { warnings: [], errors: [] },
        refineAttempted: block.refineAttempted || false,
        refineRejected: block.refineRejected || false,
        refineRejectReasons: block.refineRejectReasons || [],
      })),
    };
    return report;
  });

  const report = {
    status: reportStatus,
    originalPageSize: pages[0]?.originalPageSize || null,
    modelInputSize: pages[0]?.modelInputSize || null,
    localResize: pages[0]?.localResize || null,
    ark: pages[0]?.ark || null,
    imagePixelLimitEnabled: Boolean(config.provider.imagePixelLimit?.enabled),
    cropContactSheetPath: contactSheetPath || path.join(dirs.debug, 'crop_contact_sheet.png'),
    qaReportPath,
    pages,
    crops: (cropManifest.crops || []).map((crop) => ({
      slideId: crop.slideId,
      blockId: crop.blockId,
      rawBbox: crop.rawBbox,
      expandedBbox: crop.expandedBbox,
      finalCropBbox: crop.finalCropBbox,
      cropSize: crop.cropSize,
      refineAttempted: crop.refineAttempted || false,
      refineRejected: crop.refineRejected || false,
      refineRejectReasons: crop.refineRejectReasons || [],
    })),
  };

  const reportJsonPath = path.join(dirs.artifacts, 'report.json');
  await writeJson(reportJsonPath, report);
  const reportMdPath = path.join(dirs.artifacts, 'report.md');
  await fs.writeFile(reportMdPath, buildReportMarkdown(report), 'utf8');
}

function buildReportMarkdown(report) {
  const page = report.pages[0];
  const firstBlock = page?.blocks?.[0];
  const refineRejectedCount = report.pages.reduce(
    (count, item) => count + item.blocks.filter((block) => block.refineRejected).length,
    0
  );
  const diagnosis = [];
  if (firstBlock?.validation?.errors?.length) {
    diagnosis.push('- overlay_on_original_page is likely wrong because mapped page bbox validation already failed.');
  } else {
    diagnosis.push('- If overlay_on_model_input is wrong, the prompt or raw model output is likely wrong.');
    diagnosis.push('- If overlay_on_model_input looks right but overlay_on_original_page is wrong, the resize mapping is likely wrong.');
    diagnosis.push('- If overlay_on_original_page looks right but the crop looks wrong, the crop stage is likely wrong.');
    diagnosis.push('- If crops look right but the PPT is wrong, the PPT layout stage is likely wrong.');
  }
  if (refineRejectedCount > 0) {
    diagnosis.push('- Multiple refine rejections mean the second-pass refine strategy is degrading semantics and falling back to coarse blocks.');
  }

  return [
    '# Pipeline Report',
    '',
    `- status: ${report.status}`,
    `- originalPageSize: ${JSON.stringify(report.originalPageSize)}`,
    `- modelInputSize: ${JSON.stringify(report.modelInputSize)}`,
    `- localResize: ${JSON.stringify(report.localResize)}`,
    `- ark: ${JSON.stringify(report.ark)}`,
    `- imagePixelLimitEnabled: ${report.imagePixelLimitEnabled}`,
    `- cropContactSheetPath: ${report.cropContactSheetPath}`,
    '',
    '## Diagnosis',
    ...diagnosis,
  ].join('\n');
}

function issue(level, code, message) {
  return { level, code, message };
}

function layoutForSlide(config, plannedSlide, crops) {
  const margin = config.slide.marginInch;
  const usableX = margin;
  const usableY = margin;
  const usableW = config.slide.widthInch - margin * 2;
  const usableH = config.slide.heightInch - margin * 2;

  if (crops.length <= 1) {
    return {
      usableArea: usableW * usableH,
      totalArea: crops.reduce((sum, crop) => {
        const fit = contain(crop.widthPx, crop.heightPx, usableW, usableH);
        return sum + fit.w * fit.h;
      }, 0),
      placements: crops.map((crop) => {
        const fit = contain(crop.widthPx, crop.heightPx, usableW, usableH);
        return {
          blockId: crop.blockId,
          x: usableX + (usableW - fit.w) / 2,
          y: usableY + (usableH - fit.h) / 2,
          w: fit.w,
          h: fit.h,
          cropPath: crop.cropPath,
          widthPx: crop.widthPx,
          heightPx: crop.heightPx,
        };
      }),
    };
  }

  const gap = 0.18;
  const eachH = (usableH - gap) / Math.max(1, crops.length);
  const placements = crops.map((crop, index) => {
    const fit = contain(crop.widthPx, crop.heightPx, usableW, eachH);
    return {
      blockId: crop.blockId,
      x: usableX + (usableW - fit.w) / 2,
      y: usableY + index * (eachH + gap) + (eachH - fit.h) / 2,
      w: fit.w,
      h: fit.h,
      cropPath: crop.cropPath,
      widthPx: crop.widthPx,
      heightPx: crop.heightPx,
    };
  });

  return {
    usableArea: usableW * usableH,
    totalArea: placements.reduce((sum, item) => sum + item.w * item.h, 0),
    placements,
  };
}

async function renderPreview({
  previewPath,
  slideWidthPx,
  slideHeightPx,
  plannedSlide,
  layout,
  decorationImage,
  config,
}) {
  const canvas = createCanvas(slideWidthPx, slideHeightPx);
  const context = canvas.getContext('2d');
  context.fillStyle = `#${config.slide.backgroundColor || 'FFFFFF'}`;
  context.fillRect(0, 0, slideWidthPx, slideHeightPx);

  if (decorationImage) {
    const box = {
      x:
        ((config.slide.widthInch -
          config.branding.templateDecorationRightInch -
          config.branding.templateDecorationWidthInch) /
          config.slide.widthInch) *
        slideWidthPx,
      y: (config.branding.templateDecorationTopInch / config.slide.heightInch) * slideHeightPx,
      w: (config.branding.templateDecorationWidthInch / config.slide.widthInch) * slideWidthPx,
      h: (config.branding.templateDecorationHeightInch / config.slide.heightInch) * slideHeightPx,
    };
    context.drawImage(decorationImage, box.x, box.y, box.w, box.h);
  }

  for (const placement of layout.placements) {
    const image = await loadImage(placement.cropPath);
    const x = (placement.x / config.slide.widthInch) * slideWidthPx;
    const y = (placement.y / config.slide.heightInch) * slideHeightPx;
    const w = (placement.w / config.slide.widthInch) * slideWidthPx;
    const h = (placement.h / config.slide.heightInch) * slideHeightPx;
    context.drawImage(image, x, y, w, h);
    context.strokeStyle = 'rgba(0,0,0,0.08)';
    context.strokeRect(x, y, w, h);
  }

  context.fillStyle = '#444444';
  context.font = '24px Microsoft YaHei';
  context.fillText(
    `${plannedSlide.slideId}${plannedSlide.slideType ? ` 路 ${plannedSlide.slideType}` : ''}`,
    24,
    32
  );

  await fs.writeFile(previewPath, canvas.toBuffer('image/png'));
}

async function createContactSheet(previewPaths, outPath, tileWidth, tileHeight) {
  if (!previewPaths.length) {
    return;
  }
  const columns = 2;
  const rows = Math.ceil(previewPaths.length / columns);
  const gap = 20;
  const canvas = createCanvas(
    columns * tileWidth + (columns + 1) * gap,
    rows * tileHeight + (rows + 1) * gap
  );
  const context = canvas.getContext('2d');
  context.fillStyle = '#F3F4F6';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const [index, previewPath] of previewPaths.entries()) {
    const image = await loadImage(previewPath);
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + col * (tileWidth + gap);
    const y = gap + row * (tileHeight + gap);
    context.drawImage(image, x, y, tileWidth, tileHeight);
  }

  await fs.writeFile(outPath, canvas.toBuffer('image/png'));
}

function contain(widthPx, heightPx, maxW, maxH) {
  const ratio = Math.min(maxW / widthPx, maxH / heightPx);
  return {
    w: widthPx * ratio,
    h: heightPx * ratio,
  };
}
