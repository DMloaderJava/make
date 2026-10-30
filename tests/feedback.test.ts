import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmAction,
  dismissToast,
  getPendingConfirm,
  getToasts,
  resetFeedbackForTests,
  resolveConfirm,
  subscribeFeedback,
  toast,
} from '../src/lib/ui/feedback';

/**
 * P1-4: вместо нативных alert/confirm — собственные уведомления.
 *
 * Нативные диалоги во встроенном превью (iframe без allow-modals) молча
 * возвращают false, поэтому «Озвучить» выглядел как кнопка без действия.
 */

test('P1-4: toast складывается в очередь и снимается по id', () => {
  resetFeedbackForTests();
  let notifications = 0;
  const unsubscribe = subscribeFeedback(() => {
    notifications += 1;
  });
  const first = toast('Первое уведомление');
  toast('Ошибка', 'error');
  assert.equal(getToasts().length, 2);
  assert.equal(getToasts()[1].kind, 'error');
  dismissToast(first);
  assert.deepEqual(getToasts().map((item) => item.message), ['Ошибка']);
  assert.ok(notifications >= 3, 'подписчики должны получать каждое изменение');
  unsubscribe();
});

test('P1-4: confirmAction ждёт явного ответа пользователя', async () => {
  resetFeedbackForTests();
  const promise = confirmAction({ message: 'Удалить проект?', danger: true });
  assert.equal(getPendingConfirm()?.message, 'Удалить проект?');
  resolveConfirm(true);
  assert.equal(await promise, true);
  assert.equal(getPendingConfirm(), null);
});

test('P1-4: отмена подтверждения возвращает false', async () => {
  resetFeedbackForTests();
  const promise = confirmAction({ message: 'Точно?' });
  resolveConfirm(false);
  assert.equal(await promise, false);
});

test('P1-4: новый запрос не оставляет предыдущий промис висеть', async () => {
  resetFeedbackForTests();
  const first = confirmAction({ message: 'Первый' });
  const second = confirmAction({ message: 'Второй' });
  assert.equal(await first, false, 'первый диалог закрывается как отменённый');
  assert.equal(getPendingConfirm()?.message, 'Второй');
  resolveConfirm(true);
  assert.equal(await second, true);
});

test('P1-4: resetFeedbackForTests сбрасывает и счётчик id', () => {
  resetFeedbackForTests();
  assert.equal(toast('Первый после сброса'), 1);
  toast('Второй');
  resetFeedbackForTests();
  assert.equal(toast('Снова первый'), 1);
});
