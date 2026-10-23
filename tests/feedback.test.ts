import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './helpers/stripComments';
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

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

test('P1-4: в src/ не осталось вызовов alert/confirm (комментарии не в счёт)', () => {
  const files = collectSourceFiles(join(process.cwd(), 'src'));
  const offenders: string[] = [];
  for (const file of files) {
    // Комментарии вырезаем: упоминание «не alert, а toast» — не вызов,
    // и падать на нём структурная проверка не должна.
    const text = stripComments(readFileSync(file, 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (/\balert\(|\bconfirm\(/.test(line)) {
        offenders.push(`${file.replace(process.cwd() + '/', '')}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `нативные диалоги вернулись: ${offenders.join(', ')}`);
});

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
