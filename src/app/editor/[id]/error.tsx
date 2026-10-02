"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

type EditorErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function EditorError({ error, reset }: EditorErrorProps) {
  useEffect(() => {
    console.error("[editor] Unhandled editor error:", error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center bg-[#0B0B0C] px-4 py-10">
      <div className="w-full max-w-lg rounded-[16px] border border-[#26262C] bg-[#16161A] p-6 text-center" role="alert" aria-live="assertive">
        <AlertTriangle className="mx-auto h-8 w-8 text-[#F87171]" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-medium">Редактор столкнулся с ошибкой</h1>
        <p className="mt-2 text-sm text-[#A1A1AA]">
          Не удалось отобразить редактор. Данные проекта не были удалены. Можно попробовать загрузить страницу ещё раз.
        </p>
        {error.message && (
          <details className="mt-4 text-left text-xs text-[#8A8A93]">
            <summary className="cursor-pointer">Подробности ошибки</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{error.message}</pre>
          </details>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="h-9 rounded-[6px] bg-[#E8B44C] px-4 text-sm font-medium text-[#0B0B0C] hover:bg-[#B88A2E] transition-colors"
          >
            Повторить
          </button>
          <Link
            href="/"
            className="h-9 rounded-[6px] border border-[#26262C] px-4 text-sm text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors flex items-center"
          >
            К проектам
          </Link>
        </div>
      </div>
    </div>
  );
}
