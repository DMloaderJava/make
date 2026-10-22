/**
 * Загрузка изображений страниц для превью и экспорта.
 *
 * Зачем отдельный модуль: длинные webtoon-полосы (900×12540 и выше) декодируются
 * заметно дольше обычных страниц. Раньше каждый загрузчик ждал фиксированные
 * 2–3 с и продолжал работу, даже если картинка ещё не готова — в превью и в
 * кадре экспорта получался пустой (белый/чёрный) кадр, который больше никогда
 * не перерисовывался. Здесь ждём настоящее событие `load`/`decode`, а таймаут
 * оставлен только как страховка от «вечного» изображения.
 */

export interface LoadImageOptions {
  /** Страховочный таймаут, мс. По умолчанию 30 с — с запасом на длинные полосы. */
  timeoutMs?: number;
  crossOrigin?: boolean | string;
}

/**
 * Резолвится всегда: при ошибке/таймауте вернётся объект Image, у которого
 * `complete === false`. Вызывающий может повесить `load`-слушатель и дорисовать
 * кадр позже — именно так делает Preview.
 */
export function loadImageElement(src: string, options: LoadImageOptions = {}): Promise<HTMLImageElement> {
  return new Promise(resolve => {
    const img = new Image();
    if (options.crossOrigin !== undefined) img.crossOrigin = options.crossOrigin as string;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(img);
    };
    const timer = setTimeout(finish, options.timeoutMs ?? 30_000);
    img.onload = () => {
      clearTimeout(timer);
      finish();
    };
    img.onerror = () => {
      clearTimeout(timer);
      finish();
    };
    img.src = src;
  });
}

/** Признак того, что картинку уже можно рисовать в canvas. */
export function isImageDrawable(img: HTMLImageElement | null | undefined): boolean {
  return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}
