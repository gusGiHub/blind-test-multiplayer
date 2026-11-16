import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import CurrentGameLink from "./CurrentGameLink";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Blind Test — À vous de jouer",
  description: "Crée une salle, invite tes amis et prépare ton blind test musical.",
  icons: {
    icon: [
      { url: "/favicon.ico?v=2", type: "image/x-icon", sizes: "16x16 32x32 48x48 64x64" },
      { url: "/blind-test-logo.svg?v=2", type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: "/favicon.ico?v=2",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <a className="sr-only focus:not-sr-only" href="#main-content">Aller au contenu</a>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="Blind Test, accueil">
            <Image className="brand-mark" src="/blind-test-logo.svg" alt="" width={40} height={40} />
            Blind Test
          </Link>
          <nav className="header-actions" aria-label="Navigation principale">
            <CurrentGameLink />
            <Link href="/spotify" className="nav-button nav-button--spotify"><span aria-hidden="true">♫</span> Mes playlists Spotify <span aria-hidden="true">↗</span></Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
