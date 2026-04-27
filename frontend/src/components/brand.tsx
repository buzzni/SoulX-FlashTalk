/**
 * Brand — wordmark + vertical rule + "스튜디오" lockup.
 *
 * Used by AppLayout sidebar, login page, TopBar, ResultPage. The logo is
 * a wide PNG (I'M SELLER, ratio ~2.47:1), so the lockup scales by `size`
 * and the surrounding container should use a flex parent that allows
 * intrinsic width.
 *
 * `size`:
 *  - 'sm': sidebar (28px logo height)
 *  - 'md': topbar (24px)
 *  - 'lg': login page hero (36px)
 */
import { Link } from 'react-router-dom';

export interface BrandProps {
  size?: 'sm' | 'md' | 'lg';
  /** When set, renders as a Link to this path. Otherwise a plain span. */
  to?: string;
  className?: string;
  title?: string;
}

const SIZES = {
  sm: { logoH: 28, fontSize: 14, gap: 10, ruleH: 18 },
  md: { logoH: 24, fontSize: 13, gap: 10, ruleH: 16 },
  lg: { logoH: 40, fontSize: 18, gap: 14, ruleH: 24 },
} as const;

export function Brand({ size = 'md', to, className = '', title }: BrandProps) {
  const s = SIZES[size];
  const inner = (
    <>
      <img
        src="/imseller-logo.png"
        alt="아임셀러"
        style={{ height: s.logoH, width: 'auto' }}
        className="block"
      />
      <span
        aria-hidden
        className="block bg-border"
        style={{ width: 1, height: s.ruleH, marginLeft: s.gap, marginRight: s.gap }}
      />
      <span
        className="font-bold tracking-[-0.014em] leading-none text-foreground"
        style={{ fontSize: s.fontSize }}
      >
        스튜디오
      </span>
    </>
  );

  const cls = `inline-flex items-center no-underline text-foreground ${className}`;

  if (to) {
    return (
      <Link to={to} className={cls} title={title}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={cls} title={title}>
      {inner}
    </div>
  );
}
