import { NextRequest, NextResponse } from 'next/server';

// Next.js 16+ official: proxy.ts replaces middleware.ts (Node runtime, network boundary)
// Docs: https://nextjs.org/blog/next-16 — section "`proxy.ts` (formerly `middleware.ts`)"
//
// Правки v1.3.2:
// - пароль больше не попадает в URL: форма отправляется POST-ом;
// - в cookie лежит SHA-256 хэш пароля, а не сам пароль;
// - флаг MVS_SECURE_COOKIE управляет Secure-атрибутом (прод по http иначе не может войти);
// - GET ?password=… оставлен для обратной совместимости со старыми ссылками.

const COOKIE_NAME = 'mvs_auth';

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`mvs:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function secureCookie(): boolean {
  // По умолчанию Secure ВЫКЛЮЧЕН: типовой self-host работает по http, и с
  // автоматическим Secure из production-сборки войти было невозможно.
  // За обратным прокси с TLS включайте явно: MVS_SECURE_COOKIE=1.
  return process.env.MVS_SECURE_COOKIE === '1';
}

function withAuthCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

function loginPage(message?: string): NextResponse {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Manga Voice Studio - Protected</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="background:#0B0B0C;color:#F5F5F7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
      <form method="POST" action="/__auth" style="background:#16161A;border:1px solid #26262C;padding:2rem;border-radius:16px;max-width:400px;width:100%">
        <h1 style="margin:0 0 0.5rem;font-size:1.25rem">🔒 Protected</h1>
        <p style="color:#8A8A93;font-size:0.875rem;margin:0 0 1rem">Введи пароль для доступа (MVS_PASSWORD)</p>
        ${message ? `<p style="color:#F87171;font-size:0.8125rem;margin:0 0 0.75rem">${message}</p>` : ''}
        <input type="password" name="password" placeholder="Пароль" style="width:100%;padding:0.5rem 0.75rem;background:#0B0B0C;border:1px solid #26262C;border-radius:10px;color:#F5F5F7;margin-bottom:1rem;box-sizing:border-box" autofocus />
        <button type="submit" style="width:100%;padding:0.5rem;background:#E8B44C;color:#0B0B0C;border:none;border-radius:10px;cursor:pointer;font-weight:500">Войти</button>
      </form>
    </body>
    </html>
  `;
  return new NextResponse(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function proxy(req: NextRequest) {
  const password = process.env.MVS_PASSWORD;
  if (!password) return NextResponse.next();

  const expectedToken = await hashPassword(password);

  // Разлогин
  if (req.nextUrl.pathname === '/__logout') {
    const res = NextResponse.redirect(new URL('/', req.url));
    res.cookies.set(COOKIE_NAME, '', { path: '/', maxAge: 0 });
    return res;
  }

  // Сабмит формы логина
  if (req.nextUrl.pathname === '/__auth' && req.method === 'POST') {
    let submitted = '';
    try {
      const form = await req.formData();
      submitted = String(form.get('password') || '');
    } catch {
      submitted = '';
    }
    const submittedToken = await hashPassword(submitted);
    if (timingSafeEqualStr(submittedToken, expectedToken)) {
      return withAuthCookie(NextResponse.redirect(new URL('/', req.url)), expectedToken);
    }
    return loginPage('Неверный пароль');
  }

  const cookieToken = req.cookies.get(COOKIE_NAME)?.value;
  if (cookieToken && timingSafeEqualStr(cookieToken, expectedToken)) return NextResponse.next();

  // Обратная совместимость: старые ссылки вида /?password=...
  const urlPassword = req.nextUrl.searchParams.get('password');
  if (urlPassword && timingSafeEqualStr(await hashPassword(urlPassword), expectedToken)) {
    const cleanUrl = new URL(req.url);
    cleanUrl.searchParams.delete('password');
    return withAuthCookie(NextResponse.redirect(cleanUrl), expectedToken);
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const [, providedPassword] = decoded.split(':');
      if (
        (providedPassword && timingSafeEqualStr(providedPassword, password)) ||
        timingSafeEqualStr(decoded, password)
      ) {
        return NextResponse.next();
      }
    } catch {}
  }

  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return loginPage();
}

export default proxy;

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
