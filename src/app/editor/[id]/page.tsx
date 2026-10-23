"use client";

import { useParams } from 'next/navigation';
import { EditorView } from '@/components/studio/editor/EditorView';
import { useEditorController } from '@/components/studio/editor/useEditorController';

/**
 * Страница редактора — тонкая композиция: контроллер владеет данными и
 * побочными эффектами, EditorView только рисует (P0-1, цель ≤ 300 строк).
 */
export default function EditorPage() {
  const params = useParams();
  const id = params.id as string;
  const controller = useEditorController(id);
  return <EditorView c={controller} />;
}
