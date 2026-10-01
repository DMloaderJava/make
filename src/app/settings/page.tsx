"use client";

import { ProviderList } from '@/components/settings/ProviderList';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="flex-1 bg-[#0B0B0C] min-h-0 overflow-y-auto">
      <div className="h-14 px-4 flex items-center border-b border-[#26262C] bg-[#0B0B0C]/80 backdrop-blur sticky top-0 z-10">
        <Link href="/" className="w-8 h-8 rounded-[6px] bg-[#16161A] border border-[#26262C] flex items-center justify-center hover:bg-[#1E1E23] transition-colors">
          <ArrowLeft className="w-4 h-4 text-[#F5F5F7]" />
        </Link>
        <span className="ml-3 text-[14px] font-medium text-[#F5F5F7]">Провайдеры и ключи</span>
      </div>
      <div className="p-4 md:p-6">
        <ProviderList />
      </div>
    </div>
  );
}
