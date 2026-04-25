// Icons — inline SVG components, minimal strokes. Ported from prototype Icon.jsx.
const Icon = ({ name, size = 16, style = {} }) => {
  const paths = {
    sparkles: <><path d="M10 2l1.5 4.5L16 8l-4.5 1.5L10 14l-1.5-4.5L4 8l4.5-1.5z"/><path d="M4 14l.8 1.7L6.5 16.5l-1.7.8L4 19l-.8-1.7L1.5 16.5l1.7-.8z"/></>,
    image: <><rect x="2.5" y="2.5" width="15" height="15" rx="2"/><circle cx="7" cy="7" r="1.5"/><path d="M2.5 14l4-4 4 4 3-3 4 4"/></>,
    upload: <><path d="M10 3v10M5 8l5-5 5 5"/><path d="M3 14v2a2 2 0 002 2h10a2 2 0 002-2v-2"/></>,
    link: <><path d="M8 11a4 4 0 005.66 0l2-2a4 4 0 00-5.66-5.66l-1 1"/><path d="M12 9a4 4 0 00-5.66 0l-2 2a4 4 0 005.66 5.66l1-1"/></>,
    check: <path d="M3 10l4 4 10-10"/>,
    close: <path d="M4 4l12 12M16 4L4 16"/>,
    plus: <path d="M10 4v12M4 10h12"/>,
    play: <path d="M5 3l12 7-12 7z" fill="currentColor"/>,
    pause: <><rect x="4" y="3" width="4" height="14" fill="currentColor"/><rect x="12" y="3" width="4" height="14" fill="currentColor"/></>,
    mic: <><rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 10a6 6 0 0012 0M10 16v2"/></>,
    drag: <><circle cx="7" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="7" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="7" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="15" r="1.2" fill="currentColor" stroke="none"/></>,
    trash: <><path d="M3 5h14M8 5V3h4v2M5 5l1 13h8l1-13"/></>,
    arrow_right: <path d="M5 10h10M10 5l5 5-5 5"/>,
    arrow_left: <path d="M15 10H5M10 5l-5 5 5 5"/>,
    download: <><path d="M10 3v11M5 9l5 5 5-5"/><path d="M3 17h14"/></>,
    refresh: <><path d="M3 10a7 7 0 1 0 2-5"/><path d="M3 3v4h4"/></>,
    swap: <><path d="M4 7h11M12 4l3 3-3 3"/><path d="M16 13H5M8 16l-3-3 3-3"/></>,
    settings: <><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M4 10H2M18 10h-2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></>,
    wand: <><path d="M4 16L14 6M14 6l2-2M14 6l-2-2M4 16l-2 2M4 16l2 2"/><path d="M16 10l.5 1.5L18 12l-1.5.5L16 14l-.5-1.5L14 12l1.5-.5z"/></>,
    sound: <><path d="M3 8h3l4-3v10l-4-3H3z"/><path d="M13 7a4 4 0 010 6M15.5 4.5a7 7 0 010 11"/></>,
    copy: <><rect x="4" y="4" width="10" height="10" rx="1.5"/><path d="M8 4V2.5A1.5 1.5 0 019.5 1h6A1.5 1.5 0 0117 2.5v6A1.5 1.5 0 0115.5 10H14"/></>,
    file: <><path d="M11 2H5a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M11 2v6h6"/></>,
    info: <><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.5v.5" strokeLinecap="round"/></>,
    check_circle: <><circle cx="10" cy="10" r="7.5"/><path d="M6.5 10l2.5 2.5 4.5-5"/></>,
    alert_circle: <><circle cx="10" cy="10" r="7.5"/><path d="M10 6v5M10 13.5v.5"/></>,
    user: <><circle cx="10" cy="7" r="3.5"/><path d="M3.5 17a6.5 6.5 0 0113 0"/></>,
    shirt: <><path d="M7 2l-4 2v4h3v10h8V8h3V4l-4-2L10 4z"/></>,
    frame: <><rect x="2" y="2" width="16" height="16" rx="1.5"/><path d="M2 7h16M7 2v16"/></>,
    preview: <><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><circle cx="10" cy="10" r="2.5"/></>,
    video: <><rect x="2" y="4" width="11" height="12" rx="1.5"/><path d="M13 8l5-3v10l-5-3z"/></>,
    star: <path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L5.1 17.2 6 11.7 2 7.8l5.5-.8z"/>,
    trend: <path d="M3 14l5-5 3 3 6-6M12 6h5v5"/>,
    bg: <><rect x="2" y="2" width="16" height="16" rx="1.5"/><path d="M2 14l5-5 5 5 3-3 3 3"/><circle cx="14" cy="6" r="1.5"/></>,
    chevron_down: <path d="M5 8l5 5 5-5"/>,
    chevron_up: <path d="M15 12l-5-5-5 5"/>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={style}>
      {paths[name]}
    </svg>
  );
};

export default Icon;
