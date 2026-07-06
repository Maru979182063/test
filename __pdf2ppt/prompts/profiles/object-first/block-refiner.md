你正在细化一个已经初步识别出的局部区域。

目标仍然不是 OCR，也不是切很多碎框。
你的目标是：把这个局部区域细化成“适合直接做一页 PPT 的完整教学对象”。

允许的 type：
- cover
- section_divider
- overview_map
- knowledge_point
- example_question
- practice_question
- advanced_question
- table_object
- diagram_object
- process_object

细化规则：
- 优先少切。除非局部区域里明显存在多个完整对象，否则只返回 1 个 block。
- 默认保持对象横向完整，不要做左右碎切。
- 重点判断纵向自然边界。
- 如果是单道题，题号、题干、配图、选项、结论必须保留在一起。
- 对题目类对象，绝对不要只返回题签、题干第一行、选项尾部或残缺半题。
- 如果你不确定题目的下边界，宁可把该题的剩余选项、配图或直接相关留白一起包进去，也不要切短。
- 如果是连续多题区，按题号或自然题组拆分，但每一块都必须是完整题目。
- 如果是完整表格、流程图、思维导图，默认整个对象作为一块。
- 如果小标题只是引出其正下方对象，必须并入该对象。
- 如果拿不准，宁可返回更少、更大的块，也不要切成很多无意义小碎块。

bbox 规则：
- bbox 必须相对于当前裁图，而不是整页。
- 坐标使用整数。
- 必须输出 `"bboxFormat": "xywh_pixel_top_left"`。
- bbox 固定表示为 `[x, y, width, height]`，不是 `[x0, y0, x1, y1]`。
- 你输出的块应更像“局部横切带”，而不是很多窄竖框。

数量预期：
- 大多数局部裁图返回 1 到 3 个 block。
- 只有在局部区域里确实有多个独立题目时，才可以增加到 4 到 6 个 block。

只返回 JSON，不要输出 markdown 代码块：
{
  "blocks": [
    {
      "id": "optional-string",
      "pageRole": "exercise",
      "type": "practice_question",
      "bbox": [0, 24, 1980, 720],
      "bboxFormat": "xywh_pixel_top_left",
      "confidence": 0.92,
      "readingOrder": 1,
      "canSplit": false,
      "keepFullPageWidth": true,
      "textHint": "强化训练第1题",
      "groupHint": "q-01"
    }
  ]
}
