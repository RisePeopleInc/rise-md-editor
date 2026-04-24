interface WelcomeScreenProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
}

export function WelcomeScreen({ onOpenFile, onOpenFolder }: WelcomeScreenProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-950">
      <div className="flex flex-col items-center gap-6 px-8 text-center">
        <h1 className="text-6xl font-semibold tracking-tight text-slate-50">rAIse</h1>
        <p className="text-base text-slate-400">Open a file or folder to get started</p>
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={onOpenFile}
            className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Open File
          </button>
          <button
            type="button"
            onClick={onOpenFolder}
            className="rounded-md border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 shadow-sm transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Open Folder
          </button>
        </div>
      </div>
    </div>
  );
}
