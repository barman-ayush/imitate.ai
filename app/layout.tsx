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
  title: "Imitate AI",
  description:
    "Imitate AI made using Next.js, React.js, TypeScript, TailwindCSS, Prisma & Stripe."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={cn("bg-cover bg-center bg-fixed", inter.className)}
          style={{
            backgroundImage: 'url(/bg-image.png)',
            backgroundSize: 'cover', // Ensures the image covers the whole div
            backgroundPosition: 'center', // Centers the image
            backgroundAttachment: 'fixed' // Keeps the background fixed when scrolling
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
