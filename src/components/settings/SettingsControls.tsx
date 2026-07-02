import { useState } from "react";

export function Group({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="group">
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group-box">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`row ${wide ? "wide" : ""}`}>
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      {children && <div className="row-ctl">{children}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="switch"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function KeyInput({
  value,
  placeholder,
  onChange,
  label,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="key-input">
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="ghost"
        title={show ? "Verbergen" : "Zeigen"}
        onClick={() => setShow(!show)}
      >
        {show ? "◡" : "◉"}
      </button>
    </span>
  );
}
