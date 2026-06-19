import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thread Lead Automation dashboard",
  description: "Thread Lead Automation dashboard",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-n8n-bg text-white" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
