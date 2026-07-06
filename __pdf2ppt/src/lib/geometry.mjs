export function clampBbox(bbox, widthPx, heightPx) {
  const [x, y, w, h] = bbox;
  const left = Math.max(0, Math.min(x, widthPx - 1));
  const top = Math.max(0, Math.min(y, heightPx - 1));
  const right = Math.max(left + 1, Math.min(x + w, widthPx));
  const bottom = Math.max(top + 1, Math.min(y + h, heightPx));
  return [left, top, right - left, bottom - top];
}

export function expandBbox(bbox, bleedPx, widthPx, heightPx) {
  return clampBbox(
    [bbox[0] - bleedPx, bbox[1] - bleedPx, bbox[2] + bleedPx * 2, bbox[3] + bleedPx * 2],
    widthPx,
    heightPx
  );
}

export function bboxArea(bbox) {
  return Math.max(0, bbox[2]) * Math.max(0, bbox[3]);
}

export function overlapRatio(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  if (right <= left || bottom <= top) {
    return 0;
  }
  const overlapArea = (right - left) * (bottom - top);
  return overlapArea / Math.max(1, Math.min(bboxArea(a), bboxArea(b)));
}

export function unionBboxes(bboxes) {
  if (!bboxes.length) {
    return [0, 0, 0, 0];
  }
  const left = Math.min(...bboxes.map((bbox) => bbox[0]));
  const top = Math.min(...bboxes.map((bbox) => bbox[1]));
  const right = Math.max(...bboxes.map((bbox) => bbox[0] + bbox[2]));
  const bottom = Math.max(...bboxes.map((bbox) => bbox[1] + bbox[3]));
  return [left, top, right - left, bottom - top];
}
