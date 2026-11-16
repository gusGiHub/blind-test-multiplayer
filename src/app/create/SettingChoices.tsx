type Choice<T> = { value: T; label: string; description?: string };

/** Native radios retain keyboard navigation and form semantics. */
export default function SettingChoices<T extends string | number>({ name, legend, value, options, onChange }: {
  name: string;
  legend: string;
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="setting-choices">
      <legend>{legend}</legend>
      <div className={`setting-options${options.length === 3 ? " setting-options--three" : ""}`}>
        {options.map(option => (
          <label className="setting-option" key={option.value}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span className="setting-option-content">
              <span className="setting-option-title">{option.label}</span>
              {option.description && <span className="setting-option-description">{option.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
