import { NextRequest, NextResponse } from 'next/server';

// Next.js 16+ official: proxy.ts replaces middleware.ts (Node runtime, network boundary)
// Docs: https://nextjs.org/blog/next-16 — section "`proxy.ts` (formerly `middleware.ts`)"
// Quote: "`proxy.ts` replaces `middleware.ts` and makes the app's network boundary explicit. `proxy.ts` runs on the Node.js runtime."
// Note: middleware.ts is still supported for Edge but deprecated. Using proxy.ts is correct for Next 16.3.7.
// Tested: MVS_PASSWORD=secret npm run dev → curl http://localhost:3000 → 401 with HTML form ✓
export function proxy(req: NextRequest) {
  const password = process.env.MVS_PASSWORD;
  if (!password) return NextResponse.next();

  const cookiePassword = req.cookies.get('mvs_auth')?.value;
  if (cookiePassword === password) return NextResponse.next();

  const urlPassword = req.nextUrl.searchParams.get('password');
  if (urlPassword === password) {
    const response = NextResponse.next();
    response.cookies.set('mvs_auth', password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const [, providedPassword] = decoded.split(':');
      if (providedPassword === password || decoded === password) return NextResponse.next();
    } catch {}
  }

  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Manga Voice Studio - Protected</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="background:#0B0B0C;color:#F5F5F7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
      <form method="GET" style="background:#16161A;border:1px solid #26262C;padding:2rem;border-radius:16px;max-width:400px;width:100%">
        <h1 style="margin:0 0 0.5rem;font-size:1.25rem">🔒 Protected</h1>
        <p style="color:#8A8A93;font-size:0.875rem;margin:0 0 1rem">Введи пароль для доступа (MVS_PASSWORD)</p>
        <input type="password" name="password" placeholder="Пароль" style="width:100%;padding:0.5rem 0.75rem;background:#0B0B0C;border:1px solid #26262C;border-radius:10px;color:#F5F5F7;margin-bottom:1rem;box-sizing:border-box" autofocus />
        <button type="submit" style="width:100%;padding:0.5rem;background:#E8B44C;color:#0B0B0C;border:none;border-radius:10px;cursor:pointer;font-weight:500">Войти</button>
      </form>
    </body>
    </html>
  `;
  return new NextResponse(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default proxy;

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
