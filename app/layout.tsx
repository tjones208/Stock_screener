import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TabBar } from "./tabbar";

export const metadata: Metadata = {
  title: "Stock Screener",
  description: "Personal stock screener and momentum strategy",
  appleWebApp: { capable: true, title: "Screener", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <TabBar />
      </body>
    </html>
  );
}
