import { Slider as ShadSlider } from '@/components/ui/slider';

/**
 * WizardSlider — single-number slider with optional formatted readout
 * to the right. shadcn's Slider is array-based (supports range); this
 * wrapper coerces to a single number so wizard form rows stay terse.
 */
export interface WizardSliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  disabled?: boolean;
}

export function WizardSlider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  formatValue,
  ariaLabel,
  disabled = false,
}: WizardSliderProps) {
  return (
    <div className="flex items-center gap-3">
      <ShadSlider
        value={[value]}
        onValueChange={(v) => onChange(Number(Number(v[0]).toFixed(3)))}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        className="flex-1"
        disabled={disabled}
      />
      <span className="text-[12px] text-muted-foreground min-w-[40px] text-right tabular-nums">
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  );
}
