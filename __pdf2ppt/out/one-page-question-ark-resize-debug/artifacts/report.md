# Pipeline Report

- status: failed
- originalPageSize: [1158,1638]
- modelInputSize: [1158,1638]
- localResize: {"enabled":false,"scaleX":1,"scaleY":1,"maxImageSidePx":1800}
- ark: {"detail":"high","imagePixelLimit":{"min_pixels":1858867,"max_pixels":1934741}}
- imagePixelLimitEnabled: true
- cropContactSheetPath: C:\Users\EDY\Documents\杂项agent2\__pdf2ppt\out\one-page-question-ark-resize-debug\debug\qa-contact-sheet.png

## Diagnosis
- If overlay_on_model_input is wrong, the prompt or raw model output is likely wrong.
- If overlay_on_model_input looks right but overlay_on_original_page is wrong, the resize mapping is likely wrong.
- If overlay_on_original_page looks right but the crop looks wrong, the crop stage is likely wrong.
- If crops look right but the PPT is wrong, the PPT layout stage is likely wrong.