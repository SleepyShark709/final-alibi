import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "疑案档案 · CASE//FILE",
  description: "一款由多 Agent 驱动的中文探案游戏",
};

export const viewport: Viewport = {
  themeColor: "#151715",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
