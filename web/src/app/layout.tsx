import type { Metadata } from "next";
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenRepurpose: Molecular Triage Studio for Neglected Tropical Diseases",
  description:
    "Reproducible in-silico drug repurposing workbench combining 5-model cross-family affinity prediction, 32-protein target selectivity normalization (Delta-pKd), RDKit medicinal chemistry gates, and live NCBI PubMed verification.",
};

const themeInitScript = `
(function() {
  try {
    var saved = localStorage.getItem('openrepurpose_theme');
    var theme = (saved === 'dark' || saved === 'paper') ? saved : 'paper';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'paper');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="paper"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <a
          href="#main-stage"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-3.5 focus:py-2 focus:bg-[var(--accent)] focus:text-[var(--accent-on-solid)] focus:rounded-md focus:text-xs focus:font-semibold"
        >
          Skip to main workspace
        </a>
        {children}
      </body>
    </html>
  );
}
