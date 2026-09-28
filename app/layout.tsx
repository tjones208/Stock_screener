import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TabBar } from "./tabbar";

export const metadata: Metadata = {
  title: "Wheel Screener",
  description: "Personal stock screener for the wheel strategy",
  appleWebApp: { capable: true, title: "Wheel", statusBarStyle: "black-translucent" },
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
