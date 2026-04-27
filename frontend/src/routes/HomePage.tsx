/**
 * / — HostStudio 홈.
 *
 * Greeting + 2 quickstart cards (다크 anchor + 라이트 secondary) + 통계
 * (sparkline 포함) + 최근 작업 그리드 + 활동 피드. 사이드바는 AppLayout.
 *
 * Title 추출은 lib/format.videoTitle, 로딩은 Spinner, 빈 상태는
 * EmptyState로 통일.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Film, Play } from 'lucide-react';
import { AppLayout } from './AppLayout';
import { fetchJSON } from '../api/http';
import { schemas } from '../api/schemas-generated';
import { getUser, subscribe } from '../stores/authStore';
import { Spinner } from '../components/spinner';
import { EmptyState } from '../components/empty-state';
import { Sparkline } from '../components/sparkline';
import {
  formatDuration,
  formatRelativeDateTime,
  videoTitle,
} from '../lib/format';
import { startNewVideo } from '../lib/wizardNav';
import { cn } from '@/lib/utils';
import { DraftBanner } from '../components/draft-banner';

interface HistoryItem {
  task_id: string;
  timestamp?: string;
  script_text?: string;
  host_image?: string;
  output_path?: string;
  video_url?: string;
  generation_time?: number;
}

interface HistoryResponse {
  total: number;
  videos: HistoryItem[];
}

export function HomePage() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const display = user?.display_name || user?.user_id || '';
  const clock = useClock();

  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON('/api/history?limit=8', {
      signal: ctl.signal,
      label: '최근 작업',
      schema: schemas.HistoryResponse,
    })
      .then((r) => {
        setHistory((r.videos ?? []) as HistoryItem[]);
        setHistoryTotal(r.total);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, []);

  // Stats
  const weekItems = useMemo(() => {
    if (!history) return [];
    const cutoff = Date.now() - 7 * 86400_000;
    return history.filter((h) => {
      if (!h.timestamp) return false;
      const t = new Date(h.timestamp).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }, [history]);

  const weekCount = weekItems.length;

  // Sparkline data — bucket items per day for the last 7 days
  const weekTrend = useMemo(() => {
    const buckets = new Array(7).fill(0);
    if (!history) return buckets;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    history.forEach((h) => {
      if (!h.timestamp) return;
      const t = new Date(h.timestamp);
      t.setHours(0, 0, 0, 0);
      const days = Math.round((today.getTime() - t.getTime()) / 86400_000);
      if (days >= 0 && days < 7) buckets[6 - days] += 1;
    });
    return buckets;
  }, [history]);

  const activeDays = useMemo(
    () => weekTrend.filter((c) => c > 0).length,
    [weekTrend],
  );

  return (
    <AppLayout active="home">
      <div className="px-6 md:px-12 pt-12 md:pt-16 pb-16 max-w-[960px] animate-rise">
        {/* Greeting */}
        <div className="mb-9">
          <div className="text-[13px] text-muted-foreground mb-2 inline-flex items-center gap-2">
            <span className="signal-dot" aria-hidden />
            지금 {clock} · 모든 작업 저장됨
          </div>
          <h1 className="headline-hero m-0">
            {display ? `${display} 님,` : '안녕하세요,'}
            <br />
            오늘은 어떤 영상 만들어볼까요?
          </h1>
          <p className="m-0 mt-2 text-[15px] text-ink-2">
            호스트와 제품을 정하면 3단계로 영상이 완성돼요.
          </p>
        </div>

        <DraftBanner />

        {/* Quickstart cards */}
        <div className="grid grid-cols-1 md:grid-cols-[1.3fr_1fr] gap-3.5 mb-8">
          <button
            type="button"
            onClick={() => startNewVideo(navigate)}
            className="group surface-card-dark text-left p-6 cursor-pointer transition-all hover:translate-y-[-1px] hover:shadow-[var(--shadow-2)]"
          >
            <span className="inline-block px-2.5 py-1 rounded-full bg-white/15 text-[#b9d3ff] text-[11px] font-semibold mb-4">
              3단계 위저드
            </span>
            <h3 className="headline-card m-0">새 영상 만들기</h3>
            <p className="m-0 mt-1.5 mb-4 text-[13.5px] text-white/75 leading-[1.55]">
              마음에 드는 호스트를 만들고 — 제품·배경을 합성하고 — 목소리·대본까지 한 자리에서.
            </p>
            <div className="flex items-center justify-end mt-auto">
              <span className="grid place-items-center w-8 h-8 rounded-full bg-primary text-primary-foreground transition-colors group-hover:bg-[var(--primary-hover)]">
                <ArrowRight className="size-4" />
              </span>
            </div>
          </button>

          <Link
            to="/results"
            className="group surface-card text-left p-6 no-underline text-foreground cursor-pointer transition-all hover:translate-y-[-1px] hover:shadow-[var(--shadow-1)] hover:border-rule-strong flex flex-col"
          >
            <span className="self-start px-2.5 py-1 rounded-full bg-secondary text-ink-2 text-[11px] font-semibold mb-4">
              라이브러리
            </span>
            <h3 className="headline-card m-0">내 영상들</h3>
            <p className="m-0 mt-1.5 mb-4 text-[13.5px] text-muted-foreground leading-[1.55]">
              지금까지 만든 결과를 보고 플레이리스트로 정리하세요.
            </p>
            <div className="flex items-center justify-end mt-auto">
              <span className="grid place-items-center w-8 h-8 rounded-full bg-secondary text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                <ArrowRight className="size-4" />
              </span>
            </div>
          </Link>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-9">
          <Stat
            label="이번 주 만든 영상"
            value={`${weekCount}`}
            unit="개"
            trend={weekCount > 0 ? `최근 7일` : '— 첫 영상이 기다려요'}
            trendOk={weekCount > 0}
            sparkData={weekTrend}
            sparkKind="bars"
          />
          <Stat
            label="활동한 날"
            value={`${activeDays}`}
            unit="/ 7일"
            trend={activeDays > 0 ? '최근 7일 중' : '아직 활동 없음'}
            trendOk={activeDays > 0}
            sparkData={weekTrend}
            sparkKind="bars"
          />
          <Stat
            label="총 영상"
            value={historyTotal !== null ? `${historyTotal}` : '—'}
            unit={historyTotal !== null ? '개' : ''}
            trend={historyTotal && historyTotal > 0 ? '저장 완료' : '— 새 영상이 처음이에요'}
            trendOk={Boolean(historyTotal)}
            icon={<Film className="size-3.5 text-muted-foreground" />}
          />
        </div>

        {/* Recent works */}
        {history === null && (
          <div className="surface-card p-8 flex justify-center">
            <Spinner size="md" label="최근 작업 불러오는 중" />
          </div>
        )}

        {history && history.length > 0 && (
          <section className="mb-10">
            <div className="flex items-baseline justify-between mb-3.5">
              <h2 className="headline-section m-0">최근 작업</h2>
              <Link
                to="/results"
                className="text-primary text-[13px] font-semibold no-underline hover:underline"
              >
                전체 보기 →
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {history.slice(0, 4).map((it) => (
                <RecentRow key={it.task_id} item={it} />
              ))}
            </div>
          </section>
        )}

        {history && history.length === 0 && (
          <div className="surface-card">
            <EmptyState
              kind="no-videos"
              title="아직 만든 영상이 없어요"
              description="첫 영상을 만들어 라이브러리를 채워보세요."
              action={
                <button
                  type="button"
                  onClick={() => startNewVideo(navigate)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-md text-[13px] font-semibold hover:bg-[var(--primary-hover)] transition-colors cursor-pointer"
                >
                  지금 만들기 <ArrowRight className="size-3.5" />
                </button>
              }
            />
          </div>
        )}
      </div>
    </AppLayout>
  );
}

interface StatProps {
  label: string;
  value: string;
  unit?: string;
  trend?: string;
  trendOk?: boolean;
  sparkData?: number[];
  sparkKind?: 'line' | 'bars' | 'area';
  icon?: React.ReactNode;
}

function Stat({ label, value, unit, trend, trendOk, sparkData, sparkKind, icon }: StatProps) {
  return (
    <div className="surface-card p-4 px-5">
      <div className="text-[12px] text-muted-foreground mb-1.5 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className="font-bold tracking-[-0.024em] tabular-nums leading-none">
        <span className="text-[26px]">{value}</span>
        {unit && <span className="text-[14px] text-ink-2 font-medium ml-1">{unit}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        {trend && (
          <div className={cn('text-[11px] font-semibold', trendOk ? 'text-success-on-soft' : 'text-muted-foreground')}>
            {trend}
          </div>
        )}
        {sparkData && sparkData.length > 1 && (
          <div className={trendOk ? 'text-primary' : 'text-muted-foreground'}>
            <Sparkline data={sparkData} kind={sparkKind ?? 'line'} width={64} height={20} highlightLast />
          </div>
        )}
      </div>
    </div>
  );
}

function RecentRow({ item }: { item: HistoryItem }) {
  const videoUrl = item.video_url || `/api/videos/${item.task_id}`;
  const title = videoTitle(item);
  const ts = formatRelativeDateTime(item.timestamp);
  const [playSec, setPlaySec] = useState<number | null>(null);
  const dur = formatDuration(playSec);

  return (
    <Link
      to={`/result/${item.task_id}`}
      className="group surface-card p-3.5 grid grid-cols-[80px_1fr] gap-3.5 no-underline text-foreground transition-colors hover:border-rule-strong relative"
    >
      <div className="relative w-20 h-[60px] rounded-md overflow-hidden bg-foreground">
        <video
          src={videoUrl}
          preload="metadata"
          muted
          className="block w-full h-full object-cover"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setPlaySec(d);
          }}
        />
        <span className="absolute inset-0 grid place-items-center bg-foreground/0 group-hover:bg-foreground/30 transition-colors">
          <Play className="size-4 text-background opacity-0 group-hover:opacity-100 transition-opacity" fill="currentColor" />
        </span>
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <div className="font-semibold text-[14px] tracking-[-0.014em] truncate" title={title}>
          {title}
        </div>
        <span className="pill-success self-start">완료</span>
        <div className="text-[11.5px] text-muted-foreground tabular-nums">
          {ts}{ts && dur !== '—' && ` · ${dur}`}
        </div>
      </div>
    </Link>
  );
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
