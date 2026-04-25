/**
 * / — minimal home with two big actions: make a new video, or browse
 * past results. Future: hero / landing copy on top of the same shell.
 */
import { useNavigate } from 'react-router-dom';
import { useSyncExternalStore } from 'react';
import { AppHeader } from './AppHeader';
import { getUser, subscribe } from '../stores/authStore';

export function HomePage() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const greeting = user?.display_name || user?.user_id || '';

  return (
    <div style={pageStyle}>
      <AppHeader />
      <main style={mainStyle}>
        <div style={cardStyle}>
          {greeting && <p style={greetStyle}>안녕하세요, {greeting} 님</p>}
          <h1 style={titleStyle}>무엇을 할까요?</h1>
          <div style={buttonsStyle}>
            <button
              type="button"
              onClick={() => navigate('/step/1')}
              style={primaryBtnStyle}
            >
              <div style={btnIconStyle}>+</div>
              <div>
                <div style={btnTitleStyle}>영상 만들기</div>
                <div style={btnSubStyle}>호스트부터 영상까지 3단계</div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => navigate('/results')}
              style={secondaryBtnStyle}
            >
              <div style={btnIconStyle}>📁</div>
              <div>
                <div style={btnTitleStyle}>내 영상들</div>
                <div style={btnSubStyle}>지금까지 만든 결과 보기</div>
              </div>
            </button>
          </div>
        </div>
      </main>
    </div>
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
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
};

const cardStyle: React.CSSProperties = {
  width: 720,
  maxWidth: '100%',
  background: '#fff',
  borderRadius: 16,
  padding: 48,
  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
  textAlign: 'center',
};

const greetStyle: React.CSSProperties = { margin: 0, fontSize: 14, color: '#666' };
const titleStyle: React.CSSProperties = { margin: '8px 0 32px', fontSize: 28, fontWeight: 700 };

const buttonsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 16,
};

const baseBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '24px 28px',
  borderRadius: 12,
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  transition: 'transform .08s, box-shadow .08s',
};

const primaryBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: '#3553ff',
  color: '#fff',
  boxShadow: '0 4px 16px rgba(53,83,255,0.3)',
};

const secondaryBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: '#f0f0f5',
  color: '#222',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
};

const btnIconStyle: React.CSSProperties = { fontSize: 32, lineHeight: 1 };
const btnTitleStyle: React.CSSProperties = { fontSize: 18, fontWeight: 700, marginBottom: 4 };
const btnSubStyle: React.CSSProperties = { fontSize: 13, opacity: 0.85 };
