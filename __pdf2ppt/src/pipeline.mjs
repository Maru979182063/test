import path from 'node:path';
import { ensureDir, writeJson } from './lib/fs-utils.mjs';
import { renderPages } from './stages/render-pages.mjs';
import { detectBlocks } from './stages/detect-blocks.mjs';
import { planSlides } from './stages/plan-slides.mjs';
import { cropBlocks } from './stages/crop-blocks.mjs';
import { buildPpt } from './stages/build-ppt.mjs';
import { validateOutput } from './stages/validate-output.mjs';

export async function runPipeline(config) {
  const dirs = await prepareJobDirs(config.outputDir);
  const context = { config, dirs };

  const pageManifest = await renderPages(context);
  await writeJson(path.join(dirs.artifacts, 'pages.json'), pageManifest);

  const blockManifest = await detectBlocks({ ...context, pageManifest });
  await writeJson(path.join(dirs.artifacts, 'blocks.json'), blockManifest);

  const slidePlan = await planSlides({ ...context, pageManifest, blockManifest });
  await writeJson(path.join(dirs.artifacts, 'slide-plan.json'), slidePlan);

  const cropManifest = await cropBlocks({
    ...context,
    pageManifest,
    blockManifest,
    slidePlan,
  });
  await writeJson(path.join(dirs.artifacts, 'crops.json'), cropManifest);

  const pptResult = await buildPpt({
    ...context,
    cropManifest,
    slidePlan,
  });

  const qaResult = await validateOutput({
    ...context,
    pageManifest,
    blockManifest,
    slidePlan,
    cropManifest,
    pptResult,
  });

  const summary = {
    jobName: config.jobName,
    outputDir: config.outputDir,
    pptxPath: pptResult.pptxPath,
    pageCount: pageManifest.pages.length,
    blockCount: blockManifest.blocks.length,
    slideCount: slidePlan.slides.length,
    reviewCount: slidePlan.reviewQueue.length,
    qaStatus: qaResult.status,
    qaIssueCount: qaResult.issueCount,
    qaErrorCount: qaResult.errorCount,
    qaReportPath: qaResult.qaReportPath,
    qaContactSheetPath: qaResult.contactSheetPath,
  };

  await writeJson(path.join(dirs.artifacts, 'job-summary.json'), summary);

  return summary;
}

async function prepareJobDirs(outputDir) {
  const dirs = {
    root: outputDir,
    artifacts: path.join(outputDir, 'artifacts'),
    crops: path.join(outputDir, 'crops'),
    debug: path.join(outputDir, 'debug'),
  };

  await Promise.all(Object.values(dirs).map((dir) => ensureDir(dir)));
  return dirs;
}
