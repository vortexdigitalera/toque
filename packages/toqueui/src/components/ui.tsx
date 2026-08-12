import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function StatCard({
  icon,
  value,
  label,
  color = "accent",
}: {
  icon: string;
  value: ReactNode;
  label: string;
  color?: "accent" | "green" | "red" | "yellow" | "blue";
}) {
  const colorMap: Record<string, string> = {
    accent: "var(--accent-dim)",
    green: "var(--green-dim)",
    red: "var(--red-dim)",
    yellow: "var(--yellow-dim)",
    blue: "var(--blue-dim)",
  };
  const iconColorMap: Record<string, string> = {
    accent: "var(--accent)",
    green: "var(--green)",
    red: "var(--red)",
    yellow: "var(--yellow)",
    blue: "var(--blue)",
  };
  return (
    <div className="stat-card">
      <div className="stat-icon" style={{ background: colorMap[color], color: iconColorMap[color] }}>
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Tag({
  children,
  variant = "neutral",
}: {
  children: ReactNode;
  variant?: "green" | "red" | "yellow" | "blue" | "accent" | "neutral";
}) {
  return <span className={`tag tag-${variant}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const cls = `btn ${variant !== "primary" ? `btn-${variant}` : ""} ${size === "sm" ? "btn-sm" : ""}`;
  return (
    <button className={cls} onClick={onClick} disabled={disabled} type={type}>
      {children}
    </button>
  );
}

export function Input({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label?: string;
  type?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  return (
    <div className="form-group">
      {label && <label className="form-label">{label}</label>}
      <input
        className="form-input"
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

export function Select({
  label,
  value,
  onChange,
  children,
}: {
  label?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="form-group">
      {label && <label className="form-label">{label}</label>}
      <select className="form-select" value={value} onChange={onChange}>
        {children}
      </select>
    </div>
  );
}

export function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="loading-state">
      <div className="spinner" />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="error-state">
      <span style={{ fontSize: 32 }}>⚠</span>
      <span>{message}</span>
    </div>
  );
}

export function EmptyState({ icon = "∅", message }: { icon?: string; message: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <span>{message}</span>
    </div>
  );
}

export function Toast({ message, variant = "info" }: { message: string; variant?: "success" | "error" | "info" }) {
  return <div className={`toast toast-${variant}`}>{message}</div>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
