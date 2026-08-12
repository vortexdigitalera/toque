"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "▦" },
  { href: "/entities", label: "Entities", icon: "◈" },
  { href: "/audit", label: "Audit Logs", icon: "≡" },
  { href: "/settings", label: "Settings", icon: "⚙" },
  { href: "/users", label: "Team", icon: "👥" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

  return (
    <>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-header">
          <div className="logo">T</div>
          <h1>Toque</h1>
          <span className="badge">Nusuk</span>
        </div>
        <nav className="sidebar-nav">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className={`nav-item ${pathname === item.href ? "active" : ""}`}
                  onClick={close}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-footer">
          v1.0.0 · Cloudflare Mesh
        </div>
      </aside>
      {open && <div className="sidebar-overlay" onClick={close} />}
    </>
  );
}

export function Topbar() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return (
    <div className="topbar">
      <button
        className="menu-btn"
        onClick={() => {
          setSidebarOpen(!sidebarOpen);
          document.querySelector(".sidebar")?.classList.toggle("open");
        }}
        aria-label="Toggle menu"
      >
        ☰
      </button>
      <span style={{ fontWeight: 600, fontSize: 15 }}>Toque Dashboard</span>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="content">
        <Topbar />
        <div className="content-body">{children}</div>
      </div>
    </div>
  );
}
