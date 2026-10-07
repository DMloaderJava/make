import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containRect } from '../src/lib/pipeline/draw';

test('containRect: изображение шире кадра → вписано по ширине, letterbox по вертикали', () => {
  // 2:1 изображение, 16:9 кадр: ширина упирается, по вертикали — полосы.
  const r = containRect(200, 100, 160, 90);
  assert.equal(r.dw, 160);
  assert.equal(r.dh, 80);
  assert.equal(r.ox, 0);
  assert.equal(r.oy, 5, 'вертикально по центру: (90-80)/2');
});

test('containRect: изображение уже кадра → вписано по высоте, letterbox по горизонтали', () => {
  // 1:2 изображение, 16:9 кадр: высота упирается, по горизонтали — полосы.
  const r = containRect(100, 200, 160, 90);
  assert.equal(r.dh, 90);
  assert.equal(r.dw, 45);
  assert.equal(r.oy, 0);
  assert.equal(r.ox, 57.5, 'горизонтально по центру: (160-45)/2');
});

test('containRect: совпадающий аспект → кадр заполняется целиком', () => {
  const r = containRect(160, 90, 160, 90);
  assert.equal(r.dw, 160);
  assert.equal(r.dh, 90);
  assert.equal(r.ox, 0);
  assert.equal(r.oy, 0);
});
