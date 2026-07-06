import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';

export async function buildPpt({ config, slidePlan, cropManifest }) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: 'AUTO_PIPE',
    width: config.slide.widthInch,
    height: config.slide.heightInch,
  });
  pptx.layout = 'AUTO_PIPE';
  pptx.author = 'Codex';
  pptx.subject = config.jobName;
  pptx.title = config.jobName;
  pptx.company = 'Codex';

  const cropMap = new Map();
  for (const crop of cropManifest.crops) {
    const list = cropMap.get(crop.slideId) || [];
    list.push(crop);
    cropMap.set(crop.slideId, list);
  }

  const hasLogo = Boolean(config.branding.logoPath);
  const hasDecoration = Boolean(config.branding.templateDecorationPath);
  if (hasLogo) {
    await fs.access(config.branding.logoPath);
  }
  if (hasDecoration) {
    await fs.access(config.branding.templateDecorationPath);
  }

  for (const plannedSlide of slidePlan.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: config.slide.backgroundColor };

    if (hasDecoration && slidePlan.templateDecoration?.boxEmu) {
      slide.addImage({
        path: config.branding.templateDecorationPath,
        ...emuBoxToInches(slidePlan.templateDecoration.boxEmu),
      });
    } else if (hasDecoration) {
      slide.addImage({
        path: config.branding.templateDecorationPath,
        x:
          config.slide.widthInch -
          config.branding.templateDecorationRightInch -
          config.branding.templateDecorationWidthInch,
        y: config.branding.templateDecorationTopInch,
        w: config.branding.templateDecorationWidthInch,
        h: config.branding.templateDecorationHeightInch,
      });
    }

    if (config.slide.showAutoTitle && plannedSlide.title && !(plannedSlide.textLines || []).length) {
      slide.addText(plannedSlide.title, {
        x: config.slide.marginInch,
        y: 0.14,
        w: 2.4,
        h: 0.28,
        fontFace: 'Microsoft YaHei',
        fontSize: 14,
        bold: true,
        color: '333333',
      });
    }

    if (hasLogo) {
      slide.addImage({
        path: config.branding.logoPath,
        x:
          config.slide.widthInch -
          config.branding.marginRightInch -
          config.branding.logoWidthInch,
        y: config.branding.marginTopInch,
        w: config.branding.logoWidthInch,
        h: config.branding.logoHeightInch,
      });
    }

    const crops = cropMap.get(plannedSlide.slideId) || [];
    addDerivedText(slide, plannedSlide, crops, config);
    const fallbackBoxes = layoutBoxes(
      crops.length,
      config.slide.widthInch,
      config.slide.heightInch,
      config.slide.marginInch,
      config.slide.showAutoTitle
    );

    crops.forEach((crop, index) => {
      const box = crop.targetBoxEmu
        ? emuBoxToInches(crop.targetBoxEmu)
        : fallbackBoxes[index];
      if (!box) {
        return;
      }
      const fit = contain(crop.widthPx, crop.heightPx, box.w, box.h);
      slide.addImage({
        path: crop.cropPath,
        x: box.x + (box.w - fit.w) / 2,
        y: box.y + (box.h - fit.h) / 2,
        w: fit.w,
        h: fit.h,
      });
    });
  }

  const pptxPath = path.join(config.outputDir, config.pipeline.buildPpt.fileName);
  await pptx.writeFile({ fileName: pptxPath });

  return { pptxPath };
}

function addDerivedText(slide, plannedSlide, crops, config) {
  const textLines = (plannedSlide.textLines || []).filter(Boolean);
  if (!textLines.length) {
    return;
  }

  if (plannedSlide.slideType === 'text_relayout' || plannedSlide.slideType === 'template_only') {
    addTextRelayoutSlide(slide, textLines, config);
    return;
  }

  const textBox = suggestMixedTextBox(crops, config);
  const title = textLines[0];
  const body = textLines.slice(1);

  slide.addText(title, {
    x: textBox.x,
    y: textBox.y,
    w: textBox.w,
    h: Math.min(0.5, textBox.h),
    fontFace: 'Microsoft YaHei',
    fontSize: 20,
    bold: true,
    color: '222222',
    margin: 0,
  });

  if (body.length) {
    slide.addText(body.join('\n'), {
      x: textBox.x,
      y: textBox.y + 0.48,
      w: textBox.w,
      h: Math.max(0.6, textBox.h - 0.48),
      fontFace: 'Microsoft YaHei',
      fontSize: 12,
      color: '444444',
      breakLine: false,
      valign: 'top',
      margin: 0.02,
    });
  }
}

function addTextRelayoutSlide(slide, textLines, config) {
  if (textLines.length <= 2) {
    slide.addText(textLines[0], {
      x: 1.2,
      y: 2.0,
      w: config.slide.widthInch - 2.4,
      h: 0.7,
      fontFace: 'Microsoft YaHei',
      fontSize: 26,
      bold: true,
      align: 'center',
      color: '222222',
      margin: 0,
    });

    if (textLines[1]) {
      slide.addText(textLines[1], {
        x: 1.8,
        y: 2.75,
        w: config.slide.widthInch - 3.6,
        h: 0.4,
        fontFace: 'Microsoft YaHei',
        fontSize: 16,
        align: 'center',
        color: '666666',
        margin: 0,
      });
    }
    return;
  }

  const runs = textLines.map((line, index) => ({
    text: `${line}${index === textLines.length - 1 ? '' : '\n'}`,
    options: {
      bold: index === 0,
      breakLine: false,
    },
  }));

  slide.addText(runs, {
    x: 0.85,
    y: 1.15,
    w: config.slide.widthInch - 1.7,
    h: config.slide.heightInch - 1.8,
    fontFace: 'Microsoft YaHei',
    fontSize: 17,
    color: '333333',
    valign: 'top',
    margin: 0.02,
  });
}

function suggestMixedTextBox(crops, config) {
  const exactBoxes = crops
    .map((crop) => crop.targetBoxEmu)
    .filter(Boolean)
    .map((box) => emuBoxToInches(box));

  if (!exactBoxes.length) {
    return {
      x: config.slide.marginInch,
      y: 0.6,
      w: 4.2,
      h: 1.2,
    };
  }

  const topMost = exactBoxes.reduce((best, box) => (box.y < best.y ? box : best), exactBoxes[0]);
  if (topMost.y > 1.45) {
    return {
      x: config.slide.marginInch,
      y: 0.6,
      w: config.slide.widthInch - config.slide.marginInch * 2 - 1.5,
      h: Math.max(0.8, topMost.y - 0.75),
    };
  }

  if (topMost.x > 4.6) {
    return {
      x: config.slide.marginInch,
      y: 0.85,
      w: Math.max(2.8, topMost.x - config.slide.marginInch - 0.2),
      h: 2.0,
    };
  }

  return {
    x: config.slide.marginInch,
    y: 0.65,
    w: 4.0,
    h: 1.45,
  };
}

function layoutBoxes(count, slideWidth, slideHeight, margin, showAutoTitle) {
  const topOffset = showAutoTitle ? 0.55 : margin;
  const usableX = margin;
  const usableY = topOffset;
  const usableW = slideWidth - margin * 2;
  const usableH = slideHeight - usableY - margin;

  if (count <= 1) {
    return [{ x: usableX, y: usableY, w: usableW, h: usableH }];
  }

  if (count === 2) {
    const gap = 0.15;
    const eachH = (usableH - gap) / 2;
    return [
      { x: usableX, y: usableY, w: usableW, h: eachH },
      { x: usableX, y: usableY + eachH + gap, w: usableW, h: eachH },
    ];
  }

  const gap = 0.15;
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const cellW = (usableW - gap * (cols - 1)) / cols;
  const cellH = (usableH - gap * (rows - 1)) / rows;
  const boxes = [];

  for (let index = 0; index < count; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    boxes.push({
      x: usableX + col * (cellW + gap),
      y: usableY + row * (cellH + gap),
      w: cellW,
      h: cellH,
    });
  }

  return boxes;
}

function contain(widthPx, heightPx, maxW, maxH) {
  const ratio = Math.min(maxW / widthPx, maxH / heightPx);
  return {
    w: widthPx * ratio,
    h: heightPx * ratio,
  };
}

function emuBoxToInches(boxEmu) {
  return {
    x: boxEmu[0] / 914400,
    y: boxEmu[1] / 914400,
    w: boxEmu[2] / 914400,
    h: boxEmu[3] / 914400,
  };
}
