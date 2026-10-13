/** Marca do RupBar (taça âmbar sobre vidro escuro), desenhada em SVG. */
export function BrandMark({ size = 40, id = 'bm', className }: { size?: number; id?: string; className?: string }) {
  return (
    <svg className={`brand-mark ${className ?? ''}`} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b2f45" />
          <stop offset="1" stopColor="#07080f" />
        </linearGradient>
        <linearGradient id={`${id}-drink`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc861" />
          <stop offset="1" stopColor="#ff8a00" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0.5" cy="0.38" r="0.6">
          <stop offset="0" stopColor="#ffb340" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ffb340" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill={`url(#${id}-bg)`} />
      <rect width="512" height="512" rx="120" fill={`url(#${id}-glow)`} />
      <rect x="6" y="6" width="500" height="500" rx="114" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="12" />
      <path d="M160 128h192l-28 176a68 68 0 0 1-67 56h-2a68 68 0 0 1-67-56z" fill={`url(#${id}-drink)`} />
      <path d="M256 360v56m-56 0h112" stroke="#f5f5f7" strokeWidth="22" strokeLinecap="round" />
      <path d="M178 176h156" stroke="#fff" strokeOpacity=".6" strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}
