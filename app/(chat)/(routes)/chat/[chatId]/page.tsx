import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import prismadb from "@/lib/prismadb";
import ChatClient from "./components/client";

interface ChatIdPageProps {
  params: { chatId: string };
}

export default async function ChatIdPage({ params }: ChatIdPageProps) {
  const { userId } = await auth();

  if (!userId) {
    return redirect('/sign-in');
  }

  const companion = await prismadb.companion.findUnique({
    where: { 
      id: (await params).chatId 
    },
    include: {
      messages: {
        orderBy: { 
          createdAt: "asc" 
        },
        where: { 
          userId: userId 
        }
      },
      _count: {
        select: { 
          messages: true 
        }
      }
    }
  });

  if (!companion) {
    return redirect("/");
  }

  return (
    <ChatClient companion={companion} />
  );
}