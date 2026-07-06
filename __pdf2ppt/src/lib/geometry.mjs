import { clamp } from './fs-utils.mjs';

export function bboxArea(bbox) {
  return Math.max(0, bbox[2] || 0) * Math.max(0, bbox[3] || 0);
}

export function unionBboxes(boxes) {
  if (!boxes.length) return [0, 0, 1, 1];
  const left = Math.min(...boxes.map((box) => box[0]));
  const top = Math.min(...boxes.map((box) => box[1]));
  const right = Math.max(...boxes.map((box) => box[0] + box[2]));
  const bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

export function clampBbox(bbox, width, height) {
  const [x, y, w, h] = bbox;
  const left = clamp(Math.round(x), 0, width);
  const top = clamp(Math.round(y), 0, height);
  const right = clamp(Math.round(x + w), 0, width);
  const bottom = clamp(Math.round(y + h), 0, height);
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

export function expandBbox(bbox, bleedPx, width, height) {
  const [x, y, w, h] = bbox;
  return clampBbox(
    [x - bleedPx, y - bleedPx, w + bleedPx * 2, h + bleedPx * 2],
    width,
    height
  );
}

export function intersectionArea(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function overlapRatio(a, b) {
  const denom = Math.max(1, Math.min(bboxArea(a), bboxArea(b)));
  return intersectionArea(a, b) / denom;
}

export function xOverlapRatio(a, b) {
  const left = Math.max(a[0], b[0]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  return Math.max(0, right - left) / Math.max(1, Math.min(a[2], b[2]));
}

export function verticalGap(a, b) {
  const aBottom = a[1] + a[3];
  const bTop = b[1];
  return bTop - aBottom;
}
