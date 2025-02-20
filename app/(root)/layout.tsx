import React from "react";

import Navbar from "@/components/navbar";
import Sidebar from "@/components/sidebar";


export default async function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const isPro = true;

  return (
    <div
      className="h-full bg-cover bg-center"
      // style={{ backgroundImage: 'url(/bg-image.png)' }}
    >
      <Navbar isPro={isPro} />
      <div className="hidden md:flex mt-16 w-20 flex-col fixed inset-y-0">
        <Sidebar isPro={isPro} />
      </div>
      <main className="md:pl-20 pt-16 h-full">{children}</main>
    </div>
  );
}
