/**
 * /results — grid of completed renders.
 *
 * Reads /api/history (PR5: backed by studio_results, scoped to the
 * authenticated user). Each card links to the existing /result/:taskId
 * single-result page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from './AppHeader';
import { fetchJSON, humanizeError } from '../api/http';

interface HistoryItem {
  task_id: string;
  timestamp?: string;
  script_text?: string;
  host_image?: string;
  audio_source?: string;
  output_path?: string;
  file_size?: number;
  video_url?: string;
  generation_time?: number;
}

interface HistoryResponse {
  total: number;
  videos: HistoryItem[];
}

export function ResultsListPage() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON<HistoryResponse>('/api/history?limit=200', {
      signal: ctl.signal,
      label: '내 영상 목록',
    })
      .then((r) => setItems(r.videos))
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setError(humanizeError(e));
      });
    return () => ctl.abort();
  }, []);

  return (
    <div style={pageStyle}>
      <AppHeader />
      <main style={mainStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>내 영상들</h1>
          {items !== null && (
            <span style={countStyle}>{items.length}개</span>
          )}
        </div>
        {error && <div style={errorStyle}>{error}</div>}
        {!error && items === null && <div style={loadingStyle}>불러오는 중…</div>}
        {!error && items !== null && items.length === 0 && (
          <div style={emptyStyle}>
            <p style={{ margin: 0, fontSize: 14, color: '#666' }}>
              아직 만든 영상이 없어요.
            </p>
            <Link to="/step/1" style={linkStyle}>
              첫 영상 만들러 가기 →
            </Link>
          </div>
        )}
        {!error && items !== null && items.length > 0 && (
          <div style={gridStyle}>
            {items.map((it) => (
              <ResultCard key={it.task_id} item={it} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ResultCard({ item }: { item: HistoryItem }) {
  // The /api/videos/<id> endpoint serves the file directly (public). It also
  // works fine as a poster source for <video>, but we use it as the src for
  // a muted preview that loads the first frame only via metadata preload.
  const videoUrl = item.video_url || `/api/videos/${item.task_id}`;
  const ts = item.timestamp ? new Date(item.timestamp).toLocaleString('ko-KR') : '';
  const dur = item.generation_time ? `${Math.round(item.generation_time)}s` : '';
  const blurb = item.script_text || item.host_image || item.task_id.slice(0, 8);

  return (
    <Link to={`/result/${item.task_id}`} style={cardStyle}>
      <div style={thumbWrapStyle}>
        <video
          src={videoUrl}
          preload="metadata"
          muted
          style={thumbStyle}
        />
      </div>
      <div style={cardBodyStyle}>
        <div style={cardTitleStyle} title={blurb}>{blurb}</div>
        <div style={cardMetaStyle}>
          {ts}
          {dur && ` · ${dur}`}
        </div>
      </div>
    </Link>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f7f7fa',
  display: 'flex',
  flexDirection: 'column',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  padding: '24px 32px',
  maxWidth: 1200,
  width: '100%',
  margin: '0 auto',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  marginBottom: 16,
};

const titleStyle: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: 14, color: '#666' };

const errorStyle: React.CSSProperties = {
  padding: 16,
  background: '#fff1f1',
  color: '#b00020',
  borderRadius: 8,
};

const loadingStyle: React.CSSProperties = {
  padding: 16,
  color: '#666',
};

const emptyStyle: React.CSSProperties = {
  padding: '48px 16px',
  textAlign: 'center',
  background: '#fff',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  alignItems: 'center',
};

const linkStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#3553ff',
  textDecoration: 'none',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 16,
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
  borderRadius: 10,
  overflow: 'hidden',
  textDecoration: 'none',
  color: 'inherit',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
};

const thumbWrapStyle: React.CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  background: '#000',
  overflow: 'hidden',
};

const thumbStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const cardBodyStyle: React.CSSProperties = { padding: 12 };

const cardTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 4,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const cardMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
};
