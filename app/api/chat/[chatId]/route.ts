import dotenv from "dotenv";
import { StreamingTextResponse, LangChainStream } from "ai";
import { currentUser } from "@clerk/nextjs";
import { NextResponse } from "next/server";
import { Readable } from "stream";
import Replicate from "replicate";
import { MemoryManager } from "@/lib/memory";
import { ratelimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

dotenv.config({ path: `.env` });

// Configuration
const CONFIG = {
  TIMEOUT_MS: 30000,
  RETRY_ATTEMPTS: 2,
  MAX_LENGTH: 1024,
  MODELS: {
    default: "a16z-infra/llama-2-7b-chat:13c3cdee13ee059ab779f0291d29054dab00a47dad8261375654de5540165fb0" as const,
    fallback: "a16z-infra/mistral-7b-instruct-v0.1:83b6a56e7c828e667f21fd596c338fd4f0039b46bcfa18d973e8e70e455fda70" as const
  }
} as const;

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    // 1. Input validation and authentication
    const { prompt } = await request.json();
    const user = await currentUser();

    if (!user?.firstName || !user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    // 2. Rate limiting
    const identifier = `${request.url}-${user.id}`;
    const { success } = await ratelimit(identifier);

    if (!success) {
      return new NextResponse("Rate limit exceeded", { status: 429 });
    }

    // 3. Batch database operations
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
      select: {
        id: true,
        name: true,
        instructions: true,
        seed: true,
      }
    });

    if (!companion) {
      return new NextResponse("Companion not found", { status: 404 });
    }

    // 4. Memory management
    const companionKey = {
      companionName: companion.id,
      userId: user.id,
      modelName: "llama2-7b",  // Using smaller model
    };

    const memoryManager = await MemoryManager.getInstance();

    // Execute memory operations concurrently
    const [records, similarDocs] = await Promise.all([
      memoryManager.readLatestHistory(companionKey),
      memoryManager.vectorSearch(
        await memoryManager.readLatestHistory(companionKey),
        `${companion.id}.txt`
      )
    ]);

    if (records.length === 0) {
      await memoryManager.seedChatHistory(companion.seed, "\n\n", companionKey);
    }

    await memoryManager.writeToHistory(`User: ${prompt}\n`, companionKey);

    // 5. Prepare context
    const relevantHistory = similarDocs?.length
      ? similarDocs.map(doc => doc.pageContent).join("\n")
      : "";

    // 6. AI Model interaction with retries
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN!,
    });

    const generateResponse = async (attempt = 1): Promise<string> => {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), CONFIG.TIMEOUT_MS);
        });

        const modelResponse = replicate.run(
          CONFIG.MODELS.default as `${string}/${string}:${string}`,
          {
            input: {
              max_length: CONFIG.MAX_LENGTH,
              temperature: 0.7,
              top_p: 0.9,
              prompt: `
                ONLY generate plain sentences without prefix of who is speaking. DO NOT use ${companion.name}: prefix.
                Also , donot say that Hello! As a helpful and respectful assistant I can assure you that I am not the real ${companion.name}. 
                Act as of you the ${companion.name}
                ${companion.instructions}

                Below are relevant details about ${companion.name}'s past and the conversation you are in.
                ${relevantHistory}
                
                ${await memoryManager.readLatestHistory(companionKey)}\n${companion.name}:`
            }
          }
        );

        const response = await Promise.race([modelResponse, timeoutPromise]);
        return String(response);
      } catch (error) {
        if (attempt < CONFIG.RETRY_ATTEMPTS) {
          console.log(`Attempt ${attempt} failed, retrying with fallback model...`);
          return generateResponse(attempt + 1);
        }
        throw error;
      }
    };

    const response = await generateResponse();
    clearTimeout(timeoutId);

    // 7. Process response
    const cleaned = response.replaceAll(",", "");
    const chunks = cleaned.split("\n");
    const finalResponse = chunks[0];

    if (finalResponse?.length > 1) {
      // Execute database and memory operations concurrently
      await Promise.all([
        memoryManager.writeToHistory(finalResponse.trim(), companionKey),
        prismadb.companion.update({
          where: { id: params.chatId },
          data: {
            messages: {
              create: {
                content: finalResponse.trim(),
                role: "system",
                userId: user.id,
              },
            },
          },
        })
      ]);
    }

    // 8. Stream response
    // At the end of your POST function:
    const encoder = new TextEncoder();

    return new StreamingTextResponse(
      new ReadableStream({
        async start(controller) {
          const bytes = encoder.encode(finalResponse);
          controller.enqueue(bytes);
          controller.close();
        }
      })
    );


  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[CHAT_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}