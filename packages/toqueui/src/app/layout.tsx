import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { AppShell } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Toque — Nusuk Platform Dashboard",
  description: "Manage auth tokens, audit logs, settings, and scheduled visa sends",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
