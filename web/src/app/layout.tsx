import type { Metadata } from "next";
import "./globals.css";

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
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
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
