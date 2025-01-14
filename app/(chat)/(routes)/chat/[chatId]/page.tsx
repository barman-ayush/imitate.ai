import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import prismadb from "@/lib/prismadb";
import ChatClient from "./components/client";
import { RedirectToSignIn } from "@clerk/nextjs";

interface ChatIdPageProps {
  params: any
}

export default async function ChatIdPage({ params }: ChatIdPageProps) {
  // Retrieve the user's session
  const session = auth();
  const userId = (await session)?.userId;

  // If user is not authenticated, redirect them to the sign-in page
  if (!userId) {
    redirect(`/sign-in?redirectUrl=/chat/${params.chatId}`);
    return null; // Required as we have redirected
  }

  // Fetch the companion from the database
  const companion = await prismadb.companion.findUnique({
    where: { id: (await params).chatId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        where: { userId },
      },
      _count: { select: { messages: true } },
    },
  });

  // If no companion is found, redirect to the homepage
  if (!companion) {
    redirect("/");
    return null; // Required as we have redirected
  }

  // Render the chat client with the companion data
  return <ChatClient companion={companion} />;
}
