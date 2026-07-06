# PDF -> PPT Automation Scaffold

当前代码的真实链路是：

1. 渲染 PDF 或直接读取页图。
2. 检测页面内容块，输出 `blocks.json`。
3. 规划 slide，输出 `slide-plan.json`。
4. 按统一 bbox 协议裁图，输出 `crops.json` 和 `crops/*.png`。
5. 生成 `pptx`。

当前已经实现了 mock 全链路，也保留了 Ark 适配器入口。在主 pipeline 里，Ark 只会在 `detectBlocks.mode = "ark" | "ark-two-pass"` 或 `planSlides.mode = "ark"` 时按需加载，不会再因为静态 import 影响 mock pipeline。独立诊断脚本 `check-ark.mjs` 和 `list-ark-models.mjs` 仍然会直接使用 Ark adapter。

## Implemented

- `page-images -> pages.json`
- `pdf-poppler -> page-images -> pages.json`
- `pages.json -> blocks.json` via mock or Ark
- `blocks.json -> slide-plan.json` via mock, rules, derived report, json-file, or Ark
- `slide-plan.json -> crops.json + crops/*.png`
- `crops -> pptx`
- detect 阶段 debug 产物：
  - `debug/page_XXX_raw_model_input.png`
  - `debug/page_XXX_overlay_on_model_input.png`
  - `debug/page_XXX_blocks_report.json`
- crop 阶段 debug 产物：
  - `debug/crop_contact_sheet.png`

## Bbox Contract

工程内统一使用：

- `bboxFormat: "xywh_pixel_top_left"`
- `bbox = [x, y, width, height]`

不要把它当成 `[x0, y0, x1, y1]`。

所有进入工程的模型 bbox 都会在落盘前做规范化和校验：

- `w > 0`
- `h > 0`
- bbox 不得越界
- bbox 所属 `pageSize` 必须和实际页图尺寸一致

`artifacts/crops.json` 会保留：

- `rawBbox`
- `expandedBbox`
- `finalCropBbox`
- `cropSize`

## Folder Layout

- `automation.mjs`: CLI entry
- `sample-job.json`: example job config
- `prompts/`: model prompt templates
- `src/stages/`: pipeline stages
- `src/adapters/mock-vision-model.mjs`: mock model behavior
- `src/adapters/ark-model.mjs`: Ark adapter for Ark pipeline modes and Ark diagnostic scripts
- `src/lib/bbox.mjs`: bbox parsing, validation, expand, clamp, union helpers

## Output Layout

Each run writes into `outputDir` from your config:

- `artifacts/pages.json`
- `artifacts/blocks.json`
- `artifacts/slide-plan.json`
- `artifacts/crops.json`
- `artifacts/job-summary.json`
- `crops/*.png`
- `*.pptx`
- `debug/*.png`
- `debug/*.json`

## How To Use This Scaffold

1. Put prepared page images into a folder.
2. Update `sample-job.json` or create a new config file.
3. Run `npm run pipeline`.

Run tests with:

```bash
npm test
```

For a provider smoke check before a full run:

```bash
npm run check:ark
```

To inspect which models the current key can actually access:

```bash
npm run list:ark-models
```

## Ark Provider Config

The scaffold supports Volcengine Ark Responses API with a provider block like:

```json
{
  "provider": {
    "type": "ark",
    "apiKey": "ark-...",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "model": "doubao-seed-1-8-251228",
    "apiStyle": "auto",
    "imageDetail": "high",
    "maxImageSidePx": 2048,
    "maxOutputTokens": 4096
  }
}
```

If your Ark account requires a concrete endpoint ID instead of the model family name, replace `model` with that exact endpoint/model string. On the current key we checked, `doubao-seed-1-8-251228` is available.

`apiStyle` can be:

- `auto`
- `responses`
- `chat`

`auto` tries the Responses API first, then falls back to OpenAI-compatible chat completions.

If you are only running the mock pipeline, you do not need the Ark adapter or API key.

## PDF Rendering

Use `pipeline.render.mode = "pdf-poppler"` to render a PDF through Poppler:

```json
{
  "inputs": {
    "pdfPath": "C:/path/to/input.pdf"
  },
  "pipeline": {
    "render": {
      "mode": "pdf-poppler",
      "dpi": 220,
      "firstPage": 1,
      "maxPages": 2,
      "binaryPath": "C:/path/to/pdftoppm.cmd"
    }
  }
}
```

If `binaryPath` is empty, the scaffold tries `pdftoppm`, `pdftoppm.cmd`, and then the common Codex runtime Poppler path.

## Data Contracts

### `blocks.json`

Each block is a semantic region that should survive downstream processing:

```json
{
  "id": "p003-b02",
  "pageNumber": 3,
  "type": "example",
  "bbox": [120, 840, 2780, 1580],
  "bboxFormat": "xywh_pixel_top_left",
  "pageSize": [3000, 4200],
  "confidence": 0.91,
  "readingOrder": 2,
  "canSplit": false,
  "textHint": "例题：根据图像判断...",
  "groupHint": "example-3"
}
```

### `slide-plan.json`

Each slide references one or more source blocks:

```json
{
  "slideId": "s003",
  "title": "Example",
  "sourcePages": [3],
  "placements": [
    {
      "blockId": "p003-b02",
      "bboxFormat": "xywh_pixel_top_left"
    }
  ]
}

## Logo Config

推荐写法：

```json
{
  "branding": {
    "logoPath": "./assets/logo.png"
  }
}
```

为了兼容旧配置，`build-ppt` 仍然接受 `inputs.logoPath`，但新的示例配置已经统一到 `branding.logoPath`。
```

## Model-Critical Nodes

These are the places where a real model should make decisions:

- block detection
- slide grouping
- cross-page split / merge judgment
- optional: auto-generated slide labels

Everything else should stay deterministic.
