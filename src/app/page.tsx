"use client";

import { useEffect, useState } from 'react';
import { ImageUploader } from '@/components/upload/ImageUploader';
import { getAllProjects, createProject, Project } from '@/lib/storage/db';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { processAllImages, mergeVisionResults } from '@/lib/pipeline/extractPanels';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

function formatDurationSafe(timeline?: any[], panelsLen?: number): string {
  const last = timeline?.[timeline.length - 1]?.audioEnd;
  if (last && isFinite(last) && last > 0) {
    const m = Math.floor(last / 60);
    const s = Math.floor(last % 60);
    return `${m}:${String(s).padStart(2,'0')} · ${panelsLen ?? 0} панелей`;
  }
  if ((panelsLen ?? 0) > 0) return `${panelsLen} панелей`;
  return '—';
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; stage: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    const all = await getAllProjects();
    setProjects(all);
    const map: Record<string, string> = {};
    for (const p of all.slice(0, 9)) {
      try {
        if (p.useOPFS && p.imageFiles?.[0]) {
          const { loadProjectImageAsDataURL } = await import('@/lib/storage/opfs');
          map[p.id] = await loadProjectImageAsDataURL(p.id, p.imageFiles[0]);
        } else if (p.images[0]) {
          map[p.id] = p.images[0];
        }
      } catch {}
    }
    setPreviews(map);
  };

  const handleUpload = async (files: File[], dataUrls: string[]) => {
    const settings = getSettings();
    const keys = getAllKeys();
    const provider = getLLMProvider(settings.defaultLLMProvider) || getLLMProvider('openrouter')!;
    const llmId = provider.id;
    const apiKey = keys[llmId] || (llmId === 'gemini' ? keys['google-ai'] : '');
    const custom = localStorage.getItem('mvs-info:custom-llm-config') || localStorage.getItem('custom-llm-config');
    let baseUrl: string | undefined;
    let model = resolveLLMVisionModel(provider, settings.defaultVisionModel);
    if (llmId === 'custom' && custom) {
      try {
        const cfg = JSON.parse(custom);
        baseUrl = cfg.baseUrl;
        model = cfg.model || model;
      } catch {}
    }

    if (!model) {
      alert(`${provider.name} не имеет доступной модели для анализа изображений. Выберите vision-провайдера в настройках.`);
      router.push('/settings');
      return;
    }
    if (!apiKey) { alert(`Добавь ключ для ${provider.name} в Провайдерах`); router.push('/settings'); return; }

    setIsProcessing(true);
    setProgress({ current: 0, total: dataUrls.length, stage: 'Анализ...' });

    let project: Project | null = null;
    try {
      project = await createProject(`Проект ${new Date().toLocaleDateString('ru-RU')}`, files as any);
      const results = await processAllImages(dataUrls, provider, {
        apiKey,
        model,
        baseUrl,
        accountId: settings.cloudflareAccountId,
        temperature: 0.2,
        maxTokens: 4000,
      }, (c, t) => setProgress({ current: c, total: t, stage: `Анализ ${c}/${t}` }));
      const merged = mergeVisionResults(results);

      const updated: Project = {
        ...project,
        panels: merged.allPanels as any,
        characters: merged.allCharacters.map(c => ({ name: c.name, appearance: c.appearance, voiceId: '', emotion: 'neutral' })),
        sceneDescription: merged.sceneDescription,
        settings: { ...project.settings, llmProvider: llmId, ttsProvider: settings.defaultTTSProvider, visionModel: model, musicVolume: settings.backgroundMusicVolume },
        introDuration: settings.introDuration,
        outroDuration: settings.outroDuration,
      };

      const { saveProject } = await import('@/lib/storage/db');
      await saveProject(updated);
      router.push(`/editor/${project.id}`);
    } catch (e: any) {
      if (project) {
        try {
          const { deleteProject } = await import('@/lib/storage/db');
          await deleteProject(project.id);
        } catch {}
      }
      alert(`Ошибка: ${e.message}`);
    } finally {
      setIsProcessing(false);
      setProgress(null);
    }
  };

  const handleDemo = async () => {
    try {
      const project = await createProject(`Демо ${new Date().toLocaleDateString('ru-RU')}`, [] as any);
      const mockPanels = [
        { id: 0, bbox: { x: 5, y: 5, width: 90, height: 40 }, dialogue: 'Ты действительно думаешь, что сможешь победить меня?', character: 'Антагонист', emotion: 'angry', type: 'speech' as const, order: 0, imageIndex: 0 },
        { id: 1, bbox: { x: 10, y: 50, width: 80, height: 30 }, dialogue: 'Я не думаю. Я знаю.', character: 'Герой', emotion: 'neutral', type: 'speech' as const, order: 1, imageIndex: 0 },
      ];
      const updated: Project = {
        ...project,
        images: ['https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&h=1200&fit=crop'],
        useOPFS: false,
        panels: mockPanels as any,
        characters: [
          { name: 'Герой', appearance: 'Молодой воин', voiceId: '', emotion: 'neutral' },
          { name: 'Антагонист', appearance: 'Мощный противник', voiceId: '', emotion: 'angry' }
        ],
        sceneDescription: 'Эпическая битва, напряжённый диалог перед кульминацией.',
        intro: 'Вы когда-нибудь видели момент, когда всё решается одним ударом? Эта сцена именно такая. Сейчас вы увидите.',
        outro: 'Спасибо за просмотр! Больше — в шапке профиля. Подписывайтесь!',
        settings: { ttsProvider: 'gemini', llmProvider: 'openrouter', visionModel: 'google/gemma-4-31b-it:free', musicVolume: 0.15 },
        introDuration: 8,
        outroDuration: 5,
      };
      const { saveProject } = await import('@/lib/storage/db');
      await saveProject(updated);
      router.push(`/editor/${project.id}`);
    } catch (e: any) {
      alert(`Демо ошибка: ${e.message}`);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Удалить проект?')) return;
    const { deleteProject } = await import('@/lib/storage/db');
    await deleteProject(id);
    loadProjects();
  };

  return (
    <div className="flex-1 bg-[#0B0B0C]">
      <div className="max-w-[960px] mx-auto p-4 md:p-8 space-y-10">
        <div className="flex items-center justify-between pt-4">
          <h1 className="text-[20px] font-medium tracking-tight">Manga Voice Studio</h1>
          <Link href="/settings" className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors flex items-center">
            Провайдеры
          </Link>
        </div>

        <div className="py-8 space-y-6">
          <div className="text-center space-y-3">
            <h2 className="text-[28px] md:text-[36px] font-medium leading-tight">Кидай сюда страницы манги</h2>
            <p className="text-[14px] text-[#8A8A93] max-w-[480px] mx-auto">AI разберёт панели, озвучит голосами, соберёт видео 16:9 с SEO для YouTube</p>
          </div>

          <div className="max-w-[560px] mx-auto">
            {isProcessing && progress ? (
              <div className="p-8 rounded-[16px] bg-[#16161A] border border-[#26262C] text-center space-y-3">
                <div className="w-6 h-6 border-2 border-[#26262C] border-t-[#E8B44C] rounded-full animate-spin mx-auto" />
                <p className="text-sm">{progress.stage}</p>
                <div className="h-1 bg-[#0B0B0C] rounded-full overflow-hidden">
                  <div className="h-full bg-[#E8B44C] transition-all" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-[16px] border border-dashed border-[#26262C] bg-[#16161A] p-2">
                  <ImageUploader onUpload={handleUpload} multiple maxFiles={20} />
                </div>
                <div className="flex justify-center gap-2">
                  <button onClick={handleDemo} className="text-xs text-[#8A8A93] hover:text-[#F5F5F7] transition-colors">Попробовать демо без ключей →</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {projects.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-[13px] font-medium text-[#8A8A93]">Недавнее</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {projects.map((p) => (
                <Link key={p.id} href={`/editor/${p.id}`} className="group relative">
                  <div className="aspect-[16/9] rounded-[10px] overflow-hidden bg-[#16161A] border border-[#26262C] group-hover:border-[#2F2F36] transition-colors">
                    {previews[p.id] ? (
                      <img src={previews[p.id]} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-[220ms]" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#8A8A93] text-xs">нет превью</div>
                    )}
                  </div>
                  <div className="mt-2 px-1 pr-6">
                    <p className="text-[13px] font-medium truncate group-hover:text-[#E8B44C] transition-colors">{p.name}</p>
                    <p className="font-mono text-[11px] text-[#8A8A93]">{formatDurationSafe(p.timeline, p.panels?.length)}</p>
                  </div>
                  <button onClick={(e) => handleDelete(e, p.id)} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-[#0B0B0C]/80 text-[#8A8A93] opacity-0 group-hover:opacity-100 hover:bg-[#F87171] hover:text-white flex items-center justify-center transition-all">×</button>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="pt-12 pb-6 border-t border-[#16161A] flex items-center justify-between text-[11px] font-mono text-[#8A8A93]/50">
          <span>Self-hosted · BYOK · OPFS · WebCodecs</span>
          <span className="flex gap-3">
            <Link href="/settings" className="hover:text-[#8A8A93]">Провайдеры</Link>
            <span>Space play · ⌘E export</span>
          </span>
        </div>
      </div>
    </div>
  );
}
