'use client';

import { motion } from 'framer-motion';
import { FileUp, Loader2, MapPinned } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { cn } from '@/lib/utils';
import { putProject, saveLocal } from '@/services/db';
import { analyzeMapImage, fileToDataUrl } from '@/services/map-analysis';
import { readShareFile } from '@/services/share';
import { useProjectStore } from '@/stores/project-store';

/** Landing-page entry point: drop a map, get a world. */
export function UploadZone() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const handleFiles = async (files: File[]) => {
    const file = files[0];
    if (!file || busy) return;
    const store = useProjectStore.getState();
    try {
      if (file.name.toLowerCase().endsWith('.atlas3d')) {
        setBusy('Importing project…');
        const record = await readShareFile(file);
        await putProject(record);
        saveLocal('current-project', record.id);
        router.push('/studio');
        return;
      }
      setBusy('Analyzing map…');
      const dataUrl = await fileToDataUrl(file);
      const analysis = await analyzeMapImage(dataUrl, file.name, setBusy);
      const name =
        analysis.location ?? (file.name.replace(/\.[^.]+$/, '') || 'Imported map');
      const id = store.newProject(name, { map: { enabled: true, analysis } }, dataUrl);
      const record = store.toRecord(null);
      if (record) await putProject(record);
      saveLocal('current-project', id);
      setBusy('Building world…');
      router.push('/studio');
    } catch {
      setBusy(null);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'image/*': [], 'application/json': ['.atlas3d'] },
    multiple: false,
    onDrop: (files) => void handleFiles(files),
  });

  return (
    <motion.div
      {...getRootProps({
        className: cn(
          'group relative cursor-pointer overflow-hidden rounded-lg border border-dashed transition-colors duration-200',
          isDragActive
            ? 'border-accent bg-accent/[0.07]'
            : 'border-line-strong bg-surface/60 hover:border-ink-faint',
        ),
      })}
      whileTap={{ scale: 0.995 }}
    >
      <input {...getInputProps()} aria-label="Upload a map" />
      <div className="flex items-center gap-4 px-5 py-4">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors',
            isDragActive
              ? 'border-accent/40 bg-accent/15 text-accent'
              : 'border-line bg-raised text-ink-faint group-hover:text-accent',
          )}
        >
          {busy ? (
            <Loader2 size={17} className="animate-spin" />
          ) : isDragActive ? (
            <MapPinned size={17} />
          ) : (
            <FileUp size={17} />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">
            {busy ?? (isDragActive ? 'Release to import' : 'Drop a map to begin')}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            Satellite image, floor plan, blueprint, hand-drawn map — or an .atlas3d project
          </div>
        </div>
      </div>
    </motion.div>
  );
}
