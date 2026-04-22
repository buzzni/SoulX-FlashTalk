/**
 * ServerFilePicker — modal that lists files already in the server's
 * uploads/ dir so users can bypass blocked browser uploads.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

// Mock the api helper so the picker doesn't try a real fetch.
vi.mock('../api.js', () => ({
  listServerFiles: vi.fn(),
}));

import { listServerFiles } from '../api.js';
import ServerFilePicker from '../ServerFilePicker.jsx';

const NOW = 1_700_000_000; // fixed reference for "recent" math
const recentFile = { filename: 'recent.png', path: '/u/recent.png', url: '/api/files/recent.png', size: 1234, modified: NOW - 60 };           // 1 min ago
const oldFile    = { filename: 'older.png',  path: '/u/older.png',  url: '/api/files/older.png',  size: 5678, modified: NOW - 7200 };         // 2 h ago
const hostFile   = { filename: 'host_q.png', path: '/u/host_q.png', url: '/api/files/host_q.png', size: 999,  modified: NOW - 30 };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  // Freeze Date.now so the "recent 1h" filter is deterministic.
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});

describe('ServerFilePicker', () => {
  it('returns null when open=false (no DOM rendered)', () => {
    const { container } = render(
      <ServerFilePicker open={false} onClose={() => {}} onSelect={() => {}} />
    );
    expect(container.firstChild).toBeNull();
    expect(listServerFiles).not.toHaveBeenCalled();
  });

  it('loads + renders thumbnails after the listServerFiles promise resolves', async () => {
    listServerFiles.mockResolvedValueOnce({ files: [recentFile, oldFile, hostFile] });
    render(<ServerFilePicker open={true} onClose={() => {}} onSelect={() => {}} kind="image" />);
    await waitFor(() => expect(screen.getByText('recent.png')).toBeTruthy());
    expect(screen.getByText('older.png')).toBeTruthy();
    expect(screen.getByText('host_q.png')).toBeTruthy();
    expect(listServerFiles).toHaveBeenCalledWith('image');
  });

  it('search input filters by filename substring', async () => {
    listServerFiles.mockResolvedValueOnce({ files: [recentFile, oldFile, hostFile] });
    render(<ServerFilePicker open={true} onClose={() => {}} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('recent.png')).toBeTruthy());

    const input = screen.getByPlaceholderText(/파일명 검색/);
    fireEvent.change(input, { target: { value: 'host' } });

    expect(screen.queryByText('recent.png')).toBeNull();
    expect(screen.queryByText('older.png')).toBeNull();
    expect(screen.getByText('host_q.png')).toBeTruthy();
    // Counter "1 / 3 개"
    expect(screen.getByText(/1 \/ 3 개/)).toBeTruthy();
  });

  it('"recent 1 hour" checkbox excludes files older than 3600s', async () => {
    listServerFiles.mockResolvedValueOnce({ files: [recentFile, oldFile, hostFile] });
    render(<ServerFilePicker open={true} onClose={() => {}} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('recent.png')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/최근 1시간만/));

    expect(screen.queryByText('older.png')).toBeNull();   // > 1h ago, hidden
    expect(screen.getByText('recent.png')).toBeTruthy();  // 1 min ago, kept
    expect(screen.getByText('host_q.png')).toBeTruthy();  // 30 s ago, kept
  });

  it('clicking a thumbnail calls onSelect(file) and onClose() once each', async () => {
    listServerFiles.mockResolvedValueOnce({ files: [recentFile] });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ServerFilePicker open={true} onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('recent.png')).toBeTruthy());

    // Click the tile (the button wrapping the thumbnail)
    fireEvent.click(screen.getByText('recent.png').closest('button'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(recentFile);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
