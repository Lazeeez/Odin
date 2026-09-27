/** A segmented control: one choice among a few, keyboard- and screen-reader-friendly. */
export function Seg<T extends string>({ value, options, onChange, label, small = false }: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div class={`seg${small ? " small" : ""}`} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" class={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}
