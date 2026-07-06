import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SLIDE = {
  widthInch: 10,
  heightInch: 7.5,
  marginInch: 0.35,
  backgroundColor: 'FFFFFF',
  showAutoTitle: true,
};

const DEFAULT_BRANDING = {
  logoPath: '',
  logoWidthInch: 0.9,
  logoHeightInch: 0.28,
  marginTopInch: 0.2,
  marginRightInch: 0.2,
  templateDecorationPath: '',
  templateDecorationWidthInch: 1.6,
  templateDecorationHeightInch: 0.42,
  templateDecorationTopInch: 0.06,
  templateDecorationRightInch: 0.16,
};

const DEFAULT_PROVIDER = {
  type: 'ark',
  apiKey: '',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-1-8-251228',
  apiStyle: 'auto',
  imageDetail: 'high',
  maxImageSidePx: 2048,
  maxOutputTokens: 4096,
};

const DEFAULT_DEBUG = {
  enabled: true,
  strictBbox: true,
  writeModelInputCopies: true,
};

export async function loadJobConfig(configPath) {
  const source = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const rootDir = path.dirname(configPath);
  const jobName =
    source.jobName ||
    basenameWithoutExt(source.inputs?.pdfPath || source.inputs?.pageImagesDir || 'job');

  const outputDir = resolveMaybe(rootDir, source.outputDir || `./out/${slugify(jobName)}`);
  const resolvedBrandingLogoPath = resolveMaybe(
    rootDir,
    source.branding?.logoPath || source.inputs?.logoPath || ''
  );
  const inputs = {
    pdfPath: resolveMaybe(rootDir, source.inputs?.pdfPath || ''),
    pageImagesDir: resolveMaybe(rootDir, source.inputs?.pageImagesDir || ''),
    logoPath: resolvedBrandingLogoPath,
    blocksFile: resolveMaybe(rootDir, source.inputs?.blocksFile || ''),
    slidePlanFile: resolveMaybe(rootDir, source.inputs?.slidePlanFile || ''),
    fitDerivedReportFile: resolveMaybe(rootDir, source.inputs?.fitDerivedReportFile || ''),
  };

  return {
    ...source,
    jobName,
    configPath,
    outputDir,
    inputs,
    provider: {
      ...DEFAULT_PROVIDER,
      ...(source.provider || {}),
      apiKey:
        source.provider?.apiKey ||
        process.env.ARK_API_KEY ||
        process.env.VOLCENGINE_ARK_API_KEY ||
        '',
    },
    debug: {
      ...DEFAULT_DEBUG,
      ...(source.debug || {}),
    },
    slide: {
      ...DEFAULT_SLIDE,
      ...(source.slide || {}),
    },
    branding: {
      ...DEFAULT_BRANDING,
      ...(source.branding || {}),
      logoPath: resolvedBrandingLogoPath,
      templateDecorationPath: resolveMaybe(
        rootDir,
        source.branding?.templateDecorationPath || ''
      ),
    },
    pipeline: {
      render: {
        mode: 'page-images',
        dpi: 220,
        firstPage: 1,
        maxPages: 0,
        binaryPath: '',
        ...(source.pipeline?.render || {}),
      },
      detectBlocks: {
        mode: 'mock',
        confidenceThreshold: 0.8,
        promptProfile: 'object-first',
        targetUnit: 'teaching-object',
        objectSchema: 'teaching-object-v1',
        maxRefinePerPage: 2,
        geometryMode: 'horizontal-bands',
        forceFullPageWidth: true,
        refineBleedPx: 24,
        refineConfidenceThreshold: 0.86,
        refineAreaThreshold: 0.18,
        refineMinQuestionHeightRatio: 0.14,
        ...(source.pipeline?.detectBlocks || {}),
      },
      planSlides: {
        mode: 'mock',
        segmentationMode: 'object-first',
        maxBlocksPerSlide: 1,
        mergeGapRatio: 0.06,
        hardBreakGapRatio: 0.042,
        softBreakGapRatio: 0.02,
        hintBreakGapRatio: 0.028,
        typeBreakGapRatio: 0.022,
        hintBreakMinHeightRatio: 0.12,
        typeBreakMinHeightRatio: 0.14,
        targetSegmentHeightRatio: 0.26,
        maxSegmentHeightRatio: 0.32,
        leadTitleTopRatio: 0.22,
        leadTitleHeightRatio: 0.14,
        leadTitleMergeGapRatio: 0.05,
        trailingFragmentTopRatio: 0.72,
        trailingFragmentHeightRatio: 0.12,
        maxBlocksBeforeBreak: 3,
        minSplitGapRatio: 0.018,
        splitScoreThreshold: 0.055,
        maxRecursiveSplitDepth: 2,
        crossPageEnabled: true,
        crossPageBottomStartRatio: 0.72,
        crossPageNextTopRatio: 0.22,
        crossPageMaxCombinedHeightRatio: 0.58,
        crossPageTitleHeightRatio: 0.16,
        crossPageSameTypeOnly: true,
        ...(source.pipeline?.planSlides || {}),
      },
      crop: {
        mode: 'page-images',
        bleedPx: 0,
        preserveFullPageWidth: true,
        ...(source.pipeline?.crop || {}),
      },
      validateOutput: {
        enabled: false,
        failOnError: false,
        previewWidthPx: 1600,
        minOccupancyRatio: 0.5,
        maxCropsPerSlide: 2,
        minPlacedShortSideInch: 1.2,
        ...(source.pipeline?.validateOutput || {}),
      },
      buildPpt: {
        fileName: `${slugify(jobName)}.pptx`,
        ...(source.pipeline?.buildPpt || {}),
      },
    },
  };
}

function resolveMaybe(rootDir, value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function basenameWithoutExt(value) {
  return path.basename(value, path.extname(value));
}

function slugify(value) {
  return String(value)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
