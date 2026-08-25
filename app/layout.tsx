import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Curator",
  description: "AI curator for student research projects",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
