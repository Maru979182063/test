import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG = {
  jobName: 'pdf-to-ppt',
  outputDir: './out/pdf-to-ppt',
  provider: {
    type: 'mock',
    apiKey: '',
    baseUrl: '',
    model: '',
    apiStyle: 'auto',
    imageDetail: 'high',
    maxImageSidePx: 2048,
    maxOutputTokens: 4096,
  },
  inputs: {
    pageImagesDir: '',
    pdfPath: '',
    logoPath: '',
    blocksFile: '',
  },
  pipeline: {
    render: {
      mode: 'page-images',
      dpi: 220,
      firstPage: 1,
      maxPages: 0,
      binaryPath: '',
    },
    detectBlocks: {
      mode: 'mock',
      confidenceThreshold: 0.8,
      promptProfile: 'balanced',
      targetUnit: 'semantic-block',
      objectSchema: 'teaching-object-v1',
      maxRefinePerPage: 0,
      refineBleedPx: 24,
      refineAreaThreshold: 0.16,
      refineConfidenceThreshold: 0.86,
    },
    planSlides: {
      mode: 'mock',
      maxBlocksPerSlide: 1,
      maxBlocksBeforeBreak: 3,
      mergeGapRatio: 0.035,
      splitAreaThreshold: 0.52,
      splitHeightThreshold: 0.72,
      maxSegmentHeightRatio: 0.34,
      segmentationMode: 'balanced',
      crossPageEnabled: true,
      crossPageBottomStartRatio: 0.72,
      crossPageNextTopRatio: 0.24,
      crossPageMaxCombinedHeightRatio: 0.58,
      crossPageTitleHeightRatio: 0.16,
      crossPageSameTypeOnly: false,
    },
    crop: {
      mode: 'page-images',
      bleedPx: 16,
      preserveFullPageWidth: false,
    },
    validateOutput: {
      enabled: false,
      failOnError: false,
      previewWidthPx: 1600,
      minOccupancyRatio: 0.5,
      maxCropsPerSlide: 2,
      minPlacedShortSideInch: 1.2,
    },
    buildPpt: {
      fileName: 'output.pptx',
    },
  },
  slide: {
    widthInch: 10,
    heightInch: 7.5,
    marginInch: 0.35,
    backgroundColor: 'FFFFFF',
    showAutoTitle: true,
  },
  branding: {
    logoWidthInch: 0.9,
    logoHeightInch: 0.28,
    marginTopInch: 0.2,
    marginRightInch: 0.2,
    templateDecorationPath: '',
    templateDecorationWidthInch: 0,
    templateDecorationHeightInch: 0,
    templateDecorationTopInch: 0,
    templateDecorationRightInch: 0,
  },
};

export async function loadJobConfig(configPath) {
  const rawText = await fs.readFile(configPath, 'utf8');
  const source = JSON.parse(rawText);
  const merged = {
    ...DEFAULT_CONFIG,
    ...source,
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...source.provider,
      apiKey: source.provider?.apiKey || process.env.ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || '',
    },
    inputs: {
      ...DEFAULT_CONFIG.inputs,
      ...source.inputs,
    },
    pipeline: {
      ...DEFAULT_CONFIG.pipeline,
      ...source.pipeline,
      render: {
        ...DEFAULT_CONFIG.pipeline.render,
        ...source.pipeline?.render,
      },
      detectBlocks: {
        ...DEFAULT_CONFIG.pipeline.detectBlocks,
        ...source.pipeline?.detectBlocks,
      },
      planSlides: {
        ...DEFAULT_CONFIG.pipeline.planSlides,
        ...source.pipeline?.planSlides,
      },
      crop: {
        ...DEFAULT_CONFIG.pipeline.crop,
        ...source.pipeline?.crop,
      },
      validateOutput: {
        ...DEFAULT_CONFIG.pipeline.validateOutput,
        ...source.pipeline?.validateOutput,
      },
      buildPpt: {
        ...DEFAULT_CONFIG.pipeline.buildPpt,
        ...source.pipeline?.buildPpt,
      },
    },
    slide: {
      ...DEFAULT_CONFIG.slide,
      ...source.slide,
    },
    branding: {
      ...DEFAULT_CONFIG.branding,
      ...source.branding,
    },
  };

  merged.outputDir = path.resolve(path.dirname(configPath), merged.outputDir);
  if (merged.inputs.pageImagesDir) {
    merged.inputs.pageImagesDir = path.resolve(path.dirname(configPath), merged.inputs.pageImagesDir);
  }
  if (merged.inputs.logoPath) {
    merged.inputs.logoPath = path.resolve(path.dirname(configPath), merged.inputs.logoPath);
  }

  return merged;
}
