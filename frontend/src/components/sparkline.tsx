import * as React from 'react';

/**
 * Sparkline — tiny inline trend chart (used in stats cards on home).
 *
 * SVG-only, no deps. Auto-scales to data range. Uses currentColor so the
 * stroke + fill inherit from parent text color (set color via Tailwind
 * `text-primary` etc).
 *
 * `kind`:
 *  - 'line': single stroked path (good for a trend over time)
 *  - 'bars': vertical bars (good for sparse / categorical data)
 *  - 'area': line with filled area under (good for cumulative trend)
 */
export interface SparklineProps {
  data: number[];
  kind?: 'line' | 'bars' | 'area';
  width?: number;
  height?: number;
  className?: string;
  /** Override stroke width (line/area only) */
  strokeWidth?: number;
  /** Show last point as a filled circle */
  highlightLast?: boolean;
}

export function Sparkline({
  data,
  kind = 'line',
  width = 64,
  height = 20,
  className,
  strokeWidth = 1.5,
  highlightLast = false,
}: SparklineProps) {
  if (!data.length) {
    return <span className={className} style={{ display: 'inline-block', width, height }} />;
  }
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 1);
  const range = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const yOf = (v: number) => height - ((v - min) / range) * height;

  if (kind === 'bars') {
    const barW = Math.max(1, width / data.length - 1);
    return (
      <svg width={width} height={height} className={className} style={{ display: 'inline-block' }} aria-hidden>
        {data.map((v, i) => {
          const h = Math.max(1, ((v - min) / range) * height);
          return (
            <rect
              key={i}
              x={i * (barW + 1)}
              y={height - h}
              width={barW}
              height={h}
              fill="currentColor"
              opacity="0.6"
              rx="0.5"
            />
          );
        })}
      </svg>
    );
  }

  const points = data.map((v, i) => `${i * stepX},${yOf(v)}`).join(' ');
  const lastIdx = data.length - 1;
  const lastX = lastIdx * stepX;
  // `lastIdx >= 0` is guaranteed by the `if (!data.length)` guard
  // above, but TS's noUncheckedIndexedAccess doesn't track that —
  // `?? 0` keeps the runtime semantics and silences the warning.
  const lastY = yOf(data[lastIdx] ?? 0);

  return (
    <svg width={width} height={height} className={className} style={{ display: 'inline-block' }} aria-hidden>
      {kind === 'area' && (
        <path
          d={`M0,${height} L${points.split(' ').join(' L ')} L${width},${height} Z`}
          fill="currentColor"
          opacity="0.12"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {highlightLast && (
        <circle cx={lastX} cy={lastY} r={2} fill="currentColor" />
      )}
    </svg>
  );
}
