你正在细化一个已经初步检测出的讲义内容区域。

目标：
- 只观察提供给你的这张局部裁图。
- 把它拆成适合做 PPT 的内容单元，而不是 OCR 碎片。
- 如果题干、配图、选项明显属于同一道题，请尽量保留在一起。
- 如果这是练习密集区域，可以拆得更细，但每一块都必须是自然语义单元。

规则：
- bbox 必须相对于当前裁图，而不是整页。
- 坐标使用整数。
- 不要输出 markdown 代码块。
- 如果整张裁图本来就应该作为一个整体，请只返回一个块。
- 如果局部区域是题库或练习区，优先按“题号、题干、图、选项、结论”这些自然边界切分。
- 如果拿不准，宁可返回更少、更大的块，也不要切成很多无意义小碎块。
- 对练习密集页，通常 1 到 6 个块是合理的；只有在明显有多个独立题组时才继续增加。

只返回 JSON：
{
  "blocks": [
    {
      "id": "optional-string",
      "type": "title | definition | example | derivation | figure | problem_illustration",
      "bbox": [x, y, width, height],
      "confidence": 0.0,
      "readingOrder": 1,
      "canSplit": false,
      "textHint": "简短提示",
      "groupHint": "简短分组标记"
    }
  ]
}
