import dotenv from "dotenv";
import { StreamingTextResponse, LangChainStream } from "ai";
import { currentUser } from "@clerk/nextjs";
import { NextResponse } from "next/server";

import Replicate from "replicate"; // Use Replicate's official SDK
import { MemoryManager } from "@/lib/memory";
import { ratelimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

dotenv.config({ path: `.env` });

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  try {
    const { prompt } = await request.json();
    const user = await currentUser();

    if (!user || !user.firstName || !user.id)
      return new NextResponse("Unauthorized!", { status: 401 });

    const identifier = request.url + "-" + user.id;
    const { success } = await ratelimit(identifier);

    if (!success)
      return new NextResponse("Ratelimit Exceeded!", { status: 429 });

    const companion = await prismadb.companion.update({
      where: { id: params.chatId },
      data: {
        messages: {
          create: {
            content: prompt,
            role: "user",
            userId: user.id,
          },
        },
      },
    });

    if (!companion)
      return new NextResponse("Companion Not Found.", { status: 404 });

    const name = companion.id;
    const companion_file_name = name + ".txt";

    const companionKey = {
      companionName: name,
      userId: user.id,
      modelName: "llama2-13b",
    };

    const memoryManager = await MemoryManager.getInstance();

    const records = await memoryManager.readLatestHistory(companionKey);

    if (records.length === 0)
      await memoryManager.seedChatHistory(companion.seed, "\n\n", companionKey);

    await memoryManager.writeToHistory("User: " + prompt + "\n", companionKey);
    console.log("Hola Amigo");

    const recentChatHistory = await memoryManager.readLatestHistory(
      companionKey
    );

    const similarDocs = await memoryManager.vectorSearch(
      recentChatHistory,
      companion_file_name
    );

    let relevantHistory = "";

    if (!!similarDocs && similarDocs.length !== 0)
      relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");

    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN || "",
    });

    console.log("Sending response to Replicate !")

    const response = await replicate.run(
      "a16z-infra/llama-2-13b-chat:df7690f1994d94e96ad9d568eac121aecf50684a0b0963b25a41cc40061269e5",
      {
        input: {
          max_length: 2048,
          prompt: `
            ONLY generate plain sentences without prefix of who is speaking. DO NOT use ${companion.name}: prefix. 
            
            ${companion.instructions}
            
            Below are relevant details about ${companion.name}'s past and the conversation you are in.
            ${relevantHistory}
            
            ${recentChatHistory}\n${companion.name}:`,
        },
      }
    );
    console.log("received response from Replicate !", response)

    const cleaned = String(response).replaceAll(",", "");
    const chunks = cleaned.split("\n");
    const finalResponse = chunks[0];

    await memoryManager.writeToHistory("" + finalResponse.trim(), companionKey);

    var Readable = require("stream").Readable;

    let stream = new Readable();
    stream.push(finalResponse);
    stream.push(null);

    if (finalResponse !== undefined && finalResponse.length > 1) {
      memoryManager.writeToHistory("" + finalResponse.trim(), companionKey);

      await prismadb.companion.update({
        where: {
          id: params.chatId,
        },
        data: {
          messages: {
            create: {
              content: finalResponse.trim(),
              role: "system",
              userId: user.id,
            },
          },
        },
      });
    }

    return new StreamingTextResponse(stream);
  } catch (error) {
    console.error("[CHAT_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
