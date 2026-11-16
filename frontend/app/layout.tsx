import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ChessDNA — Find out why you lose",
  description:
    "A personal chess weakness diagnostic. Enter your Chess.com or Lichess username and get a deep breakdown of the tactical blind spots leaking your rating points.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${jakarta.variable} ${inter.variable} ${jetbrains.variable} min-h-screen bg-[#0a0a0b] font-sans text-zinc-100 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
