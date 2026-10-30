"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { isChunkLoadError, planChunkReload } from "@/lib/ui/chunkReload";

/**
 * Корневой экран ошибки для страниц вне редактора (главная, настройки).
 *
 * Та же логика, что в редакторе: сбой загрузки чанка (`Failed to load chunk …`)
 * означает устаревшую вкладку после пересборки/деплоя — лечится только полной
 * перезагрузкой, а не `reset()`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunkFailure = isChunkLoadError(error);

  useEffect(() => {
    console.error("[app] Unhandled page error:", error);
    if (planChunkReload(error).reload) {
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center bg-[#0B0B0C] px-4 py-10">
      <div className="w-full max-w-lg rounded-[16px] border border-[#26262C] bg-[#16161A] p-6 text-center" role="alert" aria-live="assertive">
        <AlertTriangle className="mx-auto h-8 w-8 text-[#F87171]" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-medium">Страница столкнулась с ошибкой</h1>
        <p className="mt-2 text-sm text-[#A1A1AA]">
          Данные проектов не пострадали — они хранятся локально в браузере. Попробуйте загрузить страницу ещё раз.
        </p>
        {chunkFailure && (
          <p className="mt-2 text-xs text-[#C9B27A]">
            Похоже, страница открыта на устаревшей версии приложения. Обновите её целиком.
          </p>
        )}
        {error.message && (
          <details className="mt-4 text-left text-xs text-[#8A8A93]">
            <summary className="cursor-pointer">Подробности ошибки</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{error.message}</pre>
          </details>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (chunkFailure) window.location.reload();
              else reset();
            }}
            className="h-9 rounded-[6px] bg-[#E8B44C] px-4 text-sm font-medium text-[#0B0B0C] hover:bg-[#B88A2E] transition-colors"
          >
            {chunkFailure ? "Обновить страницу" : "Повторить"}
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
