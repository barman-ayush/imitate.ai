import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import prismadb from "@/lib/prismadb";
import ChatClient from "./components/client";

// Update the type definition to match Next.js page props
interface ChatIdPageProps {
  params: {
    chatId: string;
  };
  searchParams?: { [key: string]: string | string[] | undefined };
}

const ChatIdPage = async ({
  params,
  searchParams,
}: ChatIdPageProps) => {
  const { userId } = await auth();

  if (!userId) {
    return redirect('/sign-in');
  }

  const companion = await prismadb.companion.findUnique({
    where: { 
      id: params.chatId 
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
};

export default ChatIdPage;