"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageUploaderProps {
  onUpload: (files: File[], dataUrls: string[]) => void | Promise<void>;
  multiple?: boolean;
  accept?: string;
}

type Preview = { file: File; url: string };

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`Не удалось прочитать ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function ImageUploader({ onUpload, multiple = true, accept = 'image/*' }: ImageUploaderProps) {
  const [dragActive, setDragActive] = useState(false);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewsRef = useRef<Preview[]>([]);

  // Object URLs нужны только для миниатюр. Они не держат вторую base64-копию файла.
  // Текущие URL освобождаем точечно при удалении/замене и все оставшиеся — при unmount.
  useEffect(() => { previewsRef.current = previews; }, [previews]);
  useEffect(() => () => {
    for (const preview of previewsRef.current) URL.revokeObjectURL(preview.url);
  }, []);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    const validFiles = incoming.filter(file => file.type.startsWith('image/'));
    const invalidCount = incoming.length - validFiles.length;
    if (validFiles.length === 0) {
      setError('Выберите файлы изображений (PNG, JPG, WEBP и другие форматы, которые поддерживает браузер).');
      return;
    }

    setError(invalidCount > 0 ? `Пропущено файлов не-изображений: ${invalidCount}` : null);
    const newPreviews = validFiles.map(file => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(previous => {
      if (!multiple) {
        for (const preview of previous) URL.revokeObjectURL(preview.url);
        return newPreviews.slice(0, 1);
      }

      // Повторный выбор того же имени заменяет старую запись, а не дублирует её.
      const incomingNames = new Set(validFiles.map(file => `${file.name}\u0000${file.size}\u0000${file.lastModified}`));
      const kept = previous.filter(preview => !incomingNames.has(`${preview.file.name}\u0000${preview.file.size}\u0000${preview.file.lastModified}`));
      for (const preview of previous) {
        if (!kept.includes(preview)) URL.revokeObjectURL(preview.url);
      }
      return [...kept, ...newPreviews];
    });
  }, [multiple]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (event.dataTransfer.files.length > 0) handleFiles(event.dataTransfer.files);
  }, [handleFiles]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) handleFiles(event.target.files);
    event.target.value = '';
  }, [handleFiles]);

  const clearPreviews = () => {
    for (const preview of previews) URL.revokeObjectURL(preview.url);
    setPreviews([]);
    setError(null);
  };

  const removePreview = (index: number) => {
    const removed = previews[index];
    if (removed) URL.revokeObjectURL(removed.url);
    setPreviews(previous => previous.filter((_, current) => current !== index));
  };

  const submit = async () => {
    if (previews.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      // Читаем последовательно: при большой пачке не создаём все base64-строки до старта.
      const files = previews.map(preview => preview.file);
      const dataUrls: string[] = [];
      for (const file of files) dataUrls.push(await readAsDataURL(file));
      await onUpload(files, dataUrls);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось обработать изображения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full space-y-4">
      <div
        className={cn(
          'rounded-[16px] border-2 border-dashed transition-all duration-[150ms] bg-[#16161A]',
          dragActive ? 'border-[#E8B44C] bg-[#E8B44C]/5' : 'border-[#26262C] hover:border-[#2F2F36]'
        )}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDrop={handleDrop}
      >
        <label className="flex flex-col items-center justify-center w-full h-[200px] cursor-pointer group">
          <div className="flex flex-col items-center justify-center gap-3">
            <div className="w-10 h-10 rounded-[10px] bg-[#1E1E23] group-hover:bg-[#26262C] flex items-center justify-center transition-colors duration-[150ms]">
              {loading ? <Loader2 className="w-5 h-5 text-[#8A8A93] animate-spin" /> : <Upload className="w-5 h-5 text-[#8A8A93] group-hover:text-[#F5F5F7]" />}
            </div>
            <div className="text-center">
              <p className="text-[14px] text-[#F5F5F7]"><span className="text-[#E8B44C] font-medium">Выбери файлы</span> или перетащи сюда</p>
              <p className="text-[12px] text-[#8A8A93] mt-1">PNG, JPG, WEBP и другие изображения · количество не ограничено</p>
            </div>
          </div>
          <input data-testid="home-image-input" type="file" className="hidden" multiple={multiple} accept={accept} onChange={handleChange} disabled={loading} />
        </label>
      </div>

      {error && <p className="text-[11px] leading-4 text-[#E86C4C]" role="alert">{error}</p>}

      {previews.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#8A8A93]">Выбрано: {previews.length} изображений</span>
            <button onClick={clearPreviews} disabled={loading} className="text-xs text-[#8A8A93] hover:text-[#F5F5F7] disabled:opacity-40">Очистить</button>
          </div>

          <div className="grid grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1">
            {previews.map((preview, index) => (
              <div key={`${preview.file.name}-${preview.file.lastModified}-${index}`} className="relative group rounded-[10px] overflow-hidden bg-[#16161A] border border-[#26262C]">
                <img src={preview.url} alt={preview.file.name} loading="lazy" className="w-full h-24 object-cover" />
                <button onClick={() => removePreview(index)} disabled={loading} className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#0B0B0C]/80 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[#F87171] transition-all disabled:opacity-40" aria-label={`Удалить ${preview.file.name}`}>
                  <X className="w-3 h-3" />
                </button>
                <div className="absolute top-1.5 left-1.5 bg-[#0B0B0C]/80 text-white font-mono text-[10px] px-1.5 py-0.5 rounded-[6px]">#{index + 1}</div>
              </div>
            ))}
          </div>

          <button data-testid="home-process-images-btn" onClick={() => void submit()} disabled={loading} className="w-full h-11 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[14px] hover:bg-[#B88A2E] transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Подготовка изображений...</> : `Обработать ${previews.length} изображений`}
          </button>
        </div>
      )}
    </div>
  );
}
