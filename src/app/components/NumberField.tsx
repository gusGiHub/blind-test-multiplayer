interface NumberFieldProps {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    hint?: string;
    disabled?: boolean;
    onChange: (value: number) => void;
}

/** Native number input preserves keyboard controls and browser validation. */
export default function NumberField({ id, label, value, min, max, hint, disabled = false, onChange }: NumberFieldProps) {
    const changeBy = (amount: number) => {
        if (!disabled) onChange(Math.min(max, Math.max(min, Number.isFinite(value) ? value + amount : min)));
    };
    return <div className="field">
        <label id={`${id}-label`} htmlFor={id}>{label}<span className="sr-only"> (secondes)</span></label>
        <div className="number-control" role="group" aria-labelledby={`${id}-label`}>
            <button className="number-control-step" type="button" aria-label={`Diminuer : ${label}`} disabled={disabled || value <= min} onClick={() => changeBy(-1)}>−</button>
            <div className="number-control-value">
                <input id={id} name={id} type="number" inputMode="numeric" min={min} max={max} step={1} required disabled={disabled} value={Number.isNaN(value) ? "" : value} onChange={event => { if (!disabled) onChange(event.target.valueAsNumber); }} aria-describedby={hint ? `${id}-hint` : undefined} />
                <span className="number-control-unit" aria-hidden="true">s</span>
            </div>
            <button className="number-control-step" type="button" aria-label={`Augmenter : ${label}`} disabled={disabled || value >= max} onClick={() => changeBy(1)}>+</button>
        </div>
        {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>;
}
