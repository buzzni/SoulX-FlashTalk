/**
 * AudioPlayer — custom player for generated TTS previews.
 *
 * Why custom: the browser-native `<audio controls>` doesn't theme
 * cleanly across OSes (especially the macOS/Safari filled style
 * that ignores CSS vars), and it stretches past the tight wizard
 * column width. The inline-sidebar layout here matches the rest of
 * the studio UI — play toggle, scrub bar, current/total time,
 * volume thumb — and drags on the scrub bar use window-level
 * listeners so users can drag past the bar boundary without
 * losing the thumb.
 *
 * Extracted from Step3Audio.jsx in Phase 4c. Originally lived
 * inline as a 130-line inner component; lives in `shared/` now
 * because the Result page may reuse it in Phase 4e.
 */

import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon.jsx';

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export interface AudioPlayerProps {
  src: string;
}

export function AudioPlayer({ src }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    el.pause();
    // Browsers lazy-load metadata; bumping load() forces header
    // parse so duration shows up immediately after a new
    // generation finishes.
    el.load();
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = volume;
  }, [volume]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else el.play().catch(() => setPlaying(false));
  };

  const seekFromEvent = (clientX: number) => {
    const el = audioRef.current;
    const bar = barRef.current;
    if (!el || !bar || !Number.isFinite(duration) || duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const next = pct * duration;
    el.currentTime = next;
    setCurrent(next);
  };

  const onBarMouseDown = (e: React.MouseEvent) => {
    setScrubbing(true);
    seekFromEvent(e.clientX);
  };

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => seekFromEvent(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, duration]);

  const pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

  return (
    <div className="mt-2.5 flex items-center gap-2.5 px-2.5 py-2 bg-card border border-border rounded">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? '일시정지' : '재생'}
        className="w-[30px] h-[30px] shrink-0 border-0 rounded-full bg-primary text-white cursor-pointer grid place-items-center transition-[background-color,filter] duration-150 hover:bg-primary-hover hover:brightness-105"
      >
        <Icon name={playing ? 'pause' : 'play'} size={12} />
      </button>
      <div
        ref={barRef}
        onMouseDown={onBarMouseDown}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
        className="relative flex-1 min-w-0 h-3.5 cursor-pointer flex items-center"
      >
        {/* Track */}
        <div className="absolute inset-x-0 h-1 rounded-sm bg-secondary pointer-events-none" />
        {/* Fill */}
        <div
          className="relative h-1 rounded-sm bg-primary pointer-events-none"
          style={{ width: `${pct}%` }}
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-primary -translate-x-1/2 -translate-y-1/2 pointer-events-none shadow-[0_1px_3px_oklch(0_0_0_/_0.2)]"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground min-w-[82px] text-right">
        {fmtTime(current)} / {fmtTime(duration)}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 text-muted-foreground">
        <Icon name="sound" size={12} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          aria-label="음량"
          className="w-[72px] [accent-color:var(--primary)]"
        />
      </div>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={(e) => setDuration((e.target as HTMLAudioElement).duration)}
        onDurationChange={(e) => setDuration((e.target as HTMLAudioElement).duration)}
        className="hidden"
      />
    </div>
  );
}
