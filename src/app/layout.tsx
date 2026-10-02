import type { Metadata } from "next";
import "./globals.css";
import { MigrationRunner } from "@/components/MigrationRunner";

// Fonts: Inter + JetBrains Mono via next/font/google in prod.
// In offline CI (fonts.googleapis.com blocked) we fall back to system stack
// to keep build green. To re-enable google fonts, uncomment below:
//
// import { Inter, JetBrains_Mono } from "next/font/google";
// const inter = Inter({ variable: "--font-inter", subsets: ["latin","cyrillic"], display: "swap" });
// const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });
// Then add ${inter.variable} ${jetbrains.variable} to <html> className
// and style fontFamily var(--font-inter).

export const metadata: Metadata = {
  title: "Manga Voice Studio — Озвучка манги с AI",
  description: "Self-hosted инструмент для автоматической генерации озвученных видео из изображений манги/комиксов с множеством TTS/LLM провайдеров, интро, субтитрами и SEO-пакетом для YouTube",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Browser extensions may add attributes to <html> before React hydrates.
  return (
    <html lang="ru" className="h-full antialiased dark" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-[#0B0B0C] text-[#F5F5F7] font-sans" style={{ fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
        <MigrationRunner />
        <main className="flex-1 flex flex-col min-h-0">{children}</main>
      </body>
    </html>
  );
}
