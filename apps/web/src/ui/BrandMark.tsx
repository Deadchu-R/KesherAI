import { useId } from "react";

/**
 * KesherAI's mark (assets/brand/mark.svg): two linked rings, lit where they meet. Drawn inline so it follows the
 * theme: the lighter rings on dark, deeper ones on light (the `--brand-*` colours in styles.css).
 *
 * @param props.size - Width and height in pixels.
 * @param props.className - Extra class for placement.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  // Gradient ids must be unique on the page (the mark can appear twice: the sidebar and the welcome screen).
  const id = useId().replace(/[^\w-]/g, "");
  const g = (n: string) => `${n}-${id}`;
  return (
    <svg width={size} height={size} viewBox="190 280 644 464" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={g("a")} gradientUnits="userSpaceOnUse" x1="218" y1="316" x2="610" y2="708">
          <stop offset="0" stopColor="var(--brand-a1)" />
          <stop offset="1" stopColor="var(--brand-a2)" />
        </linearGradient>
        <linearGradient id={g("b")} gradientUnits="userSpaceOnUse" x1="806" y1="316" x2="414" y2="708">
          <stop offset="0" stopColor="var(--brand-b1)" />
          <stop offset="1" stopColor="var(--brand-b2)" />
        </linearGradient>
        <linearGradient id={g("l")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--brand-l1)" />
          <stop offset="1" stopColor="var(--brand-l2)" />
        </linearGradient>
      </defs>
      <path d="M512 342.3 A196 196 0 0 1 512 681.7 A196 196 0 0 1 512 342.3Z" fill={`url(#${g("l")})`} />
      <circle cx="414" cy="512" r="196" fill="none" stroke={`url(#${g("a")})`} strokeWidth="72" />
      <circle cx="610" cy="512" r="196" fill="none" stroke={`url(#${g("b")})`} strokeWidth="72" />
    </svg>
  );
}
