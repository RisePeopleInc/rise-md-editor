interface WelcomeScreenProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
}

/**
 * Splash / no-file landing page. Rise-branded — Source Serif Pro for the
 * app title (with the Rise deep-blue brand color), Open Sans for body,
 * the canonical purple interaction color for the primary action button.
 *
 * The optional gradient panel at the top uses the Rise interaction-tint
 * (P100 in light, a deepened tint in dark) as a subtle hero accent that
 * fades into the primary surface.
 */
export function WelcomeScreen({ onOpenFile, onOpenFolder }: WelcomeScreenProps) {
  return (
    /* `relative` is load-bearing: without a positioned ancestor the
       absolute gradient div below leaks across the entire window — over
       the sidebar, the top chrome, everything. Containing it here keeps
       it inside the welcome surface only. */
    <div className="relative flex h-full w-full items-center justify-center bg-app">
      {/* Subtle hero gradient — fades from the brand-tint into the page
          background. Sits behind the content, no interaction. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-interaction-tint to-app"
      />
      <div className="relative flex flex-col items-center gap-6 px-8 text-center">
        <h1
          className="font-serif text-5xl font-bold tracking-tight text-brand"
          style={{ fontSize: '32px' }}
        >
          rAIse
        </h1>
        <p className="text-base text-body">Markdown editor for Rise People</p>
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={onOpenFile}
            className="rounded-lg bg-interaction px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-interaction-hover active:bg-interaction-active focus:outline-none focus-visible:ring-2 focus-visible:ring-interaction focus-visible:ring-offset-2 focus-visible:ring-offset-app"
          >
            Open File
          </button>
          <button
            type="button"
            onClick={onOpenFolder}
            className="rounded-lg border border-stroke bg-surface px-4 py-2 text-sm font-semibold text-strong shadow-sm transition hover:bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-interaction focus-visible:ring-offset-2 focus-visible:ring-offset-app"
          >
            Open Folder
          </button>
        </div>
      </div>
    </div>
  );
}
