"use client";

import { useCallback, useState } from 'react';
import { Upload, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageUploaderProps {
  onUpload: (files: File[], dataUrls: string[]) => void;
  multiple?: boolean;
  accept?: string;
  maxFiles?: number;
}

export function ImageUploader({ onUpload, multiple = true, accept = "image/*", maxFiles = 20 }: ImageUploaderProps) {
  const [dragActive, setDragActive] = useState(false);
  const [previews, setPreviews] = useState<{ file: File; url: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).slice(0, maxFiles);
    const validFiles = fileArray.filter(f => f.type.startsWith('image/'));
    if (validFiles.length === 0) return;

    setLoading(true);
    const newPreviews: { file: File; url: string }[] = [];
    for (const file of validFiles) {
      try {
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = () => reject(new Error('read error'));
          reader.readAsDataURL(file);
        });
        newPreviews.push({ file, url });
      } catch {}
    }
    setPreviews(prev => {
      const combined = multiple ? [...prev, ...newPreviews].slice(0, maxFiles) : newPreviews.slice(0, 1);
      return combined;
    });
    setLoading(false);
  }, [multiple, maxFiles]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      handleFiles(e.target.files);
      e.target.value = '';
    }
  }, [handleFiles]);

  return (
    <div className="w-full space-y-4">
      <div
        className={cn(
          "rounded-[16px] border-2 border-dashed transition-all duration-[150ms] bg-[#16161A]",
          dragActive ? "border-[#E8B44C] bg-[#E8B44C]/5" : "border-[#26262C] hover:border-[#2F2F36]"
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <label className="flex flex-col items-center justify-center w-full h-[200px] cursor-pointer group">
          <div className="flex flex-col items-center justify-center gap-3">
            <div className="w-10 h-10 rounded-[10px] bg-[#1E1E23] group-hover:bg-[#26262C] flex items-center justify-center transition-colors duration-[150ms]">
              {loading ? <Loader2 className="w-5 h-5 text-[#8A8A93] animate-spin" /> : <Upload className="w-5 h-5 text-[#8A8A93] group-hover:text-[#F5F5F7]" />}
            </div>
            <div className="text-center">
              <p className="text-[14px] text-[#F5F5F7]"><span className="text-[#E8B44C] font-medium">Выбери файлы</span> или перетащи сюда</p>
              <p className="text-[12px] text-[#8A8A93] mt-1">PNG, JPG, WEBP до 10MB · до {maxFiles}</p>
            </div>
          </div>
          <input type="file" className="hidden" multiple={multiple} accept={accept} onChange={handleChange} />
        </label>
      </div>

      {previews.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#8A8A93]">{previews.length} изображений</span>
            <button onClick={() => setPreviews([])} className="text-xs text-[#8A8A93] hover:text-[#F5F5F7]">Очистить</button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {previews.map((p, idx) => (
              <div key={idx} className="relative group rounded-[10px] overflow-hidden bg-[#16161A] border border-[#26262C]">
                <img src={p.url} alt="" className="w-full h-24 object-cover" />
                <button onClick={() => setPreviews(prev => prev.filter((_, i) => i !== idx))} className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#0B0B0C]/80 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[#F87171] transition-all">
                  <X className="w-3 h-3" />
                </button>
                <div className="absolute top-1.5 left-1.5 bg-[#0B0B0C]/80 text-white font-mono text-[10px] px-1.5 py-0.5 rounded-[6px]">#{idx+1}</div>
              </div>
            ))}
          </div>

          <button onClick={() => onUpload(previews.map(p => p.file), previews.map(p => p.url))} disabled={loading} className="w-full h-11 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[14px] hover:bg-[#B88A2E] transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Загрузка...</> : `Обработать ${previews.length} изображений`}
          </button>
        </div>
      )}
    </div>
  );
}
