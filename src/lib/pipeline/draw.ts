/**
 * Общие canvas-хелперы рендера (Preview и пути экспорта WEBM/MP4).
 * Раньше fit-contain дублировался в трёх файлах (Preview, assembleVideo,
 * videoEncoder) — любая правка letterbox-логики пришлось бы повторять 3 раза.
 */

/**
 * Fit-contain прямоугольник: изображение целиком в кадре, центрировано
 * (letterbox). Чистая функция — тестируется без canvas.
 */
export function containRect(
  imgW: number,
  imgH: number,
  w: number,
  h: number
): { dw: number; dh: number; ox: number; oy: number } {
  const imgAspect = imgW / imgH;
  const canvasAspect = w / h;
  let dw: number, dh: number;
  if (imgAspect > canvasAspect) {
    dw = w;
    dh = w / imgAspect;
  } else {
    dh = h;
    dw = h * imgAspect;
  }
  return { dw, dh, ox: (w - dw) / 2, oy: (h - dh) / 2 };
}

/** Рисует изображение целиком в кадре (contain + letterbox). */
export function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number
): void {
  const { dw, dh, ox, oy } = containRect(img.width, img.height, w, h);
  ctx.drawImage(img, ox, oy, dw, dh);
}
