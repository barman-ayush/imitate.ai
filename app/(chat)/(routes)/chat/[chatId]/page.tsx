import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import prismadb from "@/lib/prismadb";
import ChatClient from "./components/client";
import { RedirectToSignIn } from "@clerk/nextjs";

interface ChatIdPageProps {
  params: { chatId: string };
}

export default async function ChatIdPage({ params }: ChatIdPageProps) {
  // const { userId } = auth();
  const session = auth();
  const userId = (await session).userId;

  if (!userId)
    return RedirectToSignIn({
      redirectUrl: `/chat/${params.chatId}`
    });

  const companion = await prismadb.companion.findUnique({
    where: { id: params.chatId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, where: { userId } },
      _count: { select: { messages: true } }
    }
  });

  if (!companion) return redirect("/");

  return <ChatClient companion={companion} />;
}
