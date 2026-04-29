/**
 * SaveHostModal — name input modal that fires `useSaveHostMutation`.
 *
 * Eng-review T10. Sits on the WizardModal+ConfirmModal stack so focus
 * trap, scroll lock, and keyboard handling come from Radix.
 *
 *   trim → server validates length 1..100. Frontend re-checks the
 *   trimmed value to decide button-disabled state (no point letting
 *   the user click submit on a blank-after-trim input).
 *
 * On success: toast confirms + invokes `onSuccess(host)` so the parent
 * can dismiss the wizard or navigate. On error: keeps the modal open
 * so the user can retry; humanized error message inline.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { WizardModal } from './wizard-modal';
import { WizardButton as Button } from './wizard-button';
import {
  useSaveHostMutation,
  type SavedHost,
} from '../api/queries/use-saved-hosts';
import { humanizeError } from '../api/http';

const MAX_NAME_LEN = 100;

export interface SaveHostModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** image_id of the studio_hosts candidate row to promote. */
  sourceImageId: string;
  /** Optional initial name (e.g. auto-generated suggestion). */
  defaultName?: string;
  /** Fires after a successful save with the persisted SavedHost. */
  onSuccess?: (host: SavedHost) => void;
}

export function SaveHostModal({
  open,
  onOpenChange,
  sourceImageId,
  defaultName = '',
  onSuccess,
}: SaveHostModalProps) {
  const [name, setName] = useState(defaultName);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const save = useSaveHostMutation();
  const trimmed = name.trim();
  const canSubmit = trimmed.length >= 1 && trimmed.length <= MAX_NAME_LEN && !save.isPending;

  function handleClose() {
    if (save.isPending) return; // don't dismiss mid-flight
    setName(defaultName);
    setErrorMsg(null);
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setErrorMsg(null);
    try {
      const host = await save.mutateAsync({
        source_image_id: sourceImageId,
        name: trimmed,
      });
      toast.success('저장됐어요. 다음 영상부터 [내 호스트]에서 바로 선택 가능합니다.');
      onSuccess?.(host);
      setName(defaultName);
      onOpenChange(false);
    } catch (err) {
      setErrorMsg(humanizeError(err));
    }
  }

  return (
    <WizardModal
      open={open}
      onClose={handleClose}
      title="내 호스트로 저장"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={save.isPending}
          >
            취소
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="save-host-submit"
          >
            {save.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                저장 중…
              </>
            ) : (
              '저장'
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label htmlFor="save-host-name" className="text-sm-tight font-medium tracking-tight">
          호스트 이름
        </label>
        <input
          id="save-host-name"
          name="save-host-name"
          autoFocus
          maxLength={MAX_NAME_LEN}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errorMsg) setErrorMsg(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="예: 정장 입은 민지"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm-tight text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          aria-invalid={errorMsg ? true : undefined}
          aria-describedby={errorMsg ? 'save-host-error' : undefined}
        />
        <p className="text-2xs text-muted-foreground tracking-tight">
          나중에 사이드바 [나의 쇼호스트]에서 이 이름으로 다시 찾을 수 있어요.
        </p>
        {errorMsg && (
          <p
            id="save-host-error"
            role="alert"
            className="text-2xs text-destructive tracking-tight"
          >
            {errorMsg}
          </p>
        )}
      </div>
    </WizardModal>
  );
}
