// Canonical task title format used everywhere a task is named in the UI
// (RenderDashboard progress card, ResultPage, QueueStatus modal, RenderHistory).
// Matches the original "내 쇼호스트 영상 #ABCD" style from RenderDashboard so
// the same task reads identically across every surface — no "#abc12345" in one
// place, "#ABCD" in another, "쇼호스트 영상" vs "내 쇼호스트 영상" drift.

const TYPE_NAMES = {
  generate: '내 쇼호스트 영상',
  conversation: '내 멀티 대화',
};

// Last 4 chars, uppercase. Matches `taskId.slice(-4).toUpperCase()` used in
// RenderDashboard.jsx:432 and ResultPage.jsx:223.
export function shortTaskId(taskId) {
  return taskId ? String(taskId).slice(-4).toUpperCase() : '';
}

export function typeTitle(type) {
  return TYPE_NAMES[type] || '내 작업';
}

export function formatTaskTitle(taskId, type) {
  const id = shortTaskId(taskId);
  const name = typeTitle(type);
  return id ? `${name} #${id}` : name;
}
