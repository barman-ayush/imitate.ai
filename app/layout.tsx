import "./globals.css";

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import ProModal from "@/components/pro-modal";

import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Arcana AI",
  description:
    "Arcana AI is your gateway to AI-driven innovation. We craft intelligent models that resonate like legends, redefining interactions. From deploying AI agents to decoding meme coins and analyzing wallets",
  icons: {
    icon: "./logo.png"
  }
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <link rel="shortcut icon" href="/logo.png" />
          <link rel="icon" type="image/x-icon" href="/logo.png" />
        </head>
        <body
          className={cn("bg-cover bg-center bg-fixed", inter.className)}
          style={{
            backgroundImage: "url(/bg-image.png)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundAttachment: "fixed"
          }}
        >
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            {children}
            <Toaster />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
