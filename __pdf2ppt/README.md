# PDF -> PPT Automation Scaffold

This scaffold is built around the workflow we discussed:

1. Render or collect high-resolution page images.
2. Let a model detect meaningful teaching blocks.
3. Let a model decide how blocks become slides.
4. Crop the source images by bbox.
5. Build a white-background PPT with a top-right logo.

The current scaffold is intentionally split into stable program stages and replaceable model stages.

## What Is Already Wired

- `page-images -> pages.json`
- `pdf-poppler -> page-images -> pages.json`
- `pages.json -> blocks.json` via a mock model adapter
- `blocks.json -> slide-plan.json` via a mock planner adapter
- `slide-plan.json -> crops`
- `crops -> pptx`

## What Still Needs A Real Adapter Later

- Optional: high-definition re-crop from the original PDF instead of from page PNGs

The Ark model adapter is now wired in for:

- block detection with page images
- slide planning from detected block metadata

The remaining manual gap is mostly prompt iteration and PDF-native high-definition recrop.

## Folder Layout

- `automation.mjs`: CLI entry
- `sample-job.json`: example job config
- `prompts/`: model prompt templates
- `src/stages/`: pipeline stages
- `src/adapters/mock-vision-model.mjs`: mock model behavior

## Output Layout

Each run writes into `outputDir` from your config:

- `artifacts/pages.json`
- `artifacts/blocks.json`
- `artifacts/slide-plan.json`
- `artifacts/crops.json`
- `artifacts/job-summary.json`
- `crops/*.png`
- `*.pptx`

## How To Use This Scaffold

1. Put prepared page images into a folder.
2. Update `sample-job.json` or create a new config file.
3. Run `npm run pipeline`.

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
      "blockId": "p003-b02"
    }
  ]
}
```

## Model-Critical Nodes

These are the places where a real model should make decisions:

- block detection
- slide grouping
- cross-page split / merge judgment
- optional: auto-generated slide labels

Everything else should stay deterministic.
