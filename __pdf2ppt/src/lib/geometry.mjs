import {
  bboxAreaXYWH,
  bboxXYWHToArray,
  clampBboxXYWH,
  expandBboxXYWH,
  intersectionAreaXYWH,
  overlapRatioXYWH,
  unionBboxXYWH,
  verticalGapXYWH,
  xOverlapRatioXYWH,
} from './bbox.mjs';

export function bboxArea(bbox) {
  return bboxAreaXYWH(bbox);
}

export function unionBboxes(boxes) {
  return bboxXYWHToArray(unionBboxXYWH(boxes));
}

export function clampBbox(bbox, width, height) {
  return bboxXYWHToArray(clampBboxXYWH(bbox, [width, height]));
}

export function expandBbox(bbox, bleedPx, width, height) {
  return bboxXYWHToArray(expandBboxXYWH(bbox, bleedPx, [width, height]));
}

export function intersectionArea(a, b) {
  return intersectionAreaXYWH(a, b);
}

export function overlapRatio(a, b) {
  return overlapRatioXYWH(a, b);
}

export function xOverlapRatio(a, b) {
  return xOverlapRatioXYWH(a, b);
}

export function verticalGap(a, b) {
  return verticalGapXYWH(a, b);
}
