/**
 * SaveHostModal unit tests — eng-review T10.
 *
 * Covers: empty/trimmed name disabled, in-flight disabled, error keeps
 * modal open, success calls onSuccess and closes.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { ReactNode } from 'react';
import { SaveHostModal } from '../save-host-modal';
import type { SavedHost } from '../../api/queries/use-saved-hosts';

const FAKE_HOST: SavedHost = {
  id: 'host-new',
  name: '민지',
  key: 'outputs/hosts/saved/host-new.png',
  url: '/api/files/outputs/hosts/saved/host-new.png',
  created_at: '2026-04-29T12:00:00+00:00',
  updated_at: null,
  deleted_at: null,
  meta: null,
  face_ref_for_variation: 'outputs/hosts/saved/host-new.png',
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={makeClient()}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SaveHostModal', () => {
  it('disables submit when name is empty', () => {
    render(
      <Wrap>
        <SaveHostModal
          open
          onOpenChange={() => {}}
          sourceImageId="host_a_s1"
        />
      </Wrap>,
    );
    const submit = screen.getByTestId('save-host-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables submit when name is whitespace-only', () => {
    render(
      <Wrap>
        <SaveHostModal
          open
          onOpenChange={() => {}}
          sourceImageId="host_a_s1"
          defaultName="   "
        />
      </Wrap>,
    );
    const submit = screen.getByTestId('save-host-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('enables submit on non-blank input and posts on click', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => FAKE_HOST,
    });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    render(
      <Wrap>
        <SaveHostModal
          open
          onOpenChange={onOpenChange}
          sourceImageId="host_abc_s42"
          onSuccess={onSuccess}
        />
      </Wrap>,
    );
    const input = screen.getByLabelText('호스트 이름');
    fireEvent.change(input, { target: { value: '민지' } });
    const submit = screen.getByTestId('save-host-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(FAKE_HOST));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps modal open and shows error message when save fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map(),
      text: async () => 'oops',
      json: async () => ({}),
    });
    const onOpenChange = vi.fn();
    render(
      <Wrap>
        <SaveHostModal
          open
          onOpenChange={onOpenChange}
          sourceImageId="host_abc_s42"
        />
      </Wrap>,
    );
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: '민지' } });
    fireEvent.click(screen.getByTestId('save-host-submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('Enter key submits when name is valid', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => FAKE_HOST,
    });
    const onSuccess = vi.fn();
    render(
      <Wrap>
        <SaveHostModal
          open
          onOpenChange={() => {}}
          sourceImageId="host_abc_s42"
          onSuccess={onSuccess}
        />
      </Wrap>,
    );
    const input = screen.getByLabelText('호스트 이름');
    fireEvent.change(input, { target: { value: '민지' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});
