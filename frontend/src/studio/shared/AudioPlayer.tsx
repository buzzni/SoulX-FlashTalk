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
    <div className="audio-player">
      <button
        type="button"
        className="audio-player__toggle"
        onClick={toggle}
        aria-label={playing ? '일시정지' : '재생'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={12} />
      </button>
      <div
        ref={barRef}
        className="audio-player__progress"
        onMouseDown={onBarMouseDown}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
      >
        <div className="audio-player__bar" style={{ width: `${pct}%` }} />
        <div className="audio-player__thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="audio-player__time">
        {fmtTime(current)} / {fmtTime(duration)}
      </div>
      <div className="audio-player__volume">
        <Icon name="sound" size={12} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          aria-label="음량"
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
